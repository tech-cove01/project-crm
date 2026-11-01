import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { tool } from "ai";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { adaptAiTools, runPiAiSdkCall } from "@/lib/agent-runtime/pi/ai-sdk-compat";
import { PiAgentRuntime } from "@/lib/agent-runtime/pi/runtime";
import {
  createWorkbenchResultChannel,
  SUBMIT_WORKBENCH_RESULT_TOOL,
  workbenchResultPartialReason,
} from "@/lib/ai/agents/workbench-result-submission";

describe("Pi structured result adapter", () => {
  it.each([false, true])("reserves the bounded final submission and keeps a denied approval partial (denied=%s)", async (denied) => {
    const channel = createWorkbenchResultChannel({ hasPendingApproval: () => false });
    const read = vi.fn(async () => ({ lead: { status: "open" } }));
    const candidate = { summary: "已读取所选商机。", evidence: [], missingInformation: [],
      nextStep: "核对结果", wakeCondition: denied ? "human_approval" : "none" };
    const faux = fauxProvider({ provider: "crm-result-test", models: [{ id: "crm-result-model" }] });
    let finalToolNames: string[] = [];
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("crm_get_lead", {}), { stopReason: "toolUse" }),
      (context) => {
        finalToolNames = getCurrentTools(context.messages).map((item) => item.name);
        return fauxAssistantMessage(fauxToolCall(SUBMIT_WORKBENCH_RESULT_TOOL, candidate),
          { stopReason: "toolUse" });
      },
      fauxAssistantMessage("must not add another model turn"),
    ]);
    const runtime = new PiAgentRuntime(() => ({ model: faux.getModel() as never,
      streamFn: faux.provider.streamSimple.bind(faux.provider) as never }));
    const result = await runPiAiSdkCall({
      system: "只提交真实观察，不创建动作或审批。", messages: [{ role: "user", content: "核对商机" }],
      tools: { crm_get_lead: tool({ description: "Read", inputSchema: z.object({}), execute: read }),
        ...channel.tools },
      model: { provider: "crm-result-test", model: "crm-result-model", apiKey: "fake" },
      runtime, maxSteps: 2,
      finalTurn: { allowedToolNames: [SUBMIT_WORKBENCH_RESULT_TOOL], instruction: "仅提交已有结果。" },
      shouldStopAfterTurn: () => channel.submitted() !== null,
    });

    expect(read).toHaveBeenCalledOnce();
    expect(finalToolNames).toEqual([SUBMIT_WORKBENCH_RESULT_TOOL]);
    expect(result.turnCount).toBe(2);
    expect(channel.submitted()).toEqual(denied ? null : candidate);
    const reason = workbenchResultPartialReason({ finalText: channel.submitted()?.summary ?? result.text,
      submission: channel.submitted(), budgetExhausted: false, hasPendingApproval: false });
    expect(reason).toBe(denied ? "empty_final_answer" : null);
  });

  it("exposes the field assertion schema and stops after the accepted submission", async () => {
    const candidate = {
      summary: "商机状态已读取。",
      evidence: [{
        sourceType: "lead" as const,
        sourceId: "67b72c24-741b-4c26-8a15-22580211bd7e",
        claim: "商机状态为 open",
        assertions: [{ field: "status" as const, equals: "open" }],
      }],
      missingInformation: [],
      nextStep: "人工核对业务结果",
      wakeCondition: "none" as const,
    };
    const channel = createWorkbenchResultChannel();
    const adapted = adaptAiTools(channel.tools);
    expect(adapted.map((item) => item.name)).toEqual([SUBMIT_WORKBENCH_RESULT_TOOL]);
    expect(adapted[0]?.inputSchema).toMatchObject({
      type: "object",
      properties: { summary: expect.any(Object), evidence: expect.any(Object) },
    });
    const faux = fauxProvider({
      provider: "crm-result-test",
      models: [{ id: "crm-result-model" }],
    });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall(SUBMIT_WORKBENCH_RESULT_TOOL, candidate), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("unexpected second turn"),
    ]);
    const runtime = new PiAgentRuntime(() => ({
      model: faux.getModel() as never,
      streamFn: faux.provider.streamSimple.bind(faux.provider) as never,
    }));
    const result = await runPiAiSdkCall({
      system: "Submit a structured result.",
      messages: [{ role: "user", content: "Check this lead" }],
      tools: channel.tools,
      model: { provider: "crm-result-test", model: "crm-result-model", apiKey: "fake" },
      runtime,
      maxSteps: 3,
      shouldStopAfterTurn: () => channel.submitted() !== null,
    });
    expect(channel.submitted()).toEqual(candidate);
    expect(result.turnCount).toBe(1);
    expect(result.steps[0]?.toolCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolName: SUBMIT_WORKBENCH_RESULT_TOOL }),
    ]));
  });
});
