import assert from 'node:assert/strict';
import test from 'node:test';
import { probeJudgment, traceCandidates, wikiTraceFetch } from './crm025-probes.mjs';

test('counts relevant and conclusion-support candidate coverage separately', () => {
  const judged = probeJudgment({ requiredRelevantSourceIds: ['conditions', 'appendix'],
    answerSupportingSourceIds: ['conditions'], mustExcludeSourceIds: ['withdrawn'] },
  ['appendix', 'other', 'other', 'withdrawn'].map(logicalId => ({ logicalId })));
  assert.deepEqual(judged, { relevant: { hit: 1, expected: 2 }, essential: false,
    supporting: { hit: 0, expected: 1 }, unrelatedCandidates: 2, excluded: ['withdrawn'] });
  assert.equal(probeJudgment({ requiredRelevantSourceIds: [], answerSupportingSourceIds: [], mustExcludeSourceIds: [] }, []).essential, null);
});

test('records blocked reads at the fixture boundary before HTTP dispatch', async () => {
  const baseUrl = 'http://127.0.0.1:8088';
  const calls = [], dispatched = [];
  const page = { pageId: 'page', slug: 'pricing', kbId: 'alpha' };
  const send = wikiTraceFetch({ base_url: baseUrl }, ['alpha'], new Map([['page', page]]), new Map([['doc', page]]),
    calls, async address => {
      dispatched.push(address);
      return Response.json({ data: { id: 'doc', knowledge_base_id: 'alpha' } });
    });
  await assert.rejects(send(`${baseUrl}/api/v1/knowledge/other`, { method: 'GET' }), /crm025_probe_http_scope/);
  await assert.rejects(send(`${baseUrl}/api/v1/knowledgebase/beta/wiki/pages/pricing`, { method: 'GET' }), /crm025_probe_http_scope/);
  await send(`${baseUrl}/api/v1/knowledge/doc`, { method: 'GET' });
  assert.deepEqual(dispatched, [`${baseUrl}/api/v1/knowledge/doc`]);
  assert.deepEqual(calls.map(({ blocked, http }) => [blocked, http]), [[true, null], [true, null], [false, 200]]);
});

test('separates actual source and page read failures from filtered or returned candidates', () => {
  const requests = [
    { type: 'search', candidates: ['ok', 'unread', 'page-error', 'topic/other', 'source-error', 'below-top'].map(slug => ({ slug })) },
    { type: 'page', path: '/pages/ok', http: 200, page: { documentIds: ['a'] } },
    { type: 'page', path: '/pages/page-error', http: 502 },
    { type: 'page', path: '/pages/topic/other', http: 200, page: { documentIds: ['b'] } },
    { type: 'page', path: '/pages/source-error', http: 200, page: { documentIds: ['c'] } },
    { type: 'document', path: '/api/v1/knowledge/c', http: 403 },
  ];
  assert.deepEqual(traceCandidates(requests, [{ slug: 'ok' }], true).map(item => item.outcome), [
    'returned', 'not_read', 'original_page_read_failed', 'not_retained_after_original_page_before_source_reads',
    'read_without_evidence_receipt', 'outside_adapter_top_k',
  ]);
});
