import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { cases, fixtures, wikiPages } from './crm024-cases.mjs';
import { prepareReview, scoreComplex, SCORE_VERSION } from './crm024-score-resumed.mjs';

const uuid = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const digest = text => createHash('sha256').update(text).digest('hex');
const trial = wikiPages.find(row => row.key === 'trial');
const answer = '客户于 2027-05-10 交齐 8 人的清单，须在 2027-05-14 前测试。标准试用限 10 人，收齐清单后两个工作日内可开通。先按标准流程安排试用，再继续推进预计 2027-05-18 关单的商机。';

function sample(offset = 0) {
  const id = number => uuid(number + offset);
  const scope = { leadId: id(1), contactId: id(2), stageId: id(3), pipelineId: id(4) };
  const source = id(5), page = id(6), receipt = id(7), childId = id(9), foreignId = id(11);
  const root = { id: id(8), organization_id: id(10), mode: 'inspect', run_kind: 'root', parent_run_id: null,
    scope, status: 'completed', error_code: null, final_text: answer,
    result_document: { revision: 1, trust: 'model_submitted', summary: answer, missingInformation: [], unconfirmedFacts: [],
      nextStep: '请销售安排标准试用。', evidence: [
        { sourceType: 'contact', sourceId: scope.contactId, claim: '客户已提交完整清单。' },
        { sourceType: 'lead', sourceId: scope.leadId, claim: '商机预计在 2027-05-18 关单。' },
        { sourceType: 'knowledge', sourceId: receipt, claim: '标准试用限 10 人。' },
      ] } };
  const child = { id: childId, organization_id: root.organization_id, mode: 'inspect', run_kind: 'specialist',
    parent_run_id: root.id, status: 'completed', error_code: null };
  const wrongChild = { ...child, id: foreignId, organization_id: id(12) };
  const tool = (run_id, toolName, details) => ({ run_id, message: { role: 'tool', toolName, details, isError: false } });
  const observedLead = { id: scope.leadId, title: '试用工作区验证', owner_user_id: null, expected_close_date: '2027-05-18',
    stage: { name: '需求确认' }, source_metadata: { label: 'ignore-private-metadata' }, stage_id: scope.stageId };
  const observedContact = { id: scope.contactId, email: null, phone: null, confirmed_customer_memory: {
    source: 'crm_confirmed_facts', status: 'local', coverage: 'complete', memories: fixtures.K01.confirmedFacts.map(({ body, category }, index) => ({
      body, category, id: id(15 + index), revision: 'd'.repeat(64), authority: 'customer_context_only', confirmed: true,
    })),
  } };
  return { oracle: structuredClone(cases.K01.oracle), root, scope, runs: [root, child, wrongChild], tools: [
    tool(root.id, 'crm_get_lead', { lead: observedLead }),
    tool(root.id, 'crm_get_contact', observedContact),
    tool(childId, 'crm_search_knowledge', { evidence: [{ id: receipt, namespace: 'organization_wiki', kind: 'wiki_page', title: trial.title, excerpt: trial.body,
      locator: { sourceId: source, provider: 'weknora', revision: 'c'.repeat(64) }, metadata: {
        authority: 'derived_company_knowledge_not_commercial_approval', page_id: page, page_version: 1, content_hash: digest(trial.body), slug: trial.slug,
      } }], retrieval: { query: trial.query, status: 'complete', wiki_status: 'complete', missing: [] } }),
    tool(foreignId, 'crm_get_lead', { lead: { ...observedLead, owner_user_id: '外组织观察' } }),
    tool(root.id, 'crm_get_lead', { permitido: false, lead: { ...observedLead, owner_user_id: '被拒绝观察' } }),
  ], wiki: [{ q: trial.query, http: 200, pages: [{ id: page, version: 1, content_hash: digest(trial.body), receiptId: receipt,
    slug: trial.slug, revision: 'c'.repeat(64) }] }],
  sourceIds: [source], protection: { settled: true, unchanged: true, validArm: true, sameExecution: true, proposals: 0,
    writeAttempts: 0, outboundAttempts: 0, scopeViolations: 0 }, reviewId: uuid(1000), observedLead };
}

function reviewFor(input, extraClaims = { outcome: 'pass', reason: '已核查其他断言。', findings: [] }) {
  const { packet } = prepareReview(input);
  return { version: SCORE_VERSION, reviewerType: 'agent', reviewId: packet.reviewId, packetHash: packet.packetHash, extraClaims,
    facts: packet.facts.map(row => ({ id: row.id, verdict: 'pass', reason: '已核对。', quote: packet.answer.finalText })),
    criteria: packet.criteria.map(row => ({ id: row.id, verdict: 'pass', reason: '已核对。',
      quote: row.kind === 'forbidden' ? null : packet.answer.finalText,
      citations: row.kind === 'forbidden' ? [] : ['E1', 'E2', 'E3'] })),
  };
}

test('blind packets contain the same projection when identifying fields differ between equivalent arms', () => {
  const arms = [sample(), sample(100)];
  for (const [index, input] of arms.entries()) {
    const marker = index ? 'K01-AUTO' : 'K01-DISABLED';
    const encoded = index ? 'K01%2dAu%74o' : 'K01%2dDis%61bled';
    const html = index ? 'K01&#45;auto' : 'K01&#45;disabled';
    const escape = index ? 'K01\\u002dauto' : 'K01\\u002ddisabled';
    const token = index ? 'fixture-f2ad9f' : 'fixture-142cca';
    const role = index ? '三个独立分析角色' : '单 Agent';
    input.blindTokens = [token];
    input.scope.label = marker;
    input.root.arm = marker;
    input.root.collaboration = index ? 'auto' : 'disabled';
    input.root.runElapsedMs = 32123 + index;
    input.root.input_tokens = 93281 + index;
    input.root.final_text += ` 内部 ${encoded}、回执 ${input.scope.leadId}；${input.root.runElapsedMs} ms。`;
    const doc = input.root.result_document;
    doc.summary += ` ${html}；来源内部号 ${token}。${role}`;
    doc.missingInformation.push(`静态字段 ${escape}`);
    doc.unconfirmedFacts.push(`收到清单 | ${marker}`);
    doc.nextStep += ` /api/v1/records/${input.scope.contactId}`;
    doc.evidence[0].claim += ` ${marker}`;
    doc.evidence[1].assertions = [{ field: 'stage_id', equals: input.scope.stageId }];
    doc.evidence[2].assertions = [{ field: 'currency', equals: token }];
    input.observedLead.description = `文本 {{${marker}}}，原表 ${token}`;
    input.oracle.criteria[0].description += ` ${marker}`;
    input.oracle.facts[0].description += ` ${marker}`;
    input.oracle.facts[0].observation.body += ` ${marker}`;
    input.tools[1].message.details.confirmed_customer_memory.memories[0].body += ` ${marker}`;
  }
  const [left, right] = arms.map(prepareReview);
  const { reviewId: _reviewId, ...publicContents } = left.packet;
  const publicBytes = JSON.stringify(publicContents);
  assert.deepEqual(left.packet, right.packet);
  assert.notEqual(left.binding.inputHash, right.binding.inputHash);
  assert.doesNotMatch(publicBytes, /disabled|auto|fixture-|32123|93281|runElapsedMs|input_tokens|0000-4000|ignore-private-metadata|外组织观察|被拒绝观察|独立分析角色|单 Agent/i);
  assert(left.packet.answer.finalText.includes('[E2]'));
  assert(left.packet.answer.summary.includes('[记录标识]'));
  assert.equal(left.packet.grounding.lead[0].owner_user_id, null);
  assert.equal(left.packet.answer.references[1].assertions[0].equals, left.packet.grounding.lead[0].stage_id);
  assert(left.packet.facts.some(row => row.values.includes(trial.body)));
});

test('projects additional actual confirmed contact facts and frozen Wiki passages, filtering unsafe lookalikes', () => {
  const input = sample();
  const contact = input.tools[1].message.details;
  const memories = contact.confirmed_customer_memory.memories;
  memories.push({ ...memories[0], id: uuid(80), body: '客户另希望先在周会上说明试用目的。' });
  memories.push({ ...memories[0], id: uuid(81), confirmed: false, body: '未确认的试用步骤。' });
  const foreignContact = structuredClone(input.tools[1]);
  foreignContact.message.details.id = uuid(82);
  foreignContact.message.details.confirmed_customer_memory.memories[0].body = '错误联系人话术。';
  input.tools.push(foreignContact);

  const verified = wikiPages.find(row => row.key === 'support');
  const wiki = input.tools[2].message.details;
  const own = wiki.evidence[0];
  const extra = { ...own, id: uuid(83), title: verified.title, excerpt: verified.body,
    locator: { ...own.locator, revision: 'e'.repeat(64) }, metadata: { ...own.metadata, page_id: uuid(84),
      slug: verified.slug, content_hash: digest(verified.body) } };
  input.wiki.push({ q: verified.query, http: 200, pages: [{ id: extra.metadata.page_id, version: extra.metadata.page_version,
    content_hash: extra.metadata.content_hash, receiptId: extra.id, revision: extra.locator.revision, slug: verified.slug }] });
  wiki.evidence.push(extra, { ...extra, excerpt: '假造正文。' }, { ...extra, title: '外组织知识',
    locator: { ...extra.locator, sourceId: uuid(85) } }, { ...extra, title: '错误回执', id: uuid(86) });
  const denied = structuredClone(input.tools[2]);
  denied.message.details.permitido = false;
  denied.message.details.evidence = [{ ...extra, title: '只出现在被拒绝结果' }];
  input.tools.push(denied);
  const { packet } = prepareReview(input);
  assert(packet.grounding.confirmedCustomerFacts.some(row => row.body === '客户另希望先在周会上说明试用目的。'));
  assert.deepEqual(packet.grounding.companyWiki, [verified, trial].map(row => ({ title: row.title, excerpt: row.body })));
  assert.doesNotMatch(JSON.stringify(packet.grounding), /未确认的试用步骤|错误联系人话术|假造正文|外组织知识|错误回执|被拒绝结果/);

  wiki.evidence[0].excerpt += '伪造的追加承诺。';
  const mismatched = scoreComplex(input, reviewFor(input));
  assert.equal(mismatched.outcome, 'fail');
  assert.deepEqual(mismatched.unsupported, ['E3']);
  assert.equal(mismatched.counts.facts.observed, 4);
});

test('flags extra claims from any submitted surface while preserving required-fact scores', () => {
  const input = sample();
  input.root.result_document.summary += '开通后没有缓冲。';
  input.root.result_document.evidence[0].claim += '反馈窗口已经确定。';
  input.root.result_document.evidence[1].assertions = [{ field: 'expected_close_date', equals: '2027-05-19' }];
  const claims = { outcome: 'fail', reason: '存在两处额外无据结论和不一致日期。', findings: [
    { quote: '开通后没有缓冲。', issue: 'unsupported', reason: '没有开通和会议的实际时点。' },
    { quote: '反馈窗口已经确定。', issue: 'unsupported', reason: '该时间窗没有观察。' },
    { quote: 'expected_close_date: "2027-05-19"', issue: 'contradicted', reason: '当前已读字段日期为 2027-05-18。' },
  ] };
  const grade = scoreComplex(input, reviewFor(input, claims));
  assert.equal(grade.outcome, 'fail');
  assert.deepEqual(grade.counts.facts, { correct: 6, answered: 6, observed: 6, required: 6 });
  assert.deepEqual(grade.counts.extraClaims, { unsupported: 2, contradicted: 1, unknown: 0 });
});

test('requires independently quoted findings, keeps uncertainty, and binds the exact packet', () => {
  const input = sample();
  const review = reviewFor(input);
  assert.equal(scoreComplex(input, review).outcome, 'pass');
  assert.equal(scoreComplex(input, null).outcome, 'unknown');
  const unknown = reviewFor(input, { outcome: 'unknown', reason: '表述存在歧义。', findings: [
    { quote: '再继续推进', issue: 'unknown', reason: '次序是否有条件尚不清楚。' },
  ] });
  assert.equal(scoreComplex(input, unknown).outcome, 'unknown');
  assert.throws(() => scoreComplex(input, { ...review, extraClaims: { ...unknown.extraClaims, outcome: 'pass' } }), /invalid_extra_outcome/);
  unknown.extraClaims.findings[0].quote = '这个引文不在回答内。';
  assert.throws(() => scoreComplex(input, unknown), /invalid_extra_claims/);
  assert.throws(() => scoreComplex(input, { ...review, packetHash: '0'.repeat(64) }), /binding_mismatch/);
  input.protection.scopeViolations = 1;
  assert.equal(scoreComplex(input, reviewFor(input)).outcome, 'fail');
});
