import { expect, it, vi } from "vitest";
import { runtimeThatFails } from "@/tests/agent-runtime/fixtures/test-runtime";
import { runModelCall } from "./run-model-call";

it("retains provider status without storing or logging echoed protected text", async () => {
  const query = vi.fn(async (sql: string, _parameters?: unknown[]) => {
    if (sql.includes("settings->'llm'")) {
      return { rows: [{ llm: { provider: "anthropic", default_model: "test-model" } }] };
    }
    return { rows: [] };
  });
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const source = "客户只希望在周三讨论柠檬色展台";
  const error = Object.assign(new Error("rate limit while processing " + source), { statusCode: 429 });

  await expect(runModelCall(
    { query } as never,
    { anthropicApiKey: "test-key", budgetEnforcement: "off" },
    {
      tenantId: "11111111-1111-4111-8111-111111111111",
      purpose: "customer_memory_extraction",
      messages: [{ role: "user", content: source }],
      sensitiveInput: true,
    },
    { runtime: runtimeThatFails(error), log },
  )).rejects.toBe(error);

  const failure = query.mock.calls.find(([sql]) => sql.includes("insert into llm_calls"))?.[1];
  expect(failure).toEqual(expect.arrayContaining([
    "limite_ou_saldo", "Falha do provedor com entrada protegida.", 429,
  ]));
  expect(log.error).toHaveBeenCalledWith("llm: chamada falhou", expect.objectContaining({
    error_code: "limite_ou_saldo", error_message: "Falha do provedor com entrada protegida.", http_status: 429,
  }));
  expect(JSON.stringify(failure)).not.toContain(source);
  expect(JSON.stringify(log.error.mock.calls)).not.toContain(source);
});
