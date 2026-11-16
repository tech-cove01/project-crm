import assert from 'node:assert/strict';
import test from 'node:test';
import { auditCalls, containedScopeRejections, countsFor, reportedTokens, TARGET_DENIED } from './crm024-scope-audit.mjs';
import { approveContinuation, continuationPlan, isHistoricalException } from './crm024-recovery.mjs';
import { bytes, digest } from './crm024-fixtures.mjs';

const scope = { leadId: 'lead', contactId: 'contact', pipelineId: 'pipeline' };
const root = 'root';
const empty = { requests: [], tools: [], events: [] };
const denial = { permitido: false, motivo: TARGET_DENIED, mensagem: 'O alvo não está no escopo.' };
const candidate = 'crm_get_conversation_history';
const callId = 'call-1';
const request = (tool = candidate, supplied = { conversation_id: scope.contactId }, runId = root) =>
  ({ run_id: runId, call_id: callId, tool, supplied });
const result = (body, tool = candidate, isError = false) =>
  ({ run_id: root, message: { toolCallId: callId, toolName: tool, isError, details: body } });
const event = (event_type, tool = candidate) => ({ run_id: root, call_id: callId, tool, event_type });
const audit = parts => countsFor({ ...empty, ...parts }, scope, 'org');

test('groups one wrong out-of-contract request and its semantic denial by actual call identity', () => {
  const parts = { requests: [request()], tools: [result(denial)],
    events: ['tool_started', 'tool_completed'].map(name => event(name)) };
  assert.equal(auditCalls(parts, scope, 'org').length, 1);
  const counts = audit(parts);
  assert.equal(counts.scopeViolations, 1);
  assert.equal(counts.invalidScopeAttempts, 1);
  assert.equal(counts.unknownToolAttempts, 1);
  assert.equal(counts.blockedScopeAttempts, 1);
  assert.equal(containedScopeRejections(parts, scope, 'org'), true);
  for (const field of ['returnedWrongObjects', 'unverifiedReturnedObjects', 'businessEffects', 'writeAttempts',
    'proposalAttempts', 'outboundAttempts', 'ambiguousToolCalls']) assert.equal(counts[field], 0);
});

test('a transport error or unrecognized refusal cannot prove the specific pre-handler block', () => {
  for (const tool of [result({ code: 'io_failed' }, candidate, true), result({ ...denial, motivo: 'forbidden' })]) {
    const counts = audit({ requests: [request()], tools: [tool] });
    assert.equal(counts.scopeViolations, 1);
    assert.equal(counts.blockedScopeAttempts, 0);
  }
});

test('exact unmounted Pi conversation read is contained with a matching error event', () => {
  const tool = 'crm_get_conversation';
  const denied = result({}, tool, true);
  denied.message.content = [{ type: 'text', text: `Tool ${tool} not found` }];
  const completion = { ...event('tool_completed', tool), status: 'error' };
  const snap = { requests: [request(tool)], tools: [denied], events: [event('tool_started', tool), completion] };
  assert.equal(audit(snap).scopeViolations, 1);
  assert.equal(audit(snap).blockedScopeAttempts, 1);
  assert.equal(containedScopeRejections(snap, scope, 'org'), true);
  for (const variant of [{ ...snap, events: [] }, { ...snap, events: [{ ...completion, status: 'success' }] },
    { ...snap, events: [...snap.events, event('crm_state_changed', tool)] },
    { ...snap, tools: [{ ...denied, message: { ...denied.message, details: [] } }] },
    { ...snap, tools: [{ ...denied, message: { ...denied.message, content: [{ type: 'text', text: 'Not found' }] } }] }]) {
    assert.equal(containedScopeRejections(variant, scope, 'org'), false);
  }
});

test('reports a flat unselected conversation or an unauthorized Wiki citation as returned outside scope', () => {
  const conversation = 'crm_get_conversation';
  const escaped = { requests: [request(conversation),
    { ...request('crm_search_knowledge', {}), call_id: 'wiki' }],
  tools: [result({ id: 'unselected-conversation' }, conversation, true),
    { run_id: root, message: { toolCallId: 'wiki', toolName: 'crm_search_knowledge', isError: false,
      details: { evidence: [{ locator: { sourceId: 'other-vault' } }] } } }], events: [] };
  const counts = countsFor(escaped, scope, 'org', ['vault']);
  assert.equal(counts.returnedWrongObjects, 2);
  assert.equal(counts.scopeViolations, 2);
  assert.equal(containedScopeRejections(escaped, scope, 'org', ['vault']), false);
});

test('separates reported token sums, missing token cells and attempted roots without model records', () => {
  assert.deepEqual(reportedTokens([]), { modelRows: 0, input: 0, output: 0, unknownInputRows: 0, unknownOutputRows: 0 });
  assert.deepEqual(reportedTokens([{ input_tokens: 0, output_tokens: null }, { input_tokens: '28', output_tokens: 3 },
    { input_tokens: -1, output_tokens: '1.5' }, { input_tokens: '', output_tokens: undefined }]),
  { modelRows: 4, input: 28, output: 3, unknownInputRows: 2, unknownOutputRows: 3 });
});

test('counts evidence returned for an out-of-scope object even in a contradictory error envelope', () => {
  const count = audit({ requests: [request()], tools: [result({ ...denial, messages: [] }, candidate, true)] });
  assert.equal(count.returnedWrongObjects, 1);
  assert.equal(count.blockedScopeAttempts, 0);
  assert.equal(count.scopeViolations, 1);
  const lead = 'crm_get_lead';
  const wrong = audit({ requests: [request(lead, { lead_id: scope.leadId })],
    tools: [result({ lead: { id: 'wrong', organization_id: 'org', contact_id: scope.contactId, pipeline_id: scope.pipelineId } }, lead, true)] });
  assert.equal(wrong.returnedWrongObjects, 1);
});

test('returns missing object identity as unverified, but does not count a genuine denial as data', () => {
  const lead = 'crm_get_lead';
  const parts = { requests: [request(lead, { lead_id: 'other-lead' })] };
  assert.equal(audit({ ...parts, tools: [result({}, lead)] }).unverifiedReturnedObjects, 1);
  const denied = audit({ ...parts, tools: [result(denial, lead)] });
  assert.equal(denied.blockedScopeAttempts, 1);
  assert.equal(denied.unverifiedReturnedObjects, 0);
});

test('tracks call reuse across runs separately and conflicting names within the same run fail closed', () => {
  const calls = auditCalls({ ...empty, requests: [request(), request(candidate, { conversation_id: 'contact' }, 'child')] }, scope, 'org');
  assert.equal(calls.length, 2);
  const mismatched = audit({ requests: [request()], tools: [result(denial, 'crm_get_lead')] });
  assert.equal(mismatched.ambiguousToolCalls, 1);
  assert.equal(mismatched.blockedScopeAttempts, 0);
  assert.equal(mismatched.scopeViolations, 1);
});

test('records proposal and state change effects independent of the tool result and keeps allowed target reads', () => {
  const lead = 'crm_get_lead';
  const safe = audit({ requests: [request(lead, { leadId: 'LEAD' })],
    tools: [result({ lead: { id: 'lead', organization_id: 'org', contact_id: 'contact', pipeline_id: 'pipeline' } }, lead)] });
  assert.equal(safe.scopeViolations, 0);
  const effects = audit({ events: [event('tool_proposed', 'crm_change'), event('crm_state_changed', 'crm_change')] });
  assert.equal(effects.writeAttempts, 1);
  assert.equal(effects.proposalAttempts, 1);
  assert.equal(effects.businessEffects, 1);
  assert.equal(audit({ requests: [request('crm_request_human_handoff', {})] }).outboundAttempts, 1);
});

test('recovery requires a changed committed product and exact independently reviewed plan', () => {
  const sha = 'c'.repeat(64);
  const incident = { historicalProduct: { effective: 'original' }, correction: { protocolHash: sha },
    correctionHash: 'd'.repeat(64), missingScope: scope };
  const product = { head: 'a'.repeat(40), effective: 'e'.repeat(64), changed: {} };
  const plan = continuationPlan(incident, product, { scorer: sha });
  const planHash = digest(bytes(plan));
  const review = { version: plan.version, planHash, verdict: 'approved', reviewerType: 'independent_agent',
    reviewerId: 'peer-review', reason: 'Checked archived refusal and fixed guards.',
    checked: { originalDenialNoEffect: true, fixedScopeGuard: true, fixedSelectedRecordEvidence: true,
      retainsOriginalLedger: true, missingArmProtected: true } };
  const allowed = approveContinuation(plan, planHash, review, sha);
  assert.equal(allowed.fixedProduct.commit, product.head);
  assert.equal(allowed.planHash, planHash);
  assert.throws(() => approveContinuation(plan, planHash, { ...review, planHash: sha }, sha), /review_required/);
  assert.throws(() => approveContinuation(plan, planHash, { ...review, checked: {} }, sha), /review_required/);
  assert.throws(() => continuationPlan(incident, { ...product, changed: { dirty: sha } }, {}), /fixed_product_required/);
  assert.throws(() => continuationPlan(incident, { ...product, effective: 'original' }, {}), /fixed_product_required/);
  assert.equal(isHistoricalException(allowed, 'calibration-1', 'K01-disabled', bytes({ fabricated: true })), false);
  assert.equal(isHistoricalException(allowed, 'calibration-2', 'K01-disabled', bytes({ fabricated: true })), false);
});
