import { z } from "zod";
import {
  COMPLETED_APPOINTMENT_TYPE,
  ONTOLOGY_MAX_ROWS,
  ONTOLOGY_MAX_WINDOW_DAYS,
  ONTOLOGY_TEMPLATES,
  ontologyUtcInstant,
  parseOntologyWindow,
} from "@/lib/ontology/contract";

export const WORKBENCH_ONTOLOGY_TOOL = "crm_query_ontology";
export const LEAD_STAGE_TOOL = "crm_move_lead_stage";
export const COMPLETED_APPOINTMENTS = {
  template: "completed_appointments",
  version: 1,
  activityType: COMPLETED_APPOINTMENT_TYPE,
  maxWindowDays: ONTOLOGY_MAX_WINDOW_DAYS,
  maxRows: ONTOLOGY_MAX_ROWS,
} as const;

const windowSchema = z.object({ startUtc: ontologyUtcInstant, endUtc: ontologyUtcInstant }).strict();
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const semanticVersion = z.string().regex(/^\d+\.\d+\.\d+$/);
const catalogId = z.string().regex(/^[a-z][a-z0-9_]*$/).max(80);
const ontologyTemplate = z.enum(ONTOLOGY_TEMPLATES);
const leadTemplate = ontologyTemplate.exclude(["completed_appointments"]);
const semanticReceipt = z.object({
  catalog: z.object({ version: semanticVersion, digest: digestSchema }).strict(),
  definitions: z.array(z.object({
    id: catalogId,
    label: z.string().min(1).max(80),
    rule: z.string().min(1).max(600),
    version: semanticVersion,
    digest: digestSchema,
    status: z.enum(["reviewed", "disabled", "undefined"]),
    fields: z.array(z.string().regex(/^[a-z_]+\.[a-z_]+$/).max(100)).max(16),
  }).strict()).max(8),
  concepts: z.array(z.object({
    id: catalogId, label: z.string().min(1).max(80), kind: z.enum(["entity", "relation", "definition"]),
  }).strict()).max(12),
}).strict();

export type WorkbenchOntologySemantics = z.infer<typeof semanticReceipt>;

const definition = z.object({
  template: z.literal(COMPLETED_APPOINTMENTS.template),
  version: z.literal(COMPLETED_APPOINTMENTS.version),
  semantics: semanticReceipt.optional(),
});

const appointmentObservation = z.discriminatedUnion("status", [
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

const planningObservation = z.object({
  kind: z.literal("planning"),
  operation: z.enum(["resolve", "plan", "query"]),
  status: z.enum(["resolved", "ready", "clarification_required"]),
  template: ontologyTemplate.optional(),
  semantics: semanticReceipt,
  window: windowSchema.optional(),
  reason: z.enum([
    "invalid_input", "missing_definition", "unsupported_question", "definition_disabled",
    "scope_required", "invalid_window", "conflicting_conditions",
  ]).optional(),
  missing: z.array(z.string().min(1).max(240)).max(8).optional(),
}).strict();
const leadEvidence = z.object({
  kind: z.literal("lead_query"),
  template: leadTemplate,
  semantics: semanticReceipt,
  window: windowSchema.optional(),
});
const leadObservation = z.discriminatedUnion("status", [
  leadEvidence.extend({
    status: z.enum(["matched", "empty", "truncated"]),
    coverage: z.enum(["complete", "partial"]),
    scope: z.object({ leadId: z.uuid(), contactId: z.uuid(), pipelineId: z.uuid(), conversationId: z.uuid() }).partial().strict(),
    leads: z.array(z.object({ id: z.uuid(), status: z.literal("open"), pipelineId: z.uuid(), stageId: z.uuid() }).strict()).max(ONTOLOGY_MAX_ROWS),
  }).strict(),
  leadEvidence.extend({ status: z.enum(["forbidden", "error"]) }).strict(),
]);

export const workbenchOntologyObservationSchema = z.union([appointmentObservation, planningObservation, leadObservation]);
export type WorkbenchAppointmentObservation = z.infer<typeof appointmentObservation>;
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
    if (result.status !== "matched" || !("activities" in result) ||
      result.scope.leadId !== leadId.toLowerCase() || !citesExactId(reason, toolCallId))
      continue;
    const cited = result.activities.find((activity) => citesExactId(reason, activity.id));
    if (cited) return { toolCallId, activityId: cited.id };
  }
  return undefined;
}

export type WorkbenchOntologyStageBasis = z.infer<typeof workbenchOntologyStageBasisSchema>;

// Optional wire fields let the tool explain which definition or UTC dates are needed.
export const workbenchOntologyInputSchema = z.object({
  operation: z.enum(["resolve", "plan", "query"]).optional().describe("Resolve business terms, check an answerable plan, or execute a permitted read. Defaults to query."),
  question: z.string().trim().min(1).max(600).optional().describe("Original user business query clause with all requested conditions. Do not remove undefined conditions to make the query executable."),
  template: z.string().max(80).optional().describe("Reviewed templates: open_leads, completed_appointments, open_leads_without_completed_appointments"),
  startUtc: z.string().max(32).optional().describe("ISO 8601 UTC instant with Z, inclusive"),
  endUtc: z.string().max(32).optional().describe("ISO 8601 UTC instant with Z, exclusive"),
}).strict();
export type WorkbenchOntologyInput = z.infer<typeof workbenchOntologyInputSchema>;

const ontologyQuerySchema = windowSchema.extend({ template: definition.shape.template });

export function parseWorkbenchOntologyWindow(input: unknown) {
  const parsed = ontologyQuerySchema.safeParse(input);
  return parsed.success ? parseOntologyWindow(parsed.data.startUtc, parsed.data.endUtc) : null;
}
