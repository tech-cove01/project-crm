/** Isolated, serial CRM-025 evaluation. Only the authenticated Workbench API can create a root. */
import assert from 'node:assert/strict';
import { access, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual as same } from 'node:util';
import { at, business, digest, idle, one, optional, read, seal, sha, uuid } from './crm024-fixtures.mjs';
import { crm025Context, crm025Transaction, crm025Transport, makeScopeTask, RECOVERED_FIXTURE_FILE, RECOVERED_PREFLIGHT_FILE,
  RECOVERED_RUNTIME_FILE } from './crm025-materials-context.mjs';
import { BASE, BASELINE_ARCHIVE, CANDIDATE_INSPECT_DENIAL, CANDIDATE_INSPECT_DENIAL_DISABLED, CANDIDATE_WORKER_LOSS, FOLLOWUP_TOOL,
  MODEL, PHASES, SAFETY_FREEZE_FILE, SCOPE_REPLAY_FILE, SPLITS, TERMINAL, advanceLedgerSlot, candidateRecoveryScriptHashes,
  candidateRecoveryScripts, isRecoveredCandidateIncident, payloadHash, planSlots, product, read025BaselineSegments, read025OriginalFreeze,
  read025OriginalMeters, readFrozenDataset, reconcileInspectFollowupDenial, reserveSlot, safetySlots, verifyRecoveredMaterials, verifyScopeReplay,
  verifySlotMap } from './crm025-run-core.mjs';
import { findRoots, mountedTools, protectionFor, snapshot, summarizeUsage } from './crm025-run-capture.mjs';

const freezePath = phase => phase === 'baseline' ? SAFETY_FREEZE_FILE : resolve(BASE, 'candidate', 'freeze.json');
const pathFor = (slot, kind) => resolve(BASE, slot.phase, slot.split, `${slot.label}-${kind}.json`);
const candidateRecoveryPath = resolve(BASE, 'candidate', 'recovery.json');
const candidateH11RecoveryPath = resolve(BASE, 'candidate', 'recovery-h11.json');
const candidateH11DisabledRecoveryPath = resolve(BASE, 'candidate', 'recovery-h11-disabled.json');
const recoveryFor = (recovery, key) => [recovery?.value, recovery?.h11?.value, recovery?.h11Disabled?.value].find(row => row?.key === key);
const wellKnownFiles = ['crm024-fixtures.mjs', 'crm024-scope-audit.mjs', 'crm022-sales.mjs'];
const pathExists = path => access(path).then(() => true, error => {
  if (error.code === 'ENOENT') return false;
  throw error;
});

async function scriptHashes() {
  const files = (await readdir(import.meta.dirname)).filter(file => /^crm025-.*\.mjs$/.test(file) && !file.endsWith('.test.mjs'));
  return Object.fromEntries(await Promise.all([...files, ...wellKnownFiles].sort().map(async file =>
    [file, digest(await readFile(resolve(import.meta.dirname, file)))])));
}

async function candidateRecoveryRecord(freezeHash, proofHash, archivedScriptHashes) {
  const incident = CANDIDATE_WORKER_LOSS;
  assert(freezeHash === incident.freezeHash && proofHash === incident.proofHash, 'crm025_candidate_recovery_identity_required');
  const [frozen, proof] = await Promise.all([read(freezePath('candidate'), freezeHash),
    read(resolve(BASE, 'candidate', 'worker-loss-assessment.json'), proofHash)]);
  const { key, runId, jobId } = incident;
  const slot = frozen.slots?.holdout?.[12];
  const archive = proof.archive;
  const unmeteredParent = { attempts: 1, maxSteps: MODEL.maxSteps, inputAndOutput: MODEL.tokenBudget };
  assert(frozen.phase === 'candidate' && frozen.segment === 'candidate' && frozen.productCommit === incident.productCommit &&
    slot?.key === key && slot.phase === 'candidate' && slot.split === 'holdout' && slot.label === 'H07-auto' &&
    frozen.config?.max_steps === unmeteredParent.maxSteps && frozen.config?.token_budget === unmeteredParent.inputAndOutput &&
    proof.version === 1 && proof.candidateFreezeHash === freezeHash && proof.productCommit === incident.productCommit &&
    proof.key === key && proof.runId === runId && proof.technicalDisposition === 'invalid_environment' &&
    proof.opaqueInitialReadOutputs === true && proof.noReplacement === true && proof.unmeteredParentAttempt === true &&
    proof.modelBudgetAllowance?.inputAndOutput === unmeteredParent.inputAndOutput &&
    same(proof.facts?.root, { id: runId, status: 'completed' }) && same(proof.facts?.job, { id: jobId, status: 'done', attempts: 2 }) &&
    same(proof.facts?.counts, { proposals: 0, effects: 0, outbox: 0, active: 0 }) && proof.facts?.unchanged === true &&
    Object.keys(archive ?? {}).length === 6 && ['intent', 'receipt', 'result', 'meter', 'loss', 'unresolved']
      .every(kind => sha.test(archive[`${kind}Hash`])), 'crm025_candidate_recovery_proof_unbound');
  const { intentHash, receiptHash, resultHash, meterHash, lossHash, unresolvedHash } = archive;
  const recovery = { version: 1, freezeHash, key, runId, jobId, intentHash, receiptHash, resultHash, meterHash, lossHash, unresolvedHash,
    proofHash, scriptHashes: archivedScriptHashes ?? candidateRecoveryScripts(frozen.scriptHashes, await scriptHashes()), unmeteredParent };
  const [intent, receipt, raw, meter, loss, unresolved] = await Promise.all([
    read(pathFor(slot, 'intent'), intentHash), read(pathFor(slot, 'receipt'), receiptHash), readFile(pathFor(slot, 'result')),
    read(pathFor(slot, 'meter'), meterHash), read(resolve(BASE, 'candidate', 'worker-loss.json'), lossHash),
    readFile(pathFor(slot, 'unresolved-06ff931f-a041-456f-8e9a-faac8a00badb')),
  ]);
  assert(digest(raw) === resultHash && digest(unresolved) === unresolvedHash &&
    [intent, receipt].every(row => row.key === key && row.freezeHash === freezeHash) && intent.datasetHash === frozen.datasetHash &&
    receipt.httpStatus === 201 && receipt.runId === runId && isRecoveredCandidateIncident(key, freezeHash, meter, recovery) &&
    same(meter, proof.reportedUsage) && loss.candidateFreeze === freezeHash && loss.originalObservationHash === unresolvedHash &&
    loss.originalJobAttempts === 1 && loss.recoverSameQueueJob === true && loss.newPost === false,
  'crm025_candidate_recovery_archive_changed');
  return recovery;
}

async function readWorkerRecovery(freezeHash) {
  const raw = await readFile(candidateRecoveryPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!raw) return null;
  const hash = digest(raw);
  assert.equal(hash, CANDIDATE_INSPECT_DENIAL.previousRecoveryHash, 'crm025_candidate_worker_recovery_changed');
  const value = JSON.parse(raw);
  assert(same(value, await candidateRecoveryRecord(freezeHash, value?.proofHash, value.scriptHashes)), 'crm025_candidate_recovery_changed');
  return { hash, value };
}

async function inspectDenialRecoveryRecord(incident, freezeHash, previousRecoveryHash, proofHash, archivedScriptHashes) {
  assert(freezeHash === incident.freezeHash && previousRecoveryHash === incident.previousRecoveryHash && proofHash === incident.proofHash,
    'crm025_candidate_h11_identity_required');
  const [frozen, proof, guard] = await Promise.all([read(freezePath('candidate'), freezeHash),
    read(resolve(BASE, 'candidate', incident.proofFile), proofHash),
    readFile(resolve(import.meta.dirname, '../../lib/ai/agents/workbench-start-job.ts'))]);
  const { key, runId, jobId, toolName, callId, controlText, archive } = incident;
  const slot = frozen.slots?.holdout?.[incident.holdoutIndex];
  assert(frozen.phase === 'candidate' && frozen.segment === 'candidate' && frozen.productCommit === incident.productCommit &&
    slot?.key === key && slot.phase === 'candidate' && slot.split === 'holdout' && key === `candidate.${slot.caseId}.${slot.arm}` &&
    slot.label === `${slot.caseId}-${slot.arm}` &&
    proof.version === 1 && proof.candidateFreezeHash === freezeHash && proof.previousRecoveryHash === previousRecoveryHash &&
    proof.productCommit === incident.productCommit && proof.key === key && proof.runId === runId && same(proof.archive, archive) &&
    proof.disposition === 'observed_inspect_block' && proof.noReplacement === true && proof.toolName === toolName &&
    proof.callId === callId && proof.controlText === controlText && proof.rawErrorFlag === false && proof.rawEventStatus === 'success' &&
    proof.validArm === incident.validArm && proof.guardBeforeDispatch === true && proof.guardSourceHash === digest(guard) &&
    same(proof.status?.root, { id: runId, status: 'partial', mode: 'inspect' }) &&
    same(proof.status?.job, { id: jobId, status: 'done', attempts: 1 }) && proof.status?.unchanged === true &&
    same(proof.status?.counts, { scheduled_followups: 0, mcp_dispatch: 0, proposals: 0, effects: 0, outbox: 0, active: 0 }),
  'crm025_candidate_h11_proof_unbound');
  const recovery = { version: 1, freezeHash, previousRecoveryHash, key, runId, jobId, ...archive, proofHash,
    scriptHashes: archivedScriptHashes ?? candidateRecoveryScripts(frozen.scriptHashes, await scriptHashes()), toolName, callId, controlText,
    rawErrorFlag: proof.rawErrorFlag, rawEventStatus: proof.rawEventStatus, validArm: proof.validArm };
  const [intent, receipt, raw, meter] = await Promise.all([
    read(pathFor(slot, 'intent'), archive.intentHash), read(pathFor(slot, 'receipt'), archive.receiptHash),
    readFile(pathFor(slot, 'result')), read(pathFor(slot, 'meter'), archive.meterHash),
  ]);
  assert(digest(raw) === archive.resultHash && [intent, receipt].every(row => row.key === key && row.freezeHash === freezeHash) &&
    intent.datasetHash === frozen.datasetHash && receipt.httpStatus === 201 && receipt.runId === runId &&
    isRecoveredCandidateIncident(key, freezeHash, meter, recovery) && meter.specialists === 0 && same(meter, proof.reportedUsage),
  'crm025_candidate_h11_archive_changed');
  return recovery;
}

async function readInspectRecovery(incident, raw, freezeHash, previousRecoveryHash, archiveHash) {
  const hash = digest(raw);
  assert(!archiveHash || hash === archiveHash, 'crm025_candidate_h11_recovery_changed');
  const value = JSON.parse(raw);
  const scripts = archiveHash ? value.scriptHashes : undefined;
  const expected = await inspectDenialRecoveryRecord(incident, freezeHash, previousRecoveryHash, value?.proofHash, scripts);
  assert(same(value, expected), 'crm025_candidate_h11_recovery_changed');
  return { hash, value };
}

/** Reads sealed technical evidence. Original answers and the initial observation stay opaque. */
export async function read025CandidateRecovery(freezeHash) {
  const readOptional = file => readFile(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const [worker, raw, disabledRaw] = await Promise.all([readWorkerRecovery(freezeHash),
    readOptional(candidateH11RecoveryPath), readOptional(candidateH11DisabledRecoveryPath)]);
  assert(!disabledRaw || raw, 'crm025_candidate_h11_disabled_requires_auto_recovery');
  if (raw) {
    assert(worker, 'crm025_candidate_h11_requires_worker_recovery');
    const h11 = await readInspectRecovery(CANDIDATE_INSPECT_DENIAL, raw, freezeHash, worker.hash,
      disabledRaw ? CANDIDATE_INSPECT_DENIAL_DISABLED.previousRecoveryHash : undefined);
    if (!disabledRaw) return { ...worker, h11 };
    const h11Disabled = await readInspectRecovery(CANDIDATE_INSPECT_DENIAL_DISABLED, disabledRaw, freezeHash, h11.hash);
    return { ...worker, h11, h11Disabled };
  }
  if (worker) {
    const frozen = await read(freezePath('candidate'), freezeHash);
    assert(same(worker.value.scriptHashes, candidateRecoveryScripts(frozen.scriptHashes, await scriptHashes())),
      'crm025_candidate_recovery_changed');
  }
  return worker;
}

function verifyCandidateRecoveryProduct(frozen) {
  assert(product('candidate', CANDIDATE_WORKER_LOSS.productCommit).hash === frozen.productHash,
    'crm025_candidate_recovery_product_changed');
}

async function recoverCandidate(freezeHash, proofHash) {
  const frozen = await read(freezePath('candidate'), freezeHash);
  verifyCandidateRecoveryProduct(frozen);
  const recovery = await candidateRecoveryRecord(freezeHash, proofHash);
  assert.equal(payloadHash(recovery), CANDIDATE_INSPECT_DENIAL.previousRecoveryHash, 'crm025_candidate_worker_recovery_changed');
  return seal(candidateRecoveryPath, recovery);
}

async function recoverCandidateH11(freezeHash, previousRecoveryHash, proofHash) {
  const worker = await readWorkerRecovery(freezeHash);
  assert(worker?.hash === previousRecoveryHash, 'crm025_candidate_h11_requires_worker_recovery');
  verifyCandidateRecoveryProduct(await read(freezePath('candidate'), freezeHash));
  const recovery = await inspectDenialRecoveryRecord(CANDIDATE_INSPECT_DENIAL, freezeHash, previousRecoveryHash, proofHash);
  assert.equal(payloadHash(recovery), CANDIDATE_INSPECT_DENIAL_DISABLED.previousRecoveryHash, 'crm025_candidate_h11_recovery_changed');
  return seal(candidateH11RecoveryPath, recovery);
}

async function recoverCandidateH11Disabled(freezeHash, previousRecoveryHash, proofHash) {
  const worker = await readWorkerRecovery(freezeHash);
  assert(worker, 'crm025_candidate_h11_requires_worker_recovery');
  const h11 = await readInspectRecovery(CANDIDATE_INSPECT_DENIAL, await readFile(candidateH11RecoveryPath), freezeHash, worker.hash,
    CANDIDATE_INSPECT_DENIAL_DISABLED.previousRecoveryHash);
  assert(h11.hash === previousRecoveryHash, 'crm025_candidate_h11_disabled_requires_auto_recovery');
  verifyCandidateRecoveryProduct(await read(freezePath('candidate'), freezeHash));
  return seal(candidateH11DisabledRecoveryPath, await inspectDenialRecoveryRecord(CANDIDATE_INSPECT_DENIAL_DISABLED,
    freezeHash, previousRecoveryHash, proofHash));
}

async function inputs(fixtureHash, preflightHash) {
  assert(sha.test(fixtureHash) && sha.test(preflightHash), 'crm025_input_hash_required');
  const [{ dataset, datasetHash }, context, fixture, preflight] = await Promise.all([readFrozenDataset(), crm025Context({ recovered: true }),
    read(RECOVERED_FIXTURE_FILE, fixtureHash), read(RECOVERED_PREFLIGHT_FILE, preflightHash)]);
  assert(fixture.org === context.org && fixture.databaseId === context.databaseId && fixture.datasetHash === datasetHash &&
    fixture.environmentHash === context.environmentHash && preflight.ready === true && preflight.fixtureHash === fixtureHash &&
    preflight.datasetHash === datasetHash && preflight.environmentHash === context.environmentHash &&
    preflight.noModel === true && same(preflight.sourceIds, fixture.sourceIds), 'crm025_preflight_unbound');
  return { dataset, datasetHash, context, fixture, preflight };
}

async function productConfig(q, c, fixture) {
  const row = one(await q(`select a.id,a.builtin_key,a.is_active,a.paused_at,v.id version_id,v.provider,v.model,v.tool_ids,v.knowledge_source_ids,
    v.max_steps,v.token_budget,v.cost_budget_cents,
    encode(sha256(convert_to(v.system_prompt,'utf8')),'hex') "promptHash",
    encode(sha256(convert_to(to_jsonb(v)::text,'utf8')),'hex') "profileHash",o.settings->'llm' llm
    from ai_agents a join organizations o on o.id=a.organization_id join lateral (select * from ai_agent_versions
    where organization_id=$1::uuid and agent_id=a.id order by version_number desc limit 1) v on true
    where a.organization_id=$1::uuid and a.id=$2::uuid and a.origin='builtin' and a.archived_at is null`, [c.org, fixture.agent.id]));
  const { llm, ...redacted } = row;
  const sourceIds = [...fixture.sourceIds].sort();
  const sources = await q(`select id,is_active,status,source_type,source_metadata,updated_at::text from ai_knowledge_sources
    where organization_id=$1::uuid and is_active=true order by id`, [c.org]);
  assert(same(sources.map(source => source.id), sourceIds) && sources.every(source => source.is_active && source.status === 'ready' &&
    source.source_type === 'wiki' && source.source_metadata?.provider === 'weknora' && source.source_metadata?.visibility === 'organization' &&
    fixture.candidatePool.knowledgeBaseIds.includes(source.source_metadata?.knowledge_base_id)), 'crm025_active_wiki_sources_changed');
  const config = { ...redacted, versionId: row.version_id, toolIds: row.tool_ids, sourceIds,
    sources, organizationBinding: { provider: llm?.provider ?? null, model: llm?.default_model ?? null, parameters: llm?.params ?? null } };
  assert(row.is_active && !row.paused_at && row.builtin_key === 'sales_operations' && row.version_id === fixture.agent.versionId &&
    row.provider === MODEL.provider && row.model === MODEL.model && row.max_steps === MODEL.maxSteps && row.token_budget === MODEL.tokenBudget &&
    llm?.provider === MODEL.provider && llm.default_model === MODEL.model && llm.params?.temperature === MODEL.temperature &&
    row.profileHash === fixture.agent.profileHash && row.promptHash === fixture.agent.promptHash && same(llm.params, fixture.agent.modelParameters) &&
    same(row.tool_ids, fixture.agent.toolIds) && same([...row.knowledge_source_ids].sort(), sourceIds), 'crm025_agent_configuration_changed');
  return config;
}

async function verifyRecovery(fixtureHash, fixture, recoveryHash) {
  assert(sha.test(recoveryHash), 'crm025_scope_replay_hash_required');
  const [original, value, meters] = await Promise.all([read025OriginalFreeze(), read(SCOPE_REPLAY_FILE, recoveryHash), read025OriginalMeters()]);
  const old = await read(resolve(BASE, 'fixtures.json'), original.frozen.fixtureHash);
  verifyScopeReplay(value, { fixtureHash, originalFixtureHash: original.frozen.fixtureHash, databaseId: old.databaseId });
  verifyRecoveredMaterials(old, fixture);
  return { previous: { originalFreezeHash: original.hash, recoveryHash }, meters };
}

async function freeze(phase, fixtureHash, preflightHash, recoveryHash) {
  const live = product(phase);
  const { dataset, datasetHash, context, fixture } = await inputs(fixtureHash, preflightHash);
  verifySlotMap(dataset, fixture);
  const recovery = phase === 'baseline' ? await verifyRecovery(fixtureHash, fixture, recoveryHash) : null;
  const previous = recovery?.previous ?? await candidatePrevious(fixtureHash, preflightHash);
  const { createRuleManifest } = await import('./crm025-score.mjs');
  const ruleHash = payloadHash(createRuleManifest(dataset));
  const scripts = await scriptHashes();
  const slots = Object.fromEntries(SPLITS.map(split => [split,
    phase === 'baseline' ? safetySlots(dataset, split) : planSlots(dataset, phase, split)]));
  for (const slot of Object.values(slots).flatMap(items => items)) {
    const artifacts = await Promise.all(['intent', 'receipt', 'meter', 'result'].map(kind => pathExists(pathFor(slot, kind))));
    assert(artifacts.every(present => !present), 'crm025_fixture_already_used_or_changed');
  }
  const config = await crm025Transaction(context, true, async q => {
    await idle(q, context);
    for (const meter of recovery?.meters ?? []) {
      const scope = fixture.slots[meter.key];
      const root = one(await findRoots(q, context.org, scope.scope));
      assert(root.id === meter.runId && TERMINAL.has(root.status) && !root.busy &&
        same(await business(q, context, scope), scope.preState), 'crm025_historical_root_or_business_state_changed');
    }
    for (const slot of Object.values(slots).flatMap(items => items)) {
      const scope = fixture.slots[slot.key];
      assert(same(await business(q, context, scope), scope.preState) && !(await findRoots(q, context.org, scope.scope)).length,
        'crm025_fixture_already_used_or_changed');
    }
    return productConfig(q, context, fixture);
  });
  const mounted = await mountedTools(config, fixture.slots[slots.dev[0].key].scope, context.env);
  assert(mounted.root.crm_get_lead === 'read' && mounted.root.crm_get_contact === 'read' &&
    ['crm_list_leads', 'crm_list_conversations', 'crm_search_contacts'].every(tool => !Object.hasOwn(mounted.root, tool)),
  'crm025_fixed_scope_tools_not_applied');
  const currentLogicalIds = dataset.cases[0].sourcePolicy.authorizedSourceIds;
  const pages = Object.fromEntries(currentLogicalIds.map(id => [id, fixture.pages[id]]));
  assert(Object.values(pages).every(page => page?.pageId && config.sourceIds.includes(page.sourceId) &&
    sha.test(page.bodyHash) && Number.isSafeInteger(page.version)), 'crm025_current_page_map_missing');
  if (phase === 'candidate') {
    const safety = await read(SAFETY_FREEZE_FILE, previous.safetyFreezeHash);
    assert(safety.ruleHash === ruleHash && same(safety.config, config), 'crm025_baseline_seal_mismatch');
  }
  await mkdir(resolve(BASE, phase), { recursive: true });
  return seal(freezePath(phase), { version: 1, at: at(), phase, segment: phase === 'baseline' ? 'safe' : 'candidate',
    datasetHash, fixtureHash, preflightHash, ruleHash,
    environmentHash: context.environmentHash, productHash: live.hash, productCommit: live.productCommit,
    committingHead: live.commit, scriptHashes: scripts, config, sourceIds: config.sourceIds, slots, mounted, pages, previous });
}

async function candidatePrevious(fixtureHash, preflightHash, candidateRecovery) {
  const safetyFreezeHash = digest(await readFile(SAFETY_FREEZE_FILE));
  const segments = await read025BaselineSegments(safetyFreezeHash);
  assert(segments.safety.frozen.fixtureHash === fixtureHash && segments.safety.frozen.preflightHash === preflightHash,
    'crm025_candidate_uses_different_recovered_materials');
  const { sealedBaselinePrevious } = await import('./crm025-score-seal.mjs');
  return sealedBaselinePrevious(safetyFreezeHash, { candidateRecovery });
}

export async function read025Freeze(phase, freezeHash) {
  assert(PHASES.includes(phase) && sha.test(freezeHash), 'crm025_phase_freeze_required');
  const frozen = await read(freezePath(phase), freezeHash);
  const data = await inputs(frozen.fixtureHash, frozen.preflightHash);
  const live = product(phase, frozen.productCommit);
  const { createRuleManifest } = await import('./crm025-score.mjs');
  const candidateRecovery = phase === 'candidate' ? await read025CandidateRecovery(freezeHash) : null;
  assert(frozen.phase === phase && frozen.productCommit === live.productCommit && frozen.productHash === live.hash && frozen.datasetHash === data.datasetHash &&
    frozen.ruleHash === payloadHash(createRuleManifest(data.dataset)) && frozen.environmentHash === data.context.environmentHash &&
    same({ ...frozen.scriptHashes, ...candidateRecoveryScriptHashes(candidateRecovery) }, await scriptHashes()), 'crm025_execution_freeze_changed');
  const safetyHash = phase === 'baseline' ? freezeHash : frozen.previous?.safetyFreezeHash;
  const segments = await read025BaselineSegments(safetyHash);
  if (phase === 'candidate') {
    assert(same(frozen.previous, await candidatePrevious(frozen.fixtureHash, frozen.preflightHash, candidateRecovery)) &&
      frozen.segment === 'candidate' && SPLITS.every(split => same(frozen.slots[split], planSlots(data.dataset, phase, split))),
    'crm025_candidate_baseline_binding_changed');
  }
  return { ...data, frozen, freezeHash, segments, candidateRecovery };
}

async function ledger(run) {
  const meters = [...run.segments.meters];
  let firstUnused = null;
  for (const phase of PHASES) {
    const hash = phase === 'baseline' ? run.segments.safety.hash :
      (await pathExists(freezePath(phase)) ? digest(await readFile(freezePath(phase))) : null);
    for (const slot of SPLITS.flatMap(split => phase === 'baseline' ? safetySlots(run.dataset, split) : planSlots(run.dataset, phase, split))) {
      const [intent, meter, receipt, resultExists] = await Promise.all([
        optional(pathFor(slot, 'intent')), optional(pathFor(slot, 'meter')), optional(pathFor(slot, 'receipt')), pathExists(pathFor(slot, 'result')),
      ]);
      firstUnused = advanceLedgerSlot(firstUnused, slot.key, hash, run.datasetHash, run.fixture.slots[slot.key],
        { intent, meter, receipt, resultExists, recovery: recoveryFor(run.candidateRecovery, slot.key) });
      if (!intent) continue;
      // Hash opaque bytes here so development execution never consumes holdout answers or scores.
      assert(digest(await readFile(pathFor(slot, 'result'))) === meter.resultHash, 'crm025_result_changed');
      meters.push(meter);
    }
  }
  return { meters, firstUnused };
}

async function recordResult(run, slot, record) {
  const rawPath = pathFor(slot, 'result');
  const existing = await optional(rawPath);
  if (existing) assert(same(existing, record), 'crm025_result_already_sealed');
  const resultHash = existing ? digest(await readFile(rawPath)) : (await seal(rawPath, record, false)).sha256;
  const tokens = record.usage?.reported ?? { input: 0, output: 0, unknownInputRows: 0, unknownOutputRows: 0, modelRows: 0 };
  const receipt = { key: slot.key, freezeHash: run.freezeHash, resultHash, runId: record.runId, specialists: record.roleActivity?.length ?? 0,
    safe: record.protection.safe, environmentValid: record.protection.environmentValid, category: record.category, ...tokens };
  await seal(pathFor(slot, 'meter'), receipt, false);
  return receipt;
}

function payloadFor(run, slot, scope) {
  const item = run.dataset.cases.find(item => item.id === slot.caseId);
  return { agentId: run.frozen.config.id, task: makeScopeTask(item, scope, run.dataset),
    mode: 'inspect', collaboration: slot.arm, scope: scope.scope };
}

async function observe(run, slot) {
  const { context, frozen, freezeHash, datasetHash } = run;
  const scope = run.fixture.slots[slot.key];
  const payload = payloadFor(run, slot, scope);
  const intent = await read(pathFor(slot, 'intent'));
  assert(intent.key === slot.key && intent.freezeHash === freezeHash && intent.payloadHash === payloadHash(payload), 'crm025_intent_changed');
  let receipt = await optional(pathFor(slot, 'receipt'));
  if (receipt) assert(receipt.key === slot.key && receipt.freezeHash === freezeHash, 'crm025_receipt_changed');
  const existing = await optional(pathFor(slot, 'result'));
  if (existing) {
    assert(existing.freezeHash === freezeHash && existing.caseId === slot.caseId && existing.arm === slot.arm, 'crm025_result_identity_changed');
    return await optional(pathFor(slot, 'meter')) ?? recordResult(run, slot, existing);
  }
  const probe = () => crm025Transaction(context, true, q => findRoots(q, context.org, scope.scope));
  const base = { phase: slot.phase, split: slot.split, caseId: slot.caseId, arm: slot.arm, freezeHash, datasetHash };
  if (scope.expectedHttpStatus === 403 && receipt?.httpStatus === 403 && receipt.errorCode === 'forbidden_role' && !receipt.runId) {
    const state = await crm025Transaction(context, true, async q => {
      assert(!(await findRoots(q, context.org, scope.scope)).length, 'crm025_denial_created_a_root');
      return business(q, context, scope);
    });
    const unchanged = same(state, scope.preState);
    return recordResult(run, slot, { ...base, runId: null, terminal: null, category: 'permission_blocked', receipt,
      protection: { unchanged, environmentValid: true, validArm: false, safe: unchanged }, usage: null, roleActivity: [],
      runElapsedMs: null, observedElapsedMs: Date.now() - Date.parse(intent.at), snapshot: null });
  }
  const until = Date.now() + 300_000;
  let root;
  do {
    const roots = await probe();
    assert(roots.length <= 1 && (!receipt?.runId || !roots.length || roots[0].id === receipt.runId), 'crm025_ambiguous_root');
    root = roots[0];
    if (root && TERMINAL.has(root.status) && !root.busy) break;
    if (!root && !receipt?.runId) break;
    await sleep(2200);
  } while (Date.now() < until);
  if (!root || !TERMINAL.has(root.status) || root.busy) {
    await seal(pathFor(slot, `unresolved-${randomUUID()}`), { ...base, at: at(), runId: root?.id ?? receipt?.runId ?? null,
      httpStatus: receipt?.httpStatus ?? null, reason: 'read_only_reconciliation_required', noReplacement: true }, false);
    throw new Error('crm025_unresolved_request');
  }
  const { snap, protection } = await crm025Transaction(context, true, async q => {
    const snap = await snapshot(q, context, root.id, scope);
    let protection = protectionFor(snap, payload, scope, frozen, context.org);
    if (slot.phase === 'candidate' && run.candidateRecovery?.h11Disabled && scope.expectedHttpStatus === 201) {
      protection = await reconcileInspectFollowupDenial(snap, protection, frozen, root.id, async jobId => one(await q(`select
        (select count(*)::int from cron_jobs where organization_id=$1::uuid and contact_id=$2::uuid
          and kind='at' and job_kind='followup_turn') "scheduledFollowups",
        (select count(*)::int from api_audit_log where organization_id=$1::uuid and request_id::text=any($3::text[])
          and action='mcp.tool_called' and metadata->>'tool_name'=$4) "mcpDispatches"`,
      [context.org, scope.contactId, [root.id, jobId], FOLLOWUP_TOOL])));
    }
    return { snap, protection };
  });
  const current = snap.runs.find(row => row.id === root.id);
  if (scope.expectedHttpStatus !== 201) {
    protection.environmentValid = false;
    protection.safe = false;
  }
  if (!receipt) {
    receipt = { at: at(), key: slot.key, freezeHash, httpStatus: null, runId: current.id,
      errorCode: null, requestId: null, source: 'read_only_database_reconciliation' };
    await seal(pathFor(slot, 'receipt'), receipt, false);
  }
  const roleActivity = snap.runs.filter(row => row.run_kind === 'specialist').map(row => ({ role: row.specialist_key, status: row.status,
    modelTurns: row.specialist_usage?.modelTurns ?? null, modelRows: snap.calls.filter(call => call.workbench_run_id === row.id).length,
    toolAttempts: snap.requests.filter(request => request.run_id === row.id).length, toolResults: snap.tools.filter(tool => tool.run_id === row.id).length }));
  return recordResult(run, slot, { ...base, runId: current.id, terminal: current.status, category: !protection.safe ? 'safety_stop' :
    !protection.environmentValid ? 'invalid_environment' : 'settled', receipt, protection, usage: summarizeUsage(snap), roleActivity,
    runElapsedMs: current.completed_at ? Date.parse(current.completed_at) - Date.parse(current.created_at) : null,
    observedElapsedMs: Date.now() - Date.parse(intent.at), snapshot: snap });
}

async function submit(run, slot) {
  const scope = run.fixture.slots[slot.key];
  const payload = payloadFor(run, slot, scope);
  assert(product(slot.phase, run.frozen.productCommit).hash === run.frozen.productHash &&
    same(await scriptHashes(), { ...run.frozen.scriptHashes, ...candidateRecoveryScriptHashes(run.candidateRecovery) }) &&
    (slot.phase !== 'candidate' || same(run.candidateRecovery, await read025CandidateRecovery(run.freezeHash))) &&
    digest(await readFile(RECOVERED_RUNTIME_FILE)) === run.frozen.environmentHash, 'crm025_pre_submit_source_changed');
  const ledgerState = await ledger(run);
  assert(ledgerState.firstUnused === slot.key, 'crm025_next_frozen_slot_required');
  const used = reserveSlot(ledgerState.meters, slot.arm, run.candidateRecovery?.value.unmeteredParent);
  await crm025Transaction(run.context, true, async q => {
    await idle(q, run.context);
    const member = one(await q('select role from user_organizations where organization_id=$1::uuid and user_id=$2::uuid and revoked_at is null and accepted_at is not null',
      [run.context.org, scope.actorUserId]));
    const noConversations = one(await q('select count(*)::int total from conversations where organization_id=$1::uuid', [run.context.org])).total === 0;
    // The prior product lists tenant conversations before applying the selected contact filter.
    assert(noConversations && same(await productConfig(q, run.context, run.fixture), run.frozen.config) && member.role === scope.expectedRole &&
      same(await business(q, run.context, scope), scope.preState) && !(await findRoots(q, run.context.org, scope.scope)).length,
    'crm025_pre_submit_environment_changed');
  });
  await crm025Transport(run.context, scope, async request => {
    await seal(pathFor(slot, 'intent'), { at: at(), key: slot.key, freezeHash: run.freezeHash, datasetHash: run.datasetHash,
      scope: payload.scope, actorUserId: scope.actorUserId, payloadHash: payloadHash(payload), usageBefore: used }, false);
    let returned;
    try { returned = await request('/api/v1/ai/workbench/runs', 'POST', payload); }
    catch { /* The immutable intent is enough to forbid another POST. */ }
    await seal(pathFor(slot, 'receipt'), { at: at(), key: slot.key, freezeHash: run.freezeHash, httpStatus: returned?.httpStatus ?? null,
      runId: returned?.httpStatus === 201 && uuid.test(returned.data?.run_id) ? returned.data.run_id : null,
      errorCode: returned?.errorCode ?? null, requestId: returned?.requestId ?? null }, false);
  });
}

async function exclusively(action) {
  const lockPath = resolve(BASE, 'run.lock');
  const lock = await open(lockPath, 'wx', 0o600);
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, at: at() }) + '\n');
    return await action();
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

async function status(phase, split, segments = null, recovery = null) {
  const { dataset } = await readFrozenDataset();
  const slots = planSlots(dataset, phase, split);
  const meter = await Promise.all(slots.map(slot => optional(pathFor(slot, 'meter'))));
  const intent = await Promise.all(slots.map(slot => optional(pathFor(slot, 'intent'))));
  const archived = row => row && (isRecoveredCandidateIncident(row.key, row.freezeHash, row, recoveryFor(recovery, row.key)) ||
    (segments && BASELINE_ARCHIVE[row.key]?.safe === false && segments.meters.some(original => same(original, row))));
  console.info(JSON.stringify({ phase, split, planned: slots.length, submitted: intent.filter(Boolean).length,
    settled: meter.filter(Boolean).length, roots: meter.filter(row => row?.runId).length,
    denied: meter.filter(row => row?.category === 'permission_blocked').length,
    archivedIncidents: meter.filter(archived).length, paused: meter.filter(row => row && !row.safe && !archived(row)).length }));
}

async function main(args) {
  const [command, phase, splitOrFixture, hashOrPreflight, reconcileSlot] = args;
  if (!command || ['help', '--help'].includes(command)) {
    console.info('freeze-safety <fixture-sha> <preflight-sha> <scope-replay-sha> | freeze candidate <fixture-sha> <preflight-sha>');
    console.info('run <phase> <split> <freeze-sha> | reconcile <phase> <split> <freeze-sha> <case-arm> | status <phase> <split>');
    console.info('recover-candidate <candidate-freeze-sha> <worker-loss-assessment-sha>');
    console.info('recover-candidate-h11 <candidate-freeze-sha> <worker-loss-recovery-sha> <inspect-denial-assessment-sha>');
    console.info('recover-candidate-h11-disabled <candidate-freeze-sha> <h11-auto-recovery-sha> <inspect-denial-disabled-assessment-sha>');
    return;
  }
  if (command === 'recover-candidate') {
    assert(args.length === 3, 'crm025_candidate_recovery_arguments');
    return exclusively(() => recoverCandidate(phase, splitOrFixture));
  }
  if (command === 'recover-candidate-h11') {
    assert(args.length === 4, 'crm025_candidate_h11_arguments');
    return exclusively(() => recoverCandidateH11(phase, splitOrFixture, hashOrPreflight));
  }
  if (command === 'recover-candidate-h11-disabled') {
    assert(args.length === 4, 'crm025_candidate_h11_disabled_arguments');
    return exclusively(() => recoverCandidateH11Disabled(phase, splitOrFixture, hashOrPreflight));
  }
  if (command === 'freeze-safety') {
    assert(args.length === 4, 'crm025_safety_freeze_arguments');
    return exclusively(() => freeze('baseline', phase, splitOrFixture, hashOrPreflight));
  }
  if (command === 'freeze') {
    assert(args.length === 4 && phase === 'candidate', 'crm025_original_baseline_archived');
    return exclusively(() => freeze(phase, splitOrFixture, hashOrPreflight));
  }
  const split = splitOrFixture;
  assert(PHASES.includes(phase) && SPLITS.includes(split), 'crm025_invalid_batch');
  if (command === 'status') {
    const segments = await pathExists(SAFETY_FREEZE_FILE) ? await read025BaselineSegments(digest(await readFile(SAFETY_FREEZE_FILE))) : null;
    const recovery = phase === 'candidate' ? await read025CandidateRecovery(CANDIDATE_WORKER_LOSS.freezeHash) : null;
    return status(phase, split, segments, recovery);
  }
  assert(['run', 'reconcile'].includes(command), 'crm025_invalid_command');
  const run = await read025Freeze(phase, hashOrPreflight);
  assert(command === 'reconcile' || process.env.CRM025_EXECUTE === run.freezeHash, 'crm025_exact_opt_in_required');
  const slots = run.frozen.slots[split].filter(row => command === 'run' || row.label === reconcileSlot);
  assert(slots.length > 0, 'crm025_reconciliation_slot_required');
  await mkdir(resolve(BASE, phase, split), { recursive: true });
  for (const slot of slots) {
    const meter = await exclusively(async () => {
      const settled = await optional(pathFor(slot, 'meter'));
      if (settled) return settled;
      if (command === 'run' && !(await optional(pathFor(slot, 'intent')))) await submit(run, slot);
      return observe(run, slot);
    });
    await status(phase, split, run.segments, run.candidateRecovery);
    assert(meter.safe || isRecoveredCandidateIncident(slot.key, run.freezeHash, meter, recoveryFor(run.candidateRecovery, slot.key)),
      'crm025_result_requires_review');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) main(process.argv.slice(2)).catch(error => {
  const code = /^crm025_[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : error?.code === 'EEXIST' ? 'crm025_existing_artifact_or_lock' : 'crm025_evaluation_operation_failed';
  console.error(JSON.stringify({ error: code }));
  process.exitCode = 1;
});
