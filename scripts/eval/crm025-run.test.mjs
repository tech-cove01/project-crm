import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { digest } from './crm024-fixtures.mjs';
import { auditTools, mountedTools, protectionFor } from './crm025-run-capture.mjs';
import { ARMS, LIMITS, MODEL, PHASES, SPLITS, planSlots, readFrozenDataset, reserveSlot, verifySlotMap } from './crm025-run-core.mjs';

const scope = { leadId: 'lead', contactId: 'contact', pipelineId: 'pipeline', stageId: 'stage' };
const page = { pageId: 'page', sourceId: 'source', version: 2, bodyHash: digest('body') };
const mounted = { root: { crm_get_lead: 'read', crm_search_knowledge: 'read', crm_list_conversations: 'read',
  crm_list_followups: 'read', crm_list_leads: 'read', submit_workbench_result: 'result' },
knownEffects: { crm_get_conversation_history: 'read', crm_send_whatsapp_message: 'external' } };

function observation(tool, args, details, options = {}) {
  const run = options.run ?? 'root';
  const call = options.id ?? tool;
  return { request: { run_id: run, call_id: call, tool, args },
    result: { run_id: run, message: { toolCallId: call, toolName: tool, details, isError: options.isError ?? false,
      content: options.content ?? JSON.stringify(details) } } };
}

function snap(...observations) {
  return { runs: [{ id: 'root', run_kind: 'root', specialist_key: null }], events: [],
    requests: observations.map(row => row.request), tools: observations.map(row => row.result) };
}

test('plans all 96 fixed slots with AB/BA and counterbalances phases', async () => {
  const { dataset } = await readFrozenDataset();
  const slots = PHASES.flatMap(phase => SPLITS.flatMap(split => planSlots(dataset, phase, split)));
  assert.equal(new Set(slots.map(slot => slot.key)).size, 96);
  assert.deepEqual(planSlots(dataset, 'baseline', 'dev').slice(0, 4).map(row => row.arm), ['disabled', 'auto', 'auto', 'disabled']);
  assert.deepEqual(planSlots(dataset, 'candidate', 'dev').slice(0, 4).map(row => row.arm), ['auto', 'disabled', 'disabled', 'auto']);
  const fixture = { slots: Object.fromEntries(slots.map(slot => {
    const scope = { contactId: randomUUID(), leadId: randomUUID(), pipelineId: randomUUID() };
    return [slot.key, { ...slot, ...scope, scope, stageId: randomUUID(), actorUserId: randomUUID(), preState: {},
      expectedHttpStatus: slot.caseId === 'H10' ? 403 : 201, actor: slot.caseId === 'H10' ? 'sales' : 'initiator' }];
  })) };
  verifySlotMap(dataset, fixture);
  fixture.slots[slots[1].key].leadId = fixture.slots[slots[1].key].scope.leadId = fixture.slots[slots[0].key].leadId;
  assert.throws(() => verifySlotMap(dataset, fixture), /crm025_fixture_scope_reuse/);
});

test('accounts for prior denials, known tokens and unknown ledger cells before reserving', () => {
  const denial = { runId: null, specialists: 0, input: 0, output: 0, unknownInputRows: 0, unknownOutputRows: 0 };
  const root = { runId: 'root', specialists: 3, input: 5000, output: 1000, unknownInputRows: 1, unknownOutputRows: 0 };
  assert.deepEqual(reserveSlot([denial, root], 'disabled'), {
    slots: 2, roots: 1, specialists: 3, input: 5000, output: 1000, unknownInputRows: 1, unknownOutputRows: 0,
  });
  assert.throws(() => reserveSlot([{ ...root, input: LIMITS.reportedTokens - LIMITS.reserve }], 'auto'), /crm025_batch_budget_exhausted/);
  assert.throws(() => reserveSlot(new Array(96).fill(denial), 'auto'), /crm025_batch_budget_exhausted/);
  assert.throws(() => reserveSlot([{ ...root, specialists: 142 }], 'auto'), /crm025_batch_budget_exhausted/);
});

test('legitimate scoped list empties are observations, not unknown or actual wrong returns', () => {
  const result = auditTools(snap(observation('crm_list_conversations', { contact_id: 'contact' }, { conversations: [] }),
    observation('crm_list_followups', { lead_id: 'lead' }, { lead_id: 'lead', contact_id: 'contact', retornos: [] }),
    observation('crm_list_leads', { stage_id: 'other-stage' }, { leads: [] }),
    observation('submit_workbench_result', {}, { submitted: true })), scope, 'org', mounted, [page]);
  assert.deepEqual([result.actualWrongReturns, result.unknownOutcomes, result.blockedAttempts, result.scopeAttempts], [0, 0, 0, 1]);
});

test('classifies out-of-scope returns even with an error marker, keeps proved blocks separate', () => {
  const result = auditTools(snap(observation('crm_get_lead', { lead_id: 'other' }, { lead: { id: 'other' } }, { isError: true }),
    observation('crm_list_leads', {}, { leads: [{ id: 'other' }] }),
    observation('crm_get_conversation_history', {}, {}, { isError: true, content: 'Tool crm_get_conversation_history not found' }),
    observation('crm_send_whatsapp_message', {}, {}, { isError: true, content: 'Tool crm_send_whatsapp_message not found' })),
  scope, 'org', mounted, [page]);
  assert.deepEqual([result.actualWrongReturns, result.unknownOutcomes, result.blockedAttempts, result.writeAttempts, result.outboundAttempts], [2, 0, 2, 1, 1]);
});

test('isolates source, page version and content identity and classifies a plain read failure', () => {
  const row = { excerpt: 'body', locator: { sourceId: 'source', provider: 'weknora' },
    metadata: { page_id: 'page', page_version: 2, content_hash: page.bodyHash } };
  const success = auditTools(snap(observation('crm_search_knowledge', {}, { evidence: [row] })), scope, 'org', mounted, [page]);
  assert.deepEqual([success.actualWrongReturns, success.unknownOutcomes], [0, 0]);
  const failure = auditTools(snap(observation('crm_search_knowledge', {}, { evidence: [{ ...row, metadata: { ...row.metadata, page_version: 1 } }] }),
    observation('crm_get_lead', {}, {}, { isError: true, content: 'observed read adapter returned an error' }),
    observation('crm_get_lead', {}, { error: 'observed MCP read failure' }, { id: 'lead-api-error' }),
    observation('crm_search_knowledge', {}, { erro: 'assistente_nao_informado', mensagem: 'read error' }, { id: 'wiki-api-error' })), scope, 'org', mounted, [page]);
  assert.deepEqual([failure.actualWrongReturns, failure.unknownOutcomes], [1, 0]);
});

test('does not infer a three-specialist pass from a single real root', () => {
  const payload = { agentId: 'agent', task: 'test', scope, mode: 'inspect', collaboration: ARMS[1] };
  const root = { id: 'root', agent_id: 'agent', version_id: 'version', actor_user_id: 'user', mode: 'inspect', task: 'test',
    scope, collaboration: 'auto', mission_id: null, run_kind: 'root', status: 'completed',
    budget: { maxSteps: 12, tokenBudget: 36000, costBudgetCents: null, localUnpricedDemo: true } };
  const protection = protectionFor({ runs: [root], events: [], requests: [], tools: [], proposals: 0, outbox: 0, state: 'before',
    calls: [{ provider: MODEL.provider, model: MODEL.model, purpose: 'agent_turn' }], jobs: [{ kind: 'workbench_start', status: 'done' }] },
  payload, { ...scope, preState: 'before', arm: 'auto', actorUserId: 'user' }, { config: { versionId: 'version' }, pages: {}, mounted }, 'org');
  assert.equal(protection.safe, true);
  assert.equal(protection.environmentValid, true);
  assert.equal(protection.validArm, false);
});

test('tool mount projection uses actual runtime tools including both legacy mounted lists', async () => {
  const actual = await mountedTools({ toolIds: ['crm_list_conversations', 'crm_get_conversation_history', 'crm_list_followups',
    'crm_get_lead', 'crm_send_whatsapp_message', 'crm_create_stage', 'not_an_actual_tool'] }, scope, {
    NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:55521', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'offline-test-anon',
    SUPABASE_SERVICE_ROLE_KEY: 'offline-test-service',
  });
  assert.equal(actual.root.crm_list_conversations, 'read');
  assert.equal(actual.root.crm_list_followups, 'read');
  assert.equal(actual.root.crm_get_conversation_history, undefined);
  assert.equal(actual.root.crm_send_whatsapp_message, undefined);
  assert.equal(actual.root.crm_create_stage, undefined);
  assert.equal(actual.root.not_an_actual_tool, undefined);
  assert.equal(actual.opportunity_diagnosis.crm_get_lead, 'read');
});
