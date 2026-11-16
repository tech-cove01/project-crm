/** Append a CRM-025 answer review using archived local data exclusively. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { bytes, digest, optional, read, seal } from './crm024-fixtures.mjs';
import { BASE, readFrozenDataset } from './crm025-run-core.mjs';
import { makeScopeTask } from './crm025-materials-context.mjs';
import { frozenContext, projectInspectDenial, projectRecordedInspectDenial } from './crm025-score-seal.mjs';
import { scoreTask } from './crm025-score.mjs';
import { bindMetadataOpinion, metadataAddendum, rescoreTask, reviewTriggers, REVIEW_VERSION, supplementalReview } from './crm026-review-rules.mjs';
import { selectCollaborationPlan } from '../../lib/ai/agents/collaboration.ts';

const originalHash = '39a3579b920cc3efd70163d06bfc489df3e9631117bb36fe0c4310506c442fb6';
const output = resolve(BASE, 'review-v2');
const privatePath = resolve(output, 'private');
const artifacts = (reviewId, kind) => resolve(output, `${reviewId}-${kind}.json`);
const metadataArtifacts = (reviewId, kind) => resolve(output, 'metadata', `${reviewId}-${kind}.json`);
const reviewKey = row => `${row.phase}.${row.caseId}.${row.arm}`;

async function openCorpus() {
  const comparison = await read(resolve(BASE, 'comparison.json'), originalHash);
  const { dataset, datasetHash } = await readFrozenDataset();
  assert(comparison.rows.length === 96 && comparison.datasetHash === datasetHash, 'crm026_archive_mismatch');
  const candidate = await frozenContext('candidate', comparison.frozen.C.hash);
  const original = await read(resolve(BASE, 'fixtures.json'),
    (await read(resolve(BASE, 'baseline/freeze.json'), comparison.frozen.B0.hash)).fixtureHash);
  const recoveries = [candidate.candidateRecovery.h11, candidate.candidateRecovery.h11Disabled];
  return { comparison, dataset, original, fixture: candidate.fixture, recoveries };
}

async function historicalTask(row, corpus) {
  const stem = resolve(BASE, row.phase, row.split, `${row.caseId}-${row.arm}`);
  const rawBytes = await readFile(`${stem}-result.json`);
  assert(digest(rawBytes) === row.rawHash, 'crm026_raw_result_changed');
  const oldRaw = JSON.parse(rawBytes);
  assert(oldRaw.freezeHash === row.freezeHash && oldRaw.runId === row.runId, 'crm026_raw_result_unbound');
  const caseSpec = corpus.dataset.cases.find(item => item.id === row.caseId);
  const fixture = row.segment === 'B0' ? corpus.original : corpus.fixture;
  const scope = fixture.slots[reviewKey(row)];
  if (row.category !== 'settled') return { oldRaw, caseSpec, scope };
  const recovery = corpus.recoveries.find(item => item?.value.key === reviewKey(row));
  assert(!row.recoveryHash || recovery?.hash === row.recoveryHash, 'crm026_recovery_changed');
  const raw = recovery ? projectInspectDenial(rawBytes, recovery.value) : projectRecordedInspectDenial(oldRaw);
  const old = await read(`${stem}-grade.json`, row.gradeHash);
  const previous = await read(resolve(BASE, 'reviews', `${old.scoring.binding.reviewId}-review.json`), row.reviewHash);
  const input = { caseSpec, raw, scope, materials: fixture, businessClock: corpus.dataset.businessClock,
    reviewId: old.scoring.binding.reviewId };
  assert(old.rawHash === row.rawHash && old.reviewHash === row.reviewHash && old.scoring.outcome === row.outcome &&
    same(scoreTask(input, previous), old.scoring), 'crm026_legacy_review_changed');
  return { input, previous, old: old.scoring, oldRaw, caseSpec, scope };
}

function checkRouting(row, input, dataset) {
  if (row.arm !== 'auto' || !row.runId) return null;
  const { oldRaw, caseSpec, scope } = input;
  const root = oldRaw.snapshot.runs.find(item => item.id === row.runId);
  const withCalendar = makeScopeTask(caseSpec, scope, dataset);
  // The full archived runnable text and actual children must agree with the path we reproduce.
  const choose = task => Boolean(selectCollaborationPlan({ builtinKey: 'sales_operations', leadId: scope.leadId, task }));
  const predicted = choose(withCalendar);
  assert(root.task === withCalendar && predicted === (row.usage.specialists === 3) && [0, 3].includes(row.usage.specialists),
    'crm026_route_control_does_not_match_archive');
  return { key: reviewKey(row), rawHash: row.rawHash, withoutCalendar: choose(caseSpec.task), withCalendar: predicted,
    actualSpecialists: row.usage.specialists };
}

async function sealOnce(path, value) {
  const previous = await optional(path);
  if (previous) {
    assert(same(previous, value), 'crm026_append_only_record_changed');
    return { sha256: digest(await readFile(path)) };
  }
  return seal(path, value, false);
}

async function scan(corpus, previousManifest) {
  const entries = [];
  const routing = [];
  for (const row of corpus.comparison.rows) {
    const task = await historicalTask(row, corpus);
    const route = checkRouting(row, task, corpus.dataset);
    if (route) routing.push(route);
    const prior = previousManifest?.entries.find(item => item.key === reviewKey(row));
    const provenance = { key: reviewKey(row), category: row.category, rawHash: row.rawHash, priorGradeHash: row.gradeHash,
      priorReviewHash: row.reviewHash };
    if (!task.input) {
      entries.push({ ...provenance, disposition: row.category });
      continue;
    }
    const reviewId = prior?.reviewId ?? randomUUID();
    const prepared = supplementalReview({ ...task.input, reviewId }, task.previous);
    const triggers = reviewTriggers(prepared, task.old);
    const entry = { ...provenance, reviewId, packetHash: prepared.packet.packetHash, triggers,
      receipts: prepared.packet.supplementalReceipts.length, disposition: triggers.length ? 'independent_review' : 'reuse_prior_judgment' };
    entries.push(entry);
    if (triggers.length) await sealOnce(artifacts(reviewId, 'packet'), prepared.packet);
  }
  const manifest = { version: REVIEW_VERSION, originalHash, entries, routing };
  return sealOnce(resolve(privatePath, 'manifest.json'), manifest).then(() => manifest);
}

function pairedSummary(pairs, byKey, prefix = null) {
  const group = pairs.filter(row => !prefix || prefix === row.split);
  const matched = group.filter(row => row.comparable);
  const task = (phase, row) => byKey.get(`${phase}.${row.caseId}.${row.arm}`);
  const transitions = matched.map(row => {
    const before = task('baseline', row).after;
    const after = task('candidate', row).after;
    return before === 'unknown' || after === 'unknown' ? 'unknown' : `${before}_to_${after}`;
  });
  return { planned: group.length, comparable: matched.length, transitions: count(transitions),
    priorTransitions: count(matched.map(row => row.transition)),
    before: count(matched.map(row => task('baseline', row).after)), after: count(matched.map(row => task('candidate', row).after)),
    totals: Object.fromEntries(['baseline', 'candidate'].map(phase => [phase,
      matched.reduce((total, row) => {
        const item = task(phase, row);
        total.factsCorrect += item.facts.after.correct;
        total.factsRequired += item.facts.after.required;
        total.citesValid += item.citations.after.valid;
        total.citesTotal += item.citations.after.cited;
        return total;
      }, { factsCorrect: 0, factsRequired: 0, citesValid: 0, citesTotal: 0 })])) };
}

function modeSummary(pairs, byKey, phase) {
  const matched = pairs.filter(row => row.comparable);
  const get = (row, arm) => byKey.get(`${phase}.${row.caseId}.${arm}`).after;
  return { planned: pairs.length, comparable: matched.length, transitions: count(matched.map(row =>
    get(row, 'disabled') === 'unknown' || get(row, 'auto') === 'unknown' ? 'unknown'
      : `${get(row, 'disabled')}_to_${get(row, 'auto')}`)) };
}

function count(values) {
  return Object.fromEntries([...new Set(values)].sort().map(value => [value, values.filter(item => item === value).length]));
}

function changes(before, after) {
  const result = {};
  for (const section of ['facts', 'recommendations', 'forbidden']) {
    result[section] = before[section].flatMap(row => {
      const current = after[section].find(item => item.id === row.id);
      return row.verdict === current.verdict ? [] : [{ id: row.id, before: row.verdict, after: current.verdict, reason: current.reason }];
    });
  }
  result.extraClaims = same(before.extraClaims, after.extraClaims) ? null : { before: before.extraClaims, after: after.extraClaims };
  return result;
}

async function compare(corpus, manifest, mode) {
  const reviewRows = [];
  const judges = {};
  const routing = [];
  const metadata = [];
  const metadataManifestPath = resolve(privatePath, 'metadata-manifest.json');
  const preparing = mode === 'prepare-metadata';
  const final = mode === 'final';
  const metadataManifest = preparing || final ? await optional(metadataManifestPath) : null;
  if (final) assert(metadataManifest?.version === REVIEW_VERSION, 'crm026_metadata_manifest_required');
  assert(manifest.entries.length === corpus.comparison.rows.length &&
    new Set(manifest.entries.map(entry => entry.key)).size === manifest.entries.length, 'crm026_manifest_unbound');
  for (const row of corpus.comparison.rows) {
    const task = await historicalTask(row, corpus);
    const route = checkRouting(row, task, corpus.dataset);
    if (route) routing.push(route);
    const entry = manifest.entries.find(item => item.key === reviewKey(row));
    assert(entry?.rawHash === row.rawHash && entry.category === row.category && entry.priorGradeHash === row.gradeHash &&
      entry.priorReviewHash === row.reviewHash, 'crm026_manifest_unbound');
    if (!task.input) {
      assert(entry.disposition === row.category, 'crm026_manifest_unbound');
      reviewRows.push({ ...entry, segment: row.segment, before: row.outcome, after: row.outcome, comparable: false,
        unknownReasons: row.category === 'invalid_environment' ? [{ reason: 'archived_worker_tool_receipts_missing' }] : [] });
      continue;
    }
    const input = { ...task.input, reviewId: entry.reviewId };
    const prepared = supplementalReview(input, task.previous);
    const triggers = reviewTriggers(prepared, task.old);
    assert(entry.packetHash === prepared.packet.packetHash && entry.receipts === prepared.packet.supplementalReceipts.length &&
      same(entry.triggers, triggers) && entry.disposition === (triggers.length ? 'independent_review' : 'reuse_prior_judgment'),
    'crm026_manifest_unbound');
    let review;
    let reviewHash = null;
    if (entry.disposition === 'independent_review') {
      assert(same(prepared.packet, await read(artifacts(entry.reviewId, 'packet'))), 'crm026_anonymous_packet_changed');
      const raw = await readFile(artifacts(entry.reviewId, 'review')).catch(error => {
        if (error.code === 'ENOENT') throw new Error(`crm026_missing_review_${entry.reviewId}`);
        throw error;
      });
      review = JSON.parse(raw);
      assert(typeof review.reviewer === 'string' && review.reviewer.trim().length > 0, 'crm026_independent_reviewer_required');
      reviewHash = digest(raw);
      judges[review.reviewer] = (judges[review.reviewer] ?? 0) + 1;
    }
    const provisional = rescoreTask(input, prepared, review);
    const addendum = preparing || final ? metadataAddendum(input, prepared, provisional, task.old) : null;
    let metadataOpinion;
    let metadataReviewHash = null;
    if (addendum) {
      const item = { key: entry.key, reviewId: entry.reviewId, packetHash: addendum.packetHash, rawHash: row.rawHash, initialReviewHash: reviewHash };
      metadata.push(item);
      if (preparing) await sealOnce(metadataArtifacts(entry.reviewId, 'packet'), addendum);
      if (final) {
        assert(same(metadataManifest.entries.find(row => row.key === entry.key), item) &&
          same(addendum, await read(metadataArtifacts(entry.reviewId, 'packet'))), 'crm026_metadata_manifest_changed');
        const signed = await readFile(metadataArtifacts(entry.reviewId, 'review'));
        const signature = JSON.parse(signed);
        assert(typeof signature.reviewer === 'string' && signature.reviewer.trim() &&
          signature.reviewer !== review?.reviewer, 'crm026_metadata_independent_reviewer_required');
        judges[signature.reviewer] = (judges[signature.reviewer] ?? 0) + 1;
        metadataOpinion = bindMetadataOpinion(addendum, signature);
        metadataReviewHash = digest(signed);
      }
    }
    if (preparing) continue;
    const score = final ? rescoreTask(input, prepared, review, metadataOpinion, true) : provisional;
    const recorded = await sealOnce(resolve(privatePath, final ? 'final' : '.', `${entry.key}-grade.json`),
      { rawHash: row.rawHash, priorGradeHash: row.gradeHash, priorReviewHash: row.reviewHash, reviewHash,
        ...(final ? { metadataReviewHash } : {}), reviewer: review?.reviewer ?? 'original_blind_review', score });
    reviewRows.push({ ...entry, segment: row.segment, before: task.old.outcome, after: score.outcome, comparable: score.comparisonEligible,
      reviewHash, ...(final ? { metadataReviewHash } : {}), gradeHash: recorded.sha256, unknownReasons: score.unknownReasons,
      facts: { before: task.old.counts.facts, after: score.counts.facts },
      citations: { before: task.old.counts.references, after: score.counts.references }, differences: changes(task.old, score) });
  }
  assert(same(routing, manifest.routing), 'crm026_manifest_route_changed');
  const receipt = { version: REVIEW_VERSION, entries: metadata };
  if (preparing) {
    await sealOnce(metadataManifestPath, receipt);
    await sealOnce(resolve(output, 'metadata', 'assignment.json'), metadata.map(row => `${row.reviewId}-packet.json`));
    return { additionalReview: metadata.length };
  }
  if (final) assert(same(metadataManifest, receipt), 'crm026_metadata_manifest_changed');
  const byKey = new Map(reviewRows.map(row => [row.key, row]));
  const pairSet = corpus.comparison.primary.pairs;
  const comparison = { version: REVIEW_VERSION, originalHash, manifestHash: digest(bytes(manifest)), judges,
    ...(final ? { metadataManifestHash: digest(bytes(metadataManifest)),
      preliminaryHash: digest(await readFile(resolve(BASE, 'comparison-v2-preliminary.json'))) } : {}),
    aggregate: { all: pairedSummary(pairSet, byKey), development: pairedSummary(pairSet, byKey, 'dev'),
      holdout: pairedSummary(pairSet, byKey, 'holdout'),
      single: pairedSummary(pairSet.filter(row => row.arm === 'disabled'), byKey),
      threeExperts: pairedSummary(pairSet.filter(row => row.arm === 'auto'), byKey) },
    modes: { S: modeSummary(corpus.comparison.armComparison.primaryS.pairs, byKey, 'baseline'),
      C: modeSummary(corpus.comparison.armComparison.primaryC.pairs, byKey, 'candidate') },
    versions: Object.fromEntries(['B0', 'S', 'C'].map(segment => [segment,
      count(reviewRows.filter(row => row.segment === segment).map(row => row.after))])),
    routing: manifest.routing, rows: reviewRows };
  return sealOnce(resolve(BASE, 'comparison-v2.json'), comparison);
}

async function main([mode, ...args]) {
  assert(!args.length && ['prepare', 'compare', 'prepare-metadata', 'final'].includes(mode), 'crm026_review_expected_prepare_or_compare');
  const corpus = await openCorpus();
  const path = resolve(privatePath, 'manifest.json');
  const previous = await optional(path);
  if (mode === 'prepare') {
    await mkdir(privatePath, { recursive: true, mode: 0o700 });
    const manifest = await scan(corpus, previous);
    console.info(JSON.stringify({ audited: manifest.entries.length, routing: manifest.routing.length,
      dispositions: count(manifest.entries.map(row => row.disposition)), triggers: count(manifest.entries.flatMap(row => row.triggers ?? [])) }));
  } else {
    assert(previous?.version === REVIEW_VERSION && previous.originalHash === originalHash, 'crm026_review_prepare_required');
    if (mode === 'prepare-metadata') await mkdir(resolve(output, 'metadata'), { recursive: true, mode: 0o700 });
    if (mode === 'final') await mkdir(resolve(privatePath, 'final'), { recursive: true, mode: 0o700 });
    console.info(JSON.stringify(await compare(corpus, previous, mode)));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) main(process.argv.slice(2)).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
