import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { compareScores, modelMetrics } from './crm023-observation-readback.mjs';

const time = 1_794_815_888_333;
const usage = { input: 80, output: 12, cache_read_input_tokens: 0, cache_creation_input_tokens: 4 };
const expected = { spanId: 'a'.repeat(16), startTimeUnixNano: String(BigInt(time) * 1_000_000n),
  endTimeUnixNano: String(BigInt(time + 1913) * 1_000_000n), attributes: [
    { key: 'langfuse.observation.usage_details', value: { stringValue: JSON.stringify(usage) } },
  ] };
const observed = { startTime: new Date(time).toISOString(), endTime: new Date(time + 1913).toISOString(),
  latency: 1.913, usageDetails: usage };

test('uses the exact payload times and token categories', () => {
  const proof = modelMetrics(expected, observed);
  assert(proof.timingMatches && proof.usageMatches && proof.reportedDurationMatches);
  assert.equal(proof.actualDurationMs, 1913);
  assert.equal(proof.usage.cache_read_input_tokens.actual, 0);
  assert.equal(modelMetrics(expected, { ...observed, latency: 1.9 }).reportedDurationMatches, false);
});

test('missing remote measurements do not match expected zero or expected timing', () => {
  const proof = modelMetrics(expected, { startTime: observed.startTime, usageDetails: { ...usage, cache_read_input_tokens: undefined } });
  assert.equal(proof.timingMatches, false);
  assert.equal(proof.usageMatches, false);
  assert.equal(proof.usage.cache_read_input_tokens.actual, null);
  assert.equal(proof.reportedDurationMatches, null);
});

const scope = { org: 'org', runId: 'run', fingerprint: 'f'.repeat(64), traceId: 'b'.repeat(32), rootSpan: 'c'.repeat(16), profileRevision: 2 };
const metadata = { fingerprint: scope.fingerprint, profile_revision: 2, rubric_revision: null };
const scoreId = createHash('sha256').update(`${scope.org}:${scope.runId}:${scope.fingerprint}:overall`).digest('hex');
const local = { id: scoreId, traceId: scope.traceId, observationId: scope.rootSpan, name: 'crm.overall', value: 83, metadata };
const row = { id: scoreId, name: local.name, value: 83, dataType: 'NUMERIC', metadata,
  subject: { kind: 'observation', id: scope.rootSpan, traceId: scope.traceId } };
const scoreProof = remote => compareScores({ ...scope, expected: [local], remote });

test('matches deterministic score identity, subject, value, and rule revision', () => {
  assert(scoreProof([row]).complete);
  assert(scoreProof([{ ...row, metadata: JSON.stringify(metadata) }]).complete);
  assert.deepEqual(scoreProof([{ ...row, metadata: { ...metadata, rubric_revision: undefined } }]).mismatched, [scoreId]);
  assert.deepEqual(scoreProof([{ ...row, subject: { ...row.subject, id: 'f'.repeat(16) } }]).mismatched, [scoreId]);
  assert.deepEqual(scoreProof([{ ...row, value: 85 }]).mismatched, [scoreId]);
});

test('reports missing scores and rejects duplicated or additional IDs', () => {
  assert.deepEqual(scoreProof([]).missing, [scoreId]);
  assert(!scoreProof([row, row]).complete);
  assert.deepEqual(scoreProof([row, { ...row, id: 'c'.repeat(64) }]).extra, ['c'.repeat(64)]);
});
