/** Execute the independent fixed-product task slots after the memory run. */
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { digest, optional, read, ROOT, seal, sha } from './crm024-fixtures.mjs';
import { executeSlot, readMemorySlot, readSystemRecovery } from './crm026-memory-run.mjs';
import { MEMORY_ROOT, PRODUCT_COMMIT } from './crm026-memory-environment-config.mjs';
import { GENERALIZATION_ARM, GENERALIZATION_FILES, generalizationTransaction, generalizationTransport,
  loadGeneralizationEnvironment } from './crm026-generalization-environment.mjs';

const truthPath = resolve(ROOT, '.local/crm026/private/generalization-truth-draft.json');
const bindingPath = resolve(MEMORY_ROOT, 'generalization-binding.json');
const runFolder = resolve(dirname(GENERALIZATION_FILES.preflight), 'runs');
const path = (id, category) => resolve(runFolder, `${id}-${category}.json`);
const scopeTransaction = (c, action) => generalizationTransaction(c, true, action);

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
    const prior = await read(path(key, 'result'));
    assert(prior.fixtureHash === c.fixtureHash && prior.verification.safe, 'crm026_generalization_slot_unsettled');
  }
  const task = c.input.cases.find(row => row.id === id).task;
  const slot = c.fixture.slots[id];
  const profile = c.profiles.profiles[GENERALIZATION_ARM];
  const result = await executeSlot(c, slot, task, profile, { path, scopeTransaction, transport: generalizationTransport, pages: c.pages });
  assert(result.verification.safe, 'crm026_generalization_effect_unresolved');
  if (result.disposition === 'rejected_no_root') return { caseId: id, disposition: result.disposition, http: result.receipt.httpStatus };
  return { caseId: id, runId: result.observed.root.id, terminal: result.observed.root.status, configuration: result.verification.configuration,
    fresh: result.verification.fresh, input: result.observed.usage.reported.input, output: result.observed.usage.reported.output };
}

async function main([command, fixtureHash, detail, ...rest]) {
  assert(!rest.length && ['bind', 'run'].includes(command), 'crm026_generalization_runner_arguments');
  const c = await loadGeneralizationEnvironment(fixtureHash);
  console.info(JSON.stringify(command === 'bind' ? await bind(c, detail) : await run(c, detail)));
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) main(process.argv.slice(2)).catch(error => {
  console.error(/^[a-z0-9_]{1,110}$/.test(error?.message ?? '') ? error.message : 'crm026_generalization_run_failed');
  process.exitCode = 1;
});
