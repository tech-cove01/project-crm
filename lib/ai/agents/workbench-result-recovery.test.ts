import { describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { PiAgentRuntime } from "@/lib/agent-runtime/pi/runtime";
import { runPiAiSdkCall } from "@/lib/agent-runtime/pi/ai-sdk-compat";
import type { executePiTurnModelCall } from "@/lib/agent-engine/agent/pi-turn-execution";
import {
  createWorkbenchResultChannel,
  SUBMIT_WORKBENCH_RESULT_TOOL,
} from "@/lib/ai/agents/workbench-result-submission";
import { recoverWorkbenchResult } from "@/lib/ai/agents/workbench-result-recovery";

const submission = {
  summary: "已读取商机，交期仍未知。",
  evidence: [],
  missingInformation: ["交期"],
  nextStep: "询问交付团队",
  wakeCondition: "internal_response",
};

function fixture() {
  const channel = createWorkbenchResultChannel();
  const first = {
    result: {
      runtimeMessages: [{ role: "assistant", content: "Let me read the lead." }],
      turnCount: 3,
    },
    usage: { inputTokens: 100, outputTokens: 20 },
    costCents: 0,
  } as unknown as Awaited<ReturnType<typeof executePiTurnModelCall>>;
  const originalCall = {
    tenantId: "org-1",
    messages: [],
    system: "Check CRM facts.",
    tools: { crm_get_lead: { execute: async () => ({ shouldNotRun: true }) } },
    abortSignal: new AbortController().signal,
  } as never;
  return { channel, first, originalCall };
}

function realPiExecute(responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]) {
  const faux = fauxProvider({ provider: "recovery-test", models: [{ id: "model" }] });
  faux.setResponses(responses);
  const runtime = new PiAgentRuntime(() => ({ model: faux.getModel() as never,
    streamFn: faux.provider.streamSimple.bind(faux.provider) as never }));
  return vi.fn(async (_deps: unknown, call: Parameters<typeof executePiTurnModelCall>[1]) => {
    const result = await runPiAiSdkCall({
      system: call.system ?? "", messages: [], runtimeMessages: call.runtimeMessages,
      tools: call.tools, maxSteps: call.maxSteps,
      model: { provider: "recovery-test", model: "model", apiKey: "fake" }, runtime,
      shouldStopAfterTurn: turn => call.shouldStopAfterTurn?.({ ...turn,
        cumulativeUsage: turn.usage, costCents: 0 }) ?? false,
    });
    return { result, events: result.events,
      usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens }, costCents: 0 };
  });
}

const tooManyAssertions = {
  ...submission,
  evidence: [{ sourceType: "lead", sourceId: "2e32ecb0-674b-4166-b14b-f961c92e427e", claim: "实际商机字段",
    assertions: [
      { field: "status", equals: "open" }, { field: "stage_id", equals: "stage" },
      { field: "value_cents", equals: null }, { field: "currency", equals: "BRL" },
      { field: "expected_close_date", equals: null },
    ] }],
};
const invalidSubmission = () => fauxAssistantMessage(fauxToolCall(SUBMIT_WORKBENCH_RESULT_TOOL, tooManyAssertions),
  { stopReason: "toolUse" });

describe("bounded structured-result recovery", () => {
  it("uses two remaining real Pi turns to correct schema rejection without CRM tools or a third attempt", async () => {
    const { first, originalCall, channel } = fixture();
    const corrected = { ...tooManyAssertions, evidence: tooManyAssertions.evidence.map(item => ({ ...item,
      assertions: item.assertions.slice(0, 4) })) };
    const execute = realPiExecute([invalidSubmission(),
      fauxAssistantMessage(fauxToolCall(SUBMIT_WORKBENCH_RESULT_TOOL, corrected), { stopReason: "toolUse" }),
      invalidSubmission(),
    ]);
    const result = await recoverWorkbenchResult({ deps: {} as never, first, originalCall, channel,
      hasProposedActions: false, maxRemainingSteps: 2, remainingTokens: 30_000, remainingCostCents: null,
      execute: execute as never });

    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[1].maxSteps).toBe(2);
    expect(Object.keys(execute.mock.calls[0]?.[1].tools ?? {})).toEqual([SUBMIT_WORKBENCH_RESULT_TOOL]);
    expect(result.state).toBe("submitted");
    expect(result.call.result.turnCount).toBe(2);
    expect(channel.submitted()?.evidence[0]?.assertions).toHaveLength(4);
    expect(result.call.result.runtimeMessages.some(message => message.role === "tool" && message.isError)).toBe(true);
  });

  it("stops after two schema rejections and does not relax the four-assertion schema", async () => {
    const { first, originalCall, channel } = fixture();
    const execute = realPiExecute([invalidSubmission(), invalidSubmission(), invalidSubmission()]);
    const result = await recoverWorkbenchResult({ deps: {} as never, first, originalCall, channel,
      hasProposedActions: false, maxRemainingSteps: 2, remainingTokens: 30_000, remainingCostCents: null,
      execute: execute as never });

    expect(result.state).toBe("missing");
    expect(channel.submitted()).toBeNull();
    expect(result.call.result.turnCount).toBe(2);
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each(["business_refusal", "plain_text"])("does not turn %s into a schema retry", async kind => {
    const { first, originalCall } = fixture();
    const channel = createWorkbenchResultChannel({ hasPendingApproval: () => false });
    const rejected = kind === "plain_text" ? fauxAssistantMessage("没有结构化结果。")
      : fauxAssistantMessage(fauxToolCall(SUBMIT_WORKBENCH_RESULT_TOOL,
        { ...submission, wakeCondition: "human_approval" }), { stopReason: "toolUse" });
    const execute = realPiExecute([rejected, invalidSubmission()]);
    const result = await recoverWorkbenchResult({ deps: {} as never, first, originalCall, channel,
      hasProposedActions: false, maxRemainingSteps: 2, remainingTokens: 30_000, remainingCostCents: null,
      execute: execute as never });

    expect(result.state).toBe("missing");
    expect(result.call.result.turnCount).toBe(1);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("downgrades to one turn when repeated context and useful outputs do not fit", async () => {
    const { first, originalCall, channel } = fixture();
    const execute = realPiExecute([invalidSubmission(), invalidSubmission()]);
    const result = await recoverWorkbenchResult({ deps: {} as never, first, originalCall, channel,
      hasProposedActions: false, maxRemainingSteps: 2, remainingTokens: 2_000, remainingCostCents: null,
      execute: execute as never });

    expect(execute.mock.calls[0]?.[1].maxSteps).toBe(1);
    expect(result.call.result.turnCount).toBe(1);
    expect(channel.submitted()).toBeNull();
  });

  it("exposes only the result tool and reuses prior observations", async () => {
    const { channel, first, originalCall } = fixture();
    const execute = vi.fn(async (_deps, call: {
      tools: Record<string, { execute: (args: unknown, options: unknown) => Promise<unknown> }>;
      runtimeMessages: Array<{ role: string; content: string }>;
      maxSteps: number;
      maxOutputTokens: number;
    }) => {
      expect(Object.keys(call.tools)).toEqual([SUBMIT_WORKBENCH_RESULT_TOOL]);
      expect(call.runtimeMessages.map((message) => message.role)).toEqual(["assistant", "user"]);
      expect(call.maxSteps).toBe(1);
      expect(call.maxOutputTokens).toBeLessThanOrEqual(1000);
      await call.tools[SUBMIT_WORKBENCH_RESULT_TOOL]!.execute(submission, {});
      return { ...first, result: { ...first.result, turnCount: 1 } };
    });
    const recovered = await recoverWorkbenchResult({
      deps: {} as never, first, originalCall, channel, hasProposedActions: false,
      maxRemainingSteps: 2, remainingTokens: 1000, remainingCostCents: 10,
      execute: execute as never,
    });
    expect(recovered.state).toBe("submitted");
    expect(channel.submitted()).toMatchObject({ summary: submission.summary });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not spend another model call after budget exhaustion", async () => {
    const { channel, first, originalCall } = fixture();
    const execute = vi.fn();
    const recovered = await recoverWorkbenchResult({
      deps: {} as never, first, originalCall, channel, hasProposedActions: false,
      maxRemainingSteps: 0, remainingTokens: 1000, remainingCostCents: 10,
      execute: execute as never,
    });
    expect(recovered).toEqual({ call: first, state: "skipped_budget" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("reserves the next context and useful output instead of overspending a small positive balance", async () => {
    const { channel, first, originalCall } = fixture();
    const execute = vi.fn();
    const recovered = await recoverWorkbenchResult({
      deps: {} as never,
      first: {
        ...first,
        result: {
          ...first.result,
          runtimeMessages: [{ role: "assistant", content: "Observed CRM", usage: { inputTokens: 3_000 } }],
        },
      } as typeof first,
      originalCall, channel, hasProposedActions: false,
      maxRemainingSteps: 2, remainingTokens: 2_000, remainingCostCents: 10,
      execute: execute as never,
    });
    expect(recovered.state).toBe("skipped_budget");
    expect(execute).not.toHaveBeenCalled();
  });

  it("distinguishes unknown provider pricing from exhausted budget", async () => {
    const { channel, first, originalCall } = fixture();
    const execute = vi.fn();
    const recovered = await recoverWorkbenchResult({
      deps: {} as never,
      first: { ...first, costCents: null },
      originalCall, channel, hasProposedActions: false,
      maxRemainingSteps: 2, remainingTokens: 1000, remainingCostCents: 10,
      execute: execute as never,
    });
    expect(recovered.state).toBe("skipped_unknown_cost");
    expect(execute).not.toHaveBeenCalled();
  });

  it("waits for staged CRM actions to produce observations before final submission", async () => {
    const { channel, first, originalCall } = fixture();
    const execute = vi.fn();
    const recovered = await recoverWorkbenchResult({
      deps: {} as never, first, originalCall, channel, hasProposedActions: true,
      maxRemainingSteps: 2, remainingTokens: 1000, remainingCostCents: 10,
      execute: execute as never,
    });
    expect(recovered).toEqual({ call: first, state: "deferred_actions" });
    expect(execute).not.toHaveBeenCalled();
  });
});
