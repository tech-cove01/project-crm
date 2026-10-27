import { afterEach, describe, expect, it, vi } from "vitest";
import { invokePiProvider } from "@/tests/agent-runtime/fixtures/pi-http";

import { resolvePiModel } from "./model-adapter";

describe("Pi model adapter", () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each([
    ["anthropic", "anthropic-messages", "https://api.anthropic.com"],
    ["openai", "openai-responses", "https://api.openai.com/v1"],
    ["google", "google-generative-ai", "https://generativelanguage.googleapis.com/v1beta"],
    ["openrouter", "openai-completions", "https://openrouter.ai/api/v1"],
    ["opencode", "openai-completions", "https://opencode.ai/zen/v1"],
    ["deepseek", "openai-completions", "https://api.deepseek.com"],
    ["dashscope", "openai-completions", "https://dashscope.aliyuncs.com/compatible-mode/v1"],
  ] as const)(
    "binds %s through Pi with its canonical API and endpoint",
    async (provider, api, baseUrl) => {
      const resolved = await resolvePiModel({
        provider,
        model: "crm-test-model",
        apiKey: "test-key",
      });

      expect(resolved.model).toMatchObject({
        id: "crm-test-model",
        provider,
        api,
        baseUrl,
      });
      expect(resolved.streamFn).toEqual(expect.any(Function));
    },
  );

  it("honors tenant-selected endpoint and request controls in the Pi binding", async () => {
    const resolved = await resolvePiModel({
      provider: "openrouter",
      model: "tenant/model",
      apiKey: "tenant-key",
      baseUrl: "https://gateway.example.test/v1",
      headers: { "X-Tenant": "org-a" },
      maxOutputTokens: 321,
      temperature: 0.2,
      topP: 0.8,
    });

    expect(resolved.model).toMatchObject({
      id: "tenant/model",
      baseUrl: "https://gateway.example.test/v1",
    });
    expect(resolved.streamFn).toEqual(expect.any(Function));
  });

  it("sends Qwen chat to DashScope with thinking disabled for tool continuity", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    await invokePiProvider({ provider: "dashscope", model: "qwen3.8-flash", apiKey: "test-key" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "qwen3.8-flash", enable_thinking: false });
  });

  it("uses DashScope endpoint even if the model ID exists in another provider catalog", async () => {
    const { openrouterProvider } = await import("@earendil-works/pi-ai/providers/openrouter");
    const catalogModel = openrouterProvider().getModels()[0];
    expect(catalogModel).toBeDefined();
    const result = await resolvePiModel({ provider: "dashscope", model: catalogModel!.id, apiKey: "test-key" });
    expect(result.model.baseUrl).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
    expect(result.model.provider).toBe("dashscope");
    expect(result.model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(result.model.maxTokens).toBe(8192);
    expect(result.model.contextWindow).toBe(128000);
  });

  it("rejects a DashScope endpoint override before provider dispatch", async () => {
    await expect(resolvePiModel({
      provider: "dashscope", model: "qwen3.8-flash", apiKey: "test-key",
      baseUrl: "https://untrusted.example/v1",
    })).rejects.toThrow("DashScope endpoint override is not supported");
  });

  it("rejects unsupported providers before any provider request", async () => {
    await expect(
      resolvePiModel({ provider: "unsupported", model: "m", apiKey: "k" }),
    ).rejects.toThrow("Pi provider not supported by the CRM adapter");
  });
});
