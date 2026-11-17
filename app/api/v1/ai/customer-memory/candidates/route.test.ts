import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as CandidateModule from "@/lib/ai/customer-memory/candidates";
import type * as ExtractionModule from "@/lib/ai/customer-memory/extraction";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  support: vi.fn(),
  access: vi.fn(),
  source: vi.fn(),
  extract: vi.fn(),
  save: vi.fn(),
  decide: vi.fn(),
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.auth }));
vi.mock("@/lib/impersonate/support", () => ({
  requireSupportWrite: mocks.support,
  authenticatedSessionId: vi.fn().mockResolvedValue("authenticated-session"),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn().mockResolvedValue({}) }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: vi.fn().mockReturnValue({}) }));
vi.mock("@/lib/agent-engine/env", () => ({ loadEnv: vi.fn() }));
vi.mock("@/lib/agent-engine/edge/llm/run-model-call", () => ({
  llmEdgeConfigFromEnv: vi.fn(),
  runModelCall: vi.fn(),
  tool: (definition: unknown) => definition,
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/ai/customer-memory/candidates", async (importOriginal) => ({
  ...await importOriginal<typeof CandidateModule>(),
  assertCustomerMemoryCandidateAccess: mocks.access,
  loadCustomerMemorySource: mocks.source,
  saveCustomerMemoryCandidates: mocks.save,
  decideCustomerMemoryCandidate: mocks.decide,
}));
vi.mock("@/lib/ai/customer-memory/extraction", async (importOriginal) => ({
  ...await importOriginal<typeof ExtractionModule>(),
  extractCustomerMemoryCandidates: mocks.extract,
}));

import { CustomerMemoryCandidateError } from "@/lib/ai/customer-memory/candidates";
import { CustomerMemoryExtractionError } from "@/lib/ai/customer-memory/extraction";
import { PATCH, POST } from "./route";

const contactId = "691ce0e8-6e17-4a8a-afac-f29e5902b998";
const conversationId = "244fad91-5a31-4aa1-b1b0-e3d128e438cc";
const candidateId = "9af1b1bd-c80a-4e24-8323-6ab3e80f34ac";
const sourceMessage = { id: "2f502d70-29b4-4b1f-bc87-cd0ab3785337", body: "请在工作日上午联系我" };
const sourcePayload = { contact_id: contactId, conversation_id: conversationId };

function request(method: "POST" | "PATCH", body: object) {
  return new NextRequest("http://localhost/api/v1/ai/customer-memory/candidates", {
    method,
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("customer memory candidate API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.support.mockReset();
    mocks.auth.mockResolvedValue({ ok: true, org: { orgId: "authenticated-org" }, user: { id: "authenticated-user" } });
    mocks.access.mockResolvedValue(undefined);
    mocks.source.mockResolvedValue({ conversationId, messages: [sourceMessage] });
    mocks.extract.mockResolvedValue([]);
    mocks.save.mockResolvedValue({ conversation_id: conversationId, candidates: [] });
  });

  it("checks direct authorization before reading source or calling the model", async () => {
    mocks.access.mockRejectedValue(new CustomerMemoryCandidateError("forbidden", 403));
    const response = await POST(request("POST", sourcePayload));
    expect(response.status).toBe(403);
    expect(mocks.source).not.toHaveBeenCalled();
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("keeps a readonly support actor from either extraction or decision", async () => {
    mocks.support.mockImplementation(() => new Response(null, { status: 403 }));
    expect((await POST(request("POST", sourcePayload))).status).toBe(403);
    expect((await PATCH(request("PATCH", { contact_id: contactId, candidate_id: candidateId, decision: "confirm" }))).status)
      .toBe(403);
    expect(mocks.source).not.toHaveBeenCalled();
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(mocks.decide).not.toHaveBeenCalled();
  });

  it("rejects an explicitly inaccessible conversation without fallback, and distinguishes empty from provider failure", async () => {
    mocks.source.mockRejectedValueOnce(new CustomerMemoryCandidateError("source_not_found", 404));
    expect((await POST(request("POST", sourcePayload))).status).toBe(404);
    expect(mocks.extract).not.toHaveBeenCalled();

    mocks.source.mockResolvedValueOnce({ conversationId, messages: [] });
    const empty = await POST(request("POST", sourcePayload));
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ data: { conversation_id: conversationId, candidates: [] } });
    expect(mocks.extract).not.toHaveBeenCalled();

    mocks.extract.mockRejectedValueOnce(new CustomerMemoryExtractionError("model_unavailable"));
    const unavailable = await POST(request("POST", sourcePayload));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ error: { code: "model_unavailable" } });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("authorizes under the request organization and revalidates source before saving any candidate", async () => {
    mocks.save.mockRejectedValueOnce(new CustomerMemoryCandidateError("source_changed", 409));
    const response = await POST(request("POST", sourcePayload));
    expect(response.status).toBe(409);
    expect(mocks.source).toHaveBeenCalledWith(expect.anything(), {
      organizationId: "authenticated-org", contactId, conversationId,
    });
    expect(mocks.extract).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: "authenticated-org", messages: [sourceMessage],
    }));
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "authenticated-org", actorUserId: "authenticated-user", sessionId: "authenticated-session" }),
      { contactId, conversationId, messages: [sourceMessage], candidates: [] },
    );
  });
});
