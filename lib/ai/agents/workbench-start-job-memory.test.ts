import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobRow } from "@/lib/agent-engine/queue/queue";
import type { Pool } from "pg";
import type { RuntimeMessage } from "@/lib/agent-runtime";

const mocks = vi.hoisted(() => ({
  model: vi.fn(),
  event: vi.fn(async () => 1),
  query: vi.fn(),
  admin: vi.fn(),
  collaboration: vi.fn(),
  selectPlan: vi.fn(),
  mcpTools: {} as Record<string, unknown>,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.admin }));
vi.mock("@/lib/agent-engine/agent/pi-turn-execution", () => ({
  executePiTurnModelCall: mocks.model,
}));
vi.mock("@/lib/ai/agents/workbench-events", () => ({ appendWorkbenchEvent: mocks.event }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({
  getRequestPool: () => ({ query: mocks.query }),
}));
vi.mock("@/lib/agent-engine/agent/request-deps", () => ({
  requestTurnDeps: () => ({ crmCfg: {}, llmCfg: {}, log: {}, runtime: {} }),
}));
vi.mock("@/lib/ai/agents/workbench-job-lease", () => ({ assertWorkbenchJobLease: vi.fn() }));
vi.mock("@/lib/agent-engine/agent/agent-config", () => ({
  loadAgentVersionConfig: async () => ({
    systemPrompt: "CRM playbook",
    model: "test",
    maxSteps: 8,
  }),
}));
vi.mock("@/lib/agent-engine/edge/crm/mcp-tools", () => ({
  buildMcpTurnTools: async () => ({ tools: mocks.mcpTools, cleanup: vi.fn() }),
}));
vi.mock("@/lib/ai/agents/workbench-scope", () => ({
  resolveWorkbenchScope: async () => ({
    contactId: null,
    leadId: null,
    conversationId: null,
    pipelineId: null,
  }),
}));
vi.mock("@/lib/ai/agents/collaboration", () => ({
  selectCollaborationPlan: mocks.selectPlan,
  collaborationPlanForMission: (plan: unknown) => plan,
}));
vi.mock("@/lib/ai/agents/workbench-collaboration", () => ({
  runWorkbenchCollaboration: mocks.collaboration,
}));
import { runWorkbenchStartJob } from "./workbench-start-job";

const job = {
  id: "job1",
  organization_id: "org1",
  payload: { runId: "run1" },
  attempts: 1,
  max_attempts: 3,
} as unknown as JobRow;
const pool = { query: mocks.query } as unknown as Pool;
const policyRow = {
  id: "version3",
  version_id: "version3",
  organization_id: "org1",
  version_number: 3,
  content: "Published organization policy",
  created_at: "2026-10-01T00:00:00Z",
  published_at: "2026-10-01T00:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.selectPlan.mockReturnValue(null);
  mocks.collaboration.mockResolvedValue(null);
  mocks.mcpTools = {};
  mocks.model.mockRejectedValue(new Error("stop_after_model_input"));
  mocks.query.mockImplementation(async (sql: string) => ({
    rows: sql.includes("from org_memory_pointers") ? [policyRow] : [],
  }));
  mocks.admin.mockReturnValue({
    from: (table: string) => {
      const data =
        table === "ai_workbench_runs"
          ? {
              id: "run1",
              status: "running",
              agent_id: "agent1",
              task: "Check CRM",
              mode: "inspect",
              runtime_state: { versionId: "agent-version1" },
              mission_id: null,
              scope: {},
              budget: {},
            }
          : table === "ai_agent_action_proposals"
            ? []
            : null;
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data, error: null }),
        then: (resolve: (result: unknown) => unknown) =>
          Promise.resolve(resolve({ data, error: null })),
      };
      return builder;
    },
  });
});

describe("Workbench start pending proposal presentation", () => {
  it("closes the actual staged proposal with server pending text and preserves the model transcript", async () => {
    const proposals: Array<Record<string, unknown>> = [];
    const runUpdates: Array<Record<string, unknown>> = [];
    let savedMessages: RuntimeMessage[] = [];
    mocks.admin.mockReturnValue({
      from(table: string) {
        let savedProposal: Record<string, unknown> | null = null;
        const builder = {
          select: () => builder, eq: () => builder, in: () => builder,
          order: () => builder, limit: () => builder,
          upsert: (row: Record<string, unknown>) => {
            if (table === "ai_agent_run_states") savedMessages = row.messages as RuntimeMessage[];
            if (table === "ai_agent_action_proposals") {
              savedProposal = { id: "proposal-1", ...row };
              proposals.push(savedProposal);
            }
            return builder;
          },
          update: (row: Record<string, unknown>) => {
            if (table === "ai_workbench_runs") runUpdates.push(row);
            return builder;
          },
          maybeSingle: async () => ({
            data: table === "ai_workbench_runs"
              ? { id: "run1", status: "running", agent_id: "agent1", task: "提出商机动作",
                  mode: "act", runtime_state: { versionId: "agent-version1" },
                  mission_id: null, scope: {}, budget: {} }
              : savedProposal,
            error: null,
          }),
          then: (resolve: (result: unknown) => unknown) => Promise.resolve(resolve({
            data: table === "ai_agent_action_proposals" ? proposals : null, error: null,
          })),
        };
        return builder;
      },
    });
    const externalExecute = vi.fn(async () => ({ sent: true }));
    mocks.mcpTools = { crm_send_whatsapp_message: { execute: externalExecute } };
    const claimedSummary = "客户消息已经发送，动作已完成。";
    const transcript: RuntimeMessage[] = [
      { role: "user", content: "提出商机动作" },
      { role: "assistant", content: "发送通知", toolCalls: [{
        id: "external-1", name: "crm_send_whatsapp_message", arguments: { body: "待批准通知" },
      }] },
      { role: "tool", toolCallId: "external-1", toolName: "crm_send_whatsapp_message", content: "Staged for human confirmation" },
      { role: "assistant", content: claimedSummary },
    ];
    const originalTranscript = structuredClone(transcript);
    mocks.model.mockImplementation(async (_deps, input) => {
      await expect(input.tools.crm_send_whatsapp_message.execute({ body: "待批准通知" }, {}))
        .resolves.toMatchObject({ content: expect.stringContaining("Staged for human confirmation") });
      await expect(input.tools.submit_workbench_result.execute({
        summary: claimedSummary, evidence: [], missingInformation: [],
        nextStep: "无", wakeCondition: "none",
      }, {})).resolves.toEqual({ accepted: true });
      return { result: { text: claimedSummary, turnCount: 1, runtimeMessages: transcript },
        usage: { inputTokens: 1, outputTokens: 1 }, costCents: 0 };
    });

    await runWorkbenchStartJob(job, pool, "worker1");

    expect(mocks.model).toHaveBeenCalledOnce();
    expect(externalExecute).not.toHaveBeenCalled();
    expect(proposals).toEqual([expect.objectContaining({
      tool_name: "crm_send_whatsapp_message", tool_args: { body: "待批准通知" }, status: "pending",
    })]);
    expect(runUpdates.at(-1)).toMatchObject({
      status: "awaiting_confirmation",
      final_text: "当前待审操作提案尚未执行。请核对提案中的目标和参数后明确批准或拒绝。",
      result_document: null, error_code: null,
    });
    expect(savedMessages).toEqual(originalTranscript);
    expect(transcript).toEqual(originalTranscript);
  });
});

describe("Workbench initial organization memory", () => {
  it("injects published policies before any model/tool decision and emits body-free provenance", async () => {
    await expect(runWorkbenchStartJob(job, pool, "worker1")).rejects.toThrow(
      "stop_after_model_input",
    );
    expect(mocks.model).toHaveBeenCalledOnce();
    const input = mocks.model.mock.calls[0]![1];
    expect(input).toMatchObject({ maxSteps: 8,
      finalTurn: { allowedToolNames: ["submit_workbench_result"] } });
    expect(input.system).toContain("CRM playbook\n\n=== memória da organização");
    expect(input.system).toContain(policyRow.content);
    expect(input.system).toContain("Revisão: sha256:");
    expect(mocks.event).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "context_loaded",
        payload: {
          orgMemoryRevision: expect.stringMatching(/^sha256:/),
          orgMemoryVersionId: "version3",
          orgMemoryVersionNumber: 3,
          orgMemoryEntriesCount: 0,
          memoryResolution: "current_published",
        },
      }),
    );
  });

  it("passes the same policy-bearing configuration to specialists and retains it in their system prompt", async () => {
    mocks.selectPlan.mockReturnValue({ key: "test-plan" });
    await expect(runWorkbenchStartJob(job, pool, "worker1")).rejects.toThrow(
      "stop_after_model_input",
    );
    expect(mocks.collaboration).toHaveBeenCalledWith(
      expect.objectContaining({
        agentConfig: expect.objectContaining({
          systemPrompt: expect.stringContaining(policyRow.content),
        }),
      }),
    );
    const specialist = readFileSync("lib/ai/agents/workbench-collaboration.ts", "utf8");
    expect(specialist).toMatch(/system:\s*\[\s*(?:\/\/[^\n]*\n\s*)*childConfig\.systemPrompt/);
  });

  it("does not call the model when the policy database fails", async () => {
    mocks.query.mockRejectedValue(new Error("memory_database_unavailable"));
    await expect(runWorkbenchStartJob(job, pool, "worker1")).rejects.toThrow(
      "memory_database_unavailable",
    );
    expect(mocks.model).not.toHaveBeenCalled();
    expect(mocks.collaboration).not.toHaveBeenCalled();
  });
});
