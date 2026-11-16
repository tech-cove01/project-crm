import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { arms, budget, calibrationIds, cases, holdoutIds, model, regressionIds, taskFor } from './crm023-cases.mjs';

const directory = '.local/crm023';
const old = '.local/crm022/paired';
const diagnosticFiles = ['S02-auto-0.json','S02-disabled-0.json','X02-auto-0.json','M03-auto-0.json',
  'X01-disabled-0.json','X02-disabled-0.json','M03-disabled-0.json','formal-comparison-report.json',
  'formal-frozen.json','formal-scopes.json','formal-summary.json','wiki-frozen.json'];
const sourceFiles = ['crm023-score.mjs','crm023-cases.mjs','crm023-freeze.mjs','crm022-paired-cases.mjs'];

export function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function createProtocol() {
  const scope = { leadId: '{leadId}', contactId: '{contactId}', stageId: '{stageId}' };
  const taskDefinitions = Object.fromEntries(Object.entries(cases).map(([id, item]) => [id,
    { oracle: item, promptTemplate: taskFor(item, scope) }]));
  assert.equal(Object.keys(cases).length, 8);
  assert.equal(calibrationIds.every(id => regressionIds.includes(id)), true);
  assert.equal(holdoutIds.some(id => regressionIds.includes(id)), false);
  for (const id of holdoutIds) {
    const { oracle, promptTemplate } = taskDefinitions[id];
    const values = [oracle.value, oracle.expectedDate, oracle.contactName, oracle.leadTitle, ...Object.values(oracle.expected ?? {})];
    assert(values.filter(value => value != null).every(value => !promptTemplate.includes(String(value))), 'holdout_oracle_leaked');
    const anchor = oracle.policy?.policy_excerpt?.anchor;
    assert(!anchor || !promptTemplate.includes(anchor), 'holdout_policy_oracle_leaked');
  }
  return {
    version: 'crm023-v1', handoff: 'f6785b8', model, budget, arms,
    calibrationIds, regressionIds, holdoutIds, taskDefinitions,
    sourceHashes: Object.fromEntries(sourceFiles.map(file => [file,digest(readFileSync(`scripts/eval/${file}`))])),
    oldHashes: Object.fromEntries(diagnosticFiles.map(file => [file,digest(readFileSync(`${old}/${file}`))])),
    observation: {
      firstWindow: 'freeze one planned calibration auto root with three durable children before starting formal calls',
      secondWindow: 'with integration delivery paused, freeze a distinct already planned root whose events were not sent',
      fallback: 'select a distinct unsent calibration root or CRM-022 untouched root within the same constraints; no new roots for telemetry',
      maxSpanEventsPerWindow: 15, maxMinutesPerWindow: 10, maxConfigAttempts: 2,
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const protocol = createProtocol();
  const bytes = JSON.stringify(protocol, null, 2) + '\n';
  mkdirSync(directory, { recursive: true });
  writeFileSync(`${directory}/protocol.json`, bytes, { flag: 'wx', mode: 0o600 });
  console.info(JSON.stringify({ protocol: `${directory}/protocol.json`, sha256: digest(bytes), modelRoots: 0 }));
}
