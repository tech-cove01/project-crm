import { describe, expect, it } from "vitest";
import { workbenchProposalPreview } from "./workbench-proposal-preview";
const lead = "11111111-1111-4111-8111-111111111111";
describe("safe workbench approval preview", () => {
  it("shows target and relative due time using the same precedence as the real tool", () => {
    expect(
      workbenchProposalPreview("crm_schedule_followup", {
        lead_id: lead,
        in_hours: 24,
        promised_at: "2026-01-01T00:00:00Z",
        reason: "private note",
        promise: "private customer commitment",
        token: "secret",
      }),
    ).toEqual({ targetKind: "lead", targetId: lead, inHours: 24 });
  });
  it("uses an absolute ISO instant only when relative scheduling is absent", () => {
    expect(
      workbenchProposalPreview("crm_schedule_followup", {
        contact_id: lead,
        promised_at: "2026-10-02T08:00:00Z",
      }),
    ).toEqual({ targetKind: "contact", targetId: lead, promisedAt: "2026-10-02T08:00:00Z" });
  });
  it("does not copy arbitrary/invalid arguments to the manager-readable preview", () => {
    expect(
      workbenchProposalPreview("crm_schedule_followup", {
        lead_id: "secret",
        promised_at: "tomorrow",
      }),
    ).toEqual({});
    expect(workbenchProposalPreview("unknown", { contact_id: lead })).toEqual({});
  });
  it("only exposes validated move targets, excluding free-text reason and unrelated args", () => {
    const stage = "22222222-2222-4222-8222-222222222222";
    expect(workbenchProposalPreview("crm_move_lead_stage", {
      lead_id: lead, to_stage_id: stage, reason: "private note", token: "secret",
    })).toEqual({ targetKind: "lead", targetId: lead, toStageId: stage });
    expect(workbenchProposalPreview("crm_move_lead_stage", {
      lead_id: "private", to_stage_id: "private",
    })).toEqual({});
  });
});
