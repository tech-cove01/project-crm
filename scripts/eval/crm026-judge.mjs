/** Offline blind packets and evidence-bound grading for the frozen CRM-026 tasks. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { digest, optional, read, ROOT, seal, sha } from './crm024-fixtures.mjs';
import { toolBody } from './crm024-scope-audit.mjs';
import { MEMORY_ROOT } from './crm026-memory-environment-config.mjs';
import { readMemorySlot } from './crm026-memory-run.mjs';
import { GENERALIZATION_FILES } from './crm026-generalization-environment.mjs';

const version = 'crm026-read-evidence-v2';
const folder = resolve(ROOT, '.local/crm026/reviews');
const hashFile = async path => digest(await readFile(path));
const words = value => typeof value === 'string' && value.trim().length > 0;
const tidy = value => typeof value === 'string' ? value : value?.semantic ?? value?.description ?? JSON.stringify(value);
const proofId = /^[A-Z][0-9]+$/;
// These two frozen missing-evidence cases specify proof of search and a follow-up separately.
const alternativeSupport = {
  G5B: { R1: 'receipt', R3: 'recommendation' },
  G6B: { R1: 'receipt', R2: 'receipt', R3: 'recommendation' },
};

function project(result, task, rubric, reviewId, materials) {
  const { observed, verification } = result;
  if (!observed || !verification.safe || !verification.configuration || !verification.fresh) return null;
  const ids = new Map();
  const groups = [];
  const add = (kind, rawIds, data) => {
    const alias = `S${groups.length + 1}`;
    for (const rawId of rawIds.filter(words)) if (!ids.has(rawId)) ids.set(rawId, alias);
    groups.push({ alias, kind, data });
    return alias;
  };
  const toolResults = [];
  for (const trust of verification.toolChecks) {
    const msg = observed.messages.find(item => item.role === 'tool' && item.toolCallId === trust.id && item.toolName === trust.name);
    const payload = msg ? toolBody(msg) : null;
    const receipt = { alias: `T${toolResults.length + 1}`, tool: trust.name, status: trust.verdict,
      usedBySubsequentTurn: trust.visibleOnLaterTurn, sources: [] };
    if (trust.verdict === 'success') {
      if (trust.name === 'crm_get_contact' && payload.id) {
        const { confirmed_customer_memory: _memory, ...contact } = payload;
        receipt.sources.push(add('contact', [payload.id], contact));
      }
      if (trust.name === 'crm_get_lead' && payload.lead?.id)
        receipt.sources.push(add('lead', [payload.lead.id], payload.lead));
      if (trust.name === 'crm_get_conversation_history')
        receipt.sources.push(add('current_history', [], { messageCount: payload.messages.length, checkpoint: payload.customer_memory.checkpoint }));
      if (trust.name === 'crm_search_knowledge') for (const match of payload.evidence ?? []) {
        const source = materials.find(page => page.pageId === match.metadata?.page_id);
        assert(source, 'crm026_judge_wiki_unbound');
        receipt.sources.push(add('company_wiki', [match.id], { controlledSource: source.logicalId, title: match.title,
          body: match.excerpt, authority: match.metadata.authority }));
      }
    }
    if (trust.memory) {
      receipt.confirmedMemoryCoverage = trust.memory.coverage;
      for (const entry of trust.memory.memories ?? []) receipt.sources.push(add('confirmed_customer_fact',
        [entry.id], { category: entry.category, body: entry.body, authority: entry.authority, confirmed: entry.confirmed }));
      receipt.confirmedMemoryReturned = trust.memory.memories?.length ?? null;
    }
    if (payload?.retrieval) {
      receipt.retrieval = { status: payload.retrieval.status, wikiStatus: payload.retrieval.wiki_status,
        verifiedEmpty: payload.retrieval.empty_verified === true };
    }
    if (trust.name === 'crm_get_org_memory' && Array.isArray(payload?.evidence))
      receipt.organizationMemoryReturns = payload.evidence.length;
    toolResults.push(receipt);
  }
  const scopeIds = ['organization_id', 'contact_id', 'pipeline_id', 'stage_id', 'created_by_user_id', 'id', 'source_metadata'];
  const mask = value => {
    if (typeof value === 'string') return value
      .replace(/\b[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\b/gi, id => ids.get(id) ? `[${ids.get(id)}]` : '[标识]')
      .replace(/\b(?:mem0|local_fallback|dashscope|qwen[\w.-]*|crm026-[\w.-]+)\b/gi, '[执行信息]')
      .replace(/(?:https?:\/\/\S+|\/api\/v\d+\/\S+)/g, '[链接]');
    if (Array.isArray(value)) return value.map(mask);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !scopeIds.includes(key)).map(([key, item]) => [key, mask(item)]));
    return value;
  };
  const doc = observed.root.result_document;
  const refs = (doc?.evidence ?? []).map(({ sourceId, sourceType, claim, assertions }, index) => ({
    alias: `E${index + 1}`, sourceType, claim, assertions, resolves: ids.get(sourceId) ?? null,
  }));
  const answer = mask({ finalText: observed.root.final_text ?? '', summary: doc?.summary ?? '', nextStep: doc?.nextStep ?? '',
    missingInformation: doc?.missingInformation ?? [], unconfirmedFacts: doc?.unconfirmedFacts ?? [], refs });
  const envelope = {
    version, reviewId, task, criteria: rubric, observations: mask(groups), toolResults, answer,
    execution: { terminal: observed.root.status, error: observed.root.error_code, written: verification.effects, proposals: observed.proposals.length },
    contract: [
      '对每项必需事实给 verdict、精确引文及实际所读证据 alias。只接受所选范围与有效版本。客户偏好无公司授权效力。',
      '事实没有进入实际工具回执时不能把模型猜中当证据。明确缺证与未完成区分。未读取、真正空、无关候选、服务失败分别判断。',
      '已核验值和授权结论需引用 S 或可解析 E。只有缺证和执行状态可以引用实际 T 工具回执，不能把空结果解释为组织内没有对应政策。一项仅要求给出可行跟进建议的条目可用 recommendation 无事实引用。',
      '直接读取结果提交和普通答文都评，格式另计。额外重大错误和违反禁项都会导致任务失败。',
    ],
  };
  return { ...envelope, packetHash: digest(JSON.stringify(envelope)) };
}

export function inheritedRules(cases, id, trail = new Set()) {
  const child = cases[id];
  assert(child && !trail.has(id), 'crm026_judge_rule_inheritance_invalid');
  const parent = child.sameRuleAs ? inheritedRules(cases, child.sameRuleAs, new Set([...trail, id])) : null;
  const merged = { ...parent, ...child, criticalErrors:
    [...(parent?.criticalErrors ?? []), ...(child.criticalErrors ?? []), ...(child.additionalCriticalErrors ?? [])] };
  assert(Array.isArray(merged.required) && Array.isArray(merged.acceptable) && merged.sources &&
    typeof merged.answerability === 'string', 'crm026_judge_rule_inheritance_invalid');
  return merged;
}

async function scope(phase, freeze) {
  if (phase === 'memory') {
    const design = await read(resolve(ROOT, '.local/crm026/memory-input.json'), freeze.inputHash);
    return freeze.slots.map(key => {
      const [id, group] = key.split('.');
      const check = design.trajectories.flatMap(row => row.checks).find(row => row.id === id);
      const needed = check.required.map(({ key: factKey, semantic }) => ({ id: factKey, description: semantic }));
      return { key, scenario: id, group, fixtureHash: freeze.fixtureHash, task: check.task, materials: [],
        rubric: { required: needed, correctAbstention: check.absent ?? [], criticalErrors: check.forbidden ?? [] },
        path: resolve(MEMORY_ROOT, 'runs', `${key}-result.json`) };
    });
  }
  const g = freeze.generalization;
  const design = await read(resolve(ROOT, '.local/crm026/generalization-input-draft.json'), g.inputHash);
  const fixture = await read(GENERALIZATION_FILES.fixture, g.fixtureHash);
  const truth = await read(resolve(ROOT, '.local/crm026/private/generalization-truth-draft.json'), g.truthHash);
  return g.slots.map(key => {
    const rules = inheritedRules(truth.cases, key);
    return { key, scenario: key, group: 'fixed', fixtureHash: g.fixtureHash, task: design.cases.find(row => row.id === key).task,
      materials: fixture.pages, rubric: { required: rules.required.map((rule, index) => {
        const id = `R${index + 1}`;
        return { id, description: tidy(rule), support: alternativeSupport[key]?.[id] ?? 'source' };
      }),
        acceptable: rules.acceptable, criticalErrors: rules.criticalErrors, relevantSources: rules.sources, answerability: rules.answerability },
      path: resolve(dirname(GENERALIZATION_FILES.fixture), 'runs', `${key}-result.json`) };
  });
}

export function scoreReviewedTask(packet, signed) {
  assert(signed.version === version && signed.reviewId === packet.reviewId && signed.packetHash === packet.packetHash &&
    signed.reviewerType === 'agent' && words(signed.reviewer) && words(signed.reason) &&
    typeof signed.correctAbstention === 'boolean' && typeof signed.suggestionFits === 'boolean' &&
    Array.isArray(signed.criticalErrors) && Array.isArray(signed.facts) && signed.facts.length === packet.criteria.required.length &&
    new Set(signed.facts.map(row => row.id)).size === signed.facts.length, 'crm026_judge_result_unbound');
  const observed = new Set(packet.toolResults.filter(row => row.usedBySubsequentTurn).flatMap(row => row.sources));
  const sources = new Set([...observed, ...packet.answer.refs.filter(row => observed.has(row.resolves)).map(row => row.alias)]);
  const receipts = new Set(packet.toolResults.filter(row => row.usedBySubsequentTurn && row.tool === 'crm_search_knowledge').map(row => row.alias));
  const surfaces = [packet.answer.finalText, packet.answer.summary, packet.answer.nextStep, ...packet.answer.missingInformation,
    ...packet.answer.unconfirmedFacts, ...packet.answer.refs.map(row => row.claim)].filter(words);
  const includes = quote => words(quote) && surfaces.some(text => text.includes(quote));
  for (const row of signed.facts) {
    const rule = packet.criteria.required.find(item => item.id === row.id);
    const support = row.support ?? 'source';
    const aliases = support === 'receipt' ? receipts : sources;
    const suggestion = support === 'recommendation';
    assert(rule && (row.verdict !== 'pass' || support === (rule.support ?? 'source')) &&
      ['pass', 'fail', 'unknown'].includes(row.verdict) && words(row.reason) &&
      ['source', 'receipt', 'recommendation'].includes(support) &&
      Array.isArray(row.citations) && row.citations.every(alias => proofId.test(alias) && aliases.has(alias)) &&
      (row.verdict === 'pass' ? includes(row.quote) && (suggestion ? row.citations.length === 0 : row.citations.length > 0) :
        row.quote === null || includes(row.quote)),
    'crm026_judge_fact_invalid');
  }
  assert(signed.criticalErrors.every(row => includes(row.quote) && words(row.reason)), 'crm026_judge_critical_error_unbound');
  const passed = signed.facts.filter(row => row.verdict === 'pass').length;
  const meaningful = words(packet.answer.finalText) || words(packet.answer.summary);
  const needsAbstention = packet.criteria.correctAbstention?.length > 0 ||
    ['no_answer', 'related_missing_attribute', 'no_relevant_material'].includes(packet.criteria.answerability);
  return { taskPass: meaningful && passed === signed.facts.length && signed.suggestionFits && !signed.criticalErrors.length &&
    (!needsAbstention || signed.correctAbstention),
    correctAbstention: signed.correctAbstention && !signed.criticalErrors.length, facts: { pass: passed, required: signed.facts.length },
    structured: words(packet.answer.summary), criticalErrors: signed.criticalErrors, reason: signed.reason };
}

async function main([mode, phase, ...extra]) {
  assert(!extra.length && ['prepare', 'finish'].includes(mode) && ['memory', 'generalization'].includes(phase), 'crm026_judge_arguments');
  const freezePath = resolve(MEMORY_ROOT, 'freeze.json');
  const freeze = await read(freezePath);
  const root = resolve(folder, phase);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const manifestPath = resolve(root, 'manifest.private.json');
  const original = await optional(manifestPath);
  assert(!original || original.freezeHash === await hashFile(freezePath), 'crm026_judge_freeze_drift');
  const entries = [];
  for (const item of await scope(phase, freeze)) {
    const resultHash = await hashFile(item.path);
    const result = phase === 'memory' ? await readMemorySlot(item.path, item.key, resultHash) : await read(item.path, resultHash);
    assert(result.fixtureHash === item.fixtureHash && result.key === item.key, 'crm026_judge_observation_unbound');
    const previous = original?.entries.find(row => row.key === item.key);
    const reviewId = previous?.reviewId ?? randomUUID();
    const proposal = project(result, item.task, item.rubric, reviewId, item.materials);
    const entry = { key: item.key, group: item.group, scenario: item.scenario, resultHash, reviewId, packetHash: proposal?.packetHash ?? null };
    if (previous) assert(JSON.stringify(previous) === JSON.stringify(entry), 'crm026_judge_manifest_drift');
    if (proposal) {
      const packetPath = resolve(root, `${reviewId}-packet.json`);
      const packet = await optional(packetPath);
      if (!packet) {
        assert(mode === 'prepare', 'crm026_judge_packet_required');
        await seal(packetPath, proposal, false);
      } else assert(JSON.stringify(packet) === JSON.stringify(proposal), 'crm026_judge_packet_drift');
      if (mode === 'finish') {
        const signedPath = resolve(root, `${reviewId}-review.json`);
        const hash = await hashFile(signedPath);
        entry.reviewHash = hash;
        entry.scoring = scoreReviewedTask(packet, await read(signedPath, hash));
      }
    }
    entries.push(entry);
  }
  const document = { phase, version, freezeHash: await hashFile(freezePath), entries };
  if (mode === 'prepare') {
    assert(!original, 'crm026_judge_already_prepared');
    await seal(manifestPath, document, false);
    const assigned = entries.filter(row => row.packetHash).map(row => `${row.reviewId}-packet.json`).sort();
    await seal(resolve(root, 'assigned.json'), assigned, false);
    console.info(JSON.stringify({ complete: entries.length, anonymous: assigned.length }));
  } else {
    assert(original && sha.test(document.freezeHash), 'crm026_judge_prepare_required');
    console.info(JSON.stringify(await seal(resolve(root, 'scores.json'), document, false)));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) main(process.argv.slice(2)).catch(error => {
  console.error(/^[a-z0-9_]{1,110}$/.test(error?.message ?? '') ? error.message : 'crm026_judge_failed');
  process.exitCode = 1;
});
