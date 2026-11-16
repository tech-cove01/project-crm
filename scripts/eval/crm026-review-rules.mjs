/** Offline overlay on the byte-frozen CRM-025 scorer. */
import assert from 'node:assert/strict';
import { isDeepStrictEqual as same } from 'node:util';
import { digest } from './crm024-fixtures.mjs';
import { toolBody } from './crm024-scope-audit.mjs';
import { prepareReview, SCORE_VERSION, scoreTask } from './crm025-score.mjs';

export const REVIEW_VERSION = 'crm025-business-evidence-v2';
const hash = value => digest(JSON.stringify(value));
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const word = value => typeof value === 'string' && value.trim().length > 0;
const addedLeadFields = ['owner_user_id', 'owner_user_name', 'owner_agent_id', 'assigned_at', 'tags', 'stage', 'stage_id',
  'value_display', 'created_at', 'updated_at'];
const leadFields = [...addedLeadFields,
  'title', 'description', 'status', 'value_cents', 'currency', 'expected_close_date', 'closed_at',
  'last_activity_at'];
const contactFields = ['name', 'display_name', 'email', 'phone', 'tags', 'source', 'consent', 'created_at',
  'last_activity_at', 'is_blocked', 'is_anonymized', 'cpf_available'];
const fieldTerms = /owner(?:_user_(?:id|name))?|assigned_at|owner_agent_id|e-?mail|phone|telephone|tags?|consent|marketing|profiling|transactional|cpf|value_display|负责人|所有者|归属|分配|指派|邮件地址|邮箱|电话|手机号|标签|同意|授权联系|画像|沟通许可|客户来源/iu;
const contactStatuses = new Set(['local', 'mem0', 'local_fallback', 'unavailable']);
const contactCoverages = new Set(['complete', 'partial', 'unavailable']);

function ownFields(value, keys) {
  return Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
}

export function memoryReceipt(memory, confirmed = []) {
  const result = {};
  if (!record(memory)) return result;
  if (contactStatuses.has(memory.status)) result.status = memory.status;
  if (contactCoverages.has(memory.coverage)) result.coverage = memory.coverage;
  if (memory.source === 'crm_confirmed_facts') result.source = memory.source;
  if (Array.isArray(memory.memories)) {
    result.returnedCount = memory.memories.length;
    result.confirmed = confirmed;
  }
  return result;
}

function matchedReads({ raw, scope }, root, includeMetadata = false) {
  const { runs, requests, tools } = raw.snapshot;
  const owners = new Set([root.id, ...runs.filter(row => row.organization_id === root.organization_id &&
    row.parent_run_id === root.id && row.run_kind === 'specialist' && row.mode === 'inspect' &&
    ['completed', 'partial'].includes(row.status)).map(row => row.id)]);
  return tools.flatMap(({ run_id: runId, message }) => {
    const tool = message?.toolName;
    if (!owners.has(runId) || message?.role !== 'tool' || message.isError === true ||
        !['crm_get_lead', 'crm_get_contact'].includes(tool) ||
        requests.filter(row => row.run_id === runId && row.call_id === message.toolCallId && row.tool === tool).length !== 1)
      return [];
    const body = toolBody(message);
    const text = typeof message.content === 'string' ? message.content : Array.isArray(message.content)
      ? message.content.filter(item => item?.type === 'text').map(item => item.text).join('\n') : '';
    if (!record(body) || body.permitido === false || body.ok === false || body.isError === true ||
        body.error != null || body.erro != null || record(message.details) && text.startsWith('{') && !same(body, message.details))
      return [];
    if (tool === 'crm_get_lead' && body.lead?.id === scope.leadId && body.lead.organization_id === root.organization_id &&
        body.lead.contact_id === scope.contactId && body.lead.pipeline_id === root.scope.pipelineId) {
      const fields = ownFields(body.lead, includeMetadata ? [...leadFields, ...metadataFields] : leadFields);
      if (includeMetadata && Object.hasOwn(body.lead, 'source_metadata'))
        fields.source_metadata = record(body.lead.source_metadata) ? ownFields(body.lead.source_metadata, ['synthetic']) : body.lead.source_metadata;
      return [{ kind: 'lead', runId, fields }];
    }
    if (tool === 'crm_get_contact' && body.id === scope.contactId && (!body.organization_id || body.organization_id === root.organization_id)) {
      const memory = body.confirmed_customer_memory;
      const confirmed = memory?.source === 'crm_confirmed_facts' && contactStatuses.has(memory.status) &&
        Array.isArray(memory.memories) ? memory.memories.filter(row => row?.confirmed === true &&
          row.authority === 'customer_context_only' && word(row.body) && scope.memories?.some(frozen =>
            frozen.id === row.id && frozen.revision === row.revision && frozen.bodyHash === digest(row.body)))
          .map(({ body, category, revision }) => ({ body, category, revision })) : [];
      const fields = ownFields(body, contactFields);
      if (Object.hasOwn(body, 'confirmed_customer_memory')) {
        fields.confirmed_customer_memory = record(memory) ? memoryReceipt(memory, confirmed) : memory;
      }
      return [{ kind: 'contact', runId, fields }];
    }
    return [];
  });
}

function fieldMask(scope, grounding) {
  const aliases = new Map();
  if (word(scope.stageId)) aliases.set(scope.stageId.toLowerCase(), '阶段');
  for (const kind of ['lead', 'contact']) {
    const row = grounding.find(entry => entry.kind === kind);
    if (row && word(scope[`${kind}Id`])) aliases.set(scope[`${kind}Id`].toLowerCase(), row.alias);
  }
  const privateValues = [scope.label, ...(scope.blindTokens ?? [])].filter(word);
  const mask = value => {
    if (typeof value === 'string') return privateValues.reduce((text, token) => text.replaceAll(token, '[标识]'), value)
      .replace(/(?:https?:\/\/[^\s<>"']+|\/api\/v\d+\/[^\s<>"']+)/gi, '[链接]')
      .replace(/\b[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\b/gi, id => {
        const key = id.toLowerCase();
        if (!aliases.has(key)) aliases.set(key, `对象 ${aliases.size + 1}`);
        return `[${aliases.get(key)}]`;
      })
      .replace(/\b(?:[a-f0-9]{64}|[a-f0-9]{40}|[a-f0-9]{32})\b/gi, '[标识]')
      .replace(/\bCRM[ ._/-]*025[ ._:/-]+(?:D0[1-8]|H(?:0[1-9]|1[0-6]))(?:[ ._:/-]*(?:single|auto|disabled|baseline|candidate))?\b/gi, '[场景]');
    if (Array.isArray(value)) return value.map(mask);
    if (record(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mask(item)]));
    return value;
  };
  return mask;
}

export function hasObservedValue(fields, path, expected) {
  if (typeof path !== 'string' || !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/i.test(path) ||
      (expected !== null && !['string', 'number', 'boolean'].includes(typeof expected))) return false;
  let value = fields;
  for (const field of path.split('.')) {
    if (!record(value) || !Object.hasOwn(value, field)) return false;
    value = value[field];
  }
  return same(value, expected);
}

export function supplementalReview(input, previous) {
  const { packet: original } = prepareReview(input);
  const root = input.raw.snapshot.runs.find(row => row.id === input.raw.runId);
  const actual = matchedReads(input, root);
  const mask = fieldMask(input.scope, original.grounding);
  const receipts = [];
  for (const kind of ['lead', 'contact']) {
    const aliases = original.grounding.filter(row => row.kind === kind).map(row => row.alias);
    if (!aliases.length) continue;
    for (const { fields } of actual.filter(row => row.kind === kind)) {
      const entry = { kind, aliases, fields: mask(kind === 'lead' ? ownFields(fields, addedLeadFields) : fields) };
      if (!receipts.some(row => same(row, entry))) receipts.push(entry);
    }
  }
  const references = original.answer.references.map((reference, index) => {
    const rawReference = root.result_document.evidence[index];
    const { sourceType, sourceId } = rawReference ?? {};
    if (!reference.supported) return reference;
    const observations = actual.filter(row => sourceType === 'specialist'
      ? row.runId !== root.id && row.runId === sourceId
      : row.runId === root.id && row.kind === sourceType && sourceId === input.scope[`${row.kind}Id`]);
    const assertions = reference.assertions.map((assertion, position) => {
      const raw = rawReference.assertions[position];
      return assertion.observed || !record(raw) || !Object.hasOwn(raw, 'equals') ? assertion :
        { ...assertion, observed: observations.some(row => hasObservedValue(row.fields, raw.field, raw.equals)) };
    });
    return { ...reference, assertions };
  });
  const { packetHash: _packetHash, ...body } = original;
  const related = addedFieldInAnswer(body.answer) && receipts.length > 0;
  const focus = Object.fromEntries(['facts', 'recommendations', 'forbidden'].map(section => [section,
    body[section].filter(rule => previous[section].find(row => row.id === rule.id)?.verdict === 'unknown' ||
      related && fieldTerms.test(rule.description)).map(rule => rule.id)]));
  focus.extraClaims = related || previous.extraClaims.findings.some(row => row.issue === 'unknown');
  const payload = { ...body, version: REVIEW_VERSION, answer: { ...body.answer, references }, supplementalReceipts: receipts, focus,
    instructions: [...body.instructions,
      '以补充回执呈现的原始字段为准。明确的 null 与没有返回字段有区别；确认状态和完整程度分开。',
      '若完整记录足以确认没有交付必要事实或明确下一步，判该项 fail，即使答复诚实表示待复核。若本题要求合理留空，按原业务标准。',
      '仅在判定依赖确实缺失或无法验证的原始记录时标 unknown。写明缺失证据；无依据但已明示的额外断言按 unsupported/contradicted。',
    ] };
  return { packet: { ...payload, packetHash: hash(payload) }, original, previous };
}

function addedFieldInAnswer(answer) {
  const surfaces = [answer.finalText, answer.summary, answer.nextStep, ...answer.missingInformation, ...answer.unconfirmedFacts,
    ...answer.references.flatMap(row => [row.claim, ...row.assertions.map(item => item.field)])];
  return surfaces.some(value => typeof value === 'string' && fieldTerms.test(value));
}

export function reviewTriggers(prepared, oldScore) {
  const { packet, original, previous } = prepared;
  const triggers = [];
  if (!same(packet.answer.references, original.answer.references)) triggers.push('reference_field_recomputed');
  const needsJudgment = [...previous.facts, ...previous.recommendations, ...previous.forbidden].some(row => row.verdict === 'unknown') ||
    previous.extraClaims.findings.some(item => item.issue === 'unknown') || oldScore.outcome === 'unknown';
  if (needsJudgment) triggers.push('prior_unknown');
  if (packet.supplementalReceipts.length && addedFieldInAnswer(packet.answer))
    triggers.push('answer_reads_added_field');
  return triggers;
}

const metadataFields = ['source', 'owner_kind', 'lost_reason', 'stage_changed_at', 'position_in_stage'];
export const metadataClaim = /(?:source_metadata|owner_kind|lost_reason|stage_changed_at|position_in_stage|\bsource\s*[:=]|\bauthority\b|派生(?:的)?公司知识|合成标记|商机来源|商机元数据)/iu;

export function metadataAddendum(input, prepared, preliminary, legacy) {
  const { packet } = prepared;
  const removed = legacy.extraClaims.findings.filter(row => row.issue !== 'unknown' &&
    !preliminary.extraClaims.findings.some(item => item.quote === row.quote && item.issue !== 'unknown'));
  const changedToPass = preliminary.outcome === 'pass' && removed.length > 0;
  const discord = [...legacy.extraClaims.findings, ...preliminary.extraClaims.findings].filter(item => metadataClaim.test(item.quote));
  if (!changedToPass && !discord.length) return null;
  const root = input.raw.snapshot.runs.find(row => row.id === input.raw.runId);
  const mask = fieldMask(input.scope, packet.grounding);
  const leadAliases = packet.grounding.filter(row => row.kind === 'lead').map(row => row.alias);
  const observations = matchedReads(input, root, true).filter(row => row.kind === 'lead' && leadAliases.length > 0);
  const receipts = [];
  for (const row of observations) {
    const receipt = { aliases: leadAliases, fields: mask(ownFields(row.fields, [...metadataFields, 'source_metadata'])) };
    if (!receipts.some(item => same(item, receipt))) receipts.push(receipt);
  }
  // v1 only admits Wiki anchors whose actual result contains this exact authority and passes all source checks.
  const wiki = packet.grounding.filter(row => row.kind === 'company_wiki').map(row =>
    ({ aliases: [row.alias], fields: { authority: 'derived_company_knowledge_not_commercial_approval' } }));
  const { packetHash: _oldHash, ...original } = packet;
  const payload = { ...original, projectionVersion: 'verified-metadata-2',
    metadataReceipts: [...receipts, ...wiki], focus: { facts: [], recommendations: [], forbidden: [], extraClaims: true },
    formerlyDisputedClaims: [...new Set([...discord, ...removed, ...preliminary.extraClaims.findings].map(row => row.quote))],
    instructions: [...original.instructions,
      '再次核对附加断言。新增元数据必须来自对应回执。未因新证据解决的原争议仍需结论。不要把天数折合为精确自然月保证。',
    ] };
  return { ...payload, packetHash: hash(payload) };
}

export function bindMetadataOpinion(addendum, signature) {
  assert(signature?.version === REVIEW_VERSION && signature.packetHash === addendum.packetHash &&
    signature.reviewId === addendum.reviewId && signature.reviewerType === 'agent' &&
    ['facts', 'recommendations', 'forbidden'].every(key => Array.isArray(signature[key]) && !signature[key].length),
  'crm026_metadata_signature_unbound');
  return signature.extraClaims;
}

function preserveDefiniteIssues(previous, current, packet) {
  const normalized = value => value.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
  const findings = [...current.findings];
  for (const finding of previous.findings.filter(item => item.issue !== 'unknown')) {
    const original = normalized(finding.quote);
    if (findings.some(item => {
      const quote = normalized(item.quote);
      return item.issue !== 'unknown' && (quote === original || Math.min(quote.length, original.length) >= 10 &&
        (quote.includes(original) || original.includes(quote)));
    })) continue;
    // Mere source provenance cannot clear an established scalar or policy error. Only the supplemented field itself can.
    const leaf = /^\s*(?:商机\s*)?(owner_user_id|assigned_at|owner_user_name)\s*(?:为空|(?:[=:：为])\s*null)[。.]?\s*$/i.exec(finding.quote);
    if (finding.issue === 'unsupported' && leaf &&
      packet.supplementalReceipts.some(row => row.kind === 'lead' && hasObservedValue(row.fields, leaf[1].toLowerCase(), null))) continue;
    findings.push(finding);
  }
  const outcome = findings.some(row => row.issue !== 'unknown') ? 'fail' : findings.length ? 'unknown' : 'pass';
  return { ...current, outcome, findings };
}

export function rescoreTask(input, prepared, review, metadataOpinion, preserveKnown = false) {
  const { packet, original, previous } = prepared;
  const opinion = { ...previous };
  if (review) {
    assert(review.version === REVIEW_VERSION && review.reviewerType === 'agent' &&
      review.reviewId === packet.reviewId && review.packetHash === packet.packetHash, 'crm026_review_binding_mismatch');
    for (const section of ['facts', 'recommendations', 'forbidden']) {
      assert(Array.isArray(review[section]) && same(review[section].map(row => row.id).sort(), [...packet.focus[section]].sort()),
        'crm026_review_focus_mismatch');
      opinion[section] = previous[section].map(old => review[section].find(row => row.id === old.id) ?? old);
    }
    if (packet.focus.extraClaims) {
      assert(record(review.extraClaims), 'crm026_review_extra_claims_required');
      opinion.extraClaims = review.extraClaims;
    } else assert(review.extraClaims == null, 'crm026_review_focus_mismatch');
  }
  if (metadataOpinion) opinion.extraClaims = metadataOpinion;
  if (preserveKnown) opinion.extraClaims = preserveDefiniteIssues(previous.extraClaims, opinion.extraClaims, packet);
  // The original validates the same quotes, rubric, facts and alias sets. The new fields only improve their receipts.
  const score = scoreTask(input, { ...opinion, version: SCORE_VERSION, reviewId: original.reviewId, packetHash: original.packetHash });
  const references = packet.answer.references;
  const invalid = references.filter(row => !row.supported || row.assertions.some(assertion => !assertion.observed)).map(row => row.alias);
  const judgments = [...score.facts, ...score.recommendations, ...score.forbidden];
  const failure = !score.deliverable || !['completed', 'partial'].includes(packet.execution.terminal) || invalid.length > 0 ||
    score.protection.verdict === 'fail' || score.extraClaims.outcome === 'fail' ||
    judgments.some(row => row.verdict === 'fail') || score.facts.some(row => row.verdict === 'pass' && !row.pass);
  const unknownReasons = [
    ...judgments.filter(row => row.verdict === 'unknown').map(({ id, reason }) => ({ id, reason })),
    ...score.extraClaims.findings.filter(row => row.issue === 'unknown').map(({ quote, reason }) => ({ quote, reason })),
    ...(score.protection.verdict === 'unknown' ? [{ id: 'protection', reason: 'archived_protection_not_resolved' }] : []),
  ];
  const outcome = failure ? 'fail' : unknownReasons.length ? 'unknown' : 'pass';
  return { ...score, version: REVIEW_VERSION, binding: { ...score.binding, version: REVIEW_VERSION, packetHash: packet.packetHash },
    outcome, businessPass: outcome === 'pass', pass: outcome === 'pass' && score.comparisonEligible, unknownReasons,
    counts: { ...score.counts, references: { cited: references.length, valid: references.length - invalid.length, invalid } } };
}
