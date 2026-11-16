import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { ROOT, digest, optional } from './crm024-fixtures.mjs';
import { scopedTransaction } from './crm025-materials-context.mjs';
import { dbIdentity, MEMORY_ROOT, readEnvironmentTarget } from './crm026-memory-environment-config.mjs';

const SOURCE = resolve(ROOT, '.local/crm022/stack/supabase');
const CLI = resolve(ROOT, '.local/tools/supabase-v2.122.0/bin/supabase.exe');
const STACK = resolve(MEMORY_ROOT, 'stack');
const CLI_HOME = resolve(STACK, 'cli-home');
const SUPABASE = resolve(STACK, 'supabase');
const TARGET = resolve(STACK, 'status.private.env');
const CONFIG = resolve(SUPABASE, 'config.toml');
const BASELINE = resolve(ROOT, 'supabase/baseline.sql');
const PROOF = resolve(STACK, 'schema.json');
const INTENT = resolve(STACK, 'schema-intent.json');
const PROJECT = 'project-crm-eval-026';
const CONTAINER = `supabase_db_${PROJECT}`;
const NETWORK = `supabase_network_${PROJECT}`;
const SUBNET = '10.217.26.0/24';
const LEGACY_DB = '7708392892596248609';
const cliEnv = { SUPABASE_HOME: CLI_HOME, SUPABASE_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1' };
const unusedServices = 'imgproxy,mailpit,postgres-meta,studio,edge-runtime,logflare,vector,supavisor';

async function writeExact(path, data) {
  try {
    await writeFile(path, data, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    assert((await readFile(path)).equals(Buffer.from(data)), 'crm026_memory_stack_file_drift');
  }
}

async function prepare() {
  const original = await readFile(resolve(SOURCE, 'config.toml'), 'utf8');
  assert(original.includes('project_id = "project-crm-eval-1115"') &&
    /\[db\.migrations\]\r?\nenabled = false/.test(original), 'crm026_memory_stack_source_identity');
  const ports = { '55520': '55530', '55521': '55531', '55522': '55532', '55523': '55533', '55524': '55534', '55529': '55539' };
  const changed = original.replace('project_id = "project-crm-eval-1115"', `project_id = "${PROJECT}"`)
    .replace(/\b5552[0-9]\b/g, value => ports[value] ?? value);
  const templates = resolve(SUPABASE, 'templates');
  await mkdir(templates, { recursive: true });
  for (const name of ['confirmation.html', 'recovery.html'])
    await writeExact(resolve(templates, name), await readFile(resolve(SOURCE, 'templates', name)));
  await writeExact(CONFIG, changed);
  return { project: PROJECT, workdir: STACK, environment: cliEnv,
    createNetwork: ['docker', 'network', 'create', '--driver', 'bridge', '--subnet', SUBNET,
      '--label', 'com.crm-evaluation=CRM-026', NETWORK],
    command: [CLI, 'start', '--workdir', STACK, '--network-id', NETWORK, '--exclude', unusedServices],
    configHash: digest(changed) };
}

async function status() {
  const configured = await readFile(CONFIG, 'utf8');
  assert(configured.includes(`project_id = "${PROJECT}"`) && configured.includes('port = 55531') &&
    configured.includes('port = 55532'), 'crm026_memory_stack_target_config');
  const result = spawnSync(CLI, ['status', '--output', 'env', '--workdir', STACK],
    { cwd: ROOT, windowsHide: true, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...cliEnv } });
  assert(result.status === 0 && !result.error, 'crm026_memory_stack_status_failed');
  const privateEnv = parseEnv(result.stdout);
  const keys = {
    DB_URL: privateEnv.DB_URL,
    API_URL: privateEnv.API_URL,
    ANON_KEY: privateEnv.ANON_KEY ?? privateEnv.PUBLISHABLE_KEY,
    SERVICE_ROLE_KEY: privateEnv.SERVICE_ROLE_KEY ?? privateEnv.SECRET_KEY,
  };
  assert(Object.values(keys).every(value => typeof value === 'string' && value.length && !/['\r\n]/.test(value)) &&
    new URL(keys.DB_URL).port === '55532' && new URL(keys.API_URL).port === '55531', 'crm026_memory_stack_status_ports');
  const raw = Object.entries(keys).map(([key, value]) => `${key}='${value}'`).join('\n') + '\n';
  await writeExact(TARGET, raw);
  await readEnvironmentTarget(TARGET);
  return { target: TARGET, targetHash: digest(raw) };
}

const extensions = `create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists vector with schema public;
create extension if not exists citext with schema public;
create extension if not exists pg_trgm with schema public;
`;
const psql = ['exec', '-i', CONTAINER, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'];

function applySchema() {
  return new Promise((done, fail) => {
    const child = spawn('docker', [...psql, '--single-transaction', '-q', '-f', '-'],
      { cwd: ROOT, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    let diagnostic = Buffer.alloc(0);
    child.stderr.on('data', chunk => {
      diagnostic = Buffer.concat([diagnostic, chunk]).subarray(-65_536);
    });
    child.on('error', fail);
    child.once('close', (code, signal) => done({ code, signal, diagnostic }));
    child.stdin.on('error', () => {});
    child.stdin.write(extensions);
    const baseline = createReadStream(BASELINE);
    baseline.on('error', error => {
      child.stdin.destroy();
      fail(error);
    });
    baseline.pipe(child.stdin);
  });
}

async function schema() {
  const target = await readEnvironmentTarget(TARGET);
  assert(target.mode === 'fresh', 'crm026_memory_stack_fresh_required');
  const options = { connectionString: target.dbUrl };
  const databaseId = await scopedTransaction(options, true, dbIdentity);
  assert(databaseId !== LEGACY_DB, 'crm026_memory_stack_identity_conflict');
  const check = spawnSync('docker', [...psql, '-A', '-t', '-c', 'select system_identifier::text from pg_control_system()'],
    { cwd: ROOT, windowsHide: true, encoding: 'utf8', timeout: 15_000 });
  assert(check.status === 0 && check.stdout.trim() === databaseId, 'crm026_memory_stack_container_identity');
  const old = await optional(PROOF);
  const identity = { project: PROJECT, databaseId, targetHash: target.targetHash, baselineHash: digest(await readFile(BASELINE)) };
  if (old) {
    assert(Object.entries(identity).every(([key, value]) => old[key] === value), 'crm026_memory_stack_schema_proof_drift');
    return old;
  }
  const [state] = await scopedTransaction(options, true, q => q(`select to_regclass('public.organizations') crm_table,
    (select count(*)::int from auth.users) auth_count`));
  const previousIntent = await optional(INTENT);
  if (previousIntent) {
    assert(Object.entries(identity).every(([key, value]) => previousIntent[key] === value), 'crm026_memory_stack_schema_intent_drift');
  } else {
    assert(state.crm_table === null, 'crm026_memory_stack_schema_requires_empty_target');
    await writeExact(INTENT, JSON.stringify(identity, null, 2) + '\n');
  }
  assert(state.auth_count === 0, 'crm026_memory_stack_schema_requires_no_actors');
  if (state.crm_table === null) {
    const applied = await applySchema();
    const diagnostic = resolve(STACK, `schema-${digest(applied.diagnostic).slice(0, 16)}.private.log`);
    await writeExact(diagnostic, applied.diagnostic);
    assert(applied.code === 0, 'crm026_memory_stack_schema_failed');
  }
  const [ready] = await scopedTransaction(options, true, q => q(`select
    (select count(*)::int from organizations) orgs,
    (select count(*)::int from job_queue) jobs,
    (select count(*)::int from event_log) events,
    exists(select 1 from ai_models where provider='dashscope' and model_id='qwen3.8-flash' and supports_tools and deprecated_at is null) model,
    to_regclass('public.ai_customer_memories') is not null memory`));
  assert(ready.orgs === 0 && ready.jobs === 0 && ready.events === 0 && ready.model && ready.memory,
    'crm026_memory_stack_schema_not_ready');
  const proof = { ...identity, ...ready };
  await writeExact(PROOF, JSON.stringify(proof, null, 2) + '\n');
  return proof;
}

const commands = { prepare, status, schema };
const command = process.argv[2];
if (!Object.hasOwn(commands, command)) throw new Error('crm026_memory_stack_command_required');
commands[command]().then(result => console.log(JSON.stringify(result))).catch(error => {
  const code = /^[A-Z0-9_]{2,20}$|^crm026_memory_[a-z_]+$/;
  console.error([error?.code, error?.message].find(value => typeof value === 'string' && code.test(value)) ??
    'crm026_memory_stack_failed');
  process.exitCode = 1;
});
