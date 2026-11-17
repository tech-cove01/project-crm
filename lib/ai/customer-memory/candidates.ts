import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { customerMemoryInput, saveCustomerMemoryInTransaction } from "@/lib/ai/integrations/mem0";
import type { createClient } from "@/lib/supabase/server";

const SOURCE_MESSAGE_LIMIT = 20;
const SOURCE_BODY_LIMIT = 2000;
const LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;
const CANDIDATE_LIMIT = 5;

export const customerMemoryCandidateCategory = customerMemoryInput.shape.category;
export const customerMemoryCandidateDraftSchema = z
  .object({
    category: customerMemoryCandidateCategory,
    body: customerMemoryInput.shape.body,
    message_id: z.uuid(),
    quote: z
      .string()
      .min(1)
      .max(240)
      .refine((value) => value.trim().length > 0),
  })
  .strict();
export type CustomerMemoryCandidateDraft = z.infer<typeof customerMemoryCandidateDraftSchema>;
type Category = z.infer<typeof customerMemoryCandidateCategory>;
type Status = "pending" | "confirmed" | "rejected";
type CandidateErrorCode =
  | "forbidden"
  | "contact_not_found"
  | "source_not_found"
  | "source_changed"
  | "candidate_not_found"
  | "decision_conflict"
  | "invalid_evidence";

export class CustomerMemoryCandidateError extends Error {
  constructor(
    readonly code: CandidateErrorCode,
    readonly status: 403 | 404 | 409 | 422,
  ) {
    super(code);
  }
}

export type CustomerMemoryCandidateContext = {
  pool: Pool;
  organizationId: string;
  actorUserId: string;
  sessionId: string;
};
type SourceScope = { organizationId: string; contactId: string; conversationId?: string | null };
type RequestDatabase = Pick<Awaited<ReturnType<typeof createClient>>, "from">;
type SourceMessage = { id: string; body: string; sent_at: string; edited_at: string | null };
type CurrentMessage = SourceMessage & { conversation_id: string };
type CandidateRow = {
  id: string;
  conversation_id: string;
  message_id: string;
  source_revision: string;
  quote_start: number;
  quote_end: number;
  category: Category;
  body: string;
  status: Status;
  fact_id: string | null;
  decision_hash: string | null;
};

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function sourceRevision(message: SourceMessage) {
  const edited = message.edited_at;
  // PostgREST and node-postgres use different UTC spellings for the same microsecond timestamp.
  const fraction = edited?.match(/:\d\d\.(\d+)/)?.[1] ?? "";
  const revision = edited
    ? new Date(edited).toISOString().slice(0, 19) + "." + fraction.padEnd(6, "0")
    : null;
  return digest([message.body, revision]);
}

function isBoundedSource(message: SourceMessage): boolean {
  return Boolean(message.body?.trim()) && message.body.length <= SOURCE_BODY_LIMIT;
}

/** Load one source with the request user's existing conversation and message RLS. */
export async function loadCustomerMemorySource(db: RequestDatabase, scope: SourceScope) {
  const { organizationId, contactId, conversationId } = scope;
  let query = db
    .from("conversations")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .eq("is_group", false);
  if (conversationId) query = query.eq("id", conversationId);
  const { data: conversation, error: conversationError } = await query
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (conversationError) throw conversationError;
  if (!conversation) {
    if (conversationId) throw new CustomerMemoryCandidateError("source_not_found", 404);
    return { conversationId: null, messages: [] as SourceMessage[] };
  }
  const now = Date.now();
  // Recheck the parent in the message query. Message RLS alone allows an
  // accessible conversation even when its contact or group status has changed.
  const { data: messages, error: messagesError } = await db
    .from("messages")
    .select("id,body,sent_at,edited_at,conversations!messages_conversation_id_fkey!inner(id)")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .eq("conversation_id", conversation.id)
    .eq("conversations.organization_id", organizationId)
    .eq("conversations.contact_id", contactId)
    .eq("conversations.is_group", false)
    .eq("direction", "inbound")
    .eq("type", "text")
    .is("revoked_at", null)
    .not("body", "is", null)
    .neq("body", "")
    .gte("sent_at", new Date(now - LOOKBACK_MS).toISOString())
    .lte("sent_at", new Date(now).toISOString())
    .order("sent_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(SOURCE_MESSAGE_LIMIT);
  if (messagesError) throw messagesError;
  return {
    conversationId: conversation.id as string,
    messages: ((messages as SourceMessage[]) ?? [])
      .filter(isBoundedSource)
      .reverse()
      .map(({ id, body, sent_at, edited_at }) => ({ id, body, sent_at, edited_at })),
  };
}

async function withCandidateAccess<T>(
  ctx: CustomerMemoryCandidateContext,
  contactId: string,
  action: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await ctx.pool.connect();
  const authority = [ctx.organizationId, ctx.actorUserId, ctx.sessionId];
  try {
    await client.query("begin");
    const membership = await client.query(
      `select u.user_id from user_organizations u
       join auth.sessions s on s.user_id=u.user_id
       where u.organization_id=$1 and u.user_id=$2 and s.id=$3
         and (s.not_after is null or s.not_after > now())
         and u.accepted_at is not null and u.revoked_at is null and u.role in ('manager','admin')
       for share of u, s`,
      authority,
    );
    if (!membership.rows[0]) throw new CustomerMemoryCandidateError("forbidden", 403);
    // Starting support locks the session row. Ending or changing it locks this support row.
    await client.query(
      `select id from platform_support_sessions
       where actor_user_id=$1 and auth_session_id=$2 and ended_at is null for share`,
      [ctx.actorUserId, ctx.sessionId],
    );
    const support = await client.query<{ allowed: boolean }>(
      "select public.fn_support_callback_write_allowed($1,$2,$3) as allowed",
      authority,
    );
    if (!support.rows[0]?.allowed) throw new CustomerMemoryCandidateError("forbidden", 403);
    const contact = await client.query(
      `select id from contacts
       where organization_id=$1 and id=$2 and not is_anonymized and is_merged_into is null for update`,
      [ctx.organizationId, contactId],
    );
    if (!contact.rows[0]) throw new CustomerMemoryCandidateError("contact_not_found", 404);
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

export function assertCustomerMemoryCandidateAccess(
  ctx: CustomerMemoryCandidateContext,
  contactId: string,
) {
  return withCandidateAccess(ctx, contactId, async () => {});
}

async function readCurrentMessages(
  client: PoolClient,
  organizationId: string,
  contactId: string,
  ids: string[],
  lock = false,
) {
  const { rows } = await client.query<CurrentMessage>(
    `select m.id,m.conversation_id,m.body,m.sent_at::text,
            to_char(m.edited_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as edited_at
      from messages m join conversations c
        on c.id=m.conversation_id and c.organization_id=m.organization_id and c.contact_id=m.contact_id
      where m.organization_id=$1 and m.contact_id=$2 and m.id=any($3::uuid[])
        and not c.is_group and m.direction='inbound' and m.type='text' and m.revoked_at is null
        and char_length(m.body) between 1 and $4
      ${lock ? "for share of c, m" : ""}`,
    [organizationId, contactId, ids, SOURCE_BODY_LIMIT],
  );
  return new Map(rows.filter(isBoundedSource).map((row) => [row.id, row]));
}

function sourceFor(row: CandidateRow, message: CurrentMessage | undefined) {
  if (
    message?.conversation_id !== row.conversation_id ||
    sourceRevision(message) !== row.source_revision ||
    row.quote_end > message.body.length
  )
    return null;
  return {
    message_id: message.id,
    quote: message.body.slice(row.quote_start, row.quote_end),
    sent_at: new Date(message.sent_at).toISOString(),
  };
}

function candidateView(row: CandidateRow, message: CurrentMessage | undefined) {
  const source = row.status === "pending" ? sourceFor(row, message) : null;
  return {
    id: row.id,
    category: row.category,
    body: source ? row.body : "",
    status: row.status,
    source,
    fact_id: row.fact_id,
  };
}

const COLUMNS =
  "id,conversation_id,message_id,source_revision,quote_start,quote_end,category,body,status,fact_id,decision_hash";

export function listCustomerMemoryCandidates(
  ctx: CustomerMemoryCandidateContext,
  contactId: string,
) {
  const scope = [ctx.organizationId, contactId];
  return withCandidateAccess(ctx, contactId, async (client) => {
    const conversation = await client.query<{ id: string }>(
      `select id from conversations where organization_id=$1 and contact_id=$2 and not is_group
       order by last_message_at desc nulls last,id desc limit 1`,
      scope,
    );
    const { rows } = await client.query<CandidateRow>(
      `select ${COLUMNS} from ai_customer_memory_candidates
       where organization_id=$1 and contact_id=$2 and status='pending'
       order by created_at desc,id desc limit 50`,
      scope,
    );
    const sources = await readCurrentMessages(
      client,
      ctx.organizationId,
      contactId,
      rows.map((row) => row.message_id),
    );
    return {
      conversation_id: conversation.rows[0]?.id ?? null,
      candidates: rows.map((row) => candidateView(row, sources.get(row.message_id))),
    };
  });
}

type SaveCandidatesInput = {
  contactId: string;
  conversationId: string;
  messages: SourceMessage[];
  candidates: CustomerMemoryCandidateDraft[];
};

export function saveCustomerMemoryCandidates(
  ctx: CustomerMemoryCandidateContext,
  input: SaveCandidatesInput,
) {
  const { contactId, conversationId } = input;
  const drafts = z
    .array(customerMemoryCandidateDraftSchema)
    .max(CANDIDATE_LIMIT)
    .safeParse(input.candidates);
  if (!drafts.success) throw new CustomerMemoryCandidateError("invalid_evidence", 422);
  const received = new Map(
    input.messages.filter(isBoundedSource).map((message) => [message.id, message]),
  );
  return withCandidateAccess(ctx, contactId, async (client) => {
    const ids = drafts.data.map((draft) => draft.message_id);
    const current = await readCurrentMessages(client, ctx.organizationId, contactId, ids, true);
    const candidates = [];
    const seen = new Set<string>();
    for (const draft of drafts.data) {
      const observed = received.get(draft.message_id);
      const start = observed?.body.indexOf(draft.quote) ?? -1;
      if (!observed || start < 0) throw new CustomerMemoryCandidateError("invalid_evidence", 422);
      const message = current.get(draft.message_id);
      const revision = sourceRevision(observed);
      if (
        !message ||
        message.conversation_id !== conversationId ||
        sourceRevision(message) !== revision
      )
        throw new CustomerMemoryCandidateError("source_changed", 409);
      const key = digest([conversationId, message.id, revision, draft.category, draft.body]);
      if (seen.has(key)) continue;
      seen.add(key);
      const values = [
        ctx.organizationId,
        contactId,
        conversationId,
        message.id,
        revision,
        start,
        start + draft.quote.length,
        draft.category,
        draft.body,
        key,
      ];
      const inserted = await client.query<CandidateRow>(
        `insert into ai_customer_memory_candidates
         (organization_id,contact_id,conversation_id,message_id,source_revision,quote_start,quote_end,category,body,extraction_key)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict (organization_id,contact_id,extraction_key) do nothing returning ${COLUMNS}`,
        values,
      );
      const row =
        inserted.rows[0] ??
        (
          await client.query<CandidateRow>(
            `select ${COLUMNS} from ai_customer_memory_candidates
         where organization_id=$1 and contact_id=$2 and extraction_key=$3`,
            [ctx.organizationId, contactId, key],
          )
        ).rows[0];
      if (!row) throw new Error("customer_memory_candidate_missing_after_save");
      candidates.push(candidateView(row, message));
    }
    return { conversation_id: conversationId, candidates };
  });
}

type DecideCandidateInput = {
  contactId: string;
  candidateId: string;
  decision: "confirm" | "reject";
  category?: Category;
  body?: string;
};

export function decideCustomerMemoryCandidate(
  ctx: CustomerMemoryCandidateContext,
  input: DecideCandidateInput,
) {
  const scope = [ctx.organizationId, input.contactId, input.candidateId];
  return withCandidateAccess(ctx, input.contactId, async (client) => {
    const {
      rows: [row],
    } = await client.query<CandidateRow>(
      `select ${COLUMNS} from ai_customer_memory_candidates
       where organization_id=$1 and contact_id=$2 and id=$3 for update`,
      scope,
    );
    if (!row) throw new CustomerMemoryCandidateError("candidate_not_found", 404);
    const category = input.category ?? row.category;
    const body = input.body?.trim() ?? row.body;
    const decisionHash = digest(
      input.decision === "confirm" ? ["confirm", category, body] : ["reject"],
    );
    if (row.status !== "pending") {
      if (row.decision_hash !== decisionHash)
        throw new CustomerMemoryCandidateError("decision_conflict", 409);
      return candidateView(row, undefined);
    }

    const confirmNow = input.decision === "confirm";
    let factId: string | null = null;
    if (confirmNow) {
      const sources = await readCurrentMessages(
        client,
        ctx.organizationId,
        input.contactId,
        [row.message_id],
        true,
      );
      const message = sources.get(row.message_id);
      if (!sourceFor(row, message)) throw new CustomerMemoryCandidateError("source_changed", 409);
      try {
        const memory = await saveCustomerMemoryInTransaction(
          client,
          ctx.organizationId,
          ctx.actorUserId,
          {
            contact_id: input.contactId,
            request_key: row.id,
            category,
            body,
            confirmed: true,
          },
          { requireNew: true },
        );
        factId = memory.id;
      } catch (error) {
        if (error instanceof Error && error.message === "customer_memory_idempotency_conflict")
          throw new CustomerMemoryCandidateError("decision_conflict", 409);
        throw error;
      }
    }
    const {
      rows: [decided],
    } = await client.query<CandidateRow>(
      `update ai_customer_memory_candidates
       set status=$4,fact_id=$5,decision_hash=$6,decided_by=$7,decided_at=now()
       where organization_id=$1 and contact_id=$2 and id=$3 returning ${COLUMNS}`,
      [...scope, confirmNow ? "confirmed" : "rejected", factId, decisionHash, ctx.actorUserId],
    );
    if (!decided) throw new Error("customer_memory_candidate_missing_after_decision");
    return candidateView(decided, undefined);
  });
}
