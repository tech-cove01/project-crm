import { z } from "zod";
import type { ActivityType } from "@/lib/leads/activity-vocabulary";

export const WORKBENCH_ONTOLOGY_TOOL = "crm_query_ontology";
export const LEAD_STAGE_TOOL = "crm_move_lead_stage";
export const COMPLETED_APPOINTMENTS = {
  template: "completed_appointments",
  version: 1,
  activityType: "appointment_completed" satisfies ActivityType,
  maxWindowDays: 31,
  maxRows: 25,
} as const;

const utcInstant = z.iso.datetime().regex(/^(?!0000)\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/);
const windowSchema = z.object({ startUtc: utcInstant, endUtc: utcInstant }).strict();
const definition = z.object({
  template: z.literal(COMPLETED_APPOINTMENTS.template),
  version: z.literal(COMPLETED_APPOINTMENTS.version),
});

export const workbenchOntologyObservationSchema = z.discriminatedUnion("status", [
  definition.extend({
    status: z.enum(["matched", "empty", "truncated"]),
    scope: z.object({ leadId: z.uuid() }).strict(),
    window: windowSchema,
    activities: z.array(z.object({
      id: z.uuid(),
      type: z.literal(COMPLETED_APPOINTMENTS.activityType),
      performedAt: z.iso.datetime(),
    }).strict()).max(COMPLETED_APPOINTMENTS.maxRows),
  }).strict(),
  definition.extend({
    status: z.enum(["clarification_required", "forbidden", "error"]),
  }).strict(),
]);

export type WorkbenchOntologyObservation = z.infer<typeof workbenchOntologyObservationSchema>;
export const workbenchOntologyStageBasisSchema = z.object({
  toolCallId: z.string().min(1).max(200),
  activityId: z.uuid(),
}).strict();

function citesExactId(reason: string, id: string): boolean {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^A-Za-z0-9_-])${escaped}(?:$|[^A-Za-z0-9_-])`).test(reason);
}

export function matchedOntologyStageBasis(
  observations: ReadonlyMap<string, WorkbenchOntologyObservation>,
  stageArgs: unknown,
) {
  if (!stageArgs || typeof stageArgs !== "object") return undefined;
  const { reason, lead_id: leadId } = stageArgs as Record<string, unknown>;
  if (typeof reason !== "string" || typeof leadId !== "string") return undefined;
  for (const [toolCallId, result] of observations) {
    if (result.status !== "matched" || result.scope.leadId !== leadId.toLowerCase() || !citesExactId(reason, toolCallId))
      continue;
    const cited = result.activities.find((activity) => citesExactId(reason, activity.id));
    if (cited) return { toolCallId, activityId: cited.id };
  }
  return undefined;
}

export type WorkbenchOntologyStageBasis = z.infer<typeof workbenchOntologyStageBasisSchema>;

// Optional wire fields let the tool explain which definition or UTC dates are needed.
export const workbenchOntologyInputSchema = z.object({
  template: z.string().max(80).optional().describe("Only supported template: completed_appointments"),
  startUtc: z.string().max(32).optional().describe("ISO 8601 UTC instant with Z, inclusive"),
  endUtc: z.string().max(32).optional().describe("ISO 8601 UTC instant with Z, exclusive"),
}).strict();

const ontologyQuerySchema = windowSchema.extend({ template: definition.shape.template });

function utcMicroseconds(value: string): bigint {
  const [seconds, fraction = ""] = value.slice(0, -1).split(".");
  return BigInt(Date.parse(`${seconds}Z`)) * 1_000n + BigInt(fraction.padEnd(6, "0"));
}

export function parseWorkbenchOntologyWindow(input: unknown) {
  const parsed = ontologyQuerySchema.safeParse(input);
  if (!parsed.success) return null;
  const { startUtc, endUtc } = parsed.data;
  const duration = utcMicroseconds(endUtc) - utcMicroseconds(startUtc);
  return duration > 0n && duration <= BigInt(COMPLETED_APPOINTMENTS.maxWindowDays) * 86_400_000_000n
    ? { startUtc, endUtc }
    : null;
}
