import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual as same, parseEnv } from 'node:util';
import { createServerClient } from '@supabase/ssr';
import pg from 'pg';
import { HARNESS_PREFIX, MOVE, READ_FOLLOWUPS, READ_LEAD, review, stageEffect, tasks, unchanged, uuid } from './crm022-sales-checks.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const DATA = resolve(ROOT, '.local/crm022/sales');
const RUNS = '/api/v1/ai/workbench/runs';
const WEB = 'http://localhost:3415';
const AUTH = 'http://127.0.0.1:55521';
const PHASES = ['advice', 'approve', 'reject'];
const TERMINAL = new Set(['completed','partial','failed','cancelled']);
const MAX_POLLS = 150;

function check(value, code) { if (!value) throw new Error(code); }
const digest = value => createHash('sha256').update(value).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const hash = async path => digest(await readFile(path));
const stamp = () => new Date().toISOString();
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout: 15000, windowsHide: true }).trim();
const one = rows => { check(rows.length === 1, 'expected_one_row'); return rows[0]; };

function source(expected) {
  const inputs = ['app', 'lib', 'workers', 'supabase', 'components', 'hooks', 'infra', 'package.json', 'pnpm-lock.yaml', 'proxy.ts', 'next.config.ts'];
  check(git('status', '--porcelain', '--untracked-files=all', '--', ...inputs) === '', 'runtime_source_changed');
  if (expected) check(git('diff', '--name-only', expected, 'HEAD', '--', ...inputs) === '', 'runtime_head_changed');
  return git('rev-parse', 'HEAD');
}

async function input(path, expectedHash) {
  const bytes = await readFile(path);
  check(!expectedHash || digest(bytes) === expectedHash, 'input_sha256_mismatch');
  return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
}

async function artifact(dir, name, value, output = true) {
  const bytes = json(value), path = resolve(dir, name);
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  const receipt = { path, sha256: digest(bytes) };
  if (output) console.info(JSON.stringify(receipt));
  return receipt;
}

async function validateFingerprint(q, f) {
  const row = one(await q('select current_database() db, (select system_identifier::text from pg_control_system()) system_identifier'));
  check(row.db === f.dbName && row.system_identifier === f.dbSystemIdentifier, 'isolated_database_fingerprint_mismatch');
}

async function readonly(env, f, action) {
  const pool = new pg.Pool({ connectionString: env.SUPABASE_DB_URL, max: 1, options: '-c default_transaction_read_only=on',
    connectionTimeoutMillis: 5000, statement_timeout: 10000, query_timeout: 12000 });
  let disconnected = false, client;
  pool.on('error', () => { disconnected = true; });
  try {
    client = await pool.connect();
    client.on('error', () => { disconnected = true; });
    await client.query('begin isolation level repeatable read read only');
    const q = async (sql, params) => {
      check(/^select\b/i.test(sql), 'readonly_select_required');
      const result = await client.query(sql, params);
      check(!disconnected, 'database_disconnected');
      return result.rows;
    };
    await validateFingerprint(q, f);
    const result = await action(q);
    await client.query('commit');
    return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
  } finally {
    try { client?.release(); } finally { await pool.end(); }
  }
}

export async function loadEnvironment() {
  const env = parseEnv(await readFile(resolve(ROOT, '.local/crm022/runtime.env'), 'utf8'));
  const db = new URL(env.SUPABASE_DB_URL);
  check(db.protocol === 'postgresql:' && ['localhost','127.0.0.1'].includes(db.hostname) && db.port === '55522' &&
    env.NEXT_PUBLIC_APP_URL === WEB && new URL(env.NEXT_PUBLIC_SUPABASE_URL).origin === AUTH && typeof env.NEXT_PUBLIC_SUPABASE_ANON_KEY === 'string', 'isolated_ports_required');
  check(env.CRM_LOCAL_WORKBENCH_UNPRICED_MODE === 'true' && env.INTERNAL_AGENT_RUN_STUB !== 'true', 'real_finite_local_model_config_required');
  return env;
}

async function seed(env, dir, id) {
  const { initiator, decider } = await input(resolve(ROOT, '.local/crm022/actors.private.json'));
  const organizationId = env.CRM022_ORG_ID, organizationSlug = env.CRM022_ORG_SLUG;
  check(uuid(organizationId) && uuid(initiator?.id) && uuid(decider?.id) && initiator.id !== decider.id &&
    organizationSlug === 'crm022-synthetic-eval', 'isolated_org_and_actors_required');
  const f = { id, version: 1, head: source(), organizationId, organizationSlug, initiatorUserId: initiator.id, deciderUserId: decider.id,
    source: `crm022-sales:${id}`, provider: 'dashscope', model: 'qwen3.8-flash',
    leadId: randomUUID(), contactId: randomUUID(), pipelineId: randomUUID(), initialStageId: randomUUID(), targetStageId: randomUUID(), agentId: randomUUID() };
  await mkdir(dir, { recursive: true });
  await artifact(dir,'seed-intent.json',{ at: stamp(), fixture: f },false);
  const pool = new pg.Pool({ connectionString: env.SUPABASE_DB_URL, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
  pool.on('error', () => {});
  let client;
  try {
    client = await pool.connect();
    client.on('error', () => {});
    await client.query('begin');
    await client.query("set local lock_timeout='5s'");
    const { rows: identity } = await client.query(`select current_database() db,(select system_identifier::text from pg_control_system()) fingerprint,
      (select count(*)::int from organizations) organizations,
      (select slug from organizations where id=$1) slug`, [organizationId]);
    check(identity[0]?.db === 'postgres' && identity[0].organizations === 1 && identity[0].slug === organizationSlug, 'isolated_database_identity_required');
    const { rows: members } = await client.query(`select user_id from user_organizations where organization_id=$1 and user_id=any($2::uuid[])
      and revoked_at is null and accepted_at is not null and role='admin'`, [organizationId,[initiator.id,decider.id]]);
    check(members.length === 2, 'isolated_actors_membership_missing');
    f.dbName = identity[0].db;
    f.dbSystemIdentifier = identity[0].fingerprint;
    await client.query(`insert into crm_pipelines(id,organization_id,name,slug) values($1,$2,$3,$4)`,
      [f.pipelineId,organizationId,'CRM022 合成销售漏斗',`crm022-sales-${id.slice(0,8)}`]);
    await client.query(`insert into crm_stages(id,organization_id,pipeline_id,name,slug,position)
      values($1,$2,$3,'材料待核对','intake',1000),($4,$2,$3,'方案核对','preparation',2000)`, [f.initialStageId,organizationId,f.pipelineId,f.targetStageId]);
    await client.query(`insert into contacts(id,organization_id,name,source,source_metadata,created_by_user_id)
      values($1,$2,'CRM022 合成客户',$3,jsonb_build_object('synthetic',true,'batchId',$4::text),$5)`, [f.contactId,organizationId,f.source,id,initiator.id]);
    await client.query(`insert into crm_leads(id,organization_id,contact_id,pipeline_id,stage_id,title,description,source,tags,created_by_user_id)
      values($1,$2,$3,$4,$5,'CRM022 合成商机','准备内部确认所需材料与负责人。仅用于隔离测试，无客户消息或对外联系授权。',$6,$7,$8)`,
      [f.leadId,organizationId,f.contactId,f.pipelineId,f.initialStageId,f.source,['crm022-synthetic',f.source],initiator.id]);
    const prompt = '你是隔离合成环境的销售运营 Agent。根据本次实际读取提出内部建议，明确区分事实、建议与已做动作。遇到真实缺口或错误如实报告；不编造引用或审批状态。不发送任何消息。act 模式按明确请求调用 crm_move_lead_stage 暂存提案，实际批准或拒绝由 Harness 记录；决定后重新读取所选商机，禁止重提。';
    await client.query(`insert into ai_agents(id,organization_id,name,kind,model,system_prompt,created_by)
      values($1,$2,'CRM022 合成销售 Agent','mcp_agent',$3,$4,$5)`, [f.agentId,organizationId,`${f.provider}/${f.model}`,prompt,initiator.id]);
    await client.query(`insert into ai_agent_versions(id,organization_id,agent_id,version_number,system_prompt,provider,model,tool_ids,pipeline_ids,
      max_steps,token_budget,cost_budget_cents,handoff_tool_enabled,created_by)
      values($1,$2,$3,1,$4,$5,$6,$7,$8,8,16000,75,false,$9)`, [randomUUID(),organizationId,f.agentId,prompt,f.provider,f.model,[READ_LEAD,READ_FOLLOWUPS,MOVE],[f.pipelineId],initiator.id]);
    await client.query('commit');
  } catch (error) {
    if (client) await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    try { client?.release(); } finally { await pool.end(); }
  }
  await artifact(dir,'fixture.json',f);
}

function validateFixture(f, id) {
  check(f.id === id && f.version === 1 && f.source === `crm022-sales:${id}` && /^crm022[-a-z0-9]*$/.test(f.organizationSlug) &&
    ['organizationId','leadId','contactId','pipelineId','initialStageId','targetStageId','agentId','initiatorUserId','deciderUserId']
      .every(key => uuid(f[key])) && f.initialStageId !== f.targetStageId &&
    f.provider === 'dashscope' && f.model === 'qwen3.8-flash' && /^[0-9]+$/.test(f.dbSystemIdentifier) &&
    f.dbName === 'postgres' && /^[a-f0-9]{40}$/.test(f.head), 'invalid_sales_fixture');
}

async function readConfig(q, f) {
  const org = one(await q("select id,slug,settings->'llm'->>'provider' provider,settings->'llm'->>'default_model' model from organizations where id=$1 and slug=$2", [f.organizationId,f.organizationSlug]));
  const agent = one(await q(`select a.id,a.origin,a.builtin_key,a.builtin_revision,a.operation_mode, v.id version_id,v.version_number,v.status version_status,v.provider,v.model,v.tool_ids,
    v.knowledge_source_ids,v.pipeline_ids,v.max_steps,v.token_budget,v.cost_budget_cents,md5(v.system_prompt) system_prompt_hash
    from ai_agents a join lateral (select * from ai_agent_versions v where v.organization_id=a.organization_id and v.agent_id=a.id
      and (a.origin='builtin' or a.published_version_id is null or v.id=a.published_version_id) order by version_number desc limit 1) v on true
    where a.organization_id=$1 and a.id=$2 and a.paused_at is null and a.archived_at is null and a.is_active`, [f.organizationId,f.agentId]));
  const members = await q(`select user_id,role from user_organizations where organization_id=$1 and user_id=any($2::uuid[])
    and revoked_at is null and accepted_at is not null and role in ('admin','manager') order by user_id`, [f.organizationId,[f.initiatorUserId,f.deciderUserId]]);
  const stages = await q(`select id,pipeline_id,is_archived,is_won,is_lost from crm_stages where organization_id=$1 and pipeline_id=$2
    and id=any($3::uuid[]) order by id`, [f.organizationId,f.pipelineId,[f.initialStageId,f.targetStageId]]);
  check(org.provider === f.provider && org.model === f.model && agent.provider === f.provider && agent.model === f.model &&
    agent.pipeline_ids?.includes(f.pipelineId) && [READ_LEAD,READ_FOLLOWUPS,MOVE].every(tool => agent.tool_ids.includes(tool)) &&
    agent.max_steps > 0 && agent.max_steps <= 12 && agent.token_budget > 0 && agent.token_budget <= 36000 && agent.cost_budget_cents > 0 &&
    members.length === new Set([f.initiatorUserId,f.deciderUserId]).size && stages.length === 2 && stages.every(s => !s.is_archived && !s.is_won && !s.is_lost), 'scope_model_or_budget_preflight_failed');
  if (agent.origin !== 'builtin') check(agent.tool_ids.length === 3 && ['draft','published'].includes(agent.version_status), 'custom_agent_exact_three_tools_required');
  else check(agent.builtin_key === 'sales_operations' && agent.builtin_revision === 4, 'sales_builtin_revision_changed');
  return { org, agent, members, stages };
}

async function business(q, f) {
  const lead = one(await q(`select id,organization_id,contact_id,pipeline_id,stage_id,source,tags,status,value_cents,currency,owner_user_id,
    expected_close_date,closed_at::text,lost_reason,position_in_stage,updated_at::text,md5(coalesce(description,'')) description_hash,md5(title) title_hash,
    md5(custom_fields::text) custom_fields_hash,md5(source_metadata::text) source_metadata_hash
    from crm_leads where organization_id=$1 and id=$2 and contact_id=$3 and pipeline_id=$4 and source=$5`, [f.organizationId,f.leadId,f.contactId,f.pipelineId,f.source]));
  const activities = await q(`select id,type,actor_kind,actor_agent_id,performed_by_user_id,payload->>'from_stage_id' from_stage,
    payload->>'to_stage_id' to_stage,payload->>'pipeline_id' pipeline_id,performed_at::text from crm_lead_activities
    where organization_id=$1 and lead_id=$2 order by id`, [f.organizationId,f.leadId]);
  const followups = await q(`select id,enabled,updated_at::text from cron_jobs where organization_id=$1 and contact_id=$2
    and kind='at' and job_kind='followup_turn' order by id`, [f.organizationId,f.contactId]);
  const channels = one(await q(`select (select count(*)::int from channel_sessions where organization_id=$1) sessions,
    (select count(*)::int from conversations where organization_id=$1 and contact_id=$2) conversations,
    (select count(*)::int from messages m join conversations c on c.organization_id=m.organization_id and c.id=m.conversation_id
      where m.organization_id=$1 and c.contact_id=$2) messages`, [f.organizationId,f.contactId]));
  check(channels.sessions === 0 && channels.conversations === 0 && channels.messages === 0 && followups.length <= 5 &&
    followups.every(r => !r.enabled), 'fixture_must_have_no_channels_or_live_followups');
  return { lead, activities, followups, channels };
}

async function starts(q, f) {
  const rows = await q(`select id,status from ai_workbench_runs where organization_id=$1 and run_kind='root' and scope->>'leadId'=$2::text order by id`, [f.organizationId,f.leadId]);
  return rows;
}

async function attestIdle(q, f) {
  const row = one(await q("select count(*)::int busy from job_queue where organization_id=$1 and status in ('pending','running')", [f.organizationId]));
  check(row.busy === 0, 'isolated_organization_queue_busy');
}

async function runState(q, f, phase) {
  const expected = tasks(f)[phase];
  const runs = await q(`select id,status from ai_workbench_runs where organization_id=$1 and task=$2 and agent_id=$3 and mode=$4
    and actor_user_id=$5 and scope=$6::jsonb and run_kind='root'`, [f.organizationId,expected.task,f.agentId,expected.mode,f.initiatorUserId,JSON.stringify(expected.scope)]);
  check(runs.length <= 1, 'ambiguous_run_reconciliation');
  const run = runs[0];
  if (!run) return null;
  const job = one(await q(`select count(*) filter(where status in ('pending','running'))::int busy from job_queue
    where organization_id=$1 and payload->>'runId'=($2::uuid)::text`, [f.organizationId,run.id]));
  return { ...run, ...job };
}

async function capture(q, f, runId, verifyEmpty = false) {
  const state = await business(q, f);
  if (!runId) return { business: state, run: null };
  const ids = [f.organizationId,runId];
  const runs = await q(`select id,agent_id,actor_user_id,mission_id,parent_run_id,status,mode,scope,task,budget,final_text,
    result_document document,error_code,runtime_state->>'versionId' version_id,runtime_state->>'collaborationMode' collaboration,
    created_at::text,started_at::text,completed_at::text from ai_workbench_runs where organization_id=$1 and id=$2 and run_kind='root'`, ids);
  const run = verifyEmpty ? null : one(runs);
  if (verifyEmpty) check(runs.length === 0, 'observer_probe_identity_collision');
  const childCount = one(await q('select count(*)::int children from ai_workbench_runs where organization_id=$1 and parent_run_id=$2', ids)).children;
  const jobs = await q("select id,kind,status,attempts,created_at::text from job_queue where organization_id=$1 and payload->>'runId'=($2::uuid)::text order by id", ids);
  const proposals = await q(`select id,tool_name,jsonb_build_object('lead_id',tool_args->>'lead_id','to_stage_id',tool_args->>'to_stage_id') tool_args,
    status,decision_by,decision_at::text,result_summary from ai_agent_action_proposals where organization_id=$1 and run_id=$2 order by id`, ids);
  const events = await q(`select id,sequence,event_type,created_at::text,jsonb_strip_nulls(jsonb_build_object('tool',payload->'tool',
    'proposalId',payload->'proposalId','decision',payload->'decision','status',payload->'status','toolCallId',payload->'toolCallId',
    'actorUserId',payload->'actorUserId')) payload from ai_agent_run_events where organization_id=$1 and run_id=$2 order by sequence`, ids);
  const llm = await q(`select id,provider,model,status,purpose,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_cents
    from llm_calls where organization_id=$1 and workbench_run_id=$2 order by id`, ids);
  const scan = `from ai_agent_run_states s cross join lateral jsonb_array_elements(s.messages) with ordinality m(value,i)`;
  const scope = 's.organization_id=$1 and s.run_id=$2';
  const tools = await q(`select m.value->>'toolName' "toolName",m.value->>'toolCallId' "toolCallId",m.value->'isError' "isError",
    case when m.value->>'toolName'=any($3::text[]) then m.value->'content' end content,
    case when m.value->>'toolName'=any($3::text[]) then m.value->'details' end details
    ${scan} where ${scope} and m.value->>'role'='tool' order by m.i`, [...ids,[READ_LEAD,READ_FOLLOWUPS]]);
  const toolCalls = await q(`select t->>'id' id,t->>'name' name,t->'arguments'->>'lead_id' lead_id,t->'arguments'->>'to_stage_id' to_stage_id
    ${scan} cross join lateral jsonb_array_elements(case when jsonb_typeof(m.value->'toolCalls')='array' then m.value->'toolCalls' else '[]'::jsonb end) t
    where ${scope} and m.value->>'role'='assistant' order by m.i`, ids);
  // Return only the two known Harness fields from a matching infrastructure message. No user or assistant prose is projected here.
  const harness = await q(`select x.p[1] tool,x.p[2] status ${scan}
    cross join lateral jsonb_array_elements(case jsonb_typeof(m.value->'content') when 'array' then m.value->'content'
      when 'string' then jsonb_build_array(jsonb_build_object('type','text','text',m.value->>'content')) else '[]'::jsonb end) b
    cross join lateral (select regexp_match(substring(b->>'text' from char_length($3::text)+1),
      '^\{"tool":"(crm_move_lead_stage)","status":"(executed|rejected|failed)"[},]') p) x
    where ${scope} and m.value->>'role'='user' and b->>'type'='text' and starts_with(b->>'text',$3::text) and x.p is not null`, [...ids,HARNESS_PREFIX]);
  return { capturedAt: stamp(), business: state, run, childCount, jobs, proposals, events, llm, tools, toolCalls, harness };
}

export async function transport(env, f, actor, action) {
  const creds = await input(resolve(ROOT, '.local/crm022/actors.private.json'));
  const credential = creds[actor];
  check(credential?.id === f[`${actor}UserId`] && typeof credential.email === 'string' && typeof credential.password === 'string', 'fixed_actor_login_required');
  const cookies = new Map();
  const auth = createServerClient(AUTH, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => Array.from(cookies, ([name,value]) => ({ name,value })),
      setAll: values => {
        for (const {name,value} of values) {
          if (value) cookies.set(name,value);
          else cookies.delete(name);
        }
      },
    },
    cookieOptions: { name: 'sb-pi-native-auth' },
    global: { fetch: (request, init = {}) => fetch(request, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) }) },
  });
  const expectedUser = f[`${actor}UserId`];
  const login = await auth.auth.signInWithPassword({ email: credential.email, password: credential.password });
  check(!login.error && login.data.user?.id === expectedUser, 'authenticated_actor_mismatch');
  const proof = await auth.auth.getUser();
  check(!proof.error && proof.data.user?.id === expectedUser, 'verified_actor_mismatch');
  cookies.set('active_org', f.organizationId);
  async function request(path, method, data) {
    const decision = new RegExp(`^${RUNS}/[a-f0-9-]{36}/proposals/[a-f0-9-]{36}/decision$`).test(path);
    check((method === 'GET' && [RUNS,`/api/v1/contacts/${f.contactId}`].includes(path)) ||
      (method === 'POST' && (path === RUNS || decision || path === `/api/v1/leads/${f.leadId}/move`)), 'sales_api_endpoint_forbidden');
    const headers = { Origin: WEB, Cookie: Array.from(cookies, ([name,value]) => `${name}=${encodeURIComponent(value)}`).join('; ') };
    if (data) headers['Content-Type'] = 'application/json';
    const res = await fetch(WEB + path, { method, headers, redirect: 'manual', signal: AbortSignal.timeout(120000), ...(data ? { body: JSON.stringify(data) } : {}) });
    const body = await res.json().catch(() => null);
    return { httpStatus: res.status, data: body?.data ?? null };
  }
  const contact = await request(`/api/v1/contacts/${f.contactId}`, 'GET');
  check(contact.httpStatus === 200 && contact.data?.id === f.contactId && contact.data.organization_id === f.organizationId, 'authenticated_fixture_scope_mismatch');
  return action(request);
}

async function post(env, dir, f, name, actor, path, data, project) {
  // Authenticate before taking the intent. After it exists, even a transient response is reconciled read-only.
  return transport(env, f, actor, async request => {
    await artifact(dir, `${name}-intent.json`, { at: stamp(), actorUserId: f[`${actor}UserId`], channel: 'explicit_fixed_test_operator_api', path, payloadHash: digest(json(data)) }, false);
    const reply = await request(path, 'POST', data);
    const receipt = { at: stamp(), httpStatus: reply.httpStatus, ...project(reply.data) };
    await artifact(dir, `${name}-receipt.json`, receipt);
    check([200,201].includes(reply.httpStatus), 'request_not_accepted_reconcile_read_only');
    return receipt;
  });
}

async function latestRecord(dir, name) { return input(resolve(dir, `${name}.json`)); }

async function main(args) {
  const [command = 'help', id, sha, phase, value] = args;
  if (command === 'help' || command === '--help') {
    console.info(`CRM-022 sales, isolated loopback only\nnode scripts/eval/crm022-sales.mjs seed <fixture-id>\nnode scripts/eval/crm022-sales.mjs freeze <fixture-id> <fixture-sha> [previous-freeze-sha]\nnode scripts/eval/crm022-sales.mjs auth <fixture-id> <freeze-sha>\nnode scripts/eval/crm022-sales.mjs create|observe <fixture-id> <freeze-sha> advice|approve|reject [pending|final]\nnode scripts/eval/crm022-sales.mjs accept-advice <fixture-id> <freeze-sha> <advice-report-sha>\nnode scripts/eval/crm022-sales.mjs decide <fixture-id> <freeze-sha> approve|reject <proposal-uuid>\nnode scripts/eval/crm022-sales.mjs reset <fixture-id> <freeze-sha>\n`);
    return;
  }
  check(uuid(id), 'fixture_id_required');
  const dir = resolve(DATA, id);
  if (command === 'seed') {
    check(args.length === 2, 'invalid_seed_command');
    await seed(await loadEnvironment(),dir,id);
    return;
  }
  check(['freeze','auth','create','observe','accept-advice','decide','reset'].includes(command) && /^[a-f0-9]{64}$/.test(sha) && args.length <= 5, 'invalid_command');
  const fixturePath = resolve(dir, 'fixture.json');
  const frozenPath = resolve(dir, `frozen-${sha}.json`);
  const frozen = command === 'freeze' ? null : await input(frozenPath, sha);
  const f = await input(fixturePath, frozen?.fixtureHash ?? sha);
  validateFixture(f, id);
  const actualHead = source(f.head);
  const env = await loadEnvironment();
  const scripts = Object.fromEntries(await Promise.all(['crm022-sales.mjs','crm022-sales-checks.mjs'].map(async name => [name, await hash(resolve(import.meta.dirname,name))])));
  if (frozen) check(same(frozen.fixture, f) && same(frozen.scripts, scripts), 'frozen_fixture_or_scripts_changed');
  const q = action => readonly(env, f, action);
  if (command === 'freeze') {
    check(args.length === 3 || args.length === 4 && /^[a-f0-9]{64}$/.test(phase), 'invalid_freeze_command');
    const previous = phase ? await input(resolve(dir,`frozen-${phase}.json`),phase) : null;
    const snapshot = await q(async select => {
      const config = await readConfig(select,f), baseline = (await capture(select,f,f.id,true)).business;
      await attestIdle(select,f);
      const runs = await starts(select,f);
      if (previous) {
        const advice = await runState(select,f,'advice');
        const approval = runs.length === 2 ? await runState(select,f,'approve') : null;
        const known = runs.length === 1 && runs[0].id === advice?.id || runs.length === 2 && approval?.status === 'awaiting_confirmation' &&
          approval.busy === 0 && runs.every(r => [advice?.id,approval.id].includes(r.id));
        check(known && advice?.status === 'completed' && advice.busy === 0 &&
          same(previous.fixture,f) && previous.fixtureHash === sha && same(previous.config,config) &&
          unchanged(previous.baseline,baseline) && same(previous.tasks,tasks(f)), 'previous_advice_or_frozen_plan_changed');
      } else check(runs.length === 0 && baseline.lead.stage_id === f.initialStageId, 'sales_lead_not_fresh');
      return { config, baseline };
    });
    const { max_steps: maxSteps, token_budget: tokenBudget } = snapshot.config.agent;
    const freeze = { version: 1, at: stamp(), actualHead, fixture: f, fixtureHash: sha, scripts, ...snapshot, tasks: tasks(f),
      ...(phase ? { previousFreezeHash: phase, revisionReason: 'verify_sources_and_stage_order_against_existing_runs' } : {}),
      runBudget: { maxSteps, tokenBudget, costBudgetCents: null, localUnpricedDemo: true },
      caps: { roots: 3, decisionPosts: 2, resetPosts: 1, judge: 0, stagesWithModel: 5, maxStepsPerStart: maxSteps, tokenBudgetPerRun: tokenBudget, unknownCost: true } };
    if (previous) check(same(previous.runBudget,freeze.runBudget) && same(previous.caps,freeze.caps), 'previous_budgets_changed');
    await artifact(dir, `frozen-${digest(json(freeze))}.json`, freeze);
    return;
  }
  if (command === 'auth') {
    check(args.length === 3, 'invalid_auth_command');
    for (const actor of ['initiator','decider']) await transport(env,f,actor,async request => {
      const response = await request(RUNS,'GET');
      check(response.httpStatus === 200, 'authenticated_workbench_unavailable');
    });
    await artifact(dir,`auth-${randomUUID()}.json`,{ at: stamp(), freezeHash: sha, initiator: f.initiatorUserId, decider: f.deciderUserId,
      authUserVerified: 2, contactScopeVerified: 2, workbenchGet200: 2, businessPosts: 0, modelCalls: 0 });
    return;
  }
  if (command === 'accept-advice') {
    check(args.length === 4 && /^[a-f0-9]{64}$/.test(phase), 'exact_advice_review_hash_required');
    const reviewed = await input(resolve(dir, 'advice-advice-pass.json'), phase);
    check(reviewed.freezeHash === sha && reviewed.review.status === 'pass' && reviewed.review.recommendationReviewRequired, 'advice_review_not_ready');
    await artifact(dir, 'advice-accepted.json', { at: stamp(), reportHash: phase, decision: 'supported_internal_recommendation', channel: 'explicit_operator_review' });
    return;
  }
  if (command === 'reset') {
    check(args.length === 3, 'invalid_reset_command');
    const final = await latestRecord(dir, 'approve-final-pass');
    const before = await q(async select => { await attestIdle(select,f); return business(select,f); });
    check(final.review.status === 'pass' && unchanged(before, final.snapshot.business), 'approval_not_sealed_for_reset');
    const position = Number(frozen.baseline.lead.position_in_stage);
    check(Number.isFinite(position), 'initial_position_unproved');
    const payload = { stage_id: f.initialStageId, expected_updated_at: before.lead.updated_at, position_in_stage: position };
    await post(env,dir,f,'reset','decider',`/api/v1/leads/${f.leadId}/move`,payload, data => ({ leadId: (data?.lead ?? data)?.id ?? null }));
    const after = await q(select => business(select,f));
    const effect = stageEffect(before,after,f.targetStageId,f.initialStageId);
    await artifact(dir,'reset-observation.json',{ before, after, effect });
    check(effect?.actor_kind === 'user' && effect.performed_by_user_id === f.deciderUserId, 'reset_effect_not_proved');
    await artifact(dir,'reject-baseline.json',{ before, after, resetActivityId: effect.id });
    return;
  }
  check(PHASES.includes(phase), 'phase_required');
  const baseline = phase === 'reject' ? (await latestRecord(dir,'reject-baseline')).after : frozen.baseline;
  if (command === 'create') {
    check(args.length === 4, 'invalid_create_command');
    const expectedRuns = PHASES.indexOf(phase);
    if (phase !== 'advice') await latestRecord(dir,'advice-accepted');
    await q(async select => {
      await attestIdle(select,f);
      check(same(await readConfig(select,f),frozen.config) && unchanged(await business(select,f),baseline), 'fixture_or_agent_changed_since_freeze');
      const found = await starts(select,f);
      check(found.length === expectedRuns && found.every(r => TERMINAL.has(r.status)) && !(await runState(select,f,phase)), 'unexpected_existing_run');
    });
    await post(env,dir,f,`${phase}-create`,'initiator',RUNS,tasks(f)[phase],data => ({ runId: uuid(data?.run_id) ? data.run_id : null }));
    return;
  }
  if (command === 'decide') {
    check(phase !== 'advice' && uuid(value), 'proposal_id_required');
    const pending = await latestRecord(dir,`${phase}-pending-pass`);
    check(pending.freezeHash === sha && pending.review.status === 'pass' && pending.review.proposalId === value && uuid(pending.review.runId), 'proposal_not_reconciled');
    const now = await q(async select => {
      await attestIdle(select,f);
      check(same(await readConfig(select,f),frozen.config), 'fixture_or_agent_changed_since_freeze');
      return capture(select,f,pending.review.runId);
    });
    const checked = review(now,frozen,phase,'pending',baseline);
    check(checked.status === 'pass' && checked.proposalId === value && same(now.proposals,pending.snapshot.proposals), 'proposal_changed_before_decision');
    await post(env,dir,f,`${phase}-decision`,'decider',`${RUNS}/${checked.runId}/proposals/${value}/decision`,
      { decision: phase, reason: 'CRM-022 隔离测试操作员按冻结计划明确选择' }, data => ({ proposalId: data?.proposal_id === value ? value : null,
        status: ['executed','rejected','failed'].includes(data?.status) ? data.status : null }));
    return;
  }
  check(phase === 'advice' ? value === undefined : ['pending','final'].includes(value), 'invalid_observe_checkpoint');
  const checkpoint = value ?? 'advice';
  const intentName = checkpoint === 'final' ? `${phase}-decision` : `${phase}-create`;
  await latestRecord(dir, `${intentName}-intent`);
  let found;
  for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
    found = await q(select => runState(select,f,phase));
    if (found?.busy === 0 && (TERMINAL.has(found.status) || checkpoint === 'pending' && found.status === 'awaiting_confirmation')) break;
    if (attempt + 1 < MAX_POLLS) await sleep(2000);
  }
  const snapshot = await q(select => capture(select,f,found?.id));
  const verdict = found?.busy === 0 ? review(snapshot,frozen,phase,checkpoint,baseline) : { status: 'unknown', failures: ['settled_run_not_proved'] };
  const record = { phase, checkpoint, freezeHash: sha, snapshot, review: verdict };
  const saved = await artifact(dir,`${phase}-${checkpoint}-${Date.now()}-${randomUUID()}.json`,record);
  if (verdict.status === 'pass') await artifact(dir,`${phase}-${checkpoint}-pass.json`,{ ...record, sourceHash: saved.sha256 });
  else process.exitCode = 1;
  console.info(JSON.stringify({ status: verdict.status, failures: verdict.failures, runId: verdict.runId ?? null, proposalId: verdict.proposalId ?? null, usage: verdict.usage ?? null }));
}

if (basename(process.argv[1] ?? '') === 'crm022-sales.mjs') {
  main(process.argv.slice(2)).catch(error => {
    // Never publish an HTTP response, raw provider/PG message, cookie, auth token, or exception stack.
    console.error(JSON.stringify({ status: 'blocked', code: /^[a-z0-9_]{1,100}$/.test(error?.message ?? '') ? error.message : 'isolated_sales_operation_failed',
      ...(typeof error?.code === 'string' && /^[A-Z0-9_]{1,12}$/.test(error.code) ? { driverCode: error.code } : {}) }));
    process.exitCode = 1;
  });
}
