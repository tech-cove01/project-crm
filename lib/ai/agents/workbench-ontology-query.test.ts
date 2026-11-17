import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import {
  AUTHORIZED_ONTOLOGY_RUN_SQL,
  hasWorkbenchLeadOntologyAccess,
  queryWorkbenchOpenLeads,
} from "./workbench-ontology-query";

const run = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  runId: "22222222-2222-4222-8222-222222222222",
};
const contactId = "33333333-3333-4333-8333-333333333333";
const pipelineId = "44444444-4444-4444-8444-444444444444";
const leadId = "55555555-5555-4555-8555-555555555555";
const stageId = "66666666-6666-4666-8666-666666666666";
const conversationId = "77777777-7777-4777-8777-777777777777";
const leadPlan = { template: "open_leads" } as const;
const window = { startUtc: "2026-11-01T12:00:00.123456Z", endUtc: "2026-11-15T12:00:00.123457Z" };
const row = {
  scopeLeadId: null,
  scopeContactId: null,
  scopePipelineId: null,
  scopeConversationId: null,
  id: leadId,
  pipelineId,
  stageId,
};

function database() {
  const query = vi.fn();
  return { db: { query } as Queryable, query };
}

describe("Workbench SQL for reviewed open lead queries", () => {
  it("projects narrow evidence and reports the durable scope bound by SQL", async () => {
    const { db, query } = database();
    query.mockResolvedValue({ rows: [{
      ...row,
      scopeContactId: contactId,
      scopeConversationId: conversationId,
      scopePipelineId: pipelineId,
      title: "customer input that is not part of evidence",
    }] });
    await expect(queryWorkbenchOpenLeads(db, run, leadPlan)).resolves.toEqual({
      status: "matched",
      scope: { contactId, conversationId, pipelineId },
      leads: [{ id: leadId, status: "open", pipelineId, stageId }],
    });
    expect(query).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(AUTHORIZED_ONTOLOGY_RUN_SQL), [
      run.organizationId, run.runId, "open", 26,
    ]);
  });

  it("uses the recorded activity predicate and full UTC precision only for composition", async () => {
    const { db, query } = database();
    query.mockResolvedValue({ rows: [row] });
    await queryWorkbenchOpenLeads(db, run, { template: "open_leads_without_completed_appointments", window });
    const [sql, args] = query.mock.calls[0] ?? [];
    expect(sql).toContain("appointment.organization_id = lead.organization_id and appointment.lead_id = lead.id");
    expect(sql).toContain("appointment.performed_at >= $6::timestamptz");
    expect(sql).toContain("appointment.performed_at < $7::timestamptz");
    expect(args).toEqual([run.organizationId, run.runId, "open", 26, "appointment_completed", window.startUtc, window.endUtc]);
  });

  it("distinguishes an authorized empty set, denial, failure and truncated results", async () => {
    const { db, query } = database();
    query.mockResolvedValueOnce({ rows: [{ ...row, scopeLeadId: leadId, id: null, pipelineId: null, stageId: null }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error("private database failure"))
      .mockResolvedValueOnce({ rows: Array(26).fill(row) });
    await expect(queryWorkbenchOpenLeads(db, run, leadPlan)).resolves.toEqual({
      status: "empty", scope: { leadId }, leads: [],
    });
    await expect(queryWorkbenchOpenLeads(db, run, leadPlan)).resolves.toEqual({ status: "forbidden" });
    await expect(queryWorkbenchOpenLeads(db, run, leadPlan)).resolves.toEqual({ status: "error" });
    await expect(queryWorkbenchOpenLeads(db, run, leadPlan)).resolves.toMatchObject({
      status: "truncated", scope: {}, leads: Array(25).fill({ id: leadId, status: "open", pipelineId, stageId }),
    });
  });

  it("rechecks durable scope and current membership on every execution after mount", async () => {
    const { db, query } = database();
    query.mockResolvedValueOnce({ rows: [{ run_id: run.runId }] }).mockResolvedValueOnce({ rows: [] });
    await expect(hasWorkbenchLeadOntologyAccess(db, run)).resolves.toBe(true);
    await expect(queryWorkbenchOpenLeads(db, run, leadPlan)).resolves.toEqual({ status: "forbidden" });
    expect(query.mock.calls[0]).toEqual([AUTHORIZED_ONTOLOGY_RUN_SQL, [run.organizationId, run.runId]]);
    expect(query.mock.calls[1]?.[0]).toContain(AUTHORIZED_ONTOLOGY_RUN_SQL);
  });
});
