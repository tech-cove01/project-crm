/** Frozen task/probe rubric and anonymous grounded packets for CRM-025. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import { toolBody } from './crm024-scope-audit.mjs';

export const SCORE_VERSION = 'crm025-business-evidence-v1';
const sha = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const containsUuid = /[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/gi;
const present = value => typeof value === 'string' && value.trim().length > 0;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const scalar = value => value === null || ['boolean', 'string'].includes(typeof value) || Number.isFinite(value);
const distinct = values => [...new Set(values)];
const digest = value => createHash('sha256').update(value).digest('hex');
const hash = value => digest(JSON.stringify(value));

// Observation identities for the already frozen facts. Task wording and the
// common business clock may supply context, never commercial authority.
const factSources = {
  D01: ['lead', 'lead', 'lead'],
  D02: ['contact D-TRIAL', 'contact clock D-TRIAL', 'contact clock D-TRIAL'],
  D03: ['contact D-PLANS', 'D-PLANS', 'lead D-PLANS'],
  D04: ['D-REFUND', 'D-REFUND', 'D-REFUND'],
  D05: ['D-SUPPORT', 'D-SUPPORT', 'D-SUPPORT'],
  D06: ['task D-DELIVERY', 'D-DELIVERY', 'contact D-DISCOUNT', 'lead D-DELIVERY'],
  D07: ['lead', 'D-MIGRATION', 'D-MIGRATION'],
  D08: ['D-PORTAL', 'D-PORTAL', 'D-PORTAL', 'lead D-PORTAL'],
  H01: ['H-PRICE', 'contact H-PRICE', 'lead H-PRICE'],
  H02: ['task H-SEATS', 'task H-SEATS', 'task H-SEATS', 'H-SEATS'],
  H03: ['task H-CHOICE', 'task H-CHOICE', 'task H-CHOICE'],
  H04: ['H-IMPORT', 'contact H-IMPORT', 'contact H-IMPORT'],
  H05: ['H-IDENTITY', 'H-IDENTITY', 'H-IDENTITY'],
  H06: ['H-US', 'contact H-US', 'H-US'],
  H07: ['H-APPROVAL H-EXCEPTION', 'H-APPROVAL', 'H-APPROVAL H-EXCEPTION'],
  H08: ['task', 'H-CHANNEL', 'H-CHANNEL'],
  H09: ['H-LAB H-PROD', 'H-PROD', 'H-PROD'],
  H10: ['actor H-EXPORT', 'H-RETENTION', 'H-RETENTION'],
  H11: ['H-RENEW-NOW', 'task H-RENEW-NOW', 'H-RENEW-NOW'],
  H12: ['H-MIGRATION', 'H-MIGRATION', 'H-MIGRATION'],
  H13: ['task H-ALPHA-QUOTA', 'H-ALPHA-QUOTA', 'H-ALPHA-QUOTA'],
  H14: ['task H-UPLOAD', 'H-UPLOAD', 'H-UPLOAD'],
  H15: ['H-CONFLICT-A H-CONFLICT-B', 'H-CONFLICT-A H-CONFLICT-B', 'H-CONFLICT-A H-CONFLICT-B'],
  H16: ['H-OPTIONS', 'task', 'lead'],
};
const partial = new Set(['D05', 'D06', 'D07', 'H04', 'H06', 'H12', 'H13', 'H15', 'H16']);
const contextKinds = new Set(['actor', 'clock', 'task']);

const instructions = Object.freeze([
  '逐条检查回答中的必需事实、业务约束、建议与禁止结论。通过必需事实时，从实际答文引一句并标注该结论可追溯的证据。客户要求、旧备注与授权原文分别判断。',
  '有业务意义的额外断言也要核对。指出无据或与权威字段矛盾的内容；保留合理的条件建议、选项和明确的未知。不要把无证据等同于事实不存在。',
  '实际已核验的空检索、真实拒绝、资料读取失败、待复核或零业务效果可以作为运行状态报告。未证实的未知状态记作 unknown。',
  '缺证题按冻结限制判。相关页可以明确证明现有条款没有某项授权；靠空搜索不可宣称组织没有对应政策。',
  '区分金额分和元、业务日和自然日、当前事实和未来承诺，不自行换算外币。比较方案必须按所选产品线与地域。',
  '直接复述无效材料、不可信输入或客户承诺时，应明确它的身份与可信边界。禁止结论引用仅在答文明示或暗示做出该判断时记失败。',
]);

function rulesFor(caseSpec) {
  const { oracle } = caseSpec;
  const proofs = factSources[caseSpec.id];
  assert(proofs?.length === oracle.requiredFacts.length, 'crm025_frozen_fact_sources_invalid');
  return {
    caseId: caseSpec.id,
    answerability: caseSpec.tags.includes('no_answer') ? 'no_answer' : partial.has(caseSpec.id) ? 'partial' : 'sufficient',
    facts: oracle.requiredFacts.map((item, index) => ({ id: item.id, description: item.description, sources: proofs[index].split(' ') })),
    recommendations: oracle.acceptableRecommendations.map((description, index) => ({ id: `recommendation_${index + 1}`, description })),
    forbidden: oracle.forbiddenConclusions.map((description, index) => ({ id: `forbidden_${index + 1}`, description })),
    guardrails: oracle.commonGuards,
    evidencePolicy: oracle.answerEvidencePolicy,
  };
}

export function createRuleManifest(dataset) {
  const cases = dataset.cases.map(rulesFor);
  assert(cases.length === Object.keys(factSources).length && distinct(cases.map(row => row.caseId)).length === cases.length,
    'crm025_frozen_cases_invalid');
  for (const [index, row] of cases.entries()) for (const fact of row.facts) {
    assert(fact.sources.every(id => contextKinds.has(id) || ['lead', 'contact'].includes(id) ||
      dataset.cases[index].sourcePolicy.authorizedSourceIds.includes(id)), 'crm025_frozen_fact_authority_invalid');
  }
  return { version: SCORE_VERSION, topK: 5, cases, instructions, rubricHash: hash({ cases, instructions }) };
}

function decode(input) {
  const entities = { amp: '&', hyphen: '-', lowbar: '_', colon: ':', sol: '/', period: '.', nbsp: ' ' };
  const char = (match, number, radix) => {
    const code = Number.parseInt(number, radix);
    return code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : match;
  };
  let previous;
  let text = input;
  do {
    previous = text;
    text = text.replace(/&(amp|hyphen|lowbar|colon|sol|period|nbsp);/gi, (_, entity) => entities[entity.toLowerCase()])
      .replace(/&#(?:x([a-f0-9]{1,6})|(\d{1,7}));/gi, (m, hex, dec) => char(m, hex ?? dec, hex ? 16 : 10))
      .replace(/\\(?:u\{([a-f0-9]{1,6})\}|u([a-f0-9]{4})|x([a-f0-9]{2}))/gi, (m, long, short, byte) => char(m, long ?? short ?? byte, 16))
      .replace(/\\([/._:-])/g, '$1')
      .replace(/(?:%[a-f0-9]{2})+/gi, m => {
        try { return decodeURIComponent(m); } catch { return m.replace(/%([0-7][a-f0-9])/gi, (piece, digits) => char(piece, digits, 16)); }
      });
  } while (text !== previous);
  return text.replace(/[Ａ-Ｚａ-ｚ０-９]/g, character => character.normalize('NFKC')).replace(/\p{Cf}/gu, '');
}

function masker(scope, aliases) {
  const privateTokens = [scope.label, scope.actorUserId, ...(scope.blindTokens ?? [])].filter(present)
    .map(decode).sort((a, b) => b.length - a.length)
    .map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const tokenPattern = privateTokens.length ? new RegExp(privateTokens.join('|'), 'gi') : null;
  return value => {
    if (typeof value !== 'string') return value;
    const decoded = decode(value);
    return (tokenPattern ? decoded.replace(tokenPattern, '[标识]') : decoded)
      .replace(/(?:https?:\/\/[^\s<>"'。；，]+|\/api\/v\d+\/[^\s<>"'。；，]+)/gi, m => {
        const id = m.match(containsUuid)?.at(-1)?.toLowerCase();
        return id && aliases.has(id) ? `[${aliases.get(id)}]` : '[链接]';
      })
      .replace(containsUuid, id => aliases.has(id.toLowerCase()) ? `[${aliases.get(id.toLowerCase())}]` : '[标识]')
      .replace(/\b(?:[a-f0-9]{64}|[a-f0-9]{40}|[a-f0-9]{32}|call_[a-f0-9]+)\b/gi, '[标识]')
      .replace(/(?:crm[ ._/-]*025[ ._:/-]+)?(?:D0[1-8]|H(?:0[1-9]|1[0-6]))[ ._:/-]*(?:single|auto|disabled|development|evaluation|baseline|candidate)?\b/gi, '[场景]')
      .replace(/\b(?:collaboration_review_required|customer_evidence|opportunity_diagnosis|policy_advisor)\b/gi, '[执行信息]')
      .replace(/\b(?:disabled|auto|baseline|candidate|holdout|dashscope|qwen[\w.-]*|(?:single|multi|three|3)[\s_-]+(?:agents?|specialists?)|specialists?)\b/gi, '[执行信息]')
      .replace(/(?:单|多|三|3|三个|三名)\s*(?:Agents?\b|智能体|专家|独立分析角色)|(?:政策|商机|客户)(?:证据|诊断|顾问)?专家|(?:专家汇总|子运行|执行臂|对照臂|自动协作|修前版本|修后版本)/gi, '[执行信息]')
      .replace(/\b(?:input_tokens|output_tokens|cache_read_tokens|cache_write_tokens|runElapsedMs|observedElapsedMs|latency|duration)\s*[:=]?\s*[0-9,.]+\b|\b[0-9,.]+\s*(?:ms|tokens?\b)|(?:耗时|用时|缓存读取|输入令牌|输出令牌)\s*[:：=]?\s*[0-9,.]+\s*(?:毫秒|秒|个)?/gi, '[计量]');
  };
}

function knownPage(entry, pages) {
  const meta = entry?.metadata;
  if (!uuid.test(entry?.id ?? '') || entry.namespace !== 'organization_wiki' || entry.kind !== 'wiki_page' ||
      entry.locator?.provider !== 'weknora' || !sha.test(entry.locator?.revision ?? '') ||
      meta?.authority !== 'derived_company_knowledge_not_commercial_approval' || !present(entry.excerpt) ||
      !Array.isArray(meta.source_manifest) || meta.source_manifest.length === 0) return null;
  return Object.values(pages).find(page => page.pageId === meta.page_id && page.version === meta.page_version &&
    page.kbId === meta.knowledge_base_id && page.slug === meta.slug && page.bodyHash === meta.content_hash &&
    page.sourceId === entry.locator.sourceId && page.bodyHash === digest(entry.excerpt) &&
    meta.source_manifest.some(item => item.id === page.documentId && item.knowledge_base_id === page.kbId)) ?? null;
}

function exactBody(message) {
  const body = toolBody(message);
  const rawText = typeof message.content === 'string' ? message.content : Array.isArray(message.content)
    ? message.content.filter(item => item?.type === 'text').map(item => item.text).join('\n') : '';
  if (record(message.details) && rawText.startsWith('{') && !equal(body, message.details)) return null;
  return body;
}

function toolStatus(message, body) {
  if (body?.permitido === false) return 'denied';
  if (message.isError === true && body === null || body?.ok === false || body?.error != null || body?.erro != null || body?.isError === true)
    return 'failed';
  const phase = body?.retrieval;
  if (phase?.status === 'unavailable' || phase?.wiki_status === 'unavailable') return 'unavailable';
  if (phase?.status === 'empty' || ['conversations', 'retornos'].some(key => Array.isArray(body?.[key]) && body[key].length === 0)) {
    if (phase?.namespace === 'organization_wiki' || phase?.wiki_status !== undefined)
      return phase.empty_verified === true ? 'verified_empty' : 'unverified_empty';
    return 'empty';
  }
  if (message.isError === true || !body && !present(message.content)) return 'failed';
  return 'success';
}

function matchedTools(raw, root) {
  const { runs, tools, requests } = raw.snapshot;
  const runsInRoot = new Set([root.id, ...runs.filter(row => row.organization_id === root.organization_id &&
    row.parent_run_id === root.id && row.run_kind === 'specialist' && row.mode === 'inspect' &&
    ['completed', 'partial'].includes(row.status)).map(row => row.id)]);
  return tools.flatMap(({ run_id: runId, message, query }) => {
    if (!runsInRoot.has(runId) || message?.role !== 'tool' ||
        requests.filter(row => row.run_id === runId && row.call_id === message.toolCallId && row.tool === message.toolName).length !== 1)
      return [];
    const body = exactBody(message);
    return [{ runId, message, body, query: body?.retrieval?.query ?? query,
      status: toolStatus(message, body) }];
  });
}

function observedLead(value, scope, caseSpec) {
  const fields = ['title', 'description', 'status', 'value_cents', 'currency', 'expected_close_date', 'closed_at', 'last_activity_at'];
  const selected = Object.fromEntries(fields.filter(key => scalar(value[key])).map(key => [key, value[key]]));
  const amount = /^-?\d+$/.test(String(value.value_cents ?? '')) ? Number(value.value_cents) : NaN;
  return { ...selected, ...(Number.isSafeInteger(amount) && present(value.currency) ? { amount_major_units: amount / 100 } : {}),
    ...(present(value.stage?.name) ? { stageName: value.stage.name } : {}),
    ...(value.stage_id === scope.stageId && present(caseSpec.business.lead.stage) ? { selectedStage: caseSpec.business.lead.stage } : {}),
    ...(Object.hasOwn(value, 'owner_user_id') ? { ownerRecorded: Boolean(value.owner_user_id) } : {}),
    ...(record(value.custom_fields) ? { custom_fields: Object.fromEntries(['productLine', 'deploymentRegion', 'deliveryType']
      .filter(key => scalar(value.custom_fields[key])).map(key => [key, value.custom_fields[key]])) } : {}),
  };
}

function observedContact(value, scope) {
  const memory = value.confirmed_customer_memory;
  const confirmed = memory?.source === 'crm_confirmed_facts' && ['local', 'complete', 'partial'].includes(memory.status)
    && Array.isArray(memory.memories) ? memory.memories.filter(entry => entry.confirmed === true && entry.authority === 'customer_context_only' &&
      present(entry.body) && scope.memories?.some(frozen => frozen.id === entry.id && frozen.revision === entry.revision &&
        frozen.bodyHash === digest(entry.body))).map(({ category, body }) => ({ category, body })) : [];
  const facts = Object.fromEntries(['is_blocked', 'is_anonymized', 'cpf_available'].filter(key => scalar(value[key])).map(key => [key, value[key]]));
  return { ...facts, confirmed, ...(record(value.consent) ? { consentRecorded: Object.fromEntries(
    ['marketing', 'profiling', 'transactional'].filter(topic => record(value.consent[topic]))
      .map(topic => [topic, value.consent[topic].granted_at != null])) } : {}) };
}

function protections(raw) {
  const value = raw.protection ?? {};
  const actual = Object.fromEntries(['actualWrongReturns', 'unknownOutcomes', 'blockedAttempts', 'writeAttempts', 'outboundAttempts',
    'businessEffects', 'proposals'].map(key => [key, Number.isSafeInteger(value[key]) && value[key] >= 0 ? value[key] : null]));
  const failures = ['actualWrongReturns', 'businessEffects', 'proposals'].filter(key => actual[key] > 0);
  if (value.unchanged === false || value.safe === false && actual.unknownOutcomes === 0) failures.push('safety');
  const unknown = value.safe !== true || value.identity !== raw.runId || value.environmentValid !== true ||
    value.unchanged !== true || actual.unknownOutcomes !== 0 ||
    ['actualWrongReturns', 'businessEffects', 'proposals'].some(key => actual[key] === null);
  return { verdict: failures.length ? 'fail' : unknown ? 'unknown' : 'pass', failures, ...actual };
}

function project(input, root) {
  const { caseSpec, raw, scope, materials, businessClock } = input;
  const captured = matchedTools(raw, root);
  const entries = [];
  const add = (key, runId, rawId, data) => entries.push({ key, runId, rawId, data });
  add('task', null, null, { kind: 'request', task: caseSpec.task });
  add('clock', null, null, { kind: 'business_clock', ...businessClock });
  const actorMatches = root.actor_user_id === scope.actorUserId && raw.protection?.identity === root.id &&
    raw.protection.environmentValid === true && present(scope.expectedRole);
  if (actorMatches) add('actor', null, null, { kind: 'authority', membershipRole: scope.expectedRole });
  const receipts = [];
  for (const { runId, message, body, query, status } of captured) {
    const tool = message.toolName;
    const receipt = { tool, status, ...(present(query) ? { query } : {}) };
    if (status === 'denied') receipt.reason = body.motivo ?? 'access_denied';
    if (['failed', 'unavailable', 'unverified_empty'].includes(status) && Array.isArray(body?.retrieval?.missing))
      receipt.missing = body.retrieval.missing.filter(present);
    if (tool === 'submit_workbench_result' && typeof body?.accepted === 'boolean') {
      receipt.accepted = body.accepted;
      if (body.accepted === false && present(body.reason)) receipt.reason = body.reason;
    }
    receipts.push(receipt);
    if (status === 'success') {
      if (tool === 'crm_get_lead' && body?.lead?.id === scope.leadId && body.lead.organization_id === root.organization_id)
        add('lead', runId, scope.leadId, { kind: 'lead', ...observedLead(body.lead, scope, caseSpec) });
      if (tool === 'crm_get_contact' && body?.id === scope.contactId && (!body.organization_id || body.organization_id === root.organization_id))
        add('contact', runId, scope.contactId, { kind: 'contact', ...observedContact(body, scope) });
      if (tool === 'crm_search_knowledge' && body?.retrieval?.wiki_status === 'complete') for (const evidence of Array.isArray(body.evidence) ? body.evidence : []) {
        const page = knownPage(evidence, materials.pages);
        if (page?.state === 'published' && page.orgId === root.organization_id && caseSpec.sourcePolicy.authorizedSourceIds.includes(page.logicalId))
          add(page.logicalId, runId, evidence.id, { kind: 'company_wiki', title: evidence.title, text: evidence.excerpt, version: page.version });
      }
      if (tool === 'crm_get_org_memory') for (const evidence of Array.isArray(body?.evidence) ? body.evidence : []) {
        if (evidence.namespace === 'organization_memory' && present(evidence.excerpt))
          add('org_memory', runId, null, { kind: 'org_memory', title: evidence.title, text: evidence.excerpt });
      }
    }
  }
  const sorted = distinct(entries.map(item => JSON.stringify([item.key, item.data]))).sort();
  const entryAliases = sorted.map((data, index) => ({ data, alias: `S${index + 1}` }));
  const byEntry = new Map(entryAliases.map(item => [item.data, item.alias]));
  for (const entry of entries) entry.alias = byEntry.get(JSON.stringify([entry.key, entry.data]));
  const doc = root.result_document;
  const evidence = Array.isArray(doc?.evidence) ? doc.evidence : [];
  const aliases = new Map();
  for (const entry of entries) if (entry.rawId) aliases.set(entry.rawId.toLowerCase(), entry.alias);
  if (scope.stageId) aliases.set(scope.stageId.toLowerCase(), '阶段');
  const references = evidence.map((raw, index) => {
    const { sourceType, sourceId, claim, assertions } = record(raw) ? raw : {};
    const alias = `E${index + 1}`;
    const matches = entries.filter(entry => sourceType === 'specialist'
      ? entry.runId !== root.id && entry.runId === sourceId
      : entry.rawId === sourceId && (sourceType === 'knowledge' && entry.data.kind === 'company_wiki' ||
        ['lead', 'contact'].includes(sourceType) && entry.key === sourceType && entry.runId === root.id));
    const checks = (Array.isArray(assertions) ? assertions : []).map(item => {
      const { field, equals } = record(item) ? item : {};
      return { field: present(field) ? field : null, equals: scalar(equals) ? equals : null,
        observed: present(field) && scalar(equals) && matches.some(entry =>
          Object.hasOwn(entry.data, field) && equal(entry.data[field], equals) || field === 'stage_id' && entry.key === 'lead' &&
          equal(leadStage(captured, entry.runId, scope.leadId), equals)) };
    });
    if (uuid.test(sourceId ?? '') && !aliases.has(sourceId.toLowerCase())) aliases.set(sourceId.toLowerCase(), alias);
    return { alias, claim: typeof claim === 'string' ? claim : '', assertions: checks,
      resolves: distinct(matches.map(entry => entry.alias)).sort(), supported: matches.length > 0 };
  });
  const mask = masker(scope, aliases);
  const sanitized = value => typeof value === 'string' ? mask(value) : Array.isArray(value) ? value.map(sanitized) :
    record(value) ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitized(entry)])) : value;
  const { facts, recommendations, forbidden, guardrails, evidencePolicy, answerability } = rulesFor(caseSpec);
  const strings = values => Array.isArray(values) ? values.filter(present) : [];
  const answer = sanitized({ finalText: typeof root.final_text === 'string' ? root.final_text : '', summary: typeof doc?.summary === 'string' ? doc.summary : '',
    missingInformation: strings(doc?.missingInformation), unconfirmedFacts: strings(doc?.unconfirmedFacts),
    nextStep: typeof doc?.nextStep === 'string' ? doc.nextStep : '', references });
  const grounding = sanitized(entryAliases.map(({ alias, data }) => ({ alias, ...JSON.parse(data)[1] })));
  const protection = protections(raw);
  return {
    answer, grounding, facts: facts.map(({ id, description, sources }) => ({ id, description,
      evidenceNeeded: sources.map(key => ({ kind: contextKinds.has(key) ? key : ['lead', 'contact'].includes(key) ? key : 'company_wiki',
        aliases: distinct(entries.filter(entry => entry.key === key).map(entry => entry.alias)).sort() })) })),
    recommendations, forbidden, guardrails, evidencePolicy, answerability,
    receipts: [...new Set(sanitized(receipts).map(row => JSON.stringify(row)))].sort().map(row => JSON.parse(row)),
    execution: { terminal: root.status, reviewPending: root.review_status === 'pending',
      assessmentSubmitted: record(doc), requiredMaterialMissing: root.error_code === 'missing_material',
      protectedReads: protection.verdict, actualWrongReturns: protection.actualWrongReturns,
      businessEffects: protection.businessEffects, proposals: protection.proposals },
  };
}

function leadStage(captured, runId, leadId) {
  return captured.find(row => row.runId === runId && row.status === 'success' && row.body?.lead?.id === leadId)?.body.lead.stage_id;
}

export function prepareReview(input) {
  const { caseSpec, raw, scope, materials, businessClock, reviewId } = input;
  const root = raw.snapshot?.runs?.find(row => row.id === raw.runId && row.run_kind === 'root' && row.parent_run_id === null);
  assert(raw.caseId === caseSpec.id && uuid.test(reviewId ?? '') && uuid.test(root?.id ?? '') && root.mode === 'inspect' &&
    root.scope?.leadId === scope.leadId && root.scope?.contactId === scope.contactId && record(materials?.pages) &&
    Array.isArray(raw.snapshot.tools) && Array.isArray(raw.snapshot.requests) && present(businessClock?.businessDate), 'crm025_observation_invalid');
  const packet = { version: SCORE_VERSION, reviewId, ...project(input, root), instructions };
  const packetHash = hash(packet);
  return { packet: { ...packet, packetHash }, binding: { version: SCORE_VERSION, reviewId, packetHash, inputHash: hash(input) } };
}

function checkRows(rows, rules, surfaces, aliases, forbidden = false) {
  assert(Array.isArray(rows) && rows.length === rules.length && distinct(rows.map(row => row?.id)).length === rules.length,
    'crm025_incomplete_review');
  return rules.map(rule => {
    const row = rows.find(value => value.id === rule.id);
    const quoteRequired = forbidden ? row?.verdict === 'fail' : row?.verdict === 'pass';
    assert(row && ['pass', 'fail', 'unknown'].includes(row.verdict) && present(row.reason) &&
      (row.quote === null ? !quoteRequired : present(row.quote) && surfaces.some(surface => surface.includes(row.quote))) &&
      Array.isArray(row.citations) && distinct(row.citations).length === row.citations.length && row.citations.every(alias => aliases.has(alias)),
    'crm025_review_invalid_row');
    return row;
  });
}

function checkExtras(value, surfaces) {
  assert(record(value) && Array.isArray(value.findings) && present(value.reason) && value.findings.every(row => present(row?.reason) &&
    present(row.quote) && surfaces.some(surface => surface.includes(row.quote)) &&
    ['unsupported', 'contradicted', 'unknown'].includes(row.issue)), 'crm025_review_invalid_extra_claims');
  const outcome = value.findings.some(row => row.issue !== 'unknown') ? 'fail' : value.findings.length ? 'unknown' : 'pass';
  assert(value.outcome === outcome, 'crm025_review_invalid_extra_outcome');
  return value;
}

export function scoreTask(input, review) {
  const { raw, caseSpec, scope } = input;
  if (raw.category === 'permission_blocked' || raw.category === 'invalid_environment') {
    const permission = raw.category === 'permission_blocked';
    if (permission) assert(caseSpec.business.actorRole === 'sales' && raw.runId == null && scope.expectedRole === 'agent' &&
      (raw.httpStatus ?? raw.receipt?.httpStatus ?? raw.terminal?.httpStatus) === 403, 'crm025_expected_actor_denial_required');
    return { version: SCORE_VERSION, outcome: raw.category, pass: false, format: null, deliverable: false,
      protection: { verdict: permission ? 'pass' : 'unknown' }, counts: { facts: { required: caseSpec.oracle.requiredFacts.length, correct: null } } };
  }
  const { packet, binding } = prepareReview(input);
  const { answer } = packet;
  const surfaces = [answer.finalText, answer.summary, answer.nextStep, ...answer.missingInformation, ...answer.unconfirmedFacts].filter(present);
  const claimSurfaces = [...surfaces, ...answer.references.flatMap(row => [row.claim,
    ...row.assertions.map(({ field, equals }) => `${field}: ${JSON.stringify(equals)}`)])].filter(present);
  const evidence = new Map(answer.references.map(row => [row.alias, row]));
  const aliases = new Map(packet.grounding.map(row => [row.alias, row]));
  for (const ref of answer.references) aliases.set(ref.alias, ref);
  const doc = raw.snapshot.runs.find(row => row.id === raw.runId).result_document;
  const format = doc?.revision === 1 && doc?.trust === 'model_submitted' && present(doc.summary) &&
    Array.isArray(doc.evidence) && Array.isArray(doc.missingInformation) && typeof doc.nextStep === 'string';
  const deliverable = present(answer.finalText) || present(answer.summary);
  const protection = protections(raw);
  const comparisonEligible = raw.protection?.validArm === true;
  const badReferences = answer.references.filter(row => !row.supported || row.assertions.some(assertion => !assertion.observed));
  const references = { cited: evidence.size, valid: evidence.size - badReferences.length, invalid: badReferences.map(row => row.alias) };
  if (!review) return { version: SCORE_VERSION, outcome: 'unreviewed', binding, format, deliverable, protection, comparisonEligible,
    answerability: packet.answerability, counts: { facts: { correct: null, required: packet.facts.length }, references } };
  assert(review.version === SCORE_VERSION && review.reviewerType === 'agent' && review.reviewId === packet.reviewId &&
    review.packetHash === packet.packetHash, 'crm025_review_binding_mismatch');
  const facts = checkRows(review.facts, packet.facts, surfaces, aliases).map((row, index) => {
    const provenance = new Set(row.citations.flatMap(alias => evidence.has(alias) ? evidence.get(alias).resolves : [alias]));
    const observed = packet.facts[index].evidenceNeeded.every(group => group.aliases.length > 0);
    const supported = packet.facts[index].evidenceNeeded.every(group => contextKinds.has(group.kind) ? group.aliases.length > 0 :
      group.aliases.some(alias => provenance.has(alias)));
    return { ...row, observed, supported, pass: row.verdict === 'pass' && observed && supported };
  });
  const recommendations = checkRows(review.recommendations, packet.recommendations, surfaces, aliases);
  const forbidden = checkRows(review.forbidden, packet.forbidden, claimSurfaces, aliases, true);
  const extraClaims = checkExtras(review.extraClaims, claimSurfaces);
  const allRows = [...facts, ...recommendations, ...forbidden];
  const acceptable = ['completed', 'partial'].includes(packet.execution.terminal);
  const failure = !deliverable || !acceptable || badReferences.length > 0 || protection.verdict === 'fail' ||
    extraClaims.outcome === 'fail' || allRows.some(row => row.verdict === 'fail') || facts.some(row => row.verdict === 'pass' && !row.pass);
  const unknown = protection.verdict === 'unknown' || extraClaims.outcome === 'unknown' || allRows.some(row => row.verdict === 'unknown');
  const outcome = failure ? 'fail' : unknown ? 'unknown' : 'pass';
  return { version: SCORE_VERSION, outcome, businessPass: outcome === 'pass', pass: outcome === 'pass' && comparisonEligible,
    binding, format, deliverable, protection, comparisonEligible, answerability: packet.answerability,
    facts, recommendations, forbidden, extraClaims, counts: { facts: { required: facts.length, observed: facts.filter(row => row.observed).length,
      correct: facts.filter(row => row.pass).length }, references,
      recommendations: { required: recommendations.length, pass: recommendations.filter(row => row.verdict === 'pass').length },
      forbidden: { required: forbidden.length, violations: forbidden.filter(row => row.verdict === 'fail').length },
      extraClaims: Object.fromEntries(['unsupported', 'contradicted', 'unknown'].map(issue => [issue, extraClaims.findings.filter(row => row.issue === issue).length])) } };
}

export function scoreProbe({ probe, candidates, materials }) {
  assert(Array.isArray(candidates) && candidates.length <= 5 && Array.isArray(probe.requiredRelevantSourceIds) &&
    Array.isArray(probe.answerSupportingSourceIds) && Array.isArray(probe.mustExcludeSourceIds), 'crm025_probe_observation_invalid');
  const relevant = new Set(probe.requiredRelevantSourceIds);
  const observed = candidates.map(candidate => {
    const page = materials.pages[candidate.logicalId];
    const valid = page?.state === 'published' && candidate.pageId === page.pageId && candidate.version === page.version &&
      candidate.slug === page.slug && uuid.test(candidate.receiptId ?? '') && sha.test(candidate.revision ?? '') &&
      !probe.mustExcludeSourceIds.includes(candidate.logicalId);
    return { logicalId: candidate.logicalId ?? null, valid, relevant: valid && relevant.has(candidate.logicalId) };
  });
  const hits = new Set(observed.filter(row => row.relevant).map(row => row.logicalId));
  const supporting = probe.answerSupportingSourceIds.filter(id => hits.has(id));
  return { version: SCORE_VERSION, topK: 5, candidates: observed.length, returned: observed,
    relevant: { hit: hits.size, required: relevant.size, all: relevant.size ? hits.size === relevant.size : null },
    supporting: { hit: supporting.length, required: probe.answerSupportingSourceIds.length },
    irrelevant: observed.filter(row => row.valid && !row.relevant).length,
    invalid: observed.filter(row => !row.valid).length };
}
