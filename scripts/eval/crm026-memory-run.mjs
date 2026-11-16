/** Stage authentic CRM confirmations and run each frozen Workbench slot once. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { digest, optional, read, ROOT, seal, sha, uuid } from './crm024-fixtures.mjs';
import { product } from './crm025-run-core.mjs';
import { ARMS, CHECKS, WEB, validateMemoryInput } from './crm026-memory-environment-config.mjs';
import { loadMemoryEnvironment, MEMORY_ROOT, memoryTransaction, memoryTransport, readForeignContact } from './crm026-memory-environment.mjs';
import { captureRun, locateRun, preRunState, verifyRun } from './crm026-run-capture.mjs';
import { checkMemoryProbes } from './crm026-memory-probes.mjs';

const MEMORY = '/api/v1/ai/customer-memory';
const WORKBENCH = '/api/v1/ai/workbench/runs';
const TOTAL_ALLOWANCE = 1_200_000;
const RESERVE = 36_000;
const files = (label, type) => resolve(MEMORY_ROOT, 'runs', `${label}-${type}.json`);
const slotOrder = Object.values(CHECKS).flat().flatMap((checkId, index) =>
  ARMS.map((_, position) => `${checkId}.${ARMS[(index + position) % ARMS.length]}`));
const categories = new Set(['preference', 'confirmed_fact', 'communication_context']);
const scoped = (c, action) => memoryTransaction(c, true, action);
const initialPreflight = resolve(MEMORY_ROOT, 'initial-preflight.json');
const freezePath = resolve(MEMORY_ROOT, 'freeze.json');
const recoveryPath = resolve(MEMORY_ROOT, 'system-message-recovery.json');
const terminalRecoveryPath = resolve(MEMORY_ROOT, 'result-window-recovery.json');
const initialRun = Object.freeze({
  key: 'A1.none',
  freezeHash: 'fb8fc0af9d281573be55b4537984aaa67ccd75afe4e9ae22b4af43ae8d607034',
  rawHash: 'fbda4bd1ac34ac6b47677a5093d3f223f6ef540c4b05f76f04fd80a08a6600c3',
  intentHash: 'fb337ae79d97c5f10fa2b67b743a20a276a24e2bf04dd7c039e58ebb0c2510b2',
  httpHash: 'd01648a46328fdbffdd1f444594f81976a676d26b27d3a09759fd5e3f15dae05',
});

function when(c, slot, check, type, index) {
  return { fixtureHash: c.fixtureHash, key: slot.key, type, index, scenarioHash: digest(JSON.stringify(check)) };
}

function factEvents(trajectory) {
  const planned = new Map();
  for (const check of trajectory.checks) for (const event of check.eventsBefore) {
    if (event.op === 'confirm') {
      assert(!planned.has(event.key) && categories.has(event.category) &&
        typeof event.body === 'string' && event.body.trim() === event.body &&
        (event.contact == null || trajectory.decoys.some(row => row.id === event.contact)), 'crm026_memory_fact_invalid');
      planned.set(event.key, { ...event, check });
    } else assert(event.op === 'revoke' && planned.has(event.key), 'crm026_memory_revocation_invalid');
  }
  return planned;
}

function memoryRow(c, slot, field, value) {
  assert(['request_key', 'id'].includes(field), 'crm026_query_memory_field');
  return scoped(c, async q => (await q(`select id,contact_id,body,category,request_key,
      content_hash,deleted_at::text,remote_deleted_at::text,sync_state,write_outcome,external_id
      from ai_customer_memories where organization_id=$1 and ${field}=$2`, [slot.organizationId, value]))[0] ?? null);
}

async function eventReceipt(stored, binding, operation) {
  const previous = await optional(stored);
  if (previous) {
    assert(digest(JSON.stringify(previous.binding)) === digest(JSON.stringify(binding)), 'crm026_memory_prior_receipt_changed');
    return previous;
  }
  const snapshot = { ...await operation(), binding };
  await seal(stored, snapshot, false);
  return snapshot;
}

async function applyEvent(c, slot, check, event, index, all) {
  const path = files(slot.key, `event-${index}`);
  return eventReceipt(path, when(c, slot, check, event.op, index), async () => {
    const contactId = slot.decoys[all.get(event.key)?.contact] ?? slot.contactId;
    const mark = when(c, slot, check, event.op, index);
    if (slot.arm === 'none') return { ...mark, control: 'no_confirmation' };
    const intentPath = files(slot.key, `event-${index}-intent`);
    let intent = await optional(intentPath);
    if (!intent) {
      const confirmation = all.get(event.key);
      const confirmationIndex = confirmation.check.eventsBefore.findIndex(row => row.key === event.key && row.op === 'confirm');
      const original = event.op === 'revoke' ? await read(files(`${confirmation.check.id}.${slot.arm}`, `event-${confirmationIndex}`)) : null;
      intent = { ...mark, contactId, requestKey: event.op === 'confirm' ? randomUUID() : null, memoryId: original?.memory.id ?? null };
      await seal(intentPath, intent, false);
    }
    assert(Object.entries(mark).every(([key, value]) => value === intent[key]) && intent.contactId === contactId, 'crm026_memory_event_intent_changed');
    const filter = event.op === 'confirm' ? 'request_key' : 'id';
    const identity = intent.requestKey ?? intent.memoryId;
    assert(uuid.test(identity), 'crm026_memory_event_identity');
    let memory = await memoryRow(c, slot, filter, identity);
    let receipt = await optional(files(slot.key, `event-${index}-http`));
    const alreadyApplied = event.op === 'confirm' ? !!memory : !!memory?.deleted_at;
    if (!alreadyApplied && !receipt) {
      receipt = await memoryTransport(c, slot, request => event.op === 'confirm'
        ? request(MEMORY, 'POST', { contact_id: contactId, request_key: intent.requestKey, category: event.category, body: event.body, confirmed: true })
        : request(MEMORY, 'DELETE', { id: intent.memoryId }));
      await seal(files(slot.key, `event-${index}-http`), receipt, false);
      memory = await memoryRow(c, slot, filter, identity);
    }
    assert(memory?.contact_id === contactId && (event.op === 'confirm' ? !memory.deleted_at && memory.body === event.body &&
      memory.category === event.category : memory.deleted_at && memory.body === ''), 'crm026_memory_mutation_unresolved');
    return { ...mark, receipt, memory };
  });
}

async function flushMem0(c, slot, memoryIds, label) {
  if (slot.arm !== 'mem0' || !memoryIds.length) return null;
  assert(c.fixture.database.mode === 'fresh', 'crm026_memory_integrations_require_dedicated_stack');
  return eventReceipt(files(label, 'sync'), { fixtureHash: c.fixtureHash, ids: memoryIds }, async () => {
    const isSettled = rows => rows.every(row => row?.deleted_at ? !!row.remote_deleted_at
      : row?.sync_state === 'synced' && !!row.external_id && row.write_outcome === 'confirmed');
    const started = performance.now();
    const deliveries = [];
    let rows = await Promise.all(memoryIds.map(id => memoryRow(c, slot, 'id', id)));
    for (let attempt = 0; !isSettled(rows) && attempt < 60; attempt += 1) {
      const response = await fetch(`${WEB}/api/v1/cron/ai-integration-drain`, { method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${c.env.INTERNAL_CRON_SECRET}`, Origin: WEB }, signal: AbortSignal.timeout(65_000) });
      const body = await response.json();
      deliveries.push({ status: response.status, data: body.data ?? null });
      assert(response.ok, 'crm026_memory_cron_rejected');
      rows = await Promise.all(memoryIds.map(id => memoryRow(c, slot, 'id', id)));
      if (!isSettled(rows)) await wait(750);
    }
    const evidence = { fixtureHash: c.fixtureHash, label, elapsedMs: Math.round(performance.now() - started), deliveries, rows,
      settled: isSettled(rows), providerUse: { tokenCount: null } };
    if (!evidence.settled) {
      await seal(files(label, `sync-failed-${randomUUID()}`), evidence, false);
      throw new Error('crm026_memory_sync_unresolved');
    }
    return evidence;
  });
}

async function admit(c, slot, scopeTransaction) {
  const totals = await scopeTransaction(c, q => q(`select coalesce(sum(coalesce(input_tokens,0)::bigint+coalesce(output_tokens,0)::bigint),0) used,
    (select count(*)::int from ai_workbench_runs where run_kind='root' and status in ('queued','running','awaiting_confirmation')) active
    from llm_calls where workbench_run_id is not null`));
  const usage = Number(totals[0].used);
  assert(Number.isSafeInteger(usage) && usage + RESERVE <= TOTAL_ALLOWANCE && totals[0].active === 0, 'crm026_model_budget_or_queue_unavailable');
  const before = await scopeTransaction(c, q => preRunState(q, slot));
  const fresh = slot.crmScope.conversationId ? before.messages.length === 1 && before.messages[0].id === slot.currentMessageId :
    before.messages.length === 0 && before.lead?.id === slot.crmScope.leadId;
  assert(before.contact?.id === slot.contactId && before.checkpoints === 0 && fresh &&
    !before.scheduled && !before.outbox, 'crm026_slot_state_not_isolated');
  return { before, usage };
}

export async function executeSlot(c, slot, task, profile, {
  path = files, scopeTransaction = scoped, transport = memoryTransport, pages = [],
} = {}) {
  const resultPath = path(slot.key, 'result');
  const previous = await optional(resultPath);
  if (previous) return previous;
  const payload = { agentId: profile.agentId, task, mode: 'inspect', collaboration: 'disabled', scope: slot.crmScope };
  const intentPath = path(slot.key, 'intent');
  let intent = await optional(intentPath);
  let launched = await optional(path(slot.key, 'http'));
  if (!intent) {
    assert(!await scopeTransaction(c, q => locateRun(q, slot)), 'crm026_untracked_root');
    const { before, usage } = await admit(c, slot, scopeTransaction);
    intent = { fixtureHash: c.fixtureHash, payloadHash: digest(JSON.stringify(payload)), at: new Date().toISOString(), before, usage };
    await seal(intentPath, intent, false);
    try {
      launched = await transport(c, slot, request => request(WORKBENCH, 'POST', payload));
    } catch {
      launched = { httpStatus: null, data: null, errorCode: 'submission_transport_unknown' };
    }
    await seal(path(slot.key, 'http'), launched, false);
  }
  assert(intent.fixtureHash === c.fixtureHash && intent.payloadHash === digest(JSON.stringify(payload)), 'crm026_slot_intent_changed');
  if (launched?.httpStatus >= 400 && launched.httpStatus < 500 && launched.errorCode && !launched.data?.run_id &&
      !await scopeTransaction(c, q => locateRun(q, slot))) {
    const result = { fixtureHash: c.fixtureHash, key: slot.key, intentHash: digest(await readFile(intentPath)),
      receipt: launched, elapsedMs: Math.round(Date.now() - Date.parse(intent.at)), disposition: 'rejected_no_root',
      observed: null, verification: { safe: true, configuration: false, fresh: null } };
    await seal(resultPath, result, false);
    return result;
  }
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const observed = await scopeTransaction(c, async q => {
      const root = await locateRun(q, slot);
      if (!root) return null;
      assert(!launched?.data?.run_id || launched.data.run_id === root.id, 'crm026_run_receipt_mismatch');
      if (root.status === 'awaiting_confirmation') throw new Error('crm026_unexpected_workbench_awaiting_confirmation');
      return captureRun(q, slot, root.id);
    });
    if (observed) {
      const verification = verifyRun(observed, { ...slot, versionId: profile.versionId, promptHash: profile.promptHash }, payload, intent.before, pages);
      const result = { fixtureHash: c.fixtureHash, key: slot.key, intentHash: digest(await readFile(intentPath)),
        receipt: launched, elapsedMs: Math.round(Date.now() - Date.parse(intent.at)), observed, verification };
      await seal(resultPath, result, false);
      return result;
    }
    await wait(1500);
  }
  throw new Error('crm026_original_workbench_run_unresolved');
}

async function run(c, input, requested) {
  assert(c.profiles && slotOrder.includes(requested), 'crm026_frozen_slot_required');
  const freeze = await read(freezePath);
  const live = await bindingsFor(c);
  const recovery = await readSystemRecovery();
  const effective = recovery ? { ...freeze, scripts: recovery.replacementScripts } : freeze;
  assert(digest(JSON.stringify(effective)) === digest(JSON.stringify(live)), 'crm026_frozen_batch_drift');
  await mkdir(resolve(MEMORY_ROOT, 'runs'), { recursive: true });
  const index = slotOrder.indexOf(requested);
  for (const prior of slotOrder.slice(0, index)) {
    const result = await readMemorySlot(files(prior, 'result'), prior);
    assert(result.fixtureHash === c.fixtureHash && result.verification.safe, 'crm026_previous_slot_requires_reconciliation');
  }
  const slot = c.fixture.slots[requested];
  const trajectory = input.trajectories.find(row => row.id === slot.trajectoryId);
  const check = trajectory.checks.find(row => row.id === slot.checkId);
  const all = factEvents(trajectory);
  const events = [];
  for (const [i, event] of check.eventsBefore.entries()) events.push(await applyEvent(c, slot, check, event, i, all));
  await flushMem0(c, slot, events.flatMap(row => row.memory ? [row.memory.id] : []), slot.key);
  const result = requested === initialRun.key && recovery ? await readMemorySlot(files(requested, 'result'), requested) :
    await executeSlot(c, slot, check.task, c.profiles.profiles[slot.arm]);
  assert(result.verification.safe, 'crm026_tool_or_scope_effect_unresolved');
  if (result.disposition === 'rejected_no_root') return { key: slot.key, disposition: result.disposition, http: result.receipt.httpStatus, input: 0, output: 0 };
  return { key: slot.key, runId: result.observed.root.id, terminal: result.observed.root.status, configuration: result.verification.configuration,
    fresh: result.verification.fresh, input: result.observed.usage.reported.input, output: result.observed.usage.reported.output };
}

export async function readSystemRecovery() {
  const receipt = await optional(recoveryPath);
  if (!receipt) return null;
  assert(receipt.version === 'crm026-system-receipt-v1' && receipt.key === initialRun.key &&
    receipt.originalFreezeHash === initialRun.freezeHash && receipt.originalResultHash === initialRun.rawHash &&
    receipt.originalIntentHash === initialRun.intentHash && receipt.originalHttpHash === initialRun.httpHash &&
    receipt.verification?.fresh === true && receipt.verification.safe === true && receipt.originalSafe === false,
  'crm026_system_recovery_unbound');
  const old = await read(freezePath, initialRun.freezeHash);
  const followup = await readResultWindowRecovery();
  const replacement = followup?.replacementScripts ?? receipt.replacementScripts;
  const generalizationRunner = followup?.replacementGeneralizationRunnerHash ?? receipt.replacementGeneralizationRunnerHash;
  assert(Object.keys(old.scripts).length === Object.keys(replacement).length &&
    Object.entries(old.scripts).every(([name, hash]) => name === 'crm026-memory-probes.mjs' ?
      replacement[name] === hash : sha.test(replacement[name])) &&
    receipt.originalGeneralizationRunnerHash === old.generalization.runnerHash && sha.test(generalizationRunner),
  'crm026_system_recovery_source_scope');
  for (const [name, hash] of [...Object.entries(replacement),
    ['crm026-generalization-run.mjs', generalizationRunner]]) {
    assert(digest(await readFile(resolve(import.meta.dirname, name))) === hash, 'crm026_system_recovery_source_drift');
  }
  return { ...receipt, replacementScripts: replacement, replacementGeneralizationRunnerHash: generalizationRunner };
}

export async function readResultWindowRecovery() {
  const receipt = await optional(terminalRecoveryPath);
  if (!receipt) return null;
  const original = await read(recoveryPath, receipt.previousRecoveryHash);
  assert(receipt.version === 'crm026-result-window-receipt-v1' && receipt.key === 'G2A' &&
    receipt.originalFreezeHash === initialRun.freezeHash && receipt.previousRecoveryHash ===
      '3c170190e3567fe2042621dad6e6d4703bb970b34d89d53a3ff8c2beec00504d' &&
    receipt.previousGeneralizationRunnerHash === original.replacementGeneralizationRunnerHash &&
    receipt.verification?.fresh === true && receipt.verification.safe === true,
    'crm026_result_window_unbound');
  return receipt;
}

export async function sealResultWindowRecovery(evidence) {
  return seal(terminalRecoveryPath, evidence, false);
}

export async function readMemorySlot(path, key, expectedHash) {
  if (key !== initialRun.key) return read(path, expectedHash);
  assert(!expectedHash || expectedHash === initialRun.rawHash, 'crm026_original_run_recovery_drift');
  const raw = await read(path, initialRun.rawHash);
  const recovery = await readSystemRecovery();
  if (!recovery) return raw;
  const frozen = await read(freezePath, initialRun.freezeHash);
  const c = await loadMemoryEnvironment(frozen.fixtureHash, { profilesHash: frozen.profilesHash });
  const slot = c.fixture.slots[initialRun.key];
  const profile = c.profiles.profiles.none;
  const intent = await read(files(initialRun.key, 'intent'), initialRun.intentHash);
  const payload = { agentId: profile.agentId, task: raw.observed.root.task, mode: 'inspect', collaboration: 'disabled', scope: slot.crmScope };
  const verification = verifyRun(raw.observed, { ...slot, versionId: profile.versionId, promptHash: profile.promptHash }, payload, intent.before);
  assert(raw.observed.root.id === recovery.originalRunId && raw.verification.safe === false &&
    intent.payloadHash === digest(JSON.stringify(payload)) && digest(JSON.stringify(verification)) === digest(JSON.stringify(recovery.verification)),
    'crm026_original_run_recovery_drift');
  return { ...raw, verification };
}

async function recoverSystemMessage(c, input) {
  const frozen = await read(freezePath, initialRun.freezeHash);
  assert(frozen.fixtureHash === c.fixtureHash && frozen.profilesHash === c.profilesHash, 'crm026_original_run_recovery_drift');
  const current = await bindingsFor(c);
  assert(digest(JSON.stringify({ ...current, scripts: frozen.scripts })) === digest(JSON.stringify(frozen)),
    'crm026_original_run_recovery_drift');
  const [raw, intent, http] = await Promise.all([read(files(initialRun.key, 'result'), initialRun.rawHash),
    read(files(initialRun.key, 'intent'), initialRun.intentHash), read(files(initialRun.key, 'http'), initialRun.httpHash)]);
  const slot = c.fixture.slots[initialRun.key];
  const profile = c.profiles.profiles.none;
  const payload = { agentId: profile.agentId, task: input.trajectories[0].checks[0].task, mode: 'inspect', collaboration: 'disabled', scope: slot.crmScope };
  assert(raw.key === initialRun.key && raw.fixtureHash === c.fixtureHash && raw.intentHash === initialRun.intentHash &&
    raw.verification.safe === false && raw.verification.fresh === false && intent.payloadHash === digest(JSON.stringify(payload)) &&
    http.httpStatus === 201 && raw.observed.root.id === http.data?.run_id && digest(JSON.stringify(raw.receipt)) === digest(JSON.stringify(http)) &&
    raw.observed.jobs.length === 1 && raw.observed.jobs[0].attempts === 1,
  'crm026_original_run_recovery_drift');
  const verification = verifyRun(raw.observed, { ...slot, versionId: profile.versionId, promptHash: profile.promptHash }, payload, intent.before);
  const { fresh: _fresh, safe: _safe, systemPromptHash: _prompt, systemPolicyHash: _policy, ...newChecks } = verification;
  const { fresh: _oldFresh, safe: _oldSafe, ...oldChecks } = raw.verification;
  assert(verification.safe && verification.fresh && digest(JSON.stringify(oldChecks)) === digest(JSON.stringify(newChecks)),
    'crm026_system_observer_recovery_invalid');
  const evidence = { version: 'crm026-system-receipt-v1', key: initialRun.key, originalRunId: raw.observed.root.id,
    originalSafe: false, originalFreezeHash: initialRun.freezeHash, originalResultHash: initialRun.rawHash,
    originalIntentHash: initialRun.intentHash, originalHttpHash: initialRun.httpHash,
    originalGeneralizationRunnerHash: frozen.generalization.runnerHash,
    replacementGeneralizationRunnerHash: digest(await readFile(resolve(import.meta.dirname, 'crm026-generalization-run.mjs'))),
    replacementScripts: current.scripts, verification };
  const prior = await optional(recoveryPath);
  if (prior) {
    assert(digest(JSON.stringify(prior)) === digest(JSON.stringify(evidence)), 'crm026_system_recovery_changed');
    return { sha256: digest(await readFile(recoveryPath)) };
  }
  return seal(recoveryPath, evidence, false);
}

async function preflight(c, input) {
  assert(c.profiles, 'crm026_memory_profiles_required');
  await mkdir(resolve(MEMORY_ROOT, 'runs'), { recursive: true });
  const checks = [];
  for (const key of slotOrder) {
    const slot = c.fixture.slots[key];
    const trajectory = input.trajectories.find(row => row.id === slot.trajectoryId);
    const check = trajectory.checks.find(row => row.id === slot.checkId);
    factEvents(trajectory);
    const details = await memoryTransport(c, slot, async request => ({
      selected: await request(`/api/v1/contacts/${slot.contactId}`), recent: await request(`/api/v1/conversations/${slot.conversationId}/messages`),
      previous: await request(`/api/v1/conversations/${slot.oldConversationId}/messages`), memory: await request(`${MEMORY}?contact_id=${slot.contactId}`),
    }));
    const state = await scoped(c, q => preRunState(q, slot));
    const original = c.fixture.arms[slot.arm].contacts[slot.trajectoryId].oldMessages;
    assert(Object.values(details).every(row => row.httpStatus === 200) && state.messages.length === 1 &&
      details.selected.data?.id === slot.contactId && details.recent.data?.length === 1 &&
      details.recent.data[0].id === slot.currentMessageId && details.recent.data[0].body === check.task &&
      details.previous.data?.length === original.length && original.every(message =>
        details.previous.data.some(row => row.id === message.id && digest(row.body) === message.bodyHash)) &&
      details.memory.data?.length === 0 &&
      state.messages[0].body === check.task && state.checkpoints === 0 && state.memory.length === 0 &&
      await scoped(c, q => locateRun(q, slot)) === null, 'crm026_initial_persistent_scope_invalid');
    checks.push({ key, details, state });
  }
  const forbidden = await readForeignContact(c, 'none', c.fixture.slots['A1.sql'].contactId);
  assert([403, 404].includes(forbidden.httpStatus), 'crm026_cross_org_protection_invalid');
  const adapter = resolve(MEMORY_ROOT, 'adapter-preflight.json');
  await checkMemoryProbes(c, adapter, flushMem0, memoryTransaction);
  const report = { fixtureHash: c.fixtureHash, safe: true, cases: checks, forbidden, adapterHash: digest(await readFile(adapter)), generatedRoots: 0 };
  await seal(initialPreflight, report, false);
  return { ready: checks.length, foreignDenied: forbidden.httpStatus, generatedRoots: 0 };
}

async function bindingsFor(c) {
  const preflight = await read(initialPreflight);
  const adapter = resolve(MEMORY_ROOT, 'adapter-preflight.json');
  await read(adapter, preflight.adapterHash);
  const generalization = await read(resolve(MEMORY_ROOT, 'generalization-binding.json'));
  const { loadGeneralizationEnvironment } = await import('./crm026-generalization-environment.mjs');
  const g = await loadGeneralizationEnvironment(generalization.fixtureHash, { profilesHash: generalization.profilesHash,
    preflightHash: generalization.preflightHash });
  const truth = await readFile(resolve(ROOT, '.local/crm026/private/generalization-truth-draft.json'));
  const productTree = product('candidate', c.fixture.productCommit);
  assert(preflight.fixtureHash === c.fixtureHash && preflight.safe === true && sha.test(c.profilesHash) &&
    generalization.productCommit === c.fixture.productCommit && generalization.inputHash === g.fixture.inputHash &&
    generalization.truthHash === digest(truth) && g.preflight?.ready === true && g.memory.fixtureHash === c.fixtureHash,
  'crm026_memory_preflight_required');
  const sources = ['crm026-memory-run.mjs', 'crm026-memory-probes.mjs', 'crm026-run-capture.mjs', 'crm026-judge.mjs'];
  const scripts = Object.fromEntries(await Promise.all(sources.map(async name => [name,
    digest(await readFile(resolve(import.meta.dirname, name)))])));
  return { fixtureHash: c.fixtureHash, environmentHash: c.environmentHash, profilesHash: c.profilesHash,
    productCommit: c.fixture.productCommit, productHash: productTree.hash, inputHash: c.fixture.inputHash,
    preflightHash: digest(await readFile(initialPreflight)), generalization, slots: slotOrder, scripts };
}

async function main([mode, fixtureHash, inputPath, key, ...rest]) {
  assert(!rest.length && sha.test(fixtureHash ?? '') && ['preflight', 'freeze', 'recover-system-message', 'run'].includes(mode), 'crm026_memory_run_arguments');
  const c = await loadMemoryEnvironment(fixtureHash);
  const input = validateMemoryInput(await read(resolve(inputPath), c.fixture.inputHash));
  const result = mode === 'preflight' ? await preflight(c, input) :
    mode === 'freeze' ? await seal(freezePath, await bindingsFor(c), false) :
      mode === 'recover-system-message' ? await recoverSystemMessage(c, input) : await run(c, input, key);
  console.info(JSON.stringify(result));
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) main(process.argv.slice(2)).catch(error => {
  console.error(/^[a-z0-9_]{1,110}$/.test(error?.message ?? '') ? error.message : 'crm026_memory_run_failed');
  process.exitCode = 1;
});
