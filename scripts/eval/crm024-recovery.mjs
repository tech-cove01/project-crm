/** Immutable, single-incident recovery for the archived CRM-024 calibration. */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { AUDIT_VERSION, auditCalls, countsFor, TARGET_DENIED } from './crm024-scope-audit.mjs';
import { bytes, digest, read, sha } from './crm024-fixtures.mjs';

export const HISTORICAL_PHASE = 'calibration-1';
export const REJECTED_LABEL = 'K01-disabled';
export const NEVER_CREATED_LABEL = 'K01-auto';
export const RECOVERY_VERSION = 'crm024-reviewed-continuation-v1';
export const CORRECTION_FILE = 'original-scope-correction.json';
export const RECOVERY_PLAN = 'continuation-plan.json';
export const RECOVERY_REVIEW = 'continuation-review.json';
export const RECOVERY_FILE = 'continuation.json';

const original = {
  protocolHash: '65eff5f929fadaeb74e7ed17cd20237d0ec715af6b1d8235f35e2b13aa7d233c',
  freezeHash: 'f034e90edf6056ba38586185e8ff34af9973ab26f67a8a4021b0d0508aa0a4cb',
  fixtureHash: '5266ba8f3065a6574b68dc36be9ad8f038f805f16125cd3c712a7c2928faab16',
  intentHash: 'eadc796bd4c8896a1242216796f14d819e582b85f0472deefef1727f17f20b57',
  receiptHash: 'db1422369a4edeee58b074488fdd086e81fe7f45b4c317e167ae93d77082a517',
  resultHash: 'c9f033be186e813c4bd6f970c4687fc36f0fc2c32e608b5f14013537cb184a49',
  runId: '2c26cffc-06ef-4fb4-bf7f-61748ef3eaaf',
  callId: 'call_16a8687ee48d4db595a6323e',
};

export async function readHistoricalIncident(base, protocolHash) {
  assert.equal(protocolHash, original.protocolHash, 'crm024_recovery_protocol_mismatch');
  const dir = resolve(base, 'paired', HISTORICAL_PHASE);
  const [frozen, fixtures, intent, receipt, result, names] = await Promise.all([
    read(resolve(dir, 'frozen.json'), original.freezeHash),
    read(resolve(dir, 'fixtures.json'), original.fixtureHash),
    read(resolve(dir, `${REJECTED_LABEL}-intent.json`), original.intentHash),
    read(resolve(dir, `${REJECTED_LABEL}-receipt.json`), original.receiptHash),
    read(resolve(dir, `${REJECTED_LABEL}-result.json`), original.resultHash),
    readdir(dir),
  ]);
  assert(!names.some(name => name.startsWith(`${NEVER_CREATED_LABEL}-`)), 'crm024_missing_arm_history_ambiguous');
  const scope = fixtures.cases[REJECTED_LABEL];
  const root = result.snapshot.runs.find(row => row.id === original.runId);
  const p = result.protection;
  assert(intent.freezeHash === original.freezeHash && intent.protocolHash === protocolHash && intent.label === REJECTED_LABEL &&
    result.freezeHash === original.freezeHash && result.protocolHash === protocolHash && result.phase === HISTORICAL_PHASE &&
    result.label === REJECTED_LABEL && result.status === 'partial' && result.errorCode === 'missing_material' &&
    receipt.httpStatus === 201 && receipt.reconcileOnly === false && receipt.runId === result.runId && result.runId === original.runId &&
    result.snapshot.runs.length === 1 && root?.mode === 'inspect' && root.collaboration === 'disabled' &&
    root.scope.contactId === scope.contactId && root.scope.leadId === scope.leadId && !root.scope.conversationId &&
    p.settled && p.unchanged && p.validArm && p.sameExecution && p.scopeViolations === 2 && p.blockedScopeAttempts === 0 &&
    p.proposals === 0 && p.writeAttempts === 0 && p.outboundAttempts === 0 && result.snapshot.proposals === 0 &&
    same(fixtures.objects[REJECTED_LABEL].before, result.snapshot.state), 'crm024_historical_block_not_proved');
  const corrected = countsFor(result.snapshot, scope, root.organization_id);
  const violations = auditCalls(result.snapshot, scope, root.organization_id).filter(row => row.violatesScope);
  const blocked = violations[0];
  const requests = result.snapshot.requests.filter(row => row.run_id === original.runId && row.call_id === original.callId);
  assert(violations.length === 1 && blocked.runId === original.runId && blocked.callId === original.callId &&
    blocked.tool === 'crm_get_conversation_history' && blocked.invalidScope && blocked.blockedScope &&
    requests.length === 1 && requests[0].supplied.conversation_id === scope.contactId &&
    corrected.scopeViolations === 1 && corrected.blockedScopeAttempts === 1 && corrected.ambiguousToolCalls === 0 &&
    corrected.returnedWrongObjects === 0 && corrected.unverifiedReturnedObjects === 0 && corrected.businessEffects === 0 &&
    corrected.proposalAttempts === 0 && corrected.writeAttempts === 0 && corrected.outboundAttempts === 0,
  'crm024_historical_scope_effect_or_unknown');
  return {
    historicalProduct: frozen.product,
    missingScope: fixtures.cases[NEVER_CREATED_LABEL],
    correction: { version: AUDIT_VERSION, ...original, historicalPhase: HISTORICAL_PHASE, label: REJECTED_LABEL,
      archived: { scopeViolations: p.scopeViolations, blockedScopeAttempts: p.blockedScopeAttempts },
      corrected, deniedBy: TARGET_DENIED, protectedBusinessUnchanged: true, usage: result.usage },
  };
}

export async function readCorrection(base, protocolHash) {
  const incident = await readHistoricalIncident(base, protocolHash);
  const raw = await readFile(resolve(base, CORRECTION_FILE));
  assert(raw.toString('utf8') === bytes(incident.correction), 'crm024_scope_correction_not_reproducible');
  return { ...incident, correctionHash: digest(raw) };
}

export function continuationPlan(incident, product, scripts) {
  assert(product.effective !== incident.historicalProduct.effective && Object.keys(product.changed).length === 0,
    'crm024_committed_fixed_product_required');
  return {
    version: RECOVERY_VERSION,
    protocolHash: incident.correction.protocolHash,
    historical: original,
    correctionHash: incident.correctionHash,
    fixedProduct: { commit: product.head, effective: product.effective },
    scripts,
    originalResultRemainsFailed: true,
    eligibleHistoricalException: { phase: HISTORICAL_PHASE, label: REJECTED_LABEL, callId: original.callId },
    firstMissingSlot: { phase: 'calibration-2', label: NEVER_CREATED_LABEL, originalScope: incident.missingScope },
  };
}

export function approveContinuation(plan, planHash, review, reviewHash) {
  assert(sha.test(planHash) && digest(bytes(plan)) === planHash && sha.test(reviewHash) &&
    review?.version === RECOVERY_VERSION && review.planHash === planHash && review.verdict === 'approved' &&
    review.reviewerType === 'independent_agent' && typeof review.reviewerId === 'string' && review.reviewerId.trim() &&
    typeof review.reason === 'string' && review.reason.trim() &&
    ['originalDenialNoEffect', 'fixedScopeGuard', 'fixedSelectedRecordEvidence', 'retainsOriginalLedger', 'missingArmProtected']
      .every(key => review.checked?.[key] === true),
  'crm024_independent_continuation_review_required');
  return { version: RECOVERY_VERSION, protocolHash: plan.protocolHash, planHash, reviewHash,
    fixedProduct: plan.fixedProduct, correctionHash: plan.correctionHash, originalRunId: plan.historical.runId };
}

export function isHistoricalException(recovery, phase, label, resultBytes) {
  return Boolean(recovery && phase === HISTORICAL_PHASE && label === REJECTED_LABEL &&
    recovery.protocolHash === original.protocolHash && recovery.originalRunId === original.runId &&
    digest(resultBytes) === original.resultHash);
}
