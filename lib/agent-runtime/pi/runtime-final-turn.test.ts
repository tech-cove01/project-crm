import { describe, expect, it, vi } from "vitest";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

import type { RuntimeTool } from "../types";
import { PiAgentRuntime } from "./runtime";

const model = { provider: "crm-test-provider", model: "crm-test-model", apiKey: "test-key" };

function runtimeWithFaux(responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]) {
  const faux = fauxProvider({ provider: model.provider, models: [{ id: model.model }] });
  faux.setResponses(responses);
  return new PiAgentRuntime(() => ({
    model: faux.getModel() as never,
    streamFn: faux.provider.streamSimple.bind(faux.provider) as never,
  }));
}

function runtimeTool(name: string, execute: RuntimeTool["execute"]): RuntimeTool {
  return { name, description: name, inputSchema: { type: "object", properties: {} },
    capability: "read", execute };
}

describe("bounded final turn", () => {
  it("keeps observations and reserves the third existing turn for a tool-free summary", async () => {
    const read = vi.fn(async () => ({ content: "确认事实：仅站内演示" }));
    const runtime = runtimeWithFaux([
      fauxAssistantMessage(fauxToolCall("read", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("read", {}), { stopReason: "toolUse" }),
      (context) => {
        expect(getCurrentTools(context.messages)).toEqual([]);
        expect(JSON.stringify(context.messages)).toContain("确认事实：仅站内演示");
        expect(JSON.stringify(context.messages)).toContain("只输出已有事实摘要");
        return fauxAssistantMessage("仅站内演示；预算未确认。");
      },
      fauxAssistantMessage("must not request a fourth turn"),
    ]);
    const result = await runtime.run({ systemPrompt: "CRM", prompt: "复盘", model,
      tools: [runtimeTool("read", read)], maxTurns: 3,
      finalTurn: { allowedToolNames: [], instruction: "只输出已有事实摘要" } });

    expect(read).toHaveBeenCalledTimes(2);
    expect(result.finalText).toBe("仅站内演示；预算未确认。");
    expect(result.events.filter((event) => event.type === "turn_end")).toHaveLength(3);
    expect(result.messages.filter((message) => message.role === "tool")).toHaveLength(2);
  });

  it("only exposes the allowed existing submission tool and refuses hallucinated removed tools", async () => {
    const write = vi.fn(async () => ({ content: "must not write" }));
    const submit = vi.fn(async () => ({ content: "submitted" }));
    const runtime = runtimeWithFaux([
      fauxAssistantMessage(fauxToolCall("read", {}), { stopReason: "toolUse" }),
      (context) => {
        expect(getCurrentTools(context.messages).map((tool) => tool.name)).toEqual(["submit"]);
        return fauxAssistantMessage([fauxToolCall("write", {}), fauxToolCall("submit", {})],
          { stopReason: "toolUse" });
      },
    ]);
    const result = await runtime.run({ systemPrompt: "CRM", prompt: "复盘", model,
      tools: [runtimeTool("read", async () => ({ content: "fact" })),
        runtimeTool("write", write), runtimeTool("submit", submit)], maxTurns: 2,
      finalTurn: { allowedToolNames: ["submit", "not_exposed"], instruction: "仅提交已观察结果" } });

    expect(write).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledOnce();
    expect(result.messages.some((message) => message.role === "tool" &&
      message.toolName === "write" && message.isError)).toBe(true);
    expect(result.events.filter((event) => event.type === "turn_end")).toHaveLength(2);
  });

  it("keeps the CRM permission hook active for a tool present in the final allowlist", async () => {
    const write = vi.fn(async () => ({ content: "must not write" }));
    const gate = vi.fn(async () => ({ block: true, terminate: true, reason: "permission_denied" }));
    const runtime = runtimeWithFaux([
      fauxAssistantMessage(fauxToolCall("write", {}), { stopReason: "toolUse" }),
    ]);
    await runtime.run({ systemPrompt: "CRM", prompt: "act", model,
      tools: [runtimeTool("write", write)], maxTurns: 1, beforeToolCall: gate,
      finalTurn: { allowedToolNames: ["write"], instruction: "仅允许已授权工具" } });

    expect(gate).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
  });

  it("honors an earlier budget stop without spending the reserved turn", async () => {
    const runtime = runtimeWithFaux([
      fauxAssistantMessage(fauxToolCall("read", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("must not request another turn"),
    ]);
    const result = await runtime.run({ systemPrompt: "CRM", prompt: "复盘", model,
      tools: [runtimeTool("read", async () => ({ content: "fact" }))], maxTurns: 3,
      finalTurn: { allowedToolNames: [], instruction: "摘要" }, shouldStopAfterTurn: () => true });

    expect(result.events.filter((event) => event.type === "turn_end")).toHaveLength(1);
    expect(result.finalText).toBe("");
  });

  it("applies the same restriction when only one turn remains", async () => {
    const read = vi.fn(async () => ({ content: "must not read" }));
    const runtime = runtimeWithFaux([(context) => {
      expect(getCurrentTools(context.messages)).toEqual([]);
      expect(JSON.stringify(context.messages)).toContain("如实报告现有缺口");
      return fauxAssistantMessage("没有本次工具观察。");
    }]);
    const result = await runtime.run({ systemPrompt: "CRM", prompt: "复盘", model,
      tools: [runtimeTool("read", read)], maxTurns: 1,
      finalTurn: { allowedToolNames: [], instruction: "如实报告现有缺口" } });

    expect(read).not.toHaveBeenCalled();
    expect(result.finalText).toBe("没有本次工具观察。");
    expect(result.events.filter((event) => event.type === "turn_end")).toHaveLength(1);
  });
});
