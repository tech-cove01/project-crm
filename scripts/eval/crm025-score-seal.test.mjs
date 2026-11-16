import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { bytes, digest } from './crm024-fixtures.mjs';
import { probeJudgment } from './crm025-probes.mjs';
import { BASELINE_ARCHIVE, SPLITS, planSlots, readFrozenDataset } from './crm025-run-core.mjs';
import { buildIntegrityManifest } from './crm025-score-seal.mjs';

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
  const runId = denied ? null : `${key}-run`;
  const scope = { leadId: `${key}-lead`, contactId: `${key}-contact` };
  const actorUserId = denied ? 'sales' : 'admin';
  fixture.slots[key] = { scope, actorUserId, expectedRole: denied ? 'agent' : 'admin' };
  const receipt = { key, freezeHash, runId, httpStatus: denied ? 403 : 201, errorCode: denied ? 'forbidden_role' : null };
  const protection = { safe, environmentValid: true, unchanged: true, actualWrongReturns: options.actualWrongReturns ?? Number(!safe),
    unknownOutcomes: 0, businessEffects: 0, proposals: 0 };
  const intentHash = await save(path('intent'), { key, freezeHash, datasetHash, scope, actorUserId });
  const receiptHash = await save(path('receipt'), receipt);
  const resultHash = await save(path('result'), { phase, split, caseId, arm, datasetHash, freezeHash, category, runId,
    terminal: denied ? null : 'partial', receipt, protection, snapshot: denied ? null : { outbox: 0 } });
  const meterHash = await save(path('meter'), { key, freezeHash, resultHash, runId, category, safe, environmentValid: true });
  return { intentHash, receiptHash, resultHash, meterHash, safe };
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

async function setup(t, phase) {
  const base = await mkdtemp(resolve(tmpdir(), 'crm025-score-seal-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const { dataset, datasetHash } = await readFrozenDataset();
  const segments = phase === 'baseline' ? { original: { hash: digest('original') }, recovery: { hash: digest('recovery') } } : null;
  const context = { base, phase, freezeHash: digest(phase), dataset, datasetHash, segments,
    fixture: { slots: {} }, archivedTasks: {}, archivedProbes: new Map() };
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
