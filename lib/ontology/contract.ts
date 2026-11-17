import { z } from "zod";
import type { ActivityType } from "@/lib/leads/activity-vocabulary";

export const ONTOLOGY_TEMPLATES = [
  "open_leads",
  "completed_appointments",
  "open_leads_without_completed_appointments",
] as const;
export type OntologyTemplate = (typeof ONTOLOGY_TEMPLATES)[number];

export const OPEN_LEAD_STATUS = "open";
export const COMPLETED_APPOINTMENT_TYPE = "appointment_completed" satisfies ActivityType;
export const ONTOLOGY_MAX_ROWS = 25;
export const ONTOLOGY_MAX_WINDOW_DAYS = 31;

export const ontologyUtcInstant = z.iso.datetime()
  .regex(/^(?!0000)\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/);
export type OntologyWindow = { startUtc: string; endUtc: string };

export function ontologyUtcMicroseconds(value: string): bigint {
  const [seconds, fraction = ""] = value.slice(0, -1).split(".");
  return BigInt(Date.parse(`${seconds}Z`)) * 1_000n + BigInt(fraction.padEnd(6, "0"));
}

export function parseOntologyWindow(startUtc: unknown, endUtc: unknown): OntologyWindow | null {
  const start = ontologyUtcInstant.safeParse(startUtc);
  const end = ontologyUtcInstant.safeParse(endUtc);
  if (!start.success || !end.success) return null;
  const duration = ontologyUtcMicroseconds(end.data) - ontologyUtcMicroseconds(start.data);
  if (duration <= 0n || duration > BigInt(ONTOLOGY_MAX_WINDOW_DAYS) * 86_400_000_000n) return null;
  return { startUtc: start.data, endUtc: end.data };
}
