// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { AgentCollaborationOutcome, AgentSpecialistResult } from "./collaboration";
import { claimValueHash } from "./evidence-claims";
import { detectCollaborationConflicts } from "./collaboration-runtime";
import {
  collaborationRereadPort,
  persistCollaborationReview,
  rereadCollaborationOutcome,
  withCollaborationActionFence,
} from "./workbench-collaboration-review";

function result(key: string, value: string, revision: string): AgentSpecialistResult {
  return {
    childRunId: key,
    specialistKey: key,
    status: "complete",
    summary: `Old observation ${key}`,
    claims: [
      {
        id: key,
        specialistKey: key,
        subject: { resource: "lead", id: "lead-one" },
        field: "stage_id",
        valueHash: claimValueHash(value),
        valueType: "string",
        locator: { provider: "crm_tool", sourceId: "lead:lead-one", revision },
      },
    ],
    evidence: [],
    missingMaterial: [],
    toolCalls: 1,
    usage: { inputTokens: 0, outputTokens: 0, costCents: null, modelTurns: 0 },
  };
}
function outcome(): AgentCollaborationOutcome {
  const results = [result("a", "stage-before", "1"), result("b", "stage-now", "2")];
  return {
    planKey: "opportunity_review_v1",
    status: "partial",
    results,
    conflicts: detectCollaborationConflicts(results),
    usage: { toolCalls: 2, inputTokens: 0, outputTokens: 0, costCents: null, modelTurns: 0 },
  };
}
describe("bounded collaboration review", () => {
  it("matches UUID scope by identity rather than input letter casing", async () => {
    const id = "a0000000-0000-4000-8000-000000000001";
    const query = vi.fn(async () => ({ rows: [{ data: { id } }] }));
    const port = collaborationRereadPort({ query } as unknown as Pool, "org", { leadId: id.toUpperCase() }, "agent");
    expect(await port.record("lead", id)).toEqual({ id });
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ values: ["org", id] }));
  });
  it("rereads each disputed object once, separates current facts from immutable children", async () => {
    const original = outcome(),
      snapshot = JSON.stringify(original);
    const record = vi.fn(async () => ({ id: "lead-one", stage_id: "stage-now", updated_at: "3" }));
    const rechecked = await rereadCollaborationOutcome(original, { record, wiki: vi.fn() });
    expect(record).toHaveBeenCalledExactlyOnceWith("lead", "lead-one");
    expect(rechecked.resolved).toBe(true);
    expect(rechecked.outcome.conflicts).toEqual([]);
    expect(rechecked.outcome.results).toBe(original.results);
    expect(rechecked.outcome.rereadContext).toContain("stage-now");
    expect(rechecked.observations).toEqual([
      {
        identity: "lead:lead-one",
        revision: "3",
        fieldHashes: { stage_id: claimValueHash("stage-now") },
      },
    ]);
    expect(JSON.stringify(original)).toBe(snapshot);
  });
  it.each([null, { id: "lead-one", updated_at: "3" }])(
    "keeps missing records/fields pending",
    async (row) => {
      const checked = await rereadCollaborationOutcome(outcome(), {
        record: vi.fn(async () => row),
        wiki: vi.fn(),
      });
      expect(checked.resolved).toBe(false);
      expect(checked.outcome.status).toBe("partial");
      expect(checked.outcome.conflicts.length).toBeGreaterThan(0);
    },
  );
  it("keeps a failed specialist visible even if a disputed scalar can be reread", async () => {
    const original = outcome();
    original.results.push({
      ...result("c", "stage-now", "2"),
      status: "failed",
      claims: [],
      missingMaterial: ["specialist_result"],
    });
    original.conflicts = detectCollaborationConflicts(original.results);
    const checked = await rereadCollaborationOutcome(original, {
      record: vi.fn(async () => ({ stage_id: "stage-now" })),
      wiki: vi.fn(),
    });
    expect(checked.resolved).toBe(false);
    expect(checked.outcome.results[2]?.missingMaterial).toEqual(["specialist_result"]);
    expect(checked.outcome.conflicts.some((c) => c.code === "specialist_failure")).toBe(true);
  });
  it("does not clear a withdrawn/unauthorized Wiki receipt or invent replacement prose", async () => {
    const original = outcome();
    original.results.forEach((r, index) => {
      r.claims = [];
      r.evidence = [
        {
          id: `page-v${index}`,
          namespace: "organization_wiki",
          kind: "wiki_page",
          title: "Synthetic",
          excerpt: "old publication",
          locator: { provider: "weknora", sourceId: "kb-source", revision: String(index) },
          metadata: { page_id: "page-one", knowledge_base_id: "kb" },
        },
      ];
    });
    original.conflicts = detectCollaborationConflicts(original.results);
    const wiki = vi.fn(async () => false);
    const checked = await rereadCollaborationOutcome(original, { record: vi.fn(), wiki });
    expect(wiki).toHaveBeenCalledTimes(2);
    expect(checked.resolved).toBe(false);
    expect(checked.outcome.conflicts).toEqual(original.conflicts);
  });
  it("a DB guard failure prevents the actual business callback", async () => {
    const query = vi.fn(async (text: string) => {
      if (text.includes("fn_assert_ai_collaboration")) throw new Error("DATABASE_CANARY");
      return { rows: [] };
    });
    const release = vi.fn(),
      action = vi.fn();
    const pool = { connect: async () => ({ query, release }) } as unknown as Pool;
    await expect(withCollaborationActionFence(pool, "org", "run", action)).rejects.toThrow(
      "collaboration_review_required",
    );
    expect(action).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith("rollback");
    expect(release).toHaveBeenCalledOnce();
  });
  it("rejects a stale manager review CAS before changing review/proposals", async () => {
    const prior = {
      version: 1,
      revision: 4,
      status: "pending",
      planKey: "opportunity_review_v1",
      childRunIds: ["a", "b"],
      conflicts: [],
      observations: [],
      unavailable: 0,
      checkedAt: "2026-11-01T00:00:00Z",
    };
    const query = vi.fn(async (text: string) => ({
      rows: text.startsWith("select mission_id")
        ? [{ mission_id: null }]
        : text.startsWith("select collaboration_review")
          ? [{ status: "partial", collaboration_review: prior }]
          : [],
    }));
    const pool = { connect: async () => ({ query, release: vi.fn() }) } as unknown as Pool;
    await expect(
      persistCollaborationReview(pool, {
        organizationId: "org",
        runId: "run",
        outcome: outcome(),
        expectedRevision: 3,
        actorUserId: "manager",
        reason: "Check current facts",
      }),
    ).rejects.toThrow("revision_changed");
    expect(query.mock.calls.some(([sql]) => sql.startsWith("update"))).toBe(false);
  });
  it("does not continue after pending review persistence fails", async () => {
    const query = vi.fn(async (text: string) => {
      if (text.startsWith("select mission_id")) return { rows: [{ mission_id: null }] };
      if (text.startsWith("select collaboration_review"))
        return { rows: [{ status: "running", collaboration_review: null }] };
      if (text.startsWith("update public.ai_workbench_runs")) throw new Error("write_failed");
      return { rows: [] };
    });
    const pool = { connect: async () => ({ query, release: vi.fn() }) } as unknown as Pool;
    await expect(
      persistCollaborationReview(pool, { organizationId: "org", runId: "run", outcome: outcome() }),
    ).rejects.toThrow("write_failed");
    expect(query).toHaveBeenCalledWith("rollback");
    expect(query.mock.calls.some(([sql]) => sql === "commit")).toBe(false);
  });
});
