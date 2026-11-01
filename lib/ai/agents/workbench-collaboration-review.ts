import type { Pool, PoolClient, QueryConfig } from "pg";
import { z } from "zod";
import type { AgentCollaborationOutcome, AgentSpecialistResult } from "./collaboration";
import { detectCollaborationConflicts } from "./collaboration-runtime";
import { claimValueHash } from "./evidence-claims";
import { readCompanyWikiEvidence } from "@/lib/ai/integrations/weknora";
import { appendWorkbenchEventTx } from "./workbench-transaction-events";
import { integrationQuery } from "@/lib/ai/integrations/db";

const conflictSchema = z.object({
  code: z.enum(["evidence_disagreement", "stale_state", "specialist_failure"]),
  specialistKeys: z.array(z.string()).max(10),
  field: z.string().optional(),
  message: z.string(),
});
export const collaborationReviewSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().positive(),
  status: z.enum(["pending", "resolved"]),
  planKey: z.string(),
  childRunIds: z.array(z.string()).max(10),
  conflicts: z.array(conflictSchema).max(200),
  checkedAt: z.string(),
  unavailable: z.number().int().nonnegative(),
  observations: z
    .array(
      z.object({
        identity: z.string(),
        revision: z.string(),
        fieldHashes: z.record(z.string(), z.string()),
      }),
    )
    .max(20),
  reviewedBy: z.string().optional(),
  reason: z.string().max(1000).optional(),
});
export type CollaborationReview = z.infer<typeof collaborationReviewSchema>;
export class CollaborationReviewRequiredError extends Error {
  constructor() {
    super("collaboration_review_required");
  }
}
type Scope = { leadId?: string | null; contactId?: string | null; conversationId?: string | null };
type RereadPort = {
  record(resource: string, id: string): Promise<Record<string, unknown> | null>;
  wiki(evidenceId: string, revision?: string, excerpt?: string): Promise<boolean>;
};
function scalarPath(row: Record<string, unknown>, field: string): unknown {
  let value: unknown = row;
  for (const key of field.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** Exactly one authoritative reread per implicated object/evidence, never another model turn. */
export async function rereadCollaborationOutcome(
  outcome: AgentCollaborationOutcome,
  port: RereadPort,
) {
  const records = new Map<string, Record<string, unknown> | null>();
  const wiki = new Map<string, boolean>();
  let unavailable = 0;
  const implicated = outcome.conflicts.filter((c) => c.code !== "specialist_failure");
  const facts: Array<{ resource: string; id: string; fields: Record<string, unknown> }> = [];
  for (const result of outcome.results) {
    for (const claim of result.claims) {
      const identity = `${claim.subject.resource}:${claim.subject.id}`;
      if (!implicated.some((c) => c.field === identity || c.field === `${identity}:${claim.field}`))
        continue;
      if (records.has(identity)) continue;
      if (records.size >= 10) {
        unavailable++;
        continue;
      }
      try {
        records.set(identity, await port.record(claim.subject.resource, claim.subject.id));
      } catch {
        records.set(identity, null);
      }
      if (!records.get(identity)) unavailable++;
    }
    for (const evidence of result.evidence) {
      if (
        evidence.locator.provider !== "weknora" ||
        !implicated.some((c) => c.field?.startsWith(`weknora:${evidence.locator.sourceId}:`))
      )
        continue;
      if (wiki.has(evidence.id)) continue;
      if (wiki.size >= 10) {
        unavailable++;
        continue;
      }
      let verified = false;
      try {
        verified = await port.wiki(evidence.id, evidence.locator.revision, evidence.excerpt);
      } catch {
        /* stay pending */
      }
      wiki.set(evidence.id, verified);
      if (!verified) unavailable++;
    }
  }
  const results = outcome.results.map((result) => ({
    ...result,
    claims: result.claims.map((claim) => {
      const row = records.get(`${claim.subject.resource}:${claim.subject.id}`);
      if (!row) return claim;
      const value = scalarPath(row, claim.field);
      if (value === undefined) {
        unavailable++;
        return claim;
      }
      let fact = facts.find(
        (f) => f.resource === claim.subject.resource && f.id === claim.subject.id,
      );
      if (!fact) {
        fact = { ...claim.subject, fields: {} };
        facts.push(fact);
      }
      fact.fields[claim.field] = value;
      return {
        ...claim,
        valueHash: claimValueHash(value),
        locator: {
          ...claim.locator,
          revision: String(row.updated_at ?? row.revision ?? row.version ?? "current"),
        },
      };
    }),
  }));
  let conflicts = detectCollaborationConflicts(results);
  // Invalid or withdrawn immutable Wiki receipts cannot be replaced by newer prose.
  if (unavailable) conflicts = outcome.conflicts;
  else
    conflicts = conflicts.filter(
      (c) =>
        !c.field?.startsWith("weknora:") ||
        outcome.results.some((r) =>
          r.evidence.some(
            (e) => c.field?.startsWith(`weknora:${e.locator.sourceId}:`) && wiki.get(e.id) !== true,
          ),
        ),
    );
  const missingChild = results.some((result) => result.status !== "complete");
  const resolved = !conflicts.length && !unavailable && !missingChild;
  return {
    outcome: {
      ...outcome,
      conflicts,
      status: resolved ? ("complete" as const) : ("partial" as const),
      ...(facts.length ? { rereadContext: JSON.stringify(facts) } : {}),
    },
    observations: [...records.entries()]
      .flatMap(([identity, row]) =>
        row
          ? [
              {
                identity,
                revision: String(row.updated_at ?? row.revision ?? row.version ?? "current"),
                fieldHashes: Object.fromEntries(
                  (facts.find((f) => `${f.resource}:${f.id}` === identity)
                    ? Object.entries(
                        facts.find((f) => `${f.resource}:${f.id}` === identity)!.fields,
                      )
                    : []
                  ).map(([field, value]) => [field, claimValueHash(value)]),
                ),
              },
            ]
          : [],
      )
      .concat(
        outcome.results.flatMap((result) =>
          result.evidence
            .filter((e) => wiki.get(e.id) === true)
            .map((e) => ({
              identity: `weknora:${e.locator.sourceId}:${String(e.metadata?.knowledge_base_id ?? "unknown")}:${String(e.metadata?.page_id ?? e.id)}`,
              revision: e.locator.revision ?? "unknown",
              fieldHashes: { excerpt: claimValueHash(e.excerpt) },
            })),
        ),
      ),
    unavailable,
    resolved,
  };
}

export function collaborationRereadPort(
  pool: Pool,
  organizationId: string,
  scope: Scope,
  agentId: string,
): RereadPort {
  const signal = AbortSignal.timeout(15_000);
  let allowed: Promise<string[]> | undefined;
  return {
    async record(resource, id) {
      signal.throwIfAborted();
      const selections: Record<string, { id: string | null | undefined; sql: string }> = {
        lead: {
          id: scope.leadId,
          sql: "select to_jsonb(r) data from public.crm_leads r where organization_id=$1 and id=$2",
        },
        contact: {
          id: scope.contactId,
          sql: "select to_jsonb(r) data from public.contacts r where organization_id=$1 and id=$2 and is_anonymized=false and is_merged_into is null",
        },
        conversation: {
          id: scope.conversationId,
          sql: "select to_jsonb(r) data from public.conversations r where organization_id=$1 and id=$2",
        },
      };
      const selected = selections[resource];
      if (!selected || selected.id?.toLowerCase() !== id.toLowerCase()) return null;
      const query: QueryConfig & { query_timeout: number } = {
        text: selected.sql,
        values: [organizationId, id.toLowerCase()],
        query_timeout: 2000,
      };
      const { rows } = await pool.query<{ data: Record<string, unknown> }>(query);
      signal.throwIfAborted();
      return rows[0]?.data ?? null;
    },
    async wiki(id, revision, excerpt) {
      signal.throwIfAborted();
      allowed ??= integrationQuery<{ knowledge_source_ids: string[] | null }>(
        pool,
        `select v.knowledge_source_ids from public.ai_agents a
         join lateral (select knowledge_source_ids from public.ai_agent_versions av
           where av.organization_id=a.organization_id and av.agent_id=a.id
             and (a.origin='builtin' or a.published_version_id is null or av.id=a.published_version_id)
           order by av.version_number desc limit 1) v on true
         where a.organization_id=$1 and a.id=$2 and a.archived_at is null`,
        [organizationId, agentId],
      ).then((result) => result.rows[0]?.knowledge_source_ids ?? []);
      const { rows } = await integrationQuery<{ source_id: string }>(
        pool,
        "select source_id from public.ai_wiki_evidence where organization_id=$1 and id=$2",
        [organizationId, id],
      );
      if (!rows[0] || !(await allowed).includes(rows[0].source_id)) return false;
      const current = await readCompanyWikiEvidence(pool, organizationId, id, signal);
      return Boolean(
        current &&
        current.revision === revision &&
        current.content.slice(0, 12000).trim() === excerpt?.trim(),
      );
    },
  };
}

async function lockedRun(client: PoolClient, organizationId: string, runId: string) {
  await client.query(
    "select pg_advisory_xact_lock(hashtextextended(public.fn_ai_collaboration_scope_key($1,$2),0))",
    [organizationId, runId],
  );
  const { rows } = await client.query<{ collaboration_review: unknown; status: string }>(
    "select collaboration_review,status from public.ai_workbench_runs where organization_id=$1 and id=$2 and run_kind='root' for update",
    [organizationId, runId],
  );
  if (!rows[0] || ["cancelled", "failed"].includes(rows[0].status))
    throw new Error("collaboration_review_run_unavailable");
  return rows[0];
}
async function transaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local lock_timeout='5s'");
    const result = await action(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/** Persist pending before rereading/parent synthesis. A failed save must abort the caller. */
export async function persistCollaborationReview(
  pool: Pool,
  input: {
    organizationId: string;
    runId: string;
    outcome: AgentCollaborationOutcome;
    expectedRevision?: number;
    actorUserId?: string;
    reason?: string;
    unavailable?: number;
    resolved?: boolean;
    observations?: CollaborationReview["observations"];
  },
) {
  return transaction(pool, async (client) => {
    const run = await lockedRun(client, input.organizationId, input.runId);
    const prior =
      run.collaboration_review === null
        ? null
        : collaborationReviewSchema.parse(run.collaboration_review);
    if (input.expectedRevision !== undefined && prior?.revision !== input.expectedRevision)
      throw new Error("collaboration_review_revision_changed");
    if (input.actorUserId && (!prior || prior.status !== "pending" || run.status !== "partial"))
      throw new Error("collaboration_review_not_pending");
    const review = collaborationReviewSchema.parse({
      version: 1,
      revision: (prior?.revision ?? 0) + 1,
      status: input.resolved ? "resolved" : "pending",
      planKey: input.outcome.planKey,
      childRunIds: input.outcome.results.map((r) => r.childRunId),
      conflicts: input.outcome.conflicts,
      checkedAt: new Date().toISOString(),
      unavailable: input.unavailable ?? 0,
      observations: input.observations ?? [],
      ...(input.actorUserId ? { reviewedBy: input.actorUserId, reason: input.reason } : {}),
    });
    await client.query(
      "update public.ai_workbench_runs set collaboration_review=$3::jsonb where organization_id=$1 and id=$2",
      [input.organizationId, input.runId, JSON.stringify(review)],
    );
    if (input.actorUserId) {
      // Reviewing facts never authorizes an old action. A new task must create new proposals.
      await client.query(
        `update public.ai_agent_action_proposals p set status='cancelled'
        from public.ai_workbench_runs r where p.organization_id=$1 and r.organization_id=$1
        and p.run_id=r.id and p.status='pending' and r.created_at<=$3::timestamptz
        and public.fn_ai_collaboration_scope_key($1,r.id)=public.fn_ai_collaboration_scope_key($1,$2)`,
        [input.organizationId, input.runId, review.checkedAt],
      );
      await client.query(
        `update public.ai_reply_drafts d set status='stale',error_code='collaboration_review_required'
        from public.ai_workbench_runs r where d.organization_id=$1 and r.organization_id=$1
        and d.workbench_run_id=r.id and d.status='pending' and r.created_at<=$3::timestamptz
        and public.fn_ai_collaboration_scope_key($1,r.id)=public.fn_ai_collaboration_scope_key($1,$2)`,
        [input.organizationId, input.runId, review.checkedAt],
      );
    }
    await appendWorkbenchEventTx(client, input.organizationId, input.runId, "policy_checked", {
      gate: "collaboration_review",
      decision: review.status === "resolved" ? "reread_verified" : "blocked",
      code: "collaboration_review_required",
    });
    return review;
  });
}

export async function hasPendingCollaborationReview(
  pool: Pool,
  organizationId: string,
  runId: string,
) {
  try {
    await pool.query("select public.fn_assert_ai_collaboration_write_allowed($1,$2)", [
      organizationId,
      runId,
    ]);
    return false;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "P0001" &&
      "message" in error &&
      ["collaboration_review_required", "collaboration_new_run_required"].includes(
        String(error.message),
      )
    )
      return true;
    throw new Error("collaboration_review_read_failed");
  }
}

/** Shared fence for direct reversible writes and reviewed tools; SQL/RPC approvals have a DB trigger too. */
export async function withCollaborationActionFence<T>(
  pool: Pool,
  organizationId: string,
  runId: string,
  action: () => Promise<T>,
) {
  return transaction(pool, async (client) => {
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended(public.fn_ai_collaboration_scope_key($1,$2),0))",
      [organizationId, runId],
    );
    try {
      await client.query("select public.fn_assert_ai_collaboration_write_allowed($1,$2)", [
        organizationId,
        runId,
      ]);
    } catch {
      throw new CollaborationReviewRequiredError();
    }
    return action();
  });
}

export async function finishInitialCollaborationReview(
  pool: Pool,
  organizationId: string,
  runId: string,
  scope: Scope,
  outcome: AgentCollaborationOutcome,
  agentId: string,
) {
  if (!outcome.conflicts.length && outcome.status === "complete") return outcome;
  const pending = await persistCollaborationReview(pool, { organizationId, runId, outcome });
  const rechecked = await rereadCollaborationOutcome(
    outcome,
    collaborationRereadPort(pool, organizationId, scope, agentId),
  );
  await persistCollaborationReview(pool, {
    organizationId,
    runId,
    outcome: rechecked.outcome,
    expectedRevision: pending.revision,
    unavailable: rechecked.unavailable,
    resolved: rechecked.resolved,
    observations: rechecked.observations,
  });
  return rechecked.outcome;
}

export function outcomeFromChildren(
  children: Array<{ id: string; runtime_state: unknown }>,
): AgentCollaborationOutcome {
  const results = children.map((child) => {
    const state = child.runtime_state as { specialistResult?: AgentSpecialistResult } | null;
    const result = state?.specialistResult;
    if (
      !result ||
      result.childRunId !== child.id ||
      !Array.isArray(result.claims) ||
      !Array.isArray(result.evidence) ||
      !Array.isArray(result.missingMaterial) ||
      !["complete", "partial", "failed"].includes(result.status)
    )
      throw new Error("collaboration_review_child_state_invalid");
    return result;
  });
  if (results.length !== 3) throw new Error("collaboration_review_children_incomplete");
  return {
    planKey: "opportunity_review_v1",
    results,
    conflicts: detectCollaborationConflicts(results),
    status: "partial",
    usage: { toolCalls: 0, inputTokens: 0, outputTokens: 0, costCents: null, modelTurns: 0 },
  };
}
