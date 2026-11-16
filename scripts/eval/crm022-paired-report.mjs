import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { score, tested } from './crm022-paired-cases.mjs';

const directory = process.argv[2] ?? '.local/crm022/paired';
const plan = JSON.parse(readFileSync(`${directory}/formal-frozen.json`, 'utf8'));
const scoringBytes = readFileSync(new URL('./crm022-paired-cases.mjs', import.meta.url));
assert.equal(createHash('sha256').update(scoringBytes).digest('hex'),plan.scripts['crm022-paired-cases.mjs'], 'paired_report_oracle_changed');
const files = readdirSync(directory).filter(file => /^[SXCM]\d\d-(disabled|auto)-[01]\.json$/.test(file));
const snapshots = files.map(file => JSON.parse(readFileSync(`${directory}/${file}`, 'utf8')))
  .filter(({ summary }) => plan.taskIds.includes(summary.id));
const rows = snapshots.map(({ summary }) => summary);
const sum = (items, pick) => items.reduce((total, row) => total + (pick(row) ?? 0), 0);
const median = numbers => {
  if (!numbers.length) return null;
  const ordered = numbers.toSorted((a,b) => a-b);
  const i = Math.floor(ordered.length/2);
  return ordered.length % 2 ? ordered[i] : (ordered[i-1]+ordered[i])/2;
};
function metrics(items, expected) {
  const tokenKeys = ['input_tokens','output_tokens','cache_read_tokens','cache_write_tokens'];
  const tokens = Object.fromEntries(tokenKeys.map(key => {
    const available = items.map(row => row.usage?.[key]).filter(Number.isFinite);
    return [key, { total: available.length ? available.reduce((total, value) => total + value, 0) : null, rootsWithMetering: available.length }];
  }));
  return {
    passed: items.filter(row => row.pass).length, observed: items.length, planned: expected.length,
    fieldCorrect: sum(items, row => row.score?.counts.correct), fieldRequired: sum(expected, item => item.fields.length),
    fieldsWithScore: sum(items, row => row.score?.counts.required),
    citationsSupported: sum(items, row => row.score?.counts.supported), citationsMade: sum(items, row => row.score?.counts.cited),
    citationsRequired: sum(expected, item => item.fields.length - Number(item.id === 'M03')),
    medianElapsedMs: median(items.map(row => row.elapsedMs).filter(Number.isFinite)), tokens,
    failureTypes: items.filter(row => !row.pass).reduce((counts,row) => {
      const name = row.failure ?? row.errorCode ?? (!row.validArm ? 'wrong_arm' : !row.unchanged ? 'business_boundary' : !row.score?.shape ? 'answer_shape' : 'field_or_citation');
      counts[name] = (counts[name] ?? 0) + 1;
      return counts;
    }, {}),
  };
}

const kinds = ['simple','cross_source','conflict','missing'];
const primary = rows.filter(row => row.repetition === 0);
const expected = tested.filter(item => plan.taskIds.includes(item.id));
const byArm = Object.fromEntries(['disabled','auto'].map(arm => {
  const initial = primary.filter(row => row.arm === arm);
  return [arm, { ...metrics(initial, expected),
    byKind: Object.fromEntries(kinds.map(kind => [kind,metrics(initial.filter(row => row.kind === kind), expected.filter(item => item.kind === kind))])) }];
}));
const repeats = rows.filter(row => row.repetition === 1).map(row => {
  const first = primary.find(candidate => candidate.id === row.id && candidate.arm === row.arm);
  return { id: row.id, arm: row.arm, initial: first?.pass ?? false, repeat: row.pass ?? false,
    elapsedDeltaMs: first && Number.isFinite(first.elapsedMs) && Number.isFinite(row.elapsedMs) ? row.elapsedMs-first.elapsedMs : null };
});

// Inspect a complete leading JSON object separately when prose or a fence made
// the required format fail. This diagnostic leaves preregistered scores intact.
function leadingObject(text) {
  if (typeof text !== 'string') return null;
  const body = text.trim().replace(/^```(?:json)?\s*/i, '');
  if (!body.startsWith('{')) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return body.slice(0,index+1);
  }
  return null;
}

const fixture = JSON.parse(readFileSync(`${directory}/fixtures.json`, 'utf8'));
const wiki = JSON.parse(readFileSync(`${directory}/wiki-frozen.json`, 'utf8'));
const formatDiagnostics = [];
for (const snapshot of snapshots) {
  const row = snapshot.summary;
  if (!row.score || row.score.shape || !snapshot.runs) continue;
  const root = snapshot.runs.find(run => run.id === row.runId);
  const prefix = leadingObject(root?.final_text);
  const item = tested.find(test => test.id === row.id);
  const scope = plan.formalScopes?.[`${row.id}-${row.arm}-${row.repetition}`];
  if (!prefix || !scope || !item) continue;
  const diagnostic = score(item,scope,{...root,final_text:prefix},snapshot.runs,snapshot.tools,wiki,fixture.sourceId);
  if (diagnostic.shape) formatDiagnostics.push({ id:row.id, arm:row.arm, repetition:row.repetition,
    fieldCorrect:diagnostic.counts.correct, supported:diagnostic.counts.supported,
    passesFormatOnlyRelaxation:diagnostic.pass && row.validArm && row.unchanged && row.sameExecution });
}
console.log(JSON.stringify({ planned: plan.maxRoots, observed: rows.length, byArm, repeats,
  completePairs: plan.taskIds.filter(id => primary.filter(row => row.id === id).length === 2).length, formatDiagnostics, rows, cost: null }, null, 2));
