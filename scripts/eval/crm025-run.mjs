/** Isolated, serial CRM-025 evaluation. Only the authenticated Workbench API can create a root. */
import assert from 'node:assert/strict';
import { mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual as same } from 'node:util';
import { at, business, digest, idle, one, optional, read, seal, sha, uuid } from './crm024-fixtures.mjs';
import { crm025Context, crm025Transaction, crm025Transport, makeScopeTask } from './crm025-materials-context.mjs';
import { BASE, BASELINE, MODEL, PHASES, SPLITS, TERMINAL, payloadHash, planSlots, product, readFrozenDataset,
  reserveSlot, verifySlotMap } from './crm025-run-core.mjs';
import { findRoots, mountedTools, protectionFor, snapshot, summarizeUsage } from './crm025-run-capture.mjs';

const freezePath = phase => resolve(BASE, phase, 'freeze.json');
const pathFor = (slot, kind) => resolve(BASE, slot.phase, slot.split, `${slot.label}-${kind}.json`);
const wellKnownFiles = ['crm024-fixtures.mjs', 'crm024-scope-audit.mjs', 'crm022-sales.mjs'];

async function scriptHashes() {
  const files = (await readdir(import.meta.dirname)).filter(file => /^crm025-.*\.mjs$/.test(file) && !file.endsWith('.test.mjs'));
  return Object.fromEntries(await Promise.all([...files, ...wellKnownFiles].sort().map(async file =>
    [file, digest(await readFile(resolve(import.meta.dirname, file)))])));
}

async function inputs(fixtureHash, preflightHash) {
  assert(sha.test(fixtureHash) && sha.test(preflightHash), 'crm025_input_hash_required');
  const [{ dataset, datasetHash }, context, fixture, preflight] = await Promise.all([readFrozenDataset(), crm025Context(),
    read(resolve(BASE, 'fixtures.json'), fixtureHash), read(resolve(BASE, 'preflight.json'), preflightHash)]);
  assert(fixture.org === context.org && fixture.databaseId === context.databaseId && fixture.datasetHash === datasetHash &&
    fixture.environmentHash === context.environmentHash && preflight.ready === true && preflight.fixtureHash === fixtureHash &&
    preflight.datasetHash === datasetHash && preflight.environmentHash === context.environmentHash, 'crm025_preflight_unbound');
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

async function freeze(phase, fixtureHash, preflightHash) {
  const live = product(phase);
  const { dataset, datasetHash, context, fixture } = await inputs(fixtureHash, preflightHash);
  verifySlotMap(dataset, fixture);
  const { createRuleManifest } = await import('./crm025-score.mjs');
  const ruleHash = payloadHash(createRuleManifest(dataset));
  const scripts = await scriptHashes();
  const slots = Object.fromEntries(SPLITS.map(split => [split, planSlots(dataset, phase, split)]));
  const config = await crm025Transaction(context, true, async q => {
    await idle(q, context);
    for (const slot of Object.values(slots).flatMap(items => items)) {
      const scope = fixture.slots[slot.key];
      assert(same(await business(q, context, scope), scope.preState) && !(await findRoots(q, context.org, scope.scope)).length,
        'crm025_fixture_already_used_or_changed');
    }
    return productConfig(q, context, fixture);
  });
  const mounted = await mountedTools(config, fixture.slots[slots.dev[0].key].scope, context.env);
  const currentLogicalIds = dataset.cases[0].sourcePolicy.authorizedSourceIds;
  const pages = Object.fromEntries(currentLogicalIds.map(id => [id, fixture.pages[id]]));
  assert(Object.values(pages).every(page => page?.pageId && config.sourceIds.includes(page.sourceId) &&
    sha.test(page.bodyHash) && Number.isSafeInteger(page.version)), 'crm025_current_page_map_missing');
  let previous = null;
  if (phase === 'candidate') {
    const path = resolve(BASE, 'baseline', 'holdout-seal.json');
    const [baseline, receipt] = await Promise.all([read(freezePath('baseline')), read(path)]);
    const baselineHash = digest(await readFile(freezePath('baseline')));
    assert(receipt.complete === true && receipt.phase === 'baseline' && receipt.taskSlots === 32 && receipt.probes === 48 && sha.test(receipt.manifestHash) &&
      receipt.datasetHash === datasetHash && receipt.freezeHash === baselineHash && baseline.datasetHash === datasetHash &&
      baseline.ruleHash === ruleHash && baseline.fixtureHash === fixtureHash && same(baseline.config, config), 'crm025_baseline_seal_mismatch');
    const meters = await ledger(dataset, true);
    assert.equal(meters.length, 48, 'crm025_baseline_unfinished');
    const devProbes = await sealedDevProbes(dataset, datasetHash, baselineHash);
    previous = { freezeHash: baselineHash, holdoutSealHash: digest(await readFile(path)), devProbeManifestHash: payloadHash(devProbes) };
  }
  await mkdir(resolve(BASE, phase), { recursive: true });
  return seal(freezePath(phase), { version: 1, at: at(), phase, datasetHash, fixtureHash, preflightHash, ruleHash,
    environmentHash: context.environmentHash, productHash: live.hash, productCommit: phase === 'baseline' ? BASELINE : live.commit,
    committingHead: live.commit, scriptHashes: scripts, config, sourceIds: config.sourceIds, slots, mounted, pages, previous });
}

async function sealedDevProbes(dataset, datasetHash, freezeHash) {
  const output = [];
  for (const item of dataset.cases.filter(row => row.split === 'development')) {
    for (const [index, probe] of item.retrieval.probes.entries()) {
      const label = `${item.id}-${index + 1}`;
      const dir = resolve(BASE, 'baseline', 'dev', 'probes');
      const intentPath = resolve(dir, `${label}-intent.json`);
      const resultPath = resolve(dir, `${label}-result.json`);
      const [intent, result, intentBytes, resultBytes] = await Promise.all([read(intentPath), read(resultPath), readFile(intentPath), readFile(resultPath)]);
      const contract = { datasetHash, freezeHash, phase: 'baseline', split: 'dev', caseId: item.id, probeNumber: index + 1, slot: label };
      assert(Object.entries(contract).every(([key, value]) => intent[key] === value && result[key] === value) &&
        result.intentHash === digest(intentBytes) && intent.request?.query === probe.query && intent.request.top === 5 &&
        result.query === probe.query && result.unsafe === false, 'crm025_baseline_probe_binding_changed');
      output.push({ label, intentHash: result.intentHash, resultHash: digest(resultBytes) });
    }
  }
  assert(output.length === 21, 'crm025_baseline_dev_probes_unfinished');
  return output;
}

export async function read025Freeze(phase, freezeHash) {
  assert(PHASES.includes(phase) && sha.test(freezeHash), 'crm025_phase_freeze_required');
  const frozen = await read(freezePath(phase), freezeHash);
  const data = await inputs(frozen.fixtureHash, frozen.preflightHash);
  const live = product(phase);
  const { createRuleManifest } = await import('./crm025-score.mjs');
  assert(frozen.phase === phase && frozen.productHash === live.hash && frozen.datasetHash === data.datasetHash &&
    frozen.ruleHash === payloadHash(createRuleManifest(data.dataset)) && frozen.environmentHash === data.context.environmentHash &&
    same(frozen.scriptHashes, await scriptHashes()), 'crm025_execution_freeze_changed');
  return { ...data, frozen, freezeHash };
}

async function ledger(dataset, baselineOnly = false) {
  const meters = [];
  for (const phase of baselineOnly ? ['baseline'] : PHASES) {
    const freeze = await optional(freezePath(phase));
    if (!freeze) continue;
    const hash = digest(await readFile(freezePath(phase)));
    for (const split of SPLITS) {
      for (const slot of planSlots(dataset, phase, split)) {
        const intent = await optional(pathFor(slot, 'intent'));
        if (!intent) continue;
        const meter = await optional(pathFor(slot, 'meter'));
        assert(meter?.safe === true && sha.test(meter.resultHash) && meter.freezeHash === hash && intent.freezeHash === hash &&
          meter.key === slot.key && intent.key === slot.key && ['input', 'output', 'specialists', 'unknownInputRows', 'unknownOutputRows']
            .every(field => Number.isSafeInteger(meter[field]) && meter[field] >= 0), 'crm025_unreconciled_or_unsafe_execution');
        // Hash opaque bytes here so development execution never consumes holdout answers or scores.
        assert(digest(await readFile(pathFor(slot, 'result'))) === meter.resultHash, 'crm025_result_changed');
        meters.push(meter);
      }
    }
  }
  return meters;
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
  const snap = await crm025Transaction(context, true, q => snapshot(q, context, root.id, scope));
  const current = snap.runs.find(row => row.id === root.id);
  const protection = protectionFor(snap, payload, scope, frozen, context.org);
  if (scope.expectedHttpStatus !== 201) protection.environmentValid = false;
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
  assert(product(slot.phase).hash === run.frozen.productHash && same(await scriptHashes(), run.frozen.scriptHashes) &&
    digest(await readFile(resolve(BASE, 'runtime.env'))) === run.frozen.environmentHash, 'crm025_pre_submit_source_changed');
  const used = reserveSlot(await ledger(run.dataset), slot.arm);
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

async function status(phase, split) {
  const { dataset } = await readFrozenDataset();
  const slots = planSlots(dataset, phase, split);
  const meter = await Promise.all(slots.map(slot => optional(pathFor(slot, 'meter'))));
  const intent = await Promise.all(slots.map(slot => optional(pathFor(slot, 'intent'))));
  console.info(JSON.stringify({ phase, split, planned: slots.length, submitted: intent.filter(Boolean).length,
    settled: meter.filter(Boolean).length, roots: meter.filter(row => row?.runId).length,
    denied: meter.filter(row => row?.category === 'permission_blocked').length,
    paused: meter.filter(row => row && !row.safe).length }));
}

async function main(args) {
  const [command, phase, splitOrFixture, hashOrPreflight, reconcileSlot] = args;
  if (!command || ['help', '--help'].includes(command)) {
    console.info('freeze <phase> <fixture-sha> <preflight-sha> | run <phase> <split> <freeze-sha> | reconcile <phase> <split> <freeze-sha> <case-arm> | status <phase> <split>');
    return;
  }
  if (command === 'freeze') return freeze(phase, splitOrFixture, hashOrPreflight);
  const split = splitOrFixture;
  assert(PHASES.includes(phase) && SPLITS.includes(split), 'crm025_invalid_batch');
  if (command === 'status') return status(phase, split);
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
    await status(phase, split);
    assert(meter.safe, 'crm025_result_requires_review');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) main(process.argv.slice(2)).catch(error => {
  const code = /^crm025_[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : error?.code === 'EEXIST' ? 'crm025_existing_artifact_or_lock' : 'crm025_evaluation_operation_failed';
  console.error(JSON.stringify({ error: code }));
  process.exitCode = 1;
});
