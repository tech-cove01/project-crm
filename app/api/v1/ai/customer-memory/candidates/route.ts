import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { llmEdgeConfigFromEnv } from "@/lib/agent-engine/edge/llm/run-model-call";
import { loadEnv } from "@/lib/agent-engine/env";
import {
  assertCustomerMemoryCandidateAccess,
  CustomerMemoryCandidateError,
  customerMemoryCandidateCategory,
  decideCustomerMemoryCandidate,
  listCustomerMemoryCandidates,
  loadCustomerMemorySource,
  saveCustomerMemoryCandidates,
} from "@/lib/ai/customer-memory/candidates";
import {
  CustomerMemoryExtractionError,
  extractCustomerMemoryCandidates,
} from "@/lib/ai/customer-memory/extraction";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { authenticatedSessionId, requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

export const maxDuration = 60;

const sourceSchema = z.object({
  contact_id: z.uuid(),
  conversation_id: z.uuid().optional(),
}).strict();
const decisionBase = z.object({
  contact_id: z.uuid(),
  candidate_id: z.uuid(),
});
const decisionSchema = z.discriminatedUnion("decision", [
  decisionBase.extend({
    decision: z.literal("confirm"),
    category: customerMemoryCandidateCategory.optional(),
    body: z.string().trim().min(1).max(2_000).optional(),
  }).strict(),
  decisionBase.extend({ decision: z.literal("reject") }).strict(),
]);

const candidateErrors: Record<CustomerMemoryCandidateError["code"], string> = {
  forbidden: "没有操作该联系人记忆候选的权限。",
  contact_not_found: "联系人不存在或无法访问。",
  source_not_found: "无法访问所选历史单聊。",
  source_changed: "原消息已修改或撤回。请重新核对来源。",
  candidate_not_found: "该联系人的记忆候选不存在。",
  decision_conflict: "候选已有不同的处理决定。请刷新后查看。",
  invalid_evidence: "候选引用与授权消息的原文不符。",
};

function candidateFailure(error: unknown, requestId: string) {
  if (error instanceof CustomerMemoryCandidateError) {
    return fail(error.code, candidateErrors[error.code], error.status, { requestId });
  }
  if (error instanceof CustomerMemoryExtractionError) {
    const message = error.code === "model_output_invalid" ? "模型没有提交符合格式且带原文证据的候选。" : "模型暂时不可用，请稍后再试。";
    return fail(error.code, message, error.code === "model_output_invalid" ? 502 : 503, { requestId });
  }
  return fail("upstream_unavailable", "暂时无法处理记忆候选，请稍后再试。", 503, { requestId });
}

async function authorizeCandidateRequest(requestId: string, write: boolean) {
  const auth = await requireRole("manager", { requestId, resource: "ai_workbench" });
  if (!auth.ok) return { ok: false as const, response: auth.response };
  if (write) {
    const denied = await requireSupportWrite(auth.org.orgId);
    if (denied) return { ok: false as const, response: denied };
  }
  try {
    const sessionId = await authenticatedSessionId();
    return {
      ok: true as const,
      ctx: { pool: getRequestPool(), organizationId: auth.org.orgId, actorUserId: auth.user.id, sessionId },
    };
  } catch {
    return { ok: false as const, response: fail("forbidden", "无法验证当前会话权限，请重新登录。", 403, { requestId }) };
  }
}

export async function GET(req: NextRequest) {
  const requestId = randomUUID();
  const input = sourceSchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!input.success) return fail("invalid_request", "联系人或会话 ID 无效。", 400, { requestId });
  const auth = await authorizeCandidateRequest(requestId, false);
  if (!auth.ok) return auth.response;
  try {
    const result = await listCustomerMemoryCandidates(auth.ctx, input.data.contact_id);
    if (input.data.conversation_id) {
      const source = await loadCustomerMemorySource(await createClient(), {
        organizationId: auth.ctx.organizationId,
        contactId: input.data.contact_id,
        conversationId: input.data.conversation_id,
      });
      return ok({ ...result, conversation_id: source.conversationId }, { requestId });
    }
    return ok(result, { requestId });
  } catch (error) {
    return candidateFailure(error, requestId);
  }
}

export async function POST(req: NextRequest) {
  const requestId = randomUUID();
  const input = sourceSchema.safeParse(await req.json().catch(() => null));
  if (!input.success) return fail("invalid_request", "联系人或会话 ID 无效。", 400, { requestId });
  const auth = await authorizeCandidateRequest(requestId, true);
  if (!auth.ok) return auth.response;
  const { ctx } = auth;
  const contactId = input.data.contact_id;
  try {
    await assertCustomerMemoryCandidateAccess(ctx, contactId);
    const source = await loadCustomerMemorySource(await createClient(), {
      organizationId: ctx.organizationId,
      contactId,
      ...(input.data.conversation_id ? { conversationId: input.data.conversation_id } : {}),
    });
    if (!source.conversationId || !source.messages.length) {
      return ok({ conversation_id: source.conversationId, candidates: [] }, { requestId });
    }
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(45_000)]);
    const candidates = await extractCustomerMemoryCandidates({
      pool: ctx.pool,
      llmCfg: llmEdgeConfigFromEnv(loadEnv()),
      organizationId: ctx.organizationId,
      messages: source.messages,
      signal,
    });
    signal.throwIfAborted();
    const result = await saveCustomerMemoryCandidates(ctx, {
      contactId,
      conversationId: source.conversationId,
      messages: source.messages,
      candidates,
    });
    if (result.candidates.length) {
      await audit({
        action: "ai.customer_memory_candidates_extracted",
        actorUserId: ctx.actorUserId,
        organizationId: ctx.organizationId,
        resourceType: "contacts",
        resourceId: contactId,
        requestId,
        metadata: { candidate_count: result.candidates.length },
      });
    }
    return ok(result, { requestId });
  } catch (error) {
    return candidateFailure(error, requestId);
  }
}

export async function PATCH(req: NextRequest) {
  const requestId = randomUUID();
  const input = decisionSchema.safeParse(await req.json().catch(() => null));
  if (!input.success) return fail("invalid_request", "候选 ID 或审核内容无效。", 400, { requestId });
  const auth = await authorizeCandidateRequest(requestId, true);
  if (!auth.ok) return auth.response;
  const { ctx } = auth;
  const decision = input.data;
  try {
    const result = await decideCustomerMemoryCandidate(ctx, {
      contactId: decision.contact_id,
      candidateId: decision.candidate_id,
      decision: decision.decision,
      ...(decision.decision === "confirm" && decision.category ? { category: decision.category } : {}),
      ...(decision.decision === "confirm" && decision.body ? { body: decision.body } : {}),
    });
    await audit({
      action: decision.decision === "confirm" ? "ai.customer_memory_confirmed" : "ai.customer_memory_candidate_rejected",
      actorUserId: ctx.actorUserId,
      organizationId: ctx.organizationId,
      resourceType: result.fact_id ? "ai_customer_memories" : "ai_customer_memory_candidates",
      resourceId: result.fact_id ?? result.id,
      requestId,
    });
    return ok(result, { requestId });
  } catch (error) {
    return candidateFailure(error, requestId);
  }
}
