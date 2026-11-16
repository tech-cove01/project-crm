import assert from 'node:assert/strict';
import test from 'node:test';
import { score, SCORE_VERSION } from './crm023-score.mjs';

const id = n => `4d2e8ca0-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [rootId, policyChild, contactChild, unrelatedRoot, leadId, contactId, receiptId, sourceId, pageId] =
  Array.from({ length: 9 }, (_, i) => id(i + 1));
const scope = { leadId, contactId, stageId: id(10) };
const rowHash = 'ab'.repeat(32);
const quote = '试用政策：支持人工上传 CSV 并映射字段。';
const wiki = [{ q: 'CSV', pages: [{ id: pageId, version: 3, content_hash: rowHash }] }, { q: '不存在的政策', pages: [] }];
const child = (id, extra = {}) => ({ id, parent_run_id: rootId, run_kind: 'specialist', status: 'completed', ...extra });
const typed = (sourceType, sourceId) => ({ sourceType, sourceId, claim: '合成事实' });
const root = (fields, sources, evidence, extra = {}) => ({ id: rootId, run_kind: 'root', status: 'completed',
  result_document: { evidence }, final_text: JSON.stringify({ fields, sources }), ...extra });
const tool = (toolName, value, opts = {}) => ({ run_id: opts.runId ?? rootId, query: opts.query,
  message: { role: 'tool', toolName, content: JSON.stringify(value), isError: opts.error ?? false } });
const readContact = (name, opts) => tool('crm_get_contact', { id: contactId, name }, opts);
const policyEvidence = (extra = {}) => ({ id: receiptId, locator: { provider: 'weknora', sourceId },
  metadata: { page_id: pageId, page_version: 3, content_hash: rowHash }, excerpt: quote, ...extra });
const findPolicy = (entry = policyEvidence(), opts = {}) => tool('crm_search_knowledge', {
  evidence: [entry], trechos: [], retrieval: { status: 'complete', wiki_status: 'complete' },
}, { query: 'CSV', ...opts });
const readEmpty = (wikiStatus = 'empty', extra = {}) => tool('crm_search_knowledge', {
  evidence: [], trechos: [], retrieval: { status: 'empty', wiki_status: wikiStatus }, ...extra,
}, { query: '不存在的政策' });
const run = (item, answer, children, tools) => score(item, scope, answer, children, tools, wiki, sourceId);

test('scores literal direct CRM fields and recognized columns', () => {
  const item = { id: 'holdout', fields: ['currency', 'contact_name', 'current_case'],
    expected: { currency: 'CNY', contact_name: '竹里', current_case: 'open' },
    crm: { current_case: { sourceType: 'lead', field: 'status' } } };
  const answer = root({ currency: 'CNY', contact_name: '竹里', current_case: 'open' },
    { currency: leadId, contact_name: contactId, current_case: leadId }, [typed('lead', leadId), typed('contact', contactId)]);
  const result = run(item, answer, [], [tool('crm_get_lead', { lead: { id: leadId, status: 'open', currency: 'CNY' } }), readContact('竹里')]);
  assert.equal(result.version, SCORE_VERSION);
  assert.equal(result.pass, true);
  assert.deepEqual(result.counts, { correct: 3, required: 3, supported: 3, cited: 3, requiredCitations: 3 });
});

test('accepts both typed child knowledge UUID and the typed child run UUID from a successful same-root specialist', () => {
  const item = { id: 'positive', fields: ['policy_excerpt'], policy: {
    policy_excerpt: { query: 'CSV', anchor: '人工上传 CSV', expect: 'excerpt' },
  } };
  for (const [type, citation] of [['knowledge', receiptId], ['specialist', policyChild]]) {
    const answer = root({ policy_excerpt: quote }, { policy_excerpt: citation }, [typed(type, citation)]);
    assert.equal(run(item, answer, [child(policyChild)], [findPolicy(policyEvidence(), { runId: policyChild })]).pass, true);
  }
  const answer = root({ policy_excerpt: quote }, { policy_excerpt: receiptId }, [typed('knowledge', receiptId)]);
  assert.equal(run(item, answer, [], [findPolicy()]).pass, true);
});

test('rejects wrong observation values, failed tools and non-complete or foreign specialist rows', () => {
  const item = { id: 'contact', fields: ['contact_name'], expected: { contact_name: '竹里' } };
  const answer = root({ contact_name: '竹里' }, { contact_name: contactChild }, [typed('specialist', contactChild)]);
  const checks = [
    { child: child(contactChild), read: readContact('旧名', { runId: contactChild }) },
    { child: child(contactChild), read: readContact('竹里', { runId: contactChild, error: true }) },
    { child: child(contactChild, { parent_run_id: unrelatedRoot }), read: readContact('竹里', { runId: contactChild }) },
    { child: child(contactChild, { status: 'partial' }), read: readContact('竹里', { runId: contactChild }) },
    { child: child(contactChild, { status: 'failed' }), read: readContact('竹里', { runId: contactChild }) },
  ];
  for (const entry of checks) assert.equal(run(item, answer, [entry.child], [entry.read]).pass, false);
  assert.equal(run(item, answer, [child(contactChild)], [readContact('竹里', { runId: contactChild })]).pass, true);
});

test('rejects wrong citation type, unrelated query, unfrozen page and provider mismatch', () => {
  const item = { id: 'policy', fields: ['policy_excerpt'], policy: {
    policy_excerpt: { query: 'CSV', anchor: '人工上传 CSV', expect: 'excerpt' },
  } };
  const answer = root({ policy_excerpt: quote }, { policy_excerpt: receiptId }, [typed('knowledge', receiptId)]);
  const sameRoot = [child(policyChild)];
  for (const entry of [
    findPolicy(policyEvidence(), { runId: policyChild, query: 'other' }),
    findPolicy(policyEvidence({ locator: { provider: 'local_pgvector', sourceId } }), { runId: policyChild }),
    findPolicy(policyEvidence({ locator: { provider: 'weknora', sourceId: id(22) } }), { runId: policyChild }),
    findPolicy(policyEvidence({ metadata: { page_id: pageId, page_version: 2, content_hash: rowHash } }), { runId: policyChild }),
    findPolicy(policyEvidence({ id: id(23) }), { runId: policyChild }),
  ]) assert.equal(run(item, answer, sameRoot, [entry]).pass, false);
  const wrongKind = { ...answer, result_document: { evidence: [typed('specialist', receiptId)] } };
  assert.equal(run(item, wrongKind, sameRoot, [findPolicy(policyEvidence(), { runId: policyChild })]).pass, false);
  assert.equal(run(item, answer, [child(policyChild, { parent_run_id: unrelatedRoot })], [findPolicy(policyEvidence(), { runId: policyChild })]).pass, false);
});

test('separates strict formatting from content and support under the same frozen oracle', () => {
  const item = { id: 'format', fields: ['contact_name'], expected: { contact_name: '名💡 } { "字"' } };
  const answer = root({ contact_name: item.expected.contact_name }, { contact_name: contactId }, [typed('contact', contactId)]);
  const withTail = { ...answer, final_text: `\`\`\`JSON\n${answer.final_text}\n\`\`\`\n补充说明` };
  const result = run(item, withTail, [], [readContact(item.expected.contact_name)]);
  assert.equal(result.shape, false);
  assert.equal(result.contentPass, true);
  assert.equal(result.citationPass, true);
  assert.equal(result.pass, false);
  assert.equal(result.classification, 'format_noncompliant');
  assert.equal(result.diagnostics.recoveredLeadingObject, true);
  assert.equal(result.counts.correct, 1);
  const before = { ...answer, final_text: `先补充说明\n${answer.final_text}` };
  assert.equal(run(item, before, [], [readContact(item.expected.contact_name)]).diagnostics.contentShape, false);
});

test('accepts a verified null policy only for healthy empty retrieval and a permitted terminal state', () => {
  const item = { id: 'empty', fields: ['policy_excerpt'], allowPartial: true, policy: {
    policy_excerpt: { query: '不存在的政策', expect: 'empty' },
  } };
  const answer = root({ policy_excerpt: null }, { policy_excerpt: null }, [], { status: 'partial', error_code: 'missing_material' });
  const actual = run(item, answer, [], [readEmpty()]);
  assert.equal(actual.pass, true);
  assert.equal(actual.reasonableLimit, true);
  assert.equal(actual.classification, 'reasonable_limitation');
  assert.deepEqual(actual.counts, { correct: 1, required: 1, supported: 0, cited: 0, requiredCitations: 0 });
  const unavailable = run(item, answer, [], [readEmpty('unavailable')]);
  assert.equal(unavailable.classification, 'retrieval_unavailable');
  assert.equal(unavailable.pass, false);
  const laterUnavailable = run(item, answer, [], [readEmpty(), readEmpty('unavailable')]);
  assert.equal(laterUnavailable.reasonableLimit, false);
  assert.equal(laterUnavailable.classification, 'retrieval_unavailable');
  assert.equal(laterUnavailable.pass, false);
  const incomplete = readEmpty('empty', { retrieval: { status: 'empty', wiki_status: 'empty', missing: ['published_knowledge_sources'] } });
  assert.equal(run(item, answer, [], [incomplete]).pass, false);
  assert.equal(run(item, answer, [], [readEmpty(), incomplete]).pass, false);
  assert.equal(run(item, answer, [], []).pass, false);
  assert.equal(run(item, answer, [], [readEmpty(), readEmpty('complete', { evidence: [policyEvidence()] })]).pass, false);
  assert.equal(run({ ...item, allowPartial: false }, answer, [], [readEmpty()]).pass, false);
  assert.equal(run(item, { ...answer, error_code: 'collaboration_review_required' }, [], [readEmpty()]).classification, 'review_required');
  const fabricated = root({ policy_excerpt: null }, { policy_excerpt: receiptId }, [typed('knowledge', receiptId)]);
  assert.equal(run(item, fabricated, [], [readEmpty()]).pass, false);
});

test('rejects a fabricated structured knowledge citation even with null in the summary sources', () => {
  const item = { id: 'empty', fields: ['policy_excerpt'], policy: {
    policy_excerpt: { query: '不存在的政策', expect: 'empty' },
  } };
  const answer = root({ policy_excerpt: null }, { policy_excerpt: null }, [typed('knowledge', receiptId)]);
  const rejected = run(item, answer, [], [readEmpty()]);
  assert.equal(rejected.shape, true);
  assert.equal(rejected.contentPass, true);
  assert.equal(rejected.citationPass, false);
  assert.equal(rejected.reasonableLimit, false);
  assert.equal(rejected.pass, false);
  assert.deepEqual(rejected.diagnostics.unsupportedTypedEvidence,
    [{ index: 0, sourceType: 'knowledge', sourceId: receiptId, reason: 'typed_source_unobserved' }]);
  assert.equal(run(item, answer, [child(policyChild, { parent_run_id: unrelatedRoot })],
    [readEmpty(), findPolicy(policyEvidence(), { runId: policyChild })]).pass, false);
  const valid = run(item, answer, [child(policyChild)], [readEmpty(), findPolicy(policyEvidence(), { runId: policyChild })]);
  assert.equal(valid.pass, true);
  assert.deepEqual(valid.diagnostics.unsupportedTypedEvidence, []);
});

test('extra CRM and specialist typed citations need scoped successful observations too', () => {
  const item = { id: 'typed', fields: ['contact_name'], expected: { contact_name: '竹里' } };
  const fields = { contact_name: '竹里' }, sources = { contact_name: contactId };
  const direct = readContact('竹里');
  const lead = tool('crm_get_lead', { lead: { id: leadId, stage_id: scope.stageId } });
  const evidence = [typed('contact', contactId), typed('lead', leadId), typed('specialist', contactChild)];
  const answer = root(fields, sources, evidence);
  const specialistRead = readContact('竹里', { runId: contactChild });
  const supported = run(item, answer, [child(contactChild)], [direct, lead, specialistRead]);
  assert.equal(supported.pass, true);
  assert.deepEqual(supported.diagnostics.unsupportedTypedEvidence, []);
  const unsupported = run(item, answer, [child(contactChild)], [direct]);
  assert.equal(unsupported.counts.supported, 1);
  assert.equal(unsupported.citationPass, false);
  assert.deepEqual(unsupported.diagnostics.unsupportedTypedEvidence.map(entry => entry.sourceType), ['lead', 'specialist']);
  const wrongScope = tool('crm_get_lead', { lead: { id: id(42) } });
  assert.equal(run(item, answer, [child(contactChild)], [direct, wrongScope, specialistRead]).pass, false);
});

test('a nullable CRM field still needs a successful observation that explicitly contains null', () => {
  const item = { id: 'null-date', fields: ['expected_close_date'], expected: { expected_close_date: null } };
  const answer = root({ expected_close_date: null }, { expected_close_date: leadId }, [typed('lead', leadId)]);
  assert.equal(run(item, answer, [], [tool('crm_get_lead', { lead: { id: leadId } })]).pass, false);
  const explicitNull = run(item, answer, [], [tool('crm_get_lead', { lead: { id: leadId, expected_close_date: null } })]);
  assert.equal(explicitNull.pass, true);
  assert.equal(explicitNull.reasonableLimit, true);
  assert.equal(explicitNull.counts.supported, 1);
});
