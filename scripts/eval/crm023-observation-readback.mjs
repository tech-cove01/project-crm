import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { integrationFetch } from '../../lib/ai/integrations/http.ts';
import { readLangfuseObservations } from '../../lib/ai/integrations/langfuse-readback.ts';

const validNumber = value => typeof value === 'number' && Number.isFinite(value);
const tokenKeys = ['input', 'output', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
const auth = binding => `Basic ${Buffer.from(`${binding.public_key}:${binding.secret_key}`).toString('base64')}`;
const hash = value => createHash('sha256').update(value).digest('hex');

export function modelMetrics(expected, row) {
  const startMs = Number(BigInt(expected.startTimeUnixNano) / 1_000_000n);
  const endMs = Number(BigInt(expected.endTimeUnixNano) / 1_000_000n);
  const durationMs = endMs - startMs;
  const actualStartMs = typeof row.startTime === 'string' ? Date.parse(row.startTime) : null;
  const actualEndMs = typeof row.endTime === 'string' ? Date.parse(row.endTime) : null;
  const actualDurationMs = actualStartMs !== null && actualEndMs !== null &&
    Number.isFinite(actualStartMs) && Number.isFinite(actualEndMs) ? actualEndMs - actualStartMs : null;
  const reportedDurationMs = validNumber(row.latency) ? row.latency * 1000 : null;
  const tokenAttribute = expected.attributes.find(attribute => attribute.key === 'langfuse.observation.usage_details');
  const expectedUsage = tokenAttribute ? JSON.parse(tokenAttribute.value.stringValue) : null;
  const readUsage = row.usageDetails ?? null;
  const usage = Object.fromEntries(tokenKeys.map(key => [key, {
    expected: Number.isSafeInteger(expectedUsage?.[key]) ? expectedUsage[key] : null,
    actual: Number.isSafeInteger(readUsage?.[key]) ? readUsage[key] : null,
  }]));
  const timingMatches = actualStartMs === startMs && actualEndMs === endMs && actualDurationMs === durationMs;
  // The independent returned latency may be unavailable; the persisted timestamps still yield duration.
  const reportedDurationMatches = reportedDurationMs === null ? null : Math.abs(reportedDurationMs - durationMs) < 0.001;
  const usageMatches = expectedUsage ? Object.values(usage).every(x => x.expected !== null && x.actual === x.expected) : null;
  return { id: expected.spanId, startMs, endMs, durationMs, actualStartMs, actualEndMs, actualDurationMs,
    reportedDurationMs, timingMatches, reportedDurationMatches, usage, usageMatches };
}

export async function captureSpans(binding, expected, compareMetrics, deadlineSignal) {
  const models = new Map(expected.filter(span => span.name === 'crm.model').map(span => [span.spanId, span]));
  const metrics = [];
  const spans = await readLangfuseObservations(binding, expected, async (rawUrl, init) => {
    const url = new URL(rawUrl);
    if (compareMetrics) url.searchParams.set('fields', 'core,basic,io,usage,metrics');
    const response = await fetch(url, { ...init, signal: AbortSignal.any([deadlineSignal, init.signal]), redirect: 'error' });
    if (compareMetrics && response.ok) {
      const body = await response.clone().json();
      assert(Array.isArray(body?.data), 'crm023_span_response_invalid');
      for (const row of body.data) {
        if (models.has(row.id)) metrics.push(modelMetrics(models.get(row.id), row));
      }
    }
    return response;
  });
  const metricsComplete = compareMetrics && metrics.length > 0 && metrics.length === models.size &&
    metrics.every(row => row.timingMatches && row.reportedDurationMatches !== false && row.usageMatches !== false) &&
    metrics.some(row => row.usageMatches === true);
  return { ...spans, metrics, metricsComplete };
}

function scoreMetadata(raw) {
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return null; }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return {
    fingerprint: typeof raw.fingerprint === 'string' && /^[0-9a-f]{64}$/.test(raw.fingerprint) ? raw.fingerprint : null,
    profile_revision: Number.isInteger(raw.profile_revision) ? raw.profile_revision : null,
    rubric_revision: raw.rubric_revision === null || Number.isInteger(raw.rubric_revision) ? raw.rubric_revision : undefined,
  };
}

export function compareScores({ expected, remote, org, runId, traceId, fingerprint, profileRevision, rootSpan }) {
  const readById = new Map(remote.map(row => [row.id, row]));
  const expectedIds = new Set(expected.map(row => row.id));
  const missing = [];
  const mismatched = [];
  for (const row of expected) {
    const got = readById.get(row.id);
    if (!got) { missing.push(row.id); continue; }
    const meta = scoreMetadata(got.metadata);
    const stable = hash(`${org}:${runId}:${fingerprint}:${row.name.slice(4)}`);
    if (row.id !== stable || row.traceId !== traceId || row.observationId !== rootSpan ||
      got.subject?.traceId !== traceId || got.subject?.kind !== 'observation' || got.subject?.id !== rootSpan ||
      got.name !== row.name || got.value !== row.value || got.dataType !== 'NUMERIC' ||
      row.metadata?.fingerprint !== fingerprint || meta?.fingerprint !== fingerprint ||
      row.metadata?.profile_revision !== profileRevision || meta?.profile_revision !== profileRevision ||
      meta?.rubric_revision !== row.metadata?.rubric_revision) mismatched.push(row.id);
  }
  const extra = remote.filter(row => !expectedIds.has(row.id)).map(row => row.id);
  return { count: remote.length, missing, mismatched, extra,
    complete: !!expected.length && expectedIds.size === expected.length && !missing.length && !mismatched.length &&
      !extra.length && readById.size === remote.length,
    scores: expected.map(({ id, name, value, metadata }) => ({ id, name, value, metadata })) };
}

export async function captureScores(binding, traceId, createdAt, signal) {
  const rows = [];
  const cursors = new Set();
  const fromTimestamp = new Date(Date.parse(createdAt) - 60_000).toISOString();
  const toTimestamp = new Date(Date.now() + 60_000).toISOString();
  let cursor;
  for (let page = 0; page < 4; page++) {
    const query = new URLSearchParams({ traceId, fields: 'subject,details', fromTimestamp, toTimestamp, limit: '100',
      ...(cursor ? { cursor } : {}) });
    const response = await integrationFetch(binding, `/api/public/v3/scores?${query}`, {
      method: 'GET', signal, headers: { Authorization: auth(binding) },
    });
    const body = await response.json();
    assert(Array.isArray(body?.data) && body.data.every(row => /^[0-9a-f]{64}$/.test(row.id) &&
      row.subject?.traceId === traceId), 'crm023_score_response_invalid');
    rows.push(...body.data);
    cursor = body.meta?.cursor;
    if (cursor == null) return rows;
    assert(typeof cursor === 'string' && cursor.length && !cursors.has(cursor), 'crm023_score_cursor_invalid');
    cursors.add(cursor);
  }
  throw new Error('crm023_score_page_limit');
}
