import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv, isDeepStrictEqual as same } from 'node:util';
import { createServerClient } from '@supabase/ssr';
import pg from 'pg';
import { ROOT, context as priorContext, digest, optional, read, sha, uuid } from './crm024-fixtures.mjs';

export const MATERIAL_ROOT = resolve(ROOT, '.local/crm025');
export const DATASET_HASH = '590763cfffe722245effda31516e880e617fc0cf10351d98c28c89d18690f5ac';
export const BASELINE = '2d5d411223e68fef47a41c064040baf6d7c4056d';
export const RUNTIME_FILE = resolve(MATERIAL_ROOT, 'runtime.env');
export const FIXTURE_FILE = resolve(MATERIAL_ROOT, 'fixtures.json');
export const PREFLIGHT_FILE = resolve(MATERIAL_ROOT, 'preflight.json');
export const RECOVERED_RUNTIME_FILE = resolve(MATERIAL_ROOT, 'runtime-recovered.env');
export const RECOVERED_FIXTURE_FILE = resolve(MATERIAL_ROOT, 'fixtures-recovered.json');
export const RECOVERED_PREFLIGHT_FILE = resolve(MATERIAL_ROOT, 'preflight-recovered.json');
export const PLAN_FILE = resolve(MATERIAL_ROOT, 'materials-plan.json');
export const OLD_ACTORS = resolve(ROOT, '.local/crm022/actors.private.json');
export const SALES_ACTOR = resolve(MATERIAL_ROOT, 'sales-actor.private.json');
export const WORKBENCH = '/api/v1/ai/workbench/runs';
export const WIKI_ORIGIN = 'http://127.0.0.1:8088';
export const AUTH_ORIGIN = 'http://127.0.0.1:55521';
export const WEB_ORIGIN = 'http://localhost:3415';

export async function read025Dataset() {
  const dataset = await read(resolve(ROOT, 'docs/evaluation/CRM-025-cases.json'), DATASET_HASH);
  assert.equal(dataset.baselineCommit, BASELINE);
  assert.equal(dataset.cases.length, 24);
  assert.equal(dataset.corpus.filter(row => row.organizationId === 'org_alpha' && row.state === 'published').length, 28);
  assert.equal(dataset.corpus.length, 31);
  return { dataset, datasetHash: DATASET_HASH };
}

/** Attach the frozen clock equally to both arms and versions, without oracle or slot metadata. */
export function makeScopeTask(item, _scope, dataset) {
  const { businessDate, timezone, workingDays, countingRule } = dataset.businessClock;
  return `${item.task}\n\n业务日期 ${businessDate}（${timezone}）。以下为本次业务排期使用的工作日：${workingDays.join('、')}。${countingRule}`;
}

/** Uses a new connection with an explicit transaction and no implicit write retry. */
export async function scopedTransaction(options, readOnly, action) {
  const pool = new pg.Pool({ ...options, max: 1, connectionTimeoutMillis: 5000,
    statement_timeout: 15000, query_timeout: 18000, ...(readOnly ? { options: '-c default_transaction_read_only=on' } : {}) });
  pool.on('error', () => {});
  let client;
  try {
    client = await pool.connect();
    await client.query(readOnly ? 'begin isolation level repeatable read read only' : 'begin isolation level serializable');
    await client.query("set local lock_timeout='5s'");
    const q = async (statement, parameters = []) => {
      assert(!readOnly || /^\s*(select|with)\b/i.test(statement), 'crm025_read_only_sql_required');
      return (await client.query(statement, parameters)).rows;
    };
    const result = await action(q);
    await client.query('commit');
    return result;
  } finally {
    try { if (client) { try { await client.query('rollback'); } finally { client.release(); } } }
    finally { await pool.end(); }
  }
}

export async function crm025Context({ prepare = false, recovered = false } = {}) {
  assert(!prepare || !recovered, 'crm025_incompatible_environment_mode');
  const prior = await priorContext();
  const plan = await optional(PLAN_FILE);
  const fixture = await optional(recovered ? RECOVERED_FIXTURE_FILE : FIXTURE_FILE);
  const raw = prepare ? null : await readFile(recovered ? RECOVERED_RUNTIME_FILE : RUNTIME_FILE, 'utf8');
  const env = raw === null ? prior.env : parseEnv(raw);
  const environmentHash = raw === null ? null : digest(raw);
  assert(new URL(env.SUPABASE_DB_URL).host === '127.0.0.1:55522' &&
    new URL(env.NEXT_PUBLIC_SUPABASE_URL).origin === AUTH_ORIGIN && new URL(env.NEXT_PUBLIC_APP_URL).origin === WEB_ORIGIN &&
    env.NODE_ENV === 'development' && env.INTERNAL_AGENT_RUN_STUB !== 'true' &&
    ['SUPABASE_DB_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'NEXT_PUBLIC_APP_URL',
      'CRM_LOCAL_WORKBENCH_UNPRICED_MODE'].every(name => env[name] === prior.env[name]), 'crm025_unexpected_runtime_environment');
  if (!prepare) {
    const bind = JSON.parse(env.AI_INTEGRATION_BINDINGS);
    assert(fixture && plan && fixture.datasetHash === DATASET_HASH && fixture.org === prior.org &&
      fixture.betaOrg === plan.betaOrg && fixture.environmentHash === environmentHash &&
      bind.length === 1 && bind[0].organization_id === prior.org && bind[0].provider === 'weknora' &&
      new URL(bind[0].base_url).origin === WIKI_ORIGIN && bind[0].visibility === 'organization' &&
      typeof bind[0].api_key === 'string' && same(bind[0].knowledge_base_ids, [plan.kb.current]), 'crm025_exact_private_binding_required');
    if (recovered) {
      assert(sha.test(fixture.recovery?.originalFixtureHash ?? ''), 'crm025_recovered_fixture_identity_required');
      const original = await read(FIXTURE_FILE, fixture.recovery.originalFixtureHash);
      assert(fixture.keyId !== original.keyId && fixture.agent.versionId !== original.agent.versionId &&
        fixture.planHash === original.planHash && ['slots', 'pages', 'sourceIds', 'actorScopes', 'businessClock'].every(field =>
          same(fixture[field], original[field])), 'crm025_recovered_environment_drift');
    }
  }
  return { ...prior, env, environmentHash, envHash: environmentHash, organizationId: prior.org,
    betaOrg: plan?.betaOrg ?? null, plan, fixture, recovered };
}

export async function loadMaterials(fixtureHash, { recovered = false } = {}) {
  const [c, data, materials] = await Promise.all([crm025Context({ recovered }), read025Dataset(),
    read(recovered ? RECOVERED_FIXTURE_FILE : FIXTURE_FILE, fixtureHash)]);
  assert.equal(materials.environmentHash, c.environmentHash);
  return { ...c, ...data, materials, slots: materials.slots, agent: materials.agent };
}

export async function crm025Transaction(c, readOnly, action, { initial = false } = {}) {
  return scopedTransaction({ connectionString: c.env.SUPABASE_DB_URL }, readOnly, async q => {
    const [owner] = await q(`select current_database() name,system_identifier::text instance,
      (select array_agg(id order by id)::text[] from organizations) orgs,
      (select slug::text from organizations where id=$1::uuid) slug,
      (select slug::text from organizations where id=$3::uuid) beta_slug,
      (select role from user_organizations where organization_id=$1::uuid and user_id=$2::uuid and revoked_at is null and accepted_at is not null) role
      from pg_control_system()`, [c.org, c.initiatorUserId, c.betaOrg]);
    const expectedOrgs = initial ? [c.org] : [c.org, c.betaOrg].sort();
    assert(owner.name === 'postgres' && owner.instance === c.databaseId && owner.slug === 'crm022-synthetic-eval' &&
      ['admin', 'manager'].includes(owner.role) && same(owner.orgs, expectedOrgs) &&
      (initial || owner.beta_slug === c.plan.betaSlug), 'crm025_exact_isolated_crm_required');
    return action(q);
  });
}

export async function crm025Transport(c, slot, action) {
  const actor = slot.actor ?? 'initiator';
  assert(['initiator', 'sales'].includes(actor));
  const credential = actor === 'sales' ? await read(SALES_ACTOR) : (await read(OLD_ACTORS)).initiator;
  assert(credential.id === slot.actorUserId && uuid.test(credential.id) &&
    (actor === 'sales' ? credential.id === c.fixture?.actorScopes.sales.id : credential.id === c.initiatorUserId), 'crm025_actor_manifest_mismatch');
  const cookies = new Map();
  const auth = createServerClient(AUTH_ORIGIN, c.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => Array.from(cookies, ([name, value]) => ({ name, value })),
      setAll: values => {
        for (const { name, value } of values) {
          if (value) cookies.set(name, value);
          else cookies.delete(name);
        }
      },
    },
    cookieOptions: { name: 'sb-pi-native-auth' },
    global: { fetch: (request, init = {}) => fetch(request, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) }) },
  });
  const login = await auth.auth.signInWithPassword({ email: credential.email, password: credential.password });
  assert(!login.error && login.data.user?.id === credential.id, 'crm025_actor_login_failed');
  const current = await auth.auth.getUser();
  assert(!current.error && current.data.user?.id === credential.id, 'crm025_actor_verification_failed');
  cookies.set('active_org', c.org);
  async function request(path, method, data) {
    const targetId = path.split('/').at(-1);
    const scopedRead = path === `/api/v1/contacts/${slot.contactId}` || path === `/api/v1/leads/${slot.leadId}`;
    const sourceRead = c.fixture?.pages && Object.values(c.fixture.pages).some(row => path === `/api/v1/ai/knowledge/sources/${row.sourceId}`);
    const evidenceRead = path === `/api/v1/ai/integrations/wiki/evidence/${targetId}` && uuid.test(targetId) && slot.evidenceIds?.includes(targetId);
    const withdrawal = path === `/api/v1/ai/knowledge/sources/${c.plan?.source.withdrawn}` && slot.canWithdraw === true && actor === 'initiator';
    assert((method === 'POST' && path === WORKBENCH && slot.contactId && data?.mode === 'inspect' &&
      data.scope?.contactId === slot.contactId && data.scope?.leadId === slot.leadId && data.scope?.pipelineId === slot.pipelineId) ||
      (method === 'GET' && (scopedRead || sourceRead || evidenceRead || path === WORKBENCH)) ||
      (method === 'DELETE' && withdrawal), 'crm025_transport_route_not_authorized');
    const headers = { Origin: WEB_ORIGIN, Cookie: Array.from(cookies, ([name, value]) => `${name}=${encodeURIComponent(value)}`).join('; ') };
    if (data) headers['Content-Type'] = 'application/json';
    const response = await fetch(WEB_ORIGIN + path, { method, headers, redirect: 'manual', signal: AbortSignal.timeout(90000),
      ...(data ? { body: JSON.stringify(data) } : {}) });
    const body = await response.json().catch(() => null);
    return { httpStatus: response.status, data: body?.data ?? null,
      errorCode: body?.error?.code ?? null, requestId: body?.meta?.request_id ?? response.headers.get('x-request-id') };
  }
  return action(request, auth);
}
