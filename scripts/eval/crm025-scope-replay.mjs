/** Replays the selected-object boundary on the isolated fixtures, without starting a model or Workbench Run. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual as same } from 'node:util';
import { ROOT, at, business, digest, idle, one, optional, read, seal, sha } from './crm024-fixtures.mjs';
import { MATERIAL_ROOT, crm025Transaction, loadMaterials } from './crm025-materials-context.mjs';

const SAFE_PRODUCT = '59da3c47b8272fb89795445abdb115011cf91f6a';
const ORIGINAL_FIXTURE = '3b2cc4bf035218d3bfa6352692d6c2b18101666957a4b1bfe9021c2d188bf730';
const runtimePaths = ['app', 'lib', 'workers', 'supabase', 'pnpm-lock.yaml', 'package.json', 'next.config.ts', 'proxy.ts'];
const broadTools = ['crm_list_leads', 'crm_list_conversations', 'crm_search_contacts'];
const exactTools = ['crm_get_lead', 'crm_get_contact', 'crm_list_followups'];
const denied = result => result?.permitido === false && result.motivo === 'workbench_target_out_of_scope' &&
  !['leads', 'lead', 'contacts', 'contact', 'id', 'conversations', 'retornos'].some(key => Object.hasOwn(result, key));

async function inspect(c, selected, other, missing) {
  return crm025Transaction(c, true, async q => {
    await idle(q, c);
    const slots = await Promise.all([selected, other].map(slot => business(q, c, slot)));
    assert(same(slots, [selected.preState, other.preState]), 'crm025_scope_fixture_state_changed');
    const records = await q(`select id,contact_id,pipeline_id,status from crm_leads
      where organization_id=$1::uuid and id=any($2::uuid[]) order by id`, [c.org, [selected.leadId, other.leadId, missing]]);
    assert(records.length === 2 && [selected, other].every(slot => records.some(row => row.id === slot.leadId &&
      row.contact_id === slot.contactId && row.pipeline_id === slot.pipelineId && row.status === 'open')),
    'crm025_scope_same_pipeline_objects_missing');
    const alternate = await q(`select id from crm_leads where organization_id=$1::uuid and contact_id=$2::uuid and status='open'`,
      [c.org, other.contactId]);
    assert(alternate.length === 1 && alternate[0].id === other.leadId, 'crm025_scope_followup_control_missing');
    const counts = one(await q(`select
      (select count(*)::int from ai_workbench_runs where organization_id=$1::uuid) roots_and_children,
      (select count(*)::int from job_queue where organization_id=$1::uuid) jobs,
      (select count(*)::int from llm_calls where organization_id=$1::uuid) models,
      (select count(*)::int from ai_agent_action_proposals where organization_id=$1::uuid) proposals,
      (select count(*)::int from ai_internal_question_outbox where organization_id=$1::uuid) outbox`, [c.org]));
    return { slots, records, counts };
  });
}

async function readAudits(c, requestId, count) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const rows = await crm025Transaction(c, true, q => q(`select id,metadata->>'tool_name' tool,
      (metadata->>'success')::boolean success,metadata->>'error' error from api_audit_log
      where organization_id=$1::uuid and request_id::text=$2 and action='mcp.tool_called' order by id`, [c.org, requestId]));
    if (rows.length >= count) return rows;
    await delay(200);
  }
  throw new Error('crm025_scope_replay_audit_incomplete');
}

async function run(fixtureHash) {
  assert(sha.test(fixtureHash ?? '') && process.env.CRM025_SCOPE_REPLAY_EXECUTE === fixtureHash, 'crm025_scope_replay_opt_in_required');
  const receipt = resolve(MATERIAL_ROOT, 'resume/scope-replay.json');
  assert(!(await optional(receipt)), 'crm025_scope_replay_already_sealed');
  await mkdir(resolve(MATERIAL_ROOT, 'resume'), { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true }).trim();
  assert(!git('diff', '--name-only', SAFE_PRODUCT, '--', ...runtimePaths) &&
    !git('ls-files', '--others', '--exclude-standard', '--', ...runtimePaths), 'crm025_scope_replay_product_changed');
  const [c, original] = await Promise.all([loadMaterials(fixtureHash, { recovered: true }),
    read(resolve(MATERIAL_ROOT, 'fixtures.json'), ORIGINAL_FIXTURE)]);
  const { materials: fixture } = c;
  assert(same(fixture.slots, original.slots) && c.environmentHash !== original.environmentHash, 'crm025_scope_replay_fixture_unbound');

  const selected = fixture.slots['baseline.D02.disabled'];
  const other = fixture.slots['baseline.D03.disabled'];
  assert(selected.leadId !== other.leadId && selected.contactId !== other.contactId && selected.pipelineId === other.pipelineId,
    'crm025_scope_replay_wrong_controls');
  const requestId = randomUUID();
  const missing = randomUUID();
  const before = await inspect(c, selected, other, missing);
  for (const [key, value] of Object.entries(c.env)) process.env[key] = value;
  const [{ createAdminClient }, { resolveMcpTurnToolIds }, { pickToolsFromMcp }, { mintEphemeralToken, revokeEphemeralToken }] =
    await Promise.all([import('../../lib/supabase/admin.ts'), import('../../lib/agent-engine/edge/crm/mcp-tools.ts'),
      import('../../lib/ai/runtime/tools.ts'), import('../../lib/ai/runtime/mcp_token.ts')]);

  const supabase = createAdminClient();
  const targetScope = selected.scope;
  const toolIds = [...broadTools, ...exactTools];
  const projection = resolveMcpTurnToolIds(toolIds, { targetScope, readOnly: true });
  const actual = resolveMcpTurnToolIds(fixture.agent.toolIds, { targetScope, readOnly: true, workbenchProposalTools: true });
  assert(same(projection.allowed, exactTools) && broadTools.every(tool => !actual.allowed.includes(tool)) &&
    exactTools.every(tool => actual.allowed.includes(tool)), 'crm025_scope_replay_mount_boundary_failed');
  const originalResult = await read(resolve(MATERIAL_ROOT, 'baseline/dev/D02-disabled-result.json'),
    '629e40884ebdd6a5185d7018a056921fdac7189ffbe04f27e590068893d00cfb');
  const replayArgs = originalResult.snapshot.requests.find(call => call.call_id === 'call_e9cb5edc5fd24b93ac2b20a1')?.args;
  assert(replayArgs?.pipeline_id === selected.pipelineId && replayArgs.limit === 50, 'crm025_scope_replay_original_args_changed');

  const token = await mintEphemeralToken({ organizationId: c.org, runId: requestId, readOnly: true, versionCreatedBy: c.initiatorUserId });
  const role = 'ai_operator';
  const actor = { type: 'ai_agent', id: fixture.agent.id, agent_id: fixture.agent.id, role, api_token_id: token.id };
  const context = { organizationId: c.org, role, actor, apiTokenId: token.id, requestId, supabase };
  const auth = { ...context, scopes: ['mcp:read', 'actor:ai_agent'] };
  const wrap = (scope, ids = toolIds) => pickToolsFromMcp({ supabase, ctx: context, auth, targetScope: scope, toolIds: ids,
    handoffToolEnabled: false, handoffSignal: { triggered: false }, pipelineIds: [selected.pipelineId] });
  const checks = { broadNotMounted: true };
  const observations = {};
  async function call(label, tools, name, args, validate) {
    const result = await tools[name].execute(args, { toolCallId: randomUUID(), messages: [] });
    assert(validate(result), `crm025_scope_replay_${label}_failed`);
    observations[label] = { tool: name, resultHash: digest(JSON.stringify(result)) };
    return result;
  }
  try {
    const mounted = wrap(targetScope, projection.allowed);
    assert(same(Object.keys(mounted), exactTools), 'crm025_scope_replay_mount_runtime_failed');
    const direct = wrap(targetScope);
    await call('historical_list', direct, 'crm_list_leads', replayArgs, denied);
    await call('conversation_list', direct, 'crm_list_conversations', { contact_id: selected.contactId, limit: 1 }, denied);
    await call('contact_search', direct, 'crm_search_contacts', { query: 'CRM', limit: 1 }, denied);
    checks.broadDirectDenied = true;
    await call('other_lead', mounted, 'crm_get_lead', { lead_id: other.leadId }, denied);
    await call('other_contact', mounted, 'crm_get_contact', { contact_id: other.contactId }, denied);
    checks.otherObjectDenied = true;
    await call('selected_lead', mounted, 'crm_get_lead', { lead_id: selected.leadId }, row => row?.lead?.id === selected.leadId &&
      row.lead.contact_id === selected.contactId && row.lead.pipeline_id === selected.pipelineId);
    await call('selected_contact', mounted, 'crm_get_contact', { contact_id: selected.contactId }, row => row?.id === selected.contactId);
    checks.selectedReadable = true;
    await call('exact_followup', mounted, 'crm_list_followups', { contact_id: selected.contactId, limit: 1 }, row =>
      row?.lead_id === selected.leadId && row.contact_id === selected.contactId && Array.isArray(row.retornos));
    checks.followupExact = true;
    const missingScope = { ...other.scope, leadId: missing };
    await call('missing_followup', wrap(missingScope), 'crm_list_followups', { contact_id: other.contactId, limit: 1 }, row =>
      row?.motivo === 'negocio_nao_encontrado' && row.retornos?.length === 0 && !row.lead_id);
    checks.followupNoFallback = true;
    const ordinary = wrap(undefined);
    await call('ordinary_followup', ordinary, 'crm_list_followups', { lead_id: missing, contact_id: other.contactId, limit: 1 }, row =>
      row?.lead_id === other.leadId && row.contact_id === other.contactId);
    const list = await call('ordinary_list', ordinary, 'crm_list_leads', replayArgs, row => row?.leads?.length > 1 &&
      row.leads.every(lead => lead.organization_id === c.org && lead.pipeline_id === selected.pipelineId) &&
      row.leads.some(lead => lead.id !== selected.leadId));
    observations.ordinary_list.rowCount = list.leads.length;
    checks.unscopedReadable = true;
  } finally {
    await revokeEphemeralToken(token.id);
  }

  const [after, audit, credentials] = await Promise.all([inspect(c, selected, other, missing),
    readAudits(c, requestId, Object.keys(observations).length),
    crm025Transaction(c, true, q => q(`select revoked_at is not null revoked from api_tokens where id=$1::uuid and organization_id=$2::uuid`,
      [token.id, c.org]))]);
  const blocks = audit.filter(row => row.success === false && row.error === 'workbench_target_out_of_scope');
  assert(same(before, after) && credentials.length === 1 && credentials[0].revoked &&
    audit.length === Object.keys(observations).length && blocks.length === 5 &&
    same(blocks.map(row => row.tool).sort(), [...broadTools, ...exactTools.slice(0, 2)].sort()), 'crm025_scope_replay_effect_or_audit_changed');
  return seal(receipt, { version: 1, at: at(), productCommit: SAFE_PRODUCT,
    databaseId: c.databaseId, fixtureHash, originalFixtureHash: ORIGINAL_FIXTURE, fixtureVerified: true, scopeVerified: true, noModel: true,
    checks, requestId, observations, auditHash: digest(JSON.stringify(audit)), countBefore: before.counts, countAfter: after.counts,
    blockedAuditCount: blocks.length, replayTokenRevoked: true });
}

run(process.argv[2]).then(() => process.exit(0)).catch(error => {
  const label = /^crm0[0-9]{2}_[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : 'crm025_scope_replay_failed';
  console.error(JSON.stringify({ error: label, ...(typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? { sqlState: error.code } : {}) }));
  process.exit(1);
});
