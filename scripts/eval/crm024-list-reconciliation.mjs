/** Reconciles the two empty scoped list observations in one sealed CRM-024 Run. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { BASE, digest, folder, optional, read, seal, sha } from './crm024-fixtures.mjs';
import { auditCalls, countsFor, toolBody } from './crm024-scope-audit.mjs';

const version = 'crm024-r2-empty-list-reconciliation-v1';
const phase = 'calibration-2';
const label = 'K01-disabled';
const runner = 'crm024-paired.mjs';
const file = 'crm024-list-reconciliation.mjs';
const mcpAuditHash = 'bd40943a8ec511a32f853912e15e17cf35fabea3255ccb413781a4d7949467a3';
const planFile = resolve(BASE, 'r2-list-reconciliation-plan.json');
const reviewFile = resolve(BASE, 'r2-list-reconciliation-review.json');
const readyFile = resolve(BASE, 'r2-list-reconciliation.json');
const reviewChecks = ['frozenBytesUnchanged', 'sameRunAndScope', 'mountedReadOnlyTools', 'emptyNoReturnedObjects',
  'isolatedSqlNoRows', 'noWritesOrOutbound', 'remainingSlotsOnly', 'originalQualityAndUsageRetained'];
const archive = {
  freezeHash: 'b0d833fc503959db99f786da65331186835492b7da43c8449b86e215b458a4ef',
  recoveryHash: 'd13df9b132d95fc869dcd511e03db720de4543dc4ae5d9029718cf93f6283582',
  fixtureHash: 'cc0c25ae1ee86c7babd3f0f46c98749878ed2530b44956f143065e97489fcbb2',
  runId: '15af4427-294d-4228-bf62-4f9a010b078f',
  runnerHash: 'e56cf130a53c2a59e6896f3886742d4946be92be7f30f6406d2119e69bfe4dd9',
  bothK01: {
    'K01-auto': { intent: '26e2750d6453e9a79c5ba402c17ae2214e919ebb3c937ca4a43e960845963228',
      receipt: '3ea5d7aadd9bfb5cb05a718737d1137fad6b965c246d5dd9f90b474a6d76da9a',
      result: '9492d9b07afa8d3905363f265eea8ab475e0db3b71f57c1f12295380514d6c2b' },
    'K01-disabled': { intent: '25e340f4b22fcf942461f244ea12699383655b46f41b526bd6186e83db90108c',
      receipt: 'fbdde242d5630ddeaf6fb1b8e914b698f99a3a5b4001717d93e3d350486c3866',
      result: 'd8cf5624a9ec0e2c84facfa731a62902abce3055854ae1f7b10f34bd641532b4' },
  },
};

async function bindOriginal() {
  const base = folder(phase);
  const [frozen, fixtures, recovery, ...roots] = await Promise.all([
    read(resolve(base, 'frozen.json'), archive.freezeHash),
    read(resolve(base, 'fixtures.json'), archive.fixtureHash),
    read(resolve(BASE, 'continuation.json'), archive.recoveryHash),
    ...Object.entries(archive.bothK01).map(async ([slot, files]) => Object.fromEntries(await Promise.all(
      Object.entries(files).map(async ([kind, hash]) => [kind, await read(resolve(base, `${slot}-${kind}.json`), hash)])))),
  ]);
  assert(frozen.phase === phase && frozen.fixtureHash === archive.fixtureHash && frozen.continuationHash === archive.recoveryHash &&
    frozen.scripts[runner] === archive.runnerHash && recovery.fixedProduct.effective === frozen.product.effective &&
    same(frozen.labels, ['K01-auto', label, 'S02-disabled', 'S02-auto', 'C01-auto', 'C01-disabled']),
  'crm024_r2_original_freeze_changed');
  for (const { intent, receipt, result } of roots) {
    assert(intent.phase === phase && intent.protocolHash === frozen.protocolHash && intent.freezeHash === archive.freezeHash &&
      intent.continuationHash === archive.recoveryHash && result.label === intent.label && result.freezeHash === archive.freezeHash &&
      result.protocolHash === frozen.protocolHash && result.settled === true && receipt.httpStatus === 201 &&
      receipt.runId === result.runId, 'crm024_r2_original_attempt_changed');
  }
  const result = roots[1].result;
  const scope = fixtures.cases[label];
  const snap = result.snapshot;
  const live = snap.runs[0];
  const counts = countsFor(snap, scope, fixtures.org, frozen.config.sourceIds);
  assert(result.label === label && result.runId === archive.runId && result.status === 'partial' &&
    result.errorCode === 'missing_material' && result.protection.unchanged && result.protection.validArm &&
    result.protection.sameExecution && result.scopeContained === false && same(snap.state, fixtures.objects[label].before) &&
    snap.proposals === 0 && result.protection.proposals === 0 && snap.runs.length === 1 && live.id === archive.runId &&
    live.organization_id === fixtures.org && live.mode === 'inspect' && live.run_kind === 'root' && live.collaboration === 'disabled' &&
    same(live.scope, { contactId: scope.contactId, leadId: scope.leadId, pipelineId: scope.pipelineId }) &&
    counts.scopeViolations === 2 && counts.unknownToolAttempts === 2 &&
    Object.entries(counts).every(([key, n]) => result.protection[key] === n &&
      (['scopeViolations', 'unknownToolAttempts'].includes(key) || n === 0)), 'crm024_r2_list_effect_or_unknown');
  const calls = [
    { tool: 'crm_list_conversations', callId: 'call_ce44c4e798cb4356b973ce2d', supplied: { contact_id: scope.contactId },
      output: { conversations: [], cursor: null, has_more: false } },
    { tool: 'crm_list_followups', callId: 'call_ca3e9f497a874b37a418ae58', supplied: { lead_id: scope.leadId },
      output: { lead_id: scope.leadId, contact_id: scope.contactId, retornos: [] } },
  ];
  const violations = auditCalls(snap, scope, fixtures.org, frozen.config.sourceIds).filter(call => call.violatesScope);
  for (const { callId, tool, supplied, output } of calls) {
    assert(frozen.config.agent.tool_ids.includes(tool), 'crm024_r2_list_tool_not_in_frozen_permissions');
    const matches = violations.filter(call => call.callId === callId && call.runId === archive.runId && call.tool === tool &&
      !call.invalidScope && !call.mismatch && call.toolOutsideContract);
    const req = snap.requests.filter(row => row.run_id === archive.runId && row.call_id === callId && row.tool === tool);
    const res = snap.tools.filter(row => row.run_id === archive.runId && row.message.toolCallId === callId && row.message.toolName === tool);
    const events = snap.events.filter(row => row.run_id === archive.runId && row.call_id === callId && row.tool === tool);
    assert(matches.length === 1 && req.length === 1 && same(req[0].supplied, supplied) && res.length === 1 &&
      res[0].message.isError === false && same(toolBody(res[0].message), output) && events.length === 2 &&
      events[0].event_type === 'tool_started' && events[1].event_type === 'tool_completed' && events[1].status === 'success',
    'crm024_r2_exact_empty_list_evidence_required');
  }
  return { frozen, fixtures, scope, result, calls: calls.map(({ tool, callId }) => ({ tool, callId })) };
}

function verifySqlProof(sql, fixtures, scope, result, calls) {
  const root = result.snapshot.runs[0];
  const { counts, row, conversationStorage, events, jobs, beforeMatchesArchived, currentMatchesArchived } = sql.evidence;
  const runStart = Date.parse(root.created_at), runEnd = Date.parse(root.completed_at);
  const expectedEvents = result.snapshot.events.filter(event => calls.some(call => call.callId === event.call_id))
    .map(({ sequence, event_type, tool, call_id, status }) => ({ sequence, event_type, tool, call_id, status }));
  const allowedRels = ['channel_sessions', 'conversations', 'messages'];
  assert(sql.version === 'crm024-list-scope-sql-proof-v1' && sql.readOnly === true && sql.posthoc === true &&
    sql.organizationId === fixtures.org && sql.databaseId === fixtures.databaseId && sql.runId === archive.runId &&
    sql.leadId === scope.leadId && sql.contactId === scope.contactId && sql.freezeHash === archive.freezeHash &&
    sql.fixtureHash === archive.fixtureHash && sql.intentHash === archive.bothK01[label].intent &&
    sql.receiptHash === archive.bothK01[label].receipt && sql.resultHash === archive.bothK01[label].result &&
    sql.tenantConversations === 0 && sql.selectedFollowups === 0 && counts.readOnly === true && counts.organizations === 1 &&
    ['tenantConversations', 'selectedConversations', 'selectedFollowups', 'tenantFollowups', 'tenantChannels',
      'tenantMessages', 'proposals', 'busy'].every(key => counts[key] === 0) &&
    Date.parse(counts.statsResetAt) < runStart && Date.parse(counts.databaseStartedAt) < runStart && Date.parse(counts.snapshotAt) >= runEnd &&
    same(conversationStorage.map(item => item.relname).sort(), allowedRels) && conversationStorage.every(item =>
      ['insertCount', 'deleteCount', 'updateCount', 'liveEstimate'].every(key => item[key] === '0')) &&
    row.id === archive.runId && row.organization_id === fixtures.org && same(row.scope, root.scope) && row.mode === 'inspect' &&
    row.status === root.status && row.error_code === root.error_code && Date.parse(row.created_at) === runStart && Date.parse(row.completed_at) === runEnd &&
    same(events.map(({ sequence, event_type, tool, call_id, status }) => ({ sequence, event_type, tool, call_id, status })), expectedEvents) &&
    same(jobs, result.snapshot.jobs) && beforeMatchesArchived === true && currentMatchesArchived === true,
  'crm024_r2_list_sql_proof_not_scoped');
}

function verifyMcpAudit(audit, sql, sqlProofHash, scope) {
  const expected = { crm_list_conversations: { contact_id: scope.contactId, limit: 10 }, crm_list_followups: { lead_id: scope.leadId, limit: 20 } };
  assert(audit.version === 'crm024-list-scope-mcp-audit-v1' && audit.readOnly === true && audit.posthoc === true &&
    audit.proof.sha256 === sqlProofHash && audit.requestIdentifier === 'workbench_root_run_id' && audit.runId === archive.runId &&
    same(audit.calls.map(row => row.tool).sort(), Object.keys(expected).sort()) && audit.calls.every(row => {
      const [start, finish] = sql.evidence.events.filter(event => event.tool === row.tool);
      const time = Date.parse(row.createdAt);
      return row.resource_type === 'mcp_tool' && row.request_id === archive.runId && row.success === 'true' && same(row.args, expected[row.tool]) &&
        Date.parse(start.createdAt) <= time && time <= Date.parse(finish.createdAt);
    }), 'crm024_r2_list_mcp_audit_not_scoped');
}

async function buildPlan(sqlProofHash) {
  assert(sha.test(sqlProofHash), 'crm024_r2_list_sql_proof_hash_required');
  const [{ frozen, fixtures, scope, result, calls }, sql, audit, newRunner, module] = await Promise.all([
    bindOriginal(), read(resolve(BASE, 'list-scope-sql-proof.json'), sqlProofHash),
    read(resolve(BASE, 'list-scope-mcp-audit.json'), mcpAuditHash),
    readFile(resolve(import.meta.dirname, runner)), readFile(resolve(import.meta.dirname, file)),
  ]);
  verifySqlProof(sql, fixtures, scope, result, calls);
  verifyMcpAudit(audit, sql, sqlProofHash, scope);
  return { version, archive, phase, label, protocolHash: frozen.protocolHash, product: frozen.product,
    originalScripts: frozen.scripts, successorScripts: { [runner]: digest(newRunner), [file]: digest(module) },
    sqlProofHash, mcpAuditHash, calls, recordedScoreAndUsageRetained: true, recordedScopeViolations: result.protection.scopeViolations,
    correction: { allowedEmptyReads: calls.length, wrongObjects: 0, businessEffects: 0 }, remainingLabels: frozen.labels.slice(2) };
}

async function reviewPlan(planHash, reviewHash) {
  assert(sha.test(planHash) && sha.test(reviewHash), 'crm024_r2_list_review_hash_required');
  const [plan, review] = await Promise.all([read(planFile, planHash), read(reviewFile, reviewHash)]);
  assert(same(plan, await buildPlan(plan.sqlProofHash)) && review.version === version && review.planHash === planHash &&
    review.verdict === 'approved' && review.reviewerType === 'independent_agent' && typeof review.reviewerId === 'string' &&
    review.reviewerId.trim() && typeof review.reason === 'string' && review.reason.trim() &&
    reviewChecks.every(key => review.checked?.[key] === true), 'crm024_r2_list_independent_review_required');
  return { receipt: { version, planHash, reviewHash }, plan };
}

export async function readListReconciliation(protocolHash) {
  const ready = await optional(readyFile);
  if (!ready) return null;
  const { receipt, plan } = await reviewPlan(ready.planHash, ready.reviewHash);
  assert(same(ready, receipt) && plan.protocolHash === protocolHash, 'crm024_r2_list_reconciliation_changed');
  return plan;
}

export function originalScripts(scripts, overlay) {
  if (!overlay) return scripts;
  const { [file]: moduleHash, ...legacy } = scripts;
  assert(moduleHash === overlay.successorScripts[file] && scripts[runner] === overlay.successorScripts[runner],
    'crm024_r2_list_successor_source_changed');
  const original = { ...legacy, [runner]: overlay.originalScripts[runner] };
  assert(same(original, overlay.originalScripts), 'crm024_r2_list_frozen_sources_changed');
  return original;
}

export function isReconciledListResult(overlay, step, slot, raw) {
  return Boolean(overlay && step === phase && slot === label && digest(raw) === archive.bothK01[label].result);
}

async function main([mode, hash, reviewHash, ...remaining]) {
  assert(!remaining.length && sha.test(hash), 'crm024_r2_list_arguments');
  if (mode === 'plan' && reviewHash === undefined) return seal(planFile, await buildPlan(hash));
  assert(mode === 'reconcile' && process.env.CRM024_EXECUTE === hash, 'crm024_r2_list_exact_opt_in_required');
  return seal(readyFile, (await reviewPlan(hash, reviewHash)).receipt);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.dirname, file)) main(process.argv.slice(2)).catch(error => {
  console.error(JSON.stringify({ error: /^crm024_[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : 'crm024_r2_list_operation_failed' }));
  process.exitCode = 1;
});
