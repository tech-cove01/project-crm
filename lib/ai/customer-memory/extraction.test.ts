import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agent-engine/edge/llm/run-model-call", () => ({
  runModelCall: vi.fn(),
  tool: (definition: unknown) => definition,
}));

import { runModelCall } from "@/lib/agent-engine/edge/llm/run-model-call";
import { extractCustomerMemoryCandidates } from "./extraction";

const gateway = vi.mocked(runModelCall);
const submitName = "submit_customer_memory_candidates";
const messageId = "d5fd8bb1-649f-46da-a591-452abb8951e1";
const otherId = "658d7101-c911-4d28-b74f-8ef996512fe1";
const exactQuote = "请在工作日上午用邮件联系我";
const draft = { category: "preference", body: exactQuote, message_id: messageId, quote: exactQuote };
const input = () => ({
  pool: {} as never,
  llmCfg: {} as never,
  organizationId: "org",
  messages: [
    { id: messageId, body: `谢谢。${exactQuote}。` },
    { id: otherId, body: "合同可以外发吗？" },
  ],
  signal: new AbortController().signal,
});

function simulateSubmissions(...submissions: unknown[]) {
  gateway.mockImplementation(async (_pool, _cfg, call) => {
    const submissionTool = call.tools?.[submitName] as unknown as { execute: (value: unknown) => Promise<unknown> };
    for (const submission of submissions) await submissionTool.execute(submission);
    return {
      result: {
        events: [],
        steps: [{ toolCalls: submissions.map(() => ({ toolName: submitName })) }],
      },
    } as never;
  });
}

describe("customer memory extraction", () => {
  beforeEach(() => {
    gateway.mockReset();
  });

  it("uses a single read-only in-memory submission and only sends source messages to the organization Gateway", async () => {
    simulateSubmissions({ candidates: [draft] });
    const selected = input();
    await expect(extractCustomerMemoryCandidates(selected)).resolves.toEqual([draft]);

    const call = gateway.mock.calls[0]?.[2];
    expect(gateway).toHaveBeenCalledTimes(1);
    expect(call).toMatchObject({
      tenantId: selected.organizationId,
      purpose: "customer_memory_extraction",
      sensitiveInput: true,
      runtimeMode: "shadow",
      maxSteps: 1,
      maxOutputTokens: 2_000,
      abortSignal: selected.signal,
    });
    expect(call?.workbenchRunId).toBeUndefined();
    expect(call?.messages).toEqual([{
      role: "user",
      content: JSON.stringify({ messages: selected.messages.map(({ id, body }) => ({ message_id: id, body })) }),
    }]);
    expect(Object.keys(call?.tools ?? {})).toEqual([submitName]);
  });

  it.each([
    ["wrong message", { ...draft, message_id: otherId }],
    ["changed quote", { ...draft, quote: `${exactQuote}！` }],
  ])("rejects an unsupported source even alongside a valid candidate (%s)", async (_label, invalid) => {
    simulateSubmissions({ candidates: [draft, invalid] });
    await expect(extractCustomerMemoryCandidates(input())).rejects.toMatchObject({ code: "model_output_invalid" });
  });

  it("distinguishes an empty authorized source, a valid empty submission, and an omitted submission", async () => {
    await expect(extractCustomerMemoryCandidates({ ...input(), messages: [] })).resolves.toEqual([]);
    expect(gateway).not.toHaveBeenCalled();
    simulateSubmissions({ candidates: [] });
    await expect(extractCustomerMemoryCandidates(input())).resolves.toEqual([]);
    simulateSubmissions();
    await expect(extractCustomerMemoryCandidates(input())).rejects.toMatchObject({ code: "model_output_invalid" });
  });

  it("rejects multiple submissions within the same model turn", async () => {
    simulateSubmissions({ candidates: [draft] }, { candidates: [] });
    await expect(extractCustomerMemoryCandidates(input())).rejects.toMatchObject({ code: "model_output_invalid" });
  });

  it("returns a stable provider error without forwarding the original message", async () => {
    gateway.mockRejectedValue(new Error(`provider echoed: ${exactQuote}`));
    await expect(extractCustomerMemoryCandidates(input())).rejects.toMatchObject({
      code: "model_unavailable",
      message: "model_unavailable",
    });
  });

  it("distinguishes a Pi provider-error turn from a missing model submission", async () => {
    gateway.mockResolvedValue({
      result: { events: [{ type: "turn_end", data: { stop_reason: "error" } }], steps: [] },
    } as never);
    await expect(extractCustomerMemoryCandidates(input())).rejects.toMatchObject({ code: "model_unavailable" });
  });
});
