/** CRM-023 evaluator. Uses only the frozen oracle and captured workbench data. */
export const SCORE_VERSION = 'crm023-score-v1';

const crmFields = {
  stage_id: { sourceType: 'lead', field: 'stage_id' },
  value_cents: { sourceType: 'lead', field: 'value_cents' },
  currency: { sourceType: 'lead', field: 'currency' },
  status: { sourceType: 'lead', field: 'status' },
  lead_title: { sourceType: 'lead', field: 'title' },
  expected_close_date: { sourceType: 'lead', field: 'expected_close_date' },
  contact_name: { sourceType: 'contact', field: 'name' },
};
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isScalar = value => value === null || typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value);
const hasKeys = (value, keys) => isObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const parse = text => {
  if (typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch { return null; }
};

function hasShape(answer, fields) {
  return hasKeys(answer, ['fields', 'sources']) && hasKeys(answer.fields, fields) && hasKeys(answer.sources, fields) &&
    fields.every(key => isScalar(answer.fields[key]) && (answer.sources[key] === null ||
      typeof answer.sources[key] === 'string' && uuid.test(answer.sources[key])));
}

function leadingObject(text) {
  if (typeof text !== 'string') return null;
  const body = text.trim().replace(/^```(?:json)?\s*/i, '');
  if (!body.startsWith('{')) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return parse(body.slice(0, index + 1));
  }
  return null;
}

function observationData(message) {
  const content = typeof message.content === 'string' ? message.content
    : Array.isArray(message.content) ? message.content.filter(part => part?.type === 'text').map(part => part.text).join('\n') : null;
  const parsed = parse(content);
  if (isObject(parsed)) return parsed;
  return isObject(message.details) ? message.details : null;
}

function frozenContract(item, scope) {
  if (!Array.isArray(item.fields) || item.fields.length === 0 || new Set(item.fields).size !== item.fields.length ||
      !item.fields.every(key => typeof key === 'string')) throw new Error('invalid_frozen_field_list');
  const expected = { stage_id: scope.stageId, value_cents: item.value, contact_name: item.contactName,
    lead_title: item.leadTitle, expected_close_date: item.expectedDate, ...item.expected };
  return item.fields.map(key => {
    let policy = item.policy?.[key];
    if (!policy && key === 'policy_excerpt' && item.query) {
      policy = { query: item.query,
        expect: item.policyExpectation === 'empty' || item.policyExpectation == null && item.id === 'M03' ? 'empty' : 'excerpt',
        anchor: item.policyAnchor ?? (item.query === 'CSV' ? '人工上传 CSV' : item.query === '审批' ? '等待人工明确决定' : undefined) };
    }
    if (policy) {
      if (!['excerpt', 'empty'].includes(policy.expect) || typeof policy.query !== 'string' || !policy.query.trim() ||
          policy.expect === 'excerpt' && (typeof policy.anchor !== 'string' || !policy.anchor.trim())) throw new Error('invalid_frozen_policy_claim');
      return { key, policy };
    }
    const entry = item.crm?.[key] ?? item.fieldSources?.[key] ?? crmFields[key];
    const crm = typeof entry === 'string' ? { sourceType: entry, field: crmFields[key]?.field ?? key } : entry;
    if (!crm || !['lead', 'contact'].includes(crm.sourceType) || typeof crm.field !== 'string' || !isScalar(expected[key])) {
      throw new Error('invalid_frozen_crm_field');
    }
    const id = crm.sourceType === 'lead' ? scope.leadId : scope.contactId;
    if (typeof id !== 'string' || !uuid.test(id)) throw new Error('invalid_frozen_object_scope');
    return { key, crm, id, expected: expected[key] };
  });
}

function observationIndex(root, runs, tools) {
  const related = runs.filter(run => run.id !== root.id && run.parent_run_id === root.id && run.run_kind === 'specialist' &&
    (root.organization_id == null || run.organization_id == null || run.organization_id === root.organization_id));
  const relatedIds = new Set(related.map(run => run.id));
  const children = new Set(related.filter(run => run.status === 'completed' && run.error_code == null).map(run => run.id));
  const observations = [];
  const rejected = [];
  for (const { run_id, query, message } of tools) {
    if ((run_id !== root.id && !relatedIds.has(run_id)) || message?.role !== 'tool' || !message.toolName) continue;
    const data = observationData(message);
    const observation = { runId: run_id, query, tool: message.toolName, data };
    if (!data || message.isError === true || data.permitido === false || data.ok === false || data.error != null || data.erro != null) {
      rejected.push(observation);
      continue;
    }
    if (run_id === root.id || children.has(run_id)) observations.push(observation);
    else if (observation.tool === 'crm_search_knowledge' && (retrievalUnavailable(data) || incompleteRetrieval(data))) {
      rejected.push(observation);
    }
  }
  const typed = Array.isArray(root.result_document?.evidence) ? root.result_document.evidence : [];
  const typedAs = (id, sourceType) => typeof id === 'string' && uuid.test(id) &&
    typed.some(entry => entry?.sourceId === id && entry.sourceType === sourceType);
  const supports = (citation, obs, id, type) => {
    if (citation === id && typedAs(id, type) && (obs.runId === root.id || type === 'knowledge')) return true;
    return children.has(obs.runId) && citation === obs.runId && typedAs(citation, 'specialist');
  };
  return { observations, rejected, children, rootId: root.id, typed, supports };
}

function checkCrm(requirement, actual, citation, index) {
  const { crm, id, expected } = requirement;
  const fieldPassed = actual === expected;
  const matching = index.observations.filter(obs => {
    if (obs.tool !== `crm_get_${crm.sourceType}`) return false;
    const record = obs.data[crm.sourceType] ?? obs.data;
    if (!record || record.id !== id || !Object.hasOwn(record, crm.field)) return false;
    const raw = record[crm.field];
    const value = typeof expected === 'number' && crm.field === 'value_cents' && typeof raw === 'string' && /^\d+$/.test(raw) &&
      Number.isSafeInteger(Number(raw)) ? Number(raw) : raw;
    return value === expected;
  });
  const supported = fieldPassed && matching.some(obs => index.supports(citation, obs, id, crm.sourceType));
  return { fieldPassed, needsCitation: true, supported,
    limitation: supported && expected === null ? 'observed_null' : null,
    reason: !matching.length ? 'missing_actual_value' : !fieldPassed ? 'wrong_value' : !supported ? 'unsupported_citation' : 'supported' };
}

function frozenWikiPages(wiki, query) {
  const oracles = wiki.filter(entry => entry.q === query);
  const oracle = oracles.length === 1 ? oracles[0] : null;
  const validOracle = Array.isArray(oracle?.pages) && (oracle.http === undefined || oracle.http === 200) &&
    oracle.pages.every(page => uuid.test(page.id) && Number.isInteger(page.version) && page.version > 0 &&
      /^[a-f0-9]{64}$/i.test(page.content_hash));
  return validOracle ? oracle.pages : null;
}

const unavailableStatuses = new Set(['unavailable', 'disabled', 'error', 'unauthorized']);
const retrievalUnavailable = data => unavailableStatuses.has(data.retrieval?.wiki_status) || unavailableStatuses.has(data.retrieval?.status);
const incompleteRetrieval = data => data.retrieval?.missing != null &&
  (!Array.isArray(data.retrieval.missing) || data.retrieval.missing.length > 0);
const healthyEmpty = data => data.retrieval?.wiki_status === 'empty' && data.retrieval.status === 'empty' &&
  !incompleteRetrieval(data) && Array.isArray(data.evidence) && data.evidence.length === 0 &&
  Array.isArray(data.trechos) && data.trechos.length === 0;

function trustedKnowledge(observation, wiki, permittedSource) {
  const { tool, query, data } = observation;
  if (tool !== 'crm_search_knowledge' || data.retrieval?.wiki_status !== 'complete' ||
      retrievalUnavailable(data) || incompleteRetrieval(data) || !Array.isArray(data.evidence) || !uuid.test(permittedSource)) return [];
  const pages = frozenWikiPages(wiki, query);
  if (!pages?.length) return [];
  return data.evidence.filter(entry => entry?.locator?.provider === 'weknora' && entry.locator.sourceId === permittedSource &&
    uuid.test(entry.id) && pages.some(page => page.id === entry.metadata?.page_id &&
      page.version === entry.metadata?.page_version && page.content_hash === entry.metadata?.content_hash));
}

function checkPolicy(policy, actual, citation, index, wiki, permittedSource) {
  const matchesQuery = obs => obs.tool === 'crm_search_knowledge' && obs.query === policy.query;
  const reads = index.observations.filter(matchesQuery);
  const unavailable = index.rejected.some(matchesQuery) || reads.some(({ data }) => retrievalUnavailable(data));
  if (policy.expect === 'empty') {
    const pages = frozenWikiPages(wiki, policy.query);
    const contradictory = reads.some(({ data }) => incompleteRetrieval(data) ||
      (data.evidence?.length ?? 0) > 0 || (data.trechos?.length ?? 0) > 0);
    const normalEmpty = pages?.length === 0 && !unavailable && !contradictory && reads.some(({ data }) => healthyEmpty(data));
    const fieldPassed = actual === null && normalEmpty;
    return { fieldPassed, needsCitation: false, supported: false,
      limitation: fieldPassed && citation === null ? 'normal_empty' : null,
      reason: !normalEmpty ? (unavailable ? 'retrieval_unavailable' : 'empty_not_verified') :
        actual !== null ? 'expected_null' : citation !== null ? 'empty_citation_must_be_null' : 'normal_empty' };
  }
  const excerpt = typeof actual === 'string' ? actual.trim() : '';
  const evidence = reads.flatMap(obs => trustedKnowledge(obs, wiki, permittedSource).map(entry => ({ obs, entry })));
  const matching = excerpt.includes(policy.anchor) ? evidence.filter(({ entry }) =>
    typeof entry.excerpt === 'string' && entry.excerpt.includes(excerpt)) : [];
  const supported = matching.some(({ entry, obs }) => index.supports(citation, obs, entry.id, 'knowledge'));
  return { fieldPassed: matching.length > 0, needsCitation: true, supported, limitation: null,
    reason: !evidence.length ? (unavailable ? 'retrieval_unavailable' : 'required_evidence_missing') :
      !matching.length ? 'wrong_policy_excerpt' : supported ? 'supported' : 'unsupported_citation' };
}

function observedCrmIdentity(obs, scope, sourceType) {
  const id = sourceType === 'lead' ? scope.leadId : scope.contactId;
  const getter = `crm_get_${sourceType}`;
  if (obs.tool === getter) return (obs.data[sourceType] ?? obs.data).id === id;
  const list = sourceType === 'lead' ? 'crm_list_leads' : 'crm_search_contacts';
  const rows = obs.data[`${sourceType}s`];
  return obs.tool === list && Array.isArray(rows) && rows.some(row => row?.id === id);
}

function unsupportedTypedEvidence(root, scope, index, wiki, permittedSource) {
  if (root.result_document?.evidence != null && !Array.isArray(root.result_document.evidence)) {
    return [{ index: null, sourceType: null, sourceId: null, reason: 'malformed_typed_evidence' }];
  }
  const trustedIds = new Set(index.observations.flatMap(obs => trustedKnowledge(obs, wiki, permittedSource).map(entry => entry.id)));
  const supports = (type, id) => {
    if (type === 'knowledge') return trustedIds.has(id);
    if (type === 'lead' || type === 'contact') {
      return id === (type === 'lead' ? scope.leadId : scope.contactId) &&
        index.observations.some(obs => obs.runId === index.rootId && observedCrmIdentity(obs, scope, type));
    }
    if (type === 'specialist') {
      return index.children.has(id) && index.observations.some(obs => obs.runId === id &&
        (observedCrmIdentity(obs, scope, 'lead') || observedCrmIdentity(obs, scope, 'contact') ||
          trustedKnowledge(obs, wiki, permittedSource).length > 0 || (obs.tool === 'crm_search_knowledge' &&
            frozenWikiPages(wiki, obs.query)?.length === 0 && healthyEmpty(obs.data))));
    }
    return false;
  };
  return index.typed.flatMap((entry, index) => {
    const sourceId = typeof entry?.sourceId === 'string' && uuid.test(entry.sourceId) ? entry.sourceId : null;
    const sourceType = ['lead', 'contact', 'knowledge', 'specialist'].includes(entry?.sourceType) ? entry.sourceType : null;
    return sourceId && supports(sourceType, sourceId) ? [] : [{ index, sourceType, sourceId,
      reason: sourceType === null ? 'source_type_not_in_evaluation_contract' : 'typed_source_unobserved' }];
  });
}

export function score(item, scope, root, runs, tools, wiki, permittedWikiSource) {
  if (!uuid.test(root?.id) || root.run_kind != null && root.run_kind !== 'root') throw new Error('invalid_captured_root');
  const requirements = frozenContract(item, scope);
  if (requirements.some(requirement => requirement.policy) && !uuid.test(permittedWikiSource)) throw new Error('invalid_frozen_wiki_source');
  const index = observationIndex(root, runs, tools);
  const raw = parse(root.final_text);
  const shape = hasShape(raw, item.fields);
  const content = shape ? raw : leadingObject(root.final_text);
  const contentShape = hasShape(content, item.fields);
  const checks = requirements.map(requirement => {
    const { key, policy } = requirement;
    const value = content?.fields?.[key];
    const citation = content?.sources?.[key];
    return { key, cited: citation !== null && citation !== undefined,
      ...(policy ? checkPolicy(policy, value, citation, index, wiki, permittedWikiSource) : checkCrm(requirement, value, citation, index)) };
  });
  const counts = { correct: checks.filter(field => field.fieldPassed).length, required: checks.length,
    supported: checks.filter(field => field.supported).length, cited: checks.filter(field => field.cited).length,
    requiredCitations: checks.filter(field => field.needsCitation).length };
  const rejectedTyped = unsupportedTypedEvidence(root, scope, index, wiki, permittedWikiSource);
  const contentPass = contentShape && checks.every(field => field.fieldPassed);
  const citationPass = contentShape && rejectedTyped.length === 0 && checks.every(field => field.needsCitation ? field.supported : !field.cited);
  const limitations = checks.filter(field => field.limitation !== null).map(({ key, limitation }) => ({ key, kind: limitation }));
  const reasonableLimit = contentPass && citationPass && limitations.length > 0;
  const allowPartial = item.allowPartial ?? (item.id === 'M03' && !item.policy);
  const acceptablePartial = root.status === 'partial' && allowPartial && root.error_code === 'missing_material' &&
    reasonableLimit && limitations.some(item => item.kind === 'normal_empty');
  const statusAccepted = root.status === 'completed' && root.error_code == null || acceptablePartial;
  const pass = shape && contentPass && citationPass && statusAccepted;
  let classification;
  if (root.error_code === 'collaboration_review_required') classification = 'review_required';
  else if (checks.some(field => field.reason === 'retrieval_unavailable')) classification = 'retrieval_unavailable';
  else if (pass) classification = reasonableLimit ? 'reasonable_limitation' : 'answered';
  else if (checks.some(field => ['empty_not_verified', 'required_evidence_missing', 'missing_actual_value'].includes(field.reason))) classification = 'missing_required_evidence';
  else if (!shape) classification = 'format_noncompliant';
  else if (!contentPass || !citationPass) classification = 'wrong_or_unsupported';
  else classification = 'run_status_not_accepted';
  return { version: SCORE_VERSION, pass, shape, contentPass, citationPass, reasonableLimit, classification, counts, checks,
    diagnostics: { contentShape, recoveredLeadingObject: !shape && contentShape, limitations, statusAccepted,
      unsupportedTypedEvidence: rejectedTyped,
      unsupportedCitationFields: checks.filter(field => field.cited && !field.supported).map(field => field.key) } };
}
