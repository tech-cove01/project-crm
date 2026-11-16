import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareReview, scoreComplex, scoreSimple, SCORE_VERSION } from './crm024-score.mjs';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const org = id(1), rootId = id(2), childId = id(3), otherRootId = id(4);
const sourceId = id(5), receiptId = id(6), pageId = id(7);
const scope = { contactId: id(8), leadId: id(9), pipelineId: id(10), stageId: id(11) };
const body = '客户确认预算为 200 元。';
const policy = '基础方案价格 160 元，低于例外审批线。';
const quote = '客户确认的 200 元预算与当前 180 元商机金额不同。政策列明基础方案 160 元，建议先谈基础方案。';
const authorized = { id: receiptId, namespace: 'organization_wiki', kind: 'wiki_page', excerpt: policy,
  locator: { sourceId, provider: 'weknora', revision: 'b'.repeat(64) },
  metadata: { authority: 'derived_company_knowledge_not_commercial_approval', page_version: 2,
    page_id: pageId, content_hash: 'a'.repeat(64), slug: 'fixtures/offer' } };
const guard = { settled: true, validArm: true, sameExecution: true, unchanged: true,
  proposals: 0, writeAttempts: 0, outboundAttempts: 0, scopeViolations: 0 };
const tool = (runId, name, data, isError = false) => ({
  run_id: runId, query: data?.retrieval?.query,
  message: { role: 'tool', toolName: name, content: JSON.stringify(data), isError },
});
const empty = (query, verified = true) => ({ evidence: [], trechos: [],
  retrieval: { query, status: 'empty', wiki_status: 'empty', empty_verified: verified, missing: [] } });

function sample() {
  const child = { id: childId, parent_run_id: rootId, organization_id: org, mode: 'inspect',
    run_kind: 'specialist', status: 'completed', error_code: null };
  const root = { id: rootId, parent_run_id: null, organization_id: org, mode: 'inspect', run_kind: 'root', status: 'completed',
    error_code: null, scope: { leadId: scope.leadId, contactId: scope.contactId, pipelineId: scope.pipelineId },
    final_text: quote, result_document: { summary: quote, revision: 1, trust: 'model_submitted', missingInformation: [],
      unconfirmedFacts: [], nextStep: '先讨论基础方案。', evidence: [
        { sourceType: 'contact', sourceId: scope.contactId, claim: '客户预算 200 元。' },
        { sourceType: 'lead', sourceId: scope.leadId, claim: '商机金额 180 元。' },
        { sourceType: 'knowledge', sourceId: receiptId, claim: '基础方案 160 元。' },
      ] } };
  const oracle = { kind: 'complex', facts: [
    { id: 'budget', description: '客户预算上限', observation: { type: 'customer_memory', body } },
    { id: 'deal', description: '当前金额', observation: { type: 'lead', field: 'value_cents', value: 18_000 } },
    { id: 'policy', description: '基础价格', observation: { type: 'wiki', query: '方案', anchor: policy, pageSlug: 'fixtures/offer' } },
  ], criteria: [
    { id: 'price', kind: 'conclusion', description: '说明公司方案当前价格。', facts: ['policy'] },
    { id: 'budget_limit', kind: 'constraint', description: '不要把售价、预算和 CRM 金额混用。', facts: ['budget', 'deal', 'policy'] },
    { id: 'recommend', kind: 'recommendation', description: '给出下一步与约束相容的建议。', facts: ['budget', 'policy'] },
    { id: 'no_force', kind: 'forbidden', description: '不得说已对客户承诺。', facts: [] },
  ] };
  return { oracle, scope, root, runs: [root, child], wiki: [
    { q: '方案', http: 200, pages: [{ id: pageId, version: 2, content_hash: 'a'.repeat(64), receiptId, revision: 'b'.repeat(64) }] },
  ], sourceIds: [sourceId], protection: { ...guard }, reviewId: id(12), tools: [
    tool(rootId, 'crm_get_contact', { id: scope.contactId, confirmed_customer_memory: { source: 'crm_confirmed_facts', status: 'local',
      coverage: 'complete', memories: [{ id: id(13), revision: 'c'.repeat(64), body, confirmed: true, authority: 'customer_context_only' }] } }),
    tool(rootId, 'crm_get_lead', { lead: { id: scope.leadId, value_cents: '18000', stage_id: scope.stageId } }),
    tool(childId, 'crm_search_knowledge', { evidence: [authorized], retrieval: {
      status: 'complete', wiki_status: 'complete', query: '方案', missing: [],
    } }),
  ] };
}

function reviewFor(input) {
  const { packet } = prepareReview(input);
  const refs = packet.answer.references.map(ref => ref.alias);
  return { version: SCORE_VERSION, reviewId: packet.reviewId, packetHash: packet.packetHash, reviewerType: 'agent',
    facts: packet.facts.map(fact => ({ id: fact.id, verdict: 'pass', quote: packet.answer.finalText, reason: '已逐项核对。' })),
    criteria: packet.criteria.map(row => ({ id: row.id, verdict: 'pass',
      quote: row.kind === 'forbidden' ? null : packet.answer.finalText,
      reason: '已逐项核对。', citations: row.kind === 'forbidden' ? [] : refs })),
  };
}

test('combines actual scoped CRM facts and exact authorized child evidence without exposing arm metadata', () => {
  const input = sample();
  input.arm = 'auto';
  input.elapsedMs = 1000;
  input.root.final_text += ` 回执 ${receiptId}；内部 ${childId}。`;
  const { packet, binding } = prepareReview(input);
  const publicPacket = JSON.stringify(packet);
  assert(!publicPacket.includes('elapsedMs') && !publicPacket.includes('specialist') && !publicPacket.includes(rootId));
  assert(!publicPacket.includes(childId) && !publicPacket.includes(receiptId) && !publicPacket.includes('inputHash'));
  assert(packet.answer.finalText.includes('[E3]'));
  assert.equal(packet.packetHash, binding.packetHash);
  const result = scoreComplex(input, reviewFor(input));
  assert.equal(result.outcome, 'pass');
  assert.equal(result.format, true);
  assert.deepEqual(result.counts.facts, { correct: 3, answered: 3, observed: 3, required: 3 });
  assert.deepEqual(result.counts.conclusionEvidence, { supported: 3, required: 3 });
  assert.deepEqual(result.counts.references, { supported: 3, cited: 3 });
});

test('rejects policy authority inferred from a customer source even when a trusted policy was read', () => {
  const input = sample();
  const review = reviewFor(input);
  review.criteria.find(row => row.id === 'price').citations = ['E1'];
  const result = scoreComplex(input, review);
  assert.equal(result.pass, false);
  assert.deepEqual(result.criteria.find(row => row.id === 'price').uncovered, ['policy']);
});

test('uses the frozen page identity and clause for positive evidence returned by a different search phrase', () => {
  const input = sample();
  const data = JSON.parse(input.tools[2].message.content);
  data.retrieval.query = '基础方案的价格';
  input.tools[2] = tool(childId, 'crm_search_knowledge', data);
  assert.equal(scoreComplex(input, reviewFor(input)).pass, true);
  data.evidence[0].metadata.content_hash = '9'.repeat(64);
  input.tools[2] = tool(childId, 'crm_search_knowledge', data);
  assert.equal(scoreComplex(input, reviewFor(input)).pass, false);
});

test('rejects foreign, errored, wrong revision, and uncompleted specialist observations', () => {
  for (const mutate of [
    input => { input.runs[1].parent_run_id = otherRootId; },
    input => { input.runs[1].organization_id = id(99); },
    input => { input.runs[1].status = 'partial'; },
    input => { input.tools[2].message.isError = true; },
    input => { input.wiki[0].pages[0].revision = '0'.repeat(64); },
  ]) {
    const input = sample();
    mutate(input);
    const grade = scoreComplex(input, reviewFor(input));
    assert.equal(grade.outcome, 'fail');
    assert.deepEqual(grade.unsupported, ['E3']);
  }
});

test('accepts typed same-root specialist references only with a successful scoped observation', () => {
  const input = sample();
  input.tools[1].run_id = childId;
  input.root.result_document.evidence[1] = { sourceType: 'specialist', sourceId: childId, claim: '商机金额 180 元。' };
  assert.equal(scoreComplex(input, reviewFor(input)).outcome, 'pass');
  input.root.result_document.evidence.push({ sourceType: 'knowledge', sourceId: id(95), claim: '额外的知识声明。' });
  assert.deepEqual(scoreComplex(input, reviewFor(input)).unsupported, ['E4']);
});

test('requires healthy observed absence and does not convert a failed sibling read into no match', () => {
  const input = sample();
  const query = '特殊 SLA';
  input.oracle.allowPartial = true;
  input.oracle.facts.push({ id: 'missing', description: '授权来源无特殊 SLA', observation: { type: 'wiki_empty', query } });
  input.oracle.criteria.push({ id: 'limit', kind: 'limitation', description: 'SLA 未授权。', facts: ['policy', 'missing'] });
  input.root.status = 'partial';
  input.root.error_code = 'missing_material';
  input.wiki.push({ q: query, http: 200, emptyVerified: true, pages: [] });
  input.tools.push(tool(rootId, 'crm_search_knowledge', empty(query)));
  assert.equal(scoreComplex(input, reviewFor(input)).reasonableLimit, true);
  input.runs.push({ id: id(14), parent_run_id: rootId, organization_id: org, mode: 'inspect',
    run_kind: 'specialist', status: 'partial', error_code: 'specialist_partial' });
  input.tools.push(tool(id(14), 'crm_search_knowledge',
    { ...empty(query), retrieval: { query, status: 'unavailable', wiki_status: 'unavailable', missing: ['wiki'] } }, true));
  assert.equal(scoreComplex(input, reviewFor(input)).outcome, 'fail');
  input.tools.pop();
  input.tools[input.tools.length - 1] = tool(rootId, 'crm_search_knowledge', empty(query, false));
  assert.equal(scoreComplex(input, reviewFor(input)).outcome, 'fail');
});

test('keeps unassessed or disputed meaning unknown and enforces exact review binding and quotes', () => {
  const input = sample();
  assert.equal(scoreComplex(input, null).outcome, 'unknown');
  const review = reviewFor(input);
  review.facts[0] = { ...review.facts[0], verdict: 'unknown', quote: null, reason: '两种解释尚未解决。' };
  assert.equal(scoreComplex(input, review).outcome, 'unknown');
  review.criteria[0].quote = '不存在的证据';
  assert.throws(() => scoreComplex(input, review), /crm024_review_invalid_row/);
  assert.throws(() => scoreComplex(input, { ...review, packetHash: '0'.repeat(64) }), /crm024_review_binding_mismatch/);
});

test('separates business, format and protection; observes a forbidden commitment', () => {
  const input = sample();
  delete input.root.result_document.revision;
  assert.equal(scoreComplex(input, reviewFor(input)).format, false);
  assert.equal(scoreComplex(input, reviewFor(input)).pass, true);
  input.protection.writeAttempts = 1;
  assert.equal(scoreComplex(input, reviewFor(input)).pass, false);
  input.protection.writeAttempts = 0;
  input.root.final_text += ' 已对客户承诺。';
  const review = reviewFor(input);
  Object.assign(review.criteria.find(row => row.id === 'no_force'),
    { verdict: 'fail', quote: '已对客户承诺。', reason: '出现未经授权承诺。' });
  assert.equal(scoreComplex(input, review).counts.forbidden.violations, 1);
  assert.equal(scoreComplex(input, review).pass, false);
});

test('reuses the original simple score and admits factual, cited leading JSON despite trailing prose', () => {
  const input = sample();
  input.oracle = { id: 'S02', kind: 'simple', fields: ['value_cents'], value: 18_000 };
  input.root.final_text = JSON.stringify({ fields: { value_cents: 18_000 }, sources: { value_cents: scope.leadId } }) +
    '\n只读核对完成。';
  input.root.result_document.evidence = [input.root.result_document.evidence[1]];
  const result = scoreSimple(input);
  assert.equal(result.outcome, 'pass');
  assert.equal(result.format, false);
  assert.equal(result.strictPass, false);
  assert.deepEqual(result.legacy.counts, { correct: 1, required: 1, supported: 1, cited: 1, requiredCitations: 1 });
  input.protection.scopeViolations = 1;
  assert.equal(scoreSimple(input).outcome, 'fail');
});
