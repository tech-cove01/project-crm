import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual as same, parseEnv } from 'node:util';
import { ROOT, digest, optional, read, sha, uuid } from './crm024-fixtures.mjs';
import { scopedTransaction } from './crm025-materials-context.mjs';

export const MEMORY_ROOT = resolve(ROOT, '.local/crm026/memory');
export const FILES = Object.fromEntries(Object.entries({
  intent: 'setup-intent.json',
  actors: 'actors.private.json',
  runtime: 'runtime.env.json',
  fixture: 'fixture.json',
  profiles: 'profiles.json',
}).map(([name, path]) => [name, resolve(MEMORY_ROOT, path)]));
export const ARMS = ['none', 'sql', 'mem0'];
export const CHECKS = { 'M-A': ['A1', 'A2', 'A3'], 'M-B': ['B1', 'B2'], 'M-C': ['C1'] };
export const PRODUCT_COMMIT = '1561dacd949c64b773846c89522228cb478e4b1c';
export const MODEL = { provider: 'dashscope', model: 'qwen3.8-flash', temperature: 0, maxSteps: 12, tokenBudget: 36_000 };
export const WEB = 'http://localhost:3415';
export const MEM0 = 'http://127.0.0.1:8888';
const LEGACY_DB = '7708392892596248609';
const LEGACY_ROOT = resolve(ROOT, '.local/crm022/runtime.env');
const LEGACY_ORG = 'crm022-synthetic-eval';

const boundedText = (value, limit) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit;

export function validateMemoryInput(input) {
  assert(input?.version === 'crm026-memory-v1' && input.productCommit === PRODUCT_COMMIT &&
    Array.isArray(input.trajectories) && same(input.trajectories.map(row => row.id), Object.keys(CHECKS)),
  'crm026_memory_input_identity');
  for (const trajectory of input.trajectories) {
    assert(boundedText(trajectory.customerName, 150) &&
      Array.isArray(trajectory.history) && trajectory.history.length >= 1 && trajectory.history.length <= 40 &&
      trajectory.history.every(body => boundedText(body, 4000)) &&
      Array.isArray(trajectory.checks) && same(trajectory.checks.map(row => row.id), CHECKS[trajectory.id]) &&
      trajectory.checks.every(row => boundedText(row.task, 8000) && row.task === row.task.trim()),
    'crm026_memory_input_trajectory');
    const decoys = trajectory.decoys ?? [];
    assert(Array.isArray(decoys) && decoys.length <= 4 &&
      new Set(decoys.map(row => row.id)).size === decoys.length &&
      decoys.every(row => /^[a-z][a-z0-9-]{0,30}$/.test(row.id) && row.id !== 'selected' && boundedText(row.name, 150)),
    'crm026_memory_input_decoys');
    if (trajectory.id === 'M-C')
      assert(decoys.some(row => row.name === trajectory.customerName), 'crm026_memory_same_name_missing');
  }
  return input;
}

export async function seal(path, object) {
  const raw = JSON.stringify(object, null, 2) + '\n';
  await writeFile(path, raw, { flag: 'wx', mode: 0o600 });
  return digest(raw);
}

function localDb(value, port) {
  const url = new URL(value);
  assert(['postgres:', 'postgresql:'].includes(url.protocol) && ['localhost', '127.0.0.1'].includes(url.hostname) &&
    url.port === port && url.pathname === '/postgres' && url.username === 'postgres' && url.password &&
    !url.search && !url.hash, 'crm026_memory_database_url');
  return url.href;
}

function localApi(value, port) {
  const url = new URL(value);
  assert(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) && url.port === port &&
    url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash, 'crm026_memory_auth_url');
  return url.origin;
}

export async function readEnvironmentTarget(path) {
  const raw = await readFile(path, 'utf8');
  const cli = path.endsWith('.json') ? JSON.parse(raw) : parseEnv(raw);
  const mode = cli.mode ?? 'fresh';
  assert(mode === 'fresh' || mode === 'legacy-scoped', 'crm026_memory_target_mode');
  const [authPort, dbPort] = mode === 'fresh' ? ['55531', '55532'] : ['55521', '55522'];
  const data = {
    mode,
    dbUrl: localDb(cli.DB_URL, dbPort),
    authOrigin: localApi(cli.API_URL, authPort),
    anon: cli.ANON_KEY ?? cli.PUBLISHABLE_KEY,
    service: cli.SERVICE_ROLE_KEY ?? cli.SECRET_KEY,
  };
  assert(boundedText(data.anon, 8192) && boundedText(data.service, 8192) && data.anon !== data.service,
    'crm026_memory_target_auth_credentials');
  return { ...data, targetHash: digest(raw) };
}

export async function dbIdentity(q) {
  const [row] = await q('select current_database() database, system_identifier::text id from pg_control_system()');
  assert(row?.database === 'postgres' && /^[0-9]+$/.test(row.id), 'crm026_memory_database_identity');
  return row.id;
}

export async function guardMemoryDatabase(q, mode, databaseId, batch = null, { allowDeferredGeneralization = false } = {}) {
  assert(await dbIdentity(q) === databaseId && (mode === 'legacy-scoped') === (databaseId === LEGACY_DB),
    'crm026_memory_database_mismatch');
  const orgs = await q("select id,slug,settings->>'crm026' batch from organizations order by id");
  const setup = batch?.arms ? Object.values(batch.arms) : [];
  const owned = orgs.filter(row => setup.some(arm => arm.organizationId === row.id && arm.slug === row.slug && row.batch === batch.batch));
  const allowedGeneralization = allowDeferredGeneralization ? orgs.filter(row => row.batch === batch.batch &&
    row.slug === `crm026-${batch.batch.slice(0, 8)}-generalization`) : [];
  assert(allowedGeneralization.length <= 1 &&
    orgs.length === owned.length + allowedGeneralization.length + Number(mode === 'legacy-scoped') &&
    (mode !== 'legacy-scoped' || orgs.filter(row => row.slug === LEGACY_ORG).length === 1),
  'crm026_memory_unowned_organizations');
  return { owned, orgs };
}

/** A full product Worker claims across its database. Legacy reuse is only
 * eligible for a scoped Workbench consumer and must never start that Worker. */
export async function guardForeignWork(q, mode, validOrgIds) {
  const [state] = await q(`select
    exists(select 1 from job_queue where status in ('pending','running') and not coalesce(organization_id=any($1::uuid[]),false)) as foreign_jobs,
    exists(select 1 from event_log where status in ('pending','processing') and not coalesce(organization_id=any($1::uuid[]),false)) as foreign_events`,
  [validOrgIds]);
  assert(!state.foreign_jobs && (mode === 'legacy-scoped' || !state.foreign_events), 'crm026_memory_unowned_queue');
  return { unownedEventsPresent: state.foreign_events, fullWorkerAllowed: mode === 'fresh' };
}

export async function sourceLlm() {
  const privateEnv = parseEnv(await readFile(LEGACY_ROOT, 'utf8'));
  const connectionString = localDb(privateEnv.SUPABASE_DB_URL, '55522');
  assert(boundedText(privateEnv.AI_CRED_AES_KEY, 4096), 'crm026_memory_aes_key');
  const bindings = JSON.parse(privateEnv.AI_INTEGRATION_BINDINGS);
  assert(Array.isArray(bindings), 'crm026_memory_old_bindings');
  const binding = bindings.filter(row => row.provider === 'mem0');
  assert(binding.length === 1 && uuid.test(binding[0].organization_id) && binding[0].base_url === MEM0 &&
    boundedText(binding[0].api_key, 4096), 'crm026_memory_local_mem0_binding');
  const [credential] = await scopedTransaction({ connectionString }, true, async q => {
    assert(await dbIdentity(q) === LEGACY_DB, 'crm026_memory_credential_source_identity');
    return q(`select c.api_key_encrypted,c.api_key_iv,c.api_key_tag,c.api_key_last4,c.validated_at
      from ai_provider_credentials c join organizations o on o.id=c.organization_id
      where o.id=$1 and o.slug=$2 and c.provider=$3 and c.is_active and c.validated_at is not null
      order by c.validated_at desc limit 1`, [binding[0].organization_id, LEGACY_ORG, MODEL.provider]);
  });
  assert(credential?.api_key_encrypted?.length && credential.api_key_iv?.length && credential.api_key_tag?.length,
    'crm026_memory_credential_missing');
  return { credential, aesKey: privateEnv.AI_CRED_AES_KEY, mem0Key: binding[0].api_key };
}

export function buildRuntime(target, intent, source) {
  const entries = [
    { organization_id: intent.arms.mem0.organizationId, provider: 'mem0', base_url: MEM0, api_key: source.mem0Key },
  ];
  return {
    NODE_ENV: 'development',
    NEXT_PUBLIC_SUPABASE_URL: target.authOrigin,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: target.anon,
    SUPABASE_SERVICE_ROLE_KEY: target.service,
    SUPABASE_DB_URL: target.dbUrl,
    NEXT_PUBLIC_APP_URL: WEB,
    AI_CRED_AES_KEY: source.aesKey,
    AI_INTEGRATION_BINDINGS: JSON.stringify(entries),
    INTERNAL_SECRET: intent.internalSecret,
    INTERNAL_CRON_SECRET: intent.cronSecret,
    INTERNAL_AGENT_RUN_STUB: 'false',
    NEXT_TELEMETRY_DISABLED: '1',
    CRM_LOCAL_WORKBENCH_UNPRICED_MODE: 'true',
    HEALTH_HOST: '127.0.0.1',
    HEALTH_PORT: '8795',
    QUEUE_MAX_CONCURRENCY: '1',
    QUEUE_POLL_INTERVAL_MS: '1000',
    SENTRY_DSN: 'off',
    NEXT_PUBLIC_SENTRY_DSN: '',
  };
}

export async function loadMemoryEnvironment(fixtureHash, { profilesHash: expectedProfilesHash } = {}) {
  assert(sha.test(fixtureHash ?? ''), 'crm026_memory_fixture_hash_required');
  const fixture = await read(FILES.fixture, fixtureHash);
  const env = await read(FILES.runtime, fixture.environmentHash);
  const actors = await read(FILES.actors, fixture.actorsHash);
  const mode = fixture.database.mode;
  assert(mode === 'fresh' || mode === 'legacy-scoped', 'crm026_memory_target_mode');
  const [authPort, dbPort] = mode === 'fresh' ? ['55531', '55532'] : ['55521', '55522'];
  const bindings = JSON.parse(env.AI_INTEGRATION_BINDINGS);
  assert(fixture.productCommit === PRODUCT_COMMIT && env.NEXT_PUBLIC_APP_URL === WEB &&
    env.QUEUE_MAX_CONCURRENCY === '1' && env.INTERNAL_AGENT_RUN_STUB === 'false' &&
    localDb(env.SUPABASE_DB_URL, dbPort) && localApi(env.NEXT_PUBLIC_SUPABASE_URL, authPort) &&
    bindings.length === 1 && bindings[0].organization_id === fixture.arms.mem0.organizationId &&
    bindings[0].provider === 'mem0' && bindings[0].base_url === MEM0 &&
    Object.keys(fixture.slots).length === 18 && ARMS.every(arm => fixture.arms[arm].actorUserId === actors[arm].id),
  'crm026_memory_runtime_drift');
  const profiles = expectedProfilesHash ? await read(FILES.profiles, expectedProfilesHash) : await optional(FILES.profiles);
  const profilesHash = profiles ? digest(await readFile(FILES.profiles)) : null;
  assert(!expectedProfilesHash || profilesHash === expectedProfilesHash, 'crm026_memory_profile_hash_drift');
  if (profiles) assert(profiles.fixtureHash === fixtureHash && profiles.environmentHash === fixture.environmentHash &&
    same(Object.keys(profiles.profiles), ARMS), 'crm026_memory_profile_receipt_binding');
  return { fixture, fixtureHash, environmentHash: fixture.environmentHash, env, actors, profiles, profilesHash };
}

export function memoryTransaction(c, readOnly, action) {
  return scopedTransaction({ connectionString: c.env.SUPABASE_DB_URL }, readOnly, async q => {
    const { owned } = await guardMemoryDatabase(q, c.fixture.database.mode, c.fixture.database.id, c.fixture,
      { allowDeferredGeneralization: readOnly });
    assert(owned.length === ARMS.length, 'crm026_memory_arm_missing');
    return action(q);
  });
}
