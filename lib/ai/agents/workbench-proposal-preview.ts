import { z } from "zod";

/** Manager-readable target facts only, never arbitrary tool args or customer text. */
export function workbenchProposalPreview(tool: string, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const args = value as Record<string, unknown>;
  const leadId = z.string().uuid().safeParse(args.lead_id);
  if (tool === "crm_move_lead_stage") {
    const toStageId = z.string().uuid().safeParse(args.to_stage_id);
    return {
      ...(leadId.success ? { targetKind: "lead", targetId: leadId.data } : {}),
      ...(toStageId.success ? { toStageId: toStageId.data } : {}),
    };
  }
  if (tool !== "crm_schedule_followup") return {};
  const contactId = z.string().uuid().safeParse(args.contact_id);
  const inHours = z.number().positive().max(4320).safeParse(args.in_hours);
  const promisedAt = z.iso.datetime({ offset: true }).safeParse(args.promised_at);
  return {
    ...(leadId.success
      ? { targetKind: "lead", targetId: leadId.data }
      : contactId.success
        ? { targetKind: "contact", targetId: contactId.data }
        : {}),
    ...(inHours.success
      ? { inHours: inHours.data }
      : promisedAt.success
        ? { promisedAt: promisedAt.data }
        : {}),
  };
}
