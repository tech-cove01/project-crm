/** Offline integrity index and anonymous review workflow. No service access. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { digest, optional, read, seal, sha } from './crm024-fixtures.mjs';
import { probeJudgment } from './crm025-probes.mjs';
import { BASE, PHASES, SPLITS, payloadHash, planSlots, readFrozenDataset } from './crm025-run-core.mjs';
import { SCORE_VERSION, createRuleManifest, prepareReview, scoreTask } from './crm025-score.mjs';

const freezePath = phase => resolve(BASE, phase, 'freeze.json');
const scoreDir = (phase, split) => resolve(BASE, phase, split);
const reviewsDir = resolve(BASE, 'reviews');
const sameKeys = (value, expected) => Object.entries(expected).every(([key, item]) => value?.[key] === item);
const taskPath = (phase, split, label, kind) => resolve(scoreDir(phase, split), `${label}-${kind}.json`);
const probePath = (phase, split, label, kind) => resolve(scoreDir(phase, split), 'probes', `${label}-${kind}.json`);

async function sealedRead(path) {
  const bytes = await readFile(path);
  return { value: JSON.parse(bytes), hash: digest(bytes) };
}

async function frozenContext(phase, freezeHash) {
  assert(PHASES.includes(phase) && sha.test(freezeHash), 'crm025_score_freeze_required');
  const [{ dataset, datasetHash }, frozen] = await Promise.all([readFrozenDataset(), read(freezePath(phase), freezeHash)]);
  const fixture = await read(resolve(BASE, 'fixtures.json'), frozen.fixtureHash);
  assert(frozen.phase === phase && frozen.datasetHash === datasetHash && fixture.datasetHash === datasetHash &&
    frozen.ruleHash === payloadHash(createRuleManifest(dataset)), 'crm025_score_frozen_rules_changed');
  for (const file of ['crm025-score.mjs', 'crm025-score-seal.mjs']) {
    assert(frozen.scriptHashes[file] === digest(await readFile(resolve(import.meta.dirname, file))), 'crm025_score_frozen_source_changed');
  }
  return { phase, freezeHash, datasetHash, dataset, frozen, fixture };
}

async function taskEvidence(context, slot) {
  const { phase, freezeHash, datasetHash, fixture } = context;
  const path = kind => taskPath(phase, slot.split, slot.label, kind);
  const [intent, receipt, result, meter] = await Promise.all(['intent', 'receipt', 'result', 'meter'].map(kind => sealedRead(path(kind))));
  const expected = { phase, split: slot.split, caseId: slot.caseId, arm: slot.arm, datasetHash, freezeHash };
  const raw = result.value;
  const scope = fixture.slots[slot.key];
  assert(sameKeys(raw, expected) && sameKeys(intent.value, { key: slot.key, freezeHash, datasetHash }) &&
    sameKeys(receipt.value, { key: slot.key, freezeHash }) && sameKeys(meter.value, { key: slot.key, freezeHash,
      resultHash: result.hash, runId: raw.runId, category: raw.category, safe: true }) &&
    equal(intent.value.scope, scope.scope) && intent.value.actorUserId === scope.actorUserId && equal(raw.receipt, receipt.value) &&
    ['settled', 'invalid_environment', 'permission_blocked'].includes(raw.category) && raw.protection?.safe === true,
  'crm025_score_task_artifacts_unbound');
  if (raw.category !== 'permission_blocked') assert(raw.terminal && raw.runId && (!receipt.value.runId || receipt.value.runId === raw.runId),
    'crm025_score_missing_root');
  else assert(raw.protection.unchanged === true && raw.protection.environmentValid === true && scope.expectedRole === 'agent' &&
    receipt.value.httpStatus === 403 && receipt.value.errorCode === 'forbidden_role' && raw.runId == null && raw.snapshot == null,
  'crm025_score_unverified_permission_denial');
  return { raw, rawHash: result.hash, scope, index: { key: slot.key, intentHash: intent.hash, receiptHash: receipt.hash,
    resultHash: result.hash, meterHash: meter.hash } };
}

async function probeEvidence(context, split, caseSpec, index) {
  const { phase, datasetHash, freezeHash } = context;
  const probeNumber = index + 1;
  const slot = `${caseSpec.id}-${probeNumber}`;
  const probe = caseSpec.retrieval.probes[index];
  const [intent, result] = await Promise.all(['intent', 'result'].map(kind => sealedRead(probePath(phase, split, slot, kind))));
  const identity = { phase, split, slot, caseId: caseSpec.id, probeNumber, freezeHash, datasetHash };
  assert(sameKeys(intent.value, identity) && equal(intent.value.request, { query: probe.query, top: 5 }) &&
    sameKeys(result.value, { ...identity, query: probe.query, intentHash: intent.hash, unsafe: false }) &&
    Array.isArray(result.value.evidence) && result.value.evidence.length <= 5 &&
    equal(result.value.score, probeJudgment(probe, result.value.evidence)), 'crm025_score_probe_artifacts_unbound');
  return { slot, resultHash: result.hash, intentHash: intent.hash };
}

async function holdoutManifest(context) {
  const { phase, datasetHash, freezeHash, dataset } = context;
  const slots = planSlots(dataset, phase, 'holdout');
  const held = dataset.cases.filter(row => row.split === 'evaluation');
  const tasks = [];
  const probes = [];
  for (const slot of slots) tasks.push((await taskEvidence(context, slot)).index);
  for (const caseSpec of held) for (const index of caseSpec.retrieval.probes.keys()) {
    probes.push(await probeEvidence(context, 'holdout', caseSpec, index));
  }
  assert(tasks.length === 32 && probes.length === 48, 'crm025_score_holdout_plan_incomplete');
  return { version: SCORE_VERSION, phase, datasetHash, freezeHash, tasks, probes };
}

function publicReceipt(manifest, manifestHash) {
  return { version: SCORE_VERSION, phase: manifest.phase, datasetHash: manifest.datasetHash, freezeHash: manifest.freezeHash,
    complete: true, taskSlots: manifest.tasks.length, probes: manifest.probes.length, manifestHash };
}

async function sealHoldout(context) {
  const manifest = await holdoutManifest(context);
  const privatePath = resolve(scoreDir(context.phase, 'holdout'), 'integrity-manifest.json');
  const previous = await optional(privatePath);
  const committed = previous ? await sealedRead(privatePath) : await seal(privatePath, manifest, false);
  if (previous) assert(equal(previous, manifest), 'crm025_score_holdout_manifest_changed');
  const receipt = publicReceipt(manifest, committed.hash ?? committed.sha256);
  const path = resolve(BASE, context.phase, 'holdout-seal.json');
  const existing = await optional(path);
  if (existing) assert(equal(existing, receipt), 'crm025_score_holdout_receipt_changed');
  else await seal(path, receipt, false);
  return receipt;
}

async function holdoutCanBeOpened(context) {
  const baseReceipt = await sealedRead(resolve(BASE, 'baseline', 'holdout-seal.json'));
  const candidate = await read(freezePath('candidate'));
  assert(candidate.previous?.holdoutSealHash === baseReceipt.hash && candidate.previous.freezeHash === baseReceipt.value.freezeHash &&
    candidate.datasetHash === context.datasetHash && candidate.ruleHash === context.frozen.ruleHash,
  'crm025_score_holdout_locked_to_candidate_freeze');
  const { value: receipt } = await sealedRead(resolve(BASE, context.phase, 'holdout-seal.json'));
  const privatePath = resolve(scoreDir(context.phase, 'holdout'), 'integrity-manifest.json');
  const manifest = await read(privatePath, receipt.manifestHash);
  assert(equal(manifest, await holdoutManifest(context)) && equal(receipt, publicReceipt(manifest, receipt.manifestHash)),
    'crm025_score_holdout_artifacts_changed');
}

async function usedSlot(context, slot, mode) {
  const { phase, freezeHash, dataset, fixture } = context;
  const { raw, rawHash, scope } = await taskEvidence(context, slot);
  const caseSpec = dataset.cases.find(item => item.id === slot.caseId);
  const input = { caseSpec, raw, scope, materials: fixture, businessClock: dataset.businessClock };
  const bindingPath = taskPath(phase, slot.split, slot.label, 'review-binding');
  const gradePath = taskPath(phase, slot.split, slot.label, 'grade');
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
  for (const slot of planSlots(context.dataset, phase, split)) count += Number(await usedSlot(context, slot, mode));
  console.info(JSON.stringify({ phase, split, mode, count }));
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) main(process.argv.slice(2)).catch(error => {
  console.error(JSON.stringify({ error: /^crm025_[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : 'crm025_score_operation_failed' }));
  process.exitCode = 1;
});
