import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inheritedRules, scoreReviewedTask } from './crm026-judge.mjs';

test('shared family rubric retains its criteria and child prohibition, rejecting invalid parents and cycles', () => {
  const base = { required: ['fact'], sources: { required: ['W1'] }, acceptable: ['answer'], criticalErrors: ['out-of-scope'], answerability: 'sufficient' };
  const cases = { A: base, B: { sameRuleAs: 'A', additionalCriticalErrors: ['distraction'] } };
  assert.deepEqual(inheritedRules(cases, 'B').required, ['fact']);
  assert.deepEqual(inheritedRules(cases, 'B').criticalErrors, ['out-of-scope', 'distraction']);
  assert.throws(() => inheritedRules({ X: { sameRuleAs: 'X' } }, 'X'), /inheritance_invalid/);
  assert.throws(() => inheritedRules({ X: { sameRuleAs: 'Y' } }, 'X'), /inheritance_invalid/);
});

test('a used search receipt supports justified lack of evidence without inventing a Wiki citation', () => {
  const base = { version: 'crm026-read-evidence-v2', reviewId: 'review', packetHash: 'hash' };
  const packet = { ...base, criteria: { required: [{ id: 'lack', support: 'receipt' }, { id: 'next', support: 'recommendation' }], answerability: 'no_answer' },
    observations: [], toolResults: [{ alias: 'T1', tool: 'crm_search_knowledge', sources: [], usedBySubsequentTurn: true }],
    answer: { finalText: '所搜资料无据。建议向维护者确认。', missingInformation: [], unconfirmedFacts: [],
      refs: [{ alias: 'E1', resolves: null, claim: '无据' }] } };
  const grade = { ...base, reviewerType: 'agent', reviewer: 'blind', reason: '符合留空规则', suggestionFits: true, correctAbstention: true,
    criticalErrors: [], facts: [
      { id: 'lack', verdict: 'pass', reason: '观察到已授权的检索回执', quote: '所搜资料无据', support: 'receipt', citations: ['T1'] },
      { id: 'next', verdict: 'pass', reason: '建议可执行', quote: '建议向维护者确认', support: 'recommendation', citations: [] },
    ] };
  assert.equal(scoreReviewedTask(packet, grade).taskPass, true);
  assert.equal(scoreReviewedTask(packet, { ...grade, correctAbstention: false }).taskPass, false);
  assert.throws(() => scoreReviewedTask(packet, { ...grade, facts: [
    { ...grade.facts[0], support: 'source', citations: ['E1'] }, grade.facts[1],
  ] }), /fact_invalid/);
  assert.throws(() => scoreReviewedTask({ ...packet, toolResults: [{ ...packet.toolResults[0], usedBySubsequentTurn: false }] }, grade), /fact_invalid/);
  assert.throws(() => scoreReviewedTask({ ...packet, toolResults: [{ ...packet.toolResults[0], tool: 'crm_get_org_memory' }] }, grade), /fact_invalid/);
  assert.throws(() => scoreReviewedTask({ ...packet, criteria: { required: [{ id: 'lack' }, { id: 'next' }] } }, grade), /fact_invalid/);
});
