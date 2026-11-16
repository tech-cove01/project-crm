/** CRM-023 paired workbench evaluation. Invoke explicitly for each immutable step. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual as same } from 'node:util';
import pg from 'pg';
import { loadEnvironment, transport } from './crm022-sales.mjs';
import { createProtocol, digest } from './crm023-freeze.mjs';
import { score } from './crm023-score.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const BASE = resolve(ROOT, '.local/crm023');
const OLD = resolve(ROOT, '.local/crm022/paired');
const phases = ['calibration-1', 'calibration-2', 'formal'];
const roles = ['customer_evidence', 'opportunity_diagnosis', 'policy_advisor'];
const terminal = new Set(['completed', 'partial', 'failed', 'cancelled', 'awaiting_confirmation']);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const sha = /^[a-f0-9]{64}$/;
const runtimePaths = ['app','lib','workers','supabase','pnpm-lock.yaml','package.json','next.config.ts','proxy.ts'];
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout: 15000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }).trim();
const one = rows => { assert.equal(rows.length, 1, 'crm023_exactly_one_row_required'); return rows[0]; };
const at = () => new Date().toISOString();
const folder = phase => resolve(BASE, 'paired', phase);
const bytes = value => JSON.stringify(value, null, 2) + '\n';
const sum = (list, key) => list.length && list.every(row => row[key] !== null && Number.isFinite(Number(row[key])))
  ? list.reduce((n, row) => n + Number(row[key]), 0) : null;

async function read(path, hash) {
  const data = await readFile(path);
  if (hash) assert.equal(digest(data), hash, 'crm023_frozen_file_changed');
  return JSON.parse(data);
}

async function optional(path) {
  try { return await read(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function seal(path, value, print = true) {
  const content = bytes(value);
  await writeFile(path, content, { flag: 'wx', mode: 0o600 });
  const receipt = { path, sha256: digest(content) };
  if (print) console.info(JSON.stringify(receipt));
  return receipt;
}

async function protocol(hash) {
  const actual = await read(resolve(BASE, 'protocol.json'), hash);
  assert.equal(bytes(actual), bytes(createProtocol()), 'crm023_protocol_source_changed');
  return actual;
}

function gitBlobs(ref) {
  const entries = git('ls-tree','-r','-z',ref,'--',...runtimePaths).split('\0').filter(Boolean);
  return new Map(entries.map(entry => {
    const tab = entry.indexOf('\t');
    return [entry.slice(tab+1),entry.slice(0,tab).split(' ')[2]];
  }));
}

const blobDigest = blobs => digest(bytes([...blobs].sort(([a],[b]) => a.localeCompare(b))));

async function runtimeFingerprint(phase) {
  const slots = (...args) => git(...args,'--',...runtimePaths).split('\0').filter(Boolean);
  const changes = [...new Set([...slots('diff','--name-only','--no-renames','-z','HEAD'),...slots('ls-files','--others','--exclude-standard','-z')])].sort();
  assert(phase !== 'formal' || changes.length === 0, 'crm023_formal_runtime_tree_dirty');
  const blobs = gitBlobs('HEAD');
  const baseline = blobDigest(blobs), actualBytes = {};
  for (const name of changes) {
    try {
      actualBytes[name] = digest(await readFile(resolve(ROOT,name)));
      // No -w: derive the Git-cleaned blob ID without writing an object or index.
      blobs.set(name,git('hash-object',`--path=${name}`,'--',name));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      blobs.delete(name);
      actualBytes[name] = null;
    }
  }
  return { headBaseline: baseline, effective: blobDigest(blobs), actualBytes };
}

async function verifyRuntime(phase, frozen) {
  const current = await runtimeFingerprint(phase);
  assert.equal(current.effective,frozen.effective,'crm023_frozen_product_changed');
  for (const [name,expected] of Object.entries(frozen.actualBytes)) {
    let actual;
    try { actual = digest(await readFile(resolve(ROOT,name))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; actual = null; }
    assert.equal(actual,expected,'crm023_frozen_uncommitted_bytes_changed');
  }
  for (const [name,actual] of Object.entries(current.actualBytes)) {
    assert(Object.hasOwn(frozen.actualBytes,name) && frozen.actualBytes[name] === actual,'crm023_unfrozen_product_delta');
  }
}

async function scripts() {
  const names = ['crm023-paired.mjs', 'crm022-sales.mjs'];
  return Object.fromEntries(await Promise.all(names.map(async name => [name, digest(await readFile(resolve(import.meta.dirname, name)))])));
}

function plannedLabels(p, phase) {
  const ids = phase === 'formal' ? [...p.regressionIds, ...p.holdoutIds] : p.calibrationIds;
  return ids.flatMap((id, i) => (i % 2 ? [...p.arms].reverse() : p.arms).map(arm => ({ id, arm, label: `${id}-${arm}` })));
}

async function inputs(p) {
  const original = await read(resolve(OLD, 'formal-frozen.json'), p.oldHashes['formal-frozen.json']);
  const fixture = await read(resolve(OLD, 'fixtures.json'), original.fixtureHash);
  const scopes = await read(resolve(OLD, 'formal-scopes.json'), p.oldHashes['formal-scopes.json']);
  const wiki = await read(resolve(OLD, 'wiki-frozen.json'), p.oldHashes['wiki-frozen.json']);
  assert.equal(fixture.org, scopes.org, 'crm023_original_organization_changed');
  assert.equal(fixture.databaseId, scopes.databaseId, 'crm023_original_identity_changed');
  assert(same(original.formalScopes, scopes.scopes), 'crm023_original_twin_freeze_changed');
  const env = await loadEnvironment();
  const actors = await read(resolve(ROOT, '.local/crm022/actors.private.json'));
  assert(env.CRM022_ORG_ID === fixture.org && env.CRM022_ORG_SLUG === 'crm022-synthetic-eval' && uuid.test(actors.initiator?.id), 'crm023_eval_environment_required');
  return { env, original, fixture, wiki, org: fixture.org, databaseId: fixture.databaseId, initiatorUserId: actors.initiator.id };
}

async function identity(q, c) {
  const row = one(await q(`select current_database() name,system_identifier::text instance,
    (select count(*)::int from organizations) total,(select slug from organizations where id=$1) slug,
    (select role from user_organizations where organization_id=$1 and user_id=$2 and revoked_at is null and accepted_at is not null) role
    from pg_control_system()`, [c.org, c.initiatorUserId]));
  assert(row.name === 'postgres' && row.instance === c.databaseId && row.total === 1 && row.slug === 'crm022-synthetic-eval' &&
    ['admin','manager'].includes(row.role), 'crm023_isolated_database_identity_mismatch');
}

async function withDatabase(c, readOnly, action) {
  const pool = new pg.Pool({ connectionString: c.env.SUPABASE_DB_URL, max: 1, connectionTimeoutMillis: 5000,
    statement_timeout: 10000, query_timeout: 12000, ...(readOnly ? { options: '-c default_transaction_read_only=on' } : {}) });
  let disconnected = false, client;
  pool.on('error', () => { disconnected = true; });
  try {
    client = await pool.connect();
    client.on('error', () => { disconnected = true; });
    await client.query(readOnly ? 'begin isolation level repeatable read read only' : 'begin');
    await client.query("set local lock_timeout='5s'");
    const q = async (sql, params) => {
      assert(!readOnly || /^\s*(select|with)\b/i.test(sql), 'crm023_select_only');
      const reply = await client.query(sql, params);
      assert(!disconnected, 'crm023_database_disconnected');
      return reply.rows;
    };
    await identity(q, c);
    const data = await action(q);
    await client.query('commit');
    return data;
  } finally {
    try { if (client) { try { await client.query('rollback'); } finally { client.release(); } } }
    finally { await pool.end(); }
  }
}

async function business(q, c, scope) {
  return one(await q(`select l.stage_id,l.updated_at::text,md5(to_jsonb(l)::text) lead_hash,md5(to_jsonb(t)::text) contact_hash,
    (select count(*)::int from crm_lead_activities a where a.organization_id=$1 and a.lead_id=l.id) activities
    from crm_leads l join contacts t on t.id=l.contact_id and t.organization_id=l.organization_id
    where l.organization_id=$1 and l.id=$2 and l.contact_id=$3 and l.pipeline_id=$4`, [c.org,scope.leadId,scope.contactId,scope.pipelineId]));
}

async function idle(q, c) {
  const row = one(await q("select count(*)::int busy from job_queue where organization_id=$1 and kind in ('workbench_start','workbench_resume') and status in ('pending','running')", [c.org]));
  assert.equal(row.busy, 0, 'crm023_isolated_workbench_queue_busy');
}

async function seed(c, p, phase, protocolHash) {
  const dir = folder(phase);
  await mkdir(dir, { recursive: true });
  const cases = Object.fromEntries(plannedLabels(p, phase).map(entry => [entry.label, { ...entry, contactId: randomUUID(), leadId: randomUUID(),
    pipelineId: c.fixture.pipelineId, stageId: c.fixture.stageId }]));
  const token = `crm023:${phase}:${randomUUID()}`;
  await seal(resolve(dir,'seed-intent.json'), { at: at(), protocolHash, org: c.org, databaseId: c.databaseId, token, cases }, false);
  const objects = await withDatabase(c, false, async q => {
    await idle(q, c);
    const stages = await q(`select id from crm_stages where organization_id=$1 and pipeline_id=$2 and id=$3 and not is_archived and not is_won and not is_lost`,
      [c.org,c.fixture.pipelineId,c.fixture.stageId]);
    assert.equal(stages.length, 1, 'crm023_original_synthetic_stage_unavailable');
    const results = {};
    for (const scope of Object.values(cases)) {
      const item = p.taskDefinitions[scope.id].oracle;
      const label = `${scope.id}-disabled-0`;
      const before = c.original.formalScopes[label];
      const old = p.regressionIds.includes(scope.id) ? before : null;
      let synthetic;
      if (old) {
        assert(same(await business(q,c,old), c.original.objects[label]), 'crm023_original_synthetic_case_changed');
        synthetic = one(await q(`select l.title,l.description,l.value_cents,l.currency,l.expected_close_date::text expected_close_date,l.status,
          t.name,t.display_name from crm_leads l join contacts t on t.id=l.contact_id and t.organization_id=l.organization_id
          where l.organization_id=$1 and l.id=$2 and t.id=$3 and l.pipeline_id=$4 and l.stage_id=$5`,
        [c.org,old.leadId,old.contactId,old.pipelineId,old.stageId]));
      } else synthetic = { title: item.leadTitle, description: item.description ?? 'CRM023 合成商机，只供隔离取证。', value_cents: item.value,
        currency: item.expected?.currency ?? 'CNY', expected_close_date: item.expectedDate, status: item.expected?.status ?? 'open',
        name: item.contactName, display_name: item.contactName };
      const tags = JSON.stringify({ synthetic: true, batch: token, phase, label: scope.label });
      await q(`insert into contacts(id,organization_id,name,display_name,source_metadata)
        values($1,$2,$3,$4,$5::jsonb) returning id`, [scope.contactId,c.org,synthetic.name,synthetic.display_name,tags]);
      await q(`insert into crm_leads(id,organization_id,pipeline_id,stage_id,contact_id,title,description,value_cents,currency,expected_close_date,status,source_metadata)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) returning id`, [scope.leadId,c.org,scope.pipelineId,scope.stageId,scope.contactId,
        synthetic.title,synthetic.description,synthetic.value_cents,synthetic.currency,synthetic.expected_close_date,synthetic.status,tags]);
      results[scope.label] = { before: await business(q,c,scope), materialHash: digest(bytes(synthetic)), clonedFrom: old?.leadId ?? null };
    }
    for (const { id } of Object.values(cases)) assert.equal(results[`${id}-disabled`].materialHash,results[`${id}-auto`].materialHash,'crm023_twins_material_mismatch');
    return results;
  });
  await seal(resolve(dir,'fixtures.json'), { at: at(), protocolHash, org: c.org, databaseId: c.databaseId, token, cases, objects });
}

async function configuration(q, c, m) {
  const agent = one(await q(`select a.id,a.builtin_revision,a.is_active,a.paused_at,v.id version_id,v.provider,v.model,v.tool_ids,v.knowledge_source_ids,
    v.max_steps,v.token_budget,v.cost_budget_cents,md5(v.system_prompt) prompt_hash,o.settings->'llm' llm
    from ai_agents a join organizations o on o.id=a.organization_id
    join lateral (select id,provider,model,tool_ids,knowledge_source_ids,max_steps,token_budget,cost_budget_cents,system_prompt
      from ai_agent_versions where organization_id=a.organization_id and agent_id=a.id order by version_number desc limit 1) v on true
    where a.organization_id=$1 and a.id=$2 and a.builtin_key='sales_operations' and a.archived_at is null`, [c.org,c.fixture.agent.id]));
  assert(agent.is_active && !agent.paused_at && agent.provider === m.provider && agent.model === m.model && agent.max_steps === m.maxSteps &&
    agent.token_budget === m.tokenBudget && agent.llm.provider === m.provider && agent.llm.default_model === m.model && agent.llm.params?.temperature === m.temperature &&
    same(agent.tool_ids,c.original.version.tool_ids) && same(agent.knowledge_source_ids,[c.fixture.sourceId]), 'crm023_model_inputs_or_permissions_changed');
  const source = one(await q(`select id,source_type,status,is_active,source_metadata,updated_at::text from ai_knowledge_sources
    where organization_id=$1 and id=$2`, [c.org,c.fixture.sourceId]));
  const enabled = one(await q("select enabled from ai_integration_settings where organization_id=$1 and provider='weknora'", [c.org]));
  const binding = JSON.parse(c.env.AI_INTEGRATION_BINDINGS).find(x => x.provider === 'weknora' && x.organization_id === c.org);
  const origin = new URL(binding?.base_url ?? 'http://invalid');
  assert(source.source_type === 'wiki' && source.is_active && source.status === 'ready' && source.source_metadata?.provider === 'weknora' &&
    source.source_metadata?.knowledge_base_id === c.fixture.sourceKb && source.source_metadata?.visibility === 'organization' &&
    enabled.enabled && binding?.visibility === 'organization' && binding.knowledge_base_ids?.includes(c.fixture.sourceKb) &&
    typeof binding.api_key === 'string' && origin.protocol === 'http:' && ['127.0.0.1','localhost'].includes(origin.hostname) &&
    origin.port === '8088' && !origin.username && !origin.password && origin.pathname === '/' && !origin.search && !origin.hash,
  'crm023_bound_synthetic_wiki_unavailable');
  return { agent, source, wikiOrigin: origin.origin };
}

async function verifyWiki(q, c, p, phase, config) {
  const { searchCompanyWiki } = await import('../../lib/ai/integrations/weknora.ts');
  const expected = new Map();
  for (const {id} of plannedLabels(p,phase)) for (const field of Object.values(p.taskDefinitions[id].oracle.policy ?? {})) expected.set(field.query,field);
  const previous = process.env.AI_INTEGRATION_BINDINGS;
  process.env.AI_INTEGRATION_BINDINGS = c.env.AI_INTEGRATION_BINDINGS;
  try {
    const output = [];
    for (const [query, contract] of expected) {
      let receipts = 0;
      const requests = [];
      const safePool = { query: async ({ text, values }) => {
        if (text.includes('insert into ai_wiki_evidence')) {
          assert(values[0] === c.org && values[1] === c.fixture.sourceId && sha.test(values[2]), 'crm023_wiki_receipt_scope_mismatch');
          receipts++;
          // Reuse the exact existing immutable receipt instead of writing one during preflight.
          return { rows: await q('select id from ai_wiki_evidence where organization_id=$1 and source_id=$2 and manifest_hash=$3', values.slice(0,3)) };
        }
        return { rows: await q(text, values) };
      } };
      const get = async (address, init) => {
        const url = new URL(address);
        assert(url.origin === config.wikiOrigin && init?.method === 'GET' && requests.length < 24 &&
          (url.pathname.startsWith(`/api/v1/knowledgebase/${c.fixture.sourceKb}/wiki/`) || /^\/api\/v1\/knowledge\/[\w-]+$/.test(url.pathname)),
        'crm023_wiki_preflight_get_out_of_scope');
        const position = requests.push(null) - 1;
        const response = await fetch(address, { ...init, redirect: 'error' });
        requests[position] = response.status;
        return response;
      };
      const reply = await searchCompanyWiki(safePool,c.org,[c.fixture.sourceId],query,5,AbortSignal.timeout(15000),get);
      assert(requests.length > 0 && requests.every(code => code === 200) && same(reply.handledSourceIds,[c.fixture.sourceId]), 'crm023_wiki_preflight_unavailable');
      const pages = reply.evidence.map(item => ({ id: item.metadata.page_id, version: item.metadata.page_version,
        content_hash: item.metadata.content_hash, receiptId: item.id, revision: item.locator.revision }));
      if (contract.expect === 'empty') assert(reply.status === 'empty' && reply.emptyVerified === true && pages.length === 0 && receipts === 0, 'crm023_wiki_preflight_expected_empty');
      else {
        const old = c.wiki.find(item => item.q === query)?.pages ?? [];
        assert(reply.status === 'complete' && old.length > 0 && pages.length === old.length && pages.every(page => old.some(value =>
          value.id === page.id && value.version === page.version && value.content_hash === page.content_hash)) &&
          reply.evidence.some(item => item.excerpt.includes(contract.anchor)), 'crm023_wiki_preflight_frozen_page_changed');
      }
      output.push({ q: query, http: 200, status: reply.status, emptyVerified: reply.emptyVerified === true, pages, requests: requests.length, existingReceiptsSelected: receipts });
    }
    return output;
  } finally {
    if (previous === undefined) delete process.env.AI_INTEGRATION_BINDINGS;
    else process.env.AI_INTEGRATION_BINDINGS = previous;
  }
}

const workbench = '/api/v1/ai/workbench/runs';

function payloadFor(p, config, scope) {
  const task = p.taskDefinitions[scope.id].promptTemplate.replaceAll('{leadId}',scope.leadId)
    .replaceAll('{contactId}',scope.contactId).replaceAll('{stageId}',scope.stageId);
  return { agentId: config.agent.id, task, mode: 'inspect', collaboration: scope.arm,
    scope: { leadId: scope.leadId, contactId: scope.contactId, pipelineId: scope.pipelineId } };
}

async function matchedRuns(q, c, payload) {
  return q(`select r.id,r.status,exists (select 1 from job_queue j where j.organization_id=$1 and j.payload->>'runId'=r.id::text
    and j.status in ('pending','running')) busy from ai_workbench_runs r where r.organization_id=$1 and r.run_kind='root' and r.mode='inspect'
    and r.actor_user_id=$2 and r.agent_id=$3 and r.task=$4 and r.scope=$5::jsonb`,
  [c.org,c.initiatorUserId,payload.agentId,payload.task,JSON.stringify(payload.scope)]);
}

async function noScopeRun(q, c, scope) {
  const found = await q("select id from ai_workbench_runs where organization_id=$1 and run_kind='root' and scope->>'leadId'=$2::text limit 1", [c.org,scope.leadId]);
  assert.equal(found.length, 0, 'crm023_synthetic_scope_already_used');
}

async function freeze(c, p, phase, protocolHash) {
  const dir = folder(phase), product = await runtimeFingerprint(phase);
  assert(!(await optional(resolve(dir,'frozen.json'))),'crm023_phase_already_frozen');
  const f = await read(resolve(dir,'fixtures.json'));
  assert(f.protocolHash === protocolHash && f.org === c.org && f.databaseId === c.databaseId &&
    same(Object.keys(f.cases),plannedLabels(p,phase).map(entry => entry.label)), 'crm023_frozen_fixture_mismatch');
  const material = await withDatabase(c, true, async q => {
    await idle(q,c);
    const config = await configuration(q,c,p.model);
    for (const scope of Object.values(f.cases)) {
      assert(same(await business(q,c,scope),f.objects[scope.label].before), 'crm023_fixture_business_changed');
      await noScopeRun(q,c,scope);
    }
    return { config, wiki: await verifyWiki(q,c,p,phase,config) };
  });
  const fixtureHash = digest(await readFile(resolve(dir,'fixtures.json')));
  await verifyRuntime(phase,product);
  await seal(resolve(dir,'frozen.json'), { at: at(), head: git('rev-parse','HEAD'), phase, protocolHash, fixtureHash, product, scripts: await scripts(), ...material });
}

async function ledger(p, freeze, phase, label) {
  let spent = 0;
  for (const current of phases) {
    let open = false;
    for (const entry of plannedLabels(p,current)) {
      const dir = folder(current), prefix = `${entry.label}`;
      const intent = await optional(resolve(dir,`${prefix}-intent.json`));
      if (current === phase && label === prefix) {
        assert(!intent && !open, 'crm023_label_intent_exists_or_pair_order_changed');
        open = true;
      } else if (current === phase && !intent) open = true;
      if (!intent) continue;
      assert.equal(intent.protocolHash,freeze.protocolHash,'crm023_prior_protocol_changed');
      const result = await optional(resolve(dir,`${prefix}-result.json`));
      assert(result?.settled && result.protocolHash === freeze.protocolHash && result.freezeHash === intent.freezeHash &&
        Number.isFinite(result.usage?.input_tokens) && Number.isFinite(result.usage?.output_tokens) &&
        result.unchanged && result.sameExecution && !result.proposals, 'crm023_prior_run_or_usage_unreconciled');
      spent += result.usage.input_tokens + result.usage.output_tokens;
    }
  }
  if (phase === 'formal') {
    assert.equal(blobDigest(gitBlobs('origin/main')),freeze.product.effective,'crm023_formal_product_unpushed');
    const gate = await Promise.all(['calibration-2','calibration-1'].map(async name => {
      const prior = await optional(resolve(folder(name),'frozen.json'));
      if (!prior || prior.product.effective !== freeze.product.effective) return false;
      const reports = await Promise.all(plannedLabels(p,name).map(entry => optional(resolve(folder(name),`${entry.label}-result.json`))));
      return reports.every(value => value?.settled && value.validArm && value.sameExecution && value.unchanged) &&
        reports.some(value => value.id === 'X02' && value.arm === 'auto' && value.score?.pass) &&
        reports.some(value => value.id === 'M03' && value.arm === 'auto' && value.score?.pass && value.score.reasonableLimit);
    }));
    assert(gate.some(Boolean), 'crm023_formal_calibration_gate_not_met');
  }
  assert(spent + p.model.reserve < p.model.reportedStop, 'crm023_batch_reported_token_reserve_stop');
  return spent;
}

async function create(c, p, phase, freeze, hash, f, scope) {
  const dir = folder(phase), payload = payloadFor(p,freeze.config,scope);
  const spent = await ledger(p,freeze,phase,scope.label);
  await withDatabase(c,true,async q => {
    await idle(q,c);
    assert(same(await configuration(q,c,p.model),freeze.config) && same(await business(q,c,scope),f.objects[scope.label].before), 'crm023_runtime_fixture_changed');
    await noScopeRun(q,c,scope);
  });
  await transport(c.env,{ organizationId: c.org, initiatorUserId: c.initiatorUserId, contactId: scope.contactId, leadId: scope.leadId },'initiator',async api => {
    await seal(resolve(dir,`${scope.label}-intent.json`), { at: at(), phase, protocolHash: freeze.protocolHash, freezeHash: hash,
      label: scope.label, actorUserId: c.initiatorUserId, observedTokensBefore: spent, payloadHash: digest(bytes(payload)) },false);
    let response;
    try { response = await api(workbench,'POST',payload); }
    catch {
      await seal(resolve(dir,`${scope.label}-receipt.json`),{ at: at(), httpStatus: null, runId: null, reconciliationRequired: true });
      throw new Error('crm023_create_outcome_unknown_reconcile_only');
    }
    const runId = response.httpStatus === 201 && uuid.test(response.data?.run_id) ? response.data.run_id : null;
    await seal(resolve(dir,`${scope.label}-receipt.json`),{ at: at(), httpStatus: response.httpStatus, runId, reconciliationRequired: runId === null });
    console.info(JSON.stringify({ phase, label: scope.label, httpStatus: response.httpStatus, runId }));
    if (!runId) process.exitCode = 1;
  });
}

function observedQuery(row) {
  try {
    const data = typeof row.message.content === 'string' ? row.message.content : row.message.content?.filter(x => x.type === 'text').map(x => x.text).join('\n');
    const value = JSON.parse(data).retrieval?.query;
    if (typeof value === 'string' && value.trim()) return { ...row, query: value, querySource: 'tool_result' };
  } catch { /* Legacy rows may carry only the paired public argument. */ }
  const value = row.message.details?.retrieval?.query;
  if (typeof value === 'string' && value.trim()) return { ...row, query: value, querySource: 'tool_result' };
  return { ...row, querySource: row.query === null ? null : 'paired_tool_argument' };
}

async function snapshot(q, c, runId, scope) {
  const ids = [c.org,runId];
  const runs = await q(`select id,organization_id,agent_id,actor_user_id,mode,scope,parent_run_id,run_kind,specialist_key,status,error_code,final_text,
    result_document,created_at::text,completed_at::text,budget,runtime_state->>'versionId' version_id,
    runtime_state->>'collaborationMode' collaboration,runtime_state->'specialistResult'->'usage' specialist_usage,
    runtime_state->'specialistResult'->'missingMaterial' specialist_missing,collaboration_review->>'status' review_status
    from ai_workbench_runs where organization_id=$1 and (id=$2 or parent_run_id=$2) order by created_at,id`,ids);
  const runIds = runs.map(run => run.id);
  const span = [c.org,runIds];
  const tools = (await q(`with messages as (
    select s.run_id,m.i,m.value from ai_agent_run_states s cross join lateral jsonb_array_elements(s.messages) with ordinality m(value,i)
    where s.organization_id=$1 and s.run_id=any($2::uuid[])), wiki_calls as (
      select m.run_id,t.value->>'id' id,case when count(*)=1 then min(t.value->'arguments'->>'pergunta') end query
      from messages m cross join lateral jsonb_array_elements(case when jsonb_typeof(m.value->'toolCalls')='array' then m.value->'toolCalls' else '[]'::jsonb end) t(value)
      where m.value->>'role'='assistant' and t.value->>'name'='crm_search_knowledge' group by m.run_id,t.value->>'id')
    select m.run_id,m.i::int position,m.value message,t.query from messages m
    left join wiki_calls t on t.run_id=m.run_id and t.id=m.value->>'toolCallId'
    where m.value->>'role'='tool' order by m.run_id,m.i`,span)).map(observedQuery);
  const calls = await q(`select id,workbench_run_id,provider,model,status,purpose,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_cents
    from llm_calls where organization_id=$1 and workbench_run_id=any($2::uuid[]) order by id`,span);
  const jobs = await q("select id,kind,status,attempts from job_queue where organization_id=$1 and payload->>'runId'=($2::uuid)::text order by id",ids);
  const proposals = one(await q(`select count(*)::int proposals from ai_agent_action_proposals where organization_id=$1 and run_id=any($2::uuid[])`,span)).proposals;
  const outbox = await q(`select id,entity_id,event_type,status,attempts,payload->>'kind' payload_kind from event_log
    where organization_id=$1 and entity_id=any($2::uuid[]) and event_type='ai_integration.langfuse_export' order by created_at,id`,span);
  return { runs, tools, calls, jobs, proposals, outbox, state: await business(q,c,scope) };
}

async function observe(c, p, phase, freeze, hash, f, scope) {
  const dir = folder(phase), label = scope.label, payload = payloadFor(p,freeze.config,scope);
  const intent = await read(resolve(dir,`${label}-intent.json`));
  assert(intent.freezeHash === hash && intent.protocolHash === freeze.protocolHash && intent.payloadHash === digest(bytes(payload)), 'crm023_run_intent_changed');
  const receipt = await optional(resolve(dir,`${label}-receipt.json`));
  let current;
  const deadline = Date.now() + 300000;
  do {
    current = await withDatabase(c,true,async q => {
      const matches = await matchedRuns(q,c,payload);
      assert(matches.length <= 1 && (!receipt?.runId || !matches.length || matches[0].id === receipt.runId), 'crm023_ambiguous_run_identity');
      return matches[0] ?? null;
    });
    if (current && terminal.has(current.status) && !current.busy) break;
    if (!current && !receipt?.runId) break;
    await sleep(2000);
  } while (Date.now() < deadline);
  if (!current || !terminal.has(current.status) || current.busy) {
    await seal(resolve(dir,`${label}-unknown-${randomUUID()}.json`), { at: at(), phase, label, freezeHash: hash,
      kind: 'not_reconciled_or_still_running', runId: current?.id ?? receipt?.runId ?? null, httpStatus: receipt?.httpStatus ?? null, modelOrBusinessReplay: false });
    process.exitCode = 1;
    return;
  }
  const snap = await withDatabase(c,true,q => snapshot(q,c,current.id,scope));
  const root = one(snap.runs.filter(r => r.id === current.id));
  const children = snap.runs.filter(r => r.parent_run_id === root.id);
  const actualRoles = children.map(r => r.specialist_key).sort();
  const validArm = scope.arm === 'auto' ? same(actualRoles,roles) && children.every(r => r.run_kind === 'specialist' && r.mode === 'inspect') : actualRoles.length === 0;
  const rootCalls = snap.calls.filter(call => call.workbench_run_id === root.id);
  const sameExecution = root.agent_id === payload.agentId && root.actor_user_id === c.initiatorUserId && root.version_id === freeze.config.agent.version_id &&
    root.mode === 'inspect' && root.collaboration === scope.arm && same(root.scope,payload.scope) && root.budget?.maxSteps === p.model.maxSteps &&
    root.budget?.tokenBudget === p.model.tokenBudget && root.budget?.costBudgetCents === null && root.budget?.localUnpricedDemo === true &&
    snap.calls.every(call => call.provider === p.model.provider && call.model === p.model.model && call.purpose !== 'workbench_eval_judge') &&
    snap.jobs.length === 1 && snap.jobs[0].kind === 'workbench_start' && ['done','dead'].includes(snap.jobs[0].status);
  const tokenKeys = ['input_tokens','output_tokens','cache_read_tokens','cache_write_tokens','cost_cents'];
  const usage = Object.fromEntries(tokenKeys.map(key => [key,sum(snap.calls,key)]));
  const usageByRun = Object.fromEntries(snap.runs.map(row => [row.id,Object.fromEntries(tokenKeys.map(key => [key,sum(snap.calls.filter(call => call.workbench_run_id === row.id),key)]))]));
  const unchanged = snap.proposals === 0 && same(snap.state,f.objects[label].before);
  const scoring = score(p.taskDefinitions[scope.id].oracle,scope,root,snap.runs,snap.tools,freeze.wiki,freeze.config.source.id);
  const row = { at: at(), phase, label, id: scope.id, arm: scope.arm, protocolHash: freeze.protocolHash, freezeHash: hash,
    runId: root.id, status: root.status, errorCode: root.error_code, childRoles: actualRoles, childStatuses: children.map(child => child.status),
    settled: true, unchanged, sameExecution, validArm, usage, usageByRun, proposals: snap.proposals, rootModelRows: rootCalls.length,
    submittedAt: intent.at, observedElapsedMs: Date.now() - Date.parse(intent.at),
    runElapsedMs: root.completed_at ? Date.parse(root.completed_at) - Date.parse(root.created_at) : null,
    score: scoring, pass: unchanged && sameExecution && validArm && scoring.pass, snapshot: snap };
  await seal(resolve(dir,`${label}-result.json`),row);
  console.info(JSON.stringify({ phase,label,runId: row.runId,status: row.status,errorCode:row.errorCode,validArm,unchanged,sameExecution,
    pass: row.pass, classification: scoring.classification, counts: scoring.counts, usage, runElapsedMs: row.runElapsedMs }));
  if (!unchanged || !sameExecution || root.status === 'awaiting_confirmation') process.exitCode = 1;
}

async function main(args) {
  const [command = 'help', hash, phase, id, arm] = args;
  if (command === 'help' || command === '--help') {
    console.info('CRM-023: node --import tsx scripts/eval/crm023-paired.mjs seed|freeze <protocol-sha> <calibration-1|calibration-2|formal>');
    console.info('            create|observe <freeze-sha> <phase> <case-id> <disabled|auto>');
    return;
  }
  assert(sha.test(hash) && phases.includes(phase), 'crm023_frozen_phase_required');
  if (['seed','freeze'].includes(command)) {
    assert.equal(args.length, 3, 'crm023_unexpected_command_arguments');
    const p = await protocol(hash), c = await inputs(p);
    await (command === 'seed' ? seed(c,p,phase,hash) : freeze(c,p,phase,hash));
    return;
  }
  assert(['create','observe'].includes(command) && args.length === 5, 'crm023_explicit_command_required');
  const dir = folder(phase), frozen = await read(resolve(dir,'frozen.json'),hash);
  const p = await protocol(frozen.protocolHash), c = await inputs(p);
  assert(frozen.phase === phase && same(await scripts(),frozen.scripts), 'crm023_frozen_runner_changed');
  await verifyRuntime(phase,frozen.product);
  const f = await read(resolve(dir,'fixtures.json'),frozen.fixtureHash);
  const planned = plannedLabels(p,phase).find(entry => entry.id === id && entry.arm === arm);
  const scope = planned ? f.cases[planned.label] : null;
  assert(scope && scope.id === id && scope.arm === arm && f.org === c.org && f.databaseId === c.databaseId &&
    [scope.leadId,scope.contactId,scope.pipelineId,scope.stageId].every(value => uuid.test(value)), 'crm023_case_not_in_frozen_phase');
  await (command === 'create' ? create(c,p,phase,frozen,hash,f,scope) : observe(c,p,phase,frozen,hash,f,scope));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.dirname,'crm023-paired.mjs')) {
  main(process.argv.slice(2)).catch(error => {
    const code = /^crm023_[a-z0-9_]+$/.test(error?.message ?? '') ? error.message :
      error?.code === 'EEXIST' ? 'crm023_existing_intent_or_artifact' : 'crm023_paired_operation_failed';
    console.error(JSON.stringify({ error: code, ...(/^[0-9A-Z]{5}$/.test(error?.code ?? '') ? { sqlState: error.code } : {}) }));
    process.exitCode = 1;
  });
}
