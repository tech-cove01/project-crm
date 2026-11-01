// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mock = vi.hoisted(() => ({ role: vi.fn(), support: vi.fn(async () => null), from: vi.fn(), reread: vi.fn(), persist: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: mock.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: mock.support }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: mock.from }) }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({}) }));
vi.mock("@/lib/audit", () => ({ audit: mock.audit }));
vi.mock("@/lib/ai/agents/workbench-collaboration-review", async original => ({ ...await original(),
  collaborationRereadPort: () => ({}), outcomeFromChildren: () => ({}),
  rereadCollaborationOutcome: mock.reread, persistCollaborationReview: mock.persist,
}));
import { POST } from "./route";
const id = "20000000-0000-4000-8000-000000000001";
const prior = { version: 1, revision: 2, status: "pending", planKey: "opportunity_review_v1", childRunIds: [], conflicts: [], observations: [], checkedAt: "2026-11-01T00:00:00Z", unavailable: 1 };
const invoke = (body: object) => POST(new NextRequest(`http://localhost/api/v1/ai/workbench/runs/${id}/collaboration-review`, { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
beforeEach(() => {
  vi.clearAllMocks();
  mock.role.mockResolvedValue({ ok: true, org: { orgId: "org" }, user: { id: "manager" } });
  mock.from.mockImplementation((table: string) => {
    const builder = { select: () => builder, eq: () => builder,
      maybeSingle: async () => ({ data: { id, agent_id: "agent", status: "partial", scope: {}, collaboration_review: prior }, error: null }),
      then: (done: (value: object) => unknown) => Promise.resolve(done({ data: [], error: null })) };
    return builder;
  });
});
describe("explicit collaboration reread API", () => {
  it("rejects approve/execute requests rather than creating an approval mechanism", async () => {
    const response = await invoke({ decision: "approve", revision: 2, reason: "Attempt" });
    expect(response.status).toBe(422); expect(mock.from).not.toHaveBeenCalled(); expect(mock.persist).not.toHaveBeenCalled();
  });
  it("does not read tenant data if manager authorization fails", async () => {
    mock.role.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
    expect((await invoke({ decision: "reread", revision: 2, reason: "Review" })).status).toBe(403);
    expect(mock.from).not.toHaveBeenCalled();
  });
  it("rejects an outdated review revision before any reread or persistence", async () => {
    expect((await invoke({ decision: "reread", revision: 1, reason: "Review" })).status).toBe(409);
    expect(mock.reread).not.toHaveBeenCalled();
  });
  it("keeps failure explicit and never returns an execution success", async () => {
    mock.reread.mockRejectedValue(new Error("PRIVATE_ERROR"));
    const response = await invoke({ decision: "reread", revision: 2, reason: "Review current sources" });
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("PRIVATE_ERROR");
    expect(mock.persist).not.toHaveBeenCalled();
  });
  it("records the manager CAS identity but returns actionExecuted=false after a valid reread", async () => {
    mock.reread.mockResolvedValue({ outcome: {}, resolved: true, unavailable: 0, observations: [] });
    mock.persist.mockResolvedValue({ ...prior, status: "resolved", revision: 3 });
    const response = await invoke({ decision: "reread", revision: 2, reason: "Review current sources" });
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ actionExecuted: false, oldProposalsCancelled: true });
    expect(mock.persist).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ organizationId: "org", runId: id, expectedRevision: 2, actorUserId: "manager" }));
  });
});
