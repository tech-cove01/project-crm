/** Settle only the confirmed facts owned by the closed CRM-026 evaluation. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { createServerClient } from '@supabase/ssr';
import { digest, optional, read, sha, uuid } from './crm024-fixtures.mjs';
import { MEMORY_ROOT, loadMemoryEnvironment, memoryTransaction, memoryTransport } from './crm026-memory-environment.mjs';
import { MEM0, WEB, seal } from './crm026-memory-environment-config.mjs';
import { GENERALIZATION_FILES } from './crm026-generalization-environment.mjs';
import { readMemorySlot } from './crm026-memory-run.mjs';
import { readGeneralizationSlot } from './crm026-generalization-run.mjs';

const OUTPUT = resolve(MEMORY_ROOT, 'cleanup');
const PLAN = resolve(OUTPUT, 'plan.json');
const FINAL = resolve(OUTPUT, 'settled.json');
const EXECUTION_INDEX = resolve(MEMORY_ROOT, '../final-execution-index.json');
const FREEZE = resolve(MEMORY_ROOT, 'freeze.json');
const MEMORY = '/api/v1/ai/customer-memory';
const SYNC = 'ai_integration.mem0_sync';
const SYNC_CONSUMER = 'ai_integration.mem0_v1';
const ROUTING = 'conversation.routing_requested';
const now = () => new Date().toISOString();
const subjectKey = (org, contact) => digest(`crm-customer:v1:${org}:${contact}`);
const identity = ({ id, organization_id, contact_id, request_key, subject_key, confirmed_by, content_hash }) =>
  ({ id, organization_id, contact_id, request_key, subject_key, confirmed_by, content_hash });

export function cleanupSubjects(fixture) {
  const byContact = new Map();
  for (const slot of Object.values(fixture.slots)) {
    assert(slot.organizationId === fixture.arms[slot.arm].organizationId &&
      slot.actorUserId === fixture.arms[slot.arm].actorUserId, 'crm026_cleanup_slot_identity');
    for (const contactId of [slot.contactId, ...Object.values(slot.decoys)]) {
      assert(uuid.test(contactId) && uuid.test(slot.organizationId), 'crm026_cleanup_subject_identity');
      const prior = byContact.get(contactId);
      assert(!prior || prior.organizationId === slot.organizationId && prior.arm === slot.arm,
        'crm026_cleanup_duplicate_subject');
      if (!prior) byContact.set(contactId, { contactId, organizationId: slot.organizationId,
        actorUserId: slot.actorUserId, arm: slot.arm, slotKey: slot.key, subjectKey: subjectKey(slot.organizationId, contactId) });
    }
  }
  return [...byContact.values()].sort((a, b) => a.contactId.localeCompare(b.contactId));
}

async function snapshot(c) {
  return memoryTransaction(c, true, async q => {
    const ids = Object.values(c.fixture.arms).map(arm => arm.organizationId);
    const facts = await q(`select id,organization_id,contact_id,request_key,subject_key,confirmed_by,content_hash,
      body='' body_empty,deleted_at::text,remote_deleted_at::text,sync_state,write_outcome,external_id
      from ai_customer_memories where organization_id=any($1::uuid[]) order by id`, [ids]);
    const queue = await q(`select organization_id,kind,status,count(*)::int count from job_queue
      group by organization_id,kind,status order by organization_id,kind,status`);
    const roots = await q(`select organization_id,run_kind,status,count(*)::int count,array_agg(id order by id)::text[] ids from ai_workbench_runs
      group by organization_id,run_kind,status order by organization_id,run_kind,status`);
    const usage = await q(`select organization_id,provider,model,status,count(*)::int calls,
      sum(input_tokens)::text input,sum(output_tokens)::text output,
      sum(cache_read_tokens)::text cache_read,sum(cache_write_tokens)::text cache_write
      from llm_calls group by organization_id,provider,model,status order by organization_id,provider,model,status`);
    const events = await q(`select organization_id,event_type,status,count(*)::int count from event_log
      group by organization_id,event_type,status order by organization_id,event_type,status`);
    const activeEvents = await q(`select id,organization_id,entity_id,entity_kind,event_type,status,payload,attempts,consumed_by,
      created_at::text,next_attempt_at::text,next_attempt_at is null or next_attempt_at<=now() as due
      from event_log where status in ('pending','processing') order by created_at,id`);
    return { facts, queue, roots, usage, events, activeEvents };
  });
}

const requireIdle = state => assert(state.queue.every(row => !['pending', 'running'].includes(row.status)) &&
  state.roots.every(row => !['queued', 'running', 'awaiting_confirmation'].includes(row.status)), 'crm026_cleanup_workbench_busy');

function requireOwnedFacts(rows, subjects) {
  for (const row of rows) {
    const owner = subjects.find(item => item.arm !== 'none' && item.contactId === row.contact_id);
    assert(owner && row.organization_id === owner.organizationId && row.confirmed_by === owner.actorUserId &&
      row.subject_key === owner.subjectKey && uuid.test(row.id) && uuid.test(row.request_key) && sha.test(row.content_hash),
    'crm026_cleanup_fact_not_owned');
  }
}

async function verifyExecutionIndex(c, indexHash) {
  const index = await read(EXECUTION_INDEX, indexHash);
  assert(index.version === 1 && sha.test(index.freezeHash ?? '') &&
    index.memory.freezeHash === index.freezeHash && index.generalization.freezeHash === index.freezeHash,
  'crm026_cleanup_final_index_freeze');
  const freeze = await read(FREEZE, index.freezeHash);
  assert(freeze.fixtureHash === c.fixtureHash && freeze.profilesHash === c.profilesHash &&
    freeze.environmentHash === c.environmentHash && freeze.productCommit === c.fixture.productCommit &&
    sha.test(freeze.generalization.fixtureHash ?? ''), 'crm026_cleanup_final_index_fixture');
  const generalization = await read(GENERALIZATION_FILES.fixture, freeze.generalization.fixtureHash);
  assert(generalization.memoryFixtureHash === c.fixtureHash && same(generalization.database, c.fixture.database) &&
    generalization.productCommit === freeze.productCommit, 'crm026_cleanup_generalization_database');
  const phases = [
    { name: 'memory', keys: freeze.slots, fixture: c.fixture, fixtureHash: c.fixtureHash, folder: MEMORY_ROOT, count: 18 },
    { name: 'generalization', keys: freeze.generalization.slots, fixture: generalization, fixtureHash: freeze.generalization.fixtureHash,
      folder: dirname(GENERALIZATION_FILES.fixture), count: 12 },
  ];
  const roots = [];
  for (const phase of phases) {
    const entries = index[phase.name].rows;
    assert(phase.keys.length === phase.count && same([...phase.keys].sort(), Object.keys(phase.fixture.slots).sort()) &&
      same(phase.keys, entries.map(row => row.key)), 'crm026_cleanup_final_index_slots');
    for (const row of entries) {
      const rawPath = resolve(phase.folder, 'runs', `${row.key}-result.json`);
      assert(resolve(row.rawPath) === rawPath && sha.test(row.resultHash), 'crm026_cleanup_final_index_original_path');
      const raw = phase.name === 'memory' ? await readMemorySlot(rawPath, row.key, row.resultHash) :
        await readGeneralizationSlot(rawPath, row.key, row.resultHash);
      const root = raw.observed?.root;
      assert(raw.key === row.key && raw.fixtureHash === phase.fixtureHash && raw.verification?.safe === true &&
        row.runId === (root?.id ?? null) && row.terminal === (root?.status ?? raw.disposition) &&
        (root ? uuid.test(root.id) : raw.disposition === 'rejected_no_root'),
      'crm026_cleanup_final_index_original_outcome');
      if (root) roots.push({ id: root.id, status: root.status });
    }
  }
  assert(index.totals.slots === 30 && index.totals.roots === roots.length &&
    new Set(roots.map(row => row.id)).size === roots.length, 'crm026_cleanup_final_index_denominator');
  return { freezeHash: index.freezeHash, roots: roots.sort((a, b) => a.id.localeCompare(b.id)), slots: index.totals.slots };
}

function requireRunAccounting(state, execution) {
  requireIdle(state);
  const roots = state.roots.filter(row => row.run_kind === 'root')
    .flatMap(row => row.ids.map(id => ({ id, status: row.status }))).sort((a, b) => a.id.localeCompare(b.id));
  assert(same(roots, execution.roots), 'crm026_cleanup_unaccounted_database_roots');
}

async function verifyWeb(c) {
  const actor = c.actors.mem0;
  const cookies = new Map();
  const auth = createServerClient(c.env.NEXT_PUBLIC_SUPABASE_URL, c.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookieOptions: { name: 'sb-pi-native-auth' },
    cookies: {
      getAll: () => Array.from(cookies, ([name, value]) => ({ name, value })),
      setAll: rows => { for (const { name, value } of rows) cookies.set(name, value); },
    },
    global: { fetch: (req, init) => fetch(req, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) }) },
  });
  const { data, error } = await auth.auth.signInWithPassword({ email: actor.email, password: actor.password });
  assert(!error && data.user?.id === c.fixture.arms.mem0.actorUserId, 'crm026_cleanup_web_actor');
  cookies.set('active_org', c.fixture.arms.mem0.organizationId);
  const response = await fetch(`${WEB}/api/v1/ai/integrations`, {
    headers: { Origin: WEB, Cookie: Array.from(cookies, ([name, value]) => `${name}=${encodeURIComponent(value)}`).join('; ') },
    signal: AbortSignal.timeout(30_000), redirect: 'error',
  });
  const body = (await response.json()).data;
  const configured = body?.providers?.filter(row => row.configured) ?? [];
  assert(response.status === 200 && configured.length === 1 && configured[0].provider === 'mem0' &&
    configured[0].enabled === true && configured[0].destination === MEM0, 'crm026_cleanup_requires_memory_web');
  return { httpStatus: response.status, requestId: response.headers.get('x-request-id'), provider: 'mem0', origin: MEM0 };
}

async function prepare(fixtureHash, profilesHash, indexPath, indexHash) {
  assert(sha.test(profilesHash ?? '') && sha.test(indexHash ?? '') &&
    resolve(indexPath) === EXECUTION_INDEX, 'crm026_cleanup_execution_index_required');
  const c = await loadMemoryEnvironment(fixtureHash, { profilesHash });
  assert(c.fixture.database.mode === 'fresh' && c.profiles, 'crm026_cleanup_requires_owned_stack');
  const execution = await verifyExecutionIndex(c, indexHash);
  const previous = await optional(PLAN);
  if (previous) {
    assert(previous.fixtureHash === fixtureHash && previous.profilesHash === profilesHash && previous.indexHash === indexHash &&
      previous.environmentHash === c.environmentHash && same(previous.execution, execution), 'crm026_cleanup_archived_plan_changed');
    return { planHash: digest(await readFile(PLAN)), facts: previous.before.facts.length, reused: true };
  }
  const subjects = cleanupSubjects(c.fixture);
  const before = await snapshot(c);
  requireRunAccounting(before, execution);
  requireOwnedFacts(before.facts, subjects);
  await mkdir(OUTPUT, { recursive: true });
  const planHash = await seal(PLAN, { version: 1, at: now(), fixtureHash, profilesHash, indexHash,
    environmentHash: c.environmentHash, databaseId: c.fixture.database.id, subjects, execution, before });
  return { planHash, subjects: subjects.length, facts: before.facts.length, alreadyWithdrawn: before.facts.filter(row => row.deleted_at).length };
}

async function currentFact(c, fact) {
  const [row] = await memoryTransaction(c, true, q => q(`select id,organization_id,contact_id,request_key,subject_key,confirmed_by,
    content_hash,body='' body_empty,deleted_at::text,remote_deleted_at::text,sync_state,write_outcome,external_id
    from ai_customer_memories where organization_id=$1 and id=$2`, [fact.organization_id, fact.id]));
  assert(row && same(identity(fact), identity(row)), 'crm026_cleanup_fact_identity_changed');
  return row;
}

async function withdraw(c, plan, planHash, fact) {
  const base = resolve(OUTPUT, fact.id);
  const mark = { planHash, id: fact.id, subjectKey: fact.subject_key };
  const receiptPath = `${base}-receipt.json`;
  const prior = await optional(receiptPath);
  let row = await currentFact(c, fact);
  const tombstoned = () => row.deleted_at && row.body_empty && row.sync_state === 'deleted';
  if (prior) {
    assert(same(prior.mark, mark) && tombstoned(), 'crm026_cleanup_old_receipt_changed');
    return prior;
  }
  const intentPath = `${base}-intent.json`;
  const intent = await optional(intentPath);
  assert(!intent || same(intent.mark, mark), 'crm026_cleanup_old_intent_changed');
  let transport = await optional(`${base}-http.json`);
  assert(!transport || same(transport.mark, mark), 'crm026_cleanup_old_http_changed');
  if (!tombstoned()) {
    assert(!intent && !transport && !row.deleted_at && !fact.deleted_at, 'crm026_cleanup_withdrawal_unresolved_do_not_resend');
    const owner = plan.subjects.find(subject => subject.contactId === fact.contact_id);
    await seal(intentPath, { mark, at: now(), before: row });
    let receipt;
    try {
      receipt = await memoryTransport(c, c.fixture.slots[owner.slotKey], request => request(MEMORY, 'DELETE', { id: row.id }));
    } catch {
      receipt = { httpStatus: null, data: null, errorCode: 'crm026_cleanup_transport_unknown' };
    }
    transport = { mark, at: now(), httpStatus: receipt.httpStatus, requestId: receipt.requestId ?? null,
      errorCode: receipt.errorCode, hidden: receipt.httpStatus === 200 && receipt.data?.id === row.id && receipt.data?.hidden === true };
    await seal(`${base}-http.json`, transport);
    row = await currentFact(c, fact);
  }
  assert(tombstoned(), 'crm026_cleanup_withdrawal_unresolved_do_not_resend');
  const outcome = fact.deleted_at ? 'already_withdrawn' : transport?.hidden ? 'withdrawn_receipt' : 'withdrawn_sql_reconciliation';
  const receipt = { mark, outcome, transport, after: row };
  await seal(receiptPath, receipt);
  return receipt;
}

const tombstone = row => row?.deleted_at && row.body_empty && row.sync_state === 'deleted';
const localOnly = row => tombstone(row) && row.remote_deleted_at && row.write_outcome === 'never_started' && row.external_id === null;
const eventIdentity = ({ id, organization_id, entity_id, entity_kind, event_type, payload }) =>
  ({ id, organization_id, entity_id, entity_kind, event_type, payload });

function queuedProjection(row, facts, fixture) {
  assert(row.event_type === SYNC && row.entity_kind === 'ai_customer_memory' &&
    same(row.payload, { memory_id: row.entity_id }) && row.status === 'pending' && row.consumed_by.length === 0,
  'crm026_cleanup_unexpected_integration_event');
  const fact = facts.find(item => item.id === row.entity_id && item.organization_id === row.organization_id);
  const arm = row.organization_id === fixture.arms.sql.organizationId ? 'sql' : 'mem0';
  assert(fact && (arm === 'sql' ? localOnly(fact) :
    row.organization_id === fixture.arms.mem0.organizationId && tombstone(fact) && row.attempts === 0 &&
    !['in_flight', 'unknown'].includes(fact.write_outcome)), 'crm026_cleanup_unsafe_projection_event');
  return arm;
}

export function verifyCleanupResiduals(fixture, beforeEvents, state) {
  const conversations = new Map();
  for (const slot of Object.values(fixture.slots))
    for (const id of [slot.conversationId, slot.oldConversationId]) {
      assert(!conversations.has(id) || conversations.get(id) === slot.organizationId, 'crm026_cleanup_routing_scope');
      conversations.set(id, slot.organizationId);
    }
  const routing = state.activeEvents.filter(row => row.event_type === ROUTING);
  assert(conversations.size === 27 && routing.length === conversations.size &&
    same(routing, beforeEvents.filter(row => row.event_type === ROUTING)) &&
    new Set(routing.map(row => row.entity_id)).size === conversations.size &&
    routing.every(row => row.status === 'pending' && row.entity_kind === 'conversation' && row.attempts === 0 &&
      !row.consumed_by.length && conversations.get(row.entity_id) === row.organization_id),
  'crm026_cleanup_routing_events_changed');
  const deferredSql = state.activeEvents.filter(row => row.event_type !== ROUTING);
  assert(deferredSql.every(row => queuedProjection(row, state.facts, fixture) === 'sql'),
    'crm026_cleanup_mem0_projection_still_active');
  return { ownedMem0Active: 0, sqlLocalOnlyPending: deferredSql, ownedUnclaimedRouting: routing, otherActive: 0 };
}

async function readIntegrationEvent(c, event) {
  const [current] = await memoryTransaction(c, true, q => q(`select id,organization_id,entity_id,entity_kind,event_type,status,payload,
    attempts,consumed_by,created_at::text,next_attempt_at::text,last_error from event_log where id=$1 and organization_id=$2`,
  [event.id, event.organization_id]));
  assert(current && same(eventIdentity(current), eventIdentity(event)), 'crm026_cleanup_integration_event_changed');
  return current;
}

const projectionDone = (event, memory) => event.status === 'done' &&
  event.consumed_by.includes(SYNC_CONSUMER) && tombstone(memory) && !!memory.remote_deleted_at;

async function reconcileIntegrationIntents(c, plan, planHash) {
  const files = (await readdir(OUTPUT)).filter(name => /^integration-[-a-f0-9]+-intent\.json$/.test(name));
  for (const name of files) {
    const prior = await read(resolve(OUTPUT, name));
    assert(prior.planHash === planHash && ['sql', 'mem0'].includes(prior.arm), 'crm026_cleanup_integration_intent_changed');
    const fact = plan.before.facts.find(row => row.id === prior.event.entity_id && row.organization_id === prior.event.organization_id);
    assert(fact?.organization_id === c.fixture.arms[prior.arm].organizationId, 'crm026_cleanup_integration_intent_not_owned');
    if (prior.arm === 'mem0') {
      const event = await readIntegrationEvent(c, prior.event);
      assert(projectionDone(event, await currentFact(c, fact)), 'crm026_cleanup_mem0_effect_unresolved_do_not_redispatch');
    }
  }
}

async function settleProjections(c, plan, planHash) {
  const mem0 = c.fixture.arms.mem0.organizationId;
  await reconcileIntegrationIntents(c, plan, planHash);
  for (let index = 0; index <= 3 * plan.before.facts.length; index += 1) {
    const state = await snapshot(c);
    requireRunAccounting(state, plan.execution);
    const queued = state.activeEvents.filter(row => row.event_type.startsWith('ai_integration.'));
    const arms = new Map(queued.map(row => [row.id, queuedProjection(row, state.facts, c.fixture)]));
    if (state.facts.every(row => row.organization_id !== mem0 || row.remote_deleted_at) &&
      ![...arms.values()].includes('mem0')) return;
    const [event, next] = queued.filter(row => row.due);
    assert(event && event.created_at !== next?.created_at, 'crm026_cleanup_integration_queue_not_ready_or_ambiguous');
    const arm = arms.get(event.id);
    const fact = plan.before.facts.find(row => row.id === event.entity_id && row.organization_id === event.organization_id);
    assert(fact && uuid.test(event.id), 'crm026_cleanup_integration_event_not_owned');
    const key = arm === 'mem0' ? event.id : `${event.id}-${digest(event.next_attempt_at ?? 'initial').slice(0, 12)}`;
    const attempt = resolve(OUTPUT, `integration-${key}`);
    await seal(`${attempt}-intent.json`, { planHash, at: now(), arm, event });
    const started = performance.now();
    let tick;
    try {
      const response = await fetch(`${WEB}/api/v1/cron/ai-integration-drain`, { method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${c.env.INTERNAL_CRON_SECRET}`, Origin: WEB }, signal: AbortSignal.timeout(65_000) });
      const body = await response.json();
      tick = { httpStatus: response.status, result: body.data ?? null, requestId: response.headers.get('x-request-id') };
    } catch { tick = { httpStatus: null, result: null, requestId: null }; }
    await seal(`${attempt}-receipt.json`, { planHash, at: now(), elapsedMs: Math.round(performance.now() - started), ...tick });
    const readback = await readIntegrationEvent(c, event);
    const memory = await currentFact(c, fact);
    await seal(`${attempt}-readback.json`, { planHash, at: now(), event: readback, memory });
    const result = tick.result;
    const settled = arm === 'mem0' ? projectionDone(readback, memory) && result?.done === 1 && result.retried === 0 :
      localOnly(memory) && readback.status === 'pending' && readback.attempts === event.attempts &&
      !readback.consumed_by.length && !!readback.next_attempt_at && readback.next_attempt_at !== event.next_attempt_at &&
      result?.retried === 1 && result.done === 0;
    assert(tick.httpStatus === 200 && result?.scanned === 1 && result.projected === 0 &&
      result.failed === 0 && result.dead === 0 && settled, 'crm026_cleanup_integration_tick_unresolved');
  }
  throw new Error('crm026_cleanup_projection_unresolved');
}

async function providerReadback(c, subjects, planHash) {
  const [binding, extra] = JSON.parse(c.env.AI_INTEGRATION_BINDINGS);
  assert(!extra && binding.base_url === MEM0 && binding.provider === 'mem0' &&
    binding.organization_id === c.fixture.arms.mem0.organizationId, 'crm026_cleanup_provider_scope');
  const probes = [];
  for (const subject of subjects.filter(row => row.arm === 'mem0')) {
    const href = new URL('/memories', MEM0);
    href.searchParams.set('user_id', subject.subjectKey);
    href.searchParams.set('top_k', '1000');
    const start = performance.now();
    let httpStatus = null;
    let returned = null;
    try {
      const response = await fetch(href, { headers: { 'X-API-Key': binding.api_key },
        redirect: 'error', signal: AbortSignal.timeout(20_000) });
      httpStatus = response.status;
      const body = await response.text();
      if (body.length <= 1_000_000) {
        const values = JSON.parse(body)?.results;
        returned = Array.isArray(values) ? values.length : null;
      }
    } catch { /* Keep the actual HTTP status when the request reached the service. */ }
    const proof = { subject: subject.subjectKey, elapsedMs: Math.round(performance.now() - start), httpStatus, returned };
    probes.push(proof);
    await seal(resolve(OUTPUT, `provider-${randomUUID()}-read.json`), { planHash, at: now(), ...proof });
    assert(httpStatus === 200 && returned === 0, 'crm026_cleanup_remote_subject_not_empty');
  }
  return probes;
}

async function accession(planHash) {
  const rows = [];
  const names = (await readdir(OUTPUT)).filter(name => !['plan.json', 'settled.json'].includes(name)).sort();
  for (const file of names) {
    const raw = await readFile(resolve(OUTPUT, file));
    const record = JSON.parse(raw);
    assert((record.planHash ?? record.mark?.planHash) === planHash, 'crm026_cleanup_accession_drift');
    rows.push({ file, sha256: digest(raw) });
  }
  return rows;
}

async function apply(planHash) {
  assert(sha.test(planHash ?? ''), 'crm026_cleanup_plan_hash_required');
  const plan = await read(PLAN, planHash);
  const c = await loadMemoryEnvironment(plan.fixtureHash, { profilesHash: plan.profilesHash });
  const execution = await verifyExecutionIndex(c, plan.indexHash);
  assert(plan.version === 1 && plan.databaseId === c.fixture.database.id && plan.environmentHash === c.environmentHash &&
    same(plan.subjects, cleanupSubjects(c.fixture)) && same(plan.execution, execution) && c.fixture.database.mode === 'fresh',
  'crm026_cleanup_plan_scope_changed');
  const previous = await optional(FINAL);
  if (previous) {
    assert(previous.planHash === planHash, 'crm026_cleanup_final_receipt_changed');
    return { cleanupHash: digest(await readFile(FINAL)), reused: true };
  }
  const active = await snapshot(c);
  requireRunAccounting(active, execution);
  requireOwnedFacts(active.facts, plan.subjects);
  assert(same(active.facts.map(identity), plan.before.facts.map(identity)) && same(active.roots, plan.before.roots) &&
    same(active.usage, plan.before.usage), 'crm026_cleanup_plan_database_changed');
  const web = await verifyWeb(c);
  await seal(resolve(OUTPUT, `web-${randomUUID()}.json`), { planHash, at: now(), ...web });
  const withdrawals = [];
  for (const fact of plan.before.facts) withdrawals.push(await withdraw(c, plan, planHash, fact));
  await settleProjections(c, plan, planHash);
  const provider = await providerReadback(c, plan.subjects, planHash);
  const after = await snapshot(c);
  requireRunAccounting(after, execution);
  assert(same(after.queue, plan.before.queue) && same(after.roots, plan.before.roots) && same(after.usage, plan.before.usage) &&
    same(after.facts.map(identity), plan.before.facts.map(identity)) &&
    after.facts.every(row => row.deleted_at && row.body_empty && row.remote_deleted_at && row.sync_state === 'deleted'),
  'crm026_cleanup_post_state_unresolved');
  const residualEvents = verifyCleanupResiduals(c.fixture, plan.before.activeEvents, after);
  const cleanupHash = await seal(FINAL, { planHash, at: now(), executionIndexHash: plan.indexHash, web, provider, after,
    withdrawals: withdrawals.map(({ mark, outcome }) => ({ id: mark.id, outcome })), residualEvents, accession: await accession(planHash),
    evidenceRetained: true, generationRequested: 0 });
  return { cleanupHash, withdrawn: withdrawals.length, remoteSubjectsEmpty: provider.length, generationRequested: 0,
    residual: { mem0: residualEvents.ownedMem0Active, sql: residualEvents.sqlLocalOnlyPending.length,
      routing: residualEvents.ownedUnclaimedRouting.length, other: residualEvents.otherActive } };
}

async function main([mode, ...args]) {
  if (mode === 'prepare' && args.length === 4) return prepare(...args);
  if (mode === 'apply' && args.length === 1) return apply(...args);
  throw new Error('crm026_cleanup_command_required');
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) main(process.argv.slice(2)).then(value => {
  console.info(JSON.stringify(value));
}, error => {
  console.error(/^crm026_[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : 'crm026_cleanup_failed');
  process.exitCode = 1;
});
