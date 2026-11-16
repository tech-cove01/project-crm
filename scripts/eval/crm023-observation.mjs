/** Bounded observation delivery for the isolated CRM evaluation. No linked product code changes. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServerClient } from '@supabase/ssr';
import pg from 'pg';
import { integrationBinding } from '../../lib/ai/integrations/config.ts';
import { exportLangfuseEvent, langfuseTraceId } from '../../lib/ai/integrations/langfuse.ts';
import { captureScores, captureSpans, compareScores } from './crm023-observation-readback.mjs';

const root = resolve(import.meta.dirname, '../..');
const directory = resolve(root, '.local/crm023/observation');
const org = 'd22e3375-d7e1-43a2-8ce9-b5017c98b338';
const databaseId = '7708392892596248609';
const actor = '00d93672-984d-485e-8fe2-3177c4dbecb3';
const authOrigin = 'http://127.0.0.1:55521';
const web = 'http://localhost:3415';
const langfuse = 'http://127.0.0.1:3006';
const consumer = 'ai_integration.langfuse_v1';
const terminal = ['completed', 'partial', 'failed', 'cancelled'];
const selectable = ['completed', 'partial', 'failed'];
const windows = ['1', '2'];
const sources = [
  'scripts/eval/crm023-observation.mjs', 'scripts/eval/crm023-observation-readback.mjs',
  'lib/ai/integrations/langfuse.ts', 'lib/ai/integrations/langfuse-readback.ts',
  'app/api/v1/ai/workbench/runs/[id]/evaluation/route.ts',
  'infra/local-agent-services/compose.yml', 'infra/local-agent-services/compose.langfuse-eval.yml',
  'infra/local-agent-services/clickhouse-low-memory.xml', 'infra/local-agent-services/clickhouse-low-memory-users.xml',
  'infra/local-agent-services/clickhouse-eval-capacity.xml',
];
const hash = value => createHash('sha256').update(value).digest('hex');
const stringify = value => JSON.stringify(value, null, 2) + '\n';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const safe = error => /^(crm023_[a-z0-9_]+|langfuse_[a-z_]+|integration_http_\d{3})$/.test(error?.message ?? '')
  ? error.message : error?.code === 'EEXIST' ? 'crm023_prior_intent_or_artifact' : 'crm023_observation_failed';

async function seal(name, value) {
  const bytes = stringify(value);
  const path = resolve(directory, name);
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  return { path, sha256: hash(bytes) };
}

async function load(name, expectedHash) {
  const bytes = await readFile(resolve(directory, name));
  if (expectedHash) assert(hash(bytes) === expectedHash, 'crm023_frozen_hash_changed');
  return JSON.parse(bytes);
}

async function sourceManifest() {
  return Object.fromEntries(await Promise.all(sources.map(async name => [name, hash(await readFile(resolve(root, name)))])));
}

function requireEndpoints() {
  const db = new URL(process.env.SUPABASE_DB_URL ?? '');
  assert(['127.0.0.1', 'localhost'].includes(db.hostname) && db.port === '55522' && db.pathname === '/postgres' &&
    ['postgresql:', 'postgres:'].includes(db.protocol) && !db.search && !db.hash &&
    process.env.NEXT_PUBLIC_SUPABASE_URL === authOrigin && process.env.NEXT_PUBLIC_APP_URL === web && process.env.NODE_ENV === 'development',
  'crm023_isolated_endpoints_required');
  const binding = integrationBinding(org, 'langfuse');
  assert(binding && new URL(binding.base_url).origin === langfuse, 'crm023_isolated_langfuse_binding_required');
  return binding;
}

async function assertDatabase(db) {
  const { rows: [row] } = await db.query(`select current_database() db, system_identifier::text instance,
    (select count(*)::int from organizations) total_organizations,
    (select slug from organizations where id=$1) slug,
    (select enabled from ai_integration_settings where organization_id=$1 and provider='langfuse') enabled
    from pg_control_system()`, [org]);
  assert(row.db === 'postgres' && row.instance === databaseId && row.total_organizations === 1 &&
    row.slug === 'crm022-synthetic-eval' && row.enabled, 'crm023_database_identity_mismatch');
}

async function snapshot(pool, runId) {
  const db = await pool.connect();
  try {
    await db.query('begin isolation level repeatable read read only');
    const args = [org, runId];
    const { rows: runs } = await db.query(`select id,run_kind,parent_run_id,status,mode,specialist_key,created_at::text,completed_at::text,
      scope->>'leadId' lead_id,scope->>'contactId' contact_id,
      encode(sha256(convert_to(coalesce(final_text,''),'utf8')),'hex') final_sha256,
      encode(sha256(convert_to(coalesce(result_document::text,''),'utf8')),'hex') document_sha256
      from ai_workbench_runs where organization_id=$1 and (id=$2 or parent_run_id=$2) order by created_at,id`, args);
    const rootRun = runs.find(row => row.id === runId);
    assert(rootRun?.run_kind === 'root' && rootRun.parent_run_id === null && rootRun.mode === 'inspect' &&
      runs.every(run => terminal.includes(run.status) && run.completed_at), 'crm023_terminal_inspect_scope_required');
    const runIds = runs.map(row => row.id);
    const scope = [org, runIds];
    const { rows: events } = await db.query(`select id,organization_id,event_type,entity_kind,entity_id,payload,metadata,status,
      attempts,consumed_by,next_attempt_at,last_error,created_at::text,updated_at::text,
      encode(sha256(convert_to(payload::text,'utf8')),'hex') payload_hash
      from event_log where organization_id=$1 and entity_id=any($2::uuid[]) and event_type='ai_integration.langfuse_export'
      order by created_at,id`, scope);
    const { rows: calls } = await db.query(`select id,workbench_run_id,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_cents
      from llm_calls where organization_id=$1 and workbench_run_id=any($2::uuid[]) order by id`, scope);
    const { rows: jobs } = await db.query(`select id,status,attempts from job_queue where organization_id=$1
      and payload->>'runId'=any($2::text[]) order by id`, scope);
    const { rows: proposals } = await db.query(`select id,status,tool_name from ai_agent_action_proposals where organization_id=$1
      and run_id=any($2::uuid[]) order by id`, scope);
    const { rows: leads } = await db.query(`select id,stage_id,updated_at::text from crm_leads where organization_id=$1
      and id=any($2::uuid[]) order by id`, [org, runs.map(row => row.lead_id).filter(Boolean)]);
    const { rows: activities } = await db.query(`select id,lead_id,created_at::text from crm_lead_activities where organization_id=$1
      and lead_id=any($2::uuid[]) and type='stage_changed' order by id`, [org, leads.map(row => row.id)]);
    const { rows: evaluations } = await db.query(`select input_fingerprint,profile_revision,verdict,score,report->'dimensions' dimensions
      from ai_agent_eval_reports where organization_id=$1 and run_id=$2 order by created_at,id`, args);
    const { rows: outside } = await db.query(`select id,entity_id,status,attempts,consumed_by,updated_at::text,
      encode(sha256(convert_to(payload::text,'utf8')),'hex') payload_hash
      from event_log where organization_id=$1 and event_type='ai_integration.langfuse_export'
      and (entity_id is null or not (entity_id=any($2::uuid[]))) order by id`, scope);
    const business = { runs, calls, jobs, proposals, leads, activities };
    await db.query('commit');
    return { rootRun, business, businessHash: hash(stringify(business)), events, evaluations, outside };
  } finally {
    try { await db.query('rollback'); } finally { db.release(); }
  }
}

function spanEvents(current) {
  return current.events.filter(row => row.payload?.kind === 'spans');
}

const identity = row => [row.id, row.entity_id, row.payload_hash];
const status = row => ({ id: row.id, entityId: row.entity_id, payloadHash: row.payload_hash,
  kind: row.payload.kind, status: row.status, attempts: row.attempts, consumed: row.consumed_by.includes(consumer),
  error: row.last_error !== null, nextAttemptAt: row.next_attempt_at });
const ready = row => row.status === 'pending' && row.attempts === 0 && !row.consumed_by.includes(consumer) &&
  row.last_error === null && (!row.next_attempt_at || Date.parse(row.next_attempt_at) <= Date.now());

function outsideProof(before, after) {
  const originalIds = new Set(before.map(row => row.id));
  const originalAfter = after.filter(row => originalIds.has(row.id));
  const added = after.filter(row => !originalIds.has(row.id));
  const nonPendingAdditions = added.filter(row => row.status !== 'pending' || row.attempts !== 0 || row.consumed_by.length !== 0).length;
  const beforeSha = hash(stringify(before));
  const originalAfterSha = hash(stringify(originalAfter));
  return { beforeCount: before.length, originalAfterCount: originalAfter.length, added: added.length, nonPendingAdditions,
    beforeSha, originalAfterSha, unchanged: beforeSha === originalAfterSha && nonPendingAdditions === 0 };
}

function validateSpans(current, expected) {
  const { runs, calls } = current.business;
  const distinct = new Map(expected.map(span => [span.spanId, span]));
  const rootRun = current.rootRun.id;
  assert(expected.length > 0 && expected.every(span => span.traceId === langfuseTraceId(org, rootRun)), 'crm023_trace_id_mismatch');
  for (const run of runs) {
    const onRun = spanEvents(current).filter(row => row.entity_id === run.id).flatMap(row => row.payload.spans);
    const lifecycle = onRun.find(span => span.spanId === hash(`crm-run:${org}:${run.id}`).slice(0, 16));
    const child = run.id !== rootRun;
    assert(lifecycle?.name === (child ? 'crm.specialist' : 'crm.run') &&
      (!child || (run.run_kind === 'specialist' && run.parent_run_id === rootRun && lifecycle.parentSpanId === hash(`crm-run:${org}:${rootRun}`).slice(0, 16))) &&
      new Set(onRun.filter(span => span.name === 'crm.call').map(span => span.spanId)).size ===
        calls.filter(call => call.workbench_run_id === run.id).length, 'crm023_sql_or_lifecycle_graph_invalid');
  }
  for (const span of distinct.values()) {
    const parent = distinct.get(span.parentSpanId)?.name;
    const graphValid = span.name === 'crm.run' ? !span.parentSpanId
      : span.name === 'crm.specialist' ? parent === 'crm.run'
      : span.name === 'crm.call' ? ['crm.run', 'crm.specialist'].includes(parent)
      : ['crm.model', 'crm.tool'].includes(span.name) && parent === 'crm.call';
    assert(graphValid, 'crm023_span_parent_invalid');
  }
  return [...distinct.keys()].sort();
}

async function freeze(pool, window, runId) {
  const current = await snapshot(pool, runId);
  assert(selectable.includes(current.rootRun.status), 'crm023_normal_or_limited_root_required');
  const mode = current.rootRun.status === 'completed' ? 'normal' : 'limited';
  const specialistCount = current.business.runs.filter(row => row.run_kind === 'specialist').length;
  if (window === '2') {
    const prior = await load('window-1-report.json');
    const priorPlan = await load('window-1-plan.json', prior.planHash);
    assert(prior.runId !== runId && prior.finishedAt && priorPlan.mode !== mode, 'crm023_distinct_terminal_windows_required');
    assert(specialistCount === 3 || priorPlan.specialistCount === 3, 'crm023_three_specialists_required_in_windows');
  }
  const events = spanEvents(current);
  assert(events.length >= 1 && events.length <= 15 && events.every(ready) && current.events.length === events.length,
  'crm023_first_delivery_and_expected_terminal_status_required');
  const spans = events.flatMap(row => row.payload.spans);
  const nodeIds = validateSpans(current, spans);
  return seal(`window-${window}-plan.json`, { window, runId, mode, org, databaseId, at: new Date().toISOString(),
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(),
    sourceHash: await sourceManifest(), businessHash: current.businessHash, spanEvents: events.map(identity), nodeIds, specialistCount });
}

async function projectScore(plan, signal) {
  const { decider } = JSON.parse(await readFile(resolve(root, '.local/crm022/actors.private.json'), 'utf8'));
  assert(decider?.id === actor && typeof decider.email === 'string' && typeof decider.password === 'string', 'crm023_fixed_actor_required');
  const cookies = new Map();
  const supabase = createServerClient(authOrigin, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookieOptions: { name: 'sb-pi-native-auth' },
    cookies: { getAll: () => [...cookies].map(([name, value]) => ({ name, value })),
      setAll: updates => updates.forEach(({ name, value }) => value ? cookies.set(name, value) : cookies.delete(name)) },
    global: { fetch: (request, init) => fetch(request, { ...init, redirect: 'error', signal }) },
  });
  const login = await supabase.auth.signInWithPassword({ email: decider.email, password: decider.password });
  const user = await supabase.auth.getUser();
  assert(!login.error && !user.error && user.data.user?.id === actor && login.data.user?.id === actor, 'crm023_actor_verification_failed');
  cookies.set('active_org', org);
  const path = `/api/v1/ai/workbench/runs/${plan.runId}/evaluation?mode=deterministic_export`;
  const originCookie = [...cookies].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('; ');
  await seal(`window-${plan.window}-score-intent.json`, { at: new Date().toISOString(), runId: plan.runId, actor, path });
  const reply = await fetch(web + path, { method: 'POST', redirect: 'error', signal, headers: { Cookie: originCookie, Origin: web } });
  const body = await reply.json().catch(() => null);
  const value = body?.data;
  assert(reply.status === 200 && value?.runId === plan.runId && digest.test(value.inputFingerprint) &&
    value.semanticJudge?.status !== 'completed' && value.projection === 'queued_if_enabled', 'crm023_score_export_request_failed');
  return { status: reply.status, runId: value.runId, fingerprint: value.inputFingerprint, verdict: value.verdict,
    profileRevision: value.profileRevision, score: value.score, judgeStatus: value.semanticJudge?.status };
}

async function writeClaim(pool, row) {
  const { rows } = await pool.query(`update event_log set status='processing'
    where organization_id=$1 and id=$2 and entity_id=$3 and event_type='ai_integration.langfuse_export'
    and status='pending' and attempts=0 and last_error is null and not (consumed_by @> array[$4]::text[])
    and (next_attempt_at is null or next_attempt_at<=now())
    and encode(sha256(convert_to(payload::text,'utf8')),'hex')=$5 returning updated_at::text`,
  [org, row.id, row.entity_id, consumer, row.payload_hash]);
  assert(rows.length === 1, 'crm023_event_claim_rejected');
  return rows[0].updated_at;
}

async function sendEvent(pool, row, signal) {
  let sent = 0;
  const path = row.payload.kind === 'spans' ? '/api/public/otel/v1/traces' : '/api/public/ingestion';
  const result = await exportLangfuseEvent(row, pool, (url, init) => {
    assert(++sent === 1 && init.method === 'POST' && String(url) === langfuse + path,
      'crm023_single_scoped_export_required');
    return fetch(url, { ...init, signal: AbortSignal.any([signal, init.signal]), redirect: 'error' });
  });
  assert(result === 'delivered' && sent === 1, 'crm023_event_never_delivered');
}

async function consume(pool, row, signal) {
  signal.throwIfAborted();
  const claimTime = await writeClaim(pool, row);
  let error;
  try { await sendEvent(pool, row, signal); } catch (cause) { error = safe(cause); }
  const skipped = error === 'langfuse_span_receipt_incomplete';
  const done = !error || skipped;
  const { rowCount } = await pool.query(`update event_log set status=$5,
    consumed_by=case when $5='done' then array_append(consumed_by,$6) else consumed_by end,
    attempts=case when $5='done' then attempts else attempts+1 end,
    next_attempt_at=case when $5='done' then null else now()+interval '2 minutes' end,last_error=$7
    where organization_id=$1 and id=$2 and entity_id=$3 and event_type='ai_integration.langfuse_export'
    and status='processing' and updated_at=$4::timestamptz`,
  [org, row.id, row.entity_id, claimTime, done ? 'done' : 'pending', consumer, error ?? null]);
  assert(rowCount === 1, 'crm023_event_claim_changed_after_export');
  return { id: row.id, kind: row.payload.kind, accepted: !error, skipped, error };
}

function bindScore(current, receipt) {
  const rows = current.events.filter(row => row.payload.kind === 'scores');
  const evalRow = current.evaluations.find(row => row.input_fingerprint === receipt.fingerprint);
  const expected = (evalRow?.dimensions ?? []).filter(item => typeof item.score === 'number')
    .map(item => [`crm.${item.key}`, item.score]);
  if (typeof evalRow?.score === 'number') expected.push(['crm.overall', evalRow.score]);
  const scores = rows[0]?.payload.scores ?? [];
  assert(rows.length === 1 && rows[0].entity_id === current.rootRun.id && scores.length === expected.length &&
    expected.length > 0 && scores.every(score => score.metadata?.fingerprint === receipt.fingerprint) &&
    expected.every(([name, value]) => scores.filter(score => score.name === name && score.value === value).length === 1) &&
    evalRow?.profile_revision === receipt.profileRevision && evalRow?.verdict === receipt.verdict && evalRow?.score === receipt.score,
  'crm023_score_report_projection_mismatch');
  return rows[0];
}

async function observe(binding, plan, current, scoreRow, report, signal) {
  const traceId = langfuseTraceId(org, plan.runId);
  const spans = spanEvents(current).flatMap(row => row.payload.spans);
  const rootSpan = hash(`crm-run:${org}:${plan.runId}`).slice(0, 16);
  const time = new Date(Date.parse(current.rootRun.created_at)).toISOString();
  while (!signal.aborted) {
    try {
      const trace = await captureSpans(binding, spans, true, signal);
      const remote = await captureScores(binding, traceId, time, signal);
      const scores = compareScores({ expected: scoreRow.payload.scores, remote, org, runId: plan.runId,
        traceId, rootSpan, fingerprint: report.evaluation.fingerprint, profileRevision: report.evaluation.profileRevision });
      report.readback = { trace, scores };
      report.observations.push({ at: new Date().toISOString(), spans: trace.observationCount, scores: scores.count,
        complete: trace.complete && trace.metricsComplete && scores.complete });
      if (report.observations.at(-1).complete) return;
    } catch (error) {
      report.observations.push({ at: new Date().toISOString(), error: safe(error) });
    }
    await sleep(5000, undefined, { signal });
  }
}

async function runWindow(pool, binding, plan, report) {
  const signal = AbortSignal.timeout(600_000);
  const current = await snapshot(pool, plan.runId);
  const events = spanEvents(current);
  assert(current.businessHash === plan.businessHash && stringify(events.map(identity)) === stringify(plan.spanEvents) &&
    events.every(ready) && current.events.length === events.length, 'crm023_pending_window_changed');
  const expected = events.flatMap(row => row.payload.spans);
  const absent = await captureSpans(binding, expected, false, signal);
  const traceId = langfuseTraceId(org, plan.runId);
  assert(absent.observationCount === 0 && (await captureScores(binding, traceId, current.rootRun.created_at, signal)).length === 0,
    'crm023_remote_window_not_empty');
  report.before = { at: new Date().toISOString(), absent: true, eventState: events.map(status) };
  let projected;
  try {
    report.evaluation = await projectScore(plan, signal);
    projected = await snapshot(pool, plan.runId);
    const scoreRow = bindScore(projected, report.evaluation);
    assert(projected.businessHash === plan.businessHash && stringify(spanEvents(projected).map(identity)) === stringify(plan.spanEvents) &&
      ready(scoreRow) && spanEvents(projected).every(ready), 'crm023_projected_window_changed');
    for (const row of [...spanEvents(projected), scoreRow]) {
      const receipt = await consume(pool, row, signal);
      report.dispatch.push(receipt);
      assert(receipt.accepted, 'crm023_dispatch_failed');
      await sleep(3000, undefined, { signal });
    }
    await observe(binding, plan, projected, scoreRow, report, signal);
  } catch (error) {
    if (signal.aborted) throw new Error('crm023_window_observation_deadline', { cause: error });
    throw error;
  } finally {
    const final = await snapshot(pool, plan.runId);
    report.final = { eventState: final.events.map(status), businessUnchanged: final.businessHash === plan.businessHash,
      payloadsUnchanged: projected ? stringify(final.events.map(identity)) === stringify(projected.events.map(identity)) : null,
      outOfScope: outsideProof(current.outside, final.outside), usage: final.business.calls,
      runs: final.business.runs.map(({ id, parent_run_id, run_kind, status: value }) => ({ id, parent_run_id, run_kind, status: value })) };
  }
  return report.observations.at(-1)?.complete === true && report.final.businessUnchanged && report.final.payloadsUnchanged && report.final.outOfScope.unchanged &&
    report.final.eventState.every(event => event.status === 'done' && event.consumed && !event.error);
}

async function repeatOnce(pool, binding, window, reportHash) {
  const original = await load(`window-${window}-report.json`, reportHash);
  const other = await load(`window-${window === '1' ? '2' : '1'}-report.json`);
  assert(original.pass && other.pass && original.runId !== other.runId &&
    [original, other].some(value => value.final?.runs.filter(row => row.run_kind === 'specialist').length === 3),
  'crm023_two_verified_windows_with_experts_required');
  const plan = await load(`window-${window}-plan.json`, original.planHash);
  assert(plan.runId === original.runId && stringify(await sourceManifest()) === stringify(plan.sourceHash), 'crm023_replay_plan_changed');
  const current = await snapshot(pool, plan.runId);
  const event = spanEvents(current).find(row => row.payload.spans.some(span => span.name === 'crm.model'));
  const eventState = current.events.map(status);
  assert(event && current.businessHash === plan.businessHash && stringify(eventState) === stringify(original.final.eventState),
    'crm023_original_delivery_state_changed');
  const scoreRow = bindScore(current, original.evaluation);
  const signal = AbortSignal.timeout(60_000);
  const proof = { window, runId: plan.runId, reportHash, eventId: event.id, originalPayloadHash: event.payload_hash,
    evaluation: original.evaluation, startedAt: new Date().toISOString(), observations: [] };
  await seal('idempotence-intent.json', { reportHash, runId: plan.runId, event: identity(event), at: proof.startedAt });
  try {
    await sendEvent(pool, event, signal);
    proof.otlpAccepted = true;
    // Give asynchronous ingestion a bounded window before querying the existing IDs again.
    await sleep(15_000, undefined, { signal });
    await observe(binding, plan, current, scoreRow, proof, signal);
    const final = await snapshot(pool, plan.runId);
    proof.outboxUnchanged = stringify(final.events.map(status)) === stringify(eventState);
    proof.businessUnchanged = final.businessHash === plan.businessHash;
    proof.outOfScope = outsideProof(current.outside, final.outside);
    proof.nodeIdsUnchanged = stringify(proof.readback?.trace.observations.map(row => row.id).sort()) === stringify(plan.nodeIds);
    proof.pass = proof.outboxUnchanged && proof.businessUnchanged && proof.outOfScope.unchanged &&
      proof.nodeIdsUnchanged && proof.observations.at(-1)?.complete === true;
  } catch (error) { proof.pass = false; proof.error = safe(error); }
  proof.finishedAt = new Date().toISOString();
  const artifact = await seal('idempotence-report.json', proof);
  return { ...artifact, pass: proof.pass, error: proof.error, eventId: event.id };
}

async function main() {
  const [command, window, target] = process.argv.slice(2);
  if (!command || command === '--help') {
    console.info('CRM-023 observation: freeze <1|2> <existing root UUID>, deliver <1|2> <plan sha256>, repeat-once <1|2> <report sha256>. Load the isolated CRM environment using tsx.');
    return;
  }
  assert(process.argv.length === 5 && windows.includes(window) &&
    ((command === 'freeze' && uuid.test(target)) || (['deliver', 'repeat-once'].includes(command) && digest.test(target))), 'crm023_arguments_invalid');
  const binding = requireEndpoints();
  await mkdir(directory, { recursive: true });
  const pool = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL, max: 2, connectionTimeoutMillis: 5000,
    query_timeout: 5000, statement_timeout: 5000, ...(command === 'freeze' ? { options: '-c default_transaction_read_only=on' } : {}) });
  pool.on('error', () => {});
  try {
    await assertDatabase(pool);
    if (command === 'freeze') { console.info(JSON.stringify(await freeze(pool, window, target))); return; }
    assert(process.env.CRM023_OBSERVATION_EXECUTE === target, 'crm023_exact_frozen_window_required');
    if (command === 'repeat-once') {
      const replay = await repeatOnce(pool, binding, window, target);
      console.info(JSON.stringify(replay));
      if (!replay.pass) process.exitCode = 1;
      return;
    }
    const plan = await load(`window-${window}-plan.json`, target);
    assert(plan.window === window && plan.org === org && plan.databaseId === databaseId && uuid.test(plan.runId) &&
      stringify(plan.sourceHash) === stringify(await sourceManifest()),
    'crm023_exact_frozen_window_required');
    const report = { window, runId: plan.runId, planHash: target, startedAt: new Date().toISOString(),
      dispatch: [], observations: [], isolation: { newModel: false, crmBusinessWrite: false, dispatcherUsesFrozenIds: true } };
    await seal(`window-${window}-intent.json`, { runId: plan.runId, planHash: target, at: report.startedAt });
    const started = performance.now();
    try { report.pass = await runWindow(pool, binding, plan, report); }
    catch (error) { report.pass = false; report.error = safe(error); }
    report.finishedAt = new Date().toISOString();
    report.elapsedMs = Math.round(performance.now() - started);
    const artifact = await seal(`window-${window}-report.json`, report);
    console.info(JSON.stringify({ ...artifact, pass: report.pass, window, runId: plan.runId,
      error: report.error, spans: report.readback?.trace.observationCount, scores: report.readback?.scores.count,
      accepted: report.dispatch.filter(item => item.accepted).length }));
    if (!report.pass) process.exitCode = 1;
  } finally { await pool.end(); }
}

main().catch(error => { console.error(JSON.stringify({ error: safe(error) })); process.exitCode = 1; });
