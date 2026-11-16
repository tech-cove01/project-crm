/** Reconcile completed model, grading and environmental receipts without contacting services. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { digest, optional, read, ROOT, seal, sha } from './crm024-fixtures.mjs';
import { MEMORY_ROOT } from './crm026-memory-environment-config.mjs';
import { GENERALIZATION_FILES } from './crm026-generalization-environment.mjs';
import { readMemorySlot } from './crm026-memory-run.mjs';
import { scoreReviewedTask } from './crm026-judge.mjs';

const base = resolve(ROOT, '.local/crm026');
const hash = async path => digest(await readFile(path));
const sum = numbers => numbers.reduce((total, n) => total + (Number.isFinite(n) ? n : 0), 0);
const count = values => Object.fromEntries([...new Set(values)].sort().map(value => [value, values.filter(item => item === value).length]));
const median = numbers => {
  const ordered = numbers.filter(Number.isFinite).sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return !ordered.length ? null : ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
};

function aggregate(rows) {
  return {
    slots: rows.length, roots: rows.filter(row => row.runId).length, graded: rows.filter(row => row.grade).length,
    terminal: count(rows.map(row => row.terminal)), taskPass: rows.filter(row => row.grade?.taskPass).length,
    correctAbstention: rows.filter(row => row.grade?.correctAbstention).length,
    facts: { pass: sum(rows.map(row => row.grade?.facts.pass)), required: sum(rows.map(row => row.grade?.facts.required)) },
    format: rows.filter(row => row.format).length, criticalErrors: sum(rows.map(row => row.grade?.criticalErrors.length)),
    specialists: sum(rows.map(row => row.specialists)), providerRows: sum(rows.map(row => row.modelRows)),
    providerFailureRows: sum(rows.map(row => row.providerFailures)), modelDecisionEvents: sum(rows.map(row => row.modelDecisionEvents)),
    input: sum(rows.map(row => row.input)), output: sum(rows.map(row => row.output)),
    cacheRead: sum(rows.map(row => row.cacheRead)), cacheWrite: sum(rows.map(row => row.cacheWrite)), knownCosts: sum(rows.map(row => row.knownCosts)),
    cacheUnknownRows: sum(rows.map(row => row.cacheUnknownRows)),
    medianMs: median(rows.filter(row => row.runId).map(row => row.runMs)),
    observedMedianMs: median(rows.filter(row => row.runId).map(row => row.observedMs)),
  };
}

async function collect(phase, freeze, freezeHash) {
  const scoringPath = resolve(base, 'reviews', phase, 'scores.json');
  const scoresHash = await hash(scoringPath);
  const signed = await read(scoringPath, scoresHash);
  const reviewFolder = dirname(scoringPath);
  const manifest = await read(resolve(reviewFolder, 'manifest.private.json'));
  const slotOrder = phase === 'memory' ? freeze.slots : freeze.generalization.slots;
  assert(signed.phase === phase && manifest.phase === phase && signed.freezeHash === freezeHash && manifest.freezeHash === freezeHash &&
    signed.version === manifest.version && same(signed.entries.map(row => row.key), slotOrder) && same(manifest.entries.map(row => row.key), slotOrder),
    'crm026_report_slots_do_not_match_freeze');
  const isMemory = phase === 'memory';
  const folder = isMemory ? MEMORY_ROOT : dirname(GENERALIZATION_FILES.fixture);
  const rows = [];
  for (const item of signed.entries) {
    assert(sha.test(item.resultHash ?? ''), 'crm026_report_result_hash_required');
    const { reviewHash, scoring, ...binding } = item;
    const original = manifest.entries.find(row => row.key === item.key);
    assert(same(binding, original), 'crm026_report_review_binding_mismatch');
    if (item.packetHash) {
      assert(sha.test(reviewHash ?? ''), 'crm026_report_review_hash_required');
      const packet = await read(resolve(reviewFolder, `${item.reviewId}-packet.json`));
      const { packetHash, ...payload } = packet;
      const opinion = await read(resolve(reviewFolder, `${item.reviewId}-review.json`), reviewHash);
      assert(packetHash === item.packetHash && packetHash === digest(JSON.stringify(payload)) &&
        same(scoreReviewedTask(packet, opinion), scoring), 'crm026_report_score_changed');
    } else assert(!reviewHash && !scoring, 'crm026_report_unreviewable_slot_scored');
    const path = resolve(folder, 'runs', `${item.key}-result.json`);
    const source = isMemory ? await readMemorySlot(path, item.key, item.resultHash) : await read(path, item.resultHash);
    assert(source.key === item.key && source.fixtureHash === (isMemory ? freeze.fixtureHash : freeze.generalization.fixtureHash) &&
      source.verification.safe, 'crm026_report_raw_scope_mismatch');
    const result = source.observed;
    const required = result?.root.result_document;
    const memoryReads = source.verification.toolChecks?.filter(row => row.memory && row.visibleOnLaterTurn).map(row =>
      ({ tool: row.name, status: row.memory.status, coverage: row.memory.coverage,
        ids: row.memory.memories.map(fact => fact.id) })) ?? [];
    rows.push({ key: item.key, group: item.group, scenario: item.scenario, rawPath: path, resultHash: item.resultHash,
      reviewHash: item.reviewHash ?? null, grade: item.scoring ?? null, runId: result?.root.id ?? null,
      terminal: result?.root.status ?? source.disposition, error: result?.root.error_code ?? source.receipt.errorCode,
      actualContext: source.verification.fresh, scopePreserved: source.verification.unchanged,
      format: required?.revision === 1 && required?.trust === 'model_submitted',
      specialists: result?.specialists ?? 0, modelRows: result?.calls.length ?? 0, providerFailures: result?.providerFailureRows ?? 0,
      modelDecisionEvents: result?.modelDecisions ?? 0,
      input: result?.usage.reported.input ?? 0, output: result?.usage.reported.output ?? 0,
      cacheRead: sum(result?.calls.map(call => Number(call.cache_read_tokens)) ?? []),
      cacheWrite: sum(result?.calls.map(call => Number(call.cache_write_tokens)) ?? []),
      cacheUnknownRows: result?.calls.filter(call => call.cache_read_tokens == null || call.cache_write_tokens == null).length ?? 0,
      knownCosts: result?.calls.filter(call => call.cost_cents !== null && call.cost_cents !== undefined).length ?? 0,
      memoryReads, tools: count(source.verification.toolChecks?.map(row => row.name) ?? []),
      searchOutcomes: count(source.verification.toolChecks?.filter(row => row.name === 'crm_search_knowledge').map(row => row.verdict) ?? []),
      observedMs: source.elapsedMs,
      runMs: result?.root.started_at && result.root.completed_at ? Date.parse(result.root.completed_at) - Date.parse(result.root.started_at) : null });
  }
  const groups = Object.fromEntries([...new Set(rows.map(row => row.group))].map(group => [group, aggregate(rows.filter(row => row.group === group))]));
  return { phase, freezeHash, scoresHash, all: aggregate(rows), groups, rows };
}

async function writeOnce(path, value) {
  const previous = await optional(path);
  if (previous) assert(JSON.stringify(previous) === JSON.stringify(value), 'crm026_report_changed');
  else await seal(path, value, false);
  return hash(path);
}

async function main([stage, ...args]) {
  assert(!args.length && ['memory', 'generalization', 'final'].includes(stage), 'crm026_report_arguments');
  const path = resolve(MEMORY_ROOT, 'freeze.json');
  const freezeHash = await hash(path);
  const freeze = await read(path, freezeHash);
  if (stage !== 'final') {
    const summary = await collect(stage, freeze, freezeHash);
    const sha256 = await writeOnce(resolve(base, `${stage}-report-local.json`), summary);
    console.info(JSON.stringify({ sha256, all: summary.all, groups: summary.groups }));
    return;
  }
  const [memory, generalization] = await Promise.all(['memory', 'generalization'].map(phase => collect(phase, freeze, freezeHash)));
  const rows = [...memory.rows, ...generalization.rows];
  const ids = rows.map(row => row.runId).filter(Boolean);
  assert(rows.length === 30 && new Set(rows.map(row => row.key)).size === rows.length &&
    new Set(ids).size === ids.length && !rows.some(row => row.specialists) &&
    sum(rows.map(row => row.input + row.output)) <= 1_200_000, 'crm026_report_budget_drift');
  const sha256 = await writeOnce(resolve(base, 'final-execution-index.json'), { version: 1, freezeHash, memory, generalization, totals: aggregate(rows) });
  console.info(JSON.stringify({ sha256, totals: aggregate(rows) }));
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) main(process.argv.slice(2)).catch(error => {
  console.error(/^[a-z0-9_]{1,110}$/.test(error?.message ?? '') ? error.message : 'crm026_report_failed');
  process.exitCode = 1;
});
