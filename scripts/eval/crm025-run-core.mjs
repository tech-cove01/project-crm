import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { bytes, digest, read, ROOT, sha, uuid } from './crm024-fixtures.mjs';

export const BASE = resolve(ROOT, '.local/crm025');
export const BASELINE = '2d5d411223e68fef47a41c064040baf6d7c4056d';
export const SAFETY_BASELINE = '59da3c47b8272fb89795445abdb115011cf91f6a';
export const DATASET_HASH = '590763cfffe722245effda31516e880e617fc0cf10351d98c28c89d18690f5ac';
export const PHASES = ['baseline', 'candidate'];
export const SPLITS = ['dev', 'holdout'];
export const ARMS = ['disabled', 'auto'];
export const ROLES = ['customer_evidence', 'opportunity_diagnosis', 'policy_advisor'];
export const MODEL = { provider: 'dashscope', model: 'qwen3.8-flash', temperature: 0, maxSteps: 12, tokenBudget: 36_000 };
export const LIMITS = { slots: 96, specialists: 144, reportedTokens: 4_000_000, reserve: 72_000 };
export const TERMINAL = new Set(['completed', 'partial', 'failed', 'cancelled', 'awaiting_confirmation']);
export const ORIGINAL_FREEZE_HASH = '1430c9c6ef5b7777e4bba0dfa8ca6985dd9ec56475b0405e9ce865755d7da709';
export const SAFETY_FREEZE_FILE = resolve(BASE, 'baseline', 'safety-freeze.json');
export const SCOPE_REPLAY_FILE = resolve(BASE, 'resume', 'scope-replay.json');
export const BASELINE_ARCHIVE = Object.freeze({
  'baseline.D01.disabled': Object.freeze({
    safe: true,
    intentHash: '4241bda78b0e0ca60d58ceee9c9d8c9af3e3b8a520ec852c302af87fdf1e97e0',
    receiptHash: '12f988893480ddac56a2b65d0a0dc51c85ab4f555b7975cac26a6bb607148ba7',
    resultHash: 'd3dd51e1e3e2b186bd176313730e7e6640a30d2890ff792145075879e2a7aaae',
    meterHash: '363146ec918687bee6d381d53bdfcf4b1f5d59136098ca8370ce43ffb390975e',
  }),
  'baseline.D01.auto': Object.freeze({
    safe: true,
    intentHash: '08a5c679ac31237b0bdc4b1f6ba082bd561e8d8895a3b73198337e20fa6b4fc6',
    receiptHash: '9d6feb7b37fbb1ada6ac51812ef98d3d2ff052a93daf4081be01e22500f493f9',
    resultHash: 'f74aa2be861c8adb4f54fb75b8f6da4836b9e37b4d7806b1beca527fb937fa55',
    meterHash: '4bece1e369c66a17a8064fb30d49356de0a655aed7d135c95bba907ba9ad2f8d',
  }),
  'baseline.D02.auto': Object.freeze({
    safe: true,
    intentHash: '7780308cd3095417e5b26cff595ad6ea988d2d6bf3ac796bdd3e2f80a541bc30',
    receiptHash: '49e1eed79c132cb694d81482e27f3b8dd48e879cf6530a2bdf26c1842e4f4c20',
    resultHash: 'ddfb218584d30791dbf4dff3d3994b69f877f22f24789c36469c68578c14a3fe',
    meterHash: 'd220bb0dd4eb443269364be33c51555075e8e647fe3f98b201b02ad1a9883347',
  }),
  'baseline.D02.disabled': Object.freeze({
    safe: false,
    intentHash: 'ef644d2cb0b8b8eba4449a6941bc3d1e81e1a003d9ee4d6aa516b6f066385eb2',
    receiptHash: '5ff5395fed31487d81b6e1a97fa93a622d57240b20a0402d7b65be8ce5c46ee1',
    resultHash: '629e40884ebdd6a5185d7018a056921fdac7189ffbe04f27e590068893d00cfb',
    meterHash: '973b93c3fda749a8990c8ff1e7e8cb3f4ba1662896c0674fd4c43e981eddae93',
  }),
});
const runtimePaths = ['app', 'lib', 'workers', 'supabase', 'pnpm-lock.yaml', 'package.json', 'next.config.ts', 'proxy.ts'];
const sharedSafetyPaths = ['lib/agent-engine/edge/crm/mcp-tools.ts', 'lib/ai/runtime/tools.ts', 'lib/ai/runtime/workbench-target-scope.ts'];

const git = (...args) => execFileSync('git', args, {
  cwd: ROOT, encoding: 'utf8', timeout: 15000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
}).trim();
const treeHash = ref => digest(git('ls-tree', '-r', '-z', ref, '--', ...runtimePaths));

export function product(phase, frozenCommit) {
  assert(PHASES.includes(phase), 'crm025_invalid_phase');
  const commit = git('rev-parse', 'HEAD');
  assert(!git('status', '--porcelain', '--untracked-files=all', '--', ...runtimePaths), 'crm025_product_tree_dirty');
  const hash = treeHash(commit);
  if (phase === 'baseline') {
    assert.equal(hash, treeHash(SAFETY_BASELINE), 'crm025_product_safety_baseline_mismatch');
    return { commit, hash, productCommit: SAFETY_BASELINE };
  }
  assert(hash !== treeHash(BASELINE) && hash !== treeHash(SAFETY_BASELINE) &&
    !git('diff', '--name-only', SAFETY_BASELINE, commit, '--', ...sharedSafetyPaths), 'crm025_candidate_common_safety_changed');
  if (frozenCommit !== undefined) {
    assert(/^[a-f0-9]{40}$/.test(frozenCommit) && treeHash(frozenCommit) === hash, 'crm025_candidate_product_commit_changed');
  }
  return { commit, hash, productCommit: frozenCommit ?? commit };
}

export async function readFrozenDataset() {
  const raw = await readFile(resolve(ROOT, 'docs/evaluation/CRM-025-cases.json'));
  const datasetHash = digest(raw);
  assert.equal(datasetHash, DATASET_HASH, 'crm025_frozen_dataset_changed');
  const dataset = JSON.parse(raw);
  assert(dataset.baselineCommit === BASELINE && dataset.cases.length === 24 &&
    dataset.cases.filter(item => item.split === 'development').length === 8 &&
    dataset.cases.filter(item => item.split === 'evaluation').length === 16 &&
    new Set(dataset.cases.map(item => item.id)).size === 24 && dataset.cases.every(item => item.mode === 'inspect'),
  'crm025_frozen_case_shape');
  return { dataset, datasetHash };
}

export function planSlots(dataset, phase, split) {
  assert(PHASES.includes(phase) && SPLITS.includes(split), 'crm025_invalid_batch');
  return dataset.cases.filter(item => item.split === (split === 'dev' ? 'development' : 'evaluation')).flatMap((item, index) => {
    const arms = (index + Number(phase === 'candidate')) % 2 === 0 ? ARMS : [...ARMS].reverse();
    return arms.map(arm => ({ phase, split, caseId: item.id, arm, label: `${item.id}-${arm}`, key: `${phase}.${item.id}.${arm}` }));
  });
}

export function safetySlots(dataset, split) {
  return planSlots(dataset, 'baseline', split).filter(slot => !Object.hasOwn(BASELINE_ARCHIVE, slot.key));
}

export async function read025OriginalFreeze() {
  const frozen = await read(resolve(BASE, 'baseline', 'freeze.json'), ORIGINAL_FREEZE_HASH);
  assert(frozen.phase === 'baseline' && frozen.productCommit === BASELINE && frozen.productHash === treeHash(BASELINE) &&
    frozen.datasetHash === DATASET_HASH && sha.test(frozen.fixtureHash), 'crm025_original_freeze_changed');
  return { hash: ORIGINAL_FREEZE_HASH, frozen };
}

export async function read025OriginalMeters() {
  return Promise.all(Object.entries(BASELINE_ARCHIVE).map(async ([key, hashes]) => {
    const [, caseId, arm] = key.split('.');
    const file = kind => resolve(BASE, 'baseline', 'dev', `${caseId}-${arm}-${kind}.json`);
    const [intent, receipt, result, meter] = await Promise.all([
      read(file('intent'), hashes.intentHash), read(file('receipt'), hashes.receiptHash),
      readFile(file('result')), read(file('meter'), hashes.meterHash),
    ]);
    assert(digest(result) === hashes.resultHash && meter.resultHash === hashes.resultHash &&
      [intent, receipt, meter].every(item => item.key === key && item.freezeHash === ORIGINAL_FREEZE_HASH) &&
      uuid.test(meter.runId) && meter.runId === receipt.runId && receipt.httpStatus === 201 &&
      meter.safe === hashes.safe && meter.category === (hashes.safe ? 'settled' : 'safety_stop'), 'crm025_original_execution_record_changed');
    return meter;
  }));
}

export function verifyScopeReplay(value, expected) {
  const checks = ['broadNotMounted', 'broadDirectDenied', 'otherObjectDenied', 'selectedReadable', 'followupExact', 'followupNoFallback', 'unscopedReadable'];
  const counts = ['roots_and_children', 'jobs', 'models', 'proposals', 'outbox'];
  assert(value?.version === 1 && value.productCommit === SAFETY_BASELINE && value.databaseId === expected.databaseId &&
    value.fixtureHash === expected.fixtureHash && value.originalFixtureHash === expected.originalFixtureHash &&
    value.fixtureVerified === true && value.scopeVerified === true && value.noModel === true &&
    uuid.test(value.requestId) && sha.test(value.auditHash) && value.blockedAuditCount === 5 && value.replayTokenRevoked === true &&
    counts.every(name => Number.isSafeInteger(value.countBefore?.[name]) && value.countBefore[name] >= 0) &&
    same(value.countBefore, value.countAfter) &&
    checks.every(name => value.checks?.[name] === true), 'crm025_scope_replay_not_verified');
}

export function verifyRecoveredMaterials(original, recovered) {
  assert(['org', 'databaseId', 'slots', 'pages', 'sourceIds', 'businessClock', 'candidatePool', 'actorScopes']
    .every(key => same(original[key], recovered[key])) && original.agent.promptHash === recovered.agent.promptHash &&
    same(original.agent.toolIds, recovered.agent.toolIds) && same(original.agent.modelParameters, recovered.agent.modelParameters),
  'crm025_recovery_changed_original_materials');
}

/** Offline mapping for scoring and the cumulative ledger. Original probes keep the original freeze. */
export async function read025BaselineSegments(safetyFreezeHash) {
  assert(sha.test(safetyFreezeHash), 'crm025_safety_freeze_hash_required');
  const [original, frozen, { dataset }, meters] = await Promise.all([
    read025OriginalFreeze(), read(SAFETY_FREEZE_FILE, safetyFreezeHash), readFrozenDataset(), read025OriginalMeters(),
  ]);
  const previous = frozen.previous;
  assert(frozen.phase === 'baseline' && frozen.segment === 'safe' && frozen.productCommit === SAFETY_BASELINE &&
    frozen.productHash === treeHash(SAFETY_BASELINE) && frozen.datasetHash === DATASET_HASH && original.frozen.ruleHash === frozen.ruleHash &&
    previous?.originalFreezeHash === original.hash && sha.test(previous.recoveryHash) && sha.test(frozen.fixtureHash) &&
    SPLITS.every(split => same(frozen.slots[split], safetySlots(dataset, split))), 'crm025_safety_freeze_unbound');
  const [fixture, old, value] = await Promise.all([
    read(resolve(BASE, 'fixtures-recovered.json'), frozen.fixtureHash),
    read(resolve(BASE, 'fixtures.json'), original.frozen.fixtureHash), read(SCOPE_REPLAY_FILE, previous.recoveryHash),
  ]);
  verifyRecoveredMaterials(old, fixture);
  verifyScopeReplay(value, { fixtureHash: frozen.fixtureHash, originalFixtureHash: original.frozen.fixtureHash, databaseId: old.databaseId });
  return { original, safety: { hash: safetyFreezeHash, frozen }, recovery: { hash: previous.recoveryHash, value }, meters };
}

export function advanceLedgerSlot(firstUnused, key, hash, datasetHash, scope, { intent, meter, receipt, resultExists }) {
  if (!intent) {
    assert(!meter && !receipt && !resultExists, 'crm025_result_without_intent');
    return firstUnused ?? key;
  }
  assert(firstUnused === null && hash && meter?.safe === true && sha.test(meter.resultHash) && resultExists &&
    [intent, meter, receipt].every(row => row?.freezeHash === hash && row.key === key) &&
    intent.datasetHash === datasetHash && intent.actorUserId === scope.actorUserId && same(intent.scope, scope.scope) &&
    ['input', 'output', 'specialists', 'unknownInputRows', 'unknownOutputRows'].every(field => Number.isSafeInteger(meter[field]) && meter[field] >= 0) &&
    (meter.category === 'permission_blocked' ? scope.expectedHttpStatus === 403 && receipt.httpStatus === 403 &&
      receipt.errorCode === 'forbidden_role' && meter.runId === null && receipt.runId === null :
      ['settled', 'invalid_environment'].includes(meter.category) && uuid.test(meter.runId) && (!receipt.runId || meter.runId === receipt.runId)),
  'crm025_unreconciled_or_unsafe_execution');
  return null;
}

export function verifySlotMap(dataset, fixture) {
  const slots = PHASES.flatMap(phase => SPLITS.flatMap(split => planSlots(dataset, phase, split)));
  assert.equal(Object.keys(fixture.slots).length, LIMITS.slots, 'crm025_slot_count_changed');
  for (const item of slots) {
    const slot = fixture.slots[item.key];
    const permissionCase = dataset.cases.find(row => row.id === item.caseId).business.actorRole === 'sales';
    assert(slot && slot.key === item.key && slot.phase === item.phase && slot.caseId === item.caseId && slot.arm === item.arm &&
      [slot.contactId, slot.leadId, slot.pipelineId, slot.actorUserId, slot.stageId].every(id => uuid.test(id)) &&
      slot.scope?.leadId === slot.leadId && slot.scope.contactId === slot.contactId && slot.scope.pipelineId === slot.pipelineId &&
      !slot.scope.conversationId && slot.preState && slot.actor === (permissionCase ? 'sales' : 'initiator') &&
      slot.expectedHttpStatus === (permissionCase ? 403 : 201), 'crm025_fixture_slot_mismatch');
  }
  for (const field of ['contactId', 'leadId']) {
    assert.equal(new Set(Object.values(fixture.slots).map(slot => slot[field])).size, LIMITS.slots, 'crm025_fixture_scope_reuse');
  }
}

export function reserveSlot(meters, arm) {
  const used = meters.reduce((total, row) => ({ slots: total.slots + 1, roots: total.roots + Number(!!row.runId),
    specialists: total.specialists + row.specialists, input: total.input + row.input, output: total.output + row.output,
    unknownInputRows: total.unknownInputRows + row.unknownInputRows, unknownOutputRows: total.unknownOutputRows + row.unknownOutputRows,
  }), { slots: 0, roots: 0, specialists: 0, input: 0, output: 0, unknownInputRows: 0, unknownOutputRows: 0 });
  assert(used.slots < LIMITS.slots && used.roots < LIMITS.slots &&
    used.specialists + (arm === 'auto' ? ROLES.length : 0) <= LIMITS.specialists &&
    used.input + used.output + LIMITS.reserve < LIMITS.reportedTokens, 'crm025_batch_budget_exhausted');
  return used;
}

export function payloadHash(payload) {
  return digest(bytes(payload));
}
