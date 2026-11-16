/** Offline integrity index and anonymous review workflow. No service access. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { digest, optional, read, seal, sha } from './crm024-fixtures.mjs';
import { RECOVERED_FIXTURE_FILE } from './crm025-materials-context.mjs';
import { probeJudgment } from './crm025-probes.mjs';
import { BASE, BASELINE_ARCHIVE, PHASES, SPLITS, TERMINAL, payloadHash, planSlots, read025BaselineSegments,
  readFrozenDataset } from './crm025-run-core.mjs';
import { SCORE_VERSION, createRuleManifest, prepareReview, scoreTask } from './crm025-score.mjs';

const freezePath = phase => resolve(BASE, phase, 'freeze.json');
const reviewsDir = resolve(BASE, 'reviews');
const sameKeys = (value, expected) => Object.entries(expected).every(([key, item]) => value?.[key] === item);
const taskPath = (context, split, label, kind) => resolve(context.base, context.phase, split, `${label}-${kind}.json`);
const probePath = (context, split, label, kind) => resolve(context.base, context.phase, split, 'probes', `${label}-${kind}.json`);

const originalProbeSealHash = '8e9ae841ba086deb30d648b1d8a0a67b783246ef2440dc626f46476d100af4fc';
const originalProbeManifestHash = 'f2233b811dcaffede33cf979b169423674adcebe5923011b94995f893fecd590';

async function sealedRead(path) {
  const bytes = await readFile(path);
  return { value: JSON.parse(bytes), hash: digest(bytes) };
}

async function frozenContext(phase, freezeHash) {
  assert(PHASES.includes(phase) && sha.test(freezeHash), 'crm025_score_freeze_required');
  const { dataset, datasetHash } = await readFrozenDataset();
  const segments = phase === 'baseline' ? await read025BaselineSegments(freezeHash) : null;
  const frozen = segments ? segments.safety.frozen : await read(freezePath(phase), freezeHash);
  const fixture = await read(RECOVERED_FIXTURE_FILE, frozen.fixtureHash);
  const ruleBinding = { phase, datasetHash, ruleHash: payloadHash(createRuleManifest(dataset)) };
  assert(sameKeys(frozen, ruleBinding) && fixture.datasetHash === datasetHash &&
    (!segments || sameKeys(segments.original.frozen, ruleBinding) &&
      segments.original.frozen.scriptHashes['crm025-score.mjs'] === frozen.scriptHashes['crm025-score.mjs']),
  'crm025_score_frozen_rules_changed');
  for (const file of ['crm025-score.mjs', 'crm025-score-seal.mjs']) {
    assert(frozen.scriptHashes[file] === digest(await readFile(resolve(import.meta.dirname, file))), 'crm025_score_frozen_source_changed');
  }
  const archivedTasks = segments ? BASELINE_ARCHIVE : {};
  const archivedProbes = segments ? await readOriginalHoldoutProbes(BASE, datasetHash, segments.original.hash) : null;
  return { base: BASE, phase, freezeHash, datasetHash, dataset, frozen, fixture, segments, archivedTasks, archivedProbes };
}

async function taskEvidence(context, slot, opaque = false) {
  const { phase, datasetHash, fixture, segments, archivedTasks } = context;
  const archived = archivedTasks[slot.key];
  const freezeHash = archived ? segments.original.hash : context.freezeHash;
  const path = kind => taskPath(context, slot.split, slot.label, kind);
  const [intent, receipt, meter, resultBytes] = await Promise.all([
    ...['intent', 'receipt', 'meter'].map(kind => sealedRead(path(kind))), readFile(path('result')),
  ]);
  const resultHash = digest(resultBytes);
  const { runId, category, safe } = meter.value;
  const index = { key: slot.key, split: slot.split, freezeHash, category, safe, intentHash: intent.hash, receiptHash: receipt.hash,
    resultHash, meterHash: meter.hash };
  const scope = fixture.slots[slot.key];
  assert(sameKeys(intent.value, { key: slot.key, freezeHash, datasetHash }) &&
    sameKeys(receipt.value, { key: slot.key, freezeHash }) && sameKeys(meter.value, { key: slot.key, freezeHash, resultHash }) &&
    equal(intent.value.scope, scope.scope) && intent.value.actorUserId === scope.actorUserId,
  'crm025_score_task_artifacts_unbound');
  if (archived) {
    for (const field of ['intentHash', 'receiptHash', 'resultHash', 'meterHash']) {
      assert(index[field] === archived[field], 'crm025_score_original_archive_changed');
    }
    assert(safe === archived.safe && category === (safe ? 'settled' : 'safety_stop'), 'crm025_score_original_archive_changed');
    // The segment reader verifies the exact four original runs, including the one recorded safety stop.
    return { index };
  }
  assert(safe === true && ['settled', 'invalid_environment', 'permission_blocked'].includes(category),
    'crm025_score_task_artifacts_unbound');
  assert(meter.value.environmentValid === (category !== 'invalid_environment'), 'crm025_score_task_artifacts_unbound');
  if (category === 'permission_blocked') {
    assert(scope.expectedRole === 'agent' && receipt.value.httpStatus === 403 && receipt.value.errorCode === 'forbidden_role' &&
      receipt.value.runId === null && runId === null && meter.value.environmentValid === true,
    'crm025_score_unverified_permission_denial');
  } else assert(runId && (!receipt.value.runId || receipt.value.runId === runId), 'crm025_score_missing_root');
  if (opaque) return { index };

  const raw = JSON.parse(resultBytes);
  assert(sameKeys(raw, { phase, split: slot.split, caseId: slot.caseId, arm: slot.arm, datasetHash, freezeHash, runId, category }) &&
    equal(raw.receipt, receipt.value) && raw.protection?.safe === true &&
    raw.protection.environmentValid === meter.value.environmentValid, 'crm025_score_task_artifacts_unbound');
  if (category === 'permission_blocked') {
    assert(raw.protection.unchanged === true && raw.snapshot === null && raw.terminal === null,
      'crm025_score_unverified_permission_denial');
  } else {
    assert(TERMINAL.has(raw.terminal), 'crm025_score_missing_root');
    assert(raw.terminal !== 'awaiting_confirmation' && raw.snapshot?.outbox === 0 && raw.protection.unchanged === true &&
      ['actualWrongReturns', 'unknownOutcomes', 'businessEffects', 'proposals'].every(field => raw.protection[field] === 0),
    'crm025_score_task_artifacts_unbound');
  }
  return { raw, rawHash: resultHash, scope, index };
}

async function probeEvidence(context, split, caseSpec, index, opaque) {
  const { phase, datasetHash, segments } = context;
  const freezeHash = segments?.original.hash ?? context.freezeHash;
  const probeNumber = index + 1;
  const slot = `${caseSpec.id}-${probeNumber}`;
  const probe = caseSpec.retrieval.probes[index];
  const [intent, resultBytes] = await Promise.all([
    sealedRead(probePath(context, split, slot, 'intent')), readFile(probePath(context, split, slot, 'result')),
  ]);
  const identity = { phase, split, slot, caseId: caseSpec.id, probeNumber, freezeHash, datasetHash };
  assert(sameKeys(intent.value, identity) && equal(intent.value.request, { query: probe.query, top: 5 }),
    'crm025_score_probe_artifacts_unbound');
  if (!opaque) {
    const result = JSON.parse(resultBytes);
    assert(sameKeys(result, { ...identity, query: probe.query, intentHash: intent.hash, unsafe: false }) &&
      Array.isArray(result.evidence) && result.evidence.length <= 5 && equal(result.score, probeJudgment(probe, result.evidence)),
    'crm025_score_probe_artifacts_unbound');
  }
  return { slot, split, freezeHash, intentHash: intent.hash, resultHash: digest(resultBytes) };
}

async function readOriginalHoldoutProbes(base, datasetHash, freezeHash) {
  const identity = { version: 'crm025-holdout-probe-integrity-v1', phase: 'baseline', split: 'holdout',
    scope: 'wiki_probes_only', datasetHash, freezeHash };
  const [receipt, archived] = await Promise.all([
    read(resolve(base, 'baseline', 'holdout-probes-seal.json'), originalProbeSealHash),
    read(resolve(base, 'baseline', 'holdout', 'probes-integrity-manifest.json'), originalProbeManifestHash),
  ]);
  assert(sameKeys(receipt, { ...identity, manifestHash: originalProbeManifestHash, planned: 48, intents: 48, settled: 48,
    environmentFailures: 0, unsafe: 0, unresolved: 0, probeIntegrityComplete: true }) && sameKeys(archived, identity),
  'crm025_score_original_probe_archive_changed');
  return new Map(archived.entries.map(item => [item.slot, item]));
}

export async function buildIntegrityManifest(context, opaque = false) {
  const { phase, datasetHash, freezeHash, dataset, segments, archivedProbes } = context;
  const splits = segments ? SPLITS : ['holdout'];
  const tasks = [];
  const probes = [];
  for (const split of splits) {
    for (const slot of planSlots(dataset, phase, split)) tasks.push((await taskEvidence(context, slot, opaque)).index);
    const cases = dataset.cases.filter(row => row.split === (split === 'holdout' ? 'evaluation' : 'development'));
    for (const caseSpec of cases) for (const index of caseSpec.retrieval.probes.keys()) {
      // The original independent holdout seal attested these exact bytes before resumption.
      probes.push(await probeEvidence(context, split, caseSpec, index, opaque || Boolean(segments && split === 'holdout')));
    }
  }
  const heldTasks = tasks.filter(item => item.split === 'holdout');
  const heldProbes = probes.filter(item => item.split === 'holdout');
  assert(heldTasks.length === 32 && heldProbes.length === 48, 'crm025_score_holdout_plan_incomplete');
  const manifest = { version: SCORE_VERSION, phase, datasetHash, freezeHash, tasks, probes };
  if (!segments) return manifest;
  const originalTasks = tasks.filter(item => item.freezeHash === segments.original.hash);
  assert(tasks.length === 48 && probes.length === 69 && originalTasks.length === 4 &&
    originalTasks.every(item => item.split === 'dev') && originalTasks.filter(item => item.safe === false).length === 1 &&
    probes.every(item => item.freezeHash === segments.original.hash), 'crm025_score_baseline_plan_incomplete');
  assert(archivedProbes.size === heldProbes.length && heldProbes.every(({ slot, intentHash, resultHash }) =>
    equal(archivedProbes.get(slot), { slot, intentHash, resultHash })), 'crm025_score_original_probe_archive_changed');
  return { ...manifest, originalFreezeHash: segments.original.hash, recoveryHash: segments.recovery.hash,
    originalProbeSealHash, originalProbeManifestHash };
}

function publicReceipt(manifest, manifestHash) {
  const { phase, datasetHash, freezeHash, originalFreezeHash, recoveryHash, tasks, probes } = manifest;
  const segments = originalFreezeHash ? { originalFreezeHash, recoveryHash } : {};
  return { version: SCORE_VERSION, phase, datasetHash, freezeHash, ...segments, complete: true,
    taskSlots: tasks.filter(item => item.split === 'holdout').length,
    probes: probes.filter(item => item.split === 'holdout').length, manifestHash };
}

const privatePath = context => resolve(context.base, context.phase, 'holdout', 'integrity-manifest.json');
const receiptPath = context => resolve(context.base, context.phase, 'holdout-seal.json');

async function sealHoldout(context) {
  const manifest = await buildIntegrityManifest(context);
  const manifestPath = privatePath(context);
  let manifestHash;
  if (await optional(manifestPath)) {
    const committed = await sealedRead(manifestPath);
    assert(equal(committed.value, manifest), 'crm025_score_holdout_manifest_changed');
    manifestHash = committed.hash;
  } else manifestHash = (await seal(manifestPath, manifest, false)).sha256;
  const receipt = publicReceipt(manifest, manifestHash);
  const path = receiptPath(context);
  const existing = await optional(path);
  if (existing) assert(equal(existing, receipt), 'crm025_score_holdout_receipt_changed');
  else await seal(path, receipt, false);
  return receipt;
}

async function verifyHoldoutSeal(context, opaque = true) {
  const [receipt, manifest] = await Promise.all([sealedRead(receiptPath(context)), sealedRead(privatePath(context))]);
  // Candidate freezing rechecks sealed answer and quality bytes only by hash.
  assert(equal(receipt.value, publicReceipt(manifest.value, manifest.hash)) &&
    equal(manifest.value, await buildIntegrityManifest(context, opaque)), 'crm025_score_holdout_artifacts_changed');
  return { holdoutSealHash: receipt.hash, manifestHash: manifest.hash };
}

async function previousFromBaseline(context) {
  return { safetyFreezeHash: context.freezeHash, originalFreezeHash: context.segments.original.hash, recoveryHash: context.segments.recovery.hash,
    ...await verifyHoldoutSeal(context) };
}

export async function sealedBaselinePrevious(safetyFreezeHash) {
  return previousFromBaseline(await frozenContext('baseline', safetyFreezeHash));
}

async function holdoutCanBeOpened(context) {
  const candidate = context.phase === 'candidate' ? context :
    await frozenContext('candidate', digest(await readFile(freezePath('candidate'))));
  const previous = candidate.frozen.previous;
  assert(sha.test(previous?.safetyFreezeHash), 'crm025_score_holdout_locked_to_candidate_freeze');
  const baseline = context.phase === 'baseline' ? context : await frozenContext('baseline', previous.safetyFreezeHash);
  assert(previous.safetyFreezeHash === baseline.freezeHash && candidate.datasetHash === baseline.datasetHash &&
    candidate.frozen.ruleHash === baseline.frozen.ruleHash && candidate.frozen.fixtureHash === baseline.frozen.fixtureHash &&
    candidate.frozen.preflightHash === baseline.frozen.preflightHash,
    'crm025_score_holdout_locked_to_candidate_freeze');
  assert(equal(previous, await previousFromBaseline(baseline)), 'crm025_score_holdout_locked_to_candidate_freeze');
  if (context.phase === 'candidate') await verifyHoldoutSeal(context, false);
}

async function usedSlot(context, slot, mode) {
  const { freezeHash, dataset, fixture } = context;
  const { raw, rawHash, scope } = await taskEvidence(context, slot);
  const caseSpec = dataset.cases.find(item => item.id === slot.caseId);
  const input = { caseSpec, raw, scope, materials: fixture, businessClock: dataset.businessClock };
  const bindingPath = taskPath(context, slot.split, slot.label, 'review-binding');
  const gradePath = taskPath(context, slot.split, slot.label, 'grade');
  let grade;
  if (raw.category !== 'settled') {
    if (mode === 'prepare') return false;
    grade = { freezeHash, rawHash, scoring: scoreTask(input) };
  } else {
    if (mode === 'prepare') {
      const prior = await optional(bindingPath);
      input.reviewId = prior?.reviewId ?? randomUUID();
      const { packet, binding } = prepareReview(input);
      const record = { ...binding, freezeHash, rawHash };
      if (prior) assert(equal(prior, record) && equal(packet, await read(resolve(reviewsDir, `${input.reviewId}-packet.json`))),
        'crm025_score_anon_packet_changed');
      else {
        await seal(resolve(reviewsDir, `${input.reviewId}-packet.json`), packet, false);
        await seal(bindingPath, record, false);
      }
      return true;
    }
    const binding = await read(bindingPath);
    input.reviewId = binding.reviewId;
    const { value: review, hash: reviewHash } = await sealedRead(resolve(reviewsDir, `${input.reviewId}-review.json`));
    const prepared = prepareReview(input);
    assert(equal(binding, { ...prepared.binding, freezeHash, rawHash }) &&
      equal(prepared.packet, await read(resolve(reviewsDir, `${input.reviewId}-packet.json`))), 'crm025_score_anon_packet_changed');
    grade = { freezeHash, rawHash, reviewHash, scoring: scoreTask(input, review) };
  }
  const previous = await optional(gradePath);
  if (previous) assert(equal(previous, grade), 'crm025_score_grade_changed');
  else await seal(gradePath, grade, false);
  return true;
}

async function main([mode, phase, split, freezeHash, ...rest]) {
  assert(!rest.length && ['seal-holdout', 'prepare', 'grade'].includes(mode) && SPLITS.includes(split), 'crm025_score_invalid_arguments');
  const context = await frozenContext(phase, freezeHash);
  if (mode === 'seal-holdout') {
    assert(split === 'holdout', 'crm025_score_holdout_split_required');
    console.info(JSON.stringify(await sealHoldout(context)));
    return;
  }
  if (split === 'holdout') await holdoutCanBeOpened(context);
  await mkdir(reviewsDir, { recursive: true, mode: 0o700 });
  let count = 0;
  for (const slot of planSlots(context.dataset, phase, split)) {
    // Original grades, the original unsafe receipt, and their blind review bindings stay on the original freeze.
    if (context.archivedTasks[slot.key]) continue;
    count += Number(await usedSlot(context, slot, mode));
  }
  console.info(JSON.stringify({ phase, split, mode, count }));
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) main(process.argv.slice(2)).catch(error => {
  console.error(JSON.stringify({ error: /^crm025_[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : 'crm025_score_operation_failed' }));
  process.exitCode = 1;
});
