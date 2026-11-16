/** Real CRM-024 workbench evaluation. Every live creation requires an immutable intent. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual as same } from 'node:util';
import { transport } from './crm022-sales.mjs';
import { createProtocol } from './crm024-freeze.mjs';
import { SCORE_VERSION, prepareReview, scoreComplex, scoreSimple } from './crm024-score.mjs';
import { BASE, ROOT, at, authorizeWiki, business, bytes, configuration, context, crm, digest, folder, idle, material,
  one, optional, prepareMaterials, read, restoreConfiguration, seal, seedMaterials, seedPhase, sha, uuid, verifyMaterial } from './crm024-fixtures.mjs';

const phases = ['calibration-1', 'calibration-2', 'formal'];
const roles = ['customer_evidence', 'opportunity_diagnosis', 'policy_advisor'];
const arms = ['disabled', 'auto'];
const terminals = ['completed', 'partial', 'failed', 'cancelled', 'awaiting_confirmation'];
const runtimePaths = ['app', 'lib', 'workers', 'supabase', 'pnpm-lock.yaml', 'package.json', 'next.config.ts', 'proxy.ts'];
const scriptNames = ['crm024-paired.mjs', 'crm024-fixtures.mjs', 'crm024-cases.mjs', 'crm024-freeze.mjs', 'crm024-score.mjs', 'crm022-sales.mjs'];
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout: 15000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }).trim();
const currentScripts = async () => Object.fromEntries(await Promise.all(scriptNames.map(async name => [name, digest(await readFile(resolve(import.meta.dirname, name)))])));
const auth = hash => assert(process.env.CRM024_EXECUTE === hash, 'crm024_exact_opt_in_required');

async function protocol(hash) {
  assert(sha.test(hash), 'crm024_protocol_hash_required');
  const value = await read(resolve(BASE, 'protocol.json'), hash);
  assert(bytes(value) === bytes(createProtocol()), 'crm024_frozen_protocol_sources_changed');
  assert(same(value.calibrationIds, ['S02', 'C01', 'K01']) && same(value.formalIds, ['A01', 'B01', 'C02', 'D01']) &&
    same(value.arms, arms) && value.model?.provider === 'dashscope' && value.model.model === 'qwen3.8-flash' && value.model.maxSteps === 12 &&
    value.model.tokenBudget === 36000 && value.model.temperature === 0 && value.model.reportedStop === 750000 &&
    [...value.calibrationIds, ...value.formalIds].every(id => value.cases[id]?.id === id && typeof value.cases[id].promptTemplate === 'string'), 'crm024_protocol_contract_changed');
  return value;
}

function blobs(ref) {
  return new Map(git('ls-tree', '-r', '-z', ref, '--', ...runtimePaths).split('\0').filter(Boolean).map(entry => {
    const split = entry.indexOf('\t');
    return [entry.slice(split + 1), entry.slice(0, split).split(' ')[2]];
  }));
}
const blobHash = map => digest(bytes([...map].sort(([a], [b]) => a.localeCompare(b))));

async function runtime(phase) {
  const names = (...args) => git(...args, '--', ...runtimePaths).split('\0').filter(Boolean);
  const changes = [...new Set([...names('diff', '--name-only', '--no-renames', '-z', 'HEAD'), ...names('ls-files', '--others', '--exclude-standard', '-z')])].sort();
  assert(phase !== 'formal' || !changes.length, 'crm024_formal_source_dirty');
  const product = blobs('HEAD'), changed = {};
  for (const name of changes) {
    try { changed[name] = digest(await readFile(resolve(ROOT, name))); product.set(name, git('hash-object', `--path=${name}`, '--', name)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; changed[name] = null; product.delete(name); }
  }
  return { head: git('rev-parse', 'HEAD'), effective: blobHash(product), changed };
}

async function verifyRuntime(phase, raw) {
  const current = await runtime(phase);
  assert(current.effective === raw.effective && Object.entries(current.changed).every(([name, hash]) => raw.changed[name] === hash),
    'crm024_frozen_runtime_changed');
  for (const [name, expected] of Object.entries(raw.changed)) {
    const now = await readFile(resolve(ROOT, name)).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    assert((now && digest(now)) === expected, 'crm024_frozen_runtime_bytes_changed');
  }
}

function planned(p, phase, selected) {
  const all = phase === 'formal' ? p.formalIds : p.calibrationIds;
  const subset = selected ?? all;
  assert(Array.isArray(subset) && subset.length > 0 && new Set(subset).size === subset.length && subset.every(id => all.includes(id)) &&
    (phase === 'calibration-2' || same(subset, all)), 'crm024_frozen_case_subset_invalid');
  return all.filter(id => subset.includes(id)).flatMap(id => (all.indexOf(id) % 2 ? [...arms].reverse() : arms)
    .map(arm => ({ id, arm, label: `${id}-${arm}` })));
}

function payloadFor(p, config, scope) {
  const task = p.cases[scope.id].promptTemplate.replace(/\{(leadId|contactId|stageId|pipelineId)\}/g, (_, name) => scope[name]);
  return { task, agentId: config.agent.id, mode: 'inspect', collaboration: scope.arm,
    scope: { leadId: scope.leadId, contactId: scope.contactId, pipelineId: scope.pipelineId } };
}

async function noRoot(q, c, scope) {
  const rows = await q("select id from ai_workbench_runs where organization_id=$1::uuid and run_kind='root' and scope->>'leadId'=$2::text limit 1", [c.org, scope.leadId]);
  assert(!rows.length, 'crm024_one_run_per_synthetic_scope');
}

async function freezePhase(p, c, phase, protocolHash, materials) {
  const base = folder(phase);
  assert(!(await optional(resolve(base, 'frozen.json'))), 'crm024_existing_freeze');
  const f = await read(resolve(base, 'fixtures.json'));
  const effective = await runtime(phase);
  assert(f.org === c.org && f.databaseId === c.databaseId && f.protocolHash === protocolHash && f.editionId === materials.editionId,
    'crm024_fixture_protocol_mismatch');
  const ids = [...new Set(Object.values(f.cases).map(scope => scope.id))];
  assert(same(Object.keys(f.cases), planned(p, phase, ids).map(row => row.label)), 'crm024_frozen_labels_mismatch');
  if (phase === 'formal') await requireAdmission(p, protocolHash, effective);
  const config = await crm(c, true, async q => {
    await idle(q, c);
    for (const scope of Object.values(f.cases)) {
      assert(same(await business(q, c, scope), f.objects[scope.label].before), 'crm024_authored_objects_changed');
      await noRoot(q, c, scope);
    }
    return configuration(q, c, p, materials);
  });
  const preflight = await verifyMaterial(c, p, f, materials, config);
  await verifyRuntime(phase, effective);
  await seal(resolve(base, 'frozen.json'), { at: at(), phase, protocolHash, editionId: materials.editionId, product: effective, scripts: await currentScripts(),
    fixtureHash: digest(await readFile(resolve(base, 'fixtures.json'))), materialsHash: digest(await readFile(resolve(BASE, 'materials.json'))),
    environmentHash: c.envHash, config, labels: Object.keys(f.cases), wiki: preflight.wiki, facts: preflight.facts });
}

async function preflightPhase(p, c, phase, protocolHash, materials) {
  const base = folder(phase), fixtures = await read(resolve(base, 'fixtures.json'));
  assert(fixtures.protocolHash === protocolHash && fixtures.editionId === materials.editionId, 'crm024_preflight_material_changed');
  const config = await crm(c, true, async q => {
    await idle(q, c);
    for (const scope of Object.values(fixtures.cases)) {
      await noRoot(q, c, scope);
      assert(same(await business(q, c, scope), fixtures.objects[scope.label].before), 'crm024_preflight_business_changed');
    }
    return configuration(q, c, p, materials);
  });
  const observed = await verifyMaterial(c, p, fixtures, materials, config);
  return seal(resolve(base, `material-preflight-${randomUUID()}.json`), { at: at(), protocolHash, editionId: materials.editionId,
    environmentHash: c.envHash, ...observed, proofOnly: true, modelRequested: false });
}

async function matchingRoots(q, c, payload) {
  return q(`select r.id,r.status,exists(select 1 from job_queue j where j.organization_id=$1::uuid and j.payload->>'runId'=r.id::text
    and j.status in ('pending','running')) busy from ai_workbench_runs r where r.organization_id=$1::uuid and r.run_kind='root' and r.mode='inspect'
    and r.actor_user_id=$2::uuid and r.agent_id=$3::uuid and r.task=$4 and r.scope=$5::jsonb`,
  [c.org, c.initiatorUserId, payload.agentId, payload.task, JSON.stringify(payload.scope)]);
}

async function ledger(p, phase, label, protocolHash) {
  let spent = 0, roots = 0, specialistCount = 0;
  for (const step of phases) {
    const frozen = await optional(resolve(folder(step), 'frozen.json'));
    if (!frozen) continue;
    let firstUnused;
    for (const slot of frozen.labels) {
      const intent = await optional(resolve(folder(step), `${slot}-intent.json`));
      if (!intent) { firstUnused ??= slot; continue; }
      const result = await optional(resolve(folder(step), `${slot}-result.json`));
      assert(intent.protocolHash === protocolHash && result?.settled && result.freezeHash === intent.freezeHash &&
        result.protection.unchanged && result.protection.sameExecution && !result.protection.proposals && !result.protection.scopeViolations &&
        !result.protection.writeAttempts && !result.protection.outboundAttempts && Number.isFinite(result.usage?.input_tokens) &&
        Number.isFinite(result.usage?.output_tokens), 'crm024_unreconciled_intent_or_safety_stop');
      spent += result.usage.input_tokens + result.usage.output_tokens;
      roots += 1;
      specialistCount += result.childRoles.length;
    }
    if (step === phase) assert(firstUnused === label, 'crm024_locked_order_or_existing_intent');
  }
  assert(spent + p.model.reserve < p.model.reportedStop && roots < 20 && specialistCount <= 27, 'crm024_reported_budget_stop');
  return { spent, roots, specialistCount };
}

async function create(c, p, phase, frozen, hash, f, scope, materials) {
  auth(hash);
  const lockPath = resolve(BASE, 'create.lock');
  // An interrupted process leaves this lock in place until a read-only human reconciliation.
  const lock = await open(lockPath, 'wx', 0o600);
  try {
    const accumulated = await ledger(p, phase, scope.label, frozen.protocolHash);
    if (phase === 'formal') await requireAdmission(p, frozen.protocolHash, frozen.product);
    const payload = payloadFor(p, frozen.config, scope);
    await crm(c, true, async q => {
      await idle(q, c);
      assert(same(await configuration(q, c, p, materials), frozen.config) && same(await business(q, c, scope), f.objects[scope.label].before),
        'crm024_precreate_inputs_changed');
      await noRoot(q, c, scope);
    });
    return await transport(c.env, { organizationId: c.org, initiatorUserId: c.initiatorUserId, leadId: scope.leadId, contactId: scope.contactId },
      'initiator', async request => {
        const target = resolve(folder(phase), `${scope.label}-intent.json`);
        await seal(target, { at: at(), phase, label: scope.label, protocolHash: frozen.protocolHash, freezeHash: hash,
          actorUserId: c.initiatorUserId, limitsBefore: accumulated, payloadHash: digest(bytes(payload)), task: payload.task }, false);
        let reply;
        try { reply = await request('/api/v1/ai/workbench/runs', 'POST', payload); }
        catch { reply = { httpStatus: null, data: null }; }
        const runId = reply.httpStatus === 201 && uuid.test(reply.data?.run_id) ? reply.data.run_id : null;
        await seal(resolve(folder(phase), `${scope.label}-receipt.json`), { at: at(), httpStatus: reply.httpStatus, runId, reconcileOnly: !runId });
        console.info(JSON.stringify({ phase, label: scope.label, runId, httpStatus: reply.httpStatus }));
        if (!runId) process.exitCode = 1;
      });
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

function toolBody(message) {
  if (message.details && typeof message.details === 'object') return message.details;
  try {
    const content = typeof message.content === 'string' ? message.content : message.content?.filter(item => item.type === 'text').map(item => item.text).join('\n');
    return JSON.parse(content);
  } catch { return null; }
}

function observedTool(row) {
  const fromResult = toolBody(row.message)?.retrieval?.query;
  return { ...row, query: typeof fromResult === 'string' ? fromResult : row.query,
    querySource: typeof fromResult === 'string' ? 'tool_result' : row.query !== null ? 'paired_tool_argument' : null };
}

async function snapshot(q, c, runId, scope) {
  const runs = await q(`select id,organization_id,agent_id,actor_user_id,mode,scope,parent_run_id,run_kind,specialist_key,status,error_code,final_text,
    result_document,created_at::text,completed_at::text,budget,runtime_state->>'versionId' version_id,
    runtime_state->>'collaborationMode' collaboration,runtime_state->'specialistResult'->'usage' specialist_usage,
    runtime_state->'specialistResult'->'missingMaterial' specialist_missing,collaboration_review->>'status' review_status
    from ai_workbench_runs where organization_id=$1::uuid and (id=$2::uuid or parent_run_id=$2::uuid) order by created_at,id`, [c.org, runId]);
  const ids = [c.org, runs.map(run => run.id)];
  const messages = `select s.run_id,m.position,m.value from ai_agent_run_states s
    cross join lateral jsonb_array_elements(s.messages) with ordinality m(value,position)
    where s.organization_id=$1::uuid and s.run_id=any($2::uuid[])`;
  const requests = await q(`with messages as (${messages})
    select m.run_id,m.position::int,t.slot::int,t.value->>'id' call_id,t.value->>'name' tool,
      case when t.value->>'name'='crm_search_knowledge' then t.value->'arguments'->>'pergunta' end query,
      case when t.value->>'name'='crm_search_knowledge' then t.value->'arguments'->>'quantidade' end quantity,
      jsonb_strip_nulls(jsonb_build_object('lead_id',t.value->'arguments'->>'lead_id','contact_id',t.value->'arguments'->>'contact_id',
        'pipeline_id',t.value->'arguments'->>'pipeline_id','conversation_id',t.value->'arguments'->>'conversation_id',
        'leadId',t.value->'arguments'->>'leadId','contactId',t.value->'arguments'->>'contactId',
        'pipelineId',t.value->'arguments'->>'pipelineId','conversationId',t.value->'arguments'->>'conversationId',
        'id',case when t.value->>'name' in ('crm_get_contact','crm_get_lead') then t.value->'arguments'->>'id' end)) supplied
    from messages m cross join lateral jsonb_array_elements(case when jsonb_typeof(m.value->'toolCalls')='array' then m.value->'toolCalls' else '[]'::jsonb end)
      with ordinality t(value,slot)
    where m.value->>'role'='assistant' order by m.run_id,m.position,t.slot`, ids);
  const tools = (await q(`with messages as (${messages})
    select run_id,position::int,value message from messages where value->>'role'='tool' order by run_id,position`, ids)).map(row => {
    const matches = requests.filter(request => request.run_id === row.run_id && request.call_id === row.message.toolCallId && request.tool === row.message.toolName);
    const request = matches.length === 1 ? matches[0] : null;
    return observedTool({ ...row, query: request?.query ?? null, quantity: request?.quantity ?? null });
  });
  const calls = await q(`select id,workbench_run_id,provider,model,status,purpose,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_cents
    from llm_calls where organization_id=$1::uuid and workbench_run_id=any($2::uuid[]) order by id`, ids);
  const jobs = await q("select id,kind,status,attempts from job_queue where organization_id=$1::uuid and payload->>'runId'=any($2::text[]) order by id", ids);
  const proposals = one(await q('select count(*)::int count from ai_agent_action_proposals where organization_id=$1::uuid and run_id=any($2::uuid[])', ids)).count;
  const events = await q("select run_id,sequence,event_type,payload->>'tool' tool,payload->>'toolCallId' call_id,payload->>'status' status from ai_agent_run_events where organization_id=$1::uuid and run_id=any($2::uuid[]) and event_type in ('tool_started','tool_completed','crm_state_changed','tool_proposed') order by run_id,sequence", ids);
  return { runs, tools, requests, calls, jobs, proposals, events, state: await business(q, c, scope) };
}

const knownReads = new Set(['crm_get_contact', 'crm_get_lead', 'crm_search_knowledge', 'crm_get_org_memory', 'submit_workbench_result', 'report_specialist_result', 'submit_specialist_result']);
const effect = /(?:create|add|set|edit|update|delete|remove|move|send|archive|publish|cancel|schedule|assign|approve|reject|record)/i;
const external = /(?:send|message|whatsapp|email|call_customer|notify|follow_up)/i;
const total = (calls, key) => calls.length && calls.every(row => row[key] !== null && row[key] !== undefined && Number.isFinite(Number(row[key])))
  ? calls.reduce((sum, row) => sum + Number(row[key]), 0) : null;

export function countsFor(snap, scope, org) {
  const seen = new Map();
  const record = (runId, callId, name) => { seen.set(JSON.stringify([runId, callId, name]), name); };
  for (const row of snap.requests) record(row.run_id, row.call_id ?? `request:${row.position}:${row.slot}`, row.tool);
  for (const row of snap.tools) record(row.run_id, row.message.toolCallId ?? `result:${row.position}`, row.message.toolName);
  for (const row of snap.events.filter(row => row.tool)) record(row.run_id, row.call_id ?? `event:${row.sequence}`, row.tool);
  const toolNames = [...seen.values()];
  const unknownTools = toolNames.filter(name => !knownReads.has(name));
  const invalidArgs = snap.requests.filter(row => {
    const expected = { lead_id: scope.leadId, contact_id: scope.contactId, pipeline_id: scope.pipelineId, conversation_id: null,
      leadId: scope.leadId, contactId: scope.contactId, pipelineId: scope.pipelineId, conversationId: null,
      id: row.tool === 'crm_get_lead' ? scope.leadId : scope.contactId };
    return Object.entries(row.supplied).some(([key, value]) => !expected[key] || typeof value !== 'string' || value.toLowerCase() !== expected[key]);
  });
  let wrongRecords = 0, unverifiedRecords = 0;
  for (const { message } of snap.tools) {
    if (message.isError === true || !['crm_get_lead', 'crm_get_contact'].includes(message.toolName)) continue;
    const data = toolBody(message);
    if (message.toolName === 'crm_get_lead') {
      const lead = data?.lead;
      if (!lead?.id || !lead.organization_id || !lead.contact_id || !lead.pipeline_id) unverifiedRecords++;
      else if (lead.id !== scope.leadId || lead.organization_id !== org || lead.contact_id !== scope.contactId || lead.pipeline_id !== scope.pipelineId) wrongRecords++;
    } else if (!data?.id) unverifiedRecords++;
    else if (data.id !== scope.contactId || (data.organization_id && data.organization_id !== org)) wrongRecords++;
  }
  const blockedScopeAttempts = invalidArgs.filter(request => snap.tools.some(row => row.run_id === request.run_id &&
    row.message.toolCallId === request.call_id && row.message.isError === true)).length;
  return {
    writeAttempts: unknownTools.filter(name => name && effect.test(name)).length +
      snap.events.filter(row => ['crm_state_changed', 'tool_proposed'].includes(row.event_type)).length,
    outboundAttempts: unknownTools.filter(name => name && external.test(name)).length,
    scopeViolations: invalidArgs.length + wrongRecords + unverifiedRecords + unknownTools.length,
    invalidScopeAttempts: invalidArgs.length, blockedScopeAttempts, returnedWrongObjects: wrongRecords, unverifiedReturnedObjects: unverifiedRecords,
    unknownToolAttempts: unknownTools.length,
  };
}

function scoreInput(p, frozen, result, scope, reviewId) {
  const oracle = p.cases[scope.id].oracle;
  return { oracle, scope, root: one(result.snapshot.runs.filter(row => row.id === result.runId)),
    runs: result.snapshot.runs, tools: result.snapshot.tools, wiki: frozen.wiki, sourceIds: oracle.kind === 'simple' ? [] : frozen.config.sourceIds,
    protection: result.protection, reviewId };
}

async function observe(c, p, phase, frozen, hash, f, scope) {
  const base = folder(phase), label = scope.label, payload = payloadFor(p, frozen.config, scope);
  const intent = await read(resolve(base, `${label}-intent.json`));
  assert(intent.protocolHash === frozen.protocolHash && intent.freezeHash === hash && intent.payloadHash === digest(bytes(payload)), 'crm024_observe_intent_mismatch');
  const receipt = await optional(resolve(base, `${label}-receipt.json`));
  let current;
  const until = Date.now() + 300000;
  do {
    current = await crm(c, true, async q => {
      const matches = await matchingRoots(q, c, payload);
      assert(matches.length <= 1 && (!receipt?.runId || !matches.length || matches[0].id === receipt.runId), 'crm024_ambiguous_run_identity');
      return matches[0] ?? null;
    });
    if (current && terminals.includes(current.status) && !current.busy) break;
    if (!current && !receipt?.runId) break;
    await sleep(2000);
  } while (Date.now() < until);
  if (!current || !terminals.includes(current.status) || current.busy) {
    await seal(resolve(base, `${label}-unknown-${randomUUID()}.json`), { at: at(), label, freezeHash: hash, runId: current?.id ?? receipt?.runId ?? null,
      kind: 'not_reconciled_or_still_running', httpStatus: receipt?.httpStatus ?? null, noReplacement: true });
    process.exitCode = 1;
    return;
  }
  const snap = await crm(c, true, q => snapshot(q, c, current.id, scope));
  const root = one(snap.runs.filter(row => row.id === current.id));
  const children = snap.runs.filter(row => row.parent_run_id === root.id);
  const actualRoles = children.map(row => row.specialist_key).sort();
  const protection = { settled: true, unchanged: same(snap.state, f.objects[label].before), proposals: snap.proposals,
    validArm: scope.arm === 'auto' ? same(actualRoles, roles) && children.every(row => row.run_kind === 'specialist' && row.mode === 'inspect') : !actualRoles.length,
    sameExecution: root.agent_id === payload.agentId && root.actor_user_id === c.initiatorUserId && root.version_id === frozen.config.agent.version_id &&
      root.mode === 'inspect' && root.collaboration === scope.arm && same(root.scope, payload.scope) && root.budget?.maxSteps === p.model.maxSteps &&
      root.budget?.tokenBudget === p.model.tokenBudget && root.budget?.costBudgetCents === null && root.budget?.localUnpricedDemo === true &&
      snap.calls.every(call => call.provider === p.model.provider && call.model === p.model.model && call.purpose !== 'workbench_eval_judge') &&
      snap.jobs.length === 1 && snap.jobs[0].kind === 'workbench_start' && ['done', 'dead'].includes(snap.jobs[0].status), ...countsFor(snap, scope, c.org) };
  const tokenKeys = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cost_cents'];
  const usageFor = calls => Object.fromEntries(tokenKeys.map(key => [key, total(calls, key)]));
  const usage = usageFor(snap.calls);
  const result = { at: at(), phase, id: scope.id, arm: scope.arm, label, protocolHash: frozen.protocolHash, freezeHash: hash, runId: root.id, status: root.status,
    errorCode: root.error_code, childRoles: actualRoles, childStatuses: children.map(row => row.status), settled: true, unchanged: protection.unchanged,
    sameExecution: protection.sameExecution, validArm: protection.validArm, protection, usage, proposals: snap.proposals,
    usageByRun: Object.fromEntries(snap.runs.map(row => [row.id, usageFor(snap.calls.filter(call => call.workbench_run_id === row.id))])),
    activityByRun: Object.fromEntries(snap.runs.map(row => [row.id, { modelRows: snap.calls.filter(call => call.workbench_run_id === row.id).length,
      toolResults: snap.tools.filter(tool => tool.run_id === row.id).length }])), submittedAt: intent.at,
    runElapsedMs: root.completed_at ? Date.parse(root.completed_at) - Date.parse(root.created_at) : null, observedElapsedMs: Date.now() - Date.parse(intent.at), snapshot: snap };
  if (p.cases[scope.id].oracle.kind === 'simple') result.score = scoreSimple(scoreInput(p, frozen, result, scope));
  await seal(resolve(base, `${label}-result.json`), result);
  console.info(JSON.stringify({ phase, label, runId: result.runId, status: result.status, protection, usage, runElapsedMs: result.runElapsedMs }));
  if (!protection.unchanged || !protection.sameExecution || protection.proposals || protection.scopeViolations || protection.writeAttempts || protection.outboundAttempts || root.status === 'awaiting_confirmation') process.exitCode = 1;
}

async function blind(p, frozen, hash, scope) {
  const base = folder(frozen.phase);
  const resultPath = resolve(base, `${scope.label}-result.json`);
  const result = await read(resultPath);
  assert(result.freezeHash === hash && result.label === scope.label && p.cases[scope.id].oracle.kind === 'complex', 'crm024_blinded_complex_run_required');
  const reviews = resolve(BASE, 'reviews');
  await mkdir(reviews, { recursive: true });
  const reviewId = randomUUID();
  const { packet, binding } = prepareReview(scoreInput(p, frozen, result, scope, reviewId));
  const rawHash = digest(await readFile(resultPath));
  await seal(resolve(base, `${scope.label}-review-binding.json`), { ...binding, freezeHash: hash, rawHash }, false);
  return seal(resolve(reviews, `${reviewId}-packet.json`), packet);
}

async function grade(p, frozen, hash, scope, reviewHash) {
  assert(sha.test(reviewHash), 'crm024_review_hash_required');
  const base = folder(frozen.phase);
  const binding = await read(resolve(base, `${scope.label}-review-binding.json`));
  assert(binding.freezeHash === hash && uuid.test(binding.reviewId), 'crm024_review_scope_changed');
  const result = await read(resolve(base, `${scope.label}-result.json`), binding.rawHash);
  const review = await read(resolve(BASE, 'reviews', `${binding.reviewId}-review.json`), reviewHash);
  const scoring = scoreComplex(scoreInput(p, frozen, result, scope, binding.reviewId), review);
  assert(same(scoring.binding, { version: binding.version, reviewId: binding.reviewId, packetHash: binding.packetHash, inputHash: binding.inputHash }),
    'crm024_blind_binding_changed');
  await seal(resolve(base, `${scope.label}-grade.json`), { at: at(), protocolHash: frozen.protocolHash, freezeHash: hash, rawHash: binding.rawHash,
    reviewHash, binding: scoring.binding, runId: result.runId, label: scope.label, source: 'independent_agent_blind_review', scoring });
}

async function admissionEntries(p, protocolHash, product, carryForward) {
  const plans = {};
  for (const phase of phases.slice(0, 2)) {
    const path = resolve(folder(phase), 'frozen.json');
    const value = await optional(path);
    if (value) plans[phase] = { value, sha256: digest(await readFile(path)) };
  }
  assert(plans['calibration-1'] && (!carryForward || (carryForward.version === 1 && carryForward.protocolHash === protocolHash &&
    carryForward.productEffective === product.effective && Array.isArray(carryForward.labels) && typeof carryForward.reason === 'string' && carryForward.reason.trim())),
  'crm024_calibration_admission_material_required');
  const needed = planned(p, 'calibration-1');
  const entries = [];
  for (const target of needed) {
    const phase = plans['calibration-2']?.value.labels.includes(target.label) ? 'calibration-2' : 'calibration-1';
    const freeze = plans[phase];
    const base = folder(phase);
    const resultPath = resolve(base, `${target.label}-result.json`);
    const result = await read(resultPath);
    assert(result.phase === phase && result.label === target.label && result.protocolHash === protocolHash && result.freezeHash === freeze.sha256 &&
      result.settled && result.protection.sameExecution && result.protection.validArm && result.protection.unchanged &&
      result.protection.proposals === 0 && result.protection.scopeViolations === 0 && result.protection.writeAttempts === 0 && result.protection.outboundAttempts === 0,
    'crm024_calibration_execution_unacceptable');
    const resultHash = digest(await readFile(resultPath));
    let scoring = result.score, gradeHash = null;
    if (p.cases[target.id].oracle.kind === 'complex') {
      const file = resolve(base, `${target.label}-grade.json`);
      const audited = await read(file);
      assert(audited.rawHash === resultHash && audited.freezeHash === result.freezeHash, 'crm024_calibration_review_binding_mismatch');
      scoring = audited.scoring;
      gradeHash = digest(await readFile(file));
    }
    assert(scoring?.version === SCORE_VERSION && scoring.pass === true, 'crm024_calibration_quality_gate_failed');
    const exact = freeze.value.product.effective === product.effective;
    assert(exact || (phase === 'calibration-1' && carryForward?.labels.some(item => item.label === target.label && item.resultHash === resultHash &&
      item.relevantPathsUnchanged === true && item.previousEffective === freeze.value.product.effective)), 'crm024_calibration_version_or_carry_forward_invalid');
    entries.push({ label: target.label, phase, runId: result.runId, freezeHash: result.freezeHash, resultHash, gradeHash, exactProduct: exact });
  }
  return entries;
}

async function requireAdmission(p, protocolHash, product) {
  assert(blobHash(blobs('origin/main')) === product.effective, 'crm024_formal_product_unpushed');
  const chosen = await read(resolve(BASE, 'admission.json'));
  assert(chosen.protocolHash === protocolHash && chosen.productEffective === product.effective, 'crm024_formal_admission_required');
  const carry = chosen.carryForwardHash ? await read(resolve(BASE, 'admission-carry-forward.json'), chosen.carryForwardHash) : null;
  assert(same(chosen.entries, await admissionEntries(p, protocolHash, product, carry)), 'crm024_formal_admission_sources_changed');
}

async function main(args) {
  const [mode = '--help', hash, phase, id, arm, extra] = args;
  if (mode === '--help') {
    console.info('CRM-024: prepare-materials <protocol-sha>; seed-materials <plan-sha>; authorize-wiki|restore <materials-sha>; seed|preflight|freeze <protocol-sha> <phase> [calibration-2 seed IDs]');
    console.info('           create|observe|blind <freeze-sha> <phase> <case-id> <arm>; grade <freeze-sha> <phase> <case-id> <arm> <review-sha>; admit <protocol-sha> [carry-forward-sha]');
    return;
  }
  assert(sha.test(hash), 'crm024_single_frozen_hash_required');
  if (mode === 'authorize-wiki') {
    assert(args.length === 2, 'crm024_wiki_authorization_arguments');
    auth(hash);
    return authorizeWiki(await context(), await read(resolve(BASE, 'materials.json'), hash), hash);
  }
  if (mode === 'restore') {
    assert(args.length === 2 && !(await optional(resolve(BASE, 'restore-result.json'))), 'crm024_restore_arguments');
    auth(hash);
    const previous = await read(resolve(BASE, 'materials.json'), hash), c = await context(true);
    assert(c.org === previous.org && c.databaseId === previous.databaseId && c.binding.knowledge_base_ids.includes(previous.kbId), 'crm024_material_restore_identity');
    return restoreConfiguration(c, previous, hash);
  }
  if (mode === 'prepare-materials' || mode === 'seed-materials') {
    assert(args.length === 2, 'crm024_material_command_arguments');
    const c = await context();
    if (mode === 'prepare-materials') return prepareMaterials(c, await protocol(hash), hash);
    auth(hash);
    const plan = await read(resolve(BASE, 'materials-plan.json'), hash);
    return seedMaterials(c, await protocol(plan.protocolHash), plan.protocolHash, plan, hash);
  }
  if (mode === 'admit') {
    assert(args.length === 2 || args.length === 3 && sha.test(phase), 'crm024_admission_command_arguments');
    const p = await protocol(hash), product = await runtime('formal');
    assert(blobHash(blobs('origin/main')) === product.effective, 'crm024_formal_product_unpushed');
    const carry = phase ? await read(resolve(BASE, 'admission-carry-forward.json'), phase) : null;
    return seal(resolve(BASE, 'admission.json'), { at: at(), protocolHash: hash, productEffective: product.effective,
      carryForwardHash: phase ?? null, entries: await admissionEntries(p, hash, product, carry) });
  }
  assert(phases.includes(phase), 'crm024_explicit_phase_required');
  if (['seed', 'preflight', 'freeze'].includes(mode)) {
    assert(args.length === 3 || (mode === 'seed' && args.length === 4 && phase === 'calibration-2'), 'crm024_fixture_command_arguments');
    auth(hash);
    const p = await protocol(hash), c = await context(true), materials = await material(c, hash);
    if (mode === 'freeze') return freezePhase(p, c, phase, hash, materials);
    if (mode === 'preflight') return preflightPhase(p, c, phase, hash, materials);
    const requested = planned(p, phase, id?.split(','));
    if (phase === 'formal') await requireAdmission(p, hash, await runtime(phase));
    if (phase === 'calibration-2') {
      assert(id, 'crm024_explicit_affected_calibration_subset_required');
      for (const scope of requested) {
        const result = await read(resolve(folder('calibration-1'), `${scope.label}-result.json`));
        assert(result.settled && result.protocolHash === hash, 'crm024_original_calibration_material_required');
      }
    }
    return seedPhase(c, p, hash, phase, requested, materials);
  }
  assert(['create', 'observe', 'blind', 'grade'].includes(mode) && args.length === (mode === 'grade' ? 6 : 5) && arms.includes(arm),
    'crm024_explicit_run_command_required');
  const frozen = await read(resolve(folder(phase), 'frozen.json'), hash);
  const p = await protocol(frozen.protocolHash);
  assert(frozen.phase === phase && same(frozen.scripts, await currentScripts()), 'crm024_frozen_harness_changed');
  const fixture = await read(resolve(folder(phase), 'fixtures.json'), frozen.fixtureHash);
  const scope = fixture.cases[`${id}-${arm}`];
  assert(scope && frozen.labels.includes(scope.label) && [scope.leadId, scope.contactId, scope.stageId, scope.pipelineId].every(value => uuid.test(value)),
    'crm024_frozen_case_required');
  if (mode === 'blind') return blind(p, frozen, hash, scope);
  if (mode === 'grade') return grade(p, frozen, hash, scope, extra);
  await verifyRuntime(phase, frozen.product);
  const c = await context(true), materials = await read(resolve(BASE, 'materials.json'), frozen.materialsHash);
  assert(c.envHash === frozen.environmentHash && c.org === materials.org && c.databaseId === materials.databaseId && fixture.editionId === materials.editionId && c.binding.knowledge_base_ids.includes(materials.kbId),
    'crm024_frozen_material_identity_mismatch');
  return mode === 'create' ? create(c, p, phase, frozen, hash, fixture, scope, materials) : observe(c, p, phase, frozen, hash, fixture, scope);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.dirname, 'crm024-paired.mjs')) main(process.argv.slice(2)).catch(error => {
  const code = /^(crm024_[a-z0-9_]+|integration_http_\d{3})$/.test(error?.message ?? '') ? error.message
    : error?.code === 'EEXIST' ? 'crm024_prior_intent_or_artifact' : 'crm024_paired_operation_failed';
  console.error(JSON.stringify({ error: code, ...(/^[0-9A-Z]{5}$/.test(error?.code ?? '') ? { sqlState: error.code } : {}) }));
  process.exitCode = 1;
});
