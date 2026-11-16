import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Arm, MemoryContact } from "./crm022-memory-cases";

export const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const defaultMemoryQuery = "Customer preferences and confirmed communication context";
export const subjectScope = (org: string, contact: string) => digest(`crm-customer:v1:${org}:${contact}`);
const remoteScope = (org: string, memory: string) => digest(`crm-memory:v1:${org}:${memory}`);

export function requireCheck(condition: unknown, code: string): asserts condition {
  if (!condition) throw Object.assign(new Error(code), { code });
}

function fixtureId(seed: string) {
  const h = digest(seed);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function bodyHash(contact: string, category: string, body: string) {
  return digest(JSON.stringify({ contact, category, body }));
}

type FixtureRow = {
  key: string;
  id: string;
  category: string;
  body: string;
  originalRevision: string;
  revision: string;
  deleted: boolean;
  externalId?: string;
};

export type ContactFixture = {
  id: string;
  label: string;
  rows: FixtureRow[];
  subject: string;
};

type SearchHit = { id: string; userId: string; runId: string | null; revision: string | null };
type TransportEntry = { phase: string; method: string; path: string; status: number | null; elapsedMs: number; injected: boolean };

export class MemoryFixtureStore {
  readonly fixtures = new Map<string, ContactFixture>();
  readonly transport: TransportEntry[] = [];
  readonly cleanup: { id: string; externalId: string | null; outcome: string }[] = [];
  readonly #nativeFetch = globalThis.fetch;
  readonly #pool: Pool;
  readonly #observedRemoteIds = new Set<string>();
  readonly #attemptedProjectionIds = new Set<string>();
  #remoteHits: SearchHit[] = [];

  constructor(
    readonly client: PoolClient,
    readonly org: string,
    readonly origin: string,
    readonly mem0Key: string,
    readonly batchId: string,
    readonly maxTransportRequests: number,
  ) {
    // The existing adapter only calls query. A single client keeps evaluation rows transaction-scoped.
    this.#pool = { query: client.query.bind(client) } as unknown as Pool;
  }

  get binding() {
    return JSON.stringify([{ organization_id: this.org, provider: "mem0", base_url: this.origin, api_key: this.mem0Key }]);
  }

  async seed(contacts: MemoryContact[]) {
    for (const contact of contacts) {
      const id = fixtureId(`${this.batchId}/${contact.key}`);
      const subject = subjectScope(this.org, id);
      const label = `crm022-memory-synthetic-${this.batchId.slice(0, 8)}-${contact.key}`;
      const created = await this.client.query("insert into contacts(id,organization_id,name) values($1,$2,$3) returning id", [id, this.org, label]);
      requireCheck(created.rowCount === 1, "fixture_contact_insert_failed");
      const rows: FixtureRow[] = [];
      for (const [i, data] of contact.facts.entries()) {
        const memoryId = fixtureId(`${this.batchId}/${contact.key}/${data.key}`);
        const occurredAt = new Date(Date.UTC(2026, 8, 1, 12, 0, i)).toISOString();
        const revision = bodyHash(id, data.category, data.body);
        const saved = await this.client.query(
          `insert into ai_customer_memories(id,organization_id,contact_id,subject_key,request_key,category,body,content_hash,created_at,updated_at)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) returning id`,
          [memoryId, this.org, id, subject, fixtureId(`${memoryId}/request`), data.category, data.body, revision, occurredAt],
        );
        requireCheck(saved.rowCount === 1, "fixture_memory_insert_failed");
        rows.push({ ...data, id: memoryId, revision, originalRevision: revision, deleted: false });
      }
      this.fixtures.set(contact.key, { id, label, rows, subject });
    }
  }

  #mem0Fetch(fixture: ContactFixture, phase: "sync" | "search" | "outage" | "cleanup", row?: FixtureRow): typeof fetch {
    return async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      requireCheck(url.origin === this.origin && headers.get("X-API-Key") === this.mem0Key, "mem0_destination_rejected");
      const expectedScope = row ? remoteScope(this.org, row.id) : null;
      const kind = url.pathname;
      if (phase === "search" || phase === "outage") {
        const data = JSON.parse(String(init?.body));
        requireCheck(method === "POST" && kind === "/search" && !url.search &&
          data.query === defaultMemoryQuery && data.top_k === 10 && data.filters?.user_id === fixture.subject &&
          Object.keys(data.filters).length === 1, "mem0_search_scope_rejected");
      } else if (kind === "/openapi.json") {
        requireCheck(phase === "sync" && method === "GET" && !url.search, "mem0_protocol_scope_rejected");
      } else if (kind === "/memories" && method === "GET") {
        requireCheck(expectedScope && url.searchParams.get("user_id") === fixture.subject &&
          url.searchParams.get("run_id") === expectedScope && url.searchParams.get("top_k") === "1000" &&
          [...url.searchParams].length === 3, "mem0_lookup_scope_rejected");
      } else if (kind === "/memories" && method === "POST" && phase === "sync") {
        const data = JSON.parse(String(init?.body));
        requireCheck(!url.search && row && data.user_id === fixture.subject && data.run_id === expectedScope && data.infer === false &&
          data.metadata?.crm_id === expectedScope && data.metadata?.crm_hash === row.originalRevision &&
          data.metadata?.crm_category === row.category && data.messages.length === 1 &&
          data.messages[0]?.role === "user" && data.messages[0].content === row.body, "mem0_projection_scope_rejected");
      } else if (phase === "cleanup" && kind.startsWith("/memories/") && method === "DELETE") {
        requireCheck(row?.externalId && kind === `/memories/${encodeURIComponent(row.externalId)}` && !url.search &&
          this.#observedRemoteIds.has(row.externalId), "mem0_delete_scope_rejected");
      } else {
        requireCheck(false, "mem0_request_rejected");
      }
      requireCheck(this.transport.length < this.maxTransportRequests, "mem0_request_budget_exceeded");
      const started = performance.now();
      const event: TransportEntry = { phase, method, path: kind.startsWith("/memories/") ? "/memories/:id" : kind,
        status: null, elapsedMs: 0, injected: phase === "outage" };
      this.transport.push(event);
      try {
        if (phase === "outage") throw new TypeError("crm022_intentional_adapter_transport_failure");
        const result = await this.#nativeFetch(input, { ...init, redirect: "error" });
        event.status = result.status;
        if (kind === "/search" && result.ok) {
          const text = await result.clone().text();
          requireCheck(text.length <= 1_000_000, "mem0_search_response_too_large");
          const data = JSON.parse(text);
          requireCheck(Array.isArray(data.results) && data.results.length <= 100, "mem0_search_shape_invalid");
          this.#remoteHits = data.results.map((hit: Record<string, unknown>) => {
            const metadata = hit.metadata as { crm_hash?: string } | undefined;
            return { id: String(hit.id), userId: String(hit.user_id), runId: typeof hit.run_id === "string" ? hit.run_id : null,
              revision: typeof metadata?.crm_hash === "string" ? metadata.crm_hash : null };
          });
        }
        return result;
      } finally {
        event.elapsedMs = performance.now() - started;
      }
    };
  }

  async project() {
    const { syncCustomerMemory } = await import("@/lib/ai/integrations/mem0");
    for (const fixture of this.fixtures.values()) {
      for (const row of fixture.rows) {
        this.#attemptedProjectionIds.add(row.id);
        const status = await syncCustomerMemory(this.#pool, this.org, row.id, this.#mem0Fetch(fixture, "sync", row));
        requireCheck(status === "synced", "mem0_projection_not_synced");
        const saved = await this.client.query("select external_id,write_outcome from ai_customer_memories where organization_id=$1 and id=$2", [this.org, row.id]);
        requireCheck(saved.rows.length === 1 && typeof saved.rows[0]?.external_id === "string" && saved.rows[0].write_outcome === "confirmed", "mem0_projection_receipt_missing");
        row.externalId = saved.rows[0].external_id;
        this.#observedRemoteIds.add(row.externalId!);
      }
    }
  }

  async mutate(contacts: MemoryContact[]) {
    for (const contact of contacts) {
      if (!contact.mutation) continue;
      const fixture = this.fixtures.get(contact.key);
      const row = fixture?.rows.find(row => row.key === contact.mutation!.key);
      requireCheck(fixture && row?.externalId, "mutation_requires_verified_remote_projection");
      if (contact.mutation.kind === "revise") {
        const body = contact.mutation.currentBody;
        const revision = bodyHash(fixture.id, row.category, body);
        const updated = await this.client.query(
          "update ai_customer_memories set body=$3,content_hash=$4,updated_at=now() where organization_id=$1 and id=$2 and content_hash=$5 and deleted_at is null returning id",
          [this.org, row.id, body, revision, row.originalRevision],
        );
        requireCheck(updated.rowCount === 1, "isolated_revision_conflict");
        row.body = body;
        row.revision = revision;
      } else {
        const updated = await this.client.query(
          "update ai_customer_memories set body='',sync_state='deleted',deleted_at=now(),updated_at=now() where organization_id=$1 and id=$2 and content_hash=$3 and deleted_at is null returning id",
          [this.org, row.id, row.originalRevision],
        );
        requireCheck(updated.rowCount === 1, "isolated_tombstone_conflict");
        row.deleted = true;
      }
    }
  }

  async read(fixture: ContactFixture, arm: Arm, outage = false) {
    const start = performance.now();
    const firstTransport = this.transport.length;
    if (arm === "none") return { status: "omitted", providerStatus: "not_called", coverage: null, readLimit: null,
      memories: [], remoteHits: [], durationMs: performance.now() - start };
    const { readConfirmedCustomerMemory } = await import("@/lib/ai/integrations/mem0");
    const previousFetch = globalThis.fetch;
    const previousBindings = process.env.AI_INTEGRATION_BINDINGS;
    let attemptedSearch = false;
    this.#remoteHits = [];
    try {
      process.env.AI_INTEGRATION_BINDINGS = arm === "sql10" ? "[]" : this.binding;
      const transport = this.#mem0Fetch(fixture, outage ? "outage" : "search");
      globalThis.fetch = (input, init) => {
        requireCheck(arm === "mem0_10" && !attemptedSearch, "unexpected_memory_retrieval_request");
        attemptedSearch = true;
        return transport(input, init);
      };
      const result = await readConfirmedCustomerMemory(this.#pool, this.org, fixture.id);
      const candidates = fixture.rows.filter(row => !row.deleted).slice().reverse().slice(0, 50);
      requireCheck(result.readLimit === 50 && result.returnedCount === Math.min(10, candidates.length) &&
        new Set(result.memories.map(row => row.id)).size === result.memories.length && result.memories.every(memory =>
          candidates.some(row => row.id === memory.id && row.revision === memory.revision && row.body === memory.body) && memory.confirmed), "memory_read_projection_scope_changed");
      if (arm === "sql10" || outage) requireCheck(result.memories.every((row, i) => row.id === candidates[i]?.id), "sql_recent_order_changed");
      if (arm === "sql10") requireCheck(result.providerStatus === "disabled" && !attemptedSearch, "sql_arm_not_local");
      if (outage) requireCheck(result.providerStatus === "unavailable" && result.status === "local_fallback" && attemptedSearch, "outage_fallback_not_observed");
      if (arm === "mem0_10" && !outage) requireCheck(result.providerStatus === "connected" && attemptedSearch &&
        this.transport.slice(firstTransport).length === 1 && this.transport[firstTransport]?.status === 200, "live_mem0_search_not_connected");
      const remoteHits = this.#remoteHits.map(hit => {
        const row = fixture.rows.find(row => row.externalId === hit.id);
        requireCheck(row && hit.userId === fixture.subject && hit.runId === remoteScope(this.org, row.id), "unexpected_remote_memory_scope");
        return { id: row.id, projectedRevision: hit.revision, currentRevision: row.revision, deleted: row.deleted,
          insideSql50: candidates.some(candidate => candidate.id === row.id) };
      });
      return { ...result, remoteHits, durationMs: performance.now() - start };
    } finally {
      globalThis.fetch = previousFetch;
      if (previousBindings === undefined) delete process.env.AI_INTEGRATION_BINDINGS;
      else process.env.AI_INTEGRATION_BINDINGS = previousBindings;
    }
  }

  async removeProjections() {
    const { syncCustomerMemory } = await import("@/lib/ai/integrations/mem0");
    for (const fixture of this.fixtures.values()) {
      for (const row of fixture.rows) {
        if (!this.#attemptedProjectionIds.has(row.id)) continue;
        if (!row.externalId) {
          this.cleanup.push({ id: row.id, externalId: null, outcome: "verification_required_no_confirmed_receipt" });
          continue;
        }
        try {
          // Restore the frozen projection hash for ownership verification inside the rollback-only transaction.
          const retired = await this.client.query(
            "update ai_customer_memories set body='',content_hash=$3,sync_state='deleted',deleted_at=coalesce(deleted_at,now()) where organization_id=$1 and id=$2 and external_id=$4 returning id",
            [this.org, row.id, row.originalRevision, row.externalId],
          );
          requireCheck(retired.rowCount === 1, "cleanup_receipt_scope_changed");
          const outcome = await syncCustomerMemory(this.#pool, this.org, row.id, this.#mem0Fetch(fixture, "cleanup", row));
          this.cleanup.push({ id: row.id, externalId: row.externalId, outcome });
        } catch {
          this.cleanup.push({ id: row.id, externalId: row.externalId, outcome: "verification_required" });
        }
      }
    }
  }
}
