import type { RuntimeMessage } from "@/lib/agent-runtime";
import { isToolSchemaRejection } from "@/lib/agent-runtime/schema-rejection";
import { executePiTurnModelCall } from "@/lib/agent-engine/agent/pi-turn-execution";
import type { RunModelCallInput } from "@/lib/agent-engine/edge/llm/run-model-call";
import {
  type createWorkbenchResultChannel,
  SUBMIT_WORKBENCH_RESULT_TOOL,
  WORKBENCH_RESULT_INSTRUCTION,
} from "@/lib/ai/agents/workbench-result-submission";

type ModelCall = Awaited<ReturnType<typeof executePiTurnModelCall>>;

export type ResultRecoveryState =
  | "not_needed" | "deferred_actions" | "skipped_budget" | "skipped_unknown_cost"
  | "submitted" | "missing" | "failed";

/** One follow-up call, with at most two existing turns for submission/schema correction. */
export async function recoverWorkbenchResult(input: {
  deps: Parameters<typeof executePiTurnModelCall>[0];
  first: ModelCall;
  originalCall: RunModelCallInput;
  channel: ReturnType<typeof createWorkbenchResultChannel>;
  hasProposedActions: boolean;
  maxRemainingSteps: number;
  remainingTokens: number | null;
  remainingCostCents: number | null;
  beforeSideEffect?: () => Promise<void>;
  execute?: typeof executePiTurnModelCall;
}): Promise<{ call: ModelCall; state: ResultRecoveryState }> {
  if (input.channel.submitted()) return { call: input.first, state: "not_needed" };
  // CRM must execute/approve staged actions and feed observations back to Pi
  // before asking for a final result. Otherwise the result may claim a write
  // that has not happened yet.
  if (input.hasProposedActions) return { call: input.first, state: "deferred_actions" };
  const tokensLeft = input.remainingTokens === null
    ? null
    : input.remainingTokens - input.first.usage.inputTokens - input.first.usage.outputTokens;
  const costLeft = input.remainingCostCents === null
    ? null
    : input.first.costCents === null
      ? null
      : input.remainingCostCents - input.first.costCents;
  if (
    input.maxRemainingSteps < 1 ||
    (tokensLeft !== null && tokensLeft <= 0)
  ) return { call: input.first, state: "skipped_budget" };
  if (input.remainingCostCents !== null && input.first.costCents === null) {
    return { call: input.first, state: "skipped_unknown_cost" };
  }
  if (costLeft !== null && costLeft <= 0) return { call: input.first, state: "skipped_budget" };

  // A positive balance is not enough: the next request repeats the prior
  // context. Reserve at least the last observed input turn (plus margin) and
  // a useful output allowance before starting another paid/provider call.
  // The provider may tokenize differently, so this is a conservative gate,
  // not a claim of exact preflight token counting.
  const lastInput = [...input.first.result.runtimeMessages]
    .reverse()
    .find((message) => message.role === "assistant" && (message.usage?.inputTokens ?? 0) > 0);
  const averageInput = input.first.usage.inputTokens / Math.max(1, input.first.result.turnCount);
  const expectedInput = lastInput?.role === "assistant"
    ? Math.max(lastInput.usage?.inputTokens ?? 0, averageInput)
    : averageInput;
  const reservedInput = Math.ceil(expectedInput * 1.25) + 256;
  const configuredOutputCap = Math.min(input.originalCall.maxOutputTokens ?? 4_000, 4_000);
  // A rejected tool call can echo its arguments. Budget a repeated context,
  // that echo, and both outputs before offering a second provider turn.
  const twoTurnCap = tokensLeft === null ? configuredOutputCap
    : Math.min(configuredOutputCap, Math.floor((tokensLeft - 2 * reservedInput - 512) / 4));
  const recoveryTurns = input.maxRemainingSteps >= 2 &&
    twoTurnCap >= Math.max(512, Math.min(configuredOutputCap, 1024)) ? 2 : 1;
  const outputCap = recoveryTurns === 2 ? twoTurnCap : Math.min(
    input.originalCall.maxOutputTokens ?? 4_000,
    4_000,
    tokensLeft === null ? 4_000 : Math.floor(tokensLeft - reservedInput),
  );
  if (outputCap < 512) {
    return { call: input.first, state: "skipped_budget" };
  }

  await input.beforeSideEffect?.();
  input.originalCall.abortSignal?.throwIfAborted();
  const reminder: RuntimeMessage = {
    role: "user",
    content: [
      "只完成结果提交。此前 CRM 读取结果已在上文；不要再次读取、修改 CRM 或发送消息。",
      "现在必须调用 submit_workbench_result 一次。缺少的事实写入 missingInformation；",
      "每条 evidence.assertions 最多 4 项；只复制实际观察字段。schema 被拒时只修正格式，不新增事实。",
      "summary 简短归纳，不抄写全部工具结果；只保留必要的类型正确的证据，无法逐值核对时省略 assertions。",
      "已提出但未由 CRM 确认完成的动作不能写成已执行。不要输出普通文本答案。",
    ].join(""),
  };
  try {
    const recovered = await (input.execute ?? executePiTurnModelCall)(input.deps, {
      ...input.originalCall,
      system: `${input.originalCall.system ?? ""}\n${WORKBENCH_RESULT_INSTRUCTION}\n本轮仅允许结果提交，不允许 CRM 工具。`,
      messages: [],
      runtimeMessages: [...input.first.result.runtimeMessages, reminder],
      tools: input.channel.tools,
      maxSteps: recoveryTurns,
      maxOutputTokens: outputCap,
      beforeToolCall: undefined,
      afterToolCall: undefined,
      onEvent: undefined,
      shouldStopAfterTurn: ({ message, toolResults, cumulativeUsage, costCents }) => {
        if (input.channel.submitted()) return true;
        // Business refusals (including a missing approval proposal), plain
        // answers and unrelated failures must not cause another paid attempt.
        if (!toolResults?.length || !toolResults.every((result) =>
          isToolSchemaRejection(result, new Set([SUBMIT_WORKBENCH_RESULT_TOOL])))) return true;
        const nextInput = Math.ceil(Math.max(
          message.role === "assistant" ? message.usage?.inputTokens ?? 0 : 0,
          expectedInput,
        ) * 1.25) + 256 + 2 * outputCap + 512;
        return (tokensLeft !== null && tokensLeft - cumulativeUsage.totalTokens < nextInput + outputCap) ||
          (costLeft !== null && (costCents === null || costCents * 2 >= costLeft));
      },
    });
    return {
      call: recovered,
      state: input.channel.submitted() ? "submitted" : "missing",
    };
  } catch (error) {
    if (input.originalCall.abortSignal?.aborted) throw error;
    // A lost lease or cancelled Mission must not be disguised as model failure.
    await input.beforeSideEffect?.();
    return { call: input.first, state: "failed" };
  }
}
