/** New CRM-024-owned fixtures in the pre-existing isolated CRM and local Wiki. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv, isDeepStrictEqual as same } from 'node:util';
import pg from 'pg';
import { loadEnvironment } from './crm022-sales.mjs';

export const ROOT = resolve(import.meta.dirname, '../..');
export const BASE = resolve(ROOT, '.local/crm024');
const OLD = resolve(ROOT, '.local/crm022');
const WIKI_ORIGIN = 'http://127.0.0.1:8088';
const localOrg = 'd22e3375-d7e1-43a2-8ce9-b5017c98b338';
const localInstance = '7708392892596248609';
const salesKey = 'sales_operations';
export const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export const sha = /^[a-f0-9]{64}$/;
export const at = () => new Date().toISOString();
export const bytes = value => JSON.stringify(value, null, 2) + '\n';
export const digest = value => createHash('sha256').update(value).digest('hex');
export const one = rows => { assert(rows.length === 1, 'crm024_exactly_one_owner_required'); return rows[0]; };
export const folder = phase => resolve(BASE, 'paired', phase);

export async function read(path, hash) {
  const raw = await readFile(path);
  assert(!hash || sha.test(hash) && digest(raw) === hash, 'crm024_frozen_file_changed');
  return JSON.parse(raw);
}
export async function optional(path) {
  try { return await read(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function seal(path, value, print = true) {
  const raw = bytes(value);
  await writeFile(path, raw, { flag: 'wx', mode: 0o600 });
  const receipt = { path, sha256: digest(raw) };
  if (print) console.info(JSON.stringify(receipt));
  return receipt;
}

function wikiBinding(env, org) {
  const bindings = JSON.parse(env.AI_INTEGRATION_BINDINGS ?? '[]');
  const binding = one(bindings.filter(row => row.organization_id === org && row.provider === 'weknora'));
  assert(binding.base_url.replace(/\/$/, '') === WIKI_ORIGIN && binding.visibility === 'organization' &&
    typeof binding.api_key === 'string' && binding.api_key.length && Array.isArray(binding.knowledge_base_ids), 'crm024_local_wiki_binding_required');
  return binding;
}

export async function context(useNewEnvironment = false) {
  const oldEnv = await loadEnvironment();
  const oldFixture = await read(resolve(OLD, 'paired/fixtures.json'));
  const original = await read(resolve(OLD, 'paired/formal-frozen.json'));
  const oldActors = await read(resolve(OLD, 'actors.private.json'));
  assert(oldEnv.CRM022_ORG_ID === localOrg && oldEnv.CRM022_ORG_SLUG === 'crm022-synthetic-eval' &&
    oldFixture.org === localOrg && oldFixture.databaseId === localInstance && uuid.test(oldActors.initiator?.id) &&
    uuid.test(oldFixture.agent.id) && uuid.test(oldFixture.sourceId) && typeof oldFixture.sourceKb === 'string', 'crm024_existing_isolation_required');
  await read(resolve(OLD, 'paired/fixtures.json'), original.fixtureHash);
  const authorization = useNewEnvironment ? await optional(resolve(BASE, 'wiki-key-result.json')) : null;
  const runtimeName = authorization ? 'runtime-authorized.env' : 'runtime.env';
  const liveEnvironment = useNewEnvironment ? await readFile(resolve(BASE, runtimeName), 'utf8') : null;
  assert(!authorization || digest(liveEnvironment) === authorization.environmentHash, 'crm024_authorized_runtime_changed');
  const env = liveEnvironment ? parseEnv(liveEnvironment) : oldEnv;
  assert(['SUPABASE_DB_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'NEXT_PUBLIC_APP_URL', 'CRM022_ORG_ID',
    'CRM_LOCAL_WORKBENCH_UNPRICED_MODE', 'INTERNAL_AGENT_RUN_STUB'].every(key => env[key] === oldEnv[key]), 'crm024_runtime_isolation_changed');
  const binding = wikiBinding(env, localOrg);
  assert(binding.knowledge_base_ids.includes(oldFixture.sourceKb), 'crm024_old_wiki_binding_changed');
  if (useNewEnvironment) {
    const bindings = JSON.parse(env.AI_INTEGRATION_BINDINGS);
    assert(!bindings.some(row => row.organization_id === localOrg && ['mem0', 'langfuse'].includes(row.provider)) &&
      env.NODE_ENV === 'development', 'crm024_confirmed_facts_must_stay_local');
  }
  return { env, envHash: liveEnvironment ? digest(liveEnvironment) : null, org: localOrg, databaseId: localInstance, initiatorUserId: oldActors.initiator.id, oldFixture, original, binding };
}

async function transaction(options, readOnly, action) {
  const pool = new pg.Pool({ ...options, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 10000,
    query_timeout: 12000, ...(readOnly ? { options: '-c default_transaction_read_only=on' } : {}) });
  let lost = false, client;
  pool.on('error', () => { lost = true; });
  try {
    client = await pool.connect();
    client.on('error', () => { lost = true; });
    await client.query(readOnly ? 'begin isolation level repeatable read read only' : 'begin isolation level serializable');
    await client.query("set local lock_timeout='5s'");
    const q = async (statement, parameters = []) => {
      assert(!readOnly || /^(select|with)\b/i.test(statement.trim()), 'crm024_readonly_query_required');
      const { rows } = await client.query(statement, parameters);
      assert(!lost, 'crm024_database_disconnected');
      return rows;
    };
    const output = await action(q);
    await client.query('commit');
    assert(!lost, 'crm024_database_disconnected');
    return output;
  } finally {
    try { if (client) { try { await client.query('rollback'); } finally { client.release(); } } }
    finally { await pool.end(); }
  }
}

export async function crm(c, readOnly, action) {
  return transaction({ connectionString: c.env.SUPABASE_DB_URL }, readOnly, async q => {
    const owner = one(await q(`select current_database() name,system_identifier::text instance,
      (select count(*)::int from organizations) total,(select slug from organizations where id=$1::uuid) slug,
      (select role from user_organizations where organization_id=$1::uuid and user_id=$2::uuid and revoked_at is null and accepted_at is not null) role
      from pg_control_system()`, [c.org, c.initiatorUserId]));
    assert(owner.name === 'postgres' && owner.instance === c.databaseId && owner.total === 1 && owner.slug === 'crm022-synthetic-eval' &&
      ['admin', 'manager'].includes(owner.role), 'crm024_exact_isolated_crm_required');
    return action(q);
  });
}

async function wikiStore(c, readOnly, action) {
  const ownership = JSON.parse(execFileSync('docker', ['inspect', 'crm-agent-services-postgres-1', '--format',
    '{"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"ports":{{json (index .NetworkSettings.Ports "5432/tcp")}}}'],
  { encoding: 'utf8', windowsHide: true, timeout: 10000 }));
  assert(ownership.project === 'crm-agent-services' && ownership.service === 'postgres' && ownership.ports?.some(port =>
    port.HostIp === '127.0.0.1' && port.HostPort === '5438'), 'crm024_owned_wiki_database_required');
  const env = parseEnv(await readFile(resolve(ROOT, 'infra/local-agent-services/.env.generated'), 'utf8'));
  assert(typeof env.POSTGRES_PASSWORD === 'string' && env.POSTGRES_PASSWORD.length, 'crm024_owned_wiki_db_credentials_missing');
  return transaction({ host: '127.0.0.1', port: 5438, database: 'weknora', user: 'postgres', password: env.POSTGRES_PASSWORD }, readOnly, async q => {
    const tenant = one(await q(`select tenant_id::text tenant,(select current_database()) db from knowledge_bases
      where id=$1::varchar and deleted_at is null and type='wiki'`, [c.oldFixture.sourceKb]));
    assert(tenant.db === 'weknora' && /^\d+$/.test(tenant.tenant), 'crm024_old_wiki_tenant_required');
    return action(q, tenant.tenant);
  });
}

export async function idle(q, c) {
  const state = one(await q(`select count(*)::int busy from job_queue where organization_id=$1::uuid
    and kind in ('workbench_start','workbench_resume') and status in ('pending','running')`, [c.org]));
  assert(state.busy === 0, 'crm024_workbench_queue_busy');
}

async function oldVersionSnapshot(q, c) {
  const builtin = await q(`select a.id agent_id,a.builtin_key,a.builtin_revision,a.origin,a.published_version_id,v.id prior_version,v.version_number,
    v.status,v.provider,v.model,v.knowledge_source_ids,encode(sha256(convert_to(to_jsonb(v)::text,'utf8')),'hex') prior_hash
    from ai_agents a join lateral (select * from ai_agent_versions where organization_id=$1::uuid and agent_id=a.id order by version_number desc limit 1) v on true
    where a.organization_id=$1::uuid and a.origin='builtin' and a.archived_at is null order by a.builtin_key`, [c.org]);
  assert(builtin.length === 4 && builtin.every(row => row.status === 'draft' && uuid.test(row.prior_version)) &&
    builtin.some(row => row.agent_id === c.oldFixture.agent.id && row.builtin_key === salesKey), 'crm024_existing_builtin_drafts_required');
  return builtin;
}

async function sourceIds(q, c) {
  return (await q('select id from ai_knowledge_sources where organization_id=$1::uuid and is_active=true order by id', [c.org])).map(row => row.id);
}

function resourcePages(protocol) {
  const pages = protocol.materials.wikiPages;
  assert(Array.isArray(pages) && pages.length > 0 && pages.length <= 12 && pages.every(page =>
    /^[a-z0-9_-]{1,64}$/.test(page.key) && /^crm024\/[a-z0-9_-]{1,64}$/.test(page.slug) && typeof page.title === 'string' && page.title.length <= 128 &&
    typeof page.body === 'string' && page.body.trim() && Buffer.byteLength(page.body) <= 6000) &&
    new Set(pages.map(page => page.key)).size === pages.length && new Set(pages.map(page => page.slug)).size === pages.length, 'crm024_fixed_synthetic_pages_required');
  return pages;
}

export async function prepareMaterials(c, protocol, protocolHash) {
  assert(!(await optional(resolve(BASE, 'materials-intent.json'))), 'crm024_existing_material_intent');
  await mkdir(BASE, { recursive: true });
  const [baseline, tenant] = await Promise.all([
    crm(c, true, async q => { await idle(q, c); return { builtin: await oldVersionSnapshot(q, c), sources: await sourceIds(q, c) }; }),
    wikiStore(c, true, (_q, tenantId) => tenantId),
  ]);
  assert(same(baseline.sources, [c.oldFixture.sourceId]), 'crm024_only_original_synthetic_source_required');
  const plan = { protocolHash, at: at(), org: c.org, databaseId: c.databaseId, tenant, editionId: randomUUID(), kbId: randomUUID(), sourceId: randomUUID(),
    pipelineId: randomUUID(), stages: { qualification: randomUUID(), proposal: randomUUID() }, priorSourceIds: baseline.sources,
    seedImplementation: digest(await readFile(import.meta.filename)),
    builtin: baseline.builtin.map(before => ({ ...before, versionId: randomUUID(), restoreId: randomUUID() })),
    pages: resourcePages(protocol).map(page => ({ key: page.key, slug: page.slug, pageId: randomUUID(), documentId: randomUUID(), contentHash: digest(page.body) })) };
  return seal(resolve(BASE, 'materials-plan.json'), plan);
}

async function cloneDraft(q, c, row, newId, number, knowledge) {
  return one(await q(`insert into ai_agent_versions select (jsonb_populate_record(null::ai_agent_versions,
      to_jsonb(v)||jsonb_build_object('id',$4::uuid,'version_number',$5::int,'knowledge_source_ids',$6::uuid[],
      'created_at',clock_timestamp(),'created_by',$7::uuid,'status','draft','published_at',null,'superseded_at',null))).*
    from ai_agent_versions v where v.organization_id=$1::uuid and v.agent_id=$2::uuid and v.id=$3::uuid
    and encode(sha256(convert_to(to_jsonb(v)::text,'utf8')),'hex')=$8 returning id`,
  [c.org, row.agent_id, row.prior_version, newId, number, knowledge, c.initiatorUserId, row.prior_hash]));
}

async function createRuntime(c, plan, name = 'runtime.env', token) {
  const originally = await readFile(resolve(OLD, 'runtime.env'), 'utf8');
  const binding = JSON.parse(c.env.AI_INTEGRATION_BINDINGS).filter(row => row.organization_id !== c.org || !['mem0', 'langfuse'].includes(row.provider));
  const wiki = one(binding.filter(row => row.organization_id === c.org && row.provider === 'weknora'));
  wiki.knowledge_base_ids = [c.oldFixture.sourceKb, plan.kbId];
  if (token) wiki.api_key = token;
  const value = JSON.stringify(binding);
  assert(!/['\r\n]/.test(value) && /^\s*AI_INTEGRATION_BINDINGS\s*=.+$/m.test(originally), 'crm024_runtime_env_binding_encoding');
  const runtime = originally.replace(/^[ \t]*(?:AI_INTEGRATION_BINDINGS|SENTRY_DSN|NEXT_PUBLIC_SENTRY_DSN)[ \t]*=.*$/gm, '').trimEnd() +
    `\nAI_INTEGRATION_BINDINGS='${value}'\nSENTRY_DSN=off\nNEXT_PUBLIC_SENTRY_DSN=\n`;
  assert(parseEnv(runtime).AI_INTEGRATION_BINDINGS === value, 'crm024_runtime_env_multiline_binding');
  const path = resolve(BASE, name);
  await writeFile(path, runtime, { flag: 'wx', mode: 0o600 });
  return { path, environmentHash: digest(runtime) };
}

export async function authorizeWiki(c, materials, proofHash) {
  assert(materials.org === c.org && materials.databaseId === c.databaseId && uuid.test(materials.kbId) &&
    materials.kbId !== c.oldFixture.sourceKb && typeof materials.tenant === 'string' && /^\d+$/.test(materials.tenant) &&
    !(await optional(resolve(BASE, 'wiki-key-intent.json'))), 'crm024_owned_retrieve_key_inputs_required');
  await wikiStore(c, true, async (q, tenant) => {
    assert(tenant === materials.tenant, 'crm024_wiki_tenant_changed');
    const owned = one(await q('select id,description from knowledge_bases where id=$1 and tenant_id=$2 and deleted_at is null', [materials.kbId, tenant]));
    assert(owned.description === `crm024:${materials.editionId}`, 'crm024_wiki_creation_marker_missing');
  });
  const values = parseEnv(await readFile(resolve(ROOT, 'infra/local-agent-services/.env.generated'), 'utf8'));
  assert(values.WEKNORA_TENANT_ID === materials.tenant && typeof values.WEKNORA_USER_PASSWORD === 'string' && values.WEKNORA_USER_PASSWORD.length,
    'crm024_existing_local_wiki_admin_required');
  const headers = { 'Content-Type': 'application/json' };
  const login = await fetch(`${WIKI_ORIGIN}/api/v1/auth/login`, { method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ email: 'agent-services@localhost.test', password: values.WEKNORA_USER_PASSWORD }) });
  const identity = await login.json().catch(() => null);
  assert(login.ok && identity?.success && String(identity.active_tenant?.id) === materials.tenant && typeof identity.token === 'string', 'crm024_existing_wiki_admin_login_failed');
  const scope = { name: `CRM024只读检索-${materials.editionId.slice(0, 8)}`, full_access: false,
    knowledge_base_ids: [c.oldFixture.sourceKb, materials.kbId], capabilities: ['retrieve'] };
  await seal(resolve(BASE, 'wiki-key-intent.json'), { at: at(), proofHash, tenant: materials.tenant, ...scope, maximumPosts: 1 }, false);
  let response;
  try {
    response = await fetch(`${WIKI_ORIGIN}/api/v1/tenants/${materials.tenant}/api-keys`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { ...headers, Authorization: `Bearer ${identity.token}` }, body: JSON.stringify(scope) });
  } catch { /* Immutable intent prevents another token request when the result is uncertain. */ }
  await seal(resolve(BASE, 'wiki-key-receipt.json'), { at: at(), proofHash, tenant: materials.tenant, httpStatus: response?.status ?? null,
    accepted: response?.ok ?? false, ...scope, oldKeyChanged: false, servicesReloaded: false }, false);
  assert(response?.ok, 'crm024_retrieve_only_key_unconfirmed_do_not_retry');
  const result = await response.json().catch(() => null);
  assert(typeof result?.data?.token === 'string' && result.data.token.length > 10 && !/['\r\n]/.test(result.data.token), 'crm024_retrieve_only_key_missing');
  const runtime = await createRuntime(c, materials, 'runtime-authorized.env', result.data.token);
  return seal(resolve(BASE, 'wiki-key-result.json'), { at: at(), proofHash, keyId: result.data.id ?? null, ...runtime,
    tenant: materials.tenant, knowledgeBaseIds: scope.knowledge_base_ids, capabilities: scope.capabilities, fullAccess: false, noModel: true });
}

export async function seedMaterials(c, protocol, protocolHash, plan, planHash) {
  const pages = resourcePages(protocol);
  assert(plan.protocolHash === protocolHash && plan.org === c.org && plan.databaseId === c.databaseId && plan.pages.length === pages.length &&
    plan.seedImplementation === digest(await readFile(import.meta.filename)) &&
    plan.pages.every((row, index) => row.key === pages[index].key && row.slug === pages[index].slug && row.contentHash === digest(pages[index].body)),
  'crm024_owned_material_plan_changed');
  await seal(resolve(BASE, 'materials-intent.json'), { at: at(), planHash, protocolHash, kbId: plan.kbId, sourceId: plan.sourceId }, false);
  const wiki = await wikiStore(c, false, async (q, tenant) => {
    assert(tenant === plan.tenant, 'crm024_wiki_tenant_changed');
    const ids = [plan.kbId, ...plan.pages.flatMap(row => [row.pageId, row.documentId])];
    assert(ids.every(id => uuid.test(id)) && new Set(ids).size === ids.length, 'crm024_fixture_uuid_collision');
    const collisions = await q(`select id from knowledge_bases where id=any($1::varchar[]) union all select id from knowledges where id=any($1::varchar[])
      union all select id from wiki_pages where id=any($1::varchar[])`, [ids]);
    assert(!collisions.length, 'crm024_wiki_fixture_exists_do_not_retry');
    one(await q(`insert into knowledge_bases(id,tenant_id,name,description,type,embedding_model_id,summary_model_id,indexing_strategy,wiki_config)
      values($1,$2,'CRM024 合成政策',$3,'wiki','','','{"wiki_enabled":true,"vector_enabled":false,"keyword_enabled":false,"graph_enabled":false}'::jsonb,'{}'::jsonb) returning id`,
    [plan.kbId, tenant, `crm024:${plan.editionId}`]));
    const inserted = [];
    for (const [index, expected] of pages.entries()) {
      const target = plan.pages[index];
      const marker = JSON.stringify({ synthetic: true, batch: plan.editionId, manual_seed: true });
      const document = one(await q(`insert into knowledges(id,tenant_id,knowledge_base_id,type,title,source,parse_status,enable_status,file_name,
        file_type,file_size,file_hash,metadata,custom_metadata,processed_at) values($1,$2,$3,'manual',$4,'manual','completed','enabled',$5,'md',$6,$7,
        $8::jsonb,$9::jsonb,now()) returning id,updated_at::text`,
      [target.documentId, tenant, plan.kbId, expected.title, `crm024-${expected.key}.md`, Buffer.byteLength(expected.body), target.contentHash,
        JSON.stringify({ content: expected.body }), marker]));
      const page = one(await q(`insert into wiki_pages(id,tenant_id,knowledge_base_id,slug,title,page_type,status,content,source_refs,chunk_refs,
        version,page_metadata,last_edit_source,last_editor_id) values($1,$2,$3,$4,$5,'concept','published',$6,$7::jsonb,'[]'::jsonb,1,$8::jsonb,
        'manual','crm024-agent-seed') returning id,version,updated_at::text`,
      [target.pageId, tenant, plan.kbId, expected.slug, expected.title, expected.body, JSON.stringify([target.documentId]), marker]));
      inserted.push({ ...target, title: expected.title, version: page.version, updatedAt: page.updated_at, documentUpdatedAt: document.updated_at });
    }
    return inserted;
  });
  await seal(resolve(BASE, 'materials-wiki-receipt.json'), { at: at(), planHash, wiki, noProviderModel: true, manualSeed: true }, false);
  await crm(c, false, async q => {
    await idle(q, c);
    assert(same(await sourceIds(q, c), plan.priorSourceIds) && same(await oldVersionSnapshot(q, c),
      plan.builtin.map(({ versionId: _version, restoreId: _restore, ...row }) => row)), 'crm024_existing_configuration_changed');
    one(await q(`insert into ai_knowledge_sources(id,organization_id,source_type,name,status,is_active,source_metadata)
      values($1,$2,'wiki','CRM024 合成政策','ready',true,$3::jsonb) returning id`, [plan.sourceId, c.org,
    JSON.stringify({ provider: 'weknora', knowledge_base_id: plan.kbId, visibility: 'organization' })]));
    const active = await sourceIds(q, c);
    for (const row of plan.builtin) {
      const knowledge = row.knowledge_source_ids.length ? active : [];
      await cloneDraft(q, c, row, row.versionId, row.version_number + 1, knowledge);
    }
    one(await q(`insert into crm_pipelines(id,organization_id,name,slug) values($1,$2,'CRM024 合成销售',$3) returning id`,
    [plan.pipelineId, c.org, `crm024-${plan.editionId.slice(0, 8)}`]));
    for (const [index, [key, title]] of [['qualification', '需求确认'], ['proposal', '方案拟定']].entries()) {
      one(await q(`insert into crm_stages(id,organization_id,pipeline_id,name,slug,position) values($1,$2,$3,$4,$5,$6) returning id`,
      [plan.stages[key], c.org, plan.pipelineId, title, `crm024-${key}`, 1000 * (index + 1)]));
    }
  });
  await createRuntime(c, plan);
  return seal(resolve(BASE, 'materials.json'), { ...plan, at: at(), planHash, protocolHash, wiki, noModel: true });
}

export async function material(c, protocolHash) {
  const row = await read(resolve(BASE, 'materials.json'));
  assert(row.protocolHash === protocolHash && row.org === c.org && row.databaseId === c.databaseId &&
    c.binding.knowledge_base_ids.includes(row.kbId) && uuid.test(row.sourceId), 'crm024_seeded_material_required');
  return row;
}

export async function restoreConfiguration(c, materials, proofHash) {
  const intent = resolve(BASE, 'restore-intent.json');
  await seal(intent, { at: at(), proofHash, editionId: materials.editionId, sourceId: materials.sourceId,
    restores: materials.builtin.map(row => ({ agentId: row.agent_id, before: row.prior_version, current: row.versionId, restored: row.restoreId })) }, false);
  const restored = await crm(c, false, async q => {
    await idle(q, c);
    const latest = await oldVersionSnapshot(q, c);
    assert(latest.length === materials.builtin.length && latest.every(row => materials.builtin.some(prior => row.agent_id === prior.agent_id &&
      row.prior_version === prior.versionId && row.version_number === prior.version_number + 1 && row.published_version_id === prior.published_version_id)),
    'crm024_owned_configuration_no_longer_latest');
    assert(same(await sourceIds(q, c), [...materials.priorSourceIds, materials.sourceId].sort()), 'crm024_restore_scope_changed');
    one(await q(`update ai_knowledge_sources set is_active=false where organization_id=$1::uuid and id=$2::uuid and is_active
      and source_type='wiki' and source_metadata->>'knowledge_base_id'=$3 returning id`, [c.org, materials.sourceId, materials.kbId]));
    for (const before of materials.builtin) await cloneDraft(q, c, before, before.restoreId, before.version_number + 2, before.knowledge_source_ids);
    assert(same(await sourceIds(q, c), materials.priorSourceIds), 'crm024_restore_active_sources_failed');
    return oldVersionSnapshot(q, c);
  });
  return seal(resolve(BASE, 'restore-result.json'), { at: at(), proofHash, restored, sourceDeactivated: materials.sourceId, wikiOrHistoryDeleted: false });
}

async function businessRow(q, c, scope) {
  return one(await q(`select l.stage_id,l.updated_at::text,md5(to_jsonb(l)::text) lead_hash,md5(to_jsonb(t)::text) contact_hash,
    (select count(*)::int from crm_lead_activities a where a.organization_id=$1::uuid and a.lead_id=l.id) activities
    from crm_leads l join contacts t on t.id=l.contact_id and t.organization_id=l.organization_id
    where l.organization_id=$1::uuid and l.id=$2::uuid and l.contact_id=$3::uuid and l.pipeline_id=$4::uuid`,
  [c.org, scope.leadId, scope.contactId, scope.pipelineId]));
}

export async function business(q, c, scope) {
  const state = await businessRow(q, c, scope);
  const confirmed = await q(`select id,category,content_hash,confirmed_by,sync_state,write_outcome
    from ai_customer_memories where organization_id=$1::uuid and contact_id=$2::uuid and deleted_at is null order by id`, [c.org, scope.contactId]);
  const channels = one(await q('select count(*)::int found from channel_sessions where organization_id=$1::uuid', [c.org]));
  assert(channels.found === 0, 'crm024_no_customer_channel_allowed');
  return { ...state, confirmed, channels: channels.found };
}

async function syntheticRecord(q, c, p, materials, label) {
  const item = p.cases[label.id];
  if (!item.fixtureKey.startsWith('legacy:')) {
    const data = p.materials.fixtures[item.fixtureKey];
    assert(data && uuid.test(materials.stages[data.stageKey]) && data.confirmedFacts.length <= 8 &&
      new Set(data.confirmedFacts.map(fact => fact.id)).size === data.confirmedFacts.length && data.confirmedFacts.every(fact =>
      ['confirmed_fact', 'preference', 'communication_context'].includes(fact.category) && typeof fact.body === 'string' && fact.body.trim() &&
      fact.body.length <= 1200), 'crm024_frozen_crm_fixture_invalid');
    return { title: data.leadTitle, description: data.legacyNote ?? 'CRM024 合成商机。', value_cents: data.valueCents, currency: data.currency,
      expected_close_date: data.expectedCloseDate, status: 'open', name: data.contactName, display_name: data.contactName,
      confirmedFacts: data.confirmedFacts, stageId: materials.stages[data.stageKey], pipelineId: materials.pipelineId };
  }
  assert(item.fixtureKey === `legacy:${label.id}` && ['S02', 'C01'].includes(label.id), 'crm024_legacy_fixture_required');
  const old = c.original.formalScopes[`${label.id}-disabled-0`];
  assert(old && same(await businessRow(q, c, old), c.original.objects[`${label.id}-disabled-0`]), 'crm024_original_legacy_fixture_changed');
  const data = one(await q(`select l.title,l.description,l.value_cents,l.currency,l.expected_close_date::text,l.status,t.name,t.display_name
    from crm_leads l join contacts t on t.id=l.contact_id and t.organization_id=l.organization_id
    where l.organization_id=$1::uuid and l.id=$2::uuid and t.id=$3::uuid and l.stage_id=$4::uuid and l.pipeline_id=$5::uuid`,
  [c.org, old.leadId, old.contactId, old.stageId, old.pipelineId]));
  return { ...data, confirmedFacts: [], stageId: old.stageId, pipelineId: old.pipelineId, clonedFrom: old.leadId };
}

export async function seedPhase(c, p, protocolHash, phase, planned, materials) {
  const dir = folder(phase);
  await mkdir(dir, { recursive: true });
  const cases = Object.fromEntries(planned.map(entry => [entry.label, { ...entry, leadId: randomUUID(), contactId: randomUUID() }]));
  await seal(resolve(dir, 'seed-intent.json'), { at: at(), protocolHash, org: c.org, databaseId: c.databaseId, editionId: materials.editionId, cases }, false);
  const objects = await crm(c, false, async q => {
    await idle(q, c);
    const objects = {};
    for (const scope of Object.values(cases)) {
      const { stageId, pipelineId, confirmedFacts, clonedFrom, ...data } = await syntheticRecord(q, c, p, materials, scope);
      Object.assign(scope, { stageId, pipelineId });
      const tags = JSON.stringify({ synthetic: true, batch: materials.editionId, phase, label: scope.label });
      one(await q(`insert into contacts(id,organization_id,name,display_name,source_metadata) values($1,$2,$3,$4,$5::jsonb) returning id`,
      [scope.contactId, c.org, data.name, data.display_name, tags]));
      one(await q(`insert into crm_leads(id,organization_id,pipeline_id,stage_id,contact_id,title,description,value_cents,currency,expected_close_date,status,source_metadata)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) returning id`, [scope.leadId, c.org, pipelineId, stageId, scope.contactId,
        data.title, data.description, data.value_cents, data.currency, data.expected_close_date, data.status, tags]));
      const memories = [];
      for (const fact of confirmedFacts) {
        const id = randomUUID(), requestKey = randomUUID(), revision = digest(JSON.stringify({ contact: scope.contactId, category: fact.category, body: fact.body }));
        // Explicit synthetic author confirmation. No Mem0 event, provider request, or generated memory.
        one(await q(`insert into ai_customer_memories(id,organization_id,contact_id,request_key,category,body,content_hash,confirmed_by,subject_key)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`, [id, c.org, scope.contactId, requestKey, fact.category, fact.body,
          revision, c.initiatorUserId, digest(`crm-customer:v1:${c.org}:${scope.contactId}`)]));
        memories.push({ factId: fact.id, id, revision, category: fact.category, bodyHash: digest(fact.body) });
      }
      objects[scope.label] = { before: await business(q, c, scope), memories, materialHash: digest(bytes({ data, stageId, pipelineId, confirmedFacts })),
        clonedFrom: clonedFrom ?? null };
    }
    for (const { id } of planned) assert(objects[`${id}-disabled`].materialHash === objects[`${id}-auto`].materialHash, 'crm024_arm_material_mismatch');
    return objects;
  });
  return seal(resolve(dir, 'fixtures.json'), { at: at(), phase, protocolHash, editionId: materials.editionId, org: c.org, databaseId: c.databaseId, cases, objects });
}

export async function configuration(q, c, p, materials) {
  const current = one(await q(`select a.id,a.builtin_revision,a.is_active,a.paused_at,v.id version_id,v.provider,v.model,v.tool_ids,v.knowledge_source_ids,
    v.max_steps,v.token_budget,v.cost_budget_cents,md5(v.system_prompt) prompt_hash,o.settings->'llm' llm
    from ai_agents a join organizations o on o.id=a.organization_id
    join lateral (select * from ai_agent_versions where organization_id=a.organization_id and agent_id=a.id order by version_number desc limit 1) v on true
    where a.organization_id=$1::uuid and a.id=$2::uuid and a.builtin_key='sales_operations' and a.archived_at is null`, [c.org, c.oldFixture.agent.id]));
  const owned = one(materials.builtin.filter(row => row.builtin_key === salesKey));
  const sources = [...materials.priorSourceIds, materials.sourceId].sort();
  assert(current.is_active && !current.paused_at && current.version_id === owned.versionId && current.provider === p.model.provider && current.model === p.model.model &&
    current.max_steps === p.model.maxSteps && current.token_budget === p.model.tokenBudget && current.llm?.provider === p.model.provider &&
    current.llm?.default_model === p.model.model && current.llm?.params?.temperature === p.model.temperature && same(current.knowledge_source_ids, sources),
  'crm024_runtime_inputs_or_permissions_changed');
  const wiki = await q(`select id,source_type,status,is_active,source_metadata,updated_at::text from ai_knowledge_sources
    where organization_id=$1::uuid and id=any($2::uuid[]) order by id`, [c.org, sources]);
  const enabled = one(await q("select enabled from ai_integration_settings where organization_id=$1::uuid and provider='weknora'", [c.org]));
  assert(enabled.enabled && same(wiki.map(row => row.id), sources) && wiki.every(row => row.source_type === 'wiki' && row.is_active && row.status === 'ready' &&
    row.source_metadata?.provider === 'weknora' && row.source_metadata.visibility === 'organization' && c.binding.knowledge_base_ids.includes(row.source_metadata.knowledge_base_id)),
  'crm024_authorized_wiki_sources_changed');
  return { agent: current, sourceIds: sources, wiki };
}

export async function verifyMaterial(c, p, fixtures, materials, config) {
  const checks = new Map();
  for (const scope of Object.values(fixtures.cases)) for (const test of p.cases[scope.id].wikiChecks ?? []) checks.set(test.query, test);
  const prior = process.env.AI_INTEGRATION_BINDINGS;
  process.env.AI_INTEGRATION_BINDINGS = c.env.AI_INTEGRATION_BINDINGS;
  try {
    const { searchCompanyWiki } = await import('../../lib/ai/integrations/weknora.ts');
    const { readConfirmedCustomerMemory } = await import('../../lib/ai/integrations/mem0.ts');
    return await crm(c, false, async q => {
      const facts = {};
      for (const scope of Object.values(fixtures.cases)) {
        const expected = fixtures.objects[scope.label].memories;
        const result = await readConfirmedCustomerMemory({ query: async ({ text, values }) => {
          assert(values[0] === c.org && values[1] === scope.contactId && /^\s*select\b/i.test(text), 'crm024_memory_read_out_of_scope');
          return { rows: await q(text, values) };
        } }, c.org, scope.contactId, undefined, AbortSignal.timeout(5000));
        assert(result.status === 'local' && result.providerStatus === 'disabled' && result.coverage === 'complete' && result.memories.length === expected.length &&
          result.memories.every(row => row.confirmed && expected.some(entry => row.id === entry.id && row.revision === entry.revision && row.category === entry.category &&
            digest(row.body) === entry.bodyHash)), 'crm024_real_confirmed_facts_mismatch');
        facts[scope.label] = { count: result.memories.length, source: result.source, providerStatus: result.providerStatus };
      }
      const wiki = [];
      for (const [query, expected] of checks) {
        const requests = [];
        const receiptPool = { query: async ({ text, values }) => {
          if (/^\s*insert into ai_wiki_evidence\b/i.test(text)) {
            const manifest = JSON.parse(values[3]);
            assert(values[0] === c.org && values[1] === materials.sourceId && sha.test(values[2]) &&
              materials.wiki.some(page => page.pageId === manifest.page_id && page.version === manifest.page_version && page.contentHash === manifest.content_hash),
            'crm024_read_receipt_out_of_scope');
          } else assert(/^\s*select\b/i.test(text) && values[0] === c.org, 'crm024_wiki_query_out_of_scope');
          return { rows: await q(text, values) };
        } };
        const result = await searchCompanyWiki(receiptPool, c.org, config.sourceIds, query, 5, AbortSignal.timeout(15000), async (address, init) => {
          const url = new URL(address);
          const valid = c.binding.knowledge_base_ids.some(id => url.pathname.startsWith(`/api/v1/knowledgebase/${id}/wiki/`)) ||
            /^\/api\/v1\/knowledge\/[\w-]+$/.test(url.pathname);
          assert(url.origin === WIKI_ORIGIN && init?.method === 'GET' && requests.length < 24 && valid, 'crm024_wiki_get_out_of_scope');
          const index = requests.push(null) - 1;
          const response = await fetch(address, { ...init, redirect: 'error' });
          requests[index] = response.status;
          return response;
        });
        const pages = result.evidence.map(row => ({ id: row.metadata.page_id, version: row.metadata.page_version, content_hash: row.metadata.content_hash,
          slug: row.metadata.slug, receiptId: row.id, revision: row.locator.revision }));
        assert(requests.length > 0 && requests.every(status => status === 200) && same([...result.handledSourceIds].sort(), config.sourceIds) &&
          same(pages.map(row => row.slug).sort(), [...expected.pageSlugs].sort()) && (pages.length ? result.status === 'complete' && pages.every(row =>
            materials.wiki.some(page => page.pageId === row.id && page.contentHash === row.content_hash && page.version === row.version)) :
            result.status === 'empty' && result.emptyVerified === true), 'crm024_real_wiki_preflight_mismatch');
        wiki.push({ q: query, http: 200, pages, status: result.status, emptyVerified: result.emptyVerified, requestCount: requests.length });
      }
      return { facts, wiki };
    });
  } finally {
    if (prior === undefined) delete process.env.AI_INTEGRATION_BINDINGS;
    else process.env.AI_INTEGRATION_BINDINGS = prior;
  }
}
