import { describe, expect, it } from "vitest";
import {
  createWorkbenchResultChannel,
  resultDocument,
  workbenchVisibleResult,
  SUBMIT_WORKBENCH_RESULT_TOOL,
  workbenchResultSchema,
  workbenchResultPartialReason,
  workbenchFinalText,
  WORKBENCH_RESULT_INSTRUCTION,
} from "@/lib/ai/agents/workbench-result-submission";

const candidate = {
  summary: "已核对商机；交期仍需确认。",
  evidence: [
    {
      sourceType: "lead" as const,
      sourceId: "67b72c24-741b-4c26-8a15-22580211bd7e",
      claim: "商机目前处于报价阶段",
      assertions: [{ field: "value_cents" as const, equals: 128000000 }],
    },
  ],
  missingInformation: ["交期依据"],
  nextStep: "请交付同事确认可承诺日期。",
  wakeCondition: "internal_response" as const,
};

describe("Workbench structured result channel", () => {
  it("documents task-local gaps and exact null/source evidence without weakening partial outcomes", () => {
    expect(WORKBENCH_RESULT_INSTRUCTION).toContain("只包含阻止完成当前用户任务");
    expect(WORKBENCH_RESULT_INSTRUCTION).toContain("JSON null 保持 null");
    expect(WORKBENCH_RESULT_INSTRUCTION).toContain("不用全零 UUID");
    expect(WORKBENCH_RESULT_INSTRUCTION).toContain("不能证明数据丢失");
    expect(
      workbenchResultSchema.safeParse({
        ...candidate,
        evidence: [
          {
            ...candidate.evidence[0],
            assertions: [{ field: "expected_close_date", equals: null }],
          },
        ],
      }).success,
    ).toBe(true);
  });
  it("accepts one bounded, schema-valid statement without executing CRM actions", async () => {
    const channel = createWorkbenchResultChannel();
    const submit = channel.tools[SUBMIT_WORKBENCH_RESULT_TOOL];
    expect(submit).toBeDefined();
    expect(await submit!.execute!(candidate, {} as never)).toEqual({ accepted: true });
    expect(channel.submitted()).toEqual(candidate);
    expect(resultDocument(channel.submitted()!)).toMatchObject({
      revision: 1,
      trust: "model_submitted",
      summary: candidate.summary,
    });
    expect(await submit!.execute!({ ...candidate, summary: "changed" }, {} as never)).toEqual({
      accepted: false,
      reason: "already_submitted",
    });
  });

  it("rejects unbounded, unreferenced, or unexpected fields", async () => {
    const channel = createWorkbenchResultChannel();
    const submit = channel.tools[SUBMIT_WORKBENCH_RESULT_TOOL]!;
    expect(workbenchResultSchema.safeParse({ ...candidate, secret: "never" }).success).toBe(false);
    expect(
      workbenchResultSchema.safeParse({
        ...candidate,
        evidence: [
          { ...candidate.evidence[0], assertions: [{ field: "phone", equals: "private" }] },
        ],
      }).success,
    ).toBe(false);
    expect(
      await submit.execute!(
        { ...candidate, evidence: [{ ...candidate.evidence[0], sourceId: "guess" }] },
        {} as never,
      ),
    ).toEqual({ accepted: false, reason: "invalid_schema" });
    expect(channel.submitted()).toBeNull();
  });

  it("requires a real staged approval and permits correction after a refused submission", async () => {
    let pending = false;
    const channel = createWorkbenchResultChannel({ hasPendingApproval: () => pending });
    const submit = channel.tools[SUBMIT_WORKBENCH_RESULT_TOOL]!;
    const waiting = { ...candidate, missingInformation: [], wakeCondition: "human_approval" as const };
    expect(await submit.execute!(waiting, {} as never)).toMatchObject({
      accepted: false, reason: "approval_proposal_missing",
    });
    expect(channel.submitted()).toBeNull();
    expect(workbenchResultPartialReason({ finalText: waiting.summary, submission: waiting,
      budgetExhausted: false, hasPendingApproval: false })).toBe("approval_proposal_missing");
    pending = true;
    expect(await submit.execute!(waiting, {} as never)).toEqual({ accepted: true });
    expect(workbenchResultPartialReason({ finalText: waiting.summary, submission: waiting,
      budgetExhausted: false, hasPendingApproval: true })).toBeNull();
  });

  it("fails closed without an approval source while allowing an honest blocked result", async () => {
    const channel = createWorkbenchResultChannel();
    const submit = channel.tools[SUBMIT_WORKBENCH_RESULT_TOOL]!;
    expect(await submit.execute!({ ...candidate, wakeCondition: "human_approval" }, {} as never))
      .toMatchObject({ accepted: false, reason: "approval_proposal_missing" });
    expect(await submit.execute!({ ...candidate, wakeCondition: "none" }, {} as never))
      .toEqual({ accepted: true });
  });

  it("keeps only the first result when parallel submissions await the same approval lookup", async () => {
    let release!: (value: boolean) => void;
    const pending = new Promise<boolean>((resolve) => { release = resolve; });
    const channel = createWorkbenchResultChannel({ hasPendingApproval: () => pending });
    const submit = channel.tools[SUBMIT_WORKBENCH_RESULT_TOOL]!;
    const waiting = { ...candidate, wakeCondition: "human_approval" as const };
    const first = submit.execute!(waiting, {} as never);
    const second = submit.execute!({ ...waiting, summary: "不能覆盖首份提交" }, {} as never);
    release(true);
    expect(await Promise.all([first, second])).toEqual([
      { accepted: true }, { accepted: false, reason: "already_submitted" },
    ]);
    expect(channel.submitted()?.summary).toBe(waiting.summary);
  });

  it("distinguishes a complete run from a missing structured result, evidence gap and budget stop", () => {
    expect(
      workbenchResultPartialReason({
        finalText: candidate.summary,
        submission: candidate,
        budgetExhausted: false,
      }),
    ).toBe("missing_material");
    expect(
      workbenchResultPartialReason({
        finalText: candidate.summary,
        submission: null,
        budgetExhausted: false,
      }),
    ).toBe("structured_result_missing");
    expect(
      workbenchResultPartialReason({
        finalText: candidate.summary,
        submission: { ...candidate, missingInformation: [] },
        budgetExhausted: true,
      }),
    ).toBe("budget_exhausted");
    expect(
      workbenchResultPartialReason({
        finalText: candidate.summary,
        submission: { ...candidate, missingInformation: [] },
        budgetExhausted: false,
      }),
    ).toBeNull();
  });

  it("replaces a prior provisional summary after a resumed model submission", () => {
    expect(
      workbenchFinalText({
        submission: candidate,
        priorText: "尚未更新商机，准备提出修改",
        fallbackText: "stale provider text",
        candidateBodies: [],
      }),
    ).toBe(candidate.summary);
  });
});

describe("Workbench pending presentation", () => {
  const premature = { ...candidate, summary: "已在决定后只读复核所选商机阶段。",
    evidence: [{ ...candidate.evidence[0]!, claim: "已在决定后只读复核所选商机阶段。" }],
    missingInformation: [], wakeCondition: "human_approval" as const };
  const waiting = { finalText: premature.summary, submission: premature,
    pending: true, collaborationBlocked: false, pendingSendMessage: false };

  it("publishes authoritative pending text and hides premature model evidence without mutating it", () => {
    const prior = JSON.stringify(premature);
    const visible = workbenchVisibleResult(waiting);
    expect(visible.resultDocument).toBeNull();
    expect(visible.finalText).toBe("当前待审操作提案尚未执行。请核对提案中的目标和参数后明确批准或拒绝。");
    expect(visible.finalText).not.toContain("决定后");
    expect(JSON.stringify(premature)).toBe(prior);
  });

  it("keeps the existing more specific unsent reply-draft message", () => {
    expect(workbenchVisibleResult({ ...waiting, pendingSendMessage: true })).toEqual({
      finalText: "Agent 回复草稿已保存在 CRM，尚未发送。批准后将进入正式发送队列。", resultDocument: null,
    });
  });

  it("gives collaboration blocking precedence over both approval and send display", () => {
    expect(workbenchVisibleResult({ ...waiting, collaborationBlocked: true, pendingSendMessage: true }))
      .toEqual({ finalText: "协作证据尚待复核，当前待审操作仍被业务层阻断。请先完成复核。", resultDocument: null });
  });

  it("does not publish a parent's success claim when a failed child still requires review and no proposal exists", () => {
    const incomplete = { ...premature, summary: "三位专家均已覆盖，客户子任务工具缺口已由父 Agent 补齐。" };
    const snapshot = JSON.stringify(incomplete);
    expect(workbenchVisibleResult({ ...waiting, pending: false, collaborationBlocked: true,
      finalText: incomplete.summary, submission: incomplete })).toEqual({
      finalText: "协作证据尚待复核，相关动作仍被业务层阻断。请先完成复核。", resultDocument: null,
    });
    expect(JSON.stringify(incomplete)).toBe(snapshot);
  });

  it("preserves the later completed model text and structured result when no proposal remains", () => {
    const completed = { ...candidate, summary: "已在决定后读取实际状态。", missingInformation: [], wakeCondition: "none" as const };
    expect(workbenchVisibleResult({ ...waiting, pending: false, finalText: completed.summary, submission: completed }))
      .toEqual({ finalText: completed.summary, resultDocument: resultDocument(completed) });
  });

  it("preserves existing nonpending partial and missing-submission presentation", () => {
    expect(workbenchVisibleResult({ ...waiting, pending: false, submission: candidate }))
      .toEqual({ finalText: waiting.finalText, resultDocument: resultDocument(candidate) });
    expect(workbenchVisibleResult({ ...waiting, pending: false, finalText: "", submission: null }))
      .toEqual({ finalText: null, resultDocument: null });
  });

  it("does not reuse any exact server pending placeholder as a post-decision fallback", () => {
    const placeholders = [waiting, { ...waiting, pendingSendMessage: true }, { ...waiting, collaborationBlocked: true }]
      .map((input) => workbenchVisibleResult(input).finalText!);
    for (const priorText of placeholders) {
      const finalText = workbenchFinalText({ submission: null, priorText, fallbackText: "", candidateBodies: [] });
      expect(finalText).toBe("");
      expect(workbenchResultPartialReason({ finalText, submission: null, budgetExhausted: false }))
        .toBe("empty_final_answer");
    }
  });

  it("preserves real new output and arbitrary prior text without natural-language filtering", () => {
    const placeholder = workbenchVisibleResult(waiting).finalText!;
    expect(workbenchFinalText({ submission: null, priorText: placeholder, fallbackText: "本次缺少结果材料。", candidateBodies: [] }))
      .toBe("本次缺少结果材料。");
    expect(workbenchFinalText({ submission: null, priorText: "说明：" + placeholder, fallbackText: "", candidateBodies: [] }))
      .toBe("说明：" + placeholder);
    expect(workbenchFinalText({ submission: null, priorText: null, fallbackText: placeholder, candidateBodies: [] }))
      .toBe(placeholder);
    expect(workbenchFinalText({ submission: { ...candidate, summary: "已取得实际结果。" }, priorText: placeholder,
      fallbackText: "", candidateBodies: [] })).toBe("已取得实际结果。");
  });
});
