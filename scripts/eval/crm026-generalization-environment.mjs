import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import { ROOT, at, digest, one, optional, read, sha, uuid } from './crm024-fixtures.mjs';
import { WIKI_ORIGIN, scopedTransaction } from './crm025-materials-context.mjs';
import { ALPHA_TENANT, createWikiAccess, pagePath, retrieve, revokeWikiAccess, wikiAccessProof,
  wikiTransaction } from './crm025-materials-wiki.mjs';
import { product } from './crm025-run-core.mjs';
import { ARMS, MODEL, PRODUCT_COMMIT, WEB, guardForeignWork, guardMemoryDatabase,
  loadMemoryEnvironment, seal } from './crm026-memory-environment-config.mjs';
import { archiveWiki, preflightWiki, provisionWiki } from './crm026-generalization-environment-wiki.mjs';

export const GENERALIZATION_ROOT = resolve(ROOT, '.local/crm026/generalization');
export const GENERALIZATION_ARM = 'generalization';
export const GENERALIZATION_INPUT = resolve(ROOT, '.local/crm026/generalization-input-draft.json');
export const GENERALIZATION_FILES = Object.fromEntries(Object.entries({
  intent: 'setup-intent.json', identity: 'setup.private.json', keyIntent: 'wiki-key-intent.json',
  key: 'wiki-key.private.json', actor: 'actor.private.json', runtime: 'runtime.env.json',
  fixture: 'fixture.json', profiles: 'profiles.json', preflight: 'preflight.json', lock: 'environment.lock',
  closeIntent: 'cleanup-intent.json', keyCloseIntent: 'wiki-key-cleanup-intent.json', closed: 'cleanup-result.json',
}).map(([k, v]) => [k, resolve(GENERALIZATION_ROOT, v)]));
const files = GENERALIZATION_FILES;
const caseIds = Array.from({ length: 6 }, (_, i) => [`G${i + 1}A`, `G${i + 1}B`]).flat();
const WORKBENCH = '/api/v1/ai/workbench/runs';
const AGENTS = '/api/v1/ai/agents';
const sourcePath = id => `/api/v1/ai/knowledge/sources/${id}`;
const evidencePath = id => `/api/v1/ai/integrations/wiki/evidence/${id}`;
const contactPath = id => `/api/v1/contacts/${id}`;
const sourceMeta = kb => ({ provider: 'weknora', knowledge_base_id: kb, visibility: 'organization' });
const transportFetch = (request, init = {}) => fetch(request, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) });

const exact = (value, keys) => value && same(Object.keys(value).sort(), keys.toSorted());
const text = (value, max) => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= max;

export function validateGeneralizationInput(input) {
  assert(input?.version === 'crm026-generalization-input-draft/v1' && input.materialPool?.visibility === 'organization' &&
    input.materialPool.state === 'published' && input.materialPool.samePoolForEveryCase === true &&
    Array.isArray(input.materialPool.pages) && input.materialPool.pages.length === 12 &&
    Array.isArray(input.cases) && same(input.cases.map(row => row.id), caseIds), 'crm026_g_input_identity');
  const pages = input.materialPool.pages;
  assert(new Set(pages.map(row => row.id)).size === 12 && new Set(pages.map(row => row.slug)).size === 12 &&
    pages.every(row => exact(row, ['id', 'slug', 'title', 'body']) && /^W(?:0[1-9]|1[0-2])$/.test(row.id) &&
      /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(row.slug) && text(row.title, 200) && text(row.body, 2000)), 'crm026_g_input_pages');
  assert(new Set(input.cases.map(row => row.customerRef)).size === 12 && input.cases.every(row => {
    const { contact, lead } = row.crmFixture ?? {};
    return exact(row, ['id', 'customerRef', 'crmFixture', 'task']) && row.customerRef === `${row.id}-customer` &&
      exact(row.crmFixture, ['contact', 'lead']) && exact(contact, ['name']) && text(contact.name, 150) &&
      exact(lead, ['title', 'description', 'status', 'currency', 'expectedCloseDate']) && text(lead.title, 200) &&
      text(lead.description, 2000) && lead.status === 'open' && lead.currency === 'CNY' && lead.expectedCloseDate === null &&
      text(row.task, 4000);
  }), 'crm026_g_input_cases');
  return input;
}

function planGeneralization(memory, input, inputHash) {
  const batch = memory.fixture.batch;
  const organizationId = randomUUID();
  const pipelineId = randomUUID();
  const slots = Object.fromEntries(input.cases.map(({ id, task }) => {
    const contactId = randomUUID();
    return [id, { key: id, caseId: id, checkId: id, arm: GENERALIZATION_ARM, organizationId, contactId, decoys: {},
      taskHash: digest(task), crmScope: { contactId, leadId: randomUUID(), pipelineId } }];
  }));
  const pages = Object.fromEntries(input.materialPool.pages.map(({ id, body }) =>
    [id, { pageId: randomUUID(), documentId: randomUUID(), bodyHash: digest(body) }]));
  return { version: 1, batch, productCommit: PRODUCT_COMMIT, memoryFixtureHash: memory.fixtureHash,
    inputHash, organizationId, slug: `crm026-${batch.slice(0, 8)}-generalization`, pipelineId, stageId: randomUUID(),
    sourceId: randomUUID(), kb: { current: randomUUID() }, slots, pages };
}

async function sealOrVerify(path, value) {
  const previous = await optional(path);
  if (!previous) return seal(path, value);
  assert(same(previous, value), 'crm026_g_private_receipt_changed');
  return digest(await readFile(path));
}

async function exclusively(action) {
  await mkdir(GENERALIZATION_ROOT, { recursive: true });
  const lock = await open(files.lock, 'wx');
  try { return await action(); }
  finally { await lock.close(); await unlink(files.lock); }
}

async function guarded(q, memory, plan, mustExist) {
  const database = memory.fixture.database;
  assert(database.mode === 'fresh', 'crm026_g_requires_dedicated_crm_stack');
  const { owned, orgs } = await guardMemoryDatabase(q, database.mode, database.id, memory.fixture,
    { allowDeferredGeneralization: true });
  const org = orgs.find(row => row.slug === plan.slug);
  assert(owned.length === ARMS.length && (!org || org.id === plan.organizationId && org.batch === plan.batch) &&
    (!mustExist || !!org), 'crm026_g_database_ownership');
  await guardForeignWork(q, database.mode, [...owned.map(row => row.id), plan.organizationId]);
  return !!org;
}

function authClient(memory, admin = false) {
  return createClient(memory.env.NEXT_PUBLIC_SUPABASE_URL,
    admin ? memory.env.SUPABASE_SERVICE_ROLE_KEY : memory.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: transportFetch } });
}

async function provisionActor(memory, plan, identity) {
  const options = { connectionString: memory.env.SUPABASE_DB_URL };
  const find = () => scopedTransaction(options, true, async q => {
    await guarded(q, memory, plan, false);
    const rows = await q(`select id,raw_app_meta_data->>'crm026' batch from auth.users where email=$1`, [identity.email]);
    assert(rows.length <= 1 && rows.every(row => row.batch === plan.batch), 'crm026_g_auth_identity_collision');
    return rows[0]?.id;
  });
  let id = await find();
  if (!id) {
    const created = await authClient(memory, true).auth.admin.createUser({ ...identity, email_confirm: true,
      app_metadata: { crm026: plan.batch } });
    id = await find();
    assert(!created.error && uuid.test(id ?? '') && created.data.user?.id === id, 'crm026_g_auth_create_unconfirmed');
  }
  const signIn = await authClient(memory).auth.signInWithPassword(identity);
  assert(!signIn.error && signIn.data.user?.id === id, 'crm026_g_auth_identity_changed');
  return { ...identity, id };
}

async function seedCrm(q, memory, plan, input, actor) {
  if (await guarded(q, memory, plan, false)) return;
  const credential = one(await q(`select api_key_encrypted,api_key_iv,api_key_tag,api_key_last4,validated_at
    from ai_provider_credentials where organization_id=$1 and provider=$2 and is_active and validated_at is not null`,
  [memory.fixture.arms.none.organizationId, MODEL.provider]));
  const llm = { provider: MODEL.provider, default_model: MODEL.model, enabled_models: [MODEL.model],
    params: { temperature: MODEL.temperature } };
  await q(`insert into organizations(id,slug,legal_name,display_name,timezone,locale,created_by,onboarded_at,settings)
    values($1,$2,'CRM 合成泛化验证','CRM 合成泛化验证','Asia/Shanghai','zh-CN',$3,now(),$4::jsonb)`,
  [plan.organizationId, plan.slug, actor.id, JSON.stringify({ llm, crm026: plan.batch, synthetic: true })]);
  await q(`insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,'manager',now())`,
  [actor.id, plan.organizationId]);
  await q(`insert into ai_provider_credentials(organization_id,provider,label,api_key_encrypted,api_key_iv,
    api_key_tag,api_key_last4,validated_at,models_available,created_by) values($1,$2,'CRM026 isolated BYOK',$3,$4,$5,$6,$7,$8,$9)`,
  [plan.organizationId, MODEL.provider, credential.api_key_encrypted, credential.api_key_iv, credential.api_key_tag,
    credential.api_key_last4, credential.validated_at, [MODEL.model], actor.id]);
  await q(`insert into ai_integration_settings(organization_id,provider,enabled) values($1,'weknora',true),($1,'mem0',false)`, [plan.organizationId]);
  await q(`insert into ai_knowledge_sources(id,organization_id,source_type,name,status,is_active,source_metadata)
    values($1,$2,'wiki','泛化评测共同现行资料','ready',true,$3::jsonb)`,
  [plan.sourceId, plan.organizationId, JSON.stringify(sourceMeta(plan.kb.current))]);
  await q(`insert into crm_pipelines(id,organization_id,name,slug) values($1,$2,'泛化评测合成商机','crm026-generalization')`,
  [plan.pipelineId, plan.organizationId]);
  await q(`insert into crm_stages(id,organization_id,pipeline_id,name,slug,position)
    values($1,$2,$3,'方案拟定','proposal',1000)`, [plan.stageId, plan.organizationId, plan.pipelineId]);
  const marker = JSON.stringify({ synthetic: true, crm026: plan.batch });
  for (const entry of input.cases) {
    const slot = plan.slots[entry.id];
    const { contact, lead } = entry.crmFixture;
    await q(`insert into contacts(id,organization_id,name,display_name,source_metadata) values($1,$2,$3,$3,$4::jsonb)`,
    [slot.contactId, plan.organizationId, contact.name, marker]);
    await q(`insert into crm_leads(id,organization_id,pipeline_id,stage_id,contact_id,title,description,value_cents,currency,
      expected_close_date,status,source_metadata,owner_user_id) values($1,$2,$3,$4,$5,$6,$7,null,$8,null,$9,$10::jsonb,$11)`,
    [slot.crmScope.leadId, plan.organizationId, plan.pipelineId, plan.stageId, slot.contactId, lead.title,
      lead.description, lead.currency, lead.status, marker, actor.id]);
  }
}

async function readCrm(q, plan, actor, input) {
  const org = plan.organizationId;
  const scopes = await q(`select c.id contact_id,c.name,c.display_name,l.id lead_id,l.pipeline_id,l.stage_id,
      l.title,l.description,l.value_cents,l.currency,l.expected_close_date,l.status,l.owner_user_id
      from contacts c join crm_leads l on l.contact_id=c.id and l.organization_id=c.organization_id
      where c.organization_id=$1 order by c.id`, [org]);
  assert(scopes.length === 12 && input.cases.every(({ id, crmFixture: { contact, lead } }) => {
    const slot = plan.slots[id];
    const row = scopes.find(item => item.contact_id === slot.contactId);
    return row?.lead_id === slot.crmScope.leadId && row.pipeline_id === plan.pipelineId && row.stage_id === plan.stageId &&
      row.name === contact.name && row.display_name === contact.name && row.title === lead.title && row.description === lead.description &&
      row.status === lead.status && row.owner_user_id === actor.id && row.currency === lead.currency &&
      row.value_cents === null && row.expected_close_date === null;
  }), 'crm026_g_crm_scope_changed');
  const counts = one(await q(`select
    (select role from user_organizations where organization_id=$1 and user_id=$2 and accepted_at is not null and revoked_at is null) role,
    (select count(*)::int from user_organizations where organization_id=$1) members,
    (select count(*)::int from contacts where organization_id=$1) contacts,
    (select count(*)::int from crm_leads where organization_id=$1) leads,
    (select count(*)::int from conversations where organization_id=$1) conversations,
    (select count(*)::int from channel_sessions where organization_id=$1) channels,
    (select count(*)::int from ai_customer_memories where organization_id=$1) memories,
    (select count(*)::int from ai_workbench_runs where organization_id=$1) runs,
    (select count(*)::int from llm_calls where organization_id=$1) calls`, [org, actor.id]));
  const sources = await q(`select id,is_active,status,source_metadata from ai_knowledge_sources where organization_id=$1`, [org]);
  const integrations = await q(`select provider,enabled from ai_integration_settings where organization_id=$1
    and provider in ('mem0','weknora') order by provider`, [org]);
  assert(counts.role === 'manager' && counts.members === 1 && counts.contacts === 12 && counts.leads === 12 &&
    counts.conversations === 0 && counts.channels === 0 && counts.memories === 0 && counts.runs === 0 && counts.calls === 0 &&
    same(sources, [{ id: plan.sourceId, is_active: true, status: 'ready', source_metadata: sourceMeta(plan.kb.current) }]) &&
    same(integrations, [{ provider: 'mem0', enabled: false }, { provider: 'weknora', enabled: true }]), 'crm026_g_crm_isolation_changed');
  return counts;
}

export async function initializeGeneralization(memoryFixtureHash, inputHash) {
  assert(sha.test(memoryFixtureHash ?? '') && sha.test(inputHash ?? '') && process.env.CRM026_GENERALIZATION_SETUP === inputHash,
    'crm026_g_setup_exact_opt_in_required');
  return exclusively(async () => {
    product('candidate', PRODUCT_COMMIT);
    const [memory, input] = await Promise.all([loadMemoryEnvironment(memoryFixtureHash),
      read(GENERALIZATION_INPUT, inputHash).then(validateGeneralizationInput)]);
    let plan = await optional(files.intent);
    if (!plan) {
      plan = planGeneralization(memory, input, inputHash);
      await scopedTransaction({ connectionString: memory.env.SUPABASE_DB_URL }, true, q => guarded(q, memory, plan, false));
      await seal(files.intent, plan);
    }
    assert(plan.memoryFixtureHash === memoryFixtureHash && plan.inputHash === inputHash && plan.productCommit === PRODUCT_COMMIT &&
      plan.batch === memory.fixture.batch && plan.slug === `crm026-${plan.batch.slice(0, 8)}-generalization`, 'crm026_g_plan_changed');
    const options = { connectionString: memory.env.SUPABASE_DB_URL };
    await scopedTransaction(options, true, q => guarded(q, memory, plan, false));
    let identity = await optional(files.identity);
    const email = `crm026-${plan.batch}-generalization@example.test`;
    if (!identity) {
      identity = { email, password: randomBytes(32).toString('base64url') };
      await seal(files.identity, identity);
    }
    assert(identity.email === email && text(identity.password, 150), 'crm026_g_actor_plan_changed');
    const actor = await provisionActor(memory, plan, identity);
    await scopedTransaction(options, false, async q => {
      await seedCrm(q, memory, plan, input, actor);
      await readCrm(q, plan, actor, input);
    });
    const pages = await provisionWiki(plan, input.materialPool.pages);
    let key = await optional(files.key);
    if (!key) {
      assert(!(await optional(files.keyIntent)), 'crm026_g_wiki_key_unknown_do_not_repeat');
      await seal(files.keyIntent, { at: at(), batch: plan.batch, kbId: plan.kb.current });
      key = await createWikiAccess(plan);
      await seal(files.key, key);
    }
    await wikiAccessProof(plan, key.keyId, false);
    assert(key.status === 201 && text(key.token, 8192), 'crm026_g_wiki_key_receipt');
    const wiki = { organization_id: plan.organizationId, provider: 'weknora', base_url: WIKI_ORIGIN,
      api_key: key.token, knowledge_base_ids: [plan.kb.current], visibility: 'organization' };
    const runtime = { ...memory.env, AI_INTEGRATION_BINDINGS: JSON.stringify([wiki]) };
    const environmentHash = await sealOrVerify(files.runtime, runtime);
    const actorsHash = await sealOrVerify(files.actor, { [GENERALIZATION_ARM]: actor });
    const slots = Object.fromEntries(Object.entries(plan.slots).map(([id, slot]) => [id, { ...slot, actorUserId: actor.id }]));
    const marker = { organizationId: plan.organizationId, actorUserId: actor.id, slug: plan.slug };
    const fixtureHash = await sealOrVerify(files.fixture, { version: 1, batch: plan.batch, database: memory.fixture.database,
      productCommit: PRODUCT_COMMIT, memoryFixtureHash, environmentHash, actorsHash,
      inputHash, intentHash: digest(await readFile(files.intent)), keyId: key.keyId, sourceId: plan.sourceId, kbId: plan.kb.current,
      arms: { [GENERALIZATION_ARM]: marker }, slots, pages });
    return { fixtureHash, environmentHash, materialPages: pages.length, scopes: Object.keys(slots).length };
  });
}

export async function loadGeneralizationEnvironment(fixtureHash, { profilesHash: requiredProfiles, preflightHash: requiredPreflight } = {}) {
  assert(sha.test(fixtureHash ?? ''), 'crm026_g_fixture_hash_required');
  const fixture = await read(files.fixture, fixtureHash);
  const [memory, input, env, actors, plan, profiles, preflight] = await Promise.all([
    loadMemoryEnvironment(fixture.memoryFixtureHash), read(GENERALIZATION_INPUT, fixture.inputHash).then(validateGeneralizationInput),
    read(files.runtime, fixture.environmentHash), read(files.actor, fixture.actorsHash), read(files.intent, fixture.intentHash),
    requiredProfiles ? read(files.profiles, requiredProfiles) : optional(files.profiles),
    requiredPreflight ? read(files.preflight, requiredPreflight) : optional(files.preflight),
  ]);
  const [binding, extra] = JSON.parse(env.AI_INTEGRATION_BINDINGS);
  const marker = fixture.arms[GENERALIZATION_ARM];
  const actor = actors[GENERALIZATION_ARM];
  assert(fixture.productCommit === PRODUCT_COMMIT && fixture.batch === memory.fixture.batch &&
    same(fixture.database, memory.fixture.database) && fixture.database.mode === 'fresh' && plan.inputHash === fixture.inputHash &&
    binding?.organization_id === marker.organizationId && !extra && binding.provider === 'weknora' && binding.base_url === WIKI_ORIGIN &&
    binding.visibility === 'organization' && text(binding.api_key, 8192) && same(binding.knowledge_base_ids, [fixture.kbId]) &&
    same({ ...env, AI_INTEGRATION_BINDINGS: memory.env.AI_INTEGRATION_BINDINGS }, memory.env) && marker.organizationId === plan.organizationId &&
    marker.actorUserId === actor.id && marker.slug === plan.slug && fixture.kbId === plan.kb.current && fixture.sourceId === plan.sourceId &&
    same(Object.keys(fixture.slots), caseIds) && input.cases.every(({ id, task }) =>
      same(fixture.slots[id], { ...plan.slots[id], actorUserId: actor.id }) && digest(task) === fixture.slots[id].taskHash) &&
    fixture.pages.length === input.materialPool.pages.length && fixture.pages.every(page => page.sourceId === fixture.sourceId &&
      page.kbId === fixture.kbId && page.bodyHash === plan.pages[page.logicalId]?.bodyHash), 'crm026_g_runtime_drift');
  const profilesHash = profiles ? digest(await readFile(files.profiles)) : null;
  const preflightHash = preflight ? digest(await readFile(files.preflight)) : null;
  if (profiles) assert(profiles.fixtureHash === fixtureHash && profiles.environmentHash === fixture.environmentHash &&
    same(profiles.profiles[GENERALIZATION_ARM]?.sourceIds, [plan.sourceId]), 'crm026_g_profile_receipt_binding');
  if (preflight) assert(preflight.fixtureHash === fixtureHash && preflight.environmentHash === fixture.environmentHash &&
    preflight.profilesHash === profilesHash && preflight.ready && preflight.noModel && same(preflight.sourceIds, [plan.sourceId]),
  'crm026_g_preflight_receipt_binding');
  return { fixture, fixtureHash, environmentHash: fixture.environmentHash, env, actors, profiles, profilesHash,
    preflight, preflightHash, memory, plan, input, pages: fixture.pages };
}

export function generalizationTransaction(c, readOnly, action) {
  return scopedTransaction({ connectionString: c.env.SUPABASE_DB_URL }, readOnly, async q => {
    await guarded(q, c.memory, c.plan, true);
    return action(q);
  });
}

export function confirmGeneralizationWorker(c) {
  return generalizationTransaction(c, true, async q => {
    const state = await guardForeignWork(q, 'fresh', [c.plan.organizationId,
      ...Object.values(c.memory.fixture.arms).map(row => row.organizationId)]);
    const previous = one(await q(`select
      exists(select 1 from job_queue where organization_id<>$1 and status in ('pending','running')) jobs,
      exists(select 1 from ai_workbench_runs where organization_id<>$1 and status in ('queued','running','awaiting_confirmation')) runs`,
    [c.plan.organizationId]));
    assert(!previous.jobs && !previous.runs, 'crm026_g_previous_jobs_not_settled');
    return { ...state, previousRunsSettled: true };
  });
}

async function withActor(c, callback) {
  const actor = c.actors[GENERALIZATION_ARM];
  const cookies = new Map();
  const auth = createServerClient(c.env.NEXT_PUBLIC_SUPABASE_URL, c.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookieOptions: { name: 'sb-pi-native-auth' },
    cookies: { getAll: () => Array.from(cookies, ([name, value]) => ({ name, value })),
      setAll: values => { for (const { name, value } of values) if (value) cookies.set(name, value); else cookies.delete(name); } },
    global: { fetch: transportFetch },
  });
  const login = await auth.auth.signInWithPassword({ email: actor.email, password: actor.password });
  const current = await auth.auth.getUser();
  assert(!login.error && !current.error && login.data.user?.id === actor.id && current.data.user?.id === actor.id,
    'crm026_g_actor_login_not_verified');
  cookies.set('active_org', c.plan.organizationId);
  return callback(async (path, method = 'GET', data) => {
    const headers = { Origin: WEB, Cookie: Array.from(cookies, ([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ') };
    if (data) headers['Content-Type'] = 'application/json';
    const response = await fetch(WEB + path, { method, headers, redirect: 'error', signal: AbortSignal.timeout(90_000),
      ...(data ? { body: JSON.stringify(data) } : {}) });
    const body = await response.json().catch(() => null);
    return { httpStatus: response.status, data: body?.data ?? null, errorCode: body?.error?.code ?? null,
      requestId: body?.meta?.request_id ?? response.headers.get('x-request-id') };
  }, auth);
}

export function generalizationTransport(c, slot, callback) {
  const profile = c.profiles?.profiles?.[GENERALIZATION_ARM];
  const frozen = c.fixture.slots[slot?.key];
  assert(frozen && (same(slot, frozen) || profile && same(slot, { ...frozen, versionId: profile.versionId })), 'crm026_g_frozen_slot_required');
  return withActor(c, request => callback((path, method = 'GET', data) => {
    const submit = method === 'POST' && path === WORKBENCH && c.preflight?.ready === true && uuid.test(profile?.agentId ?? '') &&
      same(data, { agentId: profile.agentId, task: data?.task, mode: 'inspect', collaboration: 'disabled', scope: slot.crmScope }) &&
      typeof data.task === 'string' && digest(data.task) === slot.taskHash;
    const read = method === 'GET' && !data && path === contactPath(slot.contactId);
    assert(submit || read, 'crm026_g_transport_outside_frozen_scope');
    return request(path, method, data);
  }));
}

async function profileFor(c, route) {
  const row = await generalizationTransaction(c, true, async q => one(await q(`select a.id "agentId",a.builtin_revision "builtinRevision",
    v.id "versionId",v.provider,v.model,v.system_prompt prompt,v.tool_ids "toolIds",v.max_steps "maxSteps",
    v.token_budget "tokenBudget",v.cost_budget_cents "storedCostBudgetCents",v.knowledge_source_ids "sourceIds",
    o.settings->'llm'->'params'->'temperature' temperature
    from ai_agents a join organizations o on o.id=a.organization_id
    join ai_agent_versions v on v.organization_id=a.organization_id and v.agent_id=a.id
    where a.organization_id=$1 and a.origin='builtin' and a.builtin_key='sales_operations' and a.archived_at is null and v.status='draft'
    order by v.version_number desc limit 1`, [c.plan.organizationId])));
  assert(route.httpStatus === 200 && Array.isArray(route.data) && route.data.some(item => item.id === row.agentId) &&
    row.provider === MODEL.provider && row.model === MODEL.model && row.temperature === MODEL.temperature &&
    row.maxSteps === MODEL.maxSteps && row.tokenBudget === MODEL.tokenBudget && same(row.sourceIds, [c.plan.sourceId]) &&
    row.toolIds.includes('crm_get_contact') && row.toolIds.includes('crm_get_lead') && row.toolIds.includes('crm_search_knowledge'),
  'crm026_g_native_agent_profile');
  const { prompt, agentId, versionId, ...invariant } = row;
  const promptHash = digest(prompt);
  return { agentId, versionId, ...invariant, promptHash, profileHash: digest(JSON.stringify({ ...invariant, promptHash })), routeRequestId: route.requestId };
}

export async function preflightGeneralization(fixtureHash) {
  assert(sha.test(fixtureHash ?? '') && process.env.CRM026_GENERALIZATION_SETUP === fixtureHash,
    'crm026_g_preflight_exact_opt_in_required');
  return exclusively(async () => {
    product('candidate', PRODUCT_COMMIT);
    const c = await loadGeneralizationEnvironment(fixtureHash);
    if (c.preflight) return { fixtureHash, profilesHash: c.profilesHash, preflightHash: c.preflightHash };
    const prior = await read(resolve(ROOT, '.local/crm025/fixtures.json'), '3b2cc4bf035218d3bfa6352692d6c2b18101666957a4b1bfe9021c2d188bf730');
    const foreignPage = Object.values(prior.pages).find(row => row.state === 'published' && row.orgId === prior.org);
    assert(foreignPage, 'crm026_g_wiki_known_foreign_probe_missing');
    const [binding] = JSON.parse(c.env.AI_INTEGRATION_BINDINGS);
    const wiki = await preflightWiki(c.plan, c.input.materialPool.pages, c.pages, c.fixture.keyId, binding.api_key, foreignPage);
    const actor = c.actors[GENERALIZATION_ARM];
    const authReads = await withActor(c, async (request, auth) => {
      const source = await request(sourcePath(c.plan.sourceId));
      assert(source.httpStatus === 200 && source.data?.id === c.plan.sourceId && source.data.organization_id === c.plan.organizationId &&
        source.data.source_type === 'wiki' && source.data.is_active && same(source.data.source_metadata, sourceMeta(c.plan.kb.current)),
      'crm026_g_crm_source_readback');
      const all = Object.values(c.fixture.slots);
      const leads = await auth.from('crm_leads').select('id,contact_id,pipeline_id,organization_id,title,description,value_cents,status')
        .eq('organization_id', c.plan.organizationId).in('id', all.map(row => row.crmScope.leadId));
      assert(!leads.error && leads.data.length === all.length && c.input.cases.every(({ id, crmFixture: { lead } }) => {
        const slot = c.fixture.slots[id], read = leads.data.find(row => row.id === slot.crmScope.leadId);
        return read?.contact_id === slot.contactId && read.organization_id === c.plan.organizationId && read.pipeline_id === c.plan.pipelineId &&
          read.title === lead.title && read.description === lead.description && read.value_cents === null && read.status === lead.status;
      }), 'crm026_g_authenticated_lead_readback');
      const contacts = [];
      for (const slot of all) {
        const response = await request(contactPath(slot.contactId));
        assert(response.httpStatus === 200 && response.data?.id === slot.contactId && response.data.organization_id === c.plan.organizationId,
          'crm026_g_authenticated_contact_readback');
        contacts.push({ caseId: slot.caseId, status: response.httpStatus, requestId: response.requestId });
      }
      const sourceActorContact = Object.values(c.memory.fixture.arms.none.contacts)[0].contactId;
      const denied = await request(contactPath(sourceActorContact));
      assert(denied.httpStatus === 404 && denied.data === null, 'crm026_g_other_organization_contact_exposed');
      return { source: source.httpStatus, contacts, leads: leads.data.length, outsideOrganizationContact: denied.httpStatus };
    });
    const route = await withActor(c, request => request(AGENTS));
    const profile = await profileFor(c, route);
    const { verifyWikiSearch } = await import('./crm026-generalization-environment-search.mjs');
    const search = await verifyWikiSearch(c, generalizationTransaction);
    const observed = search.positive.receipts.find(row => row.logicalId === 'W03') ??
      search.positive.receipts[0] ?? search.negative.receipts[0];
    const matchingPage = c.pages.find(row => row.logicalId === observed?.logicalId);
    const evidenceReadback = await withActor(c, async request => {
      if (!observed) return { httpStatus: null, reason: 'no_retrieval_receipt_available' };
      assert(matchingPage && uuid.test(observed.id), 'crm026_g_probe_receipt_scope');
      const response = await request(evidencePath(observed.id));
      assert(response.httpStatus === 200 && response.data?.id === observed.id &&
        digest(response.data.content ?? '') === matchingPage.bodyHash, 'crm026_g_product_evidence_readback');
      return { logicalId: observed.logicalId, receiptId: observed.id, httpStatus: response.httpStatus, requestId: response.requestId };
    });
    const counts = await generalizationTransaction(c, true, q => readCrm(q, c.plan, actor, c.input));
    const priorProfile = c.profiles?.profiles?.[GENERALIZATION_ARM];
    const next = { ...profile, routeRequestId: priorProfile?.routeRequestId ?? profile.routeRequestId };
    const profilesHash = await sealOrVerify(files.profiles, { version: 1, fixtureHash, environmentHash: c.environmentHash,
      profiles: { [GENERALIZATION_ARM]: next } });
    const preflightHash = await seal(files.preflight, { version: 1, at: at(), fixtureHash, profilesHash,
      environmentHash: c.environmentHash, inputHash: c.fixture.inputHash, sourceIds: [c.plan.sourceId],
      ready: true, noModel: true, counts, wiki, authReads, search, evidenceReadback });
    return { fixtureHash, profilesHash, preflightHash, scopes: counts.leads, currentWikiPages: wiki.checks.length, generatedRoots: counts.runs };
  });
}

async function archiveCrm(c) {
  return generalizationTransaction(c, false, async q => {
    const org = c.plan.organizationId;
    const actorId = c.actors[GENERALIZATION_ARM].id;
    const open = one(await q(`select
      exists(select 1 from ai_workbench_runs where organization_id=$1 and status in ('queued','running','awaiting_confirmation')) runs,
      exists(select 1 from job_queue where organization_id=$1 and status in ('pending','running')) jobs`, [org]));
    assert(!open.runs && !open.jobs, 'crm026_g_cleanup_active_work');
    const source = one(await q(`select id,status,is_active,source_metadata from ai_knowledge_sources
      where organization_id=$1 and id=$2 and source_type='wiki'`, [org, c.plan.sourceId]));
    assert(same(source.source_metadata, sourceMeta(c.plan.kb.current)) &&
      (source.status === 'ready' && source.is_active || source.status === 'archived' && !source.is_active), 'crm026_g_cleanup_source_changed');
    if (source.is_active) {
      one(await q(`update ai_knowledge_sources set status='archived',is_active=false where id=$1 and organization_id=$2
        and status='ready' and is_active returning id`, [source.id, org]));
    }
    const membership = one(await q(`select role,revoked_at::text from user_organizations where organization_id=$1 and user_id=$2`,
      [org, actorId]));
    assert(membership.role === 'manager', 'crm026_g_cleanup_foreign_member');
    const revokedAt = membership.revoked_at ?? one(await q(`update user_organizations set revoked_at=now() where organization_id=$1
      and user_id=$2 and role='manager' and revoked_at is null returning revoked_at::text`, [org, actorId])).revoked_at;
    one(await q(`update ai_integration_settings set enabled=false where organization_id=$1 and provider='weknora' returning provider`, [org]));
    return { sourceId: source.id, actorRevokedAt: revokedAt, integrationDisabled: true, businessRecordsRetained: true };
  });
}

export async function closeGeneralizationResources(fixtureHash) {
  assert(sha.test(fixtureHash ?? '') && process.env.CRM026_GENERALIZATION_SETUP === fixtureHash,
    'crm026_g_cleanup_exact_opt_in_required');
  return exclusively(async () => {
    const c = await loadGeneralizationEnvironment(fixtureHash);
    const identity = { fixtureHash, keyId: c.fixture.keyId, sourceId: c.plan.sourceId, kbId: c.plan.kb.current };
    const closed = await optional(files.closed);
    if (closed) {
      assert(Object.entries(identity).every(([k, v]) => closed[k] === v), 'crm026_g_cleanup_receipt_changed');
      return { fixtureHash, cleanupHash: digest(await readFile(files.closed)) };
    }
    await sealOrVerify(files.closeIntent, identity);
    const crm = await archiveCrm(c);
    const keyState = await wikiTransaction(true, async q => one(await q(`select revoked_at::text from tenant_api_keys
      where id=$1 and tenant_id=$2`, [identity.keyId, ALPHA_TENANT])));
    if (!keyState.revoked_at) {
      assert(!(await optional(files.keyCloseIntent)), 'crm026_g_cleanup_key_unknown_do_not_repeat');
      await wikiAccessProof(c.plan, identity.keyId, false);
      await seal(files.keyCloseIntent, identity);
      await revokeWikiAccess(c.plan, identity.keyId);
    }
    const key = await wikiAccessProof(c.plan, identity.keyId, true);
    const [binding] = JSON.parse(c.env.AI_INTEGRATION_BINDINGS);
    const denied = await retrieve(binding.api_key, pagePath(c.pages[0]));
    assert([401, 403, 404].includes(denied.status), 'crm026_g_cleanup_key_readback_failed');
    const wiki = await archiveWiki(c.plan, c.input.materialPool.pages, c.pages);
    const cleanupHash = await seal(files.closed, { ...identity, at: at(), crm, wiki, revokedAt: key.revoked_at,
      revokedKeyStatus: denied.status, sourceEvidenceRetained: true });
    return { fixtureHash, cleanupHash };
  });
}

async function main([command, first, second, ...rest]) {
  assert(!rest.length, 'crm026_g_cli_arguments');
  if (command === 'initialize' && first && second) return initializeGeneralization(first, second);
  if (command === 'preflight' && first && !second) return preflightGeneralization(first);
  if (command === 'worker-guard' && first && !second) return confirmGeneralizationWorker(await loadGeneralizationEnvironment(first));
  if (command === 'cleanup' && first && !second) return closeGeneralizationResources(first);
  throw Error('crm026_g_cli_arguments');
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) main(process.argv.slice(2)).then(value => {
  console.info(JSON.stringify(value));
}, error => {
  const code = /^crm026_[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : 'crm026_generalization_environment_failed';
  console.error(JSON.stringify({ error: code, ...(typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? { sqlState: error.code } : {}) }));
  process.exitCode = 1;
});
