/** CRM-024 continuation, bound to the preserved first-round and teardown evidence. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv, isDeepStrictEqual as same } from 'node:util';
import pg from 'pg';
import { BASE, ROOT, at, business, bytes, context, crm, digest, folder, idle, one, optional, read, seal, sha, uuid } from './crm024-fixtures.mjs';

const continuation = resolve(BASE, 'continuation');
export const continuationMaterialPath = resolve(continuation, 'materials.json');
export const continuationRuntimePath = resolve(BASE, 'runtime-continuation.env');
const oldRuntime = resolve(ROOT, '.local/crm022/runtime.env');
const initialOrg = 'd22e3375-d7e1-43a2-8ce9-b5017c98b338';
const instance = '7708392892596248609';
const tenant = '10000';
const originalKb = '842886d6-75c1-4089-8747-157644e6fafa';
const ownedKb = 'b07e80e7-8be9-4d94-bf15-4785ecf969bf';
const ownedSource = '638153e0-70d0-4f6b-a2d7-9add7fcda011';
const priorSource = '0896e25a-44c1-4299-914e-9482daa4a7d4';
const origin = 'http://127.0.0.1:8088';
const oldKeyId = 3;
const proofs = {
  'protocol.json': '65eff5f929fadaeb74e7ed17cd20237d0ec715af6b1d8235f35e2b13aa7d233c',
  'materials.json': '828e1a2b80fb90b9e9f616719d34711feba288b7c0fed220e258a85b9221001b',
  'materials-wiki-receipt.json': '00ddceed179c123572d9f0c968e4783e6471cdab4f94e4ae3dc2fbb97b26ccfb',
  'restore-result.json': '343a9790a17a1609c56859892307ccf6e8258c3521c83b3c0e7fea2119a18c73',
  'wiki-key-revoke-report.json': '6efa4892d097752b037f2bf52a996fba5f5fece651d6dd9aee6421ff91afc7b8',
  'paired/calibration-1/frozen.json': 'f034e90edf6056ba38586185e8ff34af9973ab26f67a8a4021b0d0508aa0a4cb',
  'paired/calibration-1/fixtures.json': '5266ba8f3065a6574b68dc36be9ad8f038f805f16125cd3c712a7c2928faab16',
  'process-close.json': '4789e461f44a803463facb7f43ceabb0268b33b362eae9d74cd84d7991876a81',
  'queue-after-close.json': '8dd15afecfc5cd1299829b6c7c3c204681f5fa254909f0f525ef639ad999bc25',
};
const keyPath = `/api/v1/tenants/${tenant}/api-keys`;
const save = (name, value, print = true) => seal(resolve(continuation, name), value, print);
const load = (name, hash) => read(resolve(continuation, name), hash);
const optIn = hash => assert(sha.test(hash) && process.env.CRM024_CONTINUATION_EXECUTE === hash, 'crm024_continuation_exact_opt_in_required');

async function archive() {
  const previous = Object.fromEntries(await Promise.all(Object.entries(proofs).map(async ([name, hash]) => [name, await read(resolve(BASE, name), hash)])));
  const materials = previous['materials.json'];
  const restored = previous['restore-result.json'];
  const revoked = previous['wiki-key-revoke-report.json'];
  const frozen = previous['paired/calibration-1/frozen.json'];
  const originalFixtureHash = digest(await readFile(resolve(import.meta.dirname, 'crm024-fixtures.mjs')));
  assert(frozen.scripts['crm024-fixtures.mjs'] === originalFixtureHash && materials.org === initialOrg && materials.databaseId === instance &&
    materials.sourceId === ownedSource && materials.kbId === ownedKb && materials.tenant === tenant && materials.protocolHash === proofs['protocol.json'] &&
    restored.sourceDeactivated === ownedSource && restored.proofHash === proofs['materials.json'] && restored.wikiOrHistoryDeleted === false &&
    restored.restored.length === 4 && revoked.keyId === oldKeyId && revoked.tenant === tenant && revoked.pass && revoked.verifiedRevoked &&
    typeof revoked.revokedAt === 'string' && same(materials.wiki, previous['materials-wiki-receipt.json'].wiki),
  'crm024_continuation_archived_proofs_mismatch');
  return { protocol: previous['protocol.json'], materials, restored: restored.restored, revoked,
    r1: previous['paired/calibration-1/fixtures.json'], originalFixtureHash };
}

function ownership() {
  const verify = (name, service, port, published) => {
    const format = `{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{range (index .NetworkSettings.Ports "${port}/tcp")}}{{.HostIp}}:{{.HostPort}}{{end}}`;
    const result = execFileSync('docker', ['inspect', '--format', format, name], { encoding: 'utf8', windowsHide: true, timeout: 8000,
      stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    assert(result === `crm-agent-services|${service}|127.0.0.1:${published}`, 'crm024_continuation_owned_local_wiki_required');
  };
  verify('crm-agent-services-weknora-1', 'weknora', 8080, 8088);
  verify('crm-agent-services-postgres-1', 'postgres', 5432, 5438);
}

async function wikiConfig() {
  ownership();
  const env = parseEnv(await readFile(resolve(ROOT, 'infra/local-agent-services/.env.generated'), 'utf8'));
  assert(env.WEKNORA_TENANT_ID === tenant && typeof env.POSTGRES_PASSWORD === 'string' && env.POSTGRES_PASSWORD.length &&
    typeof env.WEKNORA_USER_PASSWORD === 'string' && env.WEKNORA_USER_PASSWORD.length, 'crm024_continuation_existing_wiki_admin_required');
  return env;
}

async function wikiRead(env, action) {
  const pool = new pg.Pool({ host: '127.0.0.1', port: 5438, database: 'weknora', user: 'postgres', password: env.POSTGRES_PASSWORD,
    max: 1, connectionTimeoutMillis: 5000, query_timeout: 8000, statement_timeout: 8000, options: '-c default_transaction_read_only=on' });
  pool.on('error', () => {});
  try {
    const q = async (statement, values = []) => {
      assert(/^select\b/i.test(statement.trim()), 'crm024_continuation_wiki_sql_read_only');
      return (await pool.query(statement, values)).rows;
    };
    assert(one(await q('select current_database() db')).db === 'weknora', 'crm024_continuation_wiki_database_changed');
    return await action(q);
  } finally { await pool.end(); }
}

function keyRow(q, id) {
  return q(`select id::int,tenant_id::text,scope_type,name,full_access,knowledge_base_ids,capabilities,created_at::text,revoked_at::text
    from tenant_api_keys where tenant_id=$1::bigint and id=$2::bigint`, [tenant, id]).then(one);
}

function matchesGrant(row, id, name) {
  return row?.id === id && row.name === name && row.scope_type === 'tenant' && row.full_access === false &&
    same([...(row.knowledge_base_ids ?? [])].sort(), [originalKb, ownedKb].sort()) && same(row.capabilities, ['retrieve']);
}

async function confirmWiki(env, historic) {
  const expected = historic.materials.wiki;
  return wikiRead(env, async q => {
    const originalRevoked = await keyRow(q, oldKeyId);
    assert(matchesGrant(originalRevoked, oldKeyId, `CRM024只读检索-${historic.materials.editionId.slice(0, 8)}`) &&
      originalRevoked.revoked_at === historic.revoked.revokedAt, 'crm024_continuation_historic_key_not_revoked');
    const kb = await q(`select id,description,type,embedding_model_id,summary_model_id,indexing_strategy from knowledge_bases
      where tenant_id=$1::bigint and id=any($2::varchar[]) and deleted_at is null order by id`, [tenant, [originalKb, ownedKb]]);
    const owned = one(kb.filter(row => row.id === ownedKb));
    assert(kb.length === 2 && kb.every(row => row.type === 'wiki') && owned.description === `crm024:${historic.materials.editionId}` &&
      !owned.embedding_model_id && !owned.summary_model_id && owned.indexing_strategy?.vector_enabled === false &&
      owned.indexing_strategy?.keyword_enabled === false && owned.indexing_strategy?.graph_enabled === false,
    'crm024_continuation_existing_wiki_identity_changed');
    const pages = await q(`select id,slug,title,content,status,version,updated_at::text,source_refs from wiki_pages
      where tenant_id=$1::bigint and knowledge_base_id=$2::varchar and deleted_at is null order by id`, [tenant, ownedKb]);
    const docs = await q(`select id,title,file_hash,parse_status,enable_status,updated_at::text,metadata->>'content' content from knowledges
      where tenant_id=$1::bigint and knowledge_base_id=$2::varchar and deleted_at is null order by id`, [tenant, ownedKb]);
    assert(pages.length === 6 && docs.length === 6 && expected.every(spec => {
      const page = pages.find(row => row.id === spec.pageId), doc = docs.find(row => row.id === spec.documentId);
      return page?.status === 'published' && page.version === spec.version && page.title === spec.title && page.slug === spec.slug &&
        page.updated_at === spec.updatedAt && digest(page.content) === spec.contentHash && same(page.source_refs, [spec.documentId]) &&
        doc?.parse_status === 'completed' && ['enabled', 'enable'].includes(doc.enable_status) && doc.title === spec.title &&
        doc.file_hash === spec.contentHash && doc.updated_at === spec.documentUpdatedAt && digest(doc.content ?? '') === spec.contentHash;
    }), 'crm024_continuation_frozen_wiki_content_changed');
    return { revokedKeyId: oldKeyId, revokedAt: originalRevoked.revoked_at,
      pages: pages.map(({ content, ...row }) => ({ ...row, bodyHash: digest(content) })),
      documents: docs.map(({ content, ...row }) => ({ ...row, bodyHash: digest(content) })) };
  });
}

async function activeVersions(q, c, saved) {
  const ids = saved.map(row => row.agent_id);
  const current = await q(`select a.id agent_id,a.builtin_key,a.builtin_revision,a.published_version_id,
    v.id prior_version,v.version_number,v.status,v.provider,v.model,v.knowledge_source_ids,
    encode(sha256(convert_to(to_jsonb(v)::text,'utf8')),'hex') prior_hash
    from ai_agents a join lateral (select * from ai_agent_versions where organization_id=$1::uuid and agent_id=a.id order by version_number desc limit 1) v on true
    where a.organization_id=$1::uuid and a.id=any($2::uuid[]) and a.origin='builtin' and a.archived_at is null order by a.builtin_key`, [c.org, ids]);
  assert(current.length === 4, 'crm024_continuation_four_builtin_versions_required');
  return current;
}

async function sourceState(q, c, active) {
  const rows = await q(`select id,is_active,status,source_type,source_metadata,updated_at::text from ai_knowledge_sources
    where organization_id=$1::uuid and (is_active or id=$2::uuid) order by id`, [c.org, ownedSource]);
  const entitled = rows.filter(row => row.is_active).map(row => row.id);
  const owned = one(rows.filter(row => row.id === ownedSource));
  const old = one(rows.filter(row => row.id === priorSource));
  const valid = (row, kb) => row.source_type === 'wiki' && row.status === 'ready' &&
    same(row.source_metadata, { provider: 'weknora', knowledge_base_id: kb, visibility: 'organization' });
  assert(rows.length === 2 && valid(owned, ownedKb) && valid(old, originalKb) && owned.is_active === active &&
    same(entitled, (active ? [priorSource, ownedSource] : [priorSource]).sort()), 'crm024_continuation_frozen_source_scope_changed');
  return rows;
}

async function restoredBaseline(q, c, history) {
  const active = await activeVersions(q, c, history.restored);
  assert(history.restored.every(old => active.some(row => row.agent_id === old.agent_id && row.prior_version === old.prior_version &&
    row.prior_hash === old.prior_hash && row.version_number === old.version_number && row.status === 'draft' &&
    row.published_version_id === old.published_version_id && same(row.knowledge_source_ids, old.knowledge_source_ids))),
  'crm024_continuation_current_drafts_drifted');
  const originalIds = history.materials.builtin.map(row => row.prior_version);
  const original = await q(`select id,encode(sha256(convert_to(to_jsonb(v)::text,'utf8')),'hex') hash from ai_agent_versions v
    where organization_id=$1::uuid and id=any($2::uuid[])`, [c.org, originalIds]);
  assert(original.length === 4 && history.materials.builtin.every(old => original.some(row => row.id === old.prior_version && row.hash === old.prior_hash)),
    'crm024_continuation_origin_version_changed');
  return { active, sources: await sourceState(q, c, false) };
}

async function cloneDraft(q, c, archived, targetId, number, sourceIds) {
  return one(await q(`insert into ai_agent_versions select (jsonb_populate_record(null::ai_agent_versions,to_jsonb(v)||jsonb_build_object(
    'id',$4::uuid,'version_number',$5::int,'knowledge_source_ids',$6::uuid[],'created_at',clock_timestamp(),'created_by',$7::uuid,
    'status','draft','published_at',null,'superseded_at',null))).* from ai_agent_versions v
    where v.organization_id=$1::uuid and v.agent_id=$2::uuid and v.id=$3::uuid
    and encode(sha256(convert_to(to_jsonb(v)::text,'utf8')),'hex')=$8 returning id`,
  [c.org, archived.agent_id, archived.prior_version, targetId, number, sourceIds, c.initiatorUserId, archived.prior_hash]));
}

async function inventory(c, history, env) {
  const [before, wiki] = await Promise.all([
    crm(c, true, async q => { await idle(q, c); return restoredBaseline(q, c, history); }),
    confirmWiki(env, history),
  ]);
  return { before, wiki };
}

async function prepare() {
  await mkdir(continuation, { recursive: true });
  const [c, history, env] = await Promise.all([context(), archive(), wikiConfig()]);
  const baseline = await inventory(c, history, env);
  const plan = { at: at(), protocolHash: proofs['protocol.json'], archive: proofs, sourceId: ownedSource, kbId: ownedKb,
    activationId: randomUUID(), priorKeyId: oldKeyId, implementationHash: digest(await readFile(import.meta.filename)), ...baseline,
    builtin: baseline.before.active.map(row => ({ ...row, versionId: randomUUID(), cleanupId: randomUUID() })) };
  return save('activation-plan.json', plan);
}

async function http(path, method, headers, body) {
  return fetch(`${origin}${path}`, { method, headers, redirect: 'error', signal: AbortSignal.timeout(12000),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

async function owner(env) {
  const result = await http('/api/v1/auth/login', 'POST', { 'Content-Type': 'application/json' },
    { email: 'agent-services@localhost.test', password: env.WEKNORA_USER_PASSWORD });
  const body = await result.json().catch(() => null);
  assert(result.ok && body?.success && String(body.active_tenant?.id) === tenant && typeof body.token === 'string',
    'crm024_continuation_wiki_owner_login_failed');
  return { Authorization: `Bearer ${body.token}` };
}

function parseBinding(env, c) {
  const bindings = JSON.parse(env.AI_INTEGRATION_BINDINGS);
  const wiki = one(bindings.filter(row => row.organization_id === c.org && row.provider === 'weknora'));
  assert(wiki.base_url.replace(/\/$/, '') === origin && wiki.visibility === 'organization' && typeof wiki.api_key === 'string' && wiki.api_key.length > 10,
    'crm024_continuation_private_binding_wrong');
  return { bindings, wiki };
}

async function writeRuntime(c, privateToken) {
  const raw = await readFile(oldRuntime, 'utf8');
  const { bindings, wiki } = parseBinding(parseEnv(raw), c);
  assert(wiki.api_key !== privateToken, 'crm024_continuation_duplicate_wiki_credential');
  wiki.knowledge_base_ids = [originalKb, ownedKb];
  wiki.api_key = privateToken;
  const body = JSON.stringify(bindings.filter(row => row.organization_id !== c.org || !['mem0', 'langfuse'].includes(row.provider)));
  assert(!/['\r\n]/.test(body) && /^\s*AI_INTEGRATION_BINDINGS\s*=.+$/m.test(raw), 'crm024_continuation_env_binding_encoding');
  const runtime = raw.replace(/^[ \t]*(?:AI_INTEGRATION_BINDINGS|SENTRY_DSN|NEXT_PUBLIC_SENTRY_DSN)[ \t]*=.*$/gm, '').trimEnd() +
    `\nAI_INTEGRATION_BINDINGS='${body}'\nSENTRY_DSN=off\nNEXT_PUBLIC_SENTRY_DSN=\n`;
  assert(parseEnv(runtime).AI_INTEGRATION_BINDINGS === body, 'crm024_continuation_env_binding_multiline');
  await writeFile(continuationRuntimePath, runtime, { flag: 'wx', mode: 0o600 });
  return digest(runtime);
}

async function activate(planHash) {
  optIn(planHash);
  assert(!(await optional(resolve(continuation, 'activation-intent.json'))), 'crm024_continuation_existing_activation_intent');
  const [plan, c, history, env] = await Promise.all([load('activation-plan.json', planHash), context(), archive(), wikiConfig()]);
  assert(plan.protocolHash === proofs['protocol.json'] && same(plan.archive, proofs) && plan.sourceId === ownedSource && plan.kbId === ownedKb &&
    plan.priorKeyId === oldKeyId && uuid.test(plan.activationId) && plan.implementationHash === digest(await readFile(import.meta.filename)) &&
    plan.builtin.length === 4 && plan.builtin.every(row => [row.versionId, row.cleanupId].every(id => uuid.test(id))),
  'crm024_continuation_activation_plan_changed');
  const baseline = await inventory(c, history, env);
  assert(same(baseline.before, plan.before) && same(baseline.wiki, plan.wiki), 'crm024_continuation_activation_baseline_changed');
  const headers = await owner(env);
  const grant = { name: `CRM024接续只读-${plan.activationId.slice(0, 8)}`, full_access: false,
    knowledge_base_ids: [originalKb, ownedKb], capabilities: ['retrieve'] };
  await save('activation-intent.json', { at: at(), planHash, activationId: plan.activationId, tenant, grant, maximumKeyPosts: 1 }, false);
  let response;
  try { response = await http(keyPath, 'POST', { ...headers, 'Content-Type': 'application/json' }, grant); }
  catch { /* Leave the sole intent durable even if the response is lost. */ }
  await save('key-create-receipt.json', { at: at(), planHash, tenant, httpStatus: response?.status ?? null, name: grant.name }, false);
  const created = await response?.json().catch(() => null);
  const keyId = created?.data?.id;
  assert(response?.status === 201 && created.success === true && Number.isSafeInteger(keyId) && keyId > 0 && keyId !== oldKeyId &&
    typeof created.data.token === 'string' && !/['\r\n]/.test(created.data.token) && created.data.token.length > 10,
  'crm024_continuation_creation_unconfirmed_do_not_repeat');
  const key = await wikiRead(env, q => keyRow(q, keyId));
  assert(matchesGrant(key, keyId, grant.name) && key.revoked_at === null, 'crm024_continuation_live_retrieve_scope_mismatch');
  const keyProof = await save('key-create-proof.json', { at: at(), planHash, activationId: plan.activationId, key, archivedKeyId: oldKeyId }, false);
  const envHash = await writeRuntime(c, created.data.token);
  const source = await crm(c, false, async q => {
    await idle(q, c);
    assert(same(await restoredBaseline(q, c, history), baseline.before), 'crm024_continuation_source_activation_base_changed');
    one(await q(`update ai_knowledge_sources set is_active=true where organization_id=$1::uuid and id=$2::uuid and not is_active
      and source_type='wiki' and source_metadata->>'knowledge_base_id'=$3 returning id`, [c.org, ownedSource, ownedKb]));
    const sources = await sourceState(q, c, true);
    for (const row of plan.builtin) {
      const next = row.knowledge_source_ids.length ? [priorSource, ownedSource].sort() : [];
      await cloneDraft(q, c, row, row.versionId, row.version_number + 1, next);
    }
    return sources;
  });
  return save('materials.json', { ...history.materials, at: at(), protocolHash: plan.protocolHash, activationId: plan.activationId,
    archiveMaterialHash: proofs['materials.json'], planHash, keyProofHash: keyProof.sha256, keyId, envHash, source, builtin: plan.builtin, noModel: true });
}

export async function continuationContext() {
  const baseline = await context();
  const material = await load('materials.json');
  const raw = await readFile(continuationRuntimePath, 'utf8');
  const env = parseEnv(raw), hash = digest(raw);
  assert(hash === material.envHash && env.NODE_ENV === 'development' && env.SENTRY_DSN === 'off' &&
    ['SUPABASE_DB_URL', 'NEXT_PUBLIC_APP_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'CRM022_ORG_ID',
      'CRM_LOCAL_WORKBENCH_UNPRICED_MODE', 'INTERNAL_AGENT_RUN_STUB'].every(name => env[name] === baseline.env[name]),
  'crm024_continuation_private_environment_changed');
  const { bindings, wiki } = parseBinding(env, baseline);
  assert(same(wiki.knowledge_base_ids, [originalKb, ownedKb]) && wiki.api_key !== baseline.binding.api_key &&
    !bindings.some(row => row.organization_id === baseline.org && ['mem0', 'langfuse'].includes(row.provider)), 'crm024_continuation_exact_runtime_binding_required');
  return { ...baseline, env, envHash: hash, binding: wiki };
}

export async function continuationMaterial(c, protocolHash) {
  const value = await load('materials.json');
  assert(protocolHash === proofs['protocol.json'] && value.protocolHash === protocolHash && value.archiveMaterialHash === proofs['materials.json'] &&
    value.org === c.org && value.databaseId === c.databaseId && value.sourceId === ownedSource && value.kbId === ownedKb && value.envHash === c.envHash,
  'crm024_continuation_material_changed');
  const [activation, keyProof, original] = await Promise.all([
    load('activation-plan.json', value.planHash), load('key-create-proof.json', value.keyProofHash), read(resolve(BASE, 'materials.json'), proofs['materials.json']),
  ]);
  assert(activation.activationId === value.activationId && keyProof.activationId === value.activationId && keyProof.planHash === value.planHash &&
    keyProof.key.id === value.keyId && value.keyId !== oldKeyId && same(value.builtin, activation.builtin) && same(value.wiki, original.wiki) &&
    same(value.stages, original.stages) && value.pipelineId === original.pipelineId && value.editionId === original.editionId,
  'crm024_continuation_material_lineage_changed');
  return value;
}

const armText = /(?:^|[^a-z0-9])(?:disabled|auto)(?=$|[^a-z0-9])/i;

export function assertNeutralLabel(value) {
  assert(!armText.test(JSON.stringify(value)), 'crm024_continuation_model_visible_arm_label');
}

async function caseData(q, c, p, materials, history, id) {
  const item = p.cases[id];
  assert(item?.id === id && typeof item.promptTemplate === 'string', 'crm024_continuation_unknown_case');
  assertNeutralLabel(item.promptTemplate);
  if (!item.fixtureKey.startsWith('legacy:')) {
    const frozen = p.materials.fixtures[item.fixtureKey];
    assert(frozen && uuid.test(materials.stages[frozen.stageKey]) && Array.isArray(frozen.confirmedFacts) && frozen.confirmedFacts.length <= 8 &&
      new Set(frozen.confirmedFacts.map(fact => fact.id)).size === frozen.confirmedFacts.length && frozen.confirmedFacts.every(fact =>
        ['confirmed_fact', 'preference', 'communication_context'].includes(fact.category) && typeof fact.body === 'string' && fact.body.trim() && fact.body.length <= 1200),
    'crm024_continuation_original_fixture_shape_changed');
    return { title: frozen.leadTitle, description: frozen.legacyNote ?? 'CRM024 合成商机。', value_cents: frozen.valueCents, currency: frozen.currency,
      expected_close_date: frozen.expectedCloseDate, status: 'open', name: frozen.contactName, display_name: frozen.contactName,
      confirmedFacts: frozen.confirmedFacts, stageId: materials.stages[frozen.stageKey], pipelineId: materials.pipelineId };
  }
  assert(['S02', 'C01'].includes(id) && item.fixtureKey === `legacy:${id}`, 'crm024_continuation_unplanned_legacy_fixture');
  const prior = history.r1.cases[`${id}-disabled`];
  assert(prior && same(await business(q, c, prior), history.r1.objects[`${id}-disabled`].before), 'crm024_continuation_archived_simple_fixture_changed');
  const older = c.original.formalScopes[`${id}-disabled-0`];
  const raw = one(await q(`select l.title,l.description,l.value_cents,l.currency,l.expected_close_date::text,l.status,t.name,t.display_name
    from crm_leads l join contacts t on t.id=l.contact_id and t.organization_id=l.organization_id
    where l.organization_id=$1::uuid and l.id=$2::uuid and t.id=$3::uuid and l.stage_id=$4::uuid and l.pipeline_id=$5::uuid`,
  [c.org, prior.leadId, prior.contactId, prior.stageId, prior.pipelineId]));
  return { ...raw, confirmedFacts: [], stageId: prior.stageId, pipelineId: prior.pipelineId, clonedFrom: older.leadId };
}

async function visibleData(q, c, scope) {
  return one(await q(`select
    to_jsonb(l)-array['id','contact_id','created_at','updated_at','stage_changed_at','last_activity_at','assigned_at','closed_at'] lead,
    to_jsonb(t)-array['id','created_at','updated_at','last_activity_at'] contact,
    (select count(*)::int from crm_lead_activities a where a.organization_id=$1::uuid and a.lead_id=l.id) activities
    from crm_leads l join contacts t on t.id=l.contact_id and t.organization_id=l.organization_id
    where l.organization_id=$1::uuid and l.id=$2::uuid and t.id=$3::uuid and l.stage_id=$4::uuid and l.pipeline_id=$5::uuid`,
  [c.org, scope.leadId, scope.contactId, scope.stageId, scope.pipelineId]));
}

async function seedNeutralPair(c, q, data, cases, objects, materials, historic) {
  const { stageId, pipelineId, confirmedFacts, clonedFrom, ...payload } = data;
  const id = cases[0].id;
  const materialHash = digest(bytes({ data: payload, stageId, pipelineId, confirmedFacts }));
  const old = historic.r1.objects[`${id}-disabled`];
  if (old) assert(materialHash === old.materialHash && materialHash === historic.r1.objects[`${id}-auto`].materialHash,
    'crm024_continuation_r1_truth_changed');
  const marker = { synthetic: true, batch: materials.editionId, fixtureRef: randomUUID() };
  assertNeutralLabel({ payload, confirmedFacts, marker });
  const stages = await q(`select s.name stage,p.name pipeline from crm_stages s join crm_pipelines p on p.id=s.pipeline_id
    and p.organization_id=s.organization_id where s.organization_id=$1::uuid and s.id=$2::uuid and p.id=$3::uuid and not s.is_archived`, [c.org, stageId, pipelineId]);
  assertNeutralLabel(one(stages));
  const pairModelViews = [];
  for (const scope of cases) {
    Object.assign(scope, { stageId, pipelineId });
    one(await q(`insert into contacts(id,organization_id,name,display_name,source_metadata) values($1,$2,$3,$4,$5::jsonb) returning id`,
    [scope.contactId, c.org, payload.name, payload.display_name, JSON.stringify(marker)]));
    one(await q(`insert into crm_leads(id,organization_id,pipeline_id,stage_id,contact_id,title,description,value_cents,currency,expected_close_date,status,source_metadata)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) returning id`, [scope.leadId, c.org, pipelineId, stageId, scope.contactId,
      payload.title, payload.description, payload.value_cents, payload.currency, payload.expected_close_date, payload.status, JSON.stringify(marker)]));
    const memories = [];
    for (const fact of confirmedFacts) {
      const rowId = randomUUID(), requestKey = randomUUID();
      const revision = digest(JSON.stringify({ contact: scope.contactId, category: fact.category, body: fact.body }));
      const subject = digest(`crm-customer:v1:${c.org}:${scope.contactId}`);
      one(await q(`insert into ai_customer_memories(id,organization_id,contact_id,request_key,category,body,content_hash,confirmed_by,subject_key)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`, [rowId, c.org, scope.contactId, requestKey, fact.category, fact.body,
        revision, c.initiatorUserId, subject]));
      memories.push({ factId: fact.id, id: rowId, revision, category: fact.category, bodyHash: digest(fact.body) });
    }
    const observed = await visibleData(q, c, scope);
    assert(observed.activities === 0 && observed.lead.external_id == null && observed.contact.external_id == null &&
      same(observed.lead.source_metadata, marker) && same(observed.contact.source_metadata, marker), 'crm024_continuation_neutral_storage_fields_drifted');
    assertNeutralLabel(observed);
    pairModelViews.push(observed);
    objects[scope.label] = { before: await business(q, c, scope), materialHash, memories, clonedFrom: clonedFrom ?? null,
      armNeutral: { markerHash: digest(bytes(marker)), visibleDataHash: digest(bytes(observed)), caseTruthHash: materialHash, originalR1TruthHash: old?.materialHash ?? null } };
  }
  assert(same(pairModelViews[0], pairModelViews[1]), 'crm024_continuation_twin_model_visible_data_differ');
}

export async function seedContinuationPhase(c, p, protocolHash, phase, planned, materials) {
  const history = await archive();
  assert(protocolHash === proofs['protocol.json'] && same(p, history.protocol) && materials.archiveMaterialHash === proofs['materials.json'] &&
    materials.protocolHash === protocolHash && materials.envHash === c.envHash && ['calibration-2', 'formal'].includes(phase),
  'crm024_continuation_frozen_case_seed_required');
  const ids = [...new Set(planned.map(row => row.id))];
  const admitted = phase === 'formal' ? p.formalIds : p.calibrationIds;
  assert(ids.length > 0 && planned.length === ids.length * 2 && ids.every(id => admitted.includes(id) &&
    same(planned.filter(item => item.id === id).map(item => item.arm).sort(), ['auto', 'disabled'])) &&
    planned.every(row => row.label === `${row.id}-${row.arm}`) && (phase === 'formal' ? same(ids, p.formalIds) : ids.includes('K01')),
  'crm024_continuation_planned_twin_subset_invalid');
  const output = folder(phase);
  await mkdir(output, { recursive: true });
  const cases = Object.fromEntries(planned.map(row => [row.label, { ...row, leadId: randomUUID(), contactId: randomUUID() }]));
  await seal(resolve(output, 'seed-intent.json'), { at: at(), phase, protocolHash, org: c.org, databaseId: c.databaseId, editionId: materials.editionId,
    activationId: materials.activationId, neutralSourceMetadata: true, cases }, false);
  const objects = await crm(c, false, async q => {
    await idle(q, c);
    const source = await sourceState(q, c, true);
    assert(same(source, materials.source), 'crm024_continuation_source_changed_before_seed');
    const results = {};
    for (const id of ids) {
      const row = await caseData(q, c, p, materials, history, id);
      await seedNeutralPair(c, q, row, Object.values(cases).filter(entry => entry.id === id), results, materials, history);
    }
    return results;
  });
  return seal(resolve(output, 'fixtures.json'), { at: at(), phase, protocolHash, editionId: materials.editionId, activationId: materials.activationId,
    org: c.org, databaseId: c.databaseId, cases, objects, armNeutralFixtures: true });
}

async function cleanupCrm(materialHash) {
  optIn(materialHash);
  assert(!(await optional(resolve(continuation, 'cleanup-crm-intent.json'))), 'crm024_continuation_existing_cleanup_intent');
  const [c, material, history] = await Promise.all([context(), load('materials.json', materialHash), archive()]);
  const plan = await load('activation-plan.json', material.planHash);
  assert(material.sourceId === ownedSource && material.kbId === ownedKb && uuid.test(material.activationId) &&
    material.protocolHash === proofs['protocol.json'] && same(plan.builtin, material.builtin) && material.activationId === plan.activationId,
  'crm024_continuation_cleanup_material_changed');
  await save('cleanup-crm-intent.json', { at: at(), materialHash, activationId: material.activationId, sourceId: ownedSource,
    versions: material.builtin.map(row => ({ agentId: row.agent_id, active: row.versionId, restored: row.cleanupId })) }, false);
  const result = await crm(c, false, async q => {
    await idle(q, c);
    assert(same(await sourceState(q, c, true), material.source), 'crm024_continuation_cleanup_source_changed');
    const latest = await activeVersions(q, c, history.restored);
    assert(material.builtin.every(row => latest.some(current => current.agent_id === row.agent_id && current.prior_version === row.versionId &&
      current.version_number === row.version_number + 1 && current.published_version_id === row.published_version_id && current.status === 'draft' &&
      same(current.knowledge_source_ids, row.knowledge_source_ids.length ? [priorSource, ownedSource].sort() : []))),
    'crm024_continuation_cleanup_owned_version_not_latest');
    one(await q(`update ai_knowledge_sources set is_active=false where organization_id=$1::uuid and id=$2::uuid and is_active
      and source_type='wiki' and source_metadata->>'knowledge_base_id'=$3 returning id`, [c.org, ownedSource, ownedKb]));
    for (const row of material.builtin) await cloneDraft(q, c, row, row.cleanupId, row.version_number + 2, row.knowledge_source_ids);
    return { source: await sourceState(q, c, false), builtin: await activeVersions(q, c, history.restored) };
  });
  return save('cleanup-crm-result.json', { at: at(), materialHash, activationId: material.activationId, sourceDeactivated: ownedSource,
    ...result, noWikiOrHistoryDeleted: true });
}

async function keyProbe(kb, query, token) {
  try {
    const path = `/api/v1/knowledgebase/${kb}/wiki/search?${new URLSearchParams({ q: query, limit: '1' })}`;
    return (await http(path, 'GET', { 'X-API-Key': token })).status;
  } catch { return null; }
}

async function revokeKey(materialHash) {
  optIn(materialHash);
  assert(!(await optional(resolve(continuation, 'cleanup-key-intent.json'))), 'crm024_continuation_existing_revoke_intent');
  const [c, env, material, cleanup, history] = await Promise.all([
    continuationContext(), wikiConfig(), load('materials.json', materialHash), load('cleanup-crm-result.json'), archive(),
  ]);
  assert(cleanup.materialHash === materialHash && cleanup.activationId === material.activationId && cleanup.sourceDeactivated === ownedSource &&
    cleanup.noWikiOrHistoryDeleted === true, 'crm024_continuation_exact_cleanup_result_required');
  await crm(c, true, async q => {
    await idle(q, c);
    const [source, builtin] = await Promise.all([sourceState(q, c, false), activeVersions(q, c, material.builtin)]);
    assert(same(source, cleanup.source) && same(builtin, cleanup.builtin) && material.builtin.every(row => builtin.some(current =>
      current.agent_id === row.agent_id && current.prior_version === row.cleanupId && current.version_number === row.version_number + 2)),
    'crm024_continuation_revoke_before_verified_crm_restore');
  });
  await confirmWiki(env, history);
  const proof = await load('key-create-proof.json', material.keyProofHash);
  const keyId = proof.key.id;
  assert(keyId === material.keyId && keyId !== oldKeyId && Number.isSafeInteger(keyId) && keyId > 0 && proof.activationId === material.activationId,
    'crm024_continuation_created_key_not_bound');
  const before = await wikiRead(env, q => keyRow(q, keyId));
  assert(same(before, proof.key) && before.revoked_at === null &&
    matchesGrant(before, keyId, `CRM024接续只读-${material.activationId.slice(0, 8)}`), 'crm024_continuation_revoke_live_key_changed');
  const headers = await owner(env);
  const list = await http(keyPath, 'GET', headers);
  const body = await list.json().catch(() => null);
  assert(list.status === 200 && body?.success && Array.isArray(body.data) && body.data.filter(row => matchesGrant(row, keyId, before.name)).length === 1,
    'crm024_continuation_owner_list_changed');
  const archivedRuntime = parseEnv(await readFile(oldRuntime, 'utf8'));
  const archivedToken = parseBinding(archivedRuntime, c).wiki.api_key;
  const oldBefore = await keyProbe(originalKb, '审批', archivedToken);
  const path = `${keyPath}/${keyId}`;
  await save('cleanup-key-intent.json', { at: at(), materialHash, tenant, keyId, maximumDeleteRequests: 1, before }, false);
  let status = null, accepted = false;
  try {
    const response = await http(path, 'DELETE', headers);
    status = response.status;
    accepted = status === 200 && (await response.json().catch(() => null))?.success === true;
  } catch { /* One DELETE intent; do not replay after an unknown response. */ }
  const after = await wikiRead(env, q => keyRow(q, keyId)).catch(() => null);
  const revoked = !!after && after.revoked_at !== null && same({ ...after, revoked_at: null }, before);
  const archivedKey = await wikiRead(env, q => keyRow(q, oldKeyId)).catch(() => null);
  const oldAfter = await keyProbe(originalKb, '审批', archivedToken);
  const denied = revoked ? await keyProbe(ownedKb, '试用开通', c.binding.api_key) : null;
  const pass = accepted && revoked && archivedKey?.revoked_at === history.revoked.revokedAt && oldBefore === 200 && oldAfter === 200 && [401, 403].includes(denied);
  const report = await save('cleanup-key-result.json', { at: at(), materialHash, keyId, tenant, status, accepted, revoked,
    revokedAt: after?.revoked_at ?? null, priorKeyRevokedAt: archivedKey?.revoked_at ?? null, oldBefore, oldAfter, denied, pass, noModel: true });
  if (!pass) process.exitCode = 1;
  return report;
}

async function reconcile(planHash) {
  const [plan, c, env] = await Promise.all([load('activation-plan.json', planHash), context(), wikiConfig()]);
  const intent = await load('activation-intent.json');
  assert(intent.planHash === planHash && intent.activationId === plan.activationId && intent.tenant === tenant &&
    intent.grant?.name === `CRM024接续只读-${plan.activationId.slice(0, 8)}`, 'crm024_continuation_reconcile_intent_unknown');
  const [crmState, wikiState] = await Promise.all([
    crm(c, true, async q => {
      const source = one(await q('select id,is_active from ai_knowledge_sources where organization_id=$1::uuid and id=$2::uuid', [c.org, ownedSource]));
      return { source, builtin: await activeVersions(q, c, plan.builtin) };
    }),
    wikiRead(env, q => q(`select id::int,tenant_id::text,scope_type,name,full_access,knowledge_base_ids,capabilities,created_at::text,revoked_at::text
      from tenant_api_keys where tenant_id=$1::bigint and name=$2`, [tenant, intent.grant.name])),
  ]);
  assert(wikiState.length <= 1 && wikiState.every(row => row.id !== oldKeyId && matchesGrant(row, row.id, intent.grant.name)),
    'crm024_continuation_reconcile_key_not_exact');
  return save(`activation-reconciliation-${randomUUID()}.json`, { at: at(), planHash, crm: crmState, wiki: wikiState, noHttp: true, noMutations: true });
}

async function main(args) {
  const [mode = '--help', hash] = args;
  if (mode === '--help') {
    console.info('CRM-024 continuation: prepare-activation; activate <activation-plan-sha>; reconcile <activation-plan-sha>; cleanup-crm <materials-sha>; revoke-key <materials-sha>.');
    console.info('Mutating commands require CRM024_CONTINUATION_EXECUTE set to that exact SHA. Only explicit local actions are supported.');
    return;
  }
  if (mode === 'prepare-activation' && args.length === 1) return prepare();
  assert(args.length === 2 && sha.test(hash), 'crm024_continuation_frozen_command_required');
  if (mode === 'activate') return activate(hash);
  if (mode === 'reconcile') return reconcile(hash);
  if (mode === 'cleanup-crm') return cleanupCrm(hash);
  if (mode === 'revoke-key') return revokeKey(hash);
  throw new Error('crm024_continuation_unknown_command');
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) main(process.argv.slice(2)).catch(error => {
  const reason = /^crm024_[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : error?.code === 'EEXIST'
    ? 'crm024_continuation_prior_intent_or_artifact' : 'crm024_continuation_guard_or_transport_failure';
  console.error(JSON.stringify({ error: reason, ...(/^[0-9A-Z]{5}$/.test(error?.code ?? '') ? { sqlState: error.code } : {}) }));
  process.exitCode = 1;
});
