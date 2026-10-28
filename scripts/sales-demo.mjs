import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function refuse(code) { throw Object.assign(new Error(code), { code }); }
function requireCheck(condition, code) { if (!condition) refuse(code); }

export function readDemoFixtures(root) {
  const specs = [
    ["approval-synthetic-case.json", ["leadId", "pipelineId", "oldStage", "newStage"]],
    ["mem0-crm-case.json", ["contactId", "memoryId"]],
    ["weknora-crm-case.json", ["sourceId", "kb"]],
  ];
  return specs.map(([file, keys]) => {
    let value;
    try { value = JSON.parse(readFileSync(join(root, ".local", file), "utf8")); }
    catch { refuse("sales_demo_fixture_unreadable"); }
    const ids = Object.fromEntries(keys.map(key => [key, value?.[key]]));
    requireCheck(Object.values(ids).every(id => typeof id === "string" && UUID.test(id)), "sales_demo_fixture_invalid");
    return ids;
  });
}

/** Reads only current SQL facts; no API, tool, embedding or model request. */
export async function inspectDemo(client, config, fixtures) {
  const [approval, memory, wiki] = fixtures;
  const one = async (sql, args) => (await client.query(sql, args)).rows[0];
  const organizations = [...new Set(config.bindings.map(binding => binding.organization_id))];
  requireCheck(organizations.length === 1 && UUID.test(organizations[0]), "sales_demo_single_bound_organization_required");
  const orgId = organizations[0];
  const lead = await one("select id,organization_id,pipeline_id,stage_id,contact_id,title,tags,updated_at from crm_leads where organization_id=$1 and id=$2", [orgId, approval.leadId]);
  requireCheck(lead && lead.organization_id === orgId && lead.pipeline_id === approval.pipelineId && lead.contact_id === null &&
    typeof lead.title === "string" && lead.title.startsWith("合成商机：本地审批验证") &&
    Array.isArray(lead.tags) && lead.tags.includes("synthetic-approval-test"), "sales_demo_synthetic_lead_required");
  requireCheck(UUID.test(orgId) && Number.isFinite(Date.parse(lead.updated_at)), "sales_demo_lead_snapshot_invalid");
  const contact = await one("select id,source_metadata,is_anonymized,is_merged_into from contacts where organization_id=$1 and id=$2", [orgId, memory.contactId]);
  requireCheck(contact && contact.source_metadata?.synthetic === true && contact.source_metadata?.purpose === "initial-local-acceptance" &&
    contact.is_anonymized === false && contact.is_merged_into === null, "sales_demo_synthetic_contact_required");
  const fact = await one("select id,contact_id,confirmed_by,sync_state,write_outcome,deleted_at from ai_customer_memories where organization_id=$1 and id=$2", [orgId, memory.memoryId]);
  requireCheck(fact && fact.contact_id === memory.contactId && fact.confirmed_by && fact.sync_state === "synced" &&
    fact.write_outcome === "confirmed" && fact.deleted_at === null, "sales_demo_confirmed_synced_memory_required");
  const source = await one("select id,name,source_type,source_metadata,is_active,status,updated_at from ai_knowledge_sources where organization_id=$1 and id=$2", [orgId, wiki.sourceId]);
  requireCheck(source && source.name === "本机合成产品 Wiki" && source.source_type === "wiki" && source.is_active === true && source.status === "ready" &&
    source.source_metadata?.provider === "weknora" && source.source_metadata?.knowledge_base_id === wiki.kb && source.source_metadata?.visibility === "organization", "sales_demo_authorized_synthetic_wiki_required");
  const { rows: settings } = await client.query("select provider,enabled from ai_integration_settings where organization_id=$1", [orgId]);
  for (const provider of ["mem0", "weknora", "langfuse"]) {
    const binding = config.bindings.find(item => item.organization_id === orgId && item.provider === provider);
    requireCheck(binding && settings.some(item => item.provider === provider && item.enabled === true), "sales_demo_integrations_not_enabled");
    if (provider === "weknora") requireCheck(binding.visibility === "organization" && binding.knowledge_base_ids?.includes(wiki.kb), "sales_demo_wiki_binding_mismatch");
  }
  const pipeline = await one("select id,is_archived from crm_pipelines where organization_id=$1 and id=$2", [orgId, approval.pipelineId]);
  const { rows: stages } = await client.query("select id,is_archived,is_won,is_lost from crm_stages where organization_id=$1 and pipeline_id=$2 and id=any($3::uuid[])", [orgId, approval.pipelineId, [approval.oldStage, approval.newStage]]);
  requireCheck(pipeline?.is_archived === false && approval.oldStage !== approval.newStage && stages.length === 2 &&
    stages.every(stage => stage.is_archived === false && stage.is_won === false && stage.is_lost === false) &&
    [approval.oldStage, approval.newStage].includes(lead.stage_id), "sales_demo_two_open_stages_required");
  const targetStageId = lead.stage_id === approval.oldStage ? approval.newStage : approval.oldStage;
  const organization = await one("select settings from organizations where id=$1", [orgId]);
  const llm = organization?.settings?.llm;
  requireCheck(llm?.provider === "dashscope" && typeof llm.default_model === "string" && llm.default_model.trim(), "sales_demo_dashscope_required");
  const capability = await one("select supports_tools,deprecated_at from ai_models where provider=$1 and model_id=$2", [llm.provider, llm.default_model]);
  requireCheck(capability?.supports_tools === true && capability.deprecated_at === null, "sales_demo_supported_model_required");
  const { rows: agents } = await client.query(`select a.id,a.builtin_key,a.is_active,a.paused_at,a.archived_at,
    v.id as version_id,v.provider,v.model,v.tool_ids,v.knowledge_source_ids
    from ai_agents a join lateral (select id,provider,model,tool_ids,knowledge_source_ids from ai_agent_versions
      where organization_id=a.organization_id and agent_id=a.id order by version_number desc limit 1) v on true
    where a.organization_id=$1 and a.origin='builtin' and a.builtin_key=any($2::text[])`, [orgId, ["crm_intelligence", "sales_operations"]]);
  const agentFor = key => {
    const matches = agents.filter(agent => agent.builtin_key === key);
    requireCheck(matches.length === 1, "sales_demo_builtin_agent_missing");
    const agent = matches[0];
    requireCheck(agent.is_active === true && agent.paused_at === null && agent.archived_at === null &&
      agent.provider === "dashscope" && agent.model === llm.default_model && UUID.test(agent.id) && UUID.test(agent.version_id), "sales_demo_agent_configuration_mismatch");
    const tools = key === "crm_intelligence" ? ["crm_get_contact", "crm_search_knowledge"] : ["crm_get_lead", "crm_move_lead_stage"];
    requireCheck(Array.isArray(agent.tool_ids) && tools.every(tool => agent.tool_ids.includes(tool)), "sales_demo_agent_tools_missing");
    return agent;
  };
  const inspect = agentFor("crm_intelligence");
  const approvalAgent = agentFor("sales_operations");
  requireCheck(Array.isArray(inspect.knowledge_source_ids) && inspect.knowledge_source_ids.includes(wiki.sourceId), "sales_demo_agent_wiki_not_authorized");
  const unfinished = await one(`select count(*)::int as count from ai_workbench_runs r where r.organization_id=$1 and r.run_kind='root'
    and (r.scope->>'leadId'=$2 or r.scope->>'contactId'=$3 or r.task like '[CRM-014:%')
    and (r.status in ('queued','running','awaiting_confirmation') or exists
      (select 1 from ai_agent_action_proposals p where p.organization_id=r.organization_id and p.run_id=r.id and p.status in ('pending','approved')))`, [orgId, approval.leadId, memory.contactId]);
  requireCheck(unfinished?.count === 0, "sales_demo_unfinished_run_requires_manual_review");
  return { orgId, lead, targetStageId, inspect, approvalAgent, model: llm.default_model, sourceUpdatedAt: source.updated_at };
}

export function buildDemoSession(facts, fixtures, config, sessionId = randomUUID()) {
  const [approval, memory, wiki] = fixtures;
  const marker = `[CRM-014:${sessionId}]`;
  const language = "面向用户的回复和结构化结果中的自然语言字段必须使用简体中文；JSON 键、枚举、实际记录 ID、工具名、来源标题和观察到的标量值保持原样。知识引用使用工具实际返回的片段/证据 ID，不用父级知识源或文档 ID 代替；商机引用使用实际商机 ID，不把它当成 run_event 的事件 ID，也不自行拼造时间或其他观察值。";
  const inspectTask = `${marker} 本机合成销售演示，仅做读取。${language}请先调用 crm_get_contact，读取联系人 ${memory.contactId}，根据工具返回的 confirmed_customer_memory 汇报已确认的沟通时间与方式；再调用 crm_search_knowledge，pergunta 参数精确使用“产品”两个字，quantidade 参数为 5，查询已授权的公司产品知识并列出工具实际返回的来源和关键内容。知识源为 ${wiki.sourceId}。明确区分事实与未知，不编造结果，不修改任何数据，也不发送消息。`;
  const approvalTask = `${marker} 本机合成销售演示，只处理选中的无客户关联合成商机。${language}请先读取商机 ${approval.leadId}，然后仅调用一次 crm_move_lead_stage 提出移动阶段的动作：lead_id 精确为 ${approval.leadId}，to_stage_id 精确为 ${facts.targetStageId}，reason 填写“CRM-014 合成销售演示”。等待人工确认。批准后必须再调用 crm_get_lead 复核同一商机；本任务验收仅要求实际 stage_id 等于 ${facts.targetStageId}，若一致则据实汇报完成，不重复移动。阶段可读名称、客户关联和后续外联均不属于本次内部阶段变更任务的必要材料；不要把它们当成本任务缺口，真正阻止核对阶段的错误仍须如实报告。禁止调用 crm_update_lead 或其他写工具，不操作其他商机，不发送任何消息。`;
  const shape = (agent, task, mode, scope) => ({ agentId: agent.id, task, mode, collaboration: "disabled", scope });
  return {
    version: 1, sessionId, preparedAt: new Date().toISOString(), appOrigin: config.appUrl,
    createRunPath: "/api/v1/ai/workbench/runs", workbenchUrl: `${config.appUrl}/app/ai/workbench`,
    orgId: facts.orgId, contactId: memory.contactId, memoryId: memory.memoryId,
    wikiSourceId: wiki.sourceId, wikiKbId: wiki.kb, leadId: approval.leadId, pipelineId: approval.pipelineId,
    before: { stageId: facts.lead.stage_id, updatedAt: new Date(facts.lead.updated_at).toISOString() }, targetStageId: facts.targetStageId,
    agents: { inspect: { id: facts.inspect.id, builtinKey: facts.inspect.builtin_key, versionId: facts.inspect.version_id }, approval: { id: facts.approvalAgent.id, builtinKey: facts.approvalAgent.builtin_key, versionId: facts.approvalAgent.version_id } },
    model: { provider: "dashscope", id: facts.model }, sourceUpdatedAt: new Date(facts.sourceUpdatedAt).toISOString(),
    runs: { inspect: shape(facts.inspect, inspectTask, "inspect", { contactId: memory.contactId }), approval: shape(facts.approvalAgent, approvalTask, "act", { leadId: approval.leadId, pipelineId: approval.pipelineId }) },
    checks: { sqlReadOnly: true, syntheticContact: true, memoryConfirmedSynced: true, wikiAuthorized: true, syntheticUnlinkedLead: true, twoOpenStages: true, noUnfinishedRun: true },
    budgetPolicy: { localUnpricedDemoConfigured: config.env.CRM_LOCAL_WORKBENCH_UNPRICED_MODE === "true", appliedToRunVerified: false, unknownCostIsNotZero: true },
    boundaries: { modelRequested: false, businessWritten: false, actionApproved: false, liveConnectivityVerified: false, mustRecheckBeforeApproval: true },
  };
}

export async function prepareDemo(config, { newSession = false, createPool } = {}) {
  const directory = join(config.root, ".local", "sales-demo");
  const currentPath = join(directory, "current.json");
  const lockPath = join(directory, "prepare.lock");
  const lockId = randomUUID();
  mkdirSync(directory, { recursive: true });
  let lock;
  try { lock = openSync(lockPath, "wx", 0o600); }
  catch { refuse("sales_demo_prepare_locked"); }
  let pool;
  let client;
  let connectionFailed = false;
  const onConnectionError = () => { connectionFailed = true; };
  try {
    writeFileSync(lock, JSON.stringify({ lockId }));
    requireCheck(newSession || !existsSync(currentPath), "sales_demo_session_exists_use_new");
    const fixtures = readDemoFixtures(config.root);
    const factory = createPool ?? (options => import("pg").then(({ default: pg }) => new pg.Pool(options)));
    pool = await factory({ connectionString: config.env.SUPABASE_DB_URL, options: "-c default_transaction_read_only=on", max: 1, connectionTimeoutMillis: 5000, query_timeout: 5000, statement_timeout: 5000 });
    pool.on?.("error", onConnectionError);
    client = await pool.connect();
    client.on?.("error", onConnectionError);
    await client.query("begin isolation level repeatable read read only");
    const facts = await inspectDemo(client, config, fixtures);
    requireCheck(!connectionFailed, "sales_demo_connection_failed");
    await client.query("commit");
    requireCheck(!connectionFailed, "sales_demo_connection_failed");
    const session = buildDemoSession(facts, fixtures, config);
    const sessionDirectory = join(directory, session.sessionId);
    mkdirSync(sessionDirectory);
    const sessionPath = join(sessionDirectory, "session.json");
    writeFileSync(sessionPath, JSON.stringify(session, null, 2), { flag: "wx", mode: 0o600 });
    const temporary = join(directory, `current-${session.sessionId}.tmp`);
    writeFileSync(temporary, JSON.stringify({ version: 1, sessionId: session.sessionId, sessionPath }), { flag: "wx", mode: 0o600 });
    renameSync(temporary, currentPath);
    return { sessionPath, sessionId: session.sessionId, orgId: session.orgId, contactId: session.contactId, leadId: session.leadId, wikiSourceId: session.wikiSourceId, checks: session.checks, boundaries: session.boundaries };
  } catch (error) {
    if (client) await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    try {
      try { await client?.release(); }
      finally { if (pool) await pool.end(); }
    } finally {
      try { closeSync(lock); }
      finally {
        let ownLock = false;
        try { ownLock = JSON.parse(readFileSync(lockPath, "utf8")).lockId === lockId; }
        catch { /* An unknown or replaced lock is never removed. */ }
        if (ownLock) rmSync(lockPath);
      }
    }
  }
}

export async function main(args = process.argv.slice(2)) {
  if (!args.length || (args.length === 1 && ["help", "--help", "-h"].includes(args[0]))) return { usage: "node scripts/sales-demo.mjs prepare [--new]", behavior: "只读核对本机合成资料，将两个中文提示词与范围保存到 .local；不创建 Run、不调用模型、不批准或写入业务数据。已有 session 时需显式 --new。" };
  requireCheck(args[0] === "prepare" && args.length <= 2 && (args.length === 1 || args[1] === "--new"), "sales_demo_usage_invalid");
  const { loadLocalConfig } = await import("./local-crm-config.mjs");
  return prepareDemo(loadLocalConfig(), { newSession: args[1] === "--new" });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.info(JSON.stringify(await main(), null, 2)); }
  catch (error) { console.error(JSON.stringify({ error: /^sales_demo_[a-z_]+$/.test(error.code ?? "") ? error.code : "sales_demo_prepare_failed" })); process.exitCode = 1; }
}
