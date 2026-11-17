import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { redactEventPayload } from "./workbench-events";
import { matchedOntologyStageBasis, WORKBENCH_ONTOLOGY_TOOL } from "./workbench-ontology-contract";
import { executeWorkbenchOntology, mountWorkbenchOntologyTool, queryWorkbenchOntology } from "./workbench-ontology-tools";
import { workbenchToolEffect } from "./tool-effects";

const organizationId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const leadId = "33333333-3333-4333-8333-333333333333";
const scope = { organizationId, runId, leadId };
const args = {
  template: "completed_appointments",
  startUtc: "2026-11-01T00:00:00Z",
  endUtc: "2026-11-08T00:00:00Z",
};
const row = {
  leadId,
  id: "99999999-9999-4999-8999-999999999999",
  type: "appointment_completed",
  performedAt: "2026-11-02T14:23:10.123456Z",
};

function database() {
  const query = vi.fn();
  return { db: { query } as Queryable, query };
}

describe("completed appointment ontology", () => {
  it.each([
    { template: args.template },
    { ...args, template: "all_appointments" },
    { ...args, leadId },
    { ...args, startUtc: "2026-11-01T08:00:00+08:00" },
    { ...args, startUtc: "2026-11-01T00:00Z" },
    { ...args, startUtc: "2026-02-30T00:00:00Z" },
    { ...args, endUtc: args.startUtc },
    { ...args, endUtc: "2026-12-02T00:00:00.000001Z" },
  ])("clarifies ambiguous or unsupported parameters without reading data: %j", async (input) => {
    const { db, query } = database();
    await expect(queryWorkbenchOntology(db, scope, input)).resolves.toMatchObject({ status: "clarification_required" });
    expect(query).not.toHaveBeenCalled();
  });

  it("returns only fixed typed evidence, preserving SQL microseconds", async () => {
    const { db, query } = database();
    query.mockResolvedValue({ rows: [{ ...row, body: "private customer text" }] });
    await expect(queryWorkbenchOntology(db, scope, args)).resolves.toEqual({
      template: args.template,
      version: 1,
      status: "matched",
      scope: { leadId },
      window: { startUtc: args.startUtc, endUtc: args.endUtc },
      activities: [{ id: row.id, type: row.type, performedAt: row.performedAt }],
    });
    expect(query).toHaveBeenCalledWith(expect.any(String), [
      organizationId, runId, leadId, "appointment_completed", args.startUtc, args.endUtc, 26,
    ]);
  });

  it("can use returned SQL microseconds as a boundary without rounding the window", async () => {
    const { db, query } = database();
    query.mockResolvedValue({ rows: [row] });
    const window = { startUtc: row.performedAt, endUtc: "2026-11-02T14:23:10.123457Z" };
    await expect(queryWorkbenchOntology(db, scope, { template: args.template, ...window }))
      .resolves.toMatchObject({ status: "matched", window });
    expect(query).toHaveBeenCalledWith(expect.any(String), [
      organizationId, runId, leadId, "appointment_completed", window.startUtc, window.endUtc, 26,
    ]);
  });

  it("distinguishes an authorized empty result, denial, query failure and truncation", async () => {
    const { db, query } = database();
    query.mockResolvedValueOnce({ rows: [{ leadId, id: null }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error("SQL credentials and private data"))
      .mockResolvedValueOnce({ rows: Array(26).fill(row) });
    await expect(queryWorkbenchOntology(db, scope, args)).resolves.toMatchObject({ status: "empty", activities: [] });
    await expect(queryWorkbenchOntology(db, scope, args)).resolves.toEqual({
      status: "forbidden", template: args.template, version: 1,
    });
    await expect(queryWorkbenchOntology(db, scope, args)).resolves.toEqual({
      status: "error", template: args.template, version: 1,
    });
    const capped = await queryWorkbenchOntology(db, scope, args);
    expect(capped.status).toBe("truncated");
    expect("activities" in capped && capped.activities).toHaveLength(25);
  });

  it("mounts only on a permitted scope and checks authorization again at execution", async () => {
    const { db, query } = database();
    const tools: Record<string, unknown> = {};
    query.mockResolvedValueOnce({ rows: [] });
    await mountWorkbenchOntologyTool(db, { ...scope, leadId: null }, tools);
    expect(query).toHaveBeenCalledWith(expect.any(String), [organizationId, runId]);
    expect(tools).not.toHaveProperty(WORKBENCH_ONTOLOGY_TOOL);
    query.mockResolvedValueOnce({ rows: [{ id: leadId }] }).mockResolvedValueOnce({ rows: [] });
    const observations = await mountWorkbenchOntologyTool(db, scope, tools);
    const nativeRead = tools[WORKBENCH_ONTOLOGY_TOOL] as {
      execute: (input: unknown, options: { toolCallId: string }) => Promise<{ content: string; isError: boolean }>;
    };
    const response = await nativeRead.execute(args, { toolCallId: "revoked-call" });
    expect(workbenchToolEffect(WORKBENCH_ONTOLOGY_TOOL)).toMatchObject({ effect: "read" });
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content)).toMatchObject({ status: "forbidden", toolCallId: "revoked-call" });
    expect(observations.get("revoked-call")).toMatchObject({ template: args.template, version: 1, status: "forbidden" });
  });

  it("persists an ontology receipt only with its own tool name, call ID and strict shape", async () => {
    const { db, query } = database();
    query.mockResolvedValue({ rows: [row] });
    const ontology = await queryWorkbenchOntology(db, scope, args);
    const payload = { tool: WORKBENCH_ONTOLOGY_TOOL, toolCallId: "native-call", status: "success", ontology };
    expect(redactEventPayload("tool_completed", payload)).toEqual(payload);
    expect(redactEventPayload("tool_completed", { ...payload, tool: "crm_get_lead" })).not.toHaveProperty("ontology");
    expect(redactEventPayload("tool_completed", { ...payload, toolCallId: undefined })).not.toHaveProperty("ontology");
    expect(redactEventPayload("tool_completed", {
      ...payload, ontology: { ...ontology, rawMessage: "private customer text" },
    })).not.toHaveProperty("ontology");
  });

  it("links only a stage reason that explicitly cites a matched call and activity on its lead", async () => {
    const { db, query } = database();
    query.mockResolvedValue({ rows: [row] });
    const ontology = await queryWorkbenchOntology(db, scope, args);
    const toolCallId = "crm_query_ontology:step.12";
    const observed = new Map([[toolCallId, ontology]]);
    expect(matchedOntologyStageBasis(observed, {
      lead_id: leadId, reason: `完成约见（${toolCallId}，${row.id}）。`,
    })).toEqual({ toolCallId, activityId: row.id });
    expect(matchedOntologyStageBasis(observed, { lead_id: leadId, reason: row.id })).toBeUndefined();
    expect(matchedOntologyStageBasis(observed, {
      lead_id: leadId, reason: `${toolCallId}_different ${row.id}`,
    })).toBeUndefined();
    expect(matchedOntologyStageBasis(observed, {
      lead_id: runId, reason: `${toolCallId} ${row.id}`,
    })).toBeUndefined();
  });
});

describe("versioned ontology Workbench tool", () => {
  it("exposes terms and answerability separately from SQL execution", async () => {
    const { db, query } = database();
    const unselected = { ...scope, leadId: null };
    const term = await executeWorkbenchOntology(db, unselected, { operation: "resolve", question: "开放商机" });
    const ready = await executeWorkbenchOntology(db, unselected, { operation: "plan", question: "开放商机" });
    const omittedQuestion = await executeWorkbenchOntology(db, unselected, { template: "open_leads" });
    const clarification = await executeWorkbenchOntology(db, unselected, {
      template: "open_leads", question: "授权范围内哪些开放商机高潜且跟进不足？",
    });
    expect(term).toMatchObject({ kind: "planning", status: "resolved", semantics: { definitions: [{ id: "open_leads" }] } });
    expect(ready).toMatchObject({ kind: "planning", status: "ready", template: "open_leads" });
    expect(omittedQuestion).toMatchObject({ kind: "planning", status: "clarification_required", reason: "invalid_input" });
    expect(clarification).toMatchObject({
      kind: "planning", status: "clarification_required", reason: "missing_definition",
      missing: [expect.stringContaining("高潜"), expect.stringContaining("有效跟进")],
      semantics: { catalog: { digest: expect.stringMatching(/^[a-f0-9]{64}$/) } },
    });
    expect(query).not.toHaveBeenCalled();
    const payload = { tool: WORKBENCH_ONTOLOGY_TOOL, toolCallId: "clarify", status: "success", ontology: clarification };
    expect(redactEventPayload("tool_completed", payload)).toEqual(payload);
  });

  it("returns minimal open lead evidence and preserves the combination's record-coverage limit", async () => {
    const { db, query } = database();
    query.mockResolvedValue({ rows: [{
      scopeLeadId: null, scopeContactId: null, scopePipelineId: runId, scopeConversationId: null,
      id: leadId, pipelineId: runId, stageId: row.id, title: "private title",
    }] });
    const opened = await executeWorkbenchOntology(db, { ...scope, leadId: null }, { question: "开放商机" });
    const combined = await executeWorkbenchOntology(db, { ...scope, leadId: null }, {
      question: `当前授权范围内在 ${args.startUtc} 到 ${args.endUtc} 内没有已完成约见记录的开放商机`,
    });
    expect(opened).toMatchObject({
      kind: "lead_query", status: "matched", coverage: "complete", template: "open_leads", scope: { pipelineId: runId },
      leads: [{ id: leadId, status: "open", pipelineId: runId, stageId: row.id }],
    });
    expect(JSON.stringify(opened)).not.toContain("private title");
    expect(combined).toMatchObject({ status: "matched", coverage: "partial", window: { startUtc: args.startUtc, endUtc: args.endUtc } });
    expect(combined.semantics?.definitions.map(({ id }) => id)).toEqual([
      "open_leads", "completed_appointments", "open_leads_without_completed_appointments",
    ]);
    expect(matchedOntologyStageBasis(new Map([["combo-call", combined]]), { lead_id: leadId, reason: `combo-call ${leadId}` }))
      .toBeUndefined();
    const event = { tool: WORKBENCH_ONTOLOGY_TOOL, toolCallId: "combined", status: "success", ontology: combined };
    expect(redactEventPayload("tool_completed", event)).toEqual(event);
  });

  it("retains a versioned appointment receipt as a valid stage basis", async () => {
    const { db, query } = database();
    query.mockResolvedValue({ rows: [row] });
    const receipt = await executeWorkbenchOntology(db, scope, args);
    const call = "approved-basis-call";
    expect(receipt).toMatchObject({ template: args.template, version: 1, semantics: { catalog: { version: "1.0.0" } } });
    const event = { tool: WORKBENCH_ONTOLOGY_TOOL, toolCallId: call, status: "success", ontology: receipt };
    expect(redactEventPayload("tool_completed", event)).toEqual(event);
    expect(matchedOntologyStageBasis(new Map([[call, receipt]]), { lead_id: leadId, reason: `${call} ${row.id}` }))
      .toEqual({ toolCallId: call, activityId: row.id });
  });
});
