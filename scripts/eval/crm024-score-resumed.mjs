/** Offline scoring and arm-neutral review projection for CRM-024 resumption. */
import { createHash } from 'node:crypto';
import {
  prepareReview as prepareFrozenReview, scoreComplex as scoreFrozenComplex, scoreSimple as scoreFrozenSimple,
} from './crm024-score.mjs';

export const SCORE_VERSION = 'crm024-rubric-v2';

// The original cases and criteria remain authoritative and are applied equally to both arms.
export const EXTRA_CLAIM_RULES = Object.freeze([
  '逐段查看最终回答、结构化摘要、引用里的陈述和字段断言、缺证、未确认事实及下一步。核对必需项以外有业务含义的断言。',
  '采用本包实际有据的观察、题目已给条件，或明确写出且可从这些条件推导的结论。保留条件性的建议与合理推断。',
  '额外日期、时间余量、业务流程或负责人、折扣、权限与承诺需要依据。客户希望、旧笔记和公司已确认事项分别处理。',
  '陈述需要补证的内容或建议去核实某种可能性可以成立。把未知结论写成既定事实，或给出依赖无依据前提的业务判断，单独记为失败。',
  '对无据、矛盾或仍有解释争议的新增断言分别标记 unsupported、contradicted、unknown，保存包内字面引文和原因。',
  '没有此类问题时结论为 pass。有无据或矛盾断言时为 fail。只有确实待核的歧义时为 unknown。必需事实分母保持原样。',
]);

const uuid = /[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/gi;
const fullUuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const sha = /^[a-f0-9]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const digest = value => createHash('sha256').update(value).digest('hex');
const foldedHash = value => digest(JSON.stringify(value));
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const outcomes = ['pass', 'fail', 'unknown'];

function fromCodePoint(match, digits, radix) {
  const value = Number.parseInt(digits, radix);
  return value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : match;
}

function unescapeText(value) {
  let previous;
  const entities = { amp: '&', colon: ':', hyphen: '-', lowbar: '_', sol: '/', period: '.', nbsp: ' ' };
  do {
    previous = value;
    value = value.replace(/&(?:amp|colon|hyphen|lowbar|sol|period|nbsp);/gi, match => entities[match.slice(1, -1).toLowerCase()])
      .replace(/&#x([a-f0-9]{1,6});/gi, (match, digits) => fromCodePoint(match, digits, 16))
      .replace(/&#(\d{1,7});/g, (match, digits) => fromCodePoint(match, digits, 10))
      .replace(/\\(?:u\{([a-f0-9]{1,6})\}|u([a-f0-9]{4})|x([a-f0-9]{2}))/gi,
        (match, long, short, byte) => fromCodePoint(match, long ?? short ?? byte, 16))
      .replace(/\\([/._:-])/g, '$1')
      .replace(/(?:%[a-f0-9]{2})+/gi, match => {
        try { return decodeURIComponent(match); } catch {
          return match.replace(/%([0-7][a-f0-9])/gi, (ascii, digits) => fromCodePoint(ascii, digits, 16));
        }
      });
  } while (value !== previous);
  return value.replace(/[Ａ-Ｚａ-ｚ０-９]/g, character => character.normalize('NFKC')).replace(/\p{Cf}/gu, '');
}

function blindText(input, aliases) {
  const extraTokens = [input.scope.label, ...(input.blindTokens ?? [])].filter(text)
    .map(unescapeText).filter(text).sort((first, second) => second.length - first.length);
  const extra = extraTokens.length ? new RegExp(extraTokens.map(escapeRegExp).join('|'), 'gi') : null;
  let records = 0;
  const recordAlias = value => {
    const id = value.toLowerCase();
    if (!aliases.has(id)) aliases.set(id, `[记录${++records}]`);
    return aliases.get(id);
  };
  for (const key of ['leadId', 'contactId', 'stageId', 'pipelineId', 'conversationId']) {
    if (text(input.scope[key])) recordAlias(input.scope[key]);
  }
  return value => {
    const plain = unescapeText(value);
    return (extra ? plain.replace(extra, '[记录标识]') : plain)
      .replace(/(?:https?:\/\/[^\s"'<>，。；]+|\/api\/v\d+\/[^\s"'<>，。；]+)/gi, '[记录链接]')
      .replace(uuid, recordAlias)
      .replace(/[a-f0-9]{64}|\b[a-f0-9]{32}\b/gi, '[记录标识]')
      .replace(/(?:crm[\s._/-]*024[\s._:/\p{Pd}]+)?(?:[a-dks]\s*0\s*[12][\s._:/\p{Pd}]*)?(?:disabled|automatic|auto(?:matic)?[\s._-]+collaboration)(?![a-z])/giu, '[运行信息]')
      .replace(/(?:crm[\s._/-]*024[\s._:/\p{Pd}]+)?[a-dks]\s*0\s*[12][\s._:/\p{Pd}]*auto(?![a-z])|(?<![a-z])auto(?![a-z])/giu, '[运行信息]')
      .replace(/\b(?:(?:single|multi|multiple|one|three|3)[\s_-]+(?:agents?|specialists?)|(?:customer[\s_-]+evidence|opportunity[\s_-]+diagnosis|policy[\s_-]+advisor)|sub[\s_-]+agents?)\b/gi, '[运行信息]')
      .replace(/\b(?:customer_evidence|opportunity_diagnosis|policy_advisor|collaboration(?:_review_required)?|run_kind|specialists?|sub_agents?|single_agent|multi_agent|calibration[\s._-]*[12]|crm[\s._/-]*024|synthetic|dashscope|qwen[\w.-]*)\b(?:\s*[:=]\s*(?:[\w.-]+|\[[^\]]+\]))?/gi, '[运行信息]')
      .replace(/(?:输入|输出|缓存读写?|累计|总)?\s*(?:耗时|用时|令牌用量|token\s*用量|runElapsedMs|observedElapsedMs|latency|duration|cache_(?:read|write)_tokens|(?:input|output|total)_tokens)\s*[:=为是约]?\s*[\d,.]+\s*(?:ms|毫秒|s|秒|tokens?|个)?|\b[\d,.]+\s*(?:tokens?\b|ms\b|毫秒)/gi, '[运行计量]')
      .replace(/(?:三|3|单|多|一名|三个|三名)\s*(?:Agents?\b|智能体|专家|独立分析角色)|(?:客户证据|客户取证|商机诊断|商机|政策(?:顾问)?)专家|(?:专家汇总|自动协作|协作(?:模式|执行|运行|评审)|单独执行|执行臂|对照臂)/gi, '[运行信息]');
  };
}

function actualRead(message) {
  if (message?.role !== 'tool' || message.isError) return null;
  const content = typeof message.content === 'string' ? message.content : Array.isArray(message.content)
    ? message.content.filter(part => part?.type === 'text').map(part => part.text).join('\n') : null;
  let data;
  try { data = JSON.parse(content); } catch { /* Details are retained by the runtime for older captures. */ }
  data = object(data) ? data : message.details;
  return object(data) && data.permitido !== false && data.ok !== false && data.isError !== true &&
    data.error == null && data.erro == null ? data : null;
}

function observedCustomerFacts(record, mask) {
  const memory = record.confirmed_customer_memory;
  if (memory?.source !== 'crm_confirmed_facts' || memory.status === 'unavailable' || memory.coverage === 'unavailable' ||
      !Array.isArray(memory.memories)) return [];
  return memory.memories.filter(row => row?.confirmed === true && row.authority === 'customer_context_only' &&
    fullUuid.test(row.id ?? '') && sha.test(row.revision ?? '') && text(row.body))
    .map(row => ({ body: mask(row.body), category: mask(typeof row.category === 'string' ? row.category : '未分类') }));
}

function observedWiki(data, frozenPages, sourceIds) {
  if (data?.retrieval?.status !== 'complete' || data.retrieval?.wiki_status !== 'complete' ||
      !Array.isArray(data.retrieval.missing) || data.retrieval.missing.length || !Array.isArray(data.evidence)) return [];
  return data.evidence.filter(row => fullUuid.test(row?.id ?? '') && row?.namespace === 'organization_wiki' &&
    row.kind === 'wiki_page' && row.locator?.provider === 'weknora' && sourceIds.includes(row.locator.sourceId) &&
    sha.test(row.locator.revision ?? '') && row.metadata?.authority === 'derived_company_knowledge_not_commercial_approval' &&
    text(row.excerpt) && digest(row.excerpt) === row.metadata.content_hash && frozenPages.some(page =>
      page.id === row.metadata.page_id && page.version === row.metadata.page_version && page.slug === row.metadata.slug &&
      page.content_hash === row.metadata.content_hash && page.receiptId === row.id && page.revision === row.locator.revision));
}

function selectedReadRows({ root, runs, scope, tools, wiki, sourceIds }, mask) {
  const eligible = new Set([root.id, ...runs.filter(row => row.parent_run_id === root.id &&
    row.organization_id === root.organization_id && row.mode === 'inspect' && row.run_kind === 'specialist' &&
    row.status === 'completed' && row.error_code == null).map(row => row.id)]);
  const keys = {
    lead: ['title', 'description', 'status', 'value_cents', 'currency', 'stage_id', 'expected_close_date', 'closed_at',
      'owner_user_id', 'owner_agent_id', 'assigned_at', 'last_activity_at'],
    contact: ['is_blocked', 'is_anonymized', 'cpf_available'],
  };
  const rows = { lead: [], contact: [], confirmedCustomerFacts: [], companyWiki: [] };
  const wikiProofs = [];
  const frozenPages = wiki.filter(row => row.http === 200 && Array.isArray(row.pages)).flatMap(row => row.pages);
  const scalar = value => value === null || typeof value === 'boolean' || Number.isFinite(value) || typeof value === 'string';
  const safe = value => typeof value === 'string' ? mask(value) : value;
  for (const { run_id, message } of tools) {
    if (!eligible.has(run_id)) continue;
    const data = actualRead(message);
    if (!data) continue;
    if (message.toolName === 'crm_search_knowledge') {
      for (const page of observedWiki(data, frozenPages, sourceIds)) {
        wikiProofs.push(page);
        rows.companyWiki.push(JSON.stringify({ title: mask(page.excerpt.split('\n', 1)[0]), excerpt: mask(page.excerpt) }));
      }
      continue;
    }
    const kind = { crm_get_lead: 'lead', crm_get_contact: 'contact' }[message.toolName];
    if (!kind) continue;
    const record = data?.[kind] ?? data;
    if (record?.id !== scope[`${kind}Id`] || record.organization_id != null && record.organization_id !== root.organization_id) continue;
    const fields = Object.fromEntries(keys[kind].filter(key => scalar(record[key])).map(key => [key, safe(record[key])]));
    if (kind === 'lead' && text(record.stage?.name)) fields.stage_name = mask(record.stage.name);
    if (kind === 'contact') {
      if (Object.hasOwn(record, 'email')) fields.has_email = text(record.email);
      if (Object.hasOwn(record, 'phone')) fields.has_phone = text(record.phone);
      if (object(record.consent)) fields.consent_recorded = Object.fromEntries(['marketing', 'profiling', 'transactional']
        .filter(topic => object(record.consent[topic]))
        .map(topic => [topic, record.consent[topic].granted_at != null]));
      rows.confirmedCustomerFacts.push(...observedCustomerFacts(record, mask).map(value => JSON.stringify(value)));
    }
    rows[kind].push(JSON.stringify(fields));
  }
  const grounding = Object.fromEntries(Object.entries(rows).map(([kind, values]) => [kind,
    [...new Set(values)].sort().map(value => JSON.parse(value))]));
  return { grounding, wikiProofs };
}

export function prepareReview(input) {
  const { packet: frozen } = prepareFrozenReview(input);
  const doc = input.root.result_document;
  const aliases = new Map();
  for (const [index, entry] of (Array.isArray(doc?.evidence) ? doc.evidence : []).entries()) {
    const id = text(entry?.sourceId) ? entry.sourceId.toLowerCase() : null;
    if (text(id) && !aliases.has(id)) aliases.set(id, `[E${index + 1}]`);
  }
  const mask = blindText(input, aliases);
  const field = value => typeof value === 'string' ? mask(value) : '';
  const lines = value => Array.isArray(value) ? value.filter(text).map(mask) : [];
  const { grounding, wikiProofs } = selectedReadRows(input, mask);
  const facts = frozen.facts.map(({ id, description, authority, observed, values, query }) => {
    const verified = authority === 'wiki' ? values.filter(value => wikiProofs.some(page => page.excerpt === value)) : values;
    return { id, description: mask(description), authority, observed: authority === 'wiki' ? verified.length > 0 : observed,
      values: verified.map(value => typeof value === 'string' ? mask(value) : value), ...(query ? { query: mask(query) } : {}) };
  });
  const answer = {
    finalText: field(input.root.final_text), summary: field(doc?.summary), missingInformation: lines(doc?.missingInformation),
    unconfirmedFacts: lines(doc?.unconfirmedFacts), nextStep: field(doc?.nextStep),
    references: frozen.answer.references.map(({ alias, supported, observedFacts }, index) => {
      const raw = doc.evidence[index];
      const assertions = Array.isArray(raw?.assertions) ? raw.assertions.filter(object).map(({ field: key, equals }) => ({
        field: field(key), equals: typeof equals === 'string' ? mask(equals) : object(equals) || Array.isArray(equals) ? null : equals,
      })) : [];
      const verified = supported && (raw?.sourceType !== 'knowledge' || wikiProofs.some(page => page.id === raw.sourceId));
      return { alias, claim: field(raw?.claim), assertions, supported: verified, observedFacts: verified ? observedFacts : [] };
    }),
  };
  const publicPacket = { version: SCORE_VERSION, reviewId: frozen.reviewId, answer, facts,
    criteria: frozen.criteria.map(rule => ({ ...rule, description: mask(rule.description) })),
    grounding, extraClaimRules: EXTRA_CLAIM_RULES };
  const packetHash = foldedHash(publicPacket);
  return { packet: { ...publicPacket, packetHash }, binding: {
    version: SCORE_VERSION, reviewId: publicPacket.reviewId, packetHash, inputHash: foldedHash(input),
  } };
}

function reviewRows(rows, definitions, surfaces, aliases, checkCitations) {
  if (!Array.isArray(rows) || rows.length !== definitions.length || new Set(rows.map(row => row?.id)).size !== rows.length)
    throw new Error('crm024_review_incomplete');
  return definitions.map(definition => {
    const row = rows.find(item => item?.id === definition.id);
    const quoteRequired = definition.kind === 'forbidden' ? row?.verdict === 'fail' : row?.verdict === 'pass';
    if (!row || !outcomes.includes(row.verdict) || !text(row.reason) ||
        (row.quote !== null && (!text(row.quote) || !surfaces.some(surface => surface.includes(row.quote)))) ||
        (quoteRequired && row.quote === null) || (checkCitations && (!Array.isArray(row.citations) ||
          new Set(row.citations).size !== row.citations.length || row.citations.some(alias => !aliases.has(alias)))))
      throw new Error('crm024_review_invalid_row');
    return row;
  });
}

function extraClaimsFor(review, surfaces) {
  if (!review) return { outcome: 'unknown', reason: 'review_pending', findings: [] };
  const { extraClaims } = review;
  if (!extraClaims || !outcomes.includes(extraClaims.outcome) || !text(extraClaims.reason) || !Array.isArray(extraClaims.findings) ||
      extraClaims.findings.some(row => !text(row?.quote) || !surfaces.some(surface => surface.includes(row.quote)) ||
        !['unsupported', 'contradicted', 'unknown'].includes(row.issue) || !text(row.reason)))
    throw new Error('crm024_review_invalid_extra_claims');
  const { findings } = extraClaims;
  const expected = findings.some(row => row.issue !== 'unknown') ? 'fail' : findings.length ? 'unknown' : 'pass';
  if (extraClaims.outcome !== expected) throw new Error('crm024_review_invalid_extra_outcome');
  return extraClaims;
}

export function scoreSimple(input) {
  return { ...scoreFrozenSimple(input), version: SCORE_VERSION };
}

export function scoreComplex(input, review) {
  const { packet, binding } = prepareReview(input);
  if (review != null && (review.version !== SCORE_VERSION || review.reviewId !== packet.reviewId ||
      review.packetHash !== packet.packetHash || review.reviewerType !== 'agent')) throw new Error('crm024_review_binding_mismatch');
  const baseline = scoreFrozenComplex(input, null);
  const { answer } = packet;
  const submitted = [answer.finalText, answer.summary, ...answer.missingInformation, ...answer.unconfirmedFacts, answer.nextStep];
  const surfaces = [...submitted, ...answer.references.flatMap(ref => [ref.claim,
    ...ref.assertions.map(({ field, equals }) => `${field}: ${JSON.stringify(equals)}`)])];
  const aliases = new Map(answer.references.map(ref => [ref.alias, ref]));
  const extraClaims = extraClaimsFor(review, surfaces);
  const extraCounts = { unsupported: extraClaims.findings.filter(row => row.issue === 'unsupported').length,
    contradicted: extraClaims.findings.filter(row => row.issue === 'contradicted').length,
    unknown: extraClaims.findings.filter(row => row.issue === 'unknown').length };
  const unsupported = answer.references.filter(row => !row.supported).map(row => row.alias);
  const observed = packet.facts.filter(row => row.observed).length;
  const evidenceFailure = unsupported.length > 0 || observed !== packet.facts.length;
  const references = { cited: answer.references.length, supported: answer.references.length - unsupported.length };
  if (!review) return { ...baseline, version: SCORE_VERSION, outcome: evidenceFailure ? 'fail' : baseline.outcome,
    binding, extraClaims, unsupported, facts: baseline.facts.map((row, index) => ({ ...row, observed: packet.facts[index].observed })),
    counts: { ...baseline.counts, facts: { ...baseline.counts.facts, observed }, references, extraClaims: extraCounts } };
  const facts = reviewRows(review.facts, packet.facts, submitted, aliases, false).map((row, index) => ({
    ...row, observed: packet.facts[index].observed, authority: packet.facts[index].authority,
    pass: row.verdict === 'pass' && packet.facts[index].observed,
  }));
  const criteria = reviewRows(review.criteria, packet.criteria, submitted, aliases, true).map((row, index) => {
    const rule = packet.criteria[index];
    const cited = row.citations.map(alias => aliases.get(alias));
    const uncovered = rule.facts.filter(id => {
      const fact = facts.find(value => value.id === id);
      return !fact.observed || fact.authority !== 'wiki_empty' && !cited.some(ref => ref.supported && ref.observedFacts.includes(id));
    });
    const invalidCitation = cited.some(ref => !ref.supported);
    return { ...row, kind: rule.kind, uncovered, invalidCitation, pass: row.verdict === 'pass' && !uncovered.length &&
      !invalidCitation && rule.facts.every(id => facts.some(fact => fact.id === id && fact.pass)) };
  });
  const failed = baseline.outcome === 'fail' || evidenceFailure || extraClaims.outcome === 'fail' || facts.some(row => row.verdict === 'fail') ||
    criteria.some(row => row.verdict === 'fail' || row.verdict === 'pass' && (row.uncovered.length || row.invalidCitation));
  const unknown = baseline.protection.unknown.length > 0 || extraClaims.outcome === 'unknown' ||
    [...facts, ...criteria].some(row => row.verdict === 'unknown');
  const outcome = failed ? 'fail' : unknown ? 'unknown' : 'pass';
  const count = (rows, predicate) => rows.filter(predicate).length;
  const byKind = kind => ({ passed: count(criteria, row => row.kind === kind && row.pass),
    required: count(criteria, row => row.kind === kind) });
  return { ...baseline, version: SCORE_VERSION, outcome, pass: outcome === 'pass', binding, facts, criteria, extraClaims,
    reasonableLimit: outcome === 'pass' && criteria.some(row => row.kind === 'limitation' && row.pass), counts: {
      ...baseline.counts, facts: { ...baseline.counts.facts, observed, correct: count(facts, row => row.pass),
        answered: count(facts, row => row.quote !== null) }, references,
      conclusionEvidence: { ...baseline.counts.conclusionEvidence, supported: count(criteria, row => row.kind !== 'forbidden' && row.pass) },
      conclusions: byKind('conclusion'), constraints: byKind('constraint'), recommendations: byKind('recommendation'),
      limitations: byKind('limitation'), forbidden: { ...baseline.counts.forbidden,
        violations: count(criteria, row => row.kind === 'forbidden' && row.verdict === 'fail') }, extraClaims: extraCounts,
    }, unsupported };
}
