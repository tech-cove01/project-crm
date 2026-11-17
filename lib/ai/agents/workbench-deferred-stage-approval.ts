import type { Pool } from "pg";
import { loadAgentVersionConfig } from "@/lib/agent-engine/agent/agent-config";
import { requestTurnDeps } from "@/lib/agent-engine/agent/request-deps";
import { buildMcpTurnTools } from "@/lib/agent-engine/edge/crm/mcp-tools";
import type { createAdminClient } from "@/lib/supabase/admin";
import {
  executeApprovedWorkbenchTool, WorkbenchToolRejectedError,
} from "./approved-workbench-tool";
import { validateWorkbenchToolArgs } from "./validate-workbench-tool-args";
import {
  assertWorkbenchApprovedActionCurrent, beginWorkbenchDeferredStageApproval,
  finishWorkbenchApprovedAction, markWorkbenchApprovedActionUncertain,
} from "./workbench-approved-action";
import { CollaborationReviewRequiredError, withCollaborationActionFence } from "./workbench-collaboration-review";
import { LEAD_STAGE_TOOL } from "./workbench-ontology-contract";
import { resolveWorkbenchScope, workbenchScopeInputFromRun } from "./workbench-scope";

/** Execute a queued ontology-grounded stage decision, then let the usual job resume Pi. */
export async function executeDeferredWorkbenchStageApproval(input: {
  pool: Pool;
  admin: ReturnType<typeof createAdminClient>;
  organizationId: string;
  runId: string;
  proposalId: string;
  run: { agent_id: string; status: string; mode: string; runtime_state: unknown; scope: unknown };
  assertLease: (queryable?: Pick<Pool, "query">) => Promise<void>;
  assertOwner: (queryable: Pick<Pool, "query">) => Promise<void>;
}) {
  const { admin, pool, organizationId, runId, proposalId, run, assertLease, assertOwner } = input;
  const coordinates = { organizationId, runId, proposalId };
  const { rows: [proposal] } = await pool.query<{ tool_args: unknown; outcome: string | null }>(
    `select tool_args,result_summary->>'outcome' as outcome
       from public.ai_agent_action_proposals
      where organization_id=$1 and run_id=$2 and id=$3 and tool_name=$4 and status='approved'`,
    [organizationId, runId, proposalId, LEAD_STAGE_TOOL],
  );
  if (!proposal) return;
  const claim = () => beginWorkbenchDeferredStageApproval(pool, { ...coordinates, assertLease });
  let claimed = false;
  const blocked = (code: string) => finishWorkbenchApprovedAction(pool, {
    ...coordinates, toolName: LEAD_STAGE_TOOL, expectedOutcome: claimed ? "executing" : "queued", assertOwner,
    result: { kind: "safe_failure", code },
  });
  const uncertain = () => markWorkbenchApprovedActionUncertain(pool, {
    ...coordinates, expectedOutcome: "executing", assertOwner,
  });
  if (proposal.outcome === "executing") {
    if (await claim() === "uncertain") await uncertain();
    return;
  }
  if (proposal.outcome !== "queued") return;
  if (run.status === "cancelled") {
    await blocked("approval_no_longer_current");
    return;
  }
  await assertLease();
  const state = run.runtime_state as { versionId?: unknown } | null;
  const args = validateWorkbenchToolArgs(LEAD_STAGE_TOOL, proposal.tool_args);
  if (run.status !== "running" || run.mode !== "act" || typeof state?.versionId !== "string" || !args.ok) {
    await blocked("approval_no_longer_current");
    return;
  }
  const config = await loadAgentVersionConfig(pool, organizationId, run.agent_id, state.versionId);
  const scope = await resolveWorkbenchScope(admin, organizationId, workbenchScopeInputFromRun(run.scope))
    .catch(() => null);
  if (!config?.toolIds.includes(LEAD_STAGE_TOOL) || !scope?.leadId || !scope.pipelineId ||
      typeof args.args.lead_id !== "string" || args.args.lead_id.toLowerCase() !== scope.leadId) {
    await blocked("approval_no_longer_current");
    return;
  }
  const deps = requestTurnDeps();
  const mcp = await buildMcpTurnTools(deps.crmCfg, { organizationId, jobId: runId },
    { ...config, pipelineIds: [scope.pipelineId], toolIds: [LEAD_STAGE_TOOL] }, deps.log,
    { targetScope: { leadId: scope.leadId, contactId: scope.contactId, conversationId: scope.conversationId } },
  );
  let enteredTool = false;
  try {
    if (!mcp || typeof mcp.tools[LEAD_STAGE_TOOL]?.execute !== "function") {
      await blocked("crm_tool_unavailable");
      return;
    }
    const result = await withCollaborationActionFence(pool, organizationId, runId, async () => {
      const start = await claim();
      if (start !== "claimed") return start;
      claimed = true;
      try {
        await assertWorkbenchApprovedActionCurrent(pool, coordinates);
      } catch {
        return "blocked" as const;
      }
      await assertLease();
      enteredTool = true;
      return executeApprovedWorkbenchTool({ toolName: LEAD_STAGE_TOOL, args: args.args, tools: mcp.tools as never });
    });
    if (result === "blocked") {
      await blocked("approval_no_longer_current");
    } else if (result === "uncertain") {
      await uncertain();
    } else if (result !== "settled") {
      const outcome = await finishWorkbenchApprovedAction(pool, {
        ...coordinates, toolName: LEAD_STAGE_TOOL, expectedOutcome: "executing", assertOwner,
        result: { kind: "success", output: result.output },
      });
      if (!outcome) throw new Error("deferred_stage_receipt_state_conflict");
    }
  } catch (error) {
    if (error instanceof CollaborationReviewRequiredError || error instanceof WorkbenchToolRejectedError) {
      await blocked(error instanceof CollaborationReviewRequiredError ? "collaboration_review_required" : "crm_tool_rejected");
    } else if (enteredTool) {
      await uncertain();
    } else {
      throw error;
    }
  } finally {
    await mcp?.cleanup();
  }
}
