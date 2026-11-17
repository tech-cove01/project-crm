import type { Pool, PoolClient } from "pg";
import { appendWorkbenchObservation, parseRuntimeMessages } from "@/lib/ai/agents/workbench-state";
import { appendWorkbenchEventTx } from "@/lib/ai/agents/workbench-transaction-events";
import { LEAD_STAGE_TOOL, WORKBENCH_ONTOLOGY_TOOL } from "./workbench-ontology-contract";

type ActionOutcome = "queued" | "awaiting_confirmation" | "partial" | "cancelled";
type ActionResult =
  | { kind: "success"; output: unknown; compensationArgs?: Record<string, unknown>;
      preview?: { resourceUuid: string; changedFields: string[] } }
  | { kind: "safe_failure"; code: string };

type ApprovalCoordinates = { organizationId: string; runId: string; proposalId: string };
type ExecutionState = "queued" | "executing";
type ApprovalSettlement = {
  expectedOutcome?: ExecutionState;
  assertOwner?: (queryable: Pick<Pool, "query">) => Promise<void>;
};

async function transaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local lock_timeout = '5s'");
    const result = await run(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function hasOntologyStageAuthorization(
  client: PoolClient,
  input: ApprovalCoordinates & { actorUserId: string },
): Promise<boolean> {
  const { rows } = await client.query<{ authorized: boolean }>(
    `select exists (
       select 1
         from public.ai_workbench_runs run
         join public.ai_agent_action_proposals proposal
           on proposal.organization_id=run.organization_id and proposal.run_id=run.id
          and proposal.id=$3 and proposal.tool_name=$5
         join public.crm_leads lead on lead.organization_id=run.organization_id
          and lead.id::text=lower(run.scope->>'leadId')
          and lead.id::text=lower(proposal.tool_args->>'lead_id')
          and (run.scope->>'contactId' is null or lead.contact_id::text=lower(run.scope->>'contactId'))
          and (run.scope->>'pipelineId' is null or lead.pipeline_id::text=lower(run.scope->>'pipelineId'))
         join public.crm_pipelines pipeline on pipeline.organization_id=lead.organization_id
          and pipeline.id=lead.pipeline_id and pipeline.is_archived is false
         join public.user_organizations actor on actor.organization_id=run.organization_id
          and actor.user_id=run.actor_user_id and actor.role in ('manager','admin')
          and actor.accepted_at is not null and actor.revoked_at is null
         join public.user_organizations approver on approver.organization_id=run.organization_id
          and approver.user_id=$4 and approver.role in ('manager','admin')
          and approver.accepted_at is not null and approver.revoked_at is null
         join public.ai_agent_run_events proposed on proposed.organization_id=run.organization_id
          and proposed.run_id=run.id and proposed.event_type='tool_proposed'
          and proposed.payload->>'proposalId'=proposal.id::text
         join public.ai_agent_run_events observed on observed.organization_id=run.organization_id
          and observed.run_id=run.id and observed.event_type='tool_completed'
          and observed.sequence<proposed.sequence and observed.payload->>'tool'=$6
          and observed.payload->>'toolCallId'=proposal.preview#>>'{ontologyBasis,toolCallId}'
          and observed.payload#>>'{ontology,status}'='matched'
          and observed.payload#>>'{ontology,scope,leadId}'=lead.id::text
          and (observed.payload#>'{ontology,activities}') @>
            jsonb_build_array(jsonb_build_object('id',proposal.preview#>>'{ontologyBasis,activityId}'))
        where run.organization_id=$1 and run.id=$2 and run.mode='act' and run.run_kind='root'
     ) as authorized`,
    [input.organizationId, input.runId, input.proposalId, input.actorUserId, LEAD_STAGE_TOOL, WORKBENCH_ONTOLOGY_TOOL],
  );
  return rows[0]?.authorized === true;
}

/** Claim exactly one reviewed action before entering its CRM tool adapter. */
export async function claimWorkbenchApprovedAction(pool: Pool, input: ApprovalCoordinates & {
  toolName: string; actorUserId: string; reason?: string; deferOntologyStage?: boolean;
}): Promise<boolean> {
  return transaction(pool, async (client) => {
    await client.query("select public.fn_assert_ai_collaboration_write_allowed($1,$2)", [input.organizationId, input.runId]);
    const { rows: runs } = await client.query<{ status: string; mission_id: string | null }>(
      `select status,mission_id from public.ai_workbench_runs
       where organization_id=$1 and id=$2 and run_kind='root' for update`,
      [input.organizationId, input.runId],
    );
    const run = runs[0];
    if (!run || run.status !== "awaiting_confirmation") return false;
    if (run.mission_id) {
      const { rows: missions } = await client.query<{ status: string }>(
        `select status from public.ai_missions
         where organization_id=$1 and id=$2 for share`,
        [input.organizationId, run.mission_id],
      );
      if (!missions[0] || ["cancelled", "completed"].includes(missions[0].status)) return false;
    }
    const { rows: proposals } = await client.query<{ status: string; tool_name: string }>(
      `select status,tool_name from public.ai_agent_action_proposals
       where organization_id=$1 and run_id=$2 and id=$3 for update`,
      [input.organizationId, input.runId, input.proposalId],
    );
    if (proposals[0]?.status !== "pending" ||
        proposals[0].tool_name !== input.toolName || input.toolName === "send_message")
      return false;
    if (input.deferOntologyStage &&
        (input.toolName !== LEAD_STAGE_TOOL || !await hasOntologyStageAuthorization(client, input)))
      return false;
    await client.query(
      `update public.ai_workbench_runs set status='running'
       where organization_id=$1 and id=$2 and status='awaiting_confirmation'`,
      [input.organizationId, input.runId],
    );
    await client.query(
      `update public.ai_agent_action_proposals
       set status='approved',decision_by=$4,decision_reason=$5,decision_at=now(),
           result_summary=jsonb_build_object('outcome',$6::text)
       where organization_id=$1 and run_id=$2 and id=$3 and status='pending'`,
      [input.organizationId, input.runId, input.proposalId,
        input.actorUserId, input.reason ?? null, input.deferOntologyStage ? "queued" : "executing"],
    );
    await appendWorkbenchEventTx(client, input.organizationId, input.runId,
      "human_confirmation_received", {
        proposalId: input.proposalId, decision: "approve", actorUserId: input.actorUserId,
      });
    await appendWorkbenchEventTx(client, input.organizationId, input.runId,
      "policy_checked", { proposalId: input.proposalId,
        decision: "approved", tool: input.toolName });
    if (input.deferOntologyStage) {
      // The normal continuation reserves source_event_id=proposalId.
      // The locked pending → approved transition admits this job only once.
      await client.query(
        `insert into public.job_queue
         (organization_id,kind,source_event_id,payload,max_attempts)
         values ($1,'workbench_resume',null,jsonb_build_object('runId',$2::uuid,'approvedProposalId',$3::uuid),3)`,
        [input.organizationId, input.runId, input.proposalId],
      );
    } else {
      await appendWorkbenchEventTx(client, input.organizationId, input.runId,
        "tool_started", { proposalId: input.proposalId, tool: input.toolName });
    }
    return true;
  });
}

/** The lease holder transitions only once from queued to executing. */
export async function beginWorkbenchDeferredStageApproval(pool: Pool, input: ApprovalCoordinates & {
  assertLease: (queryable: Pick<Pool, "query">) => Promise<void>;
}): Promise<"claimed" | "blocked" | "uncertain" | "settled"> {
  return transaction(pool, async (client) => {
    const { rows: [run] } = await client.query<{ status: string }>(
      `select status from public.ai_workbench_runs
       where organization_id=$1 and id=$2 and run_kind='root' for update`,
      [input.organizationId, input.runId],
    );
    if (!run) return "settled";
    const { rows: [proposal] } = await client.query<{ outcome: string | null; decision_by: string | null }>(
      `select result_summary->>'outcome' as outcome,decision_by
       from public.ai_agent_action_proposals
       where organization_id=$1 and run_id=$2 and id=$3 and tool_name=$4 and status='approved' for update`,
      [input.organizationId, input.runId, input.proposalId, LEAD_STAGE_TOOL],
    );
    if (proposal?.outcome === "executing") {
      if (run.status !== "cancelled") await input.assertLease(client);
      return "uncertain";
    }
    if (proposal?.outcome !== "queued" || !["running", "cancelled"].includes(run.status)) return "settled";
    if (run.status === "cancelled") return "blocked";
    await input.assertLease(client);
    if (!proposal.decision_by ||
        !await hasOntologyStageAuthorization(client, { ...input, actorUserId: proposal.decision_by }))
      return "blocked";
    await client.query(
      `update public.ai_agent_action_proposals set result_summary='{"outcome":"executing"}'::jsonb
       where organization_id=$1 and run_id=$2 and id=$3`,
      [input.organizationId, input.runId, input.proposalId],
    );
    await appendWorkbenchEventTx(client, input.organizationId, input.runId,
      "tool_started", { proposalId: input.proposalId, tool: LEAD_STAGE_TOOL });
    return "claimed";
  });
}

/** Never enter a tool after a cancellation or stale decision is already visible. */
export async function assertWorkbenchApprovedActionCurrent(pool: Pool, input: {
  organizationId: string; runId: string; proposalId: string;
}): Promise<void> {
  await pool.query("select public.fn_assert_ai_collaboration_write_allowed($1,$2)", [input.organizationId, input.runId]);
  const { rows } = await pool.query<{ current: boolean }>(
    `select exists (
       select 1 from public.ai_workbench_runs r
       join public.ai_agent_action_proposals p
         on p.organization_id=r.organization_id and p.run_id=r.id
       where r.organization_id=$1 and r.id=$2 and r.status='running'
         and p.id=$3 and p.status='approved'
         and (r.mission_id is null or exists (
           select 1 from public.ai_missions m
           where m.organization_id=r.organization_id and m.id=r.mission_id
             and m.status not in ('cancelled','completed')))
     ) as current`,
    [input.organizationId, input.runId, input.proposalId],
  );
  if (!rows[0]?.current) throw new Error("workbench_approved_action_no_longer_current");
}

/** Commit one known tool result with the private Pi observation and next job. */
export async function finishWorkbenchApprovedAction(
  pool: Pool,
  input: ApprovalCoordinates & ApprovalSettlement & { toolName: string; result: ActionResult },
): Promise<ActionOutcome | null> {
  return transaction(pool, async (client) => {
    const { rows: runs } = await client.query<{ status: string }>(
      `select status from public.ai_workbench_runs
       where organization_id=$1 and id=$2 and run_kind='root' for update`,
      [input.organizationId, input.runId],
    );
    const run = runs[0];
    if (!run) return null;
    const { rows: [proposal] } = await client.query<{ status: string; tool_name: string; outcome: string | null }>(
      `select status,tool_name,result_summary->>'outcome' as outcome from public.ai_agent_action_proposals
       where organization_id=$1 and run_id=$2 and id=$3 for update`,
      [input.organizationId, input.runId, input.proposalId],
    );
    if (proposal?.status !== "approved" || proposal.tool_name !== input.toolName ||
        (input.expectedOutcome && proposal.outcome !== input.expectedOutcome))
      return null;
    await input.assertOwner?.(client);
    if (!["running", "cancelled"].includes(run.status))
      throw new Error("workbench_approved_action_run_state_conflict");
    if (input.result.kind === "success" && input.toolName === "crm_update_lead" &&
        (!input.result.compensationArgs || !input.result.preview))
      throw new Error("workbench_approved_lead_compensation_missing");
    await client.query(
      `update public.ai_agent_action_proposals
       set status=$4,
           result_summary=jsonb_build_object('outcome',$5::text,'tool',$6::text),
           compensation_args=case when $7::jsonb is null then compensation_args else $7::jsonb end,
           preview=case when $8::jsonb is null then preview else $8::jsonb end
       where organization_id=$1 and run_id=$2 and id=$3 and status='approved'`,
      [input.organizationId, input.runId, input.proposalId,
        input.result.kind === "success" ? "executed" : "failed",
        input.result.kind === "success" ? "executed" : "failed",
        input.toolName,
        input.result.kind === "success" && input.result.compensationArgs
          ? JSON.stringify(input.result.compensationArgs) : null,
        input.result.kind === "success" && input.result.preview
          ? JSON.stringify(input.result.preview) : null],
    );
    await appendWorkbenchEventTx(client, input.organizationId, input.runId,
      "tool_completed", { proposalId: input.proposalId, tool: input.toolName,
        status: input.result.kind === "success" ? "success" : "error" });
    if (input.result.kind === "success")
      await appendWorkbenchEventTx(client, input.organizationId, input.runId,
        "crm_state_changed", { proposalId: input.proposalId, tool: input.toolName,
          ...(input.result.preview ? {
            targetId: input.result.preview.resourceUuid,
            changedFields: input.result.preview.changedFields,
          } : {}) });
    if (run.status === "cancelled") return "cancelled";

    const { rows: states } = await client.query<{ messages: unknown }>(
      `select messages from public.ai_agent_run_states
       where organization_id=$1 and run_id=$2 for update`,
      [input.organizationId, input.runId],
    );
    const messages = parseRuntimeMessages(states[0]?.messages);
    if (!messages) {
      await client.query(
        `update public.ai_workbench_runs
         set status='partial',error_code='resume_state_missing',completed_at=now()
         where organization_id=$1 and id=$2 and status='running'`,
        [input.organizationId, input.runId],
      );
      await client.query(
        `update public.ai_agent_action_proposals set status='cancelled'
         where organization_id=$1 and run_id=$2 and status='pending'`,
        [input.organizationId, input.runId],
      );
      await client.query(
        `update public.ai_reply_drafts
         set status='stale',error_code='resume_state_missing'
         where organization_id=$1 and workbench_run_id=$2 and status='pending'`,
        [input.organizationId, input.runId],
      );
      await appendWorkbenchEventTx(client, input.organizationId, input.runId,
        "run_partial", { status: "partial", reason: "resume_state_missing",
          pendingProposals: 0 });
      return "partial";
    }
    const observation = input.result.kind === "success"
      ? { tool: input.toolName, status: "executed" as const, result: input.result.output }
      : { tool: input.toolName, status: "failed" as const,
          result: { error: input.result.code } };
    await client.query(
      `update public.ai_agent_run_states set messages=$3::jsonb
       where organization_id=$1 and run_id=$2`,
      [input.organizationId, input.runId,
        JSON.stringify(appendWorkbenchObservation(messages, observation))],
    );
    const { rows: pending } = await client.query<{ count: number }>(
      `select count(*)::int as count from public.ai_agent_action_proposals
       where organization_id=$1 and run_id=$2 and status='pending'`,
      [input.organizationId, input.runId],
    );
    if ((pending[0]?.count ?? 0) > 0) {
      await client.query(
        `update public.ai_workbench_runs set status='awaiting_confirmation'
         where organization_id=$1 and id=$2 and status='running'`,
        [input.organizationId, input.runId],
      );
      return "awaiting_confirmation";
    }
    await client.query(
      `insert into public.job_queue
       (organization_id,kind,source_event_id,payload,max_attempts)
       values ($1,'workbench_resume',$2,jsonb_build_object('runId',$3::uuid),3)`,
      [input.organizationId, input.proposalId, input.runId],
    );
    await appendWorkbenchEventTx(client, input.organizationId, input.runId,
      "run_resumed", { proposalId: input.proposalId });
    return "queued";
  });
}

/** A started non-idempotent tool cannot be replayed after an uncertain crash. */
export async function markWorkbenchApprovedActionUncertain(
  pool: Pool,
  input: ApprovalCoordinates & ApprovalSettlement,
): Promise<boolean> {
  return transaction(pool, async (client) => {
    const { rows: runs } = await client.query<{ status: string }>(
      `select status from public.ai_workbench_runs
       where organization_id=$1 and id=$2 and run_kind='root' for update`,
      [input.organizationId, input.runId],
    );
    if (!runs[0]) return false;
    const { rows: [proposal] } = await client.query<{ status: string; tool_name: string; outcome: string | null }>(
      `select status,tool_name,result_summary->>'outcome' as outcome from public.ai_agent_action_proposals
       where organization_id=$1 and run_id=$2 and id=$3 for update`,
      [input.organizationId, input.runId, input.proposalId],
    );
    if (proposal?.status !== "approved" || (input.expectedOutcome && proposal.outcome !== input.expectedOutcome))
      return false;
    await input.assertOwner?.(client);
    await client.query(
      `update public.ai_agent_action_proposals
       set status='failed',result_summary=$4::jsonb
       where organization_id=$1 and run_id=$2 and id=$3 and status='approved'`,
      [input.organizationId, input.runId, input.proposalId,
        JSON.stringify({ outcome: "reconciliation_required", code: "effect_may_have_completed" })],
    );
    await appendWorkbenchEventTx(client, input.organizationId, input.runId,
      "tool_completed", { proposalId: input.proposalId,
        tool: proposal.tool_name, status: "unknown" });
    if (runs[0].status === "running") {
      await client.query(
        `update public.ai_workbench_runs
         set status='partial',error_code='approved_action_outcome_unknown',completed_at=now()
         where organization_id=$1 and id=$2 and status='running'`,
        [input.organizationId, input.runId],
      );
      await client.query(
        `update public.ai_agent_action_proposals set status='cancelled'
         where organization_id=$1 and run_id=$2 and status='pending'`,
        [input.organizationId, input.runId],
      );
      await client.query(
        `update public.ai_reply_drafts
         set status='stale',error_code='approved_action_outcome_unknown'
         where organization_id=$1 and workbench_run_id=$2 and status='pending'`,
        [input.organizationId, input.runId],
      );
      await appendWorkbenchEventTx(client, input.organizationId, input.runId,
        "run_partial", { status: "partial", pendingProposals: 0,
          reason: "approved_action_outcome_unknown" });
    }
    return true;
  });
}

/** A terminal execution job can fail safely only while its decision is still queued. */
export async function reconcileAbandonedDeferredStageApproval(pool: Pool, input: ApprovalCoordinates) {
  const { rows: [proposal] } = await pool.query<{ outcome: ExecutionState }>(
    `select proposal.result_summary->>'outcome' as outcome
       from public.ai_agent_action_proposals proposal
      where proposal.organization_id=$1 and proposal.run_id=$2 and proposal.id=$3
        and proposal.tool_name=$4 and proposal.status='approved'
        and not exists (
          select 1 from public.job_queue job
          where job.organization_id=proposal.organization_id and job.kind='workbench_resume'
            and job.payload->>'runId'=proposal.run_id::text
            and job.payload->>'approvedProposalId'=proposal.id::text
            and job.status in ('pending','running')
        )`,
    [input.organizationId, input.runId, input.proposalId, LEAD_STAGE_TOOL],
  );
  if (proposal?.outcome === "queued")
    return Boolean(await finishWorkbenchApprovedAction(pool, {
      ...input, toolName: LEAD_STAGE_TOOL, expectedOutcome: "queued",
      result: { kind: "safe_failure", code: "approval_execution_job_unavailable" },
    }));
  return proposal?.outcome === "executing"
    ? markWorkbenchApprovedActionUncertain(pool, { ...input, expectedOutcome: "executing" })
    : false;
}

/** Repair abandoned HTTP approvals without re-entering the CRM tool. */
export async function reconcileStaleWorkbenchApprovedActions(
  pool: Pool, limit = 20,
  onError?: (failure: { organizationId: string; runId: string;
    proposalId: string; code: string }) => void,
): Promise<number> {
  const { rows } = await pool.query<{
    organization_id: string; run_id: string; proposal_id: string; outcome: string | null;
  }>(
    `select p.organization_id,p.run_id,p.id as proposal_id,p.result_summary->>'outcome' as outcome
     from public.ai_agent_action_proposals p
     join public.ai_workbench_runs r
       on r.organization_id=p.organization_id and r.id=p.run_id
     where p.status='approved' and p.tool_name<>'send_message'
       and p.decision_at < now()-interval '6 minutes'
       and r.run_kind='root'
       and not exists (
         select 1 from public.job_queue job
         where job.organization_id=p.organization_id and job.kind='workbench_resume'
           and job.payload->>'runId'=p.run_id::text and job.payload->>'approvedProposalId'=p.id::text
           and job.status in ('pending','running')
       )
     order by p.decision_at limit $1`,
    [Math.max(1, Math.min(limit, 100))],
  );
  let marked = 0;
  for (const row of rows) {
    try {
      const input = {
        organizationId: row.organization_id, runId: row.run_id,
        proposalId: row.proposal_id,
      };
      const settled = row.outcome === "queued"
        ? await reconcileAbandonedDeferredStageApproval(pool, input)
        : await markWorkbenchApprovedActionUncertain(pool, input);
      if (settled) marked += 1;
    } catch (error) {
      onError?.({ organizationId: row.organization_id,
        runId: row.run_id, proposalId: row.proposal_id,
        code: error && typeof error === "object" && "code" in error
          ? String(error.code) : "recovery_failed" });
    }
  }
  return marked;
}
