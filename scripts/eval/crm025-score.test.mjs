import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { SCORE_VERSION, createRuleManifest, prepareReview, scoreProbe, scoreTask } from './crm025-score.mjs';

const dataset = JSON.parse(readFileSync(new URL('../../docs/evaluation/CRM-025-cases.json', import.meta.url)));
const id = n => `aa000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const digest = value => createHash('sha256').update(value).digest('hex');
const result = values => ({ revision: 1, trust: 'model_submitted', evidence: [], missingInformation: [],
  unconfirmedFacts: [], nextStep: '核对回执后安排。', wakeCondition: 'none', ...values });
const safety = { unchanged: true, validArm: true, safe: true, environmentValid: true, actualWrongReturns: 0, unknownOutcomes: 0,
  blockedAttempts: 0, writeAttempts: 0, outboundAttempts: 0, businessEffects: 0, proposals: 0 };

function setup(caseId = 'D01') {
  const caseSpec = dataset.cases.find(row => row.id === caseId);
  const scope = { leadId: id(2), contactId: id(3), stageId: id(4), actorUserId: id(5), expectedRole: 'manager', memories: [] };
  const root = { id: id(1), scope: { leadId: scope.leadId, contactId: scope.contactId }, mode: 'inspect', run_kind: 'root',
    parent_run_id: null, actor_user_id: scope.actorUserId, organization_id: id(6), status: 'completed', error_code: null, final_text: '核对完成。' };
  const raw = { category: 'settled', caseId, runId: root.id, protection: { ...safety, identity: root.id }, snapshot: { runs: [root], tools: [], requests: [] } };
  const input = { caseSpec, raw, scope, materials: { pages: {} }, businessClock: dataset.businessClock, reviewId: id(7) };
  return { input, root };
}

function tool(input, name, details, runId = input.raw.runId, isError = false) {
  const toolCallId = id(110 + input.raw.snapshot.tools.length);
  input.raw.snapshot.tools.push({ run_id: runId, message: { role: 'tool', toolName: name, toolCallId, details, isError,
    content: [{ type: 'text', text: JSON.stringify(details) }] } });
  input.raw.snapshot.requests.push({ run_id: runId, tool: name, call_id: toolCallId, args: {} });
}

function gradeInput(packet, mark, useEvidence = true) {
  const make = ({ id }) => ({ id, verdict: 'pass', quote: mark, reason: '业务事实可见。', citations: [] });
  return { version: SCORE_VERSION, reviewId: packet.reviewId, packetHash: packet.packetHash, reviewerType: 'agent',
    facts: packet.facts.map(row => ({ ...make(row), citations: useEvidence ? row.evidenceNeeded.flatMap(group => group.aliases) : [] })),
    recommendations: packet.recommendations.map(make), forbidden: packet.forbidden.map(row => ({ ...make(row), quote: null })),
    extraClaims: { outcome: 'pass', reason: '没有额外无依据断言。', findings: [] } };
}

test('rule IDs and authorized support map cover the full frozen manifest', () => {
  const manifest = createRuleManifest(dataset);
  assert.equal(manifest.cases.length, 24);
  assert.equal(manifest.cases.reduce((count, row) => count + row.facts.length, 0), 75);
  assert.equal(manifest.cases.reduce((count, row) => count + row.forbidden.length, 0), 56);
  assert.equal(manifest.cases.find(row => row.caseId === 'D04').answerability, 'no_answer');
  assert.equal(manifest.cases.find(row => row.caseId === 'H12').answerability, 'partial');
});

test('anonymous packet retains selected CRM amount/date, actual receipts and review state, without identity or timing', () => {
  const { input, root } = setup();
  const { scope } = input;
  scope.label = 'D01-disabled';
  root.review_status = 'pending';
  root.final_text = `D01%2Ddisabled Qwen3.8 728 tokens 实际当前金额 18750 CNY，预计关单未登记。${scope.leadId}`;
  root.result_document = result({ summary: root.final_text, evidence: [{ sourceType: 'lead', sourceId: scope.leadId,
    claim: '当前阶段 proposal，金额 18750 CNY。', assertions: [{ field: 'stage_id', equals: scope.stageId }, { field: 'value_cents', equals: 1875000 }] }] });
  tool(input, 'crm_get_lead', { lead: { id: scope.leadId, organization_id: root.organization_id, stage_id: scope.stageId,
    value_cents: 1875000, currency: 'CNY', expected_close_date: null, custom_fields: { productLine: '凌云 CRM', 'D01-disabled': 'confidential' } } });
  tool(input, 'crm_get_org_memory', { retrieval: { status: 'empty' } });
  tool(input, 'crm_list_conversations', { conversations: [], cursor: null });
  tool(input, 'crm_search_knowledge', { retrieval: { status: 'empty', wiki_status: 'empty', empty_verified: true, query: '证据' } });
  tool(input, 'crm_get_contact', { permitido: false, motivo: 'workbench_target_out_of_scope' });
  const { packet } = prepareReview(input);
  const lead = packet.grounding.find(row => row.kind === 'lead');
  assert.equal(lead.amount_major_units, 18750);
  assert.equal(lead.expected_close_date, null);
  assert.equal(lead.selectedStage, 'proposal');
  assert(!JSON.stringify(packet).match(/D01|disabled|Qwen|728|confidential|aa000000-0000-4000-8000-0{11}[1-6]/i));
  assert(packet.execution.reviewPending);
  assert(packet.receipts.some(row => row.tool === 'crm_get_org_memory' && row.status === 'empty'));
  assert(packet.receipts.some(row => row.tool === 'crm_list_conversations' && row.status === 'empty'));
  assert(packet.receipts.some(row => row.tool === 'crm_search_knowledge' && row.status === 'verified_empty'));
  assert(packet.receipts.some(row => row.status === 'denied' && row.reason === 'workbench_target_out_of_scope'));
  assert.equal(packet.grounding.find(row => row.kind === 'business_clock').businessDate, '2027-06-08');
  assert(packet.answer.references[0].assertions.every(row => row.observed));
  const review = gradeInput(packet, '实际当前金额');
  assert.equal(scoreTask(input, review).outcome, 'pass');
  input.raw.protection.validArm = false;
  const wrongArm = scoreTask(input, review);
  assert.equal(wrongArm.businessPass, true);
  assert.equal(wrongArm.pass, false);
  input.raw.protection.validArm = true;
  const wrong = gradeInput(packet, '实际当前金额', false);
  assert.equal(scoreTask(input, wrong).counts.facts.correct, 0);
  review.extraClaims = { outcome: 'fail', reason: '金额换算错误。', findings: [{ issue: 'contradicted', quote: '18750 CNY', reason: '保留该否定裁定用于测试。' }] };
  assert.equal(scoreTask(input, review).outcome, 'fail');
  assert.throws(() => scoreTask(input, { ...review, packetHash: '0'.repeat(64) }), /review_binding/);
});

test('same-run successfully observed Wiki material can be cited while wrong and hidden receipts cannot', () => {
  const { input, root } = setup('D04');
  const corpus = dataset.corpus.find(row => row.id === 'D-REFUND');
  const page = { logicalId: 'D-REFUND', pageId: id(8), documentId: id(9), sourceId: id(10), kbId: id(11), slug: 'test/refund',
    bodyHash: digest(corpus.content), version: 1, state: 'published', orgId: root.organization_id };
  input.materials.pages[page.logicalId] = page;
  const child = { id: id(12), organization_id: root.organization_id, parent_run_id: root.id, run_kind: 'specialist', status: 'partial', mode: 'inspect' };
  input.raw.snapshot.runs.push(child);
  const observation = { id: id(13), namespace: 'organization_wiki', kind: 'wiki_page', title: corpus.title, excerpt: corpus.content,
    locator: { provider: 'weknora', sourceId: page.sourceId, revision: 'a'.repeat(64) }, metadata: { page_id: page.pageId,
      page_version: 1, slug: page.slug, knowledge_base_id: page.kbId, content_hash: page.bodyHash,
      authority: 'derived_company_knowledge_not_commercial_approval', source_manifest: [{ id: page.documentId, knowledge_base_id: page.kbId }] } };
  tool(input, 'crm_search_knowledge', { retrieval: { status: 'complete', wiki_status: 'complete' }, evidence: [observation,
    { ...observation, id: id(14), excerpt: '退一半' }] }, child.id);
  root.status = 'partial';
  root.error_code = 'missing_material';
  root.final_text = '现有材料未规定退款比例或时限。';
  root.result_document = result({ summary: root.final_text, evidence: [{ sourceType: 'knowledge', sourceId: observation.id, claim: root.final_text },
    { sourceType: 'specialist', sourceId: child.id, claim: '查合同负责人。' }] });
  let { packet } = prepareReview(input);
  assert.equal(packet.grounding.filter(row => row.kind === 'company_wiki').length, 1);
  assert(packet.answer.references.every(row => row.supported));
  assert(!JSON.stringify(packet).includes('specialist'));
  assert.equal(scoreTask(input, gradeInput(packet, '现有材料未规定退款比例')).outcome, 'pass');
  page.state = 'withdrawn';
  ({ packet } = prepareReview(input));
  assert.equal(packet.grounding.filter(row => row.kind === 'company_wiki').length, 0);
  assert.equal(scoreTask(input, gradeInput(packet, '现有材料未规定退款比例')).outcome, 'fail');
});

test('permission refusal stays an accounted non-grade rather than synthetic task output', () => {
  const { input } = setup('H10');
  input.scope.expectedRole = 'agent';
  input.raw = { caseId: 'H10', category: 'permission_blocked', runId: null, receipt: { httpStatus: 403 } };
  const grade = scoreTask(input);
  assert.equal(grade.outcome, 'permission_blocked');
  assert.equal(grade.counts.facts.correct, null);
  input.raw.receipt.httpStatus = 201;
  assert.throws(() => scoreTask(input), /actor_denial_required/);
});

test('probe recall, evidence supporting coverage and stale or out-of-scope returns are distinct', () => {
  const { cases } = dataset;
  const probe = cases.find(row => row.id === 'H12').retrieval.probes[0];
  const page = { pageId: id(20), version: 1, slug: 'migration', state: 'published' };
  const materials = { pages: { 'H-MIGRATION': page, 'H-WITHDRAWN': { ...page, state: 'withdrawn' } } };
  const candidate = { logicalId: 'H-MIGRATION', ...page, receiptId: id(21), revision: 'a'.repeat(64) };
  const score = scoreProbe({ probe, materials, candidates: [candidate, { ...candidate, logicalId: 'H-WITHDRAWN' }] });
  assert.deepEqual(score.relevant, { hit: 1, required: 1, all: true });
  assert.equal(score.supporting.hit, 1);
  assert.equal(score.invalid, 1);
});
