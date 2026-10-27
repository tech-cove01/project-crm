import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ bindings: [] as Record<string, unknown>[], credentials: [] as Record<string, unknown>[] }));
vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn() } }));
vi.mock("@/lib/crypto/aes_gcm", () => ({ byteaToBuffer: () => Buffer.from("synthetic"), decryptKey: () => "synthetic-key" }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const filters: Array<[string, unknown]> = [];
      const rows = () => (table === "ai_purpose_bindings" ? fixture.bindings : fixture.credentials)
        .filter(row => filters.every(([key, val]) => row[key] === val));
      const b = {
        select: () => b,
        eq: (key: string, val: unknown) => { filters.push([key, val]); return b; },
        not: () => b,
        maybeSingle: async () => ({ data: rows()[0] ?? null }),
        order: async () => ({ data: rows() }),
      };
      return b;
    },
  }),
}));
import { resolverChaveDeEmbedding } from "./chave";

const cred = (provider: string) => ({ id: "cred-1", organization_id: "org-1", provider, is_active: true, label: "synthetic", api_key_encrypted: "x", api_key_iv: "x", api_key_tag: "x" });
beforeEach(() => { fixture.bindings = []; fixture.credentials = []; vi.stubEnv("CRM_EMBEDDING_PROVIDER", ""); });
afterEach(() => vi.unstubAllEnvs());

describe("embedding provider isolation", () => {
  it("keeps OpenAI as the default for valid existing organizations", async () => {
    fixture.credentials = [cred("openai")];
    const result = await resolverChaveDeEmbedding("org-1");
    expect(result?.origem).toBe("credencial_da_organizacao");
    expect(result?.baseUrl).toBeNull();
  });
  it("never treats a DashScope credential as an OpenAI binding", async () => {
    fixture.credentials = [cred("dashscope")];
    fixture.bindings = [{ organization_id: "org-1", purpose: "embedding_indexar", is_enabled: true, provider: "openai", credential_id: "cred-1", model_id: "text-embedding-3-small", base_url: null }];
    expect(await resolverChaveDeEmbedding("org-1")).toBeNull();
  });
  it("requires an explicit installation switch and same-tenant DashScope credential", async () => {
    vi.stubEnv("CRM_EMBEDDING_PROVIDER", "dashscope");
    fixture.credentials = [cred("dashscope")];
    const result = await resolverChaveDeEmbedding("org-1");
    expect(result?.model).toBe("dashscope/text-embedding-v4");
    expect(result?.baseUrl).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
    expect(await resolverChaveDeEmbedding("another-org")).toBeNull();
  });
});
