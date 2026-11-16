import assert from 'node:assert/strict';
import { isDeepStrictEqual as same } from 'node:util';
import { digest, one } from './crm024-fixtures.mjs';
import { ALPHA_TENANT, documentPath, pagePath, retrieve, wikiAccessProof, wikiTransaction } from './crm025-materials-wiki.mjs';

const indexStrategy = { wiki_enabled: true, vector_enabled: false, keyword_enabled: false, graph_enabled: false };
const markerFor = plan => ({ synthetic: true, crm026: plan.batch, dataset: plan.inputHash });
const descriptionFor = plan => `crm026:${plan.batch}:generalization:${plan.inputHash}`;

async function findBase(q, plan, { includeArchived = false } = {}) {
  const row = (await q(`select id,tenant_id::text,description,type,indexing_strategy,deleted_at from knowledge_bases
    where id=$1`, [plan.kb.current]))[0];
  if (!row) return null;
  assert(row.tenant_id === ALPHA_TENANT && row.description === descriptionFor(plan) && row.type === 'wiki' &&
    (includeArchived || row.deleted_at === null) && same(row.indexing_strategy, indexStrategy), 'crm026_g_wiki_base_not_owned');
  return row;
}

async function inspectPages(q, plan, input, archived = false) {
  const marker = markerFor(plan);
  const nativePages = await q(`select id,tenant_id::text,slug,title,content,status,source_refs,version,page_metadata,
    updated_at::text,deleted_at from wiki_pages where knowledge_base_id=$1 order by slug`, [plan.kb.current]);
  const nativeDocs = await q(`select id,tenant_id::text,title,file_hash,metadata->>'content' content,custom_metadata,
    parse_status,enable_status,updated_at::text,deleted_at from knowledges where knowledge_base_id=$1 order by id`, [plan.kb.current]);
  assert(nativePages.length === input.length && nativeDocs.length === input.length, 'crm026_g_wiki_page_count');
  return input.map(entry => {
    const expected = plan.pages[entry.id];
    const page = nativePages.find(row => row.id === expected.pageId);
    const doc = nativeDocs.find(row => row.id === expected.documentId);
    assert(page?.slug === entry.slug && page.tenant_id === ALPHA_TENANT && page.title === entry.title && page.status === 'published' &&
      page.version === 1 && page.content === entry.body && same(page.source_refs, [expected.documentId]) &&
      same(page.page_metadata, marker) && Boolean(page.deleted_at) === archived && doc?.title === entry.title && doc.tenant_id === ALPHA_TENANT &&
      doc.file_hash === expected.bodyHash && doc.content === entry.body && same(doc.custom_metadata, marker) &&
      doc.parse_status === 'completed' && doc.enable_status === 'enabled' && Boolean(doc.deleted_at) === archived, 'crm026_g_wiki_identity_mismatch');
    return { logicalId: entry.id, ...expected, kbId: plan.kb.current, sourceId: plan.sourceId, slug: entry.slug,
      version: page.version, updatedAt: page.updated_at, documentUpdatedAt: doc.updated_at };
  });
}

/** Create one owned KB in the guarded local Wiki tenant, and reuse its exact original IDs on recovery. */
export function provisionWiki(plan, input) {
  return wikiTransaction(false, async q => {
    if (!(await findBase(q, plan))) {
      one(await q(`insert into knowledge_bases(id,tenant_id,name,description,type,embedding_model_id,summary_model_id,
        indexing_strategy,wiki_config) values($1,$2,'CRM026 合成泛化资料',$3,'wiki','','',$4::jsonb,'{}'::jsonb) returning id`,
      [plan.kb.current, ALPHA_TENANT, descriptionFor(plan), JSON.stringify(indexStrategy)]));
      const marker = JSON.stringify(markerFor(plan));
      for (const entry of input) {
        const row = plan.pages[entry.id];
        one(await q(`insert into knowledges(id,tenant_id,knowledge_base_id,type,title,source,parse_status,enable_status,
          file_name,file_type,file_size,file_hash,metadata,custom_metadata,processed_at) values($1,$2,$3,'manual',$4,'manual',
          'completed','enabled',$5,'md',$6,$7,$8::jsonb,$9::jsonb,now()) returning id`, [row.documentId, ALPHA_TENANT,
          plan.kb.current, entry.title, entry.slug + '.md', Buffer.byteLength(entry.body), row.bodyHash,
          JSON.stringify({ content: entry.body }), marker]));
        one(await q(`insert into wiki_pages(id,tenant_id,knowledge_base_id,slug,title,page_type,status,content,source_refs,
          chunk_refs,version,page_metadata,last_edit_source,last_editor_id) values($1,$2,$3,$4,$5,'concept','published',$6,
          $7::jsonb,'[]'::jsonb,1,$8::jsonb,'manual','crm026-fixture-owner') returning id`, [row.pageId, ALPHA_TENANT,
          plan.kb.current, entry.slug, entry.title, entry.body, JSON.stringify([row.documentId]), marker]));
      }
    }
    return inspectPages(q, plan, input);
  });
}

export async function preflightWiki(plan, entries, pages, keyId, token, foreignPage) {
  const current = await wikiTransaction(true, async q => {
    assert(await findBase(q, plan), 'crm026_g_wiki_owned_base_missing');
    return inspectPages(q, plan, entries);
  });
  assert(same(current, pages), 'crm026_g_wiki_fixture_changed');
  const grant = await wikiAccessProof(plan, keyId, false);
  const checks = [];
  for (const row of pages) {
    const [page, doc] = await Promise.all([retrieve(token, pagePath(row)), retrieve(token, documentPath(row))]);
    const article = page.body;
    const source = doc.body?.data;
    assert(page.status === 200 && article?.id === row.pageId && article.knowledge_base_id === row.kbId &&
      article.version === row.version && article.status === 'published' && article.slug === row.slug &&
      digest(article.content) === row.bodyHash && same(article.source_refs, [row.documentId]) &&
      Date.parse(article.updated_at) === Date.parse(row.updatedAt) && doc.status === 200 && source?.id === row.documentId &&
      source.knowledge_base_id === row.kbId && source.file_hash === row.bodyHash && source.parse_status === 'completed' &&
      ['enabled', 'enable'].includes(source.enable_status) && Date.parse(source.updated_at) === Date.parse(row.documentUpdatedAt),
    'crm026_g_wiki_current_readback_failed');
    checks.push({ logicalId: row.logicalId, pageStatus: page.status, documentStatus: doc.status });
  }
  assert(foreignPage.kbId !== plan.kb.current, 'crm026_g_wiki_foreign_probe_collision');
  const [page, doc] = await Promise.all([retrieve(token, pagePath(foreignPage)), retrieve(token, documentPath(foreignPage))]);
  assert([401, 403, 404].includes(page.status) && [401, 403, 404].includes(doc.status), 'crm026_g_wiki_foreign_access');
  return { grant, checks, foreign: { pageStatus: page.status, documentStatus: doc.status } };
}

export function archiveWiki(plan, entries, pages) {
  return wikiTransaction(false, async q => {
    const base = await findBase(q, plan, { includeArchived: true });
    assert(base, 'crm026_g_wiki_owned_base_missing');
    if (!base.deleted_at) {
      assert(same(await inspectPages(q, plan, entries), pages), 'crm026_g_wiki_cleanup_fixture_changed');
      const pageIds = pages.map(row => row.pageId);
      const documentIds = pages.map(row => row.documentId);
      const scope = [plan.kb.current, ALPHA_TENANT];
      assert((await q(`update wiki_pages set deleted_at=now() where knowledge_base_id=$1 and tenant_id=$2 and
        id=any($3::varchar[]) and deleted_at is null returning id`, [...scope, pageIds])).length === pageIds.length,
      'crm026_g_wiki_cleanup_pages_changed');
      assert((await q(`update knowledges set deleted_at=now() where knowledge_base_id=$1 and tenant_id=$2 and
        id=any($3::varchar[]) and deleted_at is null returning id`, [...scope, documentIds])).length === documentIds.length,
      'crm026_g_wiki_cleanup_docs_changed');
      one(await q(`update knowledge_bases set deleted_at=now() where id=$1 and tenant_id=$2 and description=$3
        and deleted_at is null returning id`, [plan.kb.current, ALPHA_TENANT, descriptionFor(plan)]));
    }
    assert((await findBase(q, plan, { includeArchived: true }))?.deleted_at, 'crm026_g_wiki_cleanup_not_archived');
    const archived = await inspectPages(q, plan, entries, true);
    return { kbId: plan.kb.current, archived: true, pages: archived.length, documents: archived.length };
  });
}
