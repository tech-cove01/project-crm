import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  arms, budget, businessDate, calibrationIds, cases, fixtures, formalIds, legacyIds,
  model, taskFor, templateScope, wikiPages,
} from './crm024-cases.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const protocolPath = '.local/crm024/protocol.json';
const prior = '.local/crm023';
const priorFormal = `${prior}/paired/formal`;
const legacyReportHashes = {
  'S02-disabled': '98ce05c218931789e3428a08686f83ba601bd0e5153612ac2857088ca51d181d',
  'S02-auto': '520076920aac2f4637f90e09956742982e5316513f15a4179e6b774800c1813d',
  'C01-disabled': '0dac5fc85d1a944a14042c13f3a4210b03c2e014826989cc46d6260adfca158c',
  'C01-auto': 'e89794ad30ca3e82f10a2593a4613a157783c472fe95086d9132ea6a2a5b8012',
};
const sourceFiles = [
  'crm024-cases.mjs', 'crm024-freeze.mjs', 'crm024-score.mjs', 'crm024-score.test.mjs',
  'crm023-cases.mjs', 'crm023-score.mjs', 'crm022-paired-cases.mjs',
].map(file => `scripts/eval/${file}`);
const stages = { qualification: '需求确认', proposal: '方案拟定' };

export const serialized = value => JSON.stringify(value, null, 2) + '\n';
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function readJson(path, expectedHash) {
  const bytes = readFileSync(resolve(repo, path));
  const sha256 = digest(bytes);
  assert(!expectedHash || sha256 === expectedHash, 'crm024_legacy_artifact_hash_mismatch');
  return { data: JSON.parse(bytes), sha256 };
}

function toolResult(entry) {
  const content = entry.message.content;
  const text = typeof content === 'string' ? content : content.filter(part => part.type === 'text').map(part => part.text).join('\n');
  return JSON.parse(text);
}

export function verifyLegacyEvidence() {
  const oldProtocol = readJson(`${prior}/protocol.json`, 'ec9e764283fa17f4eb2e868192a52b0f390634aa555a3f7e4487d4a0bd8873dc');
  const oldFreeze = readJson(`${priorFormal}/frozen.json`, 'a3d5a97a95c7d48b555bcb7738448b24f698305d5ed4562a2cb016f955a613a9');
  const oldFixtures = readJson(`${priorFormal}/fixtures.json`, '51a1fb89a66ad37920b568ab090c64e708343176debeacbab2298b978f0682e6');
  assert.equal(oldFreeze.data.protocolHash, oldProtocol.sha256, 'crm024_legacy_protocol_binding_mismatch');
  assert.equal(oldFreeze.data.fixtureHash, oldFixtures.sha256, 'crm024_legacy_fixture_binding_mismatch');
  const observations = {};
  for (const id of legacyIds) {
    const definition = oldProtocol.data.taskDefinitions[id];
    assert.equal(taskFor(cases[id], templateScope), definition.promptTemplate, 'crm024_legacy_prompt_changed');
    assert.equal(serialized(cases[id].oracle), serialized({ ...definition.oracle, kind: 'simple' }), 'crm024_legacy_oracle_changed');
    for (const arm of arms) {
      const label = `${id}-${arm}`;
      const scope = oldFixtures.data.cases[label];
      const intent = readJson(`${priorFormal}/${label}-intent.json`);
      const report = readJson(`${priorFormal}/${label}-result.json`, legacyReportHashes[label]);
      const scoped = { leadId: scope.leadId, contactId: scope.contactId, pipelineId: scope.pipelineId };
      const payload = { agentId: oldFreeze.data.config.agent.id, task: taskFor(cases[id], scope),
        mode: 'inspect', collaboration: arm, scope: scoped };
      assert.equal(intent.data.protocolHash, oldProtocol.sha256, 'crm024_legacy_intent_protocol_mismatch');
      assert.equal(intent.data.freezeHash, oldFreeze.sha256, 'crm024_legacy_intent_freeze_mismatch');
      assert.equal(digest(serialized(payload)), intent.data.payloadHash, 'crm024_legacy_intent_payload_changed');
      const result = report.data;
      assert(result.settled && result.unchanged && result.sameExecution && result.validArm && result.proposals === 0 &&
        result.freezeHash === oldFreeze.sha256 && result.label === label, 'crm024_legacy_result_binding_mismatch');
      const root = result.snapshot.runs.find(run => run.id === result.runId && run.parent_run_id === null);
      assert(root && root.mode === 'inspect' && root.collaboration === arm && root.scope?.leadId === scope.leadId &&
        root.scope?.contactId === scope.contactId && root.scope?.pipelineId === scope.pipelineId, 'crm024_legacy_scope_mismatch');
      const policy = result.snapshot.runs.find(run => run.parent_run_id === root.id && run.specialist_key === 'policy_advisor');
      const policyReads = policy ? result.snapshot.tools.filter(item => item.run_id === policy.id).map(entry => ({
        tool: entry.message.toolName, retrieval: toolResult(entry).retrieval,
      })) : [];
      if (arm === 'auto') {
        assert(result.status === 'partial' && result.errorCode === 'collaboration_review_required' && !result.pass &&
          root.result_document === null && policy?.status === 'partial' && policy.specialist_usage?.modelTurns === 3 &&
          policy.specialist_missing?.includes('required_policy_evidence') && policyReads.length === 2 &&
          policyReads.some(item => item.tool === 'crm_search_knowledge' && item.retrieval?.wiki_status === 'empty' &&
            item.retrieval?.empty_verified === true) &&
          policyReads.some(item => item.tool === 'crm_get_org_memory' && item.retrieval?.status === 'empty'),
        'crm024_legacy_wrong_block_not_proved');
      } else {
        assert(result.status === 'completed' && result.pass && root.result_document && !policy, 'crm024_legacy_single_control_not_proved');
      }
      observations[label] = {
        intentSha256: intent.sha256, payloadHash: intent.data.payloadHash, resultSha256: report.sha256,
        scope, materialHash: oldFixtures.data.objects[label].materialHash, runId: root.id,
        status: result.status, errorCode: result.errorCode, delivered: root.result_document !== null, strictPass: result.pass,
        ...(policy ? { policy: { runId: policy.id, status: policy.status, usage: policy.specialist_usage,
          missing: policy.specialist_missing, reads: policyReads } } : {}),
      };
    }
    assert.equal(observations[`${id}-disabled`].materialHash, observations[`${id}-auto`].materialHash, 'crm024_legacy_material_mismatch');
  }
  return { protocolSha256: oldProtocol.sha256, freezeSha256: oldFreeze.sha256, fixtureSha256: oldFixtures.sha256, observations };
}

function checkComplex(item, promptTemplate) {
  const fixture = fixtures[item.fixtureKey];
  const { facts, criteria, allowPartial } = item.oracle;
  const definitions = new Map(facts.map(fact => [fact.id, fact.observation]));
  const covered = new Set(criteria.flatMap(rule => rule.facts));
  const checkedQueries = new Map(item.wikiChecks.map(check => [check.query, check]));
  assert(fixture && Object.hasOwn(stages, fixture.stageKey) && fixture.confirmedFacts.length > 0 && fixture.confirmedFacts.length <= 8,
    'crm024_invalid_sql_fixture');
  assert(!promptTemplate.includes('企业知识搜索词') && !promptTemplate.includes('请取得实际依据并回答：') &&
    !promptTemplate.includes('[CRM-') && !promptTemplate.includes('纯 JSON'), 'crm024_generated_prompt_leaked_runtime_marker');
  assert(definitions.size === facts.length && covered.size === definitions.size && [...covered].every(id => definitions.has(id)),
    'crm024_rubric_fact_coverage_mismatch');
  assert(new Set(criteria.map(rule => rule.id)).size === criteria.length && criteria.some(rule => rule.kind === 'forbidden') &&
    criteria.some(rule => rule.kind === 'recommendation') && (!allowPartial || criteria.some(rule => rule.kind === 'limitation')) &&
    criteria.every(rule => rule.kind === 'forbidden' ? rule.facts.length === 0 : rule.facts.length > 0), 'crm024_incomplete_rubric');
  const kinds = new Set(facts.map(fact => fact.observation.type));
  assert(['lead', 'customer_memory', 'wiki'].every(kind => kinds.has(kind)) && criteria.some(rule =>
    new Set(rule.facts.map(id => definitions.get(id).type)).size > 1), 'crm024_missing_cross_source_criterion');
  for (const { observation } of facts) {
    const { type, body, query, pageSlug, anchor } = observation;
    if (type === 'customer_memory') {
      assert(fixture.confirmedFacts.some(fact => fact.body === body) && !promptTemplate.includes(body), 'crm024_memory_missing_or_leaked');
    } else if (type === 'wiki') {
      assert(checkedQueries.get(query)?.pageSlugs.includes(pageSlug) && wikiPages.some(page =>
        page.query === query && page.slug === pageSlug && page.body.includes(anchor)) && !promptTemplate.includes(anchor),
      'crm024_wiki_fact_missing_or_leaked');
    } else if (type === 'wiki_empty') {
      assert(checkedQueries.get(query)?.pageSlugs.length === 0 && checkedQueries.get(query)?.emptyVerified === true &&
        !wikiPages.some(page => page.body.includes(query)) && allowPartial, 'crm024_invalid_verified_empty_case');
    } else {
      const { field, value } = observation;
      const expected = {
        description: fixture.legacyNote, value_cents: fixture.valueCents, expected_close_date: fixture.expectedCloseDate,
        stage_id: { $scope: 'stageId' }, status: 'open',
      };
      assert(type === 'lead' && Object.hasOwn(expected, field) && serialized(value) === serialized(expected[field]) &&
        (typeof value === 'object' || !promptTemplate.includes(String(value))), 'crm024_lead_fact_missing_or_leaked');
    }
  }
}

function pairs(ids) {
  return ids.map((id, index) => ({ id, order: index % 2 ? [...arms].reverse() : [...arms] }));
}

export function createProtocol() {
  const all = [...calibrationIds, ...formalIds];
  assert(all.length === 7 && new Set(all).size === all.length && Object.keys(cases).length === all.length,
    'crm024_case_matrix_mismatch');
  assert(new Set(wikiPages.map(page => page.slug)).size === wikiPages.length &&
    new Set(wikiPages.map(page => page.query)).size === wikiPages.length, 'crm024_wiki_topics_not_distinct');
  const frozenCases = Object.fromEntries(all.map(id => {
    const { task, ...item } = cases[id];
    assert.equal(item.phase, calibrationIds.includes(id) ? 'calibration' : 'formal', 'crm024_phase_mismatch');
    const promptTemplate = taskFor(cases[id], templateScope);
    if (item.oracle.kind === 'complex') {
      assert(task.length > 0, 'crm024_empty_complex_task');
      checkComplex(item, promptTemplate);
    }
    return [id, { ...item, promptTemplate }];
  }));
  return {
    version: 'crm024-v1', scoreVersion: 'crm024-rubric-v1', handoff: '5cde2ff', mode: 'inspect',
    businessDate, model, budget, arms, calibrationIds, formalIds, legacyIds,
    pairs: { calibration: pairs(calibrationIds), formal: pairs(formalIds) }, cases: frozenCases,
    materials: { fixtures, wikiPages, stages }, legacy: verifyLegacyEvidence(),
    sourceHashes: Object.fromEntries(sourceFiles.map(path => [path, digest(readFileSync(resolve(repo, path)))])),
  };
}

function main() {
  const args = process.argv.slice(2);
  assert(args.length === 0 || args.length === 1 && ['--check', '--verify'].includes(args[0]), 'crm024_freeze_usage');
  const bytes = serialized(createProtocol());
  const target = resolve(repo, protocolPath);
  if (args[0] === '--verify') {
    assert(bytes === readFileSync(target, 'utf8'), 'crm024_frozen_protocol_changed');
  } else if (!args.length) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
  }
  console.info(JSON.stringify({ protocol: protocolPath, sha256: digest(bytes),
    action: args[0] ?? 'frozen', cases: 7, legacyIntentsVerified: 4, modelRoots: 0 }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
