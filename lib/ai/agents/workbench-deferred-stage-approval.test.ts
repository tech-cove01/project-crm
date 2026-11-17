import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  beginWorkbenchDeferredStageApproval, claimWorkbenchApprovedAction, finishWorkbenchApprovedAction,
} from "./workbench-approved-action";
import { LEAD_STAGE_TOOL } from "./workbench-ontology-contract";
import { executeDeferredWorkbenchStageApproval } from "./workbench-deferred-stage-approval";

const stageTool = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agent-engine/agent/agent-config", () => ({
  loadAgentVersionConfig: async () => ({ toolIds: ["crm_move_lead_stage"] }),
}));
vi.mock("@/lib/agent-engine/agent/request-deps", () => ({ requestTurnDeps: () => ({}) }));
vi.mock("@/lib/agent-engine/edge/crm/mcp-tools", () => ({
  buildMcpTurnTools: async () => ({ tools: { crm_move_lead_stage: { execute: stageTool } }, cleanup: async () => {} }),
}));
vi.mock("./workbench-scope", () => ({
  workbenchScopeInputFromRun: (scope: unknown) => scope,
  resolveWorkbenchScope: async (_admin: unknown, _org: unknown, scope: unknown) => scope,
}));

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

describe("Worker approval with one database connection", () => {
  it.each(["success", "revoked", "lock_timeout", "unknown"] as const)("settles %s without reborrowing the held connection", async (scenario) => {
    const leadId = "035318ca-60ce-4616-95d9-9f8998483a1c";
    const stageId = "77d2cb6e-881d-4c79-9e29-23dae582c97a";
    const args = { lead_id: leadId, to_stage_id: stageId };
    let status = "approved";
    let outcome = "queued";
    let authorizationChecks = 0;
    let transactionOwnsConnection = false;
    let committedClaim = false;
    let eventSequence = 0;
    const events: unknown[] = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql === "commit" && outcome === "executing") committedClaim = true;
      if (scenario === "lock_timeout" && sql.includes("pg_advisory_xact_lock")) throw new Error("lock_timeout");
      if (sql.includes("select tool_args")) return { rows: status === "approved" ? [{ tool_args: args, outcome }] : [] };
      if (sql.includes("select status from public.ai_workbench_runs")) return { rows: [{ status: "running" }] };
      if (sql.includes("as authorized")) {
        authorizationChecks += 1;
        return { rows: [{ authorized: scenario !== "revoked" || authorizationChecks === 1 }] };
      }
      if (sql.includes("select p.decision_by") || sql.includes("as outcome,decision_by"))
        return { rows: [{ outcome, decision_by: "approver" }] };
      if (sql.includes("select status,tool_name")) return { rows: [{ status, tool_name: LEAD_STAGE_TOOL, outcome }] };
      if (sql.includes("result_summary='{\"outcome\":\"executing\"}'")) outcome = "executing";
      if (sql.includes("set status=$4,")) status = String(params?.[3]);
      if (sql.includes("set status='failed',result_summary=$4")) {
        status = "failed";
        outcome = JSON.parse(String(params?.[3])).outcome;
      }
      if (sql.includes("returning sequence")) {
        events.push(params?.[2]);
        eventSequence += 1;
        return { rows: [{ sequence: eventSequence }] };
      }
      if (sql.includes("select messages")) return { rows: [{ messages: [] }] };
      return { rows: [] };
    });
    const noReborrow = () => {
      if (transactionOwnsConnection) throw new Error("single_connection_already_held");
    };
    const client = { query, release: () => { transactionOwnsConnection = false; } };
    const pool = {
      query: async (sql: string, params?: unknown[]) => {
        noReborrow();
        return query(sql, params);
      },
      connect: async () => {
        noReborrow();
        transactionOwnsConnection = true;
        return client;
      },
    } as unknown as Pool;
    stageTool.mockReset().mockImplementation(async () => {
      expect(committedClaim).toBe(true);
      if (scenario === "unknown") throw new Error("write_outcome_unconfirmed");
      return { lead: { id: leadId, stage_id: stageId } };
    });
    const input: Parameters<typeof executeDeferredWorkbenchStageApproval>[0] = {
      ...scope,
      pool,
      admin: {} as Parameters<typeof executeDeferredWorkbenchStageApproval>[0]["admin"],
      run: { agent_id: "agent", status: "running", mode: "act", runtime_state: { versionId: "version" },
        scope: { leadId, pipelineId: "pipeline" } },
      assertLease: async (queryable = pool) => { await queryable.query("lease"); },
      assertOwner: async (queryable) => { await queryable.query("owner"); },
    };
    await executeDeferredWorkbenchStageApproval(input);
    await executeDeferredWorkbenchStageApproval(input);
    expect(authorizationChecks).toBe(scenario === "lock_timeout" ? 1 : 2);
    expect(stageTool).toHaveBeenCalledTimes(scenario === "success" || scenario === "unknown" ? 1 : 0);
    expect(status).toBe(scenario === "success" ? "executed" : "failed");
    expect(events.filter((event) => event === "crm_state_changed")).toHaveLength(scenario === "success" ? 1 : 0);
    if (scenario === "unknown") expect(outcome).toBe("reconciliation_required");
    if (scenario === "lock_timeout") {
      expect(query).toHaveBeenCalledWith(expect.stringContaining("update public.ai_agent_run_states"), [
        scope.organizationId, scope.runId, expect.stringContaining("approval_execution_not_started"),
      ]);
    }
    expect(transactionOwnsConnection).toBe(false);
  });
});
