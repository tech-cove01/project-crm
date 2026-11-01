import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { closeWorkbenchRun } from "./workbench-close";
import { assertWorkbenchJobLease } from "./workbench-job-lease";

function fixture(options: {
  blocked?: string; failure?: Error; status?: string;
  pending?: string[]; updated?: boolean;
} = {}) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("j.locked_by=$3")) return { rows: [{ current: true }] };
    if (sql.startsWith("select status from")) return { rows: [{ status: options.status ?? "running" }] };
    if (sql.includes("fn_assert_ai_collaboration_write_allowed")) {
      if (options.failure) throw options.failure;
      if (options.blocked) throw Object.assign(new Error(options.blocked), { code: "P0001" });
    }
    if (sql.startsWith("select id,tool_name"))
      return { rows: (options.pending ?? []).map((tool_name) => ({ id: "proposal", tool_name })) };
    if (sql.startsWith("update public.ai_workbench_runs"))
      return { rows: options.updated === false ? [] : [{ id: "run" }] };
    return { rows: [] };
  });
  const release = vi.fn();
  const pool = { connect: vi.fn(async () => ({ query, release })) } as unknown as Pool;
  const input = { organizationId: "org", runId: "run", finalText: "已核对商机。",
    submission: { summary: "已核对商机。", evidence: [], missingInformation: [], nextStep: "完成", wakeCondition: "none" as const },
    answerInvalidCode: null, budgetExhausted: false, runtimeState: { versionId: "version" },
    beforeSideEffect: vi.fn(async () => undefined),
  };
  return { query, release, pool, input };
}

describe("workbench close fence", () => {
  it.each(["collaboration_review_required", "collaboration_new_run_required"])(
    "stops an old task after %s and suppresses its assessment", async (blocked) => {
      const f = fixture({ blocked });
      expect(await closeWorkbenchRun(f.pool, f.input)).toMatchObject({
        status: "partial", pending: false, partialReason: blocked,
      });
      const update = f.query.mock.calls.find(([sql]) => sql.startsWith("update public.ai_workbench_runs"));
      expect(update).toBeDefined();
      expect(f.query).toHaveBeenCalledWith(expect.stringContaining("status=$3"), [
        "org", "run", "partial", blocked === "collaboration_new_run_required"
          ? "当前任务的提案已失效，请新建任务重新取证并生成提案。" : expect.stringContaining("协作证据尚待复核"), null,
        blocked, JSON.stringify(f.input.runtimeState), false,
      ]);
      const sql = f.query.mock.calls.map(([text]) => text);
      expect(sql.indexOf("rollback to savepoint workbench_close_admission"))
        .toBeLessThan(sql.findIndex((text) => text.startsWith("select id,tool_name")));
      expect(sql.at(-1)).toBe("commit");
      expect(f.release).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { pending: [], status: "completed" },
    { pending: ["crm_move_lead_stage"], status: "awaiting_confirmation" },
    { pending: ["send_message"], status: "awaiting_confirmation" },
  ])("keeps the current normal $status result", async ({ pending, status }) => {
    const f = fixture({ pending });
    expect(await closeWorkbenchRun(f.pool, f.input)).toMatchObject({ status, pending: !!pending.length });
    expect(f.query).toHaveBeenCalledWith(expect.stringContaining("returning id"), expect.arrayContaining([status]));
    if (!pending.length)
      expect(f.query).toHaveBeenCalledWith(expect.stringContaining("returning id"), expect.arrayContaining([
        JSON.stringify({ revision: 1, trust: "model_submitted", ...f.input.submission }),
      ]));
  });

  it("checks a lease again after acquiring the fence and before the update", async () => {
    const f = fixture();
    f.input.beforeSideEffect.mockImplementation(async () => {
      expect(f.query.mock.calls.some(([sql]) => sql.includes("pg_advisory_xact_lock"))).toBe(true);
    });
    await closeWorkbenchRun(f.pool, f.input);
    expect(f.input.beforeSideEffect).toHaveBeenCalledTimes(2);
    const expired = fixture();
    expired.input.beforeSideEffect.mockRejectedValue(new Error("lease_lost"));
    await expect(closeWorkbenchRun(expired.pool, expired.input)).rejects.toThrow("lease_lost");
    expect(expired.query.mock.calls.some(([sql]) => sql.startsWith("update public.ai_workbench_runs"))).toBe(false);
    expect(expired.query).toHaveBeenLastCalledWith("rollback");
  });

  it("checks the real lease through the checked-out client without borrowing another pool connection", async () => {
    const f = fixture();
    const pool = Object.assign(f.pool, { query: vi.fn(() => { throw new Error("pool_connection_already_checked_out"); }) });
    const job = { id: "job", organization_id: "org", locked_by: "worker",
      claim_acquired_at: "2026-11-01T00:00:00Z" } as never;
    const beforeSideEffect = (queryable: Pick<Pool, "query"> = pool) =>
      assertWorkbenchJobLease(queryable, job, "worker");
    expect(await closeWorkbenchRun(pool, { ...f.input, beforeSideEffect })).toMatchObject({ status: "completed" });
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.connect).toHaveBeenCalledOnce();
    expect(f.query.mock.calls.filter(([sql]) => sql.includes("j.locked_by=$3"))).toHaveLength(2);
  });

  it.each([
    new Error("database offline"),
    Object.assign(new Error("unrelated failure"), { code: "P0001" }),
  ])("rolls back unknown admission failures instead of fabricating a completed result", async (failure) => {
    const f = fixture({ failure });
    await expect(closeWorkbenchRun(f.pool, f.input)).rejects.toThrow(failure.message);
    expect(f.query.mock.calls.some(([sql]) => sql.startsWith("update public.ai_workbench_runs"))).toBe(false);
    expect(f.query).toHaveBeenLastCalledWith("rollback");
  });

  it.each([{ status: "cancelled" }, { updated: false }])("returns no result when cancellation wins ($status)", async (options) => {
    const f = fixture(options);
    expect(await closeWorkbenchRun(f.pool, f.input)).toBeNull();
  });

  it("preserves the distinct start and resume queued-state guards", async () => {
    const resume = fixture({ status: "queued" });
    expect(await closeWorkbenchRun(resume.pool, resume.input)).toBeNull();
    const start = fixture({ status: "queued" });
    expect(await closeWorkbenchRun(start.pool, { ...start.input, allowQueued: true }))
      .toMatchObject({ status: "completed" });
  });

  it("releases the transaction before asking the caller to continue an automatic write", async () => {
    const f = fixture();
    expect(await closeWorkbenchRun(f.pool, { ...f.input, continueAfterAutomaticWrites: true }))
      .toEqual({ continued: true });
    expect(f.query.mock.calls.some(([sql]) => sql.startsWith("update public.ai_workbench_runs"))).toBe(false);
    expect(f.query).toHaveBeenLastCalledWith("commit");
    expect(f.release).toHaveBeenCalledOnce();
  });
});
