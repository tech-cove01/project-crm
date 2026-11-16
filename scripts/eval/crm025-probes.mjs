/** Run each frozen CRM-025 Wiki probe once through the actual adapter. */
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { at, digest, optional, seal, sha } from './crm024-fixtures.mjs';

const base = resolve(import.meta.dirname, '../../.local/crm025');
const top = 5;

export function probeJudgment(probe, returned) {
  const ids = new Set(returned.map(item => item.logicalId));
  const hit = expected => expected.filter(id => ids.has(id)).length;
  const required = probe.requiredRelevantSourceIds;
  const supporting = probe.answerSupportingSourceIds;
  return {
    relevant: { hit: hit(required), expected: required.length },
    essential: required.length ? hit(required) === required.length : null,
    supporting: { hit: hit(supporting), expected: supporting.length },
    unrelatedCandidates: [...ids].filter(id => !required.includes(id)).length,
    excluded: probe.mustExcludeSourceIds.filter(id => ids.has(id)),
  };
}

function wikiBinding(context, fixture) {
  const all = JSON.parse(context.env.AI_INTEGRATION_BINDINGS ?? '[]');
  const binding = all.find(item => item.organization_id === context.org && item.provider === 'weknora');
  const kbIds = new Set(fixture.sourceIds.flatMap(source => Object.values(fixture.pages)
    .filter(page => page.sourceId === source && page.state === 'published').map(page => page.kbId)));
  assert(binding?.visibility === 'organization' && new URL(binding.base_url).origin === 'http://127.0.0.1:8088' &&
    kbIds.size === 1 && binding.knowledge_base_ids.length === kbIds.size && binding.knowledge_base_ids.every(id => kbIds.has(id)),
  'crm025_probe_common_binding_changed');
  return { binding, kbIds };
}

const pagePath = (kb, slug) => `/api/v1/knowledgebase/${kb}/wiki/pages/${slug.split('/').map(encodeURIComponent).join('/')}`;
const documentPath = id => `/api/v1/knowledge/${encodeURIComponent(id)}`;

export function wikiTraceFetch(binding, kbIds, pages, documents, requests, fetchImpl = fetch) {
  const searches = new Set([...kbIds].map(kb => `/api/v1/knowledgebase/${kb}/wiki/search`));
  const pagesByPath = new Set([...pages.values()].map(page => pagePath(page.kbId, page.slug)));
  const documentsByPath = new Set([...documents.keys()].map(documentPath));
  return async (address, init) => {
    const url = new URL(address instanceof Request ? address.url : address);
    const type = searches.has(url.pathname) ? 'search' : pagesByPath.has(url.pathname) ? 'page' :
      documentsByPath.has(url.pathname) ? 'document' : null;
    const blocked = url.origin !== new URL(binding.base_url).origin || init?.method !== 'GET' || !type;
    const request = { type, path: url.pathname, query: url.searchParams.get('q'), http: null, blocked };
    requests.push(request);
    assert(!blocked, 'crm025_probe_http_scope');
    const response = await fetchImpl(address, { ...init, redirect: 'error' });
    request.http = response.status;
    const body = response.ok ? await response.clone().json().catch(() => null) : null;
    if (type === 'search' && Array.isArray(body?.pages)) {
      request.candidates = body.pages.map(page => ({ id: page?.id ?? null, slug: page?.slug ?? null }));
    } else if (type === 'page' && body && typeof body === 'object') {
      request.page = { id: body.id ?? null, slug: body.slug ?? null, kbId: body.knowledge_base_id ?? null,
        version: body.version ?? null, state: body.status ?? null,
        bodyHash: typeof body.content === 'string' ? digest(body.content) : null,
        documentIds: Array.isArray(body.source_refs) ? body.source_refs.map(ref => typeof ref === 'string' ? ref.split('|')[0] : null) : [] };
    } else if (type === 'document' && body?.data) {
      const row = body.data;
      request.document = { id: row.id ?? null, kbId: row.knowledge_base_id ?? null, fileHash: row.file_hash ?? null,
        parseStatus: row.parse_status ?? null, enableStatus: row.enable_status ?? null };
    }
    return response;
  };
}

function verifiedRows(fixture, actorOrg) {
  const pages = new Map(), documents = new Map();
  for (const [logicalId, item] of Object.entries(fixture.pages)) {
    if (item.state !== 'published' || !fixture.sourceIds.includes(item.sourceId)) continue;
    const row = { logicalId, ...item };
    assert(!pages.has(item.pageId) && !documents.has(item.documentId) && item.pageId && item.slug && item.version && sha.test(item.bodyHash),
      'crm025_probe_fixture_page_identity');
    pages.set(item.pageId, row);
    documents.set(item.documentId, row);
  }
  assert(fixture.org === actorOrg && pages.size === 28, 'crm025_probe_common_pool_required');
  return { pages, documents };
}

function auditedPool(q, org, fixture, pages) {
  return { query: async ({ text, values }) => {
    assert(values?.[0] === org, 'crm025_probe_sql_scope');
    if (/^\s*insert into ai_wiki_evidence\b/i.test(text)) {
      const manifest = JSON.parse(values[3]);
      const page = pages.get(manifest.page_id);
      assert(page && page.sourceId === values[1] && sha.test(values[2]) && manifest.knowledge_base_id === page.kbId &&
        manifest.page_version === page.version && manifest.content_hash === page.bodyHash && digest(values[4]) === page.bodyHash &&
        manifest.sources.length === 1 && manifest.sources[0].id === page.documentId, 'crm025_probe_receipt_scope');
    } else {
      assert(/^\s*select\b[\s\S]*\bfrom\s+(?:ai_knowledge_sources|ai_integration_settings|ai_wiki_evidence)\b/i.test(text),
        'crm025_probe_sql_operation');
      if (/\bfrom\s+ai_knowledge_sources\b/i.test(text)) {
        assert(Array.isArray(values[1]) && values[1].every(id => fixture.sourceIds.includes(id)), 'crm025_probe_source_scope');
      }
    }
    return { rows: await q(text, values) };
  } };
}

function verifyReads(requests, pages, documents) {
  const bySlug = new Map([...pages.values()].map(page => [page.slug, page]));
  for (const request of requests) {
    for (const candidate of request.candidates ?? []) {
      const page = bySlug.get(candidate.slug);
      if (candidate.id || candidate.slug) assert(page && (!candidate.id || candidate.id === page.pageId), 'crm025_probe_unexpected_search_candidate');
    }
    if (request.page) {
      const page = pages.get(request.page.id);
      assert(page && page.kbId === request.page.kbId && page.version === request.page.version &&
        page.slug === request.page.slug && page.bodyHash === request.page.bodyHash && request.page.state === 'published',
      'crm025_probe_unexpected_page_read');
    }
    if (request.document) {
      const document = documents.get(request.document.id);
      assert(document && document.kbId === request.document.kbId && document.bodyHash === request.document.fileHash,
        'crm025_probe_unexpected_document_read');
    }
  }
}

export function traceCandidates(requests, returned, fallback) {
  return requests.filter(request => request.type === 'search').flatMap((search, index) =>
    (search.candidates ?? []).map((candidate, rank) => {
      const slugPath = typeof candidate.slug === 'string' ? candidate.slug.split('/').map(encodeURIComponent).join('/') : null;
      const read = slugPath && requests.find(request => request.type === 'page' && request.path.endsWith(`/${slugPath}`));
      if (returned.some(page => page.slug === candidate.slug)) return { ...candidate, rank: rank + 1, search: index + 1, outcome: 'returned' };
      let outcome = !read && rank >= top ? 'outside_adapter_top_k' : !read ? 'not_read' :
        read.http !== 200 || !read.page ? 'original_page_read_failed' : 'read_without_evidence_receipt';
      if (fallback && read?.page && !requests.some(request => request.type === 'document' &&
          read.page.documentIds.some(id => request.path.endsWith(`/${encodeURIComponent(id)}`)))) {
        outcome = 'not_retained_after_original_page_before_source_reads';
      }
      return { ...candidate, rank: rank + 1, search: index + 1, outcome };
    }));
}

async function measure(context, fixture, probe, adapter, transaction) {
  const { binding, kbIds } = wikiBinding(context, fixture);
  const { pages, documents } = verifiedRows(fixture, context.org);
  const requests = [];
  let result, failure = null, unsafe = false;
  const before = performance.now();
  try {
    result = await transaction(context, false, q => adapter.searchCompanyWiki(auditedPool(q, context.org, fixture, pages),
      context.org, fixture.sourceIds, probe.query, top, AbortSignal.timeout(15000), wikiTraceFetch(binding, kbIds, pages, documents, requests)));
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    failure = /^(?:crm025_[a-z0-9_]+|integration_http_\d{3}|integration_db_timeout)$/.test(message)
      ? message : 'adapter_call_failed';
    unsafe = failure.startsWith('crm025_');
  }
  if (requests.some(request => request.blocked)) { failure = 'crm025_probe_http_scope'; unsafe = true; }
  try { verifyReads(requests, pages, documents); }
  catch (error) { failure = error.message; unsafe = true; }
  const returned = (result?.evidence ?? []).map(row => {
    const page = pages.get(row.metadata?.page_id);
    if (!page || row.locator?.sourceId !== page.sourceId || row.metadata.page_version !== page.version ||
        row.metadata.content_hash !== page.bodyHash || digest(row.excerpt) !== page.bodyHash) unsafe = true;
    return { logicalId: page?.logicalId ?? null, slug: row.metadata?.slug ?? null, receiptId: row.id,
      pageId: row.metadata?.page_id ?? null, version: row.metadata?.page_version ?? null, revision: row.locator?.revision ?? null };
  });
  const elapsedMs = Math.round(performance.now() - before);
  const environmentFailure = failure && !unsafe || result?.status === 'disabled' ||
    result && (result.handledSourceIds.length !== fixture.sourceIds.length ||
      !result.handledSourceIds.every(id => fixture.sourceIds.includes(id))) ||
    requests.some(request => !request.blocked && (request.http === null || request.http >= 500 ||
      [401, 403, 429].includes(request.http) || request.type === 'search' && request.http >= 400));
  return { failure, unsafe, elapsedMs, status: result?.status ?? null, emptyVerified: result?.emptyVerified ?? false,
    environmentFailure: Boolean(environmentFailure), mode: result?.queryMode ?? null,
    handledSourceIds: result?.handledSourceIds ?? [], internalHttp: requests,
    trace: traceCandidates(requests, returned, result?.fallbackUsed), evidence: returned, score: probeJudgment(probe, returned) };
}

async function runProbeBatch(phase, split, freezeHash) {
  assert(['baseline', 'candidate'].includes(phase) && ['dev', 'holdout'].includes(split) && sha.test(freezeHash) &&
    process.env.CRM025_EXECUTE === freezeHash, 'crm025_probe_frozen_scope_required');
  const [{ read025Freeze }, { crm025Transaction }, adapter] = await Promise.all([
    import('./crm025-run.mjs'), import('./crm025-materials.mjs'), import('../../lib/ai/integrations/weknora.ts'),
  ]);
  const { frozen, context, dataset, fixture } = await read025Freeze(phase, freezeHash);
  process.env.AI_INTEGRATION_BINDINGS = context.env.AI_INTEGRATION_BINDINGS;
  const dir = resolve(base, phase, split, 'probes');
  await mkdir(dir, { recursive: true });
  let settled = 0;
  for (const scenario of dataset.cases.filter(item => item.split === (split === 'dev' ? 'development' : 'evaluation'))) {
    for (const [i, probe] of scenario.retrieval.probes.entries()) {
      const slot = `${scenario.id}-${i + 1}`;
      const intentPath = resolve(dir, `${slot}-intent.json`), resultPath = resolve(dir, `${slot}-result.json`);
      const archived = await optional(resultPath);
      if (archived) {
        const priorRaw = await readFile(intentPath);
        const previousIntent = JSON.parse(priorRaw);
        const bound = { phase, split, slot, caseId: scenario.id, probeNumber: i + 1, freezeHash, datasetHash: frozen.datasetHash };
        assert(digest(priorRaw) === archived.intentHash && Object.entries(bound).every(([key, val]) =>
          previousIntent[key] === val && archived[key] === val) && previousIntent.request?.query === probe.query &&
          previousIntent.request.top === top && archived.query === probe.query && !archived.unsafe, 'crm025_probe_original_safety_stop');
        settled += 1;
        continue;
      }
      assert(!(await optional(intentPath)), 'crm025_probe_unknown_original_request');
      const intent = await seal(intentPath, { at: at(), phase, split, slot, caseId: scenario.id, probeNumber: i + 1,
        freezeHash, datasetHash: frozen.datasetHash, request: { query: probe.query, top } }, false);
      const outcome = await measure(context, fixture, probe, adapter, crm025Transaction);
      await seal(resultPath, { at: at(), phase, split, slot, caseId: scenario.id, probeNumber: i + 1,
        query: probe.query, freezeHash, datasetHash: frozen.datasetHash, intentHash: intent.sha256, ...outcome }, false);
      assert(!outcome.unsafe, 'crm025_probe_actual_scope_stop');
      settled += 1;
    }
  }
  console.info(JSON.stringify({ phase, split, settled }));
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  runProbeBatch(...process.argv.slice(2)).catch(error => {
    const code = /^(?:crm025_[a-z0-9_]+|integration_http_\d{3})$/.test(error?.message ?? '') ? error.message : 'crm025_probe_batch_failed';
    console.error(JSON.stringify({ error: code }));
    process.exitCode = 1;
  });
}
