import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { bytes, digest } from './crm024-fixtures.mjs';
import { probeJudgment } from './crm025-probes.mjs';
import { BASELINE_ARCHIVE, CANDIDATE_INSPECT_DENIAL, CANDIDATE_WORKER_LOSS, SPLITS, planSlots, readFrozenDataset } from './crm025-run-core.mjs';
import { buildIntegrityManifest, projectInspectDenial, sealHoldout, usedSlot } from './crm025-score-seal.mjs';

async function save(path, value) {
  const data = bytes(value);
  await writeFile(path, data);
  return digest(data);
}

async function writeTask(context, slot, options = {}) {
  const { base, fixture, datasetHash } = context;
  const { phase, split, caseId, arm, key, label } = slot;
  const path = kind => resolve(base, phase, split, `${label}-${kind}.json`);
  const historical = context.segments && BASELINE_ARCHIVE[key];
  const freezeHash = options.freezeHash ?? (historical ? context.segments.original.hash : context.freezeHash);
  const safe = options.safe ?? historical?.safe ?? true;
  const denied = caseId === 'H10';
  const category = denied ? 'permission_blocked' : safe ? 'settled' : 'safety_stop';
  const runId = denied ? null : options.runId ?? `${key}-run`;
  const scope = { leadId: `${key}-lead`, contactId: `${key}-contact` };
  const actorUserId = denied ? 'sales' : 'admin';
  fixture.slots[key] = { ...scope, scope, actorUserId, expectedRole: denied ? 'agent' : 'admin' };
  const receipt = { key, freezeHash, runId, httpStatus: denied ? 403 : 201, errorCode: denied ? 'forbidden_role' : null };
  const protection = { safe, environmentValid: true, unchanged: true, actualWrongReturns: options.actualWrongReturns ?? Number(!safe),
    unknownOutcomes: options.unknownOutcomes ?? 0, businessEffects: 0, proposals: 0, ...options.protection };
  const intentHash = await save(path('intent'), { key, freezeHash, datasetHash, scope, actorUserId });
  const receiptHash = await save(path('receipt'), receipt);
  const resultHash = await save(path('result'), { phase, split, caseId, arm, datasetHash, freezeHash, category, runId,
    terminal: denied ? null : 'partial', receipt, protection, snapshot: denied ? null : options.snapshot ?? { outbox: 0 } });
  const meterHash = await save(path('meter'), { key, freezeHash, resultHash, runId, category, safe, environmentValid: true });
  return { intentHash, receiptHash, resultHash, meterHash, runId, safe };
}

async function writeProbe(context, split, caseSpec, probe, idx) {
  const { base, phase, datasetHash, segments } = context;
  const freezeHash = segments?.original.hash ?? context.freezeHash;
  const slot = `${caseSpec.id}-${idx + 1}`;
  const identity = { phase, split, slot, caseId: caseSpec.id, probeNumber: idx + 1, freezeHash, datasetHash };
  const path = kind => resolve(base, phase, split, 'probes', `${slot}-${kind}.json`);
  const intentHash = await save(path('intent'), { ...identity, request: { query: probe.query, top: 5 } });
  const evidence = [];
  const resultHash = await save(path('result'), { ...identity, query: probe.query, intentHash, unsafe: false,
    evidence, score: probeJudgment(probe, evidence) });
  return { slot, intentHash, resultHash };
}

async function setup(t, phase, freezeHash = digest(phase)) {
  const base = await mkdtemp(resolve(tmpdir(), 'crm025-score-seal-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const { dataset, datasetHash } = await readFrozenDataset();
  const segments = phase === 'baseline' ? { original: { hash: digest('original') }, recovery: { hash: digest('recovery') } } : null;
  const context = { base, phase, freezeHash, dataset, datasetHash, segments,
    fixture: { slots: {}, pages: {} }, archivedTasks: {}, archivedProbes: new Map() };
  for (const split of (segments ? SPLITS : ['holdout'])) {
    await mkdir(resolve(base, phase, split, 'probes'), { recursive: true });
    for (const slot of planSlots(dataset, phase, split)) {
      const archive = await writeTask(context, slot);
      if (segments && BASELINE_ARCHIVE[slot.key]) context.archivedTasks[slot.key] = archive;
    }
    const cases = dataset.cases.filter(row => row.split === (split === 'holdout' ? 'evaluation' : 'development'));
    for (const caseSpec of cases) for (const [idx, probe] of caseSpec.retrieval.probes.entries()) {
      const archive = await writeProbe(context, split, caseSpec, probe, idx);
      if (segments && split === 'holdout') context.archivedProbes.set(archive.slot, archive);
    }
  }
  return context;
}

test('baseline index preserves four original roots, one original stop and all 69 original probes', async t => {
  const context = await setup(t, 'baseline');
  const manifest = await buildIntegrityManifest(context);
  const original = context.segments.original.hash;
  assert.equal(manifest.tasks.filter(item => item.freezeHash === original).length, 4);
  assert.equal(manifest.tasks.filter(item => item.freezeHash === context.freezeHash).length, 44);
  assert.equal(manifest.probes.length, 69);
  assert(manifest.probes.every(item => item.freezeHash === original));
  const unsafe = manifest.tasks.filter(item => item.safe === false);
  assert.deepEqual(unsafe.map(item => [item.key, item.category]), [['baseline.D02.disabled', 'safety_stop']]);
  assert.deepEqual(await buildIntegrityManifest(context, true), manifest);

  const incident = planSlots(context.dataset, 'baseline', 'dev').find(item => item.key === unsafe[0].key);
  await writeTask(context, incident, { safe: true });
  await assert.rejects(buildIntegrityManifest(context), /crm025_score_original_archive_changed/);
});

test('original stop never permits an unsafe new development or holdout task', async t => {
  const context = await setup(t, 'baseline');
  const dev = planSlots(context.dataset, 'baseline', 'dev').find(item => item.caseId === 'D03');
  const held = planSlots(context.dataset, 'baseline', 'holdout')[0];
  await writeTask(context, dev, { freezeHash: context.segments.original.hash });
  await assert.rejects(buildIntegrityManifest(context), /crm025_score_task_artifacts_unbound/);
  await writeTask(context, dev, { safe: false });
  await assert.rejects(buildIntegrityManifest(context, true), /crm025_score_task_artifacts_unbound/);
  await writeTask(context, dev);
  await writeTask(context, held, { actualWrongReturns: 1 });
  await assert.rejects(buildIntegrityManifest(context), /crm025_score_task_artifacts_unbound/);
  await writeTask(context, held);
  const probe = resolve(context.base, 'baseline', 'holdout', 'probes', 'H01-1-result.json');
  await writeFile(probe, 'rewritten held probe bytes');
  await assert.rejects(buildIntegrityManifest(context, true), /crm025_score_original_probe_archive_changed/);
});

test('candidate integrity recheck hashes holdout result bytes without consuming quality', async t => {
  const context = await setup(t, 'candidate');
  const manifest = await buildIntegrityManifest(context);
  assert.equal(manifest.tasks.length, 32);
  assert.equal(manifest.probes.length, 48);
  assert.equal(manifest.tasks.filter(item => item.category === 'permission_blocked').length, 2);
  assert.deepEqual(await buildIntegrityManifest(context, true), manifest);

  const probe = resolve(context.base, 'candidate', 'holdout', 'probes', 'H01-1-result.json');
  await writeFile(probe, 'opaque test bytes');
  const changed = await buildIntegrityManifest(context, true);
  assert.equal(changed.probes.find(item => item.slot === 'H01-1').resultHash, digest('opaque test bytes'));
  assert.notDeepEqual(manifest, changed);
  await assert.rejects(buildIntegrityManifest(context), SyntaxError);
});

test('seals the exact reviewed worker loss and grades it without an anonymous packet', async t => {
  const context = await setup(t, 'candidate');
  const slot = planSlots(context.dataset, 'candidate', 'holdout').find(item => item.key === CANDIDATE_WORKER_LOSS.key);
  const artifact = kind => resolve(context.base, 'candidate', 'holdout', `${slot.label}-${kind}.json`);
  const original = await writeTask(context, slot, { safe: false, actualWrongReturns: 0, unknownOutcomes: 3 });
  await assert.rejects(buildIntegrityManifest(context), /crm025_score_task_artifacts_unbound/);
  const value = { ...original, freezeHash: context.freezeHash, key: slot.key };
  context.candidateRecovery = { value, hash: digest(bytes(value)) };

  const manifest = await buildIntegrityManifest(context);
  assert.deepEqual(await buildIntegrityManifest(context, true), manifest);
  assert.equal(manifest.candidateRecoveryHash, context.candidateRecovery.hash);
  assert.equal(manifest.tasks.length, 32);
  assert.equal(manifest.probes.length, 48);
  const incident = manifest.tasks.filter(item => !item.safe);
  assert.deepEqual(incident.map(item => [item.key, item.category, item.classification, item.resultHash, item.meterHash]),
    [[slot.key, 'safety_stop', 'invalid_environment', original.resultHash, original.meterHash]]);
  const receipt = await sealHoldout(context);
  assert.equal(receipt.candidateRecoveryHash, context.candidateRecovery.hash);
  assert.deepEqual(await sealHoldout(context), receipt);

  assert.equal(await usedSlot(context, slot, 'prepare'), false);
  await assert.rejects(readFile(artifact('review-binding')), { code: 'ENOENT' });
  assert.equal(await usedSlot(context, slot, 'grade'), true);
  const grade = JSON.parse(await readFile(artifact('grade')));
  assert.equal(grade.recoveryHash, context.candidateRecovery.hash);
  assert.equal(grade.rawCategory, 'safety_stop');
  assert.equal(grade.rawSafe, false);
  assert.equal(grade.rawHash, original.resultHash);
  assert.equal(grade.scoring.outcome, 'invalid_environment');
  assert.equal(grade.scoring.deliverable, false);
  assert.equal(grade.scoring.counts.facts.correct, null);
  assert.equal(digest(await readFile(artifact('result'))), original.resultHash);
  assert.equal(digest(await readFile(artifact('meter'))), original.meterHash);
});

test('recovery cannot authorize changed bytes, a different freeze, or a second unsafe candidate slot', async t => {
  const context = await setup(t, 'candidate');
  const slots = planSlots(context.dataset, 'candidate', 'holdout');
  const slot = slots.find(item => item.key === CANDIDATE_WORKER_LOSS.key);
  const original = await writeTask(context, slot, { safe: false, actualWrongReturns: 0, unknownOutcomes: 3 });
  const value = { ...original, freezeHash: context.freezeHash, key: slot.key };
  for (const change of [{ resultHash: digest('different result') }, { freezeHash: digest('different freeze') }]) {
    const modified = { ...value, ...change };
    context.candidateRecovery = { value: modified, hash: digest(bytes(modified)) };
    await assert.rejects(buildIntegrityManifest(context, true), /crm025_score_candidate_recovery_unbound/);
  }
  const other = slots.find(item => item.key !== slot.key && item.caseId === slot.caseId);
  await writeTask(context, other, { safe: false });
  context.candidateRecovery = { value, hash: digest(bytes(value)) };
  await assert.rejects(buildIntegrityManifest(context), /crm025_score_task_artifacts_unbound/);
});

test('scores only the exact H11 inspect denial as blocked while keeping the original invalid arm', async t => {
  const { key, runId, freezeHash, toolName, callId, controlText, previousRecoveryHash, proofHash } = CANDIDATE_INSPECT_DENIAL;
  const context = await setup(t, 'candidate', freezeHash);
  const slots = planSlots(context.dataset, 'candidate', 'holdout');
  const slot = slots.find(item => item.key === key);
  const workerLoss = slots.find(item => item.key === CANDIDATE_WORKER_LOSS.key);
  const lost = await writeTask(context, workerLoss, { safe: false, actualWrongReturns: 0, unknownOutcomes: 3 });
  context.candidateRecovery = { hash: previousRecoveryHash, value: { ...lost, key: workerLoss.key, freezeHash } };
  const artifact = kind => resolve(context.base, 'candidate', 'holdout', `${slot.label}-${kind}.json`);
  const { scope, actorUserId } = context.fixture.slots[key];
  const root = { id: runId, actor_user_id: actorUserId, parent_run_id: null, run_kind: 'root', mode: 'inspect', status: 'partial',
    scope, final_text: '确认未安排跟进。' };
  const request = { run_id: runId, call_id: callId, tool: toolName };
  const message = { role: 'tool', toolCallId: callId, toolName, isError: false, content: [{ type: 'text', text: controlText }] };
  const original = await writeTask(context, slot, { safe: false, runId, actualWrongReturns: 0, unknownOutcomes: 1,
    protection: { identity: runId, validArm: false, blockedAttempts: 0, writeAttempts: 1, outboundAttempts: 0,
      toolAudit: [{ run: runId, id: callId, tool: toolName, unknown: true, blocked: false, wrong: false, write: true, outbound: false }] },
    snapshot: { runs: [root], requests: [request], tools: [{ run_id: runId, message }], proposals: 0, outbox: 0,
      events: [{ ...request, event_type: 'tool_completed', status: 'success' }] } });

  await assert.rejects(buildIntegrityManifest(context), /crm025_score_task_artifacts_unbound/);
  const value = { ...original, key, freezeHash, toolName, callId, controlText, previousRecoveryHash, proofHash,
    rawErrorFlag: false, rawEventStatus: 'success', validArm: false };
  const recovery = { value, hash: digest(bytes(value)) };
  context.candidateRecovery.h11 = recovery;
  const manifest = await buildIntegrityManifest(context);
  assert.deepEqual(await buildIntegrityManifest(context, true), manifest);
  assert.equal(manifest.tasks.length, 32);
  assert.equal(manifest.probes.length, 48);
  const classified = manifest.tasks.filter(item => item.classification);
  assert.deepEqual(classified.map(item => [item.key, item.safe, item.category, item.classification]), [
    [workerLoss.key, false, 'safety_stop', 'invalid_environment'], [slot.key, false, 'safety_stop', 'settled'],
  ]);
  const receipt = await sealHoldout(context);
  assert.equal(receipt.candidateRecoveryHash, previousRecoveryHash);
  assert.equal(receipt.candidateH11RecoveryHash, recovery.hash);

  const raw = await readFile(artifact('result'));
  const view = projectInspectDenial(raw, value);
  assert.equal(view.protection.unknownOutcomes, 0);
  assert.equal(view.protection.blockedAttempts, 1);
  assert.equal(view.protection.writeAttempts, 1);
  assert.equal(view.protection.validArm, false);
  assert.deepEqual(view.snapshot.events, JSON.parse(raw).snapshot.events);
  assert.throws(() => projectInspectDenial(raw, { ...value, callId: 'different' }), /crm025_score_inspect_denial_unbound/);
  const altered = bytes({ ...JSON.parse(raw), protection: { ...JSON.parse(raw).protection, unknownOutcomes: 2 } });
  assert.throws(() => projectInspectDenial(altered, { ...value, resultHash: digest(altered) }), /crm025_score_inspect_denial_unbound/);

  const reviews = resolve(context.base, 'reviews');
  await mkdir(reviews);
  assert.equal(await usedSlot(context, slot, 'prepare'), true);
  const binding = JSON.parse(await readFile(artifact('review-binding')));
  assert.equal(binding.recoveryHash, recovery.hash);
  const packet = JSON.parse(await readFile(resolve(reviews, `${binding.reviewId}-packet.json`)));
  assert.deepEqual(packet.receipts, [{ tool: toolName, status: 'denied', reason: 'inspect_only_policy' }]);
  const votes = (rows, verdict) => rows.map(({ id }) => ({ id, verdict, quote: null, reason: 'test evidence', citations: [] }));
  await save(resolve(reviews, `${binding.reviewId}-review.json`), { version: packet.version, reviewId: packet.reviewId,
    packetHash: packet.packetHash, reviewerType: 'agent', facts: votes(packet.facts, 'fail'),
    recommendations: votes(packet.recommendations, 'fail'), forbidden: votes(packet.forbidden, 'pass'),
    extraClaims: { outcome: 'pass', reason: 'test evidence', findings: [] } });
  assert.equal(await usedSlot(context, slot, 'grade'), true);
  const grade = JSON.parse(await readFile(artifact('grade')));
  assert.equal(grade.recoveryHash, recovery.hash);
  assert.equal(grade.rawCategory, 'safety_stop');
  assert.equal(grade.rawSafe, false);
  assert.equal(grade.scoring.comparisonEligible, false);
  assert.equal(grade.scoring.protection.verdict, 'pass');
  assert.equal(digest(await readFile(artifact('result'))), original.resultHash);
  assert.equal(digest(await readFile(artifact('meter'))), original.meterHash);
});
