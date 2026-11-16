import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { createBrowserClient } from '@supabase/ssr';
import pg from 'pg';
import { buildTask, score, tested } from './crm022-paired-cases.mjs';

const base = '.local/crm022';
const dir = `${base}/paired`;
const sourceKb = '842886d6-75c1-4089-8747-157644e6fafa';
const crmOrigin = 'http://localhost:3415';
const apiOrigin = 'http://127.0.0.1:55521';
const org = process.env.CRM022_ORG_ID;
const actor = () => JSON.parse(readFileSync(`${base}/actors.private.json`, 'utf8')).initiator;
const hash = value => createHash('sha256').update(value).digest('hex');
const load = file => JSON.parse(readFileSync(`${dir}/${file}`, 'utf8'));
const save = (file, data) => writeFileSync(`${dir}/${file}`, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const codes = new Set(['completed', 'partial', 'failed', 'cancelled', 'awaiting_confirmation']);
const arms = ['disabled', 'auto'];

function labelsFor(items) {
  return items.flatMap(item => arms.flatMap(arm => [0, ...(item.repeat ? [1] : [])].map(repetition => `${item.id}-${arm}-${repetition}`)));
}

async function authenticate() {
  const cookies = new Map();
  const auth = createBrowserClient(apiOrigin, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    isSingleton: false,
    cookieOptions: { name: 'sb-pi-native-auth' },
    cookies: {
      getAll: () => [...cookies].map(([name, value]) => ({ name, value })),
      setAll: values => values.forEach(({ name, value }) => cookies.set(name, value)),
    },
  });
  const account = actor();
  const { data, error } = await auth.auth.signInWithPassword({ email: account.email, password: account.password });
  assert(!error && data.user.id === account.id, 'paired_authentication_failed');
  return async (path, body) => {
    const headers = { Cookie: [...cookies].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('; '), Origin: crmOrigin };
    const init = { headers, signal: AbortSignal.timeout(120_000), redirect: 'error' };
    if (body) Object.assign(init, { method: 'POST', body: JSON.stringify(body), headers: { ...headers, 'Content-Type': 'application/json' } });
    const response = await fetch(crmOrigin + path, init);
    const payload = await response.json().catch(() => null);
    return { status: response.status, error: payload?.error?.code ?? null, data: payload?.data ?? null };
  };
}

async function checkDatabase(pool) {
  const url = new URL(process.env.SUPABASE_DB_URL);
  assert(['127.0.0.1', 'localhost'].includes(url.hostname) && url.port === '55522' && url.pathname === '/postgres');
  assert.equal(process.env.NEXT_PUBLIC_SUPABASE_URL, apiOrigin);
  assert.equal(process.env.NEXT_PUBLIC_APP_URL, crmOrigin);
  const { rows } = await pool.query(`select id,slug,(select system_identifier::text from pg_control_system()) database_id,
    settings->'llm'->>'default_model' model from organizations`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, org);
  assert.equal(rows[0].slug, 'crm022-synthetic-eval');
  assert.equal(rows[0].model, 'qwen3.8-flash');
  return rows[0].database_id;
}

async function seed(pool, databaseId) {
  assert(!existsSync(`${dir}/fixtures.json`), 'paired_fixtures_exist');
  const binding = JSON.parse(process.env.AI_INTEGRATION_BINDINGS).find(item => item.provider === 'weknora' && item.organization_id === org);
  assert(binding?.knowledge_base_ids?.includes(sourceKb), 'synthetic_policy_source_not_bound');
  const api = await authenticate();
  const response = await api('/api/v1/ai/agents');
  assert.equal(response.status, 200, `agents_preflight_http_${response.status}_${response.error}`);
  const { rows: [agent] } = await pool.query(`select a.id,v.id version,v.tool_ids,v.max_steps,v.token_budget
    from ai_agents a join lateral (select id,tool_ids,max_steps,token_budget from ai_agent_versions
      where organization_id=$1 and agent_id=a.id order by version_number desc limit 1) v on true
    where a.organization_id=$1 and a.builtin_key='sales_operations'`, [org]);
  assert(agent && ['crm_get_contact','crm_get_lead','crm_search_knowledge'].every(tool => agent.tool_ids.includes(tool)));
  const sourceId = randomUUID();
  const pipelineId = randomUUID();
  const stageId = randomUUID();
  const staleStageId = randomUUID();
  const cases = Object.fromEntries(tested.map(item => [item.id, { leadId: randomUUID(), contactId: randomUUID(), pipelineId, stageId }]));
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`insert into ai_knowledge_sources(id,organization_id,source_type,name,status,is_active,source_metadata)
      values($1,$2,'wiki','CRM022 合成产品政策','ready',true,$3::jsonb)`, [sourceId, org, JSON.stringify({ provider: 'weknora', knowledge_base_id: sourceKb, visibility: 'organization' })]);
    await client.query(`insert into crm_pipelines(id,organization_id,name,slug) values($1,$2,'CRM022 对照','crm022-paired')`, [pipelineId, org]);
    await client.query(`insert into crm_stages(id,organization_id,pipeline_id,name,slug,position)
      values($1,$2,$3,'待核对','crm022-active',1000),($4,$2,$3,'旧阶段','crm022-stale',2000)`, [stageId, org, pipelineId, staleStageId]);
    for (const item of tested) {
      const { contactId, leadId } = cases[item.id];
      await client.query(`insert into contacts(id,organization_id,name,display_name,source_metadata)
        values($1,$2,$3,$3,'{"batch":"crm022-paired"}'::jsonb)`, [contactId, org, item.contactName]);
      const description = item.kind === 'conflict' ? `旧销售快照，仅供核对。旧阶段 UUID=${staleStageId}，旧金额=1800 分，已失效。` : 'CRM022 合成样本';
      await client.query(`insert into crm_leads(id,organization_id,pipeline_id,stage_id,contact_id,title,description,value_cents,currency,expected_close_date,source_metadata)
        values($1,$2,$3,$4,$5,$6,$7,$8,'CNY',$9,'{"batch":"crm022-paired"}'::jsonb)`,
      [leadId, org, pipelineId, stageId, contactId, item.leadTitle, description, item.value, item.expectedDate]);
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally { client.release(); }
  save('fixtures.json', { org, databaseId, sourceId, sourceKb, agent, pipelineId, stageId, staleStageId, cases,
    head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() });
  console.log(JSON.stringify({ seeded: tested.length, databaseId, sourceId, agentId: agent.id }));
}

async function seedFormalTwins(pool, fixture, databaseId) {
  assert.equal(fixture.org, org);
  assert.equal(fixture.databaseId, databaseId);
  assert(!existsSync(`${dir}/formal-scopes.json`), 'paired_formal_scopes_exist');
  const pilot = load('calibration-summary.json');
  assert(pilot.summaries.length === 2 && pilot.summaries.every(row => row.validArm && row.unchanged && row.sameExecution));
  const scopes = {};
  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const item of tested.filter(entry => entry.kind !== 'calibration')) {
      const original = fixture.cases[item.id];
      scopes[`${item.id}-disabled-0`] = original;
      const twins = [`${item.id}-auto-0`, ...(item.repeat ? [`${item.id}-disabled-1`, `${item.id}-auto-1`] : [])];
      for (const key of twins) {
        const contactId = randomUUID();
        const leadId = randomUUID();
        const c = await client.query(`insert into contacts(id,organization_id,name,display_name,source_metadata)
          select $3,organization_id,name,display_name,source_metadata from contacts where organization_id=$1 and id=$2`, [org, original.contactId, contactId]);
        const l = await client.query(`insert into crm_leads(id,organization_id,pipeline_id,stage_id,contact_id,title,description,value_cents,currency,expected_close_date,source_metadata)
          select $3,organization_id,pipeline_id,stage_id,$4,title,description,value_cents,currency,expected_close_date,source_metadata
          from crm_leads where organization_id=$1 and id=$2`, [org, original.leadId, leadId, contactId]);
        assert(c.rowCount === 1 && l.rowCount === 1, 'paired_formal_source_missing');
        scopes[key] = { ...original, contactId, leadId };
      }
    }
    await client.query('commit');
  } catch (error) { await client.query('rollback'); throw error; }
  finally { client.release(); }
  save('formal-scopes.json', { databaseId, org, scopes });
}

async function snapshot(pool, runId, leadId) {
  const { rows: runs } = await pool.query(`select id,agent_id,mode,scope,parent_run_id,run_kind,specialist_key,status,error_code,final_text,
    result_document,created_at,completed_at,budget,runtime_state->>'versionId' version_id from ai_workbench_runs
    where organization_id=$1 and (id=$2 or parent_run_id=$2) order by created_at,id`, [org, runId]);
  const ids = runs.map(run => run.id);
  const { rows: tools } = await pool.query(`with messages as (
    select s.run_id,m.ordinality,m.value from ai_agent_run_states s
    cross join lateral jsonb_array_elements(s.messages) with ordinality m(value,ordinality)
    where s.organization_id=$1 and s.run_id=any($2::uuid[])), wiki_calls as (
    select m.run_id,call->>'id' as id,call->'arguments'->>'pergunta' as question from messages m
    cross join lateral jsonb_array_elements(case when jsonb_typeof(m.value->'toolCalls')='array' then m.value->'toolCalls' else '[]'::jsonb end) as calls(call)
    where m.value->>'role'='assistant' and call->>'name'='crm_search_knowledge')
    select m.run_id,m.ordinality::int as position,m.value as message,c.question as query from messages m
    left join wiki_calls c on c.run_id=m.run_id and c.id=m.value->>'toolCallId'
    where m.value->>'role'='tool' order by m.run_id,m.ordinality`, [org, ids]);
  const { rows: calls } = await pool.query(`select id,workbench_run_id,provider,model,status,input_tokens,output_tokens,
    cache_read_tokens,cache_write_tokens,cost_cents from llm_calls where organization_id=$1 and workbench_run_id=any($2::uuid[])`, [org, ids]);
  const { rows: jobs } = await pool.query(`select id,status,attempts from job_queue where organization_id=$1 and payload->>'runId'=$2`, [org, runId]);
  const { rows: [{ proposals }] } = await pool.query(`select count(*)::int proposals from ai_agent_action_proposals
    where organization_id=$1 and run_id=$2`, [org, runId]);
  return { runs, tools, calls, jobs, state: await business(pool, leadId), proposals };
}

async function business(pool, leadId) {
  const { rows } = await pool.query(`select l.stage_id,l.updated_at::text,md5(to_jsonb(l)::text) lead_hash,
    md5(to_jsonb(c)::text) contact_hash, (select count(*)::int from crm_lead_activities a where a.organization_id=$1 and a.lead_id=l.id) activities
    from crm_leads l join contacts c on c.id=l.contact_id and c.organization_id=l.organization_id
    where l.organization_id=$1 and l.id=$2`, [org, leadId]);
  assert.equal(rows.length, 1, 'paired_object_scope_changed');
  return rows[0];
}

async function currentConfiguration(pool, fixture) {
  const { rows: [version] } = await pool.query(`select v.id,v.provider,v.model,v.tool_ids,v.knowledge_source_ids,v.max_steps,
    v.token_budget,md5(v.system_prompt) as prompt_digest,o.settings->'llm' llm from ai_agent_versions v
    join organizations o on o.id=v.organization_id
    where v.organization_id=$1 and v.agent_id=$2 order by v.version_number desc limit 1`, [org, fixture.agent.id]);
  assert(version && version.provider === 'dashscope' && version.model === 'qwen3.8-flash', 'paired_version_model_changed');
  assert.deepEqual(version.knowledge_source_ids, [fixture.sourceId], 'paired_version_source_changed');
  assert.equal(version.max_steps, 12);
  assert.equal(version.token_budget, 36000);
  assert(['crm_get_contact','crm_get_lead','crm_search_knowledge'].every(tool => version.tool_ids.includes(tool)));
  return version;
}

async function runOnce(pool, api, fixture, plan, wiki, id, arm, repetition = 0) {
  const item = tested.find(test => test.id === id);
  const label = `${id}-${arm}-${repetition}`;
  const scope = plan.formalScopes ? plan.formalScopes[label] : fixture.cases[id];
  assert(scope, 'paired_frozen_scope_missing');
  if (existsSync(`${dir}/${label}.json`)) return load(`${label}.json`).summary;
  const before = await business(pool, scope.leadId);
  assert.deepEqual(before, plan.objects[label], 'paired_frozen_object_changed');
  assert.deepEqual(await currentConfiguration(pool, fixture), plan.version, 'paired_configuration_changed');
  const { rowCount: active } = await pool.query(`select id from job_queue where organization_id=$1
    and status in ('pending','running') and kind in ('workbench_start','workbench_resume') limit 1`, [org]);
  assert.equal(active, 0, 'paired_workbench_queue_not_idle');
  const payload = { agentId: fixture.agent.id, task: buildTask(item, scope), mode: 'inspect', collaboration: arm,
    scope: { leadId: scope.leadId, contactId: scope.contactId, pipelineId: scope.pipelineId } };
  let start = Date.now();
  let response;
  if (existsSync(`${dir}/${label}.intent.json`)) {
    assert(existsSync(`${dir}/${label}.receipt.json`), 'prior_intent_reconcile_before_retry');
    const intent = load(`${label}.intent.json`);
    assert.deepEqual(intent.payload, payload, 'paired_prior_intent_changed');
    response = load(`${label}.receipt.json`);
    assert(!response.reconciliationRequired, 'paired_transport_unknown_reconcile_no_replay');
    start = Date.parse(intent.at);
  } else {
    if (plan.formalScopes) {
      const { rowCount } = await pool.query(`select id from ai_workbench_runs where organization_id=$1 and run_kind='root'
        and scope->>'leadId'=$2 limit 1`, [org, scope.leadId]);
      assert.equal(rowCount, 0, 'paired_formal_scope_already_used');
    }
    save(`${label}.intent.json`, { at: new Date(start), payload });
    try { response = await api('/api/v1/ai/workbench/runs', payload); }
    catch {
      save(`${label}.receipt.json`, { reconciliationRequired: true, status: 'transport_unknown' });
      throw new Error('paired_transport_unknown_reconcile_no_replay');
    }
    save(`${label}.receipt.json`, response);
  }
  if (response.status !== 201 || !response.data?.run_id) {
    const summary = { id, arm, repetition, kind: item.kind, attempted: true, failure: `http_${response.status}_${response.error}`, score: null };
    save(`${label}.json`, { summary });
    return summary;
  }
  const runId = response.data.run_id;
  for (let seconds = 0; seconds < 300; seconds += 2) {
    const { rows: [run] } = await pool.query(`select status, exists(select 1 from job_queue where organization_id=$1
      and payload->>'runId'=$2::uuid::text and status in ('pending','running')) as busy
      from ai_workbench_runs where organization_id=$1 and id=$2`, [org, runId]);
    if (codes.has(run?.status) && !run.busy) break;
    await sleep(2000);
  }
  const result = await snapshot(pool, runId, scope.leadId);
  const root = result.runs.find(run => run.id === runId);
  assert(root, 'root_capture_missing');
  const roles = result.runs.filter(run => run.parent_run_id === runId).map(run => run.specialist_key).sort();
  const validArm = arm === 'auto' ? roles.join() === 'customer_evidence,opportunity_diagnosis,policy_advisor' : roles.length === 0;
  const unchanged = JSON.stringify(before) === JSON.stringify(result.state) && result.proposals === 0;
  const scoring = score(item, scope, root, result.runs, result.tools, wiki, fixture.sourceId);
  const sameExecution = root.agent_id === fixture.agent.id && root.version_id === plan.version.id && root.mode === 'inspect' &&
    root.scope?.leadId === scope.leadId && root.scope?.contactId === scope.contactId && root.scope?.pipelineId === scope.pipelineId &&
    root.budget?.maxSteps === 12 && root.budget?.tokenBudget === 36000 && root.budget?.costBudgetCents === null &&
    result.calls.length > 0 && result.calls.every(call => call.provider === 'dashscope' && call.model === 'qwen3.8-flash');
  const usage = Object.fromEntries(['input_tokens','output_tokens','cache_read_tokens','cache_write_tokens'].map(key => [key,
    result.calls.length && result.calls.every(call => call[key] !== null) ? result.calls.reduce((total, call) => total + Number(call[key]), 0) : null]));
  const summary = { id, kind: item.kind, arm, repetition, runId, status: root.status, errorCode: root.error_code, roles, validArm,
    unchanged, sameExecution, childStatuses: result.runs.filter(run => run.parent_run_id === runId).map(run => run.status),
    failure: !codes.has(root.status) ? 'poll_timeout' : root.status === 'awaiting_confirmation' ? 'unexpected_proposal' : null,
    elapsedMs: root.completed_at ? root.completed_at.getTime() - start : null,
    attempts: result.jobs.reduce((total, job) => total + job.attempts, 0), usage, cost: null, score: scoring,
    pass: sameExecution && validArm && unchanged && scoring.pass };
  save(`${label}.json`, { summary, ...result });
  console.log(JSON.stringify(summary));
  assert(unchanged, 'readonly_business_state_changed');
  assert(codes.has(root.status) && root.status !== 'awaiting_confirmation', 'paired_root_not_closed');
  assert(sameExecution, 'paired_executed_version_scope_or_model_changed');
  return summary;
}

async function main() {
  const [mode, cap = '12'] = process.argv.slice(2);
  if (!['seed','seed-twins','calibration','formal'].includes(mode)) throw new Error('Use seed, seed-twins, calibration, or formal <task-count>.');
  mkdirSync(dir, { recursive: true });
  const pool = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL, max: 2, statement_timeout: 15000 });
  try {
    const databaseId = await checkDatabase(pool);
    if (mode === 'seed') return await seed(pool, databaseId);
    const productPaths = ['app','lib','workers','supabase','pnpm-lock.yaml'];
    assert.equal(execFileSync('git',['status','--porcelain','--', ...productPaths],{encoding:'utf8'}).trim(), '', 'paired_runtime_source_changed');
    const fixture = load('fixtures.json');
    const wiki = load('wiki-frozen.json');
    assert.equal(fixture.databaseId, databaseId);
    assert.equal(fixture.org, org);
    if (mode === 'seed-twins') return await seedFormalTwins(pool, fixture, databaseId);
    let formalScopes = null;
    if (mode === 'formal') {
      const pilot = load('calibration-summary.json');
      assert.deepEqual(pilot.summaries.map(row => row.arm).sort(), ['auto','disabled']);
      assert(pilot.summaries.every(row => row.unchanged && row.sameExecution && row.validArm && !row.failure) &&
        pilot.summaries.some(row => row.score?.shape), 'paired_calibration_not_exercised');
      const twins = load('formal-scopes.json');
      assert.equal(twins.org, org);
      assert.equal(twins.databaseId, databaseId);
      formalScopes = twins.scopes;
      assert.deepEqual(Object.keys(formalScopes).sort(), labelsFor(tested.slice(1)).sort(), 'paired_formal_scope_labels_changed');
      assert.equal(new Set(Object.values(formalScopes).map(item => item.leadId)).size, 32, 'paired_formal_scopes_not_distinct');
      assert.equal(new Set(Object.values(formalScopes).map(item => item.contactId)).size, 32, 'paired_formal_contacts_not_distinct');
    }
    const selected = mode === 'calibration' ? tested.slice(0,1) : tested.slice(1,1+Number(cap));
    assert(selected.length > 0 && selected.length <= 12);
    const planFile = mode === 'calibration' && cap === 'repair' ? 'calibration-frozen-repair.json' : `${mode}-frozen.json`;
    const scripts = ['crm022-paired.mjs','crm022-paired-cases.mjs'];
    const api = await authenticate();
    assert.equal((await api('/api/v1/ai/agents')).status, 200);
    assert.equal((await api(`/api/v1/contacts/${fixture.cases[selected[0].id].contactId}`)).status, 200);
    const objects = {};
    for (const item of selected) {
      for (let repeat=0; repeat <= Number(mode === 'formal' && item.repeat); repeat++) {
        for (const arm of arms) {
          const label = `${item.id}-${arm}-${repeat}`;
          const scope = formalScopes ? formalScopes[label] : fixture.cases[item.id];
          objects[label] = await business(pool, scope.leadId);
        }
      }
    }
    const plan = { model: 'dashscope/qwen3.8-flash', fixtureHash: hash(readFileSync(`${dir}/fixtures.json`)),
      wikiHash: hash(readFileSync(`${dir}/wiki-frozen.json`)), version: await currentConfiguration(pool, fixture), objects, formalScopes,
      productTree: Object.fromEntries(productPaths.map(path => [path,
        execFileSync('git',['rev-parse',`HEAD:${path}`],{encoding:'utf8'}).trim()])),
      scripts: Object.fromEntries(scripts.map(file => [file, hash(readFileSync(`scripts/eval/${file}`))])), taskIds: selected.map(item => item.id),
      maxRoots: selected.length * 2 + (mode === 'formal' ? selected.filter(item => item.repeat).length * 2 : 0) };
    if (mode === 'calibration' && cap === 'repair') {
      const original = load('calibration-frozen.json');
      assert.deepEqual({ ...original, scripts: plan.scripts }, plan, 'paired_calibration_inputs_changed');
    }
    if (existsSync(`${dir}/${planFile}`)) assert.deepEqual(load(planFile), plan, 'frozen_plan_changed');
    else save(planFile, plan);
    const summaries = [];
    for (const item of selected) {
      for (let repeat=0; repeat <= Number(mode === 'formal' && item.repeat); repeat++) {
        const order = (item.index+repeat)%2 === 0 ? ['disabled','auto'] : ['auto','disabled'];
        for (const arm of order) {
          const charged = summaries.reduce((total, entry) => total + Number(entry.usage.input_tokens ?? 0) + Number(entry.usage.output_tokens ?? 0), 0);
          if (mode === 'formal') assert(charged + 72000 < 750_000 || existsSync(`${dir}/${item.id}-${arm}-${repeat}.json`), 'paired_observed_token_reserve_stop');
          const result = await runOnce(pool, api, fixture, plan, wiki, item.id, arm, repeat);
          summaries.push(result);
          assert(!result.failure, 'workbench_http_failure');
          assert(result.sameExecution && Number.isFinite(result.usage.input_tokens) && Number.isFinite(result.usage.output_tokens), 'paired_usage_or_runtime_unknown');
        }
      }
    }
    if (!existsSync(`${dir}/${mode}-summary.json`)) save(`${mode}-summary.json`, { plan, summaries });
  } finally { await pool.end(); }
}

main().catch(error => {
  const message = /^[\w .,_-]{1,180}$/.test(error.message) ? error.message : error.code ?? error.name;
  console.error('crm022_paired_failed', message);
  process.exitCode = 1;
});
