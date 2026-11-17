import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  beginWorkbenchDeferredStageApproval, claimWorkbenchApprovedAction, finishWorkbenchApprovedAction,
} from "./workbench-approved-action";
import { LEAD_STAGE_TOOL } from "./workbench-ontology-contract";

const scope = { organizationId: "org", runId: "run", proposalId: "proposal" };

function fakePool(getRows: (sql: string) => object[]) {
  const query = vi.fn(async (sql: string, _params?: unknown[]) => ({ rows: getRows(sql) }));
  const client = { query, release: vi.fn() };
  return { query, client, pool: { connect: async () => client } as unknown as Pool };
}

describe("deferred ontology stage approval", () => {
  it("saves the human decision and separate execution job before any tool start", async () => {
    const { query, pool } = fakePool((sql) => {
      if (sql.includes("select status,mission_id"))
        return [{ status: "awaiting_confirmation", mission_id: null }];
      if (sql.includes("select status,tool_name from"))
        return [{ status: "pending", tool_name: LEAD_STAGE_TOOL }];
      if (sql.includes("as authorized")) return [{ authorized: true }];
      if (sql.includes("returning sequence")) return [{ sequence: 1 }];
      return [];
    });
    await expect(claimWorkbenchApprovedAction(pool, {
      ...scope, actorUserId: "approver", toolName: LEAD_STAGE_TOOL, deferOntologyStage: true,
    })).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("values ($1,'workbench_resume',null"),
      [scope.organizationId, scope.runId, scope.proposalId],
    );
    expect(query.mock.calls.some(([, params]) => params?.includes("tool_started"))).toBe(false);
    const approval = query.mock.calls.find(([sql]) => sql.includes("set status='approved'"));
    expect(approval?.[1]?.at(-1)).toBe("queued");
    expect(query).toHaveBeenLastCalledWith("commit");
  });

  it("does not replay an execution that already crossed the tool-start boundary", async () => {
    const { client, query, pool } = fakePool((sql) => {
      if (sql.includes("select status from public.ai_workbench_runs")) return [{ status: "running" }];
      if (sql.includes("decision_by")) return [{ outcome: "executing", decision_by: "approver" }];
      return [];
    });
    const assertLease = vi.fn(async () => {});
    await expect(beginWorkbenchDeferredStageApproval(pool, { ...scope, assertLease })).resolves.toBe("uncertain");
    expect(assertLease).toHaveBeenCalledWith(client);
    expect(query.mock.calls.some(([sql]) => sql.includes("update public.ai_agent_action_proposals"))).toBe(false);
  });

  it("prevents a stale queued finalizer from settling a newer executing proposal", async () => {
    const { pool, query } = fakePool((sql) => {
      if (sql.includes("select status from public.ai_workbench_runs")) return [{ status: "running" }];
      if (sql.includes("select status,tool_name"))
        return [{ status: "approved", tool_name: LEAD_STAGE_TOOL, outcome: "executing" }];
      return [];
    });
    const assertOwner = vi.fn(async () => {});
    await expect(finishWorkbenchApprovedAction(pool, {
      ...scope, toolName: LEAD_STAGE_TOOL, expectedOutcome: "queued", assertOwner,
      result: { kind: "safe_failure", code: "scope_changed" },
    })).resolves.toBeNull();
    expect(assertOwner).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => sql.includes("update public.ai_agent_action_proposals"))).toBe(false);
  });

  it("verifies the lease on the same locked transaction before writing a receipt", async () => {
    const { pool, client, query } = fakePool((sql) => {
      if (sql.includes("select status from public.ai_workbench_runs")) return [{ status: "running" }];
      if (sql.includes("select status,tool_name"))
        return [{ status: "approved", tool_name: LEAD_STAGE_TOOL, outcome: "executing" }];
      return [];
    });
    const assertOwner = vi.fn(async () => { throw new Error("lease_lost"); });
    await expect(finishWorkbenchApprovedAction(pool, {
      ...scope, toolName: LEAD_STAGE_TOOL, expectedOutcome: "executing", assertOwner,
      result: { kind: "success", output: {} },
    })).rejects.toThrow("lease_lost");
    expect(assertOwner).toHaveBeenCalledWith(client);
    expect(query.mock.calls.some(([sql]) => sql.includes("update public.ai_agent_action_proposals"))).toBe(false);
    expect(query).toHaveBeenLastCalledWith("rollback");
  });
});
