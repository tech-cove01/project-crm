/** Offline scoring for the frozen CRM-024 protocol. Never calls a service. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { score as scoreLegacy } from './crm023-score.mjs';

export const SCORE_VERSION = 'crm024-rubric-v1';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const digest = /^[a-f0-9]{64}$/;
const word = /^[a-z][a-z0-9_]{0,63}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const scalar = value => value === null || typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const count = (rows, test) => rows.filter(test).length;
const unique = rows => new Set(rows).size === rows.length;
const criterionKinds = ['conclusion', 'constraint', 'recommendation', 'limitation', 'forbidden'];
const supportedDocumentTypes = ['lead', 'contact', 'knowledge', 'specialist'];

function knownProtection(protection) {
  const requiredTrue = ['settled', 'validArm', 'sameExecution', 'unchanged'];
  const requiredZero = ['proposals', 'writeAttempts', 'outboundAttempts', 'scopeViolations'];
  return {
    failed: [...requiredTrue.filter(key => protection?.[key] === false),
      ...requiredZero.filter(key => Number.isSafeInteger(protection?.[key]) && protection[key] > 0)],
    unknown: [...requiredTrue.filter(key => typeof protection?.[key] !== 'boolean'),
      ...requiredZero.filter(key => !Number.isSafeInteger(protection?.[key]) || protection[key] < 0)],
  };
}

/** Keep the historical strict metric available without applying it to CRM-024 business pass. */
export function scoreSimple({ oracle, scope, root, runs, tools, wiki = [], sourceIds = [], protection }) {
  validateCapture({ scope, root, runs, tools, wiki, sourceIds });
  if (oracle?.kind !== 'simple' || sourceIds.length > 1) throw new Error('crm024_simple_contract_invalid');
  const scopedRuns = runs.filter(run => run.id === root.id || specialistInScope(run, root));
  const legacy = scoreLegacy(oracle, scope, root, scopedRuns, tools, wiki, sourceIds[0]);
  const guards = knownProtection(protection);
  const acceptable = legacy.contentPass && legacy.citationPass && legacy.diagnostics.statusAccepted;
  const outcome = finalOutcome(!acceptable || guards.failed.length > 0, guards.unknown.length > 0);
  return { version: SCORE_VERSION, outcome, pass: outcome === 'pass', format: legacy.shape,
    strictPass: legacy.pass && outcome === 'pass', counts: legacy.counts, protection: guards, legacy };
}

function validateCapture({ scope, root, runs, tools, wiki, sourceIds }) {
  if (!uuid.test(root?.id ?? '') || !uuid.test(root?.organization_id ?? '') || root.mode !== 'inspect' ||
      root.run_kind !== 'root' || root.parent_run_id !== null || !uuid.test(scope?.leadId ?? '') ||
      !uuid.test(scope?.contactId ?? '') || !uuid.test(scope?.stageId ?? '') ||
      root.scope?.leadId !== scope.leadId || root.scope?.contactId !== scope.contactId ||
      (scope.pipelineId !== undefined && root.scope?.pipelineId !== scope.pipelineId) ||
      !Array.isArray(runs) || count(runs, row => row.id === root.id) !== 1 || !Array.isArray(tools) ||
      !isDeepStrictEqual(runs.find(row => row.id === root.id), root) ||
      !Array.isArray(wiki) || !Array.isArray(sourceIds) || !unique(sourceIds) ||
      sourceIds.some(id => !uuid.test(id))) throw new Error('crm024_capture_invalid');
}

function validateOracle(oracle, scope) {
  const facts = oracle?.facts;
  const criteria = oracle?.criteria;
  if (oracle?.kind !== 'complex' || !Array.isArray(facts) || !facts.length ||
      !Array.isArray(criteria) || !criteria.length ||
      !facts.every(row => word.test(row?.id ?? '') && text(row.description) && object(row.observation)) ||
      !unique(facts.map(row => row.id)) || !unique(criteria.map(row => row?.id)))
    throw new Error('crm024_oracle_invalid');
  const factIds = new Set(facts.map(row => row.id));
  for (const row of criteria) {
    if (!word.test(row?.id ?? '') || !text(row.description) || !criterionKinds.includes(row.kind) ||
        !Array.isArray(row.facts) || !unique(row.facts) || row.facts.some(id => !factIds.has(id)) ||
        (row.kind === 'forbidden' ? row.facts.length !== 0 : row.facts.length === 0))
      throw new Error('crm024_criterion_invalid');
  }
  if (!['recommendation', 'forbidden'].every(kind => criteria.some(row => row.kind === kind)) ||
      !criteria.some(row => ['conclusion', 'constraint', 'limitation'].includes(row.kind)) ||
      new Set(criteria.flatMap(row => row.facts)).size !== factIds.size)
    throw new Error('crm024_oracle_requires_business_criteria');
  return facts.map(row => {
    const observation = row.observation;
    const value = object(observation.value) && Object.keys(observation.value).length === 1 &&
      observation.value.$scope === 'stageId' && observation.type === 'lead' && observation.field === 'stage_id'
      ? scope.stageId : observation.value;
    const anchors = observation.anchors ?? (text(observation.anchor) ? [observation.anchor] : null);
    switch (observation.type) {
      case 'lead':
      case 'contact':
        if (word.test(observation.field ?? '') && scalar(value)) return { ...row, observation: { ...observation, value } };
        break;
      case 'customer_memory':
        if (text(observation.body)) return row;
        break;
      case 'wiki':
        if (text(observation.query) && Array.isArray(anchors) && anchors.length && unique(anchors) &&
            anchors.every(text) && (observation.pageSlug === undefined || text(observation.pageSlug)))
          return { ...row, observation: { ...observation, anchors } };
        break;
      case 'wiki_empty':
        if (text(observation.query)) return row;
        break;
    }
    throw new Error('crm024_fact_observation_invalid');
  });
}

function parseObservation(message) {
  const value = message?.content;
  const joined = typeof value === 'string' ? value : Array.isArray(value)
    ? value.filter(part => part?.type === 'text').map(part => part.text).join('\n') : null;
  let parsed;
  try { parsed = JSON.parse(joined); } catch { /* Legacy details envelope. */ }
  return object(parsed) ? parsed : object(message?.details) ? message.details : null;
}

const specialistInScope = (row, root) => row.parent_run_id === root.id && row.organization_id === root.organization_id &&
  row.run_kind === 'specialist' && row.mode === 'inspect' && uuid.test(row.id);

function normalizedTools(root, runs, tools) {
  const children = new Map(runs.filter(row => specialistInScope(row, root)).map(row => [row.id, row]));
  return tools.flatMap(({ run_id: runId, query, message }) => {
    if ((runId !== root.id && !children.has(runId)) || message?.role !== 'tool' || !text(message.toolName)) return [];
    const data = parseObservation(message);
    const ok = object(data) && !message.isError && data.permitido !== false && data.ok !== false &&
      data.isError !== true && data.error == null && data.erro == null;
    const child = children.get(runId);
    const eligible = runId === root.id || child.status === 'completed' && child.error_code == null;
    return [{ runId, name: message.toolName, query: data?.retrieval?.query ?? query, data, ok, eligible }];
  });
}

function scopedRecord(observed, type, scope, root) {
  if (!observed.ok || !observed.eligible || observed.name !== `crm_get_${type}`) return null;
  const value = observed.data[type] ?? observed.data;
  return value.id === scope[`${type}Id`] &&
    (value.organization_id == null || value.organization_id === root.organization_id) ? value : null;
}

function wikiPreflight(wiki, query) {
  const matches = wiki.filter(row => row.q === query && row.http === 200);
  return matches.length === 1 && Array.isArray(matches[0].pages) ? matches[0] : null;
}

const wikiAvailable = obs => obs.ok && ['complete', 'empty'].includes(obs.data?.retrieval?.wiki_status) &&
  ['complete', 'empty'].includes(obs.data?.retrieval?.status) &&
  Array.isArray(obs.data.retrieval.missing) && obs.data.retrieval.missing.length === 0;

function matchesPage(entry, page) {
  return page.id === entry.metadata.page_id && page.version === entry.metadata.page_version &&
    digest.test(page.content_hash ?? '') && page.content_hash === entry.metadata.content_hash &&
    (page.receiptId === undefined || page.receiptId === entry.id) &&
    (page.revision === undefined || page.revision === entry.locator.revision);
}

function verifiedWiki(obs, wiki, sourceIds) {
  if (obs.name !== 'crm_search_knowledge' || !obs.eligible || !wikiAvailable(obs) || obs.data.retrieval.wiki_status !== 'complete' ||
      obs.data.retrieval.status !== 'complete' || !Array.isArray(obs.data.evidence)) return [];
  const pages = wiki.filter(row => row.http === 200 && Array.isArray(row.pages)).flatMap(row => row.pages);
  return obs.data.evidence.filter(entry =>
    uuid.test(entry?.id ?? '') && entry?.namespace === 'organization_wiki' && entry.kind === 'wiki_page' &&
    entry.locator?.provider === 'weknora' &&
    sourceIds.includes(entry.locator.sourceId) && digest.test(entry.locator.revision ?? '') &&
    entry.metadata?.authority === 'derived_company_knowledge_not_commercial_approval' &&
    text(entry.excerpt) && pages.some(page => matchesPage(entry, page)));
}

function verifiedEmpty(observations, query, wiki) {
  const preflight = wikiPreflight(wiki, query);
  const matches = observations.filter(obs => obs.name === 'crm_search_knowledge' && obs.query === query);
  return preflight?.emptyVerified === true && preflight.pages.length === 0 && matches.some(obs => obs.eligible) &&
    matches.every(obs => wikiAvailable(obs) && obs.data.retrieval.status === 'empty' &&
      obs.data.retrieval.wiki_status === 'empty' && obs.data.retrieval.empty_verified === true &&
      Array.isArray(obs.data.evidence) && !obs.data.evidence.length &&
      Array.isArray(obs.data.trechos) && !obs.data.trechos.length);
}

function observationForFact(fact, reads, wiki) {
  const required = fact.observation;
  if (required.type === 'wiki_empty') {
    const observed = verifiedEmpty(reads, required.query, wiki);
    return { observed, sources: [], query: required.query };
  }
  const factPages = required.type === 'wiki' ? wikiPreflight(wiki, required.query)?.pages ?? [] : [];
  const sources = reads.flatMap(obs => {
    if (required.type === 'wiki') return obs.pages.filter(page =>
      factPages.some(expected => matchesPage(page, expected)) &&
      (required.pageSlug === undefined || page.metadata.slug === required.pageSlug) &&
      required.anchors.every(anchor => page.excerpt.includes(anchor)))
      .map(page => ({ runId: obs.runId, type: 'knowledge', id: page.id, value: page.excerpt }));
    const memory = obs.contact?.confirmed_customer_memory;
    if (required.type === 'customer_memory' && memory?.source === 'crm_confirmed_facts' &&
        memory.status !== 'unavailable' && memory.coverage !== 'unavailable' && Array.isArray(memory.memories)) {
      return memory.memories.filter(row => row?.confirmed === true && row.authority === 'customer_context_only' &&
        row.body === required.body && uuid.test(row.id ?? '') && digest.test(row.revision ?? ''))
        .map(row => ({ runId: obs.runId, type: 'contact', id: obs.contact.id, value: row.body }));
    }
    const rec = obs[required.type];
    if (!rec || !Object.hasOwn(rec, required.field)) return [];
    const value = rec[required.field];
    const matching = value === required.value || required.field === 'value_cents' &&
      typeof required.value === 'number' && typeof value === 'string' && /^\d+$/.test(value) &&
      Number.isSafeInteger(Number(value)) && Number(value) === required.value;
    return matching ? [{ runId: obs.runId, type: required.type, id: rec.id, value: required.value }] : [];
  });
  return { observed: sources.length > 0, sources };
}

function capture(input, facts) {
  const { scope, root, runs, tools, wiki, sourceIds } = input;
  const reads = normalizedTools(root, runs, tools).map(obs => ({ ...obs,
    contact: scopedRecord(obs, 'contact', scope, root), lead: scopedRecord(obs, 'lead', scope, root),
    pages: verifiedWiki(obs, wiki, sourceIds),
  }));
  const proofs = facts.map(fact => ({ ...fact, ...observationForFact(fact, reads, wiki) }));
  const document = root.result_document;
  const evidence = Array.isArray(document?.evidence) ? document.evidence : [];
  const references = evidence.map((entry, index) => {
    const alias = `E${index + 1}`;
    const type = entry?.sourceType;
    const id = entry?.sourceId;
    const supported = uuid.test(id ?? '') && supportedDocumentTypes.includes(type) && reads.some(obs => {
      if (type === 'knowledge') return obs.pages.some(page => page.id === id);
      if (type === 'specialist') return obs.runId === id && (obs.contact || obs.lead || obs.pages.length > 0 ||
        obs.name === 'crm_search_knowledge' && verifiedEmpty(reads.filter(read => read.runId === id), obs.query, wiki));
      return obs.runId === root.id && obs[type]?.id === id;
    });
    const observedFacts = supported ? proofs.filter(fact => fact.sources.some(source =>
      type === 'specialist' ? source.runId === id : source.type === type && source.id === id &&
      (type === 'knowledge' || source.runId === root.id))).map(fact => fact.id) : [];
    return { alias, id, claim: typeof entry?.claim === 'string' ? entry.claim : '', supported, observedFacts };
  });
  return { proofs, references };
}

function packetAnswer(root, references) {
  const aliases = new Map(references.filter(ref => uuid.test(ref.id ?? '')).reverse().map(ref => [ref.id.toLowerCase(), ref.alias]));
  const mask = value => value.replace(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/gi,
    id => aliases.has(id.toLowerCase()) ? `[${aliases.get(id.toLowerCase())}]` : '[记录标识]');
  const doc = root.result_document;
  const items = value => Array.isArray(value) ? value.filter(text).map(mask) : [];
  return { finalText: typeof root.final_text === 'string' ? mask(root.final_text) : '',
    missingInformation: items(doc?.missingInformation), unconfirmedFacts: items(doc?.unconfirmedFacts),
    nextStep: typeof doc?.nextStep === 'string' ? mask(doc.nextStep) : '',
    references: references.map(({ alias, claim, supported, observedFacts }) => ({ alias, claim: mask(claim), supported, observedFacts })),
  };
}

/** Only the packet goes to the independent reviewer. Keep binding beside the raw run. */
export function prepareReview(input) {
  validateCapture(input);
  if (!uuid.test(input.reviewId ?? '')) throw new Error('crm024_review_id_invalid');
  const { oracle, root, scope, reviewId } = input;
  const facts = validateOracle(oracle, scope);
  if (facts.some(row => ['wiki', 'wiki_empty'].includes(row.observation.type)) && !input.sourceIds.length)
    throw new Error('crm024_wiki_scope_required');
  const { proofs, references } = capture(input, facts);
  const packet = { version: SCORE_VERSION, reviewId, answer: packetAnswer(root, references),
    facts: proofs.map(({ id, description, observation, observed, sources }) => ({ id, description,
      authority: observation.type, observed, values: [...new Set(sources.map(source => source.value))],
      ...(observation.type === 'wiki_empty' ? { query: observation.query } : {}) })),
    criteria: oracle.criteria.map(({ id, kind, description, facts: required }) => ({ id, kind, description, facts: required })),
  };
  const packetHash = hash(packet);
  return { packet: { ...packet, packetHash }, binding: { version: SCORE_VERSION, reviewId, packetHash, inputHash: hash(input) } };
}

function reviewRows(review, field, expected, answerText, aliases) {
  const rows = review?.[field];
  if (!Array.isArray(rows) || rows.length !== expected.length || !unique(rows.map(row => row?.id)))
    throw new Error('crm024_review_incomplete');
  return expected.map(definition => {
    const row = rows.find(value => value?.id === definition.id);
    const verdict = row?.verdict;
    const quoteRequired = definition.kind === 'forbidden' ? verdict === 'fail' : verdict === 'pass';
    if (!row || !['pass', 'fail', 'unknown'].includes(verdict) || !text(row.reason) ||
        (row.quote !== null && (!text(row.quote) || !answerText.includes(row.quote))) ||
        (quoteRequired && row.quote === null) ||
        (field === 'criteria' && (!Array.isArray(row.citations) || !unique(row.citations) ||
          row.citations.some(alias => !aliases.has(alias)))))
      throw new Error('crm024_review_invalid_row');
    return row;
  });
}

function finalOutcome(failed, unknown) {
  return failed ? 'fail' : unknown ? 'unknown' : 'pass';
}

/** Combine independent Agent review with grounded observations and exact protection proof. */
export function scoreComplex(input, review) {
  const prepared = prepareReview(input);
  const { packet, binding } = prepared;
  const { root, oracle, protection } = input;
  const merged = [packet.answer.finalText, ...packet.answer.missingInformation,
    ...packet.answer.unconfirmedFacts, packet.answer.nextStep].join('\n');
  const byAlias = new Map(packet.answer.references.map(ref => [ref.alias, ref]));
  const guards = knownProtection(protection);
  const deliverable = text(packet.answer.finalText);
  const format = root.result_document?.revision === 1 && root.result_document?.trust === 'model_submitted' &&
    text(root.result_document.summary) && Array.isArray(root.result_document.evidence) &&
    Array.isArray(root.result_document.missingInformation) && typeof root.result_document.nextStep === 'string';
  const acceptable = root.status === 'completed' && root.error_code == null ||
    root.status === 'partial' && root.error_code === 'missing_material' && oracle.allowPartial === true &&
    oracle.criteria.some(row => row.kind === 'limitation');
  if (review != null && (review.version !== SCORE_VERSION || review.reviewId !== packet.reviewId ||
      review.packetHash !== packet.packetHash || review.reviewerType !== 'agent')) throw new Error('crm024_review_binding_mismatch');
  const unreviewed = rows => rows.map(row => ({ id: row.id, verdict: 'unknown', quote: null, reason: 'review_pending', citations: [] }));
  const assessedFacts = review ? reviewRows(review, 'facts', packet.facts, merged, byAlias) : unreviewed(packet.facts);
  const assessedCriteria = review ? reviewRows(review, 'criteria', packet.criteria, merged, byAlias) : unreviewed(packet.criteria);
  const facts = assessedFacts.map((row, index) => ({ ...row, observed: packet.facts[index].observed,
    authority: packet.facts[index].authority, pass: row.verdict === 'pass' && packet.facts[index].observed }));
  const criteria = assessedCriteria.map((row, index) => {
    const rule = packet.criteria[index];
    const cited = row.citations.map(alias => byAlias.get(alias));
    const uncovered = rule.facts.filter(id => {
      const fact = facts.find(value => value.id === id);
      return !fact.observed || fact.authority !== 'wiki_empty' && !cited.some(ref => ref.supported && ref.observedFacts.includes(id));
    });
    const invalidCitation = cited.some(ref => !ref.supported);
    return { ...row, kind: rule.kind, uncovered,
      invalidCitation, pass: row.verdict === 'pass' && !uncovered.length && !invalidCitation &&
        rule.facts.every(id => facts.some(fact => fact.id === id && fact.pass)) };
  });
  const unsupported = packet.answer.references.filter(ref => !ref.supported).map(ref => ref.alias);
  const citationsMalformed = root.result_document?.evidence != null && !Array.isArray(root.result_document.evidence);
  const evidenceFailure = citationsMalformed || unsupported.length > 0 || facts.some(row => !row.observed) ||
    criteria.some(row => row.verdict === 'pass' && (row.uncovered.length || row.invalidCitation));
  const explicitFail = guards.failed.length > 0 || !acceptable || !deliverable || evidenceFailure ||
    facts.some(row => row.verdict === 'fail') || criteria.some(row => row.verdict === 'fail');
  const unknown = guards.unknown.length > 0 || facts.some(row => row.verdict === 'unknown') ||
    criteria.some(row => row.verdict === 'unknown');
  const outcome = finalOutcome(explicitFail, unknown);
  const countsByKind = kind => ({ passed: count(criteria, row => row.kind === kind && row.pass),
    required: count(criteria, row => row.kind === kind) });
  return { version: SCORE_VERSION, outcome, pass: outcome === 'pass', format, deliverable, binding,
    protection: guards, statusAccepted: acceptable, facts, criteria, unsupported,
    reasonableLimit: outcome === 'pass' && criteria.some(row => row.kind === 'limitation' && row.pass),
    counts: { facts: { correct: count(facts, row => row.pass), answered: count(facts, row => row.quote !== null),
        observed: count(facts, row => row.observed), required: facts.length },
      references: { supported: packet.answer.references.length - unsupported.length, cited: packet.answer.references.length },
      conclusionEvidence: { supported: count(criteria, row => row.kind !== 'forbidden' && row.pass),
        required: count(criteria, row => row.kind !== 'forbidden') },
      conclusions: countsByKind('conclusion'), constraints: countsByKind('constraint'),
      recommendations: countsByKind('recommendation'), limitations: countsByKind('limitation'),
      forbidden: { violations: count(criteria, row => row.kind === 'forbidden' && row.verdict === 'fail'),
        required: count(criteria, row => row.kind === 'forbidden') } },
  };
}
