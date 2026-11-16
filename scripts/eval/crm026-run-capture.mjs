/** Real Workbench observations for a single CRM-026-owned target. */
import assert from 'node:assert/strict';
import { isDeepStrictEqual as same } from 'node:util';
import { digest } from './crm024-fixtures.mjs';
import { TARGET_DENIED, toolBody } from './crm024-scope-audit.mjs';
import { summarizeUsage } from './crm025-run-capture.mjs';

const statuses = new Set(['completed', 'partial', 'failed', 'cancelled']);
const policyAnchor = '\n\nUse CRM tools to verify facts. Follow the run mode and tool policy.';
// Frozen product workbench-start-job.ts appends the guard and WORKBENCH_RESULT_INSTRUCTION.
const inspectPolicyHash = '67cd978e24b8ab8a5d8596307efe6c69ab516845dc7bb57426a8a5f055339c1a';
// Frozen workbench-result-recovery.ts repeats the result contract and closes the CRM tools.
const recoveryPolicyHash = 'e6c170556a2a07556c780598050aa86ec02cbb299fda45a8c2d3efea297d611b';
const recoveryReminderHash = '79b82045f8feb240dbbb37030667422adcce47419fa130248b0437622d6a0cff';
const finalWindowHash = 'fed05a73066e10276a4ae660c08ee3e90ede77ff137fe9ba0578afbc62e91d00';
const readIdentity = { crm_get_contact: 'contact_id', crm_get_lead: 'lead_id', crm_get_conversation: 'conversation_id',
  crm_get_conversation_history: 'conversation_id' };
const sdkUuidPattern = '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$';
const sdkUuid = new RegExp(sdkUuidPattern, 'i');
const queryOne = async (q, sql, parameters) => {
  const rows = await q(sql, parameters);
  assert(rows.length === 1, 'crm026_single_scope_required');
  return rows[0];
};

export async function preRunState(q, slot) {
  const args = [slot.organizationId, slot.contactId, slot.crmScope.conversationId ?? null, slot.crmScope.leadId ?? null];
  return queryOne(q, `select
    (select to_jsonb(c) from contacts c where c.organization_id=$1 and c.id=$2) contact,
    (select to_jsonb(c) from conversations c where c.organization_id=$1 and c.contact_id=$2 and c.id=$3) conversation,
    (select coalesce(jsonb_agg(to_jsonb(m) order by m.id),'[]'::jsonb) from messages m where m.organization_id=$1 and m.conversation_id=$3) messages,
    (select count(*)::int from lead_checkpoints where organization_id=$1 and conversation_id=$3) checkpoints,
    (select to_jsonb(l) from crm_leads l where l.organization_id=$1 and l.contact_id=$2 and l.id=$4) lead,
    (select coalesce(jsonb_agg(jsonb_build_object('id',id,'category',category,'body',body,'deleted_at',deleted_at,'content_hash',content_hash)
      order by id),'[]'::jsonb) from ai_customer_memories where organization_id=$1 and contact_id=$2) memory,
    (select count(*)::int from cron_jobs where organization_id=$1) scheduled,
    (select count(*)::int from ai_internal_question_outbox where organization_id=$1) outbox`, args);
}

export async function locateRun(q, slot) {
  const rows = await q(`select id,status from ai_workbench_runs where organization_id=$1 and parent_run_id is null
     and scope->>'contactId'=$2 and scope->>'conversationId' is not distinct from $3 and scope->>'leadId' is not distinct from $4`,
  [slot.organizationId, slot.contactId, slot.crmScope.conversationId ?? null, slot.crmScope.leadId ?? null]);
  assert(rows.length <= 1, 'crm026_duplicate_roots');
  return rows[0] ?? null;
}

export async function captureRun(q, slot, runId) {
  const args = [slot.organizationId, runId];
  const roots = await q(`select id, organization_id, agent_id,actor_user_id,scope,task,mode,status,error_code,final_text,result_document,budget,
     created_at::text,started_at::text,completed_at::text,mission_id,runtime_state
     from ai_workbench_runs where organization_id=$1 and id=$2 and run_kind='root' and parent_run_id is null`, args);
  if (!roots.length) return null;
  const root = roots[0];
  const jobs = await q(`select id,kind,status,attempts from job_queue where organization_id=$1 and payload->>'runId'=$2::text`, args);
  if (!statuses.has(root.status) || jobs.some(job => ['pending', 'running'].includes(job.status))) return null;
  const child = await queryOne(q, 'select count(*)::int count from ai_workbench_runs where organization_id=$1 and parent_run_id=$2', args);
  const proposals = await q('select id,status,tool_name from ai_agent_action_proposals where organization_id=$1 and run_id=$2', args);
  const calls = await q(`select id,purpose,provider,model,status,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_cents,
      job_id,latency_ms,error_code,http_status,created_at::text from llm_calls where organization_id=$1 and workbench_run_id=$2 order by created_at,id`, args);
  const events = await q(`select sequence,event_type,payload,created_at::text from ai_agent_run_events
     where organization_id=$1 and run_id=$2 order by sequence`, args);
  const audit = await q(`select action,resource_type,metadata from api_audit_log
     where organization_id=$1 and request_id::text=$2::text and action='mcp.tool_called'`, args);
  const messages = (await q('select messages from ai_agent_run_states where organization_id=$1 and run_id=$2', args))[0]?.messages ?? [];
  return { root, jobs, specialists: child.count, proposals, calls, events, audit, messages,
    modelDecisions: events.filter(row => row.event_type === 'model_decision').length,
    providerFailureRows: calls.filter(row => row.status === 'erro').length,
    state: await preRunState(q, slot), usage: summarizeUsage({ calls }) };
}

function memoryFor(tool, value, slot) {
  if (tool === 'crm_get_contact' && value?.id === slot.contactId) return value.confirmed_customer_memory;
  if (tool !== 'crm_get_conversation_history') return null;
  const observed = value?.customer_memory;
  if (observed?.scope?.contact_id !== slot.contactId || observed.scope.conversation_id !== slot.crmScope.conversationId ||
      observed.scope.organization_id !== slot.organizationId) return null;
  return observed.confirmed_customer_memory;
}

function checkTool(tool, args, value, message, slot, before, pages) {
  const scope = slot.crmScope;
  const protectedIds = { lead_id: scope.leadId, contact_id: scope.contactId, conversation_id: scope.conversationId };
  const mismatched = Object.entries(protectedIds).some(([key, expected]) => args?.[key] != null && args[key] !== expected);
  const text = Array.isArray(message.content) ? message.content.map(item => item.text).join('\n') : message.content;
  const guarded = value?.permitido === false && value.motivo === TARGET_DENIED &&
      typeof value.mensagem === 'string' && Object.keys(value).sort().join(',') === 'mensagem,motivo,permitido' ||
    /^Tool .+ not found$/.test(text ?? '') && message.isError === true ||
    text === 'Blocked by inspect-only policy; no CRM state was changed.' && (!value || !Object.keys(value).length);
  if (guarded) return 'denied';
  if (mismatched) return 'scope_unresolved';
  if (message.isError === true || value?.ok === false || value?.error != null || value?.erro != null) return 'failed';
  if (tool === 'crm_get_lead') return value?.lead?.id && value.lead.id === scope.leadId &&
    value.lead.organization_id === slot.organizationId && value.lead.contact_id === scope.contactId ? 'success' : 'scope_unresolved';
  if (tool === 'crm_get_contact') return value?.id === scope.contactId &&
    (!value.organization_id || value.organization_id === slot.organizationId) ? 'success' : 'scope_unresolved';
  if (tool === 'crm_get_conversation') return value?.id === scope.conversationId &&
    value.contact_id === scope.contactId ? 'success' : 'scope_unresolved';
  if (tool === 'crm_get_conversation_history') {
    const allowed = new Set(before.messages.map(row => row.id));
    if (Array.isArray(value?.messages) && value.messages.every(row => allowed.has(row.id)) &&
        value?.customer_memory?.status === 'unavailable' && value.customer_memory.checkpoint === null) return 'unavailable';
    return Array.isArray(value?.messages) && value.messages.every(row => allowed.has(row.id)) &&
      value?.customer_memory?.scope?.conversation_id === scope.conversationId &&
      value.customer_memory.scope.contact_id === scope.contactId &&
      value.customer_memory.scope.organization_id === slot.organizationId &&
      value.customer_memory.checkpoint === null ? 'success' : 'scope_unresolved';
  }
  if (tool === 'crm_list_followups' && Array.isArray(value?.retornos) && !value.retornos.length &&
      (value.lead_id ?? null) === (scope.leadId ?? null) && (value.contact_id ?? null) === (scope.contactId ?? null)) return 'empty';
  if (tool === 'crm_search_knowledge') {
    if (!Array.isArray(value?.evidence)) return 'failed';
    const valid = value.evidence.every(row => pages.some(page => page.pageId === row.metadata?.page_id &&
      page.version === row.metadata?.page_version && page.sourceId === row.locator?.sourceId &&
      page.bodyHash === row.metadata.content_hash && typeof row.excerpt === 'string' && page.bodyHash === digest(row.excerpt)));
    if (!valid) return 'scope_unresolved';
    return value.retrieval?.empty_verified === true ? 'verified_empty' : value.evidence.length ? 'success'
      : value.retrieval?.status === 'unavailable' || value.retrieval?.wiki_status === 'unavailable' ? 'unavailable' : 'unverified_empty';
  }
  if (tool === 'crm_get_org_memory' || tool === 'submit_workbench_result') return 'success';
  return 'effect_unresolved';
}

function messageText(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value) || value.some(item => item?.type !== 'text' || typeof item.text !== 'string')) return null;
  return value.map(item => item.text).join('\n');
}

function rejectedReadIdentity(call, message, events) {
  const field = readIdentity[call.name];
  const args = call.arguments;
  if (!field || typeof args?.[field] !== 'string' || Object.keys(args).length !== 1 || sdkUuid.test(args[field]) || message.isError !== true ||
      !same(message.details, {}) || !Array.isArray(message.content) || message.content.length !== 1) return false;
  const text = [`Validation failed for tool "${call.name}":`, `  - ${field}: must match format "uuid"`,
    `  - ${field}: must match pattern "${sdkUuidPattern}"`, '', 'Received arguments:', JSON.stringify(args, null, 2)].join('\n');
  const matched = events.filter(event => event.payload?.toolCallId === call.id && event.payload?.tool === call.name);
  return messageText(message.content) === text && matched.length === 2 &&
    matched[0].event_type === 'tool_started' && matched[1].event_type === 'tool_completed' && matched[1].payload.status === 'error';
}

function resultWindow(messages) {
  return messages.every(row => row.role === 'assistant' ? (row.toolCalls ?? []).every(call => call.name === 'submit_workbench_result') :
    row.role === 'tool' && row.toolName === 'submit_workbench_result');
}

function originalWindow(messages) {
  const reminder = messages.findIndex(row => row.role === 'user');
  if (reminder < 0) return messages.every(row => ['assistant', 'tool'].includes(row.role));
  return messages.slice(0, reminder).every(row => ['assistant', 'tool'].includes(row.role)) &&
    messageHash(messages[reminder]) === finalWindowHash && resultWindow(messages.slice(reminder + 1));
}

function messageHash(message) {
  const value = messageText(message?.content);
  return value === null ? null : digest(value);
}

function promptEnvelope(messages, events, expected, promptHash) {
  const system = messages[0]?.role === 'system' ? messageText(messages[0].content) : null;
  const authority = system?.indexOf(policyAnchor) ?? -1;
  const systemPromptHash = authority > 0 ? digest(system.slice(0, authority)) : null;
  const systemPolicyHash = authority > 0 ? digest(system.slice(authority)) : null;
  if (systemPromptHash !== promptHash || messages[1]?.role !== 'user' || messageText(messages[1].content) !== expected)
    return { valid: false, systemPromptHash, systemPolicyHash };
  const tail = messages.slice(2);
  if (systemPolicyHash === inspectPolicyHash)
    return { valid: originalWindow(tail), systemPromptHash, systemPolicyHash };
  const boundary = tail.findIndex(row => row.role === 'system');
  const recovery = events.filter(row => row.event_type === 'model_decision' &&
    ['submitted', 'missing'].includes(row.payload?.resultRecovery));
  const submitted = tail.slice(boundary + 3);
  const accepted = submitted.some(row => row.role === 'tool' && toolBody(row)?.accepted === true);
  const valid = systemPolicyHash === recoveryPolicyHash && boundary > 0 && recovery.length === 1 &&
    originalWindow(tail.slice(0, boundary)) && messageText(tail[boundary].content) === '' &&
    tail[boundary + 1]?.role === 'user' && messageHash(tail[boundary + 1]) === recoveryReminderHash &&
    tail[boundary + 2]?.role === 'user' && messageHash(tail[boundary + 2]) === finalWindowHash &&
    submitted.filter(row => row.role === 'assistant').length <= 2 && resultWindow(submitted) &&
    (recovery[0]?.payload.resultRecovery !== 'submitted' || accepted);
  return { valid, systemPromptHash, systemPolicyHash };
}

export function verifyRun(raw, slot, input, before, pages = []) {
  const { root, jobs, specialists, proposals, calls, events, messages, state } = raw;
  const configuration = root.actor_user_id === slot.actorUserId && root.agent_id === input.agentId &&
    root.mode === 'inspect' && root.runtime_state?.collaborationMode === 'disabled' &&
    root.runtime_state?.versionId === slot.versionId && root.mission_id === null &&
    root.task === input.task && same(root.scope, input.scope) && root.budget?.maxSteps === 12 &&
    root.budget?.tokenBudget === 36000 && root.budget?.localUnpricedDemo === true &&
    jobs.length === 1 && jobs[0].kind === 'workbench_start' && ['done', 'dead'].includes(jobs[0].status) &&
    calls.every(row => row.provider === 'dashscope' && row.model === 'qwen3.8-flash' && row.purpose === 'agent_turn');
  const context = events.find(row => row.event_type === 'context_loaded' && row.payload?.contactId === slot.contactId)?.payload;
  const scopeKeys = { contact_id: 'contactId', lead_id: 'leadId', conversation_id: 'conversationId', pipeline_id: 'pipelineId' };
  const scopeLines = Object.entries(scopeKeys).filter(([, key]) => context?.[key]).map(([label, key]) => `${label}: ${context[key]}`);
  const formatHint = '若用户明确要求 summary 为纯 JSON，只提交一个符合所需键的 JSON 对象，从 { 开始、到 } 结束，前后不加 Markdown 或说明。事实依据和真实缺口分别放在结构化 evidence 和 missingInformation。用户允许核验无匹配后留空，且授权搜索已确认无匹配时，政策项和该项引用填 null，evidence 不为该政策项加入不存在的知识回执。已读取的 CRM 字段即使为 null，也仍可引用其实际 CRM 来源。';
  const absentHistoryHint = slot.crmScope.conversationId ? [] : ['本次未选择会话。只使用已选 CRM 对象和已授权资料取证，不把其他对象 ID 当作会话 ID。'];
  const expected = [input.task, `已校验的当前 CRM 目标范围（由工作台选择；请先用只读工具读取这些精确对象，不要猜选其他记录）：\n${scopeLines.join('\n')}`,
    ...absentHistoryHint, formatHint].join('\n\n');
  const organization = events.find(row => row.event_type === 'context_loaded' && row.payload?.memoryResolution === 'current_published')?.payload;
  const { valid: promptValid, systemPromptHash, systemPolicyHash } = promptEnvelope(messages, events, expected, slot.promptHash);
  const fresh = scopeLines.length > 0 && ['contactId', 'leadId', 'conversationId', 'pipelineId'].every(key =>
    (context?.[key] ?? null) === (slot.crmScope[key] ?? null)) && promptValid &&
    before.checkpoints === 0 && before.messages.every(row => row.body === input.task) &&
    organization?.orgMemoryVersionId === null && organization.orgMemoryEntriesCount === 0;
  const toolChecks = messages.flatMap((parent, index) => parent.role !== 'assistant' ? [] :
    (parent.toolCalls ?? []).map(call => {
      const outcomes = messages.filter(row => row.role === 'tool' && row.toolCallId === call.id && row.toolName === call.name);
      const message = outcomes[0];
      const position = messages.indexOf(message);
      const body = message ? toolBody(message) : null;
      const verdict = outcomes.length === 1 && position > index
        ? rejectedReadIdentity(call, message, events) ? 'denied' :
          checkTool(call.name, call.arguments, body, message, slot, before, pages) : 'effect_unresolved';
      return { name: call.name, id: call.id, verdict, memory: verdict === 'success' ? memoryFor(call.name, body, slot) : null,
        visibleOnLaterTurn: position > index && messages.slice(position + 1).some(row => row.role === 'assistant') };
    }));
  const sourceFacts = new Map(before.memory.filter(row => !row.deleted_at).map(row => [row.id, row]));
  const foreignMemory = toolChecks.filter(row => row.memory?.memories?.some(item => {
    const fact = sourceFacts.get(item.id);
    return !fact || item.body !== fact.body || item.revision !== fact.content_hash ||
      item.confirmed !== true || item.authority !== 'customer_context_only';
  })).length;
  const effects = events.filter(row => ['crm_state_changed', 'tool_proposed', 'human_confirmation_requested'].includes(row.event_type)).length;
  const unchanged = same(before, state);
  const orphanResults = messages.filter(row => row.role === 'tool' && (!row.toolCallId || !row.toolName ||
    toolChecks.filter(call => call.id === row.toolCallId && call.name === row.toolName).length !== 1)).length;
  const unexplainedEvents = events.filter(row => ['tool_started', 'tool_completed'].includes(row.event_type) && row.payload?.toolCallId &&
    !toolChecks.some(call => call.id === row.payload.toolCallId && call.name === row.payload.tool)).length;
  const executed = messages.length > 0 || calls.some(row => row.status === 'ok');
  const safe = unchanged && specialists === 0 && !proposals.length && !effects && !foreignMemory && !unexplainedEvents && !orphanResults &&
    (!executed || configuration && fresh) && toolChecks.every(call => typeof call.id === 'string' && call.id.length > 0) &&
    toolChecks.every(row => !row.verdict.endsWith('unresolved'));
  return { safe, unchanged, configuration, fresh, systemPromptHash, systemPolicyHash, effects, foreignMemory, orphanResults,
    unexplainedEvents, toolChecks };
}
