import assert from 'node:assert/strict';
import { isDeepStrictEqual as same } from 'node:util';
import { digest, sha, uuid } from './crm024-fixtures.mjs';
import { WIKI_ORIGIN } from './crm025-materials-context.mjs';
import { documentPath, pagePath } from './crm025-materials-wiki.mjs';

/** No-generation smoke test through the real read adapter and owned evidence storage. */
export async function verifyWikiSearch(c, transaction) {
  const { plan, pages } = c;
  const kbSearch = `/api/v1/knowledgebase/${plan.kb.current}/wiki/search`;
  const byId = new Map(pages.map(page => [page.pageId, page]));
  const exactReadPaths = new Set(pages.flatMap(page => [pagePath(page), documentPath(page)]));
  const originalBinding = process.env.AI_INTEGRATION_BINDINGS;
  process.env.AI_INTEGRATION_BINDINGS = c.env.AI_INTEGRATION_BINDINGS;
  try {
    const { searchCompanyWiki } = await import('../../lib/ai/integrations/weknora.ts');
    return await transaction(c, false, async q => {
      const pool = { query: async ({ text, values }) => {
        const ids = Array.isArray(values?.[1]) ? values[1] : null;
        const select = /^(?:select enabled from ai_integration_settings|select id,source_metadata,updated_at from ai_knowledge_sources|select id from ai_wiki_evidence)\b/.test(text);
        const insert = /^insert into ai_wiki_evidence\b/.test(text);
        assert(values?.[0] === plan.organizationId &&
          (select && (values[1] === 'weknora' || values[1] === plan.sourceId || ids?.every(id => id === plan.sourceId)) ||
           insert && values[1] === plan.sourceId && sha.test(values[2]) && pages.some(page => page.bodyHash === digest(values[4]))),
        'crm026_g_probe_sql_scope');
        return { rows: await q(text, values) };
      } };
      const probe = async query => {
        let requests = 0;
        let forbidden = false;
        const fetcher = async (input, init = {}) => {
          const url = new URL(input instanceof Request ? input.url : input);
          const allowed = url.origin === WIKI_ORIGIN && (init.method ?? 'GET') === 'GET' &&
            (url.pathname === kbSearch || exactReadPaths.has(url.pathname) && !url.search);
          if (!allowed) { forbidden = true; throw Error('crm026_g_probe_http_scope'); }
          requests += 1;
          const response = await fetch(input, { ...init, redirect: 'error' });
          if (response.status >= 400) forbidden = true;
          return response;
        };
        const start = performance.now();
        const outcome = await searchCompanyWiki(pool, plan.organizationId, [plan.sourceId], query, 5, undefined, fetcher);
        const elapsedMs = Math.round(performance.now() - start);
        assert(!forbidden && requests > 0 && same(outcome.handledSourceIds, [plan.sourceId]) &&
          ['complete', 'empty'].includes(outcome.status), 'crm026_g_probe_upstream_failure');
        const receipts = outcome.evidence.map(row => {
          const page = byId.get(row.metadata?.page_id);
          assert(page && page.kbId === row.metadata.knowledge_base_id && page.version === row.metadata.page_version &&
            row.locator?.sourceId === plan.sourceId && uuid.test(row.id) && sha.test(row.locator.revision) &&
            page.bodyHash === row.metadata.content_hash && digest(row.excerpt) === page.bodyHash, 'crm026_g_probe_returned_unknown_page');
          return { logicalId: page.logicalId, id: row.id, revision: row.locator.revision };
        });
        return { status: outcome.status, queryMode: outcome.queryMode, emptyVerified: outcome.emptyVerified,
          receipts, requests, elapsedMs };
      };
      const positive = await probe('楠望扫码通道 Code 128 标签配置');
      const negative = await probe('第三方打印硒鼓回收商 定点上门 最少箱数');
      const observed = negative.emptyVerified === true && !negative.receipts.length ? 'verified_empty'
        : negative.receipts.length ? 'unrelated_candidates' : 'unverified_empty';
      return { positive: { ...positive, foundExpected: positive.receipts.some(item => item.logicalId === 'W03') },
        negative: { ...negative, observed }, modelCalls: 0 };
    });
  } finally {
    if (originalBinding === undefined) delete process.env.AI_INTEGRATION_BINDINGS;
    else process.env.AI_INTEGRATION_BINDINGS = originalBinding;
  }
}
