import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentRuntimeEvent, RuntimeMessage } from "@/lib/agent-runtime";
import { OPPORTUNITY_REVIEW_PLAN } from "./collaboration";
import { runWorkbenchCollaboration } from "./workbench-collaboration";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), cleanup: vi.fn(), buildTools: vi.fn() }));
vi.mock("@/lib/agent-engine/agent/pi-turn-execution", () => ({ executePiTurnModelCall: mocks.execute }));
vi.mock("@/lib/agent-engine/edge/crm/mcp-tools", () => ({
  buildMcpTurnTools: (...args: unknown[]) => mocks.buildTools(...args),
}));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({}) }));
vi.mock("./workbench-events", () => ({ appendWorkbenchEvent: async () => undefined }));
vi.mock("./workbench-collaboration-review", () => ({
  finishInitialCollaborationReview: async (_pool: unknown, _org: unknown, _run: unknown,
    _scope: unknown, outcome: unknown) => outcome,
}));

function fixture(messages: RuntimeMessage[], text: string) {
  const updates: Array<Record<string, unknown>> = [];
  const admin = {
    from: (table: string) => {
      let isUpdate = false;
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: isUpdate ? { id: "child" } : null, error: null }),
        insert: async () => ({ error: null }),
        update: (value: Record<string, unknown>) => { isUpdate = true; updates.push(value); return builder; },
        upsert: async () => ({ error: null }),
      };
      expect(["ai_workbench_runs", "ai_agent_run_states"]).toContain(table);
      return builder;
    },
    rpc: async (_name: string, args: { p_attempt: string }) => ({
      data: [{ execution_attempt_id: args.p_attempt }], error: null,
    }),
  };
  mocks.execute.mockImplementation(async (_deps: unknown, input: {
    onEvent: (event: AgentRuntimeEvent) => Promise<void>;
  }) => {
    for (const message of messages.filter((message) => message.role === "tool")) {
      await input.onEvent({ type: "tool_execution_end", data: {
        tool_name: message.toolName, tool_call_id: message.toolCallId, is_error: message.isError,
      } });
    }
    return { result: { text, runtimeMessages: messages },
      usage: { inputTokens: 100, outputTokens: 20 }, costCents: null, events: [{ type: "turn_end" }] };
  });
  const input = {
    admin, deps: { crmCfg: {}, log: {}, llmCfg: {} },
    plan: { ...OPPORTUNITY_REVIEW_PLAN, specialists: OPPORTUNITY_REVIEW_PLAN.specialists.slice(0, 1) },
    root: { organizationId: "org", parentRunId: "parent", rootJobId: "job", agentId: "agent",
      actorUserId: null, task: "核对客户", scope: { contactId: "contact", leadId: null,
        conversationId: null, pipelineId: null }, budget: {} },
    agentConfig: { toolIds: ["crm_get_contact"], model: "qwen", provider: "dashscope",
      systemPrompt: "CRM" }, signal: new AbortController().signal,
  } as unknown as Parameters<typeof runWorkbenchCollaboration>[0];
  return { input, updates };
}

function observation(value: unknown): RuntimeMessage {
  return { role: "tool", toolName: "crm_get_contact", toolCallId: "call-1", isError: false,
    content: JSON.stringify(value), details: value };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.buildTools.mockResolvedValue({ tools: {}, cleanup: mocks.cleanup });
});

describe("workbench specialist result boundary", () => {
  it("keeps all organization policy while exposing only the selected customer's minimal tools", async () => {
    const { input } = fixture([observation({ id: "contact" })], "已核对事实");
    input.agentConfig.systemPrompt = "组织安全：禁止外联。父销售通用清单：先检查商机和跟进记录。";
    input.agentConfig.toolIds = ["crm_get_contact", "crm_list_conversations", "crm_get_conversation_history"];
    mocks.buildTools.mockResolvedValue({ tools: Object.fromEntries(input.agentConfig.toolIds.map(name =>
      [name, { execute: async () => ({}) }])), cleanup: mocks.cleanup });
    await runWorkbenchCollaboration(input);
    const call = mocks.execute.mock.calls[0]?.[1];

    expect(Object.keys(call.tools)).toEqual(["crm_get_contact"]);
    expect(call.system).toContain(input.agentConfig.systemPrompt);
    expect(call.system).toContain("通用销售工作清单不能扩大本次专职取证范围");
    expect(call.system).toContain("未分配给本角色的事实");
    expect(mocks.buildTools.mock.calls[0]?.[2].toolIds).toEqual(["crm_get_contact"]);
  });

  it("does not invent a contact target or widen tools when selected scope is absent", async () => {
    const { input } = fixture([], "没有选中客户或会话，无法取证。");
    input.root.scope.contactId = null;
    input.plan.specialists = [OPPORTUNITY_REVIEW_PLAN.specialists[0]!];
    const outcome = await runWorkbenchCollaboration(input);

    expect(mocks.buildTools.mock.calls[0]?.[2].toolIds).toEqual([]);
    expect(Object.keys(mocks.execute.mock.calls[0]?.[1].tools)).toEqual([]);
    expect(outcome.results[0]).toMatchObject({ status: "partial", missingMaterial: ["tool_observations"] });
  });

  it("reserves the original final turn and persists a genuine nonempty model summary", async () => {
    const { input, updates } = fixture([observation({ id: "contact", name: "合成客户" })], "已核对合成客户。");
    const outcome = await runWorkbenchCollaboration(input);

    expect(mocks.execute.mock.calls[0]?.[1]).toMatchObject({ maxSteps: 3,
      finalTurn: { allowedToolNames: [] } });
    expect(outcome.results[0]).toMatchObject({ status: "complete", summary: "已核对合成客户。" });
    expect(updates).toContainEqual(expect.objectContaining({ status: "completed", final_text: "已核对合成客户。" }));
    expect(mocks.cleanup).toHaveBeenCalledOnce();
  });

  it("does not turn successful tool observations into a fabricated summary", async () => {
    const { input, updates } = fixture([observation({ id: "contact", name: "合成客户" })], "");
    const outcome = await runWorkbenchCollaboration(input);

    expect(outcome.results[0]).toMatchObject({ status: "partial", summary: "",
      missingMaterial: ["specialist_summary"] });
    expect(updates).toContainEqual(expect.objectContaining({ status: "partial", final_text: null }));
  });

  it.each([{ permitido: false, motivo: "target_scope_denied" }, { ok: false }, { error: "read_failed" }])(
    "keeps a provider/CRM refusal partial even when isError was false: %j", async (value) => {
      const { input } = fixture([observation(value)], "本次读取被拒绝，缺少客户事实。");
      const outcome = await runWorkbenchCollaboration(input);

      expect(outcome.results[0]).toMatchObject({ status: "partial", evidence: [], claims: [],
        missingMaterial: ["failed_tool_observations"] });
    },
  );
});
