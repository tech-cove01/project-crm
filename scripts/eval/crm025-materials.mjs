import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv, isDeepStrictEqual as same } from 'node:util';
import { createClient } from '@supabase/supabase-js';
import { ROOT, at, business, digest, idle, one, optional, read, seal, sha, uuid } from './crm024-fixtures.mjs';
import { AUTH_ORIGIN, BASELINE, DATASET_HASH, FIXTURE_FILE, MATERIAL_ROOT, PLAN_FILE, RUNTIME_FILE,
  SALES_ACTOR, crm025Context, crm025Transaction, read025Dataset } from './crm025-materials-context.mjs';
import { ALPHA_TENANT, createWikiAccess, inspectWiki, pagePath, readSeededWiki, retrieve, revokeWikiAccess, seedWiki, wikiAccessProof,
  wikiTransaction } from './crm025-materials-wiki.mjs';

export { MATERIAL_ROOT, FIXTURE_FILE, PREFLIGHT_FILE, RUNTIME_FILE, crm025Context, crm025Transaction, crm025Transport,
  loadMaterials, makeScopeTask, read025Dataset } from './crm025-materials-context.mjs';

const local = name => resolve(MATERIAL_ROOT, name);
const runtimePaths = ['app', 'lib', 'workers', 'supabase', 'pnpm-lock.yaml', 'package.json', 'next.config.ts', 'proxy.ts'];
const phases = ['baseline', 'candidate'];
const arms = ['disabled', 'auto'];
const roles = new Map([['sales', 'agent']]);
const stageNames = { proposal: '方案拟定', qualification: '需求确认' };
const sourceNames = { current: '销售服务条款', withdrawn: '已归档销售服务例外', foreign: '销售服务条款' };
const planFiles = ['crm025-materials.mjs', 'crm025-materials-context.mjs', 'crm025-materials-wiki.mjs', 'crm025-materials-preflight.mjs'];
const git = (...args) => execFileSync('git', args, { cwd: ROOT, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
const optIn = hash => assert(sha.test(hash ?? '') && process.env.CRM025_MATERIALS_EXECUTE === hash, 'crm025_materials_exact_opt_in_required');

function assertBaseline() {
  assert.equal(git('diff', '--name-only', BASELINE, '--', ...runtimePaths), '', 'crm025_base_product_changed');
  assert.equal(git('ls-files', '--others', '--exclude-standard', '--', ...runtimePaths), '', 'crm025_base_product_untracked_path');
}

async function materialSources() {
  return Object.fromEntries(await Promise.all(planFiles.map(async name => [name, digest(await readFile(resolve(import.meta.dirname, name)))])));
}

async function agentRecord(q, c) {
  return one(await q(`select a.id,a.builtin_key as "builtinKey",a.builtin_revision as "builtinRevision",
    a.published_version_id as "publishedVersionId",v.id as "versionId",v.version_number as "versionNumber",v.status as "versionStatus",
    v.provider,v.model,v.tool_ids as "toolIds",v.max_steps as "maxSteps",v.token_budget as "tokenBudget",
    v.cost_budget_cents as "configuredCostBudgetCents",v.knowledge_source_ids as "sourceIds",
    encode(sha256(convert_to(v.system_prompt,'utf8')),'hex') as "promptHash",
    encode(sha256(convert_to(to_jsonb(v)::text,'utf8')),'hex') as "profileHash",
    o.settings->'llm'->>'provider' as "orgProvider",o.settings->'llm'->>'default_model' as "orgModel",
    o.settings->'llm'->'params'->'temperature' as temperature,
    o.settings->'llm'->'params' as "modelParameters"
    from ai_agents a join organizations o on o.id=a.organization_id
    join lateral (select * from ai_agent_versions where organization_id=$1::uuid and agent_id=a.id order by version_number desc limit 1) v on true
    where a.organization_id=$1::uuid and a.id=$2::uuid and a.builtin_key='sales_operations' and a.origin='builtin'
      and a.archived_at is null and a.paused_at is null and a.is_active`, [c.org, c.oldFixture.agent.id]));
}

function requireModel(row) {
  assert(row.provider === 'dashscope' && row.orgProvider === row.provider && row.model === 'qwen3.8-flash' && row.orgModel === row.model &&
    row.temperature === 0 && row.maxSteps === 12 && row.tokenBudget === 36000 && row.versionStatus === 'draft' &&
    sha.test(row.promptHash) && sha.test(row.profileHash) && Array.isArray(row.toolIds) && row.toolIds.includes('crm_get_lead') &&
    row.toolIds.includes('crm_get_contact') && row.toolIds.includes('crm_search_knowledge'), 'crm025_expected_model_or_tool_budget_missing');
}

async function activeSourceIds(q, org) {
  return (await q('select id from ai_knowledge_sources where organization_id=$1::uuid and is_active order by id', [org])).map(row => row.id);
}

async function prepare() {
  assertBaseline();
  await mkdir(MATERIAL_ROOT, { recursive: true });
  const [{ dataset, datasetHash }, c, sources] = await Promise.all([read025Dataset(), crm025Context({ prepare: true }), materialSources()]);
  assert(!c.plan && !(await optional(local('seed-intent.json'))), 'crm025_materials_already_planned');
  const batch = randomUUID(), betaOrg = randomUUID();
  const kb = { current: randomUUID(), historical: randomUUID(), withdrawn: randomUUID(), foreign: randomUUID() };
  const source = { current: randomUUID(), withdrawn: randomUUID(), foreign: randomUUID() };
  const history = one(dataset.corpus.filter(entry => entry.state === 'superseded'));
  const replacement = one(dataset.corpus.filter(entry => entry.organizationId === history.organizationId && entry.title === history.title &&
    entry.state === 'published' && entry.version > history.version));
  const successorPage = randomUUID(), revisionSlug = randomUUID();
  const pages = Object.fromEntries(dataset.corpus.map(entry => {
    const kind = entry.organizationId === 'org_beta' ? 'foreign' : entry.state === 'withdrawn' ? 'withdrawn' : 'current';
    const revision = entry.id === history.id || entry.id === replacement.id;
    return [entry.id, { logicalId: entry.id, pageId: revision ? successorPage : randomUUID(), documentId: randomUUID(), sourceId: source[kind],
      kbId: kb[kind], slug: revision ? revisionSlug : randomUUID(), version: entry.version, bodyHash: digest(entry.content), state: entry.state,
      orgId: kind === 'foreign' ? betaOrg : c.org, evidenceId: randomUUID(),
      ...(entry.state === 'superseded' ? { revisionId: randomUUID(), backingKbId: kb.historical } : {}) }];
  }));
  const pipelineId = randomUUID();
  const stages = Object.fromEntries(Object.keys(stageNames).map(stage => [stage, randomUUID()]));
  const slots = Object.fromEntries(phases.flatMap(phase => dataset.cases.flatMap(entry => arms.map(arm => {
    const key = `${phase}.${entry.id}.${arm}`;
    const contactId = randomUUID(), leadId = randomUUID();
    return [key, { key, phase, caseId: entry.id, arm, leadId, contactId, pipelineId, stageId: stages[entry.business.lead.stage],
      actor: entry.business.actorRole === 'sales' ? 'sales' : 'initiator', scope: { leadId, contactId, pipelineId },
      memories: entry.business.confirmedCustomerFacts.map(fact => ({ id: randomUUID(), requestKey: randomUUID(), key: fact.id,
        category: 'confirmed_fact', bodyHash: digest(fact.body), revision: digest(JSON.stringify({ contact: contactId, category: 'confirmed_fact', body: fact.body })) })) }];
  }))));
  const [crm, wiki] = await Promise.all([
    crm025Transaction(c, true, async q => {
      await idle(q, c);
      const agent = await agentRecord(q, c);
      requireModel(agent);
      const ids = await activeSourceIds(q, c.org);
      assert(same(ids, [c.oldFixture.sourceId]) && same(agent.sourceIds, ids), 'crm025_original_source_scope_unexpected');
      const manager = one(await q(`select role from user_organizations where organization_id=$1::uuid and user_id=$2::uuid
        and accepted_at is not null and revoked_at is null`, [c.org, c.initiatorUserId])).role;
      assert(one(await q("select enabled from ai_integration_settings where organization_id=$1::uuid and provider='weknora'", [c.org])).enabled,
        'crm025_wiki_integration_disabled');
      return { agent, ids, manager };
    }, { initial: true }),
    wikiTransaction(true, async () => ({ tenant: ALPHA_TENANT })),
  ]);
  const plan = { version: 1, at: at(), datasetHash, baseline: BASELINE, org: c.org, databaseId: c.databaseId, batch,
    materialSources: sources, betaOrg, betaSlug: `crm025-beta-${batch.slice(0, 8)}`, betaTenantName: `CRM 025 Foreign ${batch.slice(0, 8)}`,
    kb, source, pages, pipelineId, stages, slots, before: crm, wiki, activeAgentVersionId: randomUUID(), restoredAgentVersionId: randomUUID(),
    salesEmail: `crm025-sales-${batch.slice(0, 8)}@localhost.test` };
  return seal(PLAN_FILE, plan);
}

async function cloneSalesDraft(q, c, prior, target, number, sourceIds) {
  return one(await q(`insert into ai_agent_versions select (jsonb_populate_record(null::ai_agent_versions,to_jsonb(v)||jsonb_build_object(
      'id',$4::uuid,'version_number',$5::int,'knowledge_source_ids',$6::uuid[],'created_at',clock_timestamp(),'created_by',$7::uuid,
      'status','draft','published_at',null,'superseded_at',null))).* from ai_agent_versions v
    where v.organization_id=$1::uuid and v.agent_id=$2::uuid and v.id=$3::uuid
      and encode(sha256(convert_to(to_jsonb(v)::text,'utf8')),'hex')=$8 returning id`,
  [c.org, prior.id, prior.versionId, target, number, sourceIds, c.initiatorUserId, prior.profileHash]));
}

async function createSalesActor(c, plan) {
  assert(new URL(c.env.NEXT_PUBLIC_SUPABASE_URL).origin === AUTH_ORIGIN && c.env.SUPABASE_SERVICE_ROLE_KEY, 'crm025_local_auth_required');
  const password = randomBytes(36).toString('base64url');
  const admin = createClient(AUTH_ORIGIN, c.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (request, init = {}) => fetch(request, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) }) } });
  await seal(local('sales-actor-intent.private.json'), { email: plan.salesEmail, password, at: at(), batch: plan.batch }, false);
  const result = await admin.auth.admin.createUser({ email: plan.salesEmail, password, email_confirm: true,
    user_metadata: { name: 'CRM 合成销售', synthetic_fixture: plan.batch } });
  assert(!result.error && result.data.user?.email === plan.salesEmail && uuid.test(result.data.user?.id), 'crm025_sales_auth_creation_unconfirmed');
  const actor = { id: result.data.user.id, email: plan.salesEmail, password, role: roles.get('sales') };
  await seal(SALES_ACTOR, actor, false);
  return actor;
}

async function insertCrmSource(q, plan, type) {
  const org = type === 'foreign' ? plan.betaOrg : plan.org;
  const metadata = { provider: 'weknora', knowledge_base_id: plan.kb[type], visibility: 'organization' };
  return one(await q(`insert into ai_knowledge_sources(id,organization_id,source_type,name,status,is_active,source_metadata)
    values($1::uuid,$2::uuid,'wiki',$3,'ready',true,$4::jsonb) returning id`,
  [plan.source[type], org, sourceNames[type], JSON.stringify(metadata)]));
}

async function seedCrm(c, plan, dataset, actor) {
  return crm025Transaction(c, false, async q => {
    await idle(q, c);
    assert(same(await agentRecord(q, c), plan.before.agent) && same(await activeSourceIds(q, c.org), plan.before.ids),
      'crm025_baseline_changed_after_plan');
    one(await q(`insert into organizations(id,slug,legal_name,display_name,timezone,locale,settings)
      values($1::uuid,$2,$3,$3,'Asia/Shanghai','zh-CN',$4::jsonb) returning id`, [plan.betaOrg, plan.betaSlug, 'CRM 合成外部组织',
      JSON.stringify({ synthetic: true, crm025: plan.batch })]));
    for (const kind of ['current', 'withdrawn', 'foreign']) await insertCrmSource(q, plan, kind);
    await cloneSalesDraft(q, c, plan.before.agent, plan.activeAgentVersionId, plan.before.agent.versionNumber + 1, [plan.source.current]);
    const managerId = c.initiatorUserId;
    one(await q(`insert into user_organizations(user_id,organization_id,role,invited_by,invited_at,accepted_at)
      values($1,$2,$3,$4,now(),now()) returning id`, [actor.id, c.org, actor.role, managerId]));
    one(await q(`insert into crm_pipelines(id,organization_id,name,slug) values($1,$2,$3,$4) returning id`,
      [plan.pipelineId, c.org, '合成销售核对', `fixture-${plan.batch.slice(0, 8)}`]));
    for (const [index, [key, label]] of Object.entries(stageNames).entries()) {
      one(await q(`insert into crm_stages(id,organization_id,pipeline_id,name,slug,position) values($1,$2,$3,$4,$5,$6) returning id`,
      [plan.stages[key], c.org, plan.pipelineId, label, key, 1000 * (index + 1)]));
    }
    const scenarios = new Map(dataset.cases.map(item => [item.id, item]));
    const slots = {};
    const meta = { synthetic: true, batch: plan.batch };
    for (const [key, slot] of Object.entries(plan.slots)) {
      const entry = scenarios.get(slot.caseId);
      const actorUserId = slot.actor === 'sales' ? actor.id : managerId;
      const expectedRole = slot.actor === 'sales' ? actor.role : plan.before.manager;
      const lead = entry.business.lead;
      one(await q(`insert into contacts(id,organization_id,name,display_name,source_metadata) values($1,$2,$3,$3,$4::jsonb) returning id`,
      [slot.contactId, c.org, '合成采购联系人', JSON.stringify(meta)]));
      one(await q(`insert into crm_leads(id,organization_id,pipeline_id,stage_id,contact_id,title,description,value_cents,currency,expected_close_date,
        status,custom_fields,source_metadata,owner_user_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14) returning id`,
      [slot.leadId, c.org, slot.pipelineId, slot.stageId, slot.contactId, lead.title, lead.description ?? null, lead.valueCents,
        lead.currency, lead.expectedCloseDate, lead.status, JSON.stringify(lead.customFields), JSON.stringify(meta), slot.actor === 'sales' ? actor.id : null]));
      for (const [index, memory] of slot.memories.entries()) {
        one(await q(`insert into ai_customer_memories(id,organization_id,contact_id,request_key,category,body,content_hash,confirmed_by,subject_key)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`, [memory.id, c.org, slot.contactId, memory.requestKey, memory.category,
          entry.business.confirmedCustomerFacts[index].body, memory.revision, managerId, digest(`crm-customer:v1:${c.org}:${slot.contactId}`)]));
      }
      slots[key] = { ...slot, actorUserId, expectedRole, expectedHttpStatus: slot.actor === 'sales' ? 403 : 201,
        preState: await business(q, c, slot) };
    }
    const agent = await agentRecord(q, c);
    requireModel(agent);
    assert(agent.versionId === plan.activeAgentVersionId && agent.promptHash === plan.before.agent.promptHash &&
      same(agent.toolIds, plan.before.agent.toolIds) && same(agent.modelParameters, plan.before.agent.modelParameters) &&
      same(agent.sourceIds, [plan.source.current]), 'crm025_material_scope_drift');
    return { slots, agent: { ...agent, costBudgetCents: null } };
  }, { initial: true });
}

async function writeRuntime(c, plan, token) {
  const raw = await readFile(resolve(ROOT, '.local/crm022/runtime.env'), 'utf8');
  const wiki = { organization_id: c.org, provider: 'weknora', base_url: c.binding.base_url,
    api_key: token, knowledge_base_ids: [plan.kb.current], visibility: 'organization' };
  const body = JSON.stringify([wiki]);
  assert(!/['\r\n]/.test(body), 'crm025_private_wiki_binding_invalid');
  const value = raw.replace(/^[ \t]*(?:AI_INTEGRATION_BINDINGS|SENTRY_DSN|NEXT_PUBLIC_SENTRY_DSN)[ \t]*=.*(?:\r?\n|$)/gm, '').trimEnd() +
    `\nAI_INTEGRATION_BINDINGS='${body}'\nSENTRY_DSN=off\nNEXT_PUBLIC_SENTRY_DSN=\n`;
  const env = parseEnv(value);
  assert(env.AI_INTEGRATION_BINDINGS === body && env.HEALTH_HOST === '127.0.0.1' && env.HEALTH_PORT === '8795', 'crm025_runtime_env_roundtrip_failed');
  await writeFile(RUNTIME_FILE, value, { flag: 'wx', mode: 0o600 });
  return digest(value);
}

async function finishSeed(c, plan, planHash, dataset, wiki, actor, resumeHash) {
  const crm = await seedCrm(c, plan, dataset, actor);
  await seal(local('crm-seed-receipt.json'), { at: at(), planHash, actorId: actor.id, slots: Object.keys(crm.slots), agentId: crm.agent.id,
    versionId: crm.agent.versionId }, false);
  await seal(local('wiki-key-intent.json'), { at: at(), planHash, batch: plan.batch, kb: plan.kb.current }, false);
  const key = await createWikiAccess(plan);
  await seal(local('wiki-key-receipt.json'), { at: at(), planHash, status: key.status, proof: await wikiAccessProof(plan, key.keyId, false) }, false);
  const environmentHash = await writeRuntime(c, plan, key.token);
  return seal(FIXTURE_FILE, { version: 1, at: at(), datasetHash: DATASET_HASH, planHash, baseline: BASELINE, org: c.org,
    organizationId: c.org, databaseId: c.databaseId, betaOrg: plan.betaOrg, betaTenantId: wiki.betaTenantId, environmentHash,
    sourceIds: [plan.source.current], pages: wiki.pages, candidatePool: { mode: 'shared', crmSourceIds: [plan.source.current], knowledgeBaseIds: [plan.kb.current] },
    actorScopes: { initiator: { id: c.initiatorUserId, role: plan.before.manager }, sales: { id: actor.id, role: actor.role } },
    keyId: key.keyId, businessClock: dataset.businessClock, seedResumeHash: resumeHash ?? null, ...crm });
}

async function seed(planHash) {
  optIn(planHash);
  assertBaseline();
  const [plan, c, { dataset }] = await Promise.all([read(PLAN_FILE, planHash), crm025Context({ prepare: true }), read025Dataset()]);
  assert(plan.datasetHash === DATASET_HASH && plan.baseline === BASELINE && plan.org === c.org && plan.databaseId === c.databaseId &&
    plan.wiki.tenant === ALPHA_TENANT && same(plan.materialSources, await materialSources()) && Object.keys(plan.slots).length === 96,
  'crm025_exact_material_plan_required');
  await seal(local('seed-intent.json'), { at: at(), planHash, batch: plan.batch, betaOrg: plan.betaOrg, kb: plan.kb, source: plan.source }, false);
  const wiki = await seedWiki(plan, dataset);
  await seal(local('wiki-seed-receipt.json'), { at: at(), planHash, betaTenantId: wiki.betaTenantId, ...await inspectWiki(plan, wiki.pages) }, false);
  const actor = await createSalesActor(c, plan);
  return finishSeed(c, plan, planHash, dataset, wiki, actor);
}

async function resumeSeedState(originalHash) {
  assertBaseline();
  const [plan, c, { dataset }, intent, wikiReceipt, actor, actorIntent] = await Promise.all([
    read(PLAN_FILE, originalHash), crm025Context({ prepare: true }), read025Dataset(), read(local('seed-intent.json')),
    read(local('wiki-seed-receipt.json')), read(SALES_ACTOR), read(local('sales-actor-intent.private.json')),
  ]);
  assert(intent.planHash === originalHash && intent.batch === plan.batch && intent.betaOrg === plan.betaOrg && same(intent.kb, plan.kb) &&
    same(intent.source, plan.source) && wikiReceipt.planHash === originalHash && actor.role === 'agent' && actor.email === plan.salesEmail &&
    actorIntent.batch === plan.batch && actorIntent.email === actor.email && actorIntent.password === actor.password &&
    plan.org === c.org && plan.databaseId === c.databaseId && plan.datasetHash === DATASET_HASH &&
    await Promise.all(['crm-seed-receipt.json', 'wiki-key-intent.json', 'fixtures.json'].map(name => optional(local(name))))
      .then(items => items.every(item => item === null)), 'crm025_partial_seed_identity_not_confirmed');
  const [wiki, rollback] = await Promise.all([
    readSeededWiki(plan, wikiReceipt),
    crm025Transaction(c, true, async q => {
      await idle(q, c);
      assert(same(await agentRecord(q, c), plan.before.agent) && same(await activeSourceIds(q, c.org), plan.before.ids),
        'crm025_crm_baseline_not_restored');
      const identity = one(await q(`select id,email_confirmed_at is not null confirmed,raw_user_meta_data->>'synthetic_fixture' batch
        from auth.users where id=$1::uuid and email=$2`, [actor.id, actor.email]));
      assert(identity.id === actor.id && identity.confirmed && identity.batch === plan.batch, 'crm025_seed_actor_auth_mismatch');
      const slots = Object.values(plan.slots);
      const check = one(await q(`select (select count(*)::int from organizations where id=$1::uuid) beta,
        (select count(*)::int from ai_knowledge_sources where id=any($2::uuid[])) sources,
        (select count(*)::int from ai_agent_versions where id=$3::uuid) profile,
        (select count(*)::int from user_organizations where user_id=$4::uuid) membership,
        (select count(*)::int from crm_pipelines where id=$5::uuid) pipeline,
        (select count(*)::int from crm_stages where id=any($6::uuid[])) stages,
        (select count(*)::int from crm_leads where id=any($7::uuid[])) leads,
        (select count(*)::int from contacts where id=any($8::uuid[])) contacts,
        (select count(*)::int from ai_customer_memories where id=any($9::uuid[])) memories,
        (select count(*)::int from ai_workbench_runs where organization_id=$10::uuid and scope->>'leadId'=any($7::text[])) roots`,
      [plan.betaOrg, Object.values(plan.source), plan.activeAgentVersionId, actor.id, plan.pipelineId, Object.values(plan.stages),
        slots.map(slot => slot.leadId), slots.map(slot => slot.contactId), slots.flatMap(slot => slot.memories.map(row => row.id)), c.org]));
      assert(Object.values(check).every(count => count === 0), 'crm025_owned_crm_transaction_not_rolled_back');
      return check;
    }, { initial: true }),
  ]);
  const received = await Promise.all(['seed-intent.json', 'wiki-seed-receipt.json'].map(async name => [name, digest(await readFile(local(name)))]));
  const state = { version: 1, originalHash, datasetHash: DATASET_HASH, org: c.org, databaseId: c.databaseId, batch: plan.batch,
    priorReceipts: Object.fromEntries(received), currentMaterialSources: await materialSources(),
    failedSqlState: '23505', failedConstraint: 'ai_knowledge_sources_nome_unico_por_org',
    changes: { withdrawnSourceName: sourceNames.withdrawn }, rollback, reused: { wikiTenant: wiki.betaTenantId, actorId: actor.id },
    noReplay: ['wiki-seed', 'create-sales-actor'], remaining: ['seed-crm', 'create-retrieve-key', 'write-frozen-fixtures'] };
  return { c, plan, dataset, wiki, actor, state };
}

async function planResume(originalHash) {
  const { state } = await resumeSeedState(originalHash);
  return seal(local('seed-resume-plan.json'), state);
}

async function resumeSeed(hash) {
  optIn(hash);
  const sealed = await read(local('seed-resume-plan.json'), hash);
  const { c, plan, dataset, wiki, actor, state } = await resumeSeedState(sealed.originalHash);
  assert(same(state, sealed), 'crm025_seed_resume_plan_changed');
  await seal(local('seed-resume-intent.json'), { at: at(), hash, originalHash: sealed.originalHash, includesKeyCreation: true }, false);
  return finishSeed(c, plan, sealed.originalHash, dataset, wiki, actor, hash);
}

export async function inspectCrm(c, fixture, dataset, withdrawn) {
  return crm025Transaction(c, true, async q => {
    await idle(q, c);
    const agent = await agentRecord(q, c);
    requireModel(agent);
    assert(same({ ...agent, costBudgetCents: null }, fixture.agent), 'crm025_frozen_sales_profile_mismatch');
    const { plan } = c;
    const sources = await q(`select id,organization_id,source_type,status,is_active,source_metadata,updated_at from ai_knowledge_sources
      where id=any($1::uuid[]) order by id`, [Object.values(plan.source)]);
    assert(sources.length === 3 && Object.entries(plan.source).every(([kind, id]) => {
      const row = sources.find(row => row.id === id);
      const archived = kind === 'withdrawn' && withdrawn;
      return row?.organization_id === (kind === 'foreign' ? plan.betaOrg : c.org) && row.source_type === 'wiki' &&
        row.status === (archived ? 'archived' : 'ready') && row.is_active !== archived &&
        same(row.source_metadata, { provider: 'weknora', knowledge_base_id: plan.kb[kind], visibility: 'organization' });
    }), 'crm025_crm_knowledge_boundary_changed');
    const members = await q(`select user_id,organization_id,role from user_organizations where user_id=any($1::uuid[])
      and accepted_at is not null and revoked_at is null order by user_id`, [Object.values(fixture.actorScopes).map(actor => actor.id)]);
    assert(members.length === 2 && Object.values(fixture.actorScopes).every(expected => members.some(row =>
      row.user_id === expected.id && row.organization_id === c.org && row.role === expected.role)), 'crm025_actor_scope_changed');
    const map = new Map(dataset.cases.map(entry => [entry.id, entry]));
    const records = await q(`select l.id,l.contact_id,l.pipeline_id,l.stage_id,l.status,l.title,l.description,l.value_cents,l.currency,
      l.expected_close_date::text,l.custom_fields,l.source_metadata,l.external_id,l.owner_user_id,s.slug,t.source_metadata contact_metadata,
      to_jsonb(t)->>'external_id' contact_external
      from crm_leads l join contacts t on t.id=l.contact_id and t.organization_id=l.organization_id
      join crm_stages s on s.id=l.stage_id and s.organization_id=l.organization_id
      where l.organization_id=$1::uuid and l.id=any($2::uuid[])`, [c.org, Object.values(fixture.slots).map(slot => slot.leadId)]);
    const state = {};
    for (const slot of Object.values(fixture.slots)) {
      const record = one(records.filter(row => row.id === slot.leadId));
      const entry = map.get(slot.caseId), expected = entry.business.lead;
      assert(record.contact_id === slot.contactId && record.pipeline_id === slot.pipelineId && record.stage_id === slot.stageId &&
        record.slug === expected.stage && record.status === expected.status && record.title === expected.title &&
        record.description === (expected.description ?? null) && record.value_cents != null && Number(record.value_cents) === expected.valueCents &&
        record.currency === expected.currency && record.expected_close_date === expected.expectedCloseDate &&
        same(record.custom_fields, expected.customFields) && record.external_id === null && record.contact_external === null &&
        same(record.source_metadata, { synthetic: true, batch: plan.batch }) && same(record.contact_metadata, record.source_metadata) &&
        record.owner_user_id === (slot.actor === 'sales' ? slot.actorUserId : null) && same(await business(q, c, slot), slot.preState),
      'crm025_frozen_crm_object_mismatch');
      state[slot.key] = digest(JSON.stringify(record));
    }
    return { actorScope: members, sources, scopedObjects: state };
  });
}

async function cleanup(hash) {
  optIn(hash);
  const c = await crm025Context();
  const fixture = await read(FIXTURE_FILE, hash), { plan } = c;
  assert(fixture.keyId === c.fixture.keyId && fixture.planHash === digest(await readFile(PLAN_FILE)), 'crm025_exact_cleanup_identity_required');
  await seal(local('cleanup-intent.json'), { at: at(), fixtureHash: hash, sourceId: plan.source.current, keyId: fixture.keyId,
    restoreVersionId: plan.restoredAgentVersionId, salesActor: fixture.actorScopes.sales.id }, false);
  const { restoreSourceScope } = await import('./crm025-materials-source-scope.mjs');
  const restoredScope = await crm025Transaction(c, false, async q => {
    await idle(q, c);
    assert((await agentRecord(q, c)).profileHash === fixture.agent.profileHash, 'crm025_restore_conflicting_agent_edit');
    one(await q(`update ai_knowledge_sources set is_active=false,status='archived' where id=$1::uuid and organization_id=$2::uuid
      and is_active and status='ready' and source_metadata->>'knowledge_base_id'=$3 returning id`, [plan.source.current, c.org, plan.kb.current]));
    one(await q(`update ai_knowledge_sources set is_active=false,status='archived' where id=$1::uuid and organization_id=$2::uuid
      and is_active and status='ready' and source_metadata->>'knowledge_base_id'=$3 returning id`, [plan.source.foreign, plan.betaOrg, plan.kb.foreign]));
    one(await q(`update user_organizations set revoked_at=clock_timestamp() where user_id=$1::uuid and organization_id=$2::uuid
      and role='agent' and revoked_at is null returning id`, [fixture.actorScopes.sales.id, c.org]));
    const restoral = await restoreSourceScope(q, c, hash);
    await cloneSalesDraft(q, c, plan.before.agent, plan.restoredAgentVersionId, plan.before.agent.versionNumber + 2, plan.before.ids);
    assert(same(await activeSourceIds(q, c.org), plan.before.ids), 'crm025_original_source_scope_not_restored');
    return restoral;
  });
  await seal(local('cleanup-crm-receipt.json'), { at: at(), fixtureHash: hash, restoredVersionId: plan.restoredAgentVersionId,
    sourceIds: plan.before.ids, actorsRevoked: [fixture.actorScopes.sales.id], crmRecordsRetained: true, restoredScope }, false);
  const bind = JSON.parse(c.env.AI_INTEGRATION_BINDINGS)[0];
  const page = Object.values(fixture.pages).find(entry => entry.orgId === c.org && entry.state === 'published');
  const priorPath = `/api/v1/knowledgebase/${encodeURIComponent(c.oldFixture.sourceKb)}/wiki/search?q=${encodeURIComponent('审批')}&limit=1`;
  const originalKey = c.binding.api_key;
  const before = await retrieve(originalKey, priorPath);
  assert(before.status === 200, 'crm025_original_retrieval_scope_unavailable');
  await seal(local('cleanup-key-intent.json'), { at: at(), fixtureHash: hash, keyId: fixture.keyId }, false);
  const key = await revokeWikiAccess(plan, fixture.keyId);
  const [denied, original] = await Promise.all([retrieve(bind.api_key, pagePath(page)), retrieve(originalKey, priorPath)]);
  assert([401, 403].includes(denied.status) && original.status === 200, 'crm025_revocation_probe_mismatch');
  return seal(local('cleanup-result.json'), { at: at(), fixtureHash: hash, restored: true, keyRevoked: key,
    ownedKeyDenied: denied.status, oldKeyBefore: before.status, oldKeyAfter: original.status, restoredScope, crmRecordsRetained: true, wikiHistoryRetained: true });
}

async function main([command, hash, ...extra]) {
  assert(extra.length === 0);
  if (command === 'prepare' && hash === undefined) return prepare();
  if (command === 'seed') return seed(hash);
  if (command === 'plan-resume' && sha.test(hash ?? '')) return planResume(hash);
  if (command === 'resume') return resumeSeed(hash);
  if (command === 'preflight') { optIn(hash); const { preflight } = await import('./crm025-materials-preflight.mjs'); return preflight(hash); }
  if (command === 'cleanup') return cleanup(hash);
  throw new Error('crm025_materials_commands_prepare_seed_preflight_cleanup');
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) main(process.argv.slice(2)).catch(error => {
  const safe = /^crm025_[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : 'crm025_materials_command_failed';
  console.error(JSON.stringify({ error: safe, ...(typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? { sqlState: error.code } : {}),
    ...(typeof error?.constraint === 'string' && /^[a-z0-9_]+$/.test(error.constraint) ? { constraint: error.constraint } : {}) }));
  process.exitCode = 1;
});
