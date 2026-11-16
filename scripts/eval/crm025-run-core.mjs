import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bytes, digest, ROOT, uuid } from './crm024-fixtures.mjs';

export const BASE = resolve(ROOT, '.local/crm025');
export const BASELINE = '2d5d411223e68fef47a41c064040baf6d7c4056d';
export const DATASET_HASH = '590763cfffe722245effda31516e880e617fc0cf10351d98c28c89d18690f5ac';
export const PHASES = ['baseline', 'candidate'];
export const SPLITS = ['dev', 'holdout'];
export const ARMS = ['disabled', 'auto'];
export const ROLES = ['customer_evidence', 'opportunity_diagnosis', 'policy_advisor'];
export const MODEL = { provider: 'dashscope', model: 'qwen3.8-flash', temperature: 0, maxSteps: 12, tokenBudget: 36_000 };
export const LIMITS = { slots: 96, specialists: 144, reportedTokens: 4_000_000, reserve: 72_000 };
export const TERMINAL = new Set(['completed', 'partial', 'failed', 'cancelled', 'awaiting_confirmation']);
const runtimePaths = ['app', 'lib', 'workers', 'supabase', 'pnpm-lock.yaml', 'package.json', 'next.config.ts', 'proxy.ts'];

const git = (...args) => execFileSync('git', args, {
  cwd: ROOT, encoding: 'utf8', timeout: 15000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
}).trim();
const treeHash = ref => digest(git('ls-tree', '-r', '-z', ref, '--', ...runtimePaths));

export function product(phase) {
  assert(PHASES.includes(phase), 'crm025_invalid_phase');
  const commit = git('rev-parse', 'HEAD');
  assert(!git('status', '--porcelain', '--untracked-files=all', '--', ...runtimePaths), 'crm025_product_tree_dirty');
  const hash = treeHash(commit);
  assert(phase === 'baseline' ? hash === treeHash(BASELINE) : hash !== treeHash(BASELINE), 'crm025_product_baseline_mismatch');
  return { commit, hash };
}

export async function readFrozenDataset() {
  const raw = await readFile(resolve(ROOT, 'docs/evaluation/CRM-025-cases.json'));
  const datasetHash = digest(raw);
  assert.equal(datasetHash, DATASET_HASH, 'crm025_frozen_dataset_changed');
  const dataset = JSON.parse(raw);
  assert(dataset.baselineCommit === BASELINE && dataset.cases.length === 24 &&
    dataset.cases.filter(item => item.split === 'development').length === 8 &&
    dataset.cases.filter(item => item.split === 'evaluation').length === 16 &&
    new Set(dataset.cases.map(item => item.id)).size === 24 && dataset.cases.every(item => item.mode === 'inspect'),
  'crm025_frozen_case_shape');
  return { dataset, datasetHash };
}

export function planSlots(dataset, phase, split) {
  assert(PHASES.includes(phase) && SPLITS.includes(split), 'crm025_invalid_batch');
  return dataset.cases.filter(item => item.split === (split === 'dev' ? 'development' : 'evaluation')).flatMap((item, index) => {
    const arms = (index + Number(phase === 'candidate')) % 2 === 0 ? ARMS : [...ARMS].reverse();
    return arms.map(arm => ({ phase, split, caseId: item.id, arm, label: `${item.id}-${arm}`, key: `${phase}.${item.id}.${arm}` }));
  });
}

export function verifySlotMap(dataset, fixture) {
  const slots = PHASES.flatMap(phase => SPLITS.flatMap(split => planSlots(dataset, phase, split)));
  assert.equal(Object.keys(fixture.slots).length, LIMITS.slots, 'crm025_slot_count_changed');
  for (const item of slots) {
    const slot = fixture.slots[item.key];
    const permissionCase = dataset.cases.find(row => row.id === item.caseId).business.actorRole === 'sales';
    assert(slot && slot.key === item.key && slot.phase === item.phase && slot.caseId === item.caseId && slot.arm === item.arm &&
      [slot.contactId, slot.leadId, slot.pipelineId, slot.actorUserId, slot.stageId].every(id => uuid.test(id)) &&
      slot.scope?.leadId === slot.leadId && slot.scope.contactId === slot.contactId && slot.scope.pipelineId === slot.pipelineId &&
      !slot.scope.conversationId && slot.preState && slot.actor === (permissionCase ? 'sales' : 'initiator') &&
      slot.expectedHttpStatus === (permissionCase ? 403 : 201), 'crm025_fixture_slot_mismatch');
  }
  for (const field of ['contactId', 'leadId']) {
    assert.equal(new Set(Object.values(fixture.slots).map(slot => slot[field])).size, LIMITS.slots, 'crm025_fixture_scope_reuse');
  }
}

export function reserveSlot(meters, arm) {
  const used = meters.reduce((total, row) => ({ slots: total.slots + 1, roots: total.roots + Number(!!row.runId),
    specialists: total.specialists + row.specialists, input: total.input + row.input, output: total.output + row.output,
    unknownInputRows: total.unknownInputRows + row.unknownInputRows, unknownOutputRows: total.unknownOutputRows + row.unknownOutputRows,
  }), { slots: 0, roots: 0, specialists: 0, input: 0, output: 0, unknownInputRows: 0, unknownOutputRows: 0 });
  assert(used.slots < LIMITS.slots && used.roots < LIMITS.slots &&
    used.specialists + (arm === 'auto' ? ROLES.length : 0) <= LIMITS.specialists &&
    used.input + used.output + LIMITS.reserve < LIMITS.reportedTokens, 'crm025_batch_budget_exhausted');
  return used;
}

export function payloadHash(payload) {
  return digest(bytes(payload));
}
