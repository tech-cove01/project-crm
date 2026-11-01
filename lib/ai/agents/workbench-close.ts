import type { Pool } from "pg";
import {
  workbenchResultPartialReason,
  workbenchVisibleResult,
  type WorkbenchResultSubmission,
} from "./workbench-result-submission";

/** Close against the same lead fence as review registration, never a model-turn snapshot. */
export async function closeWorkbenchRun(pool: Pool, input: {
  organizationId: string;
  runId: string;
  finalText: string;
  submission: WorkbenchResultSubmission | null;
  answerInvalidCode: string | null;
  budgetExhausted: boolean;
  runtimeState: Record<string, unknown>;
  beforeSideEffect?: (queryable?: Pick<Pool, "query">) => Promise<void>;
  continueAfterAutomaticWrites?: boolean;
  allowQueued?: boolean;
}) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local lock_timeout='5s'");
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended(public.fn_ai_collaboration_scope_key($1,$2),0))",
      [input.organizationId, input.runId],
    );
    // Waiting for the fence may outlive the worker lease.
    await input.beforeSideEffect?.(client);
    const { rows: runs } = await client.query<{ status: string }>(
      "select status from public.ai_workbench_runs where organization_id=$1 and id=$2 and run_kind='root' for update",
      [input.organizationId, input.runId],
    );
    if (!runs[0] || (runs[0].status !== "running" && !(input.allowQueued && runs[0].status === "queued"))) {
      await client.query("commit");
      return null;
    }
    let blockReason: "collaboration_review_required" | "collaboration_new_run_required" | null = null;
    await client.query("savepoint workbench_close_admission");
    try {
      await client.query("select public.fn_assert_ai_collaboration_write_allowed($1,$2)",
        [input.organizationId, input.runId]);
    } catch (error) {
      await client.query("rollback to savepoint workbench_close_admission");
      if (!(error instanceof Error) || !("code" in error) || error.code !== "P0001" ||
          !["collaboration_review_required", "collaboration_new_run_required"].includes(error.message))
        throw error;
      blockReason = error.message as NonNullable<typeof blockReason>;
    }
    await client.query("release savepoint workbench_close_admission");
    const { rows: proposals } = await client.query<{ id: string; tool_name: string }>(
      "select id,tool_name from public.ai_agent_action_proposals where organization_id=$1 and run_id=$2 and status='pending'",
      [input.organizationId, input.runId],
    );
    const pending = proposals.length > 0;
    if (!blockReason && !pending && input.continueAfterAutomaticWrites) {
      await client.query("commit");
      return { continued: true as const };
    }
    const partialReason = blockReason ?? workbenchResultPartialReason({
      finalText: input.finalText, submission: input.submission,
      answerInvalidCode: input.answerInvalidCode, budgetExhausted: input.budgetExhausted,
      hasPendingApproval: pending,
    });
    const status = blockReason ? "partial" : pending ? "awaiting_confirmation" : partialReason ? "partial" : "completed";
    const visible = blockReason === "collaboration_new_run_required" ? {
      finalText: "当前任务的提案已失效，请新建任务重新取证并生成提案。", resultDocument: null,
    } : workbenchVisibleResult({
      finalText: input.finalText, submission: input.submission, pending,
      collaborationBlocked: blockReason !== null,
      pendingSendMessage: proposals.some((proposal) => proposal.tool_name === "send_message"),
    });
    await input.beforeSideEffect?.(client);
    const { rows: updated } = await client.query<{ id: string }>(
      `update public.ai_workbench_runs set status=$3,final_text=$4,result_document=$5::jsonb,
       error_code=$6,runtime_state=$7::jsonb,
       completed_at=case when $3='awaiting_confirmation' then null else clock_timestamp() end
       where organization_id=$1 and id=$2 and (status='running' or ($8::boolean and status='queued')) returning id`,
      [input.organizationId, input.runId, status, visible.finalText,
        visible.resultDocument === null ? null : JSON.stringify(visible.resultDocument),
        status === "partial" ? partialReason : null,
        JSON.stringify(input.runtimeState), input.allowQueued ?? false],
    );
    await client.query("commit");
    return updated.length ? { continued: false as const, status, partialReason, pending } : null;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
