import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv, isDeepStrictEqual as same } from 'node:util';
import { ROOT, digest, one } from './crm024-fixtures.mjs';
import { WIKI_ORIGIN, scopedTransaction } from './crm025-materials-context.mjs';

export const ALPHA_TENANT = '10000';
const BASE_PATH = '/api/v1/knowledgebase';
const KEYS_PATH = `/api/v1/tenants/${ALPHA_TENANT}/api-keys`;
const configPath = resolve(ROOT, 'infra/local-agent-services/.env.generated');

async function wikiEnv() {
  const env = parseEnv(await readFile(configPath, 'utf8'));
  assert(env.WEKNORA_TENANT_ID === ALPHA_TENANT && env.POSTGRES_PASSWORD && env.WEKNORA_USER_PASSWORD,
    'crm025_existing_wiki_credentials_required');
  return env;
}

/** Confirm Docker ownership and native tenant before using SQL on the loopback fixture service. */
export async function wikiTransaction(readOnly, action) {
  for (const [service, port, target] of [['postgres', 5432, 5438], ['weknora', 8080, 8088]]) {
    const format = `{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{range (index .NetworkSettings.Ports "${port}/tcp")}}{{.HostIp}}:{{.HostPort}}{{end}}`;
    const own = execFileSync('docker', ['inspect', '--format', format, `crm-agent-services-${service}-1`],
      { encoding: 'utf8', windowsHide: true, timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    assert.equal(own, `crm-agent-services|${service}|127.0.0.1:${target}`, 'crm025_wiki_service_ownership_mismatch');
  }
  const env = await wikiEnv();
  return scopedTransaction({ host: '127.0.0.1', port: 5438, database: 'weknora', user: 'postgres', password: env.POSTGRES_PASSWORD }, readOnly,
    async q => {
      const owner = one(await q(`select current_database() db,t.id::text tenant from tenants t
        where id=$1::bigint and deleted_at is null and status='active'`, [ALPHA_TENANT]));
      assert(owner.db === 'weknora' && owner.tenant === ALPHA_TENANT, 'crm025_wiki_tenant_mismatch');
      return action(q);
    });
}

async function wikiRequest(path, method, headers, body) {
  const response = await fetch(WIKI_ORIGIN + path, { method, headers, redirect: 'error', signal: AbortSignal.timeout(12000),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function ownerHeaders() {
  const env = await wikiEnv();
  const headers = { 'Content-Type': 'application/json' };
  const login = await wikiRequest('/api/v1/auth/login', 'POST', headers,
    { email: 'agent-services@localhost.test', password: env.WEKNORA_USER_PASSWORD });
  assert(login.status === 200 && login.body?.success && String(login.body.active_tenant?.id) === ALPHA_TENANT &&
    typeof login.body.token === 'string', 'crm025_wiki_management_login_failed');
  return { ...headers, Authorization: `Bearer ${login.body.token}` };
}

export function pagePath(row) {
  return `${BASE_PATH}/${encodeURIComponent(row.kbId)}/wiki/pages/${row.slug.split('/').map(encodeURIComponent).join('/')}`;
}

export const documentPath = row => `/api/v1/knowledge/${encodeURIComponent(row.documentId)}`;
export const retrieve = (token, path) => wikiRequest(path, 'GET', { 'X-API-Key': token });

export const grantFor = plan => ({ name: `CRM025读取-${plan.batch.slice(0, 8)}`, full_access: false,
  knowledge_base_ids: [plan.kb.current], capabilities: ['retrieve'] });

export async function createWikiAccess(plan) {
  const headers = await ownerHeaders();
  const reply = await wikiRequest(KEYS_PATH, 'POST', headers, grantFor(plan));
  assert(reply.status === 201 && reply.body?.success === true && Number.isSafeInteger(reply.body.data?.id) &&
    typeof reply.body.data?.token === 'string' && reply.body.data.token.length > 10 && !/['\r\n]/.test(reply.body.data.token),
  'crm025_wiki_key_creation_not_confirmed');
  return { keyId: reply.body.data.id, token: reply.body.data.token, status: reply.status };
}

export async function wikiAccessProof(plan, keyId, revoked) {
  const grant = grantFor(plan);
  return wikiTransaction(true, async q => {
    const row = one(await q(`select id::int,name,tenant_id::text,scope_type,full_access,knowledge_base_ids,capabilities,revoked_at::text
      from tenant_api_keys where id=$1::bigint and tenant_id=$2::bigint`, [keyId, ALPHA_TENANT]));
    assert(row.id === keyId && row.name === grant.name && row.tenant_id === ALPHA_TENANT && row.scope_type === 'tenant' &&
      !row.full_access && same(row.knowledge_base_ids, grant.knowledge_base_ids) && same(row.capabilities, grant.capabilities) &&
      Boolean(row.revoked_at) === revoked, 'crm025_wiki_key_scope_mismatch');
    return row;
  });
}

export async function revokeWikiAccess(plan, keyId) {
  await wikiAccessProof(plan, keyId, false);
  const reply = await wikiRequest(`${KEYS_PATH}/${keyId}`, 'DELETE', await ownerHeaders());
  assert(reply.status === 200 && reply.body?.success, 'crm025_wiki_key_revocation_not_confirmed');
  return wikiAccessProof(plan, keyId, true);
}

async function wikiBase(q, plan, kind, tenant) {
  return one(await q(`insert into knowledge_bases(id,tenant_id,name,description,type,embedding_model_id,summary_model_id,indexing_strategy,wiki_config)
    values($1,$2,$3,$4,'wiki','','','{"wiki_enabled":true,"vector_enabled":false,"keyword_enabled":false,"graph_enabled":false}'::jsonb,'{}'::jsonb)
    returning id`, [plan.kb[kind], tenant, '销售服务条款', `crm025:${plan.batch}:${kind}`]));
}

/** Native current page and history rows share a page identity. Only the current 28 appear to search. */
export async function seedWiki(plan, dataset) {
  return wikiTransaction(false, async q => {
    const alpha = one(await q('select id::text, name from tenants where id=$1::bigint and deleted_at is null', [ALPHA_TENANT]));
    assert(alpha.id === ALPHA_TENANT && !(await q('select id from tenants where name=$1', [plan.betaTenantName])).length,
      'crm025_wiki_seed_collision');
    const beta = one(await q(`insert into tenants(name,description,business)
      values($1,$2,'crm025-synthetic') returning id::text`, [plan.betaTenantName, `crm025:${plan.batch}`])).id;
    const material = Object.fromEntries(Object.entries(plan.pages).map(([id, row]) => [id, {
      ...row, tenantId: row.orgId === plan.betaOrg ? beta : alpha.id,
    }]));
    for (const kind of ['current', 'historical', 'withdrawn', 'foreign']) {
      await wikiBase(q, plan, kind, kind === 'foreign' ? beta : alpha.id);
    }
    for (const entry of dataset.corpus) {
      const row = material[entry.id];
      const state = entry.state === 'published' ? 'enabled' : 'disabled';
      const marker = { synthetic: true, dataset: plan.datasetHash, batch: plan.batch };
      const source = one(await q(`insert into knowledges(id,tenant_id,knowledge_base_id,type,title,source,parse_status,enable_status,file_name,
        file_type,file_size,file_hash,metadata,custom_metadata,processed_at) values($1,$2,$3,'manual',$4,'manual','completed',$5,$6,'md',$7,$8,
        $9::jsonb,$10::jsonb,now()) returning id,updated_at::text`, [row.documentId, row.tenantId, row.backingKbId ?? row.kbId, entry.title, state,
      `${row.slug.replaceAll('/', '-')}.md`, Buffer.byteLength(entry.content), row.bodyHash, JSON.stringify({ content: entry.content }), JSON.stringify(marker)]));
      row.documentUpdatedAt = source.updated_at;
      if (entry.state === 'superseded') continue;
      const page = one(await q(`insert into wiki_pages(id,tenant_id,knowledge_base_id,slug,title,page_type,status,content,source_refs,chunk_refs,
        version,page_metadata,last_edit_source,last_editor_id) values($1,$2,$3,$4,$5,'concept',$6,$7,$8::jsonb,'[]'::jsonb,$9,$10::jsonb,
        'manual','crm-fixture-owner') returning id,updated_at::text`, [row.pageId, row.tenantId, row.kbId, row.slug, entry.title,
      entry.state === 'withdrawn' ? 'archived' : 'published', entry.content, JSON.stringify([row.documentId]), entry.version, JSON.stringify(marker)]));
      row.updatedAt = page.updated_at;
    }
    const old = dataset.corpus.find(entry => entry.state === 'superseded');
    const historic = material[old.id];
    const revision = one(await q(`insert into wiki_page_revisions(id,tenant_id,knowledge_base_id,page_id,slug,version,title,page_type,status,
      content,edit_source,editor_id,edited_at) values($1,$2,$3,$4,$5,$6,$7,'concept','published',$8,'manual','crm-fixture-owner',$9::timestamptz)
      returning edited_at::text`, [historic.revisionId, historic.tenantId, historic.kbId, historic.pageId, historic.slug, old.version, old.title, old.content,
    `${old.effectiveFrom}T00:00:00+08:00`]));
    historic.updatedAt = revision.edited_at;
    return { pages: material, betaTenantId: beta };
  });
}

export function inspectWiki(plan, pages) {
  return wikiTransaction(true, async q => {
    const bases = await q(`select id,tenant_id::text,description from knowledge_bases where id=any($1::varchar[]) and deleted_at is null`, [Object.values(plan.kb)]);
    assert(bases.length === 4 && Object.entries(plan.kb).every(([kind, id]) => bases.some(row => row.id === id &&
      row.tenant_id === (kind === 'foreign' ? Object.values(pages).find(page => page.orgId === plan.betaOrg).tenantId : ALPHA_TENANT) &&
      row.description === `crm025:${plan.batch}:${kind}`)), 'crm025_wiki_bases_changed');
    const visible = await q(`select id,tenant_id::text,knowledge_base_id,slug,title,status,version,content,source_refs,updated_at::text from wiki_pages
      where knowledge_base_id=any($1::varchar[]) and deleted_at is null`, [Object.values(plan.kb)]);
    const docs = await q(`select id,tenant_id::text,knowledge_base_id,title,file_hash,enable_status,parse_status,metadata->>'content' body,updated_at::text
      from knowledges where knowledge_base_id=any($1::varchar[]) and deleted_at is null`, [Object.values(plan.kb)]);
    const old = Object.values(pages).find(page => page.state === 'superseded');
    const revision = one(await q(`select id,tenant_id::text,knowledge_base_id,page_id,version,status,slug,title,content from wiki_page_revisions
      where tenant_id=$1::bigint and knowledge_base_id=$2 and page_id=$3 and version=$4`, [old.tenantId, old.kbId, old.pageId, old.version]));
    assert(visible.length === 30 && docs.length === 31 && revision.id === old.revisionId && digest(revision.content) === old.bodyHash &&
      revision.slug === old.slug && revision.status === 'published', 'crm025_real_version_history_changed');
    for (const row of Object.values(pages)) {
      const doc = docs.find(doc => doc.id === row.documentId);
      const page = visible.find(page => page.id === row.pageId);
      assert(doc && doc.tenant_id === row.tenantId && doc.knowledge_base_id === (row.backingKbId ?? row.kbId) && doc.file_hash === row.bodyHash &&
        digest(doc.body ?? '') === row.bodyHash && doc.parse_status === 'completed' &&
        doc.enable_status === (row.state === 'published' ? 'enabled' : 'disabled') && doc.updated_at === row.documentUpdatedAt,
      'crm025_frozen_wiki_document_mismatch');
      assert(page && page.tenant_id === row.tenantId && page.knowledge_base_id === row.kbId && page.slug === row.slug &&
        (row.state === 'superseded' ? page.version > row.version && digest(page.content) !== row.bodyHash :
          page.version === row.version && page.updated_at === row.updatedAt && digest(page.content) === row.bodyHash &&
          page.status === (row.state === 'withdrawn' ? 'archived' : 'published') && same(page.source_refs, [row.documentId])), 'crm025_frozen_wiki_page_mismatch');
    }
    return { currentCount: visible.filter(page => page.knowledge_base_id === plan.kb.current && page.status === 'published').length,
      documentCount: docs.length, historyCount: 1, inspectedTenants: bases.map(base => base.tenant_id).filter((value, index, all) => all.indexOf(value) === index) };
  });
}

/** Reconstruct the owned Wiki transaction from its committed native identities without seeding it twice. */
export async function readSeededWiki(plan, seedReceipt) {
  const pages = await wikiTransaction(true, async q => {
    const tenant = one(await q('select id::text, description from tenants where name=$1 and deleted_at is null', [plan.betaTenantName]));
    assert(tenant.id === seedReceipt.betaTenantId && tenant.description === `crm025:${plan.batch}`, 'crm025_committed_wiki_tenant_changed');
    const all = [];
    for (const row of Object.values(plan.pages)) {
      const tenantId = row.orgId === plan.betaOrg ? tenant.id : ALPHA_TENANT;
      const doc = one(await q(`select updated_at::text from knowledges where tenant_id=$1::bigint and id=$2
        and knowledge_base_id=$3 and deleted_at is null`, [tenantId, row.documentId, row.backingKbId ?? row.kbId]));
      const page = row.state === 'superseded'
        ? one(await q(`select edited_at::text updated_at from wiki_page_revisions where tenant_id=$1::bigint and id=$2
          and page_id=$3 and knowledge_base_id=$4`, [tenantId, row.revisionId, row.pageId, row.kbId]))
        : one(await q(`select updated_at::text from wiki_pages where tenant_id=$1::bigint and id=$2
          and knowledge_base_id=$3 and deleted_at is null`, [tenantId, row.pageId, row.kbId]));
      all.push([row.logicalId, { ...row, tenantId, updatedAt: page.updated_at, documentUpdatedAt: doc.updated_at }]);
    }
    return Object.fromEntries(all);
  });
  const check = await inspectWiki(plan, pages);
  assert(check.currentCount === seedReceipt.currentCount && check.documentCount === seedReceipt.documentCount &&
    check.historyCount === seedReceipt.historyCount, 'crm025_committed_wiki_seed_mismatch');
  return { pages, betaTenantId: seedReceipt.betaTenantId };
}
