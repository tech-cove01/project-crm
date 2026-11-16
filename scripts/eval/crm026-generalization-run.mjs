/** Execute the independent fixed-product task slots after the memory run. */
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { digest, optional, read, ROOT, seal, sha } from './crm024-fixtures.mjs';
import { executeSlot, readMemorySlot, readResultWindowRecovery, readSystemRecovery, sealResultWindowRecovery } from './crm026-memory-run.mjs';
import { MEMORY_ROOT, PRODUCT_COMMIT } from './crm026-memory-environment-config.mjs';
import { GENERALIZATION_ARM, GENERALIZATION_FILES, generalizationTransaction, generalizationTransport,
  loadGeneralizationEnvironment } from './crm026-generalization-environment.mjs';
import { verifyRun } from './crm026-run-capture.mjs';

const truthPath = resolve(ROOT, '.local/crm026/private/generalization-truth-draft.json');
const bindingPath = resolve(MEMORY_ROOT, 'generalization-binding.json');
const runFolder = resolve(dirname(GENERALIZATION_FILES.preflight), 'runs');
const path = (id, category) => resolve(runFolder, `${id}-${category}.json`);
const scopeTransaction = (c, action) => generalizationTransaction(c, true, action);
const terminalIncident = {
  key: 'G2A', root: '1373de11-2a16-4b18-96e1-e257daa99fd7',
  raw: 'd478d72372e0ed0a446272200dcaa753b4ab12567be30754977beacab15932c8',
  intent: '0a9b31e7759e0174bc0c0c873d81fed615ee98b5b07a7aadf14dc5c9f6ac2b75',
  http: '4c1bbe12b79f4ba9f5496a1d8cdeb7b69f8f140da74ad9cfecb06f2dedfb66f4',
  previous: '3c170190e3567fe2042621dad6e6d4703bb970b34d89d53a3ff8c2beec00504d',
  freeze: 'fb8fc0af9d281573be55b4537984aaa67ccd75afe4e9ae22b4af43ae8d607034',
};

async function bind(c, truthHash) {
  assert(sha.test(truthHash ?? ''), 'crm026_generalization_truth_hash_required');
  assert(digest(await readFile(truthPath)) === truthHash, 'crm026_generalization_truth_hash_changed');
  const expected = {
    productCommit: PRODUCT_COMMIT, inputHash: c.fixture.inputHash, truthHash, fixtureHash: c.fixtureHash,
    profilesHash: c.profilesHash, preflightHash: c.preflightHash, slots: c.input.cases.map(row => row.id),
    runnerHash: digest(await readFile(import.meta.filename)),
  };
  assert(c.preflight?.ready === true && c.preflight.noModel === true && expected.slots.length === 12 &&
    sha.test(expected.profilesHash) && sha.test(expected.preflightHash), 'crm026_generalization_not_preflighted');
  const prior = await optional(bindingPath);
  if (prior) {
    const recovery = await readSystemRecovery();
    const frozen = recovery ? { ...prior, runnerHash: recovery.replacementGeneralizationRunnerHash } : prior;
    assert(digest(JSON.stringify(frozen)) === digest(JSON.stringify(expected)), 'crm026_generalization_frozen_binding_changed');
  }
  else await seal(bindingPath, expected, false);
  return expected;
}

async function run(c, id) {
  const binding = await read(bindingPath);
  await bind(c, binding.truthHash);
  const freeze = await read(resolve(MEMORY_ROOT, 'freeze.json'));
  assert(digest(JSON.stringify(freeze.generalization)) === digest(JSON.stringify(binding)) &&
    binding.slots.includes(id), 'crm026_generalization_batch_not_frozen');
  // Read the memory ledger and the earlier G receipts before admitting any new task.
  for (const key of freeze.slots) {
    const prior = await readMemorySlot(resolve(MEMORY_ROOT, 'runs', `${key}-result.json`), key);
    assert(prior.fixtureHash === freeze.fixtureHash && prior.verification.safe, 'crm026_memory_slot_unsettled');
  }
  await mkdir(runFolder, { recursive: true, mode: 0o700 });
  for (const key of binding.slots.slice(0, binding.slots.indexOf(id))) {
    const prior = await readGeneralizationSlot(path(key, 'result'), key);
    assert(prior.fixtureHash === c.fixtureHash && prior.verification.safe, 'crm026_generalization_slot_unsettled');
  }
  const task = c.input.cases.find(row => row.id === id).task;
  const slot = c.fixture.slots[id];
  const profile = c.profiles.profiles[GENERALIZATION_ARM];
  const result = id === terminalIncident.key && await readResultWindowRecovery()
    ? await readGeneralizationSlot(path(id, 'result'), id)
    : await executeSlot(c, slot, task, profile, { path, scopeTransaction, transport: generalizationTransport, pages: c.pages });
  assert(result.verification.safe, 'crm026_generalization_effect_unresolved');
  if (result.disposition === 'rejected_no_root') return { caseId: id, disposition: result.disposition, http: result.receipt.httpStatus };
  return { caseId: id, runId: result.observed.root.id, terminal: result.observed.root.status, configuration: result.verification.configuration,
    fresh: result.verification.fresh, input: result.observed.usage.reported.input, output: result.observed.usage.reported.output };
}

async function reconstruct(c, raw) {
  const item = terminalIncident;
  const [intent, http] = await Promise.all([read(path(item.key, 'intent'), item.intent), read(path(item.key, 'http'), item.http)]);
  const slot = c.fixture.slots[item.key];
  const profile = c.profiles.profiles[GENERALIZATION_ARM];
  const payload = { agentId: profile.agentId, task: c.input.cases.find(row => row.id === item.key).task,
    mode: 'inspect', collaboration: 'disabled', scope: slot.crmScope };
  assert(raw.key === item.key && raw.fixtureHash === c.fixtureHash && raw.intentHash === item.intent &&
    raw.verification.safe === false && raw.verification.fresh === false && intent.payloadHash === digest(JSON.stringify(payload)) &&
    http.httpStatus === 201 && http.data?.run_id === item.root && raw.observed.root.id === item.root &&
    digest(JSON.stringify(raw.receipt)) === digest(JSON.stringify(http)) && raw.observed.jobs.length === 1 &&
    raw.observed.jobs[0].attempts === 1 && raw.observed.calls.length === 2, 'crm026_result_window_original_mismatch');
  const verification = verifyRun(raw.observed, { ...slot, versionId: profile.versionId, promptHash: profile.promptHash }, payload, intent.before, c.pages);
  const comparable = ({ fresh: _fresh, safe: _safe, systemPromptHash: _prompt, systemPolicyHash: _policy, ...checks }) => checks;
  assert(verification.safe && verification.fresh &&
    digest(JSON.stringify(comparable(verification))) === digest(JSON.stringify(comparable(raw.verification))),
    'crm026_result_window_reconstruction_failed');
  return verification;
}

export async function readGeneralizationSlot(resultPath, key, expectedHash) {
  const item = terminalIncident;
  if (key !== item.key) return read(resultPath, expectedHash);
  assert(!expectedHash || expectedHash === item.raw, 'crm026_result_window_raw_hash_required');
  const original = await read(resultPath, item.raw);
  const receipt = await readResultWindowRecovery();
  if (!receipt) return original;
  await readSystemRecovery();
  const freeze = await read(resolve(MEMORY_ROOT, 'freeze.json'), item.freeze);
  const c = await loadGeneralizationEnvironment(freeze.generalization.fixtureHash, {
    profilesHash: freeze.generalization.profilesHash, preflightHash: freeze.generalization.preflightHash,
  });
  const verification = await reconstruct(c, original);
  assert(receipt.originalRunId === item.root && receipt.originalResultHash === item.raw && receipt.originalIntentHash === item.intent &&
    receipt.originalHttpHash === item.http && digest(JSON.stringify(verification)) === digest(JSON.stringify(receipt.verification)),
    'crm026_result_window_receipt_changed');
  return { ...original, verification };
}

async function recoverResultWindow(c) {
  const item = terminalIncident;
  const [freeze, previous, raw] = await Promise.all([read(resolve(MEMORY_ROOT, 'freeze.json'), item.freeze),
    read(resolve(MEMORY_ROOT, 'system-message-recovery.json'), item.previous), read(path(item.key, 'result'), item.raw)]);
  assert(freeze.generalization.fixtureHash === c.fixtureHash && freeze.generalization.profilesHash === c.profilesHash &&
    freeze.generalization.preflightHash === c.preflightHash, 'crm026_result_window_environment_changed');
  const verification = await reconstruct(c, raw);
  const replacements = Object.fromEntries(await Promise.all(Object.keys(freeze.scripts).map(async name =>
    [name, digest(await readFile(resolve(import.meta.dirname, name)))])));
  return sealResultWindowRecovery({ version: 'crm026-result-window-receipt-v1', key: item.key, originalFreezeHash: item.freeze,
    originalRunId: item.root, originalResultHash: item.raw, originalIntentHash: item.intent, originalHttpHash: item.http,
    previousRecoveryHash: item.previous, previousGeneralizationRunnerHash: previous.replacementGeneralizationRunnerHash,
    replacementGeneralizationRunnerHash: digest(await readFile(import.meta.filename)), replacementScripts: replacements, verification });
}

async function main([command, fixtureHash, detail, ...rest]) {
  assert(!rest.length && ['bind', 'run', 'recover-result-window'].includes(command), 'crm026_generalization_runner_arguments');
  const c = await loadGeneralizationEnvironment(fixtureHash);
  console.info(JSON.stringify(command === 'bind' ? await bind(c, detail) :
    command === 'recover-result-window' ? await recoverResultWindow(c) : await run(c, detail)));
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) main(process.argv.slice(2)).catch(error => {
  console.error(/^[a-z0-9_]{1,110}$/.test(error?.message ?? '') ? error.message : 'crm026_generalization_run_failed');
  process.exitCode = 1;
});
