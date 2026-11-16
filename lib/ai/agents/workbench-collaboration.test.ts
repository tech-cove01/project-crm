import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentRuntimeEvent, RuntimeMessage } from "@/lib/agent-runtime";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { PiAgentRuntime } from "@/lib/agent-runtime/pi/runtime";
import { runPiAiSdkCall } from "@/lib/agent-runtime/pi/ai-sdk-compat";
import type { executePiTurnModelCall } from "@/lib/agent-engine/agent/pi-turn-execution";
import { OPPORTUNITY_REVIEW_PLAN } from "./collaboration";
import { runWorkbenchCollaboration } from "./workbench-collaboration";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), cleanup: vi.fn(), buildTools: vi.fn(), appendEvent: vi.fn() }));
vi.mock("@/lib/agent-engine/agent/pi-turn-execution", () => ({ executePiTurnModelCall: mocks.execute }));
vi.mock("@/lib/agent-engine/edge/crm/mcp-tools", () => ({
  buildMcpTurnTools: (...args: unknown[]) => mocks.buildTools(...args),
}));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({}) }));
vi.mock("./workbench-events", () => ({ appendWorkbenchEvent: async (...args: unknown[]) => {
  mocks.appendEvent(...args);
} }));
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
      actorUserId: null, mode: "inspect", task: "核对客户", scope: { contactId: "contact", leadId: null,
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

function recordTool(field: string) {
  return { description: "Read selected record", inputSchema: { type: "object", properties: { [field]: { type: "string" } }, required: [field] },
    execute: async (args: Record<string, string>) => ({ id: args[field], status: "open" }) };
}

const authorizedPolicy = { id: "policy-receipt", namespace: "organization_wiki", kind: "wiki_page",
  title: "审批原文", excerpt: "等待人工明确决定", locator: { provider: "weknora", sourceId: "published-source" } };

function knowledge(query: string, wikiStatus: string, evidence: unknown[] = [], verified = wikiStatus === "empty"): RuntimeMessage {
  return {
    role: "tool", toolName: "crm_search_knowledge", toolCallId: `wiki-${query}-${wikiStatus}`, isError: false,
    content: JSON.stringify({
      evidence, trechos: [],
      retrieval: { query, status: evidence.length ? "complete" : "empty", wiki_status: wikiStatus,
        empty_verified: verified, missing: [] },
    }),
  };
}

function policyFixture(messages: RuntimeMessage[], allowEmpty = false) {
  const prepared = fixture(messages, "已报告政策工具当前结果。");
  const { input } = prepared;
  input.root.task = '产品原文使用企业知识搜索词“审批”。' +
    (allowEmpty ? "若正常检索没有匹配，按缺证项留空。" : "要求该政策原文。");
  input.plan.specialists = OPPORTUNITY_REVIEW_PLAN.specialists.filter(s => s.key === "policy_advisor");
  input.agentConfig.toolIds = ["crm_search_knowledge", "crm_get_org_memory"];
  input.agentConfig.knowledgeSourceIds = ["published-source"];
  return prepared;
}

function useRealPi(responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]) {
  const faux = fauxProvider({ provider: "specialist-test", models: [{ id: "model" }] });
  faux.setResponses(responses);
  const runtime = new PiAgentRuntime(() => ({ model: faux.getModel() as never,
    streamFn: faux.provider.streamSimple.bind(faux.provider) as never }));
  mocks.execute.mockImplementation(async (_deps: unknown, call: Parameters<typeof executePiTurnModelCall>[1]) => {
    const result = await runPiAiSdkCall({ system: call.system ?? "", messages: call.messages,
      tools: call.tools, maxSteps: call.maxSteps, finalTurn: call.finalTurn,
      beforeToolCall: call.beforeToolCall, onEvent: call.onEvent, runtime,
      model: { provider: "specialist-test", model: "model", apiKey: "fake" },
      shouldStopAfterTurn: turn => call.shouldStopAfterTurn?.({ ...turn, cumulativeUsage: turn.usage, costCents: 0 }) ?? false });
    return { result, events: result.events, usage: { inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens }, costCents: 0 };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.buildTools.mockResolvedValue({ tools: { crm_get_contact: recordTool("contact_id") }, cleanup: mocks.cleanup });
});

describe("workbench specialist result boundary", () => {
  it.each(["customer_evidence", "opportunity_diagnosis"])("closes %s record tools immediately after its selected read", async key => {
    const { input } = fixture([], "");
    const tool = key === "customer_evidence" ? "crm_get_contact" : "crm_get_lead";
    const field = key === "customer_evidence" ? "contact_id" : "lead_id";
    const extraTool = key === "customer_evidence" ? "crm_get_lead" : "crm_get_contact";
    input.plan.specialists = OPPORTUNITY_REVIEW_PLAN.specialists.filter(s => s.key === key);
    input.agentConfig.toolIds = [tool];
    input.root.scope.leadId = "lead";
    mocks.buildTools.mockResolvedValue({ tools: { [tool]: recordTool(field) }, cleanup: mocks.cleanup });
    let secondTools: string[] = [];
    useRealPi([
      fauxAssistantMessage(fauxToolCall(tool, { [field]: field === "contact_id" ? input.root.scope.contactId : input.root.scope.leadId }), { stopReason: "toolUse" }),
      context => {
        secondTools = getCurrentTools(context.messages).map(tool => tool.name);
        return secondTools.length ? fauxAssistantMessage(fauxToolCall(extraTool, {}), { stopReason: "toolUse" })
          : fauxAssistantMessage("仅根据本次成功读取报告所选记录事实。");
      },
      fauxAssistantMessage("must not use a third turn"),
    ]);
    const result = await runWorkbenchCollaboration(input);

    expect(mocks.execute.mock.calls[0]?.[1].maxSteps).toBe(2);
    expect(secondTools).toEqual([]);
    expect(result.results[0]).toMatchObject({ status: "complete", toolCalls: 1, missingMaterial: [], usage: { modelTurns: 2 } });
  });

  it("keeps two explicit record reads and one tool-free answer within the original three turns", async () => {
    const { input } = fixture([], "");
    input.root.scope.conversationId = "conversation";
    input.agentConfig.toolIds = ["crm_get_contact", "crm_get_conversation_history"];
    mocks.buildTools.mockResolvedValue({ tools: { crm_get_contact: recordTool("contact_id"),
      crm_get_conversation_history: recordTool("conversation_id") }, cleanup: mocks.cleanup });
    let lastTools: string[] = [];
    useRealPi([
      fauxAssistantMessage(fauxToolCall("crm_get_contact", { contact_id: "contact" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("crm_get_conversation_history", { conversation_id: "conversation" }), { stopReason: "toolUse" }),
      context => { lastTools = getCurrentTools(context.messages).map(tool => tool.name); return fauxAssistantMessage("已读取明确选择的客户与会话。"); },
    ]);
    const result = await runWorkbenchCollaboration(input);

    expect(mocks.execute.mock.calls[0]?.[1].maxSteps).toBe(3);
    expect(lastTools).toEqual([]);
    expect(result.results[0]).toMatchObject({ status: "complete", toolCalls: 2, usage: { modelTurns: 3 } });
  });

  it("keeps a hallucinated tool request partial even if the tool-free final phase was already reached", async () => {
    const { input } = fixture([], "");
    useRealPi([
      fauxAssistantMessage(fauxToolCall("crm_get_contact", { contact_id: "contact" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("crm_get_lead", {}), { stopReason: "toolUse" }),
    ]);
    const result = await runWorkbenchCollaboration(input);

    expect(result.results[0]?.status).toBe("partial");
    expect(result.results[0]?.missingMaterial).toContain("failed_tool_observations");
    expect(result.results[0]?.usage.modelTurns).toBe(2);
  });

  it("retains three turns for two policy queries even when only one search tool is exposed", async () => {
    const { input } = fixture([], "未执行额外业务动作。");
    input.plan.specialists = OPPORTUNITY_REVIEW_PLAN.specialists.filter(s => s.key === "policy_advisor");
    input.agentConfig.toolIds = ["crm_search_knowledge"];
    mocks.buildTools.mockResolvedValue({ tools: { crm_search_knowledge: { execute: async () => ({}) } }, cleanup: mocks.cleanup });
    await runWorkbenchCollaboration(input);

    expect(mocks.execute.mock.calls[0]?.[1]).toMatchObject({ maxSteps: 3, finalTurn: { allowedToolNames: [] } });
  });

  it("keeps the durable policy specialist in an explicitly CRM-only inspect run without searching unneeded material", async () => {
    const { input, updates } = policyFixture([]);
    input.root.task = "请取得实际依据并回答：value_cents（当前金额）。\n这是范围内的 CRM 核对；只需回答指定字段。";
    const result = await runWorkbenchCollaboration(input);

    expect(result.results[0]).toMatchObject({ specialistKey: "policy_advisor", status: "complete", evidence: [],
      missingMaterial: [], toolCalls: 0, usage: { modelTurns: 0 } });
    expect(updates).toContainEqual(expect.objectContaining({ status: "completed" }));
    expect(mocks.buildTools).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.appendEvent).toHaveBeenCalledWith(input.admin, expect.objectContaining({
      type: "usage_reported", payload: { inputTokens: 0, outputTokens: 0, costCents: null, calls: 0 },
    }));

    input.root.mode = "act";
    const act = await runWorkbenchCollaboration(input);
    expect(mocks.buildTools).toHaveBeenCalledOnce();
    expect(act.results[0]).toMatchObject({ status: "partial", missingMaterial: ["tool_observations"] });
  });

  it.each([
    "value_cents（当前金额（分，数字））",
    "stage_id（商机当前阶段 UUID）、value_cents（当前金额（分，数字））",
    "stage_id (商机当前阶段 UUID), value_cents (当前金额 (分,数字))",
  ])("keeps the policy role idle for a scoped field list with display labels: %s", async fields => {
    const { input } = policyFixture([]);
    input.root.task = [
      "合成资料的只读销售核对。只处理指定商机与关联客户。",
      `请取得实际依据并回答：${fields}。`,
      "备注留有旧销售快照。若与当前结构化字段冲突，按权威的当前 CRM 字段填写。",
      "这是范围内的 CRM 核对；只需回答指定字段。",
      "请把 submit_workbench_result.summary 写成纯 JSON 对象。对缺失的政策填 null。不提案、不外发。",
    ].join("\n");
    const outcome = await runWorkbenchCollaboration(input);

    expect(outcome.results[0]).toMatchObject({ status: "complete", toolCalls: 0, usage: { modelTurns: 0 } });
    expect(mocks.buildTools).not.toHaveBeenCalled();
  });

  it.each([
    "只核当前金额和阶段，不需要公司政策",
    "请仅核对当前金额及商机阶段，\r\n无需查询企业政策。",
    "请只确认商机当前币种与阶段。\n不必查组织政策。",
  ])("accepts a bounded equivalent current request: %s", async task => {
    const { input } = policyFixture([]);
    input.root.task = task;
    const outcome = await runWorkbenchCollaboration(input);

    expect(outcome.results[0]).toMatchObject({ status: "complete", toolCalls: 0, usage: { modelTurns: 0 } });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    "查金额并判断折扣能否批准。",
    "旧备注说“只核当前金额和阶段，不需要公司政策”。请判断客户提出的折扣能否批准。",
    "请取得实际依据并回答：value_cents（当前金额（分，数字））。\n这是范围内的 CRM 核对；只需回答指定字段。\n另外请确认能否承诺加急。",
    "请取得实际依据并回答：value_cents（当前金额（分，数字）。\n这是范围内的 CRM 核对；只需回答指定字段。",
    "请取得实际依据并回答：value_cents（当前金额（分，数字）。\n这是范围内的 CRM 核对；只需回答指定字段。\n只核 CRM 字段，不需要公司政策。",
    "请取得实际依据并回答：value_cents（当前金额）。\n这是范围内的 CRM 核对；只需回答指定字段。\n另外请核实付费版本是否含审计日志，客户可以选择哪些条款。",
    "旧备注原文如下：\n请取得实际依据并回答：value_cents（当前金额）。\n这是范围内的 CRM 核对；只需回答指定字段。\n当前任务请确定支持的计费规则。",
  ])("retains normal policy checks for another requirement or an ambiguous field list: %s", async task => {
    const { input } = policyFixture([]);
    input.root.task = task;
    const outcome = await runWorkbenchCollaboration(input);

    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(outcome.results[0]).toMatchObject({ status: "partial", missingMaterial: ["tool_observations"] });
  });

  it("keeps tool authority and executes the explicitly selected query after a model tries to rewrite it", async () => {
    const { input } = policyFixture([]);
    const read = vi.fn(async (args: Record<string, unknown>) => {
      const response = knowledge(String(args.pergunta), "complete", [authorizedPolicy]);
      return JSON.parse(response.content as string);
    });
    mocks.buildTools.mockResolvedValue({
      tools: { crm_search_knowledge: { ...recordTool("pergunta"), execute: read }, crm_get_org_memory: recordTool("unused") },
      cleanup: mocks.cleanup,
    });
    useRealPi([
      fauxAssistantMessage(fauxToolCall("crm_search_knowledge", { pergunta: "无关政策" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("已取得审批原文。"),
    ]);
    const result = await runWorkbenchCollaboration(input);

    expect(mocks.buildTools.mock.calls[0]?.[2].toolIds).toEqual(["crm_search_knowledge"]);
    expect(mocks.buildTools.mock.calls[0]?.[4]).toMatchObject({ readOnly: true });
    expect(read).toHaveBeenCalledOnce();
    expect(read.mock.calls[0]?.[0]).toMatchObject({ pergunta: "审批" });
    expect(result.results[0]).toMatchObject({ status: "complete", evidence: [authorizedPolicy] });
  });

  it("does not force a query or permit empty results based on a prohibited or quoted phrase", async () => {
    const prohibited = policyFixture([knowledge("审批", "empty")], true);
    prohibited.input.root.task = "禁止使用企业知识搜索词“审批”。若正常检索没有匹配，按缺证项留空。";
    expect((await runWorkbenchCollaboration(prohibited.input)).results[0]).toMatchObject({
      status: "partial", missingMaterial: ["required_policy_evidence"],
    });
    expect(mocks.buildTools.mock.calls[0]?.[2].toolIds).toEqual(["crm_search_knowledge", "crm_get_org_memory"]);

    const disallow = policyFixture([knowledge("审批", "empty")]);
    disallow.input.root.task += "\n旧说明写着：若正常检索没有匹配，按缺证项留空。";
    expect((await runWorkbenchCollaboration(disallow.input)).results[0]?.status).toBe("partial");
  });

  it("resolves early empty only when the required term later returns an authorized observation", async () => {
    const { input } = policyFixture([knowledge("审批", "empty"), knowledge("审批", "complete", [authorizedPolicy])]);
    const result = await runWorkbenchCollaboration(input);
    expect(result.results[0]).toMatchObject({ status: "complete", missingMaterial: [] });
  });

  it.each([
    ["required absent", [knowledge("审批", "empty")], "required_policy_evidence"],
    ["unrelated hit", [knowledge("审批", "empty"), knowledge("其他", "complete", [authorizedPolicy])], "required_policy_evidence"],
    ["unauthorized hit", [knowledge("审批", "complete", [{ ...authorizedPolicy,
      locator: { provider: "weknora", sourceId: "other-source" } }])], "published_knowledge_sources"],
    ["service unavailable even after a hit", [knowledge("审批", "complete", [authorizedPolicy]),
      knowledge("审批", "unavailable")], "published_knowledge_sources"],
  ])("keeps %s partial", async (_label, messages, missing) => {
    const { input } = policyFixture(messages);
    const result = await runWorkbenchCollaboration(input);
    expect(result.results[0]).toMatchObject({ status: "partial", missingMaterial: [missing] });
  });

  it("records verified absence only for an exact allowed-empty check", async () => {
    const { input } = policyFixture([knowledge("审批", "empty")], true);
    const result = await runWorkbenchCollaboration(input);
    expect(result.results[0]).toMatchObject({
      status: "complete", evidence: [], missingMaterial: [], summary: expect.stringContaining("正常检索无匹配"),
    });

    for (const wikiStatus of ["disabled", "unavailable"]) {
      const afterFailure = policyFixture([knowledge("审批", wikiStatus)], true);
      const guarded = await runWorkbenchCollaboration(afterFailure.input);
      expect(guarded.results[0]?.status).toBe("partial");
    }
    const unverified = policyFixture([knowledge("审批", "empty", [], false)], true);
    expect((await runWorkbenchCollaboration(unverified.input)).results[0]?.status).toBe("partial");
  });

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
    expect(mocks.execute.mock.calls[0]?.[1].maxSteps).toBe(1);
    expect(outcome.results[0]).toMatchObject({ status: "partial", missingMaterial: ["tool_observations"] });
  });

  it("reserves the original final turn and persists a genuine nonempty model summary", async () => {
    const { input, updates } = fixture([observation({ id: "contact", name: "合成客户" })], "已核对合成客户。");
    const outcome = await runWorkbenchCollaboration(input);

    expect(mocks.execute.mock.calls[0]?.[1]).toMatchObject({ maxSteps: 2,
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

  it.each([{ permitido: false, motivo: "target_scope_denied" }, { ok: false }, { error: "read_failed" }, { erro: "refused" }])(
    "keeps a provider/CRM refusal partial even when isError was false: %j", async (value) => {
      const { input } = fixture([observation(value)], "本次读取被拒绝，缺少客户事实。");
      const outcome = await runWorkbenchCollaboration(input);

      expect(outcome.results[0]).toMatchObject({ status: "partial", evidence: [], claims: [],
        missingMaterial: ["failed_tool_observations"] });
    },
  );
});
