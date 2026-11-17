import { createClient } from "@supabase/supabase-js";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  decideCustomerMemoryCandidate,
  listCustomerMemoryCandidates,
  loadCustomerMemorySource,
  saveCustomerMemoryCandidates,
  type CustomerMemoryCandidateContext,
  type CustomerMemoryCandidateDraft,
} from "./candidates";

const contactId = "10000000-0000-4000-8000-000000000001";
const conversationId = "10000000-0000-4000-8000-000000000002";
const messageId = "10000000-0000-4000-8000-000000000003";
const organizationId = "10000000-0000-4000-8000-000000000004";
const candidateId = "10000000-0000-4000-8000-000000000007";
const body = "🚲 下次请安排周四上午联系。";
const observed = {
  id: messageId,
  body,
  sent_at: "2026-11-17T01:00:00.000Z",
  edited_at: "2026-11-17T06:00:00.123450+05:00",
};
const draft: CustomerMemoryCandidateDraft = {
  category: "preference",
  body: "客户希望周四上午联系",
  message_id: messageId,
  quote: "周四上午",
};

function candidateDatabase(
  currentEditedAt = "2026-11-17T01:00:00.123450Z",
  customResult?: (sql: string) => { rows: unknown[] } | undefined,
) {
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    const custom = customResult?.(sql);
    if (custom) return custom;
    if (sql.includes("from user_organizations")) return { rows: [{ user_id: "member" }] };
    if (sql.includes("fn_support_callback_write_allowed")) return { rows: [{ allowed: true }] };
    if (sql.includes("from contacts")) return { rows: [{ id: contactId }] };
    if (sql.includes("from messages")) {
      return {
        rows: [{ ...observed, conversation_id: conversationId, edited_at: currentEditedAt }],
      };
    }
    if (sql.includes("insert into ai_customer_memory_candidates")) {
      if (!values) throw new Error("Expected candidate params");
      return {
        rows: [
          {
            id: "new-candidate",
            conversation_id: values[2],
            message_id: values[3],
            source_revision: values[4],
            quote_start: values[5],
            quote_end: values[6],
            category: values[7],
            body: values[8],
            status: "pending",
            fact_id: null,
            decision_hash: null,
          },
        ],
      };
    }
    return { rows: [] };
  });
  const ctx: CustomerMemoryCandidateContext = {
    pool: { connect: async () => ({ query, release: vi.fn() }) } as unknown as Pool,
    organizationId,
    actorUserId: "10000000-0000-4000-8000-000000000005",
    sessionId: "10000000-0000-4000-8000-000000000006",
  };
  const save = (candidate: CustomerMemoryCandidateDraft) =>
    saveCustomerMemoryCandidates(ctx, {
      contactId,
      conversationId,
      messages: [observed],
      candidates: [candidate],
    });
  return { ctx, query, save };
}

describe("customer memory candidate source proofs", () => {
  it("keeps messages out of extraction after the conversation becomes a group", async () => {
    let isGroup = false;
    const fetch = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/conversations")) {
        expect(isGroup).toBe(false);
        isGroup = true;
        return Response.json([{ id: conversationId }]);
      }
      expect(url.pathname).toBe("/rest/v1/messages");
      expect(url.searchParams.get("select")).toContain(
        "conversations!messages_conversation_id_fkey!inner(id)",
      );
      expect(url.searchParams.get("conversations.organization_id")).toBe(`eq.${organizationId}`);
      expect(url.searchParams.get("conversations.contact_id")).toBe(`eq.${contactId}`);
      expect(url.searchParams.get("conversations.is_group")).toBe("eq.false");
      return Response.json(isGroup ? [] : [observed]);
    });
    const db = createClient("http://127.0.0.1:54321", "synthetic", {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { fetch },
    });
    await expect(
      loadCustomerMemorySource(db, { organizationId, contactId, conversationId }),
    ).resolves.toEqual({ conversationId, messages: [] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("filters candidates to pending before applying the review list limit", async () => {
    const { ctx, query } = candidateDatabase();
    await expect(listCustomerMemoryCandidates(ctx, contactId)).resolves.toMatchObject({
      candidates: [],
    });
    const list = query.mock.calls.find(([sql]) =>
      sql.includes("from ai_customer_memory_candidates"),
    );
    expect(list?.[0]).toMatch(/and status='pending'\s+order by .* limit 50/);
  });

  it("returns only a decision receipt and does not read the source when rejecting", async () => {
    const pending = {
      id: candidateId,
      conversation_id: conversationId,
      message_id: messageId,
      category: draft.category,
      body: draft.body,
      status: "pending",
      fact_id: null,
    };
    const { ctx, query } = candidateDatabase(undefined, (sql) => {
      if (sql.includes("from ai_customer_memory_candidates")) return { rows: [pending] };
      if (sql.includes("update ai_customer_memory_candidates")) {
        return { rows: [{ ...pending, status: "rejected" }] };
      }
    });
    await expect(
      decideCustomerMemoryCandidate(ctx, { contactId, candidateId, decision: "reject" }),
    ).resolves.toEqual({
      id: candidateId,
      category: draft.category,
      status: "rejected",
      fact_id: null,
      body: "",
      source: null,
    });
    expect(query.mock.calls.map(([sql]) => sql).join("\n")).not.toMatch(
      /from messages|insert into (ai_customer_memories|event_log)\b/,
    );
  });

  it("preserves a literal quote across a UTF-16 prefix and different UTC spellings", async () => {
    const { query, save } = candidateDatabase();
    await expect(save(draft)).resolves.toEqual({
      conversation_id: conversationId,
      candidates: [
        {
          id: "new-candidate",
          category: draft.category,
          body: draft.body,
          status: "pending",
          source: { message_id: messageId, quote: draft.quote, sent_at: observed.sent_at },
          fact_id: null,
        },
      ],
    });
    expect(query.mock.calls.map(([sql]) => sql).join("\n")).not.toMatch(
      /insert into (ai_customer_memories|event_log)\b/,
    );
  });

  it.each([
    { candidate: { ...draft, quote: "周五上午" }, revision: undefined, code: "invalid_evidence" },
    { candidate: draft, revision: "2026-11-17T01:00:00.123451Z", code: "source_changed" },
    {
      candidate: { ...draft, message_id: conversationId },
      revision: undefined,
      code: "invalid_evidence",
    },
  ])(
    "rejects $code without persisting candidate or fact",
    async ({ candidate, revision, code }) => {
      const { query, save } = candidateDatabase(revision);
      await expect(save(candidate)).rejects.toMatchObject({ code });
      expect(query.mock.calls.map(([sql]) => sql).join("\n")).not.toMatch(/\binsert into\b/);
      expect(query).toHaveBeenLastCalledWith("rollback");
    },
  );
});
