/** No Agent generation. Real read adapter, owned confirmations and reversible probes. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { digest, optional, seal, uuid } from './crm024-fixtures.mjs';
import { memoryTransport } from './crm026-memory-environment.mjs';

const MEMORY = '/api/v1/ai/customer-memory';
const probeBody = '合成预检客户已确认：校对目录采用灰底版本。';

async function stage(path, fixtureHash, action) {
  const previous = await optional(path);
  if (previous) {
    assert(previous.fixtureHash === fixtureHash, 'crm026_memory_probe_stage_changed');
    return previous.data;
  }
  const data = await action();
  await seal(path, { fixtureHash, data }, false);
  return data;
}

async function checkFallback(pool, readMemory, slot, contactId) {
  const attempted = [];
  const server = createServer((req, res) => {
    attempted.push({ method: req.method, path: req.url });
    res.writeHead(503, { 'Content-Type': 'application/json' }).end('{}');
  });
  await new Promise((ok, fail) => server.once('error', fail).listen(0, '127.0.0.1', ok));
  const original = process.env.AI_INTEGRATION_BINDINGS;
  try {
    const records = JSON.parse(original);
    const binding = records.find(row => row.organization_id === slot.organizationId && row.provider === 'mem0');
    assert(binding, 'crm026_memory_probe_missing_provider');
    binding.base_url = `http://127.0.0.1:${server.address().port}`;
    process.env.AI_INTEGRATION_BINDINGS = JSON.stringify(records);
    const fallback = await readMemory(pool, slot.organizationId, contactId);
    assert(fallback.status === 'local_fallback' && fallback.coverage === 'complete' &&
      fallback.memories.length === 1 && fallback.memories[0].body === probeBody &&
      attempted.length === 1 && attempted[0].path === '/search', 'crm026_memory_fallback_contract');
    return { fallback, attempted };
  } finally {
    process.env.AI_INTEGRATION_BINDINGS = original;
    await new Promise((ok, fail) => server.close(error => error ? fail(error) : ok()));
  }
}

async function checkWindow(pool, readMemory, slot) {
  const client = await pool.connect();
  const contactId = slot.decoys['window-probe'];
  try {
    await client.query('begin');
    const tags = Array.from({ length: 51 }, (_, index) => `选择边界探针 ${index + 1}`);
    const { rows } = await client.query(`insert into ai_customer_memories(organization_id,contact_id,request_key,category,
      body,content_hash,confirmed_by,subject_key,created_at)
      select $1,$2,gen_random_uuid(),'confirmed_fact',ord.body,ord.hash,$3,$4,
      now()-(ord.n||' seconds')::interval
      from unnest($5::text[],$6::text[]) with ordinality as ord(body,hash,n)
      returning id,body`, [slot.organizationId, contactId, slot.actorUserId,
      digest(`crm-customer:v1:${slot.organizationId}:${contactId}`), tags, tags.map(digest)]);
    assert(rows.length === 51, 'crm026_memory_window_fixture_incomplete');
    const queries = [];
    const observed = await readMemory({ async query(config) {
      const result = await client.query(config);
      if (/order by created_at desc limit 50/i.test(config.text))
        queries.push({ sql: config.text, selected: result.rows.map(row => row.id) });
      return result;
    } },
      slot.organizationId, contactId);
    const rank50 = rows.find(row => row.body === tags[49]);
    const rank51 = rows.find(row => row.body === tags[50]);
    assert(observed.status === 'local' && observed.coverage === 'partial' && observed.readLimit === 50 &&
      observed.memories.length === 10 && observed.memories.every((row, index) => row.body === tags[index]) &&
      queries.length === 2 && queries.every(query => query.selected.length === 50 &&
        query.selected.includes(rank50.id) && !query.selected.includes(rank51.id)), 'crm026_memory_window_contract');
    return { fixtureRows: rows.length, persisted: false, newest: observed.memories.length, declaredReadLimit: observed.readLimit,
      coverage: observed.coverage, outerWindowCandidates: [rank50.id, rank51.id], queries };
  } finally {
    try { await client.query('rollback'); } finally { client.release(); }
  }
}

export async function checkMemoryProbes(c, artifact, flushMem0, transaction) {
  const previous = await optional(artifact);
  if (previous) {
    assert(previous.fixtureHash === c.fixtureHash && previous.generatedRoots === 0, 'crm026_memory_probe_changed');
    return previous;
  }
  process.env.AI_INTEGRATION_BINDINGS = c.env.AI_INTEGRATION_BINDINGS;
  const { readConfirmedCustomerMemory: readMemory } = await import('../../lib/ai/integrations/mem0.ts');
  const pool = new pg.Pool({ connectionString: c.env.SUPABASE_DB_URL, max: 2, connectionTimeoutMillis: 5000 });
  const results = [];
  try {
    for (const arm of ['none', 'sql', 'mem0']) {
      const slot = c.fixture.slots[`A1.${arm}`];
      const contactId = slot.decoys['window-probe'];
      const recordStep = (name, action) => stage(`${artifact}.${arm}-${name}.json`, c.fixtureHash, action);
      const empty = await recordStep('before', () => readMemory(pool, slot.organizationId, contactId));
      assert(empty.status === (arm === 'mem0' ? 'mem0' : 'local') && empty.coverage === 'complete' &&
        empty.memories.length === 0, 'crm026_memory_initial_adapter_state');
      if (arm === 'none') {
        results.push({ arm, empty });
        continue;
      }
      const requestKey = await recordStep('intent', () => randomUUID());
      const proof = await recordStep('confirm', async () => {
        const { rows } = await pool.query('select id,body from ai_customer_memories where organization_id=$1 and contact_id=$2 and request_key=$3',
          [slot.organizationId, contactId, requestKey]);
        if (rows.length === 1) {
          assert(rows[0].body === probeBody, 'crm026_memory_probe_confirm_mismatch');
          return { httpStatus: null, data: { id: rows[0].id }, recoveredFromOriginalRequest: true };
        }
        return memoryTransport(c, slot, request => request(MEMORY, 'POST', {
          contact_id: contactId, request_key: requestKey, category: 'confirmed_fact', body: probeBody, confirmed: true,
        }));
      });
      assert((proof.httpStatus === 200 || proof.recoveredFromOriginalRequest) && uuid.test(proof.data?.id ?? ''), 'crm026_memory_probe_confirm_failed');
      const memoryId = proof.data.id;
      const sync = await flushMem0(c, slot, [memoryId], 'preflight-confirm');
      const confirmed = await recordStep('current', () => readMemory(pool, slot.organizationId, contactId));
      assert(confirmed.status === (arm === 'mem0' ? 'mem0' : 'local') && confirmed.coverage === 'complete' &&
        confirmed.memories.length === 1 && confirmed.memories[0].id === memoryId &&
        confirmed.memories[0].body === probeBody, 'crm026_memory_probe_confirmation_not_visible');
      const fallback = arm === 'mem0' ? await recordStep('fallback', () => checkFallback(pool, readMemory, slot, contactId)) : null;
      const withdrawal = await recordStep('withdraw', async () => {
        const { rows } = await pool.query('select deleted_at from ai_customer_memories where organization_id=$1 and contact_id=$2 and id=$3',
          [slot.organizationId, contactId, memoryId]);
        if (rows[0]?.deleted_at) return { httpStatus: null, data: { hidden: true }, recoveredFromOriginalRequest: true };
        return memoryTransport(c, slot, request => request(MEMORY, 'DELETE', { id: memoryId }));
      });
      assert((withdrawal.httpStatus === 200 || withdrawal.recoveredFromOriginalRequest) && withdrawal.data?.hidden === true,
        'crm026_memory_probe_withdrawal_failed');
      const deletionSync = await flushMem0(c, slot, [memoryId], 'preflight-withdraw');
      const after = await recordStep('after', () => readMemory(pool, slot.organizationId, contactId));
      assert(after.memories.length === 0 && after.status === confirmed.status, 'crm026_memory_probe_stale_value');
      const count = await transaction(c, true, q => q(`select
        (select count(*)::int from ai_workbench_runs where organization_id=$1) roots,
        (select count(*)::int from llm_calls where organization_id=$1) generation`, [slot.organizationId]));
      assert(count[0].roots === 0 && count[0].generation === 0, 'crm026_preflight_generated_model');
      results.push({ arm, empty, proof, sync, confirmed, fallback, withdrawal, deletionSync, after });
    }
    const window = await checkWindow(pool, readMemory, c.fixture.slots['A1.sql']);
    const value = { fixtureHash: c.fixtureHash, results, window, generatedRoots: 0,
      embedding: { liveSearches: 3, faultInjectedSearches: 1, synchronizedFacts: 1, verifiedRemoteDeletions: 1, tokens: null } };
    await seal(artifact, value, false);
    return value;
  } finally {
    await pool.end();
  }
}
