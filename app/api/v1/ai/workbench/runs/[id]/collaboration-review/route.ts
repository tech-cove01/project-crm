import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { audit } from "@/lib/audit";
import {
  collaborationReviewSchema,
  collaborationRereadPort,
  outcomeFromChildren,
  persistCollaborationReview,
  rereadCollaborationOutcome,
} from "@/lib/ai/agents/workbench-collaboration-review";

export const dynamic = "force-dynamic";
const bodySchema = z
  .object({
    revision: z.number().int().positive(),
    reason: z.string().trim().min(1).max(1000),
    decision: z.literal("reread"),
  })
  .strict();
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID(),
    { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success)
    return fail("invalid_request", "运行 ID 无效。", 400, { requestId });
  const authz = await requireRole("manager", { requestId, resource: "ai_workbench" });
  if (!authz.ok) return authz.response;
  const denied = await requireSupportWrite(authz.org.orgId);
  if (denied) return denied;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return fail("invalid_request", "请提交复核版本、理由及重新取证决定。", 422, { requestId });
  const admin = createAdminClient();
  const { data: run, error } = await admin
    .from("ai_workbench_runs")
    .select("id,agent_id,status,scope,collaboration_review")
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .eq("run_kind", "root")
    .maybeSingle();
  if (error)
    return fail("review_unavailable", "无法核对运行状态；动作保持阻断。", 503, { requestId });
  if (!run) return fail("not_found", "运行不存在。", 404, { requestId });
  const prior = collaborationReviewSchema.safeParse(run.collaboration_review);
  if (
    !prior.success ||
    prior.data.status !== "pending" ||
    prior.data.revision !== parsed.data.revision ||
    run.status !== "partial"
  )
    return fail("review_state_conflict", "复核状态已变化，请刷新后重试。", 409, { requestId });
  try {
    const { data: children, error: childError } = await admin
      .from("ai_workbench_runs")
      .select("id,runtime_state")
      .eq("organization_id", authz.org.orgId)
      .eq("parent_run_id", id)
      .eq("run_kind", "specialist");
    if (childError) throw new Error("review_material_unavailable");
    const outcome = outcomeFromChildren(children ?? []);
    const rechecked = await rereadCollaborationOutcome(
      outcome,
      collaborationRereadPort(getRequestPool(), authz.org.orgId, run.scope ?? {}, run.agent_id),
    );
    const review = await persistCollaborationReview(getRequestPool(), {
      organizationId: authz.org.orgId,
      runId: id,
      outcome: rechecked.outcome,
      expectedRevision: parsed.data.revision,
      actorUserId: authz.user.id,
      reason: parsed.data.reason,
      unavailable: rechecked.unavailable,
      resolved: rechecked.resolved,
      observations: rechecked.observations,
    });
    await audit({
      action: "ai_workbench.collaboration_reviewed",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "ai_workbench_runs",
      resourceId: id,
      requestId,
      metadata: { revision: review.revision, status: review.status, decision: "reread_only" },
    });
    return ok(
      {
        review,
        actionExecuted: false,
        oldProposalsCancelled: true,
        nextStep:
          review.status === "resolved" ? "create_new_run_with_current_facts" : "review_required",
      },
      { requestId },
    );
  } catch (cause) {
    if (
      cause instanceof Error &&
      ["collaboration_review_revision_changed", "collaboration_review_not_pending"].includes(
        cause.message,
      )
    )
      return fail("review_state_conflict", "另一项复核已改变状态，请刷新后重试。", 409, {
        requestId,
      });
    return fail("review_unavailable", "无法完成当前事实复核；动作保持阻断。", 503, { requestId });
  }
}
