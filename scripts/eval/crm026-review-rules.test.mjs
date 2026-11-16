import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { hasObservedValue, memoryReceipt, rescoreTask, REVIEW_VERSION, supplementalReview } from './crm026-review-rules.mjs';

test('assertions distinguish a real null from a missing field or a null parent', () => {
  const lead = { owner_user_id: null, consent: { marketing: { granted_at: null }, profiling: null } };
  assert(hasObservedValue(lead, 'owner_user_id', null));
  assert(hasObservedValue(lead, 'consent.marketing.granted_at', null));
  assert(!hasObservedValue(lead, 'assigned_at', null));
  assert(!hasObservedValue(lead, 'consent.profiling.granted_at', null));
  assert(!hasObservedValue(lead, 'consent.marketing.granted_at', 'null'));
  assert(!hasObservedValue(lead, 'constructor.name', 'Object'));
});

test('memory provider state and coverage are separate, including unavailable', () => {
  const confirmed = [{ category: 'preference', body: 'example', revision: 2 }];
  for (const status of ['local', 'mem0', 'local_fallback']) {
    const raw = { status, coverage: 'partial', source: 'crm_confirmed_facts', memories: [{}] };
    assert.deepEqual(memoryReceipt(raw, confirmed), { status, coverage: 'partial', source: raw.source, returnedCount: 1, confirmed });
  }
  assert.deepEqual(memoryReceipt({ status: 'unavailable', coverage: 'unavailable', memories: [] }),
    { status: 'unavailable', coverage: 'unavailable', returnedCount: 0, confirmed: [] });
  assert.deepEqual(memoryReceipt({ status: 'complete' }), {});
});

test('second anonymous identity may supplement legacy rows and binds all signed focus IDs', () => {
  const dataset = JSON.parse(readFileSync(new URL('../../docs/evaluation/CRM-025-cases.json', import.meta.url)));
  const caseSpec = dataset.cases[0];
  const id = '10000000-0000-0000-0000-000000000001';
  const scope = { leadId: '20000000-0000-0000-0000-000000000001', contactId: '30000000-0000-0000-0000-000000000001' };
  const run = { id, scope, run_kind: 'root', parent_run_id: null, mode: 'inspect', status: 'partial', final_text: '等待核对' };
  const input = { raw: { runId: id, caseId: caseSpec.id, category: 'settled', snapshot: { runs: [run], requests: [], tools: [] } },
    caseSpec, scope, materials: { pages: {} }, businessClock: dataset.businessClock,
    reviewId: '40000000-0000-0000-0000-000000000002' };
  const opinions = rules => rules.map(({ id }) => ({ id, verdict: 'unknown', reason: '档案未交付必要事实', quote: null, citations: [] }));
  const legacy = { reviewId: '40000000-0000-0000-0000-000000000001', reviewerType: 'agent',
    facts: opinions(caseSpec.oracle.requiredFacts),
    recommendations: opinions(caseSpec.oracle.acceptableRecommendations.map((_, index) => ({ id: `recommendation_${index + 1}` }))),
    forbidden: opinions(caseSpec.oracle.forbiddenConclusions.map((_, index) => ({ id: `forbidden_${index + 1}` }))),
    extraClaims: { outcome: 'pass', reason: '没有额外断言', findings: [] } };
  const prepared = supplementalReview(input, legacy);
  const signed = { version: REVIEW_VERSION, reviewId: input.reviewId, packetHash: prepared.packet.packetHash, reviewerType: 'agent',
    facts: legacy.facts.map(row => ({ ...row, verdict: 'fail' })), recommendations: legacy.recommendations, forbidden: legacy.forbidden, extraClaims: null };
  assert.equal(rescoreTask(input, prepared, signed).outcome, 'fail');
  assert.throws(() => rescoreTask(input, prepared, { ...signed, facts: [] }), /crm026_review_focus_mismatch/);
  assert.throws(() => rescoreTask({ ...input, reviewId: legacy.reviewId }, prepared, signed), /crm025_review_binding_mismatch/);
});
