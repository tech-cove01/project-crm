import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadEnvironment, transport } from "./crm022-sales.mjs";
import { fixtureByHash, poll, startWorker, stopWorker, verifyWorkerPortFree } from "./crm022-reliability.mjs";

const root = resolve(import.meta.dirname, "../..");
const base = resolve(root, ".local/crm022/reliability");
const uu = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const runsPath = "/api/v1/ai/workbench/runs";
const tool = "crm_move_lead_stage";
const provider = "dashscope";
const model = "qwen3.8-flash";
const tools = ["crm_get_lead", tool];
const budgets = { maxSteps: 8, tokenBudget: 16_000, costBudgetCents: 75 };
const system = "只在 CRM-022 隔离合成夹具执行任务。只读取选中的商机，按明确请求暂存一次阶段动作，等待外部明确决定。决定后只重读和报告，不重提、不写其他字段或发送消息。";
const check = (ok, code) => { if (!ok) throw new Error(code); };
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const now = () => new Date().toISOString();
const source = () => execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true }).trim();
const sourcePaths = ["scripts/eval/crm022-reliability-fixtures.mjs", "scripts/eval/crm022-reliability.mjs", "scripts/eval/crm022-reliability-worker.mjs", "scripts/eval/crm022-sales.mjs", "scripts/eval/crm022-sales-checks.mjs",
  "app/api/v1/ai/workbench/runs/route.ts", "app/api/v1/ai/workbench/runs/[id]/proposals/[proposalId]/decision/route.ts"];

async function artifact(dir, name, value) {
  const path = resolve(dir, name);
  const bytes = JSON.stringify(value, null, 2) + "\n";
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  return { path, sha256: sha(bytes) };
}

function taskFor(fixture, row) {
  return {
    agentId: fixture.agentId, mode: "act", collaboration: "disabled",
    scope: { leadId: row.leadId, contactId: row.contactId, pipelineId: fixture.pipelineId },
    task: `[${fixture.marker}:${row.scenario}] 这是无外联的合成可靠性验收。先用 crm_get_lead 读取当前商机 ${row.leadId}，再仅调用一次 crm_move_lead_stage 暂存目标 ${fixture.targetStageId}，不执行别的动作。仅收到实际待审批才等待人工决定。决定后由同一个持久 Run 重读相同商机一次，提交结构化中文结果。以真实观察区分已执行与已拒绝，不重提、不发送消息、不编造值。`,
  };
}

async function prepare(args) {
  const [organizationId, organizationSlug, systemIdentifier, initiatorUserId, deciderUserId] = args;
  check(args.length === 5 && [organizationId, initiatorUserId, deciderUserId].every(id => uu.test(id)) &&
    initiatorUserId !== deciderUserId && /^crm022-[a-z0-9-]+$/.test(organizationSlug) && /^\d{10,24}$/.test(systemIdentifier),
  "crm022_fixture_identity_required");
  const id = randomUUID();
  const directory = resolve(base, id);
  await mkdir(directory, { recursive: true });
  const fixture = { version: 1, id, at: now(), head: source(), marker: `crm022-reliability:${id}`, organizationId, organizationSlug,
    database: { name: "postgres", systemIdentifier }, initiatorUserId, deciderUserId, provider, model, tools, budgets,
    knowledgeSources: [], channels: [], pipelineId: randomUUID(), initialStageId: randomUUID(), targetStageId: randomUUID(),
    agentId: randomUUID(), versionId: randomUUID(), approvedCaps: { rootPosts: 2, decisionPosts: 4, judge: 0, channel: 0 },
    cases: ["retry", "interrupt"].map(scenario => ({ scenario, leadId: randomUUID(), contactId: randomUUID() })),
    sourceHashes: Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, sha(await readFile(resolve(root,path)))]))),
  };
  for (const row of fixture.cases) row.payload = taskFor(fixture, row);
  console.log(JSON.stringify({ ...await artifact(directory, "fixture.json", fixture), batchId: id, requests: 0 }));
}

async function load(id, hash) {
  check(uu.test(id ?? "") && /^[a-f0-9]{64}$/.test(hash ?? ""), "crm022_exact_fixture_required");
  const directory = resolve(base, id);
  const f = await fixtureByHash(directory,hash);
  check(f.version === 1 && f.id === id && f.head === source() && f.database?.name === "postgres" &&
    f.marker === `crm022-reliability:${id}` && f.provider === provider && f.model === model &&
    uu.test(f.organizationId) && f.cases.length === 2 && f.cases.map(x => x.scenario).join(",") === "retry,interrupt" &&
    f.cases.every(row => uu.test(row.leadId) && uu.test(row.contactId) &&
      JSON.stringify(taskFor(f, row)) === JSON.stringify(row.payload)), "crm022_frozen_fixture_invalid");
  for (const path of sourcePaths)
    check(sha(await readFile(resolve(root,path))) === f.sourceHashes[path], "crm022_fixture_source_changed");
  return { f, directory };
}

async function rebind(id, originalHash) {
  check(uu.test(id??"") && /^[a-f0-9]{64}$/.test(originalHash??""),"crm022_exact_fixture_required");
  const directory=resolve(base,id), bytes=await readFile(resolve(directory,"fixture.json"));
  check(sha(bytes)===originalHash, "crm022_fixture_digest_changed");
  const f=JSON.parse(bytes), head=source();
  const unchanged=execFileSync("git",["diff","--name-only",f.head,head,"--","app","lib","workers","supabase","package.json","pnpm-lock.yaml"],
    {cwd:root,encoding:"utf8",windowsHide:true}).trim();
  check(f.id===id && unchanged==="", "crm022_current_product_source_differs");
  const seed=JSON.parse(await readFile(resolve(directory,"seed-result.json"),"utf8"));
  check(seed.committed && seed.fixtureHash===originalHash && !seed.modelRequested,"crm022_exact_seed_receipt_required");
  const next={...f,head,originalFixtureHash:originalHash,reboundAt:now(),
    sourceHashes:Object.fromEntries(await Promise.all(sourcePaths.map(async path=>[path,sha(await readFile(resolve(root,path)))])))};
  const digest = sha(JSON.stringify(next,null,2)+"\n");
  console.log(JSON.stringify({...await artifact(directory,`fixture-execution-${digest}.json`,next),head,requests:0}));
}

async function database(env, f, write, fn) {
  const pool = new pg.Pool({ connectionString: env.SUPABASE_DB_URL, max: 1, connectionTimeoutMillis: 5000,
    options: write ? undefined : "-c default_transaction_read_only=on", statement_timeout: 7000, query_timeout: 8000 });
  let client;
  let lost = false;
  pool.on("error", () => { lost = true; });
  try {
    client = await pool.connect();
    client.on("error", () => { lost = true; });
    await client.query(write ? "begin" : "begin isolation level repeatable read read only");
    const [identity] = (await client.query(`select current_database() name, (select system_identifier::text from pg_control_system()) system_id,
      (select slug from organizations where id=$1::uuid) slug, (select count(*)::int from organizations) organizations,
      (select count(*)::int from channel_sessions) channels`, [f.organizationId])).rows;
    check(identity?.name === f.database.name && identity.system_id === f.database.systemIdentifier && identity.slug === f.organizationSlug &&
      identity.organizations === 1 && identity.channels === 0, "crm022_disposable_database_identity_mismatch");
    const result = await fn(client);
    check(!lost, "crm022_database_connection_lost");
    await client.query("commit");
    return result;
  } catch (error) {
    if (client) await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    try { client?.release(); } finally { await pool.end(); }
  }
}

async function seed(env, f, directory, hash) {
  await artifact(directory, "seed-intent.json", { at: now(), fixtureHash: hash });
  await database(env, f, true, async client => {
    const org = f.organizationId;
    const { rows } = await client.query(`select user_id from user_organizations where organization_id=$1::uuid
      and user_id=any($2::uuid[]) and role='admin' and revoked_at is null and accepted_at is not null`, [org,[f.initiatorUserId,f.deciderUserId]]);
    check(rows.length === 2, "crm022_synthetic_actors_required");
    await client.query("insert into crm_pipelines(id,organization_id,name,slug) values($1,$2,'CRM022 合成可靠性漏斗',$3)",
      [f.pipelineId,org,`crm022-reliability-${f.id.slice(0,8)}`]);
    await client.query(`insert into crm_stages(id,organization_id,pipeline_id,name,slug,position)
      values($1,$2,$3,'初始核对','start-review',1000),($4,$2,$3,'方案核对','next-review',2000)`, [f.initialStageId,org,f.pipelineId,f.targetStageId]);
    for (const row of f.cases) {
      await client.query(`insert into contacts(id,organization_id,name,source,source_metadata,created_by_user_id)
        values($1,$2,'CRM022 合成可靠性客户',$3,jsonb_build_object('synthetic',true,'batchId',$4::text),$5)`,
      [row.contactId,org,f.marker,f.id,f.initiatorUserId]);
      await client.query(`insert into crm_leads(id,organization_id,contact_id,pipeline_id,stage_id,title,description,source,tags,created_by_user_id)
        values($1,$2,$3,$4,$5,$6,'仅供本机隔离测试，不授权外联。',$7,$8,$9)`,
      [row.leadId,org,row.contactId,f.pipelineId,f.initialStageId,`CRM022 合成可靠性商机 ${row.scenario}`,f.marker,["crm022-synthetic",f.marker],f.initiatorUserId]);
    }
    await client.query(`insert into ai_agents(id,organization_id,name,kind,model,system_prompt,created_by)
      values($1,$2,'CRM022 合成可靠性 Agent','mcp_agent',$3,$4,$5)`, [f.agentId,org,`${provider}/${model}`,system,f.initiatorUserId]);
    await client.query(`insert into ai_agent_versions(id,organization_id,agent_id,version_number,system_prompt,provider,model,tool_ids,pipeline_ids,
      max_steps,token_budget,cost_budget_cents,handoff_tool_enabled,created_by)
      values($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11,false,$12)`,
    [f.versionId,org,f.agentId,system,provider,model,tools,[f.pipelineId],budgets.maxSteps,budgets.tokenBudget,budgets.costBudgetCents,f.initiatorUserId]);
  });
  return artifact(directory, "seed-result.json", { at: now(), fixtureHash: hash, committed: true, contacts: 2, leads: 2, agents: 1, modelRequested: false });
}

async function snapshot(client, f, row) {
  const result = await client.query(`select l.id,l.stage_id,l.updated_at::text,l.contact_id,l.pipeline_id,
    (select count(*)::int from crm_lead_activities a where a.organization_id=l.organization_id and a.lead_id=l.id and a.type='stage_changed') stage_effects
    from crm_leads l where l.organization_id=$1::uuid and l.id=$2::uuid and l.contact_id=$3::uuid and l.pipeline_id=$4::uuid and l.source=$5::text`,
  [f.organizationId,row.leadId,row.contactId,f.pipelineId,f.marker]);
  check(result.rows.length === 1, "crm022_exact_synthetic_lead_required");
  const roots = (await client.query(`select id,status,mode,agent_id,actor_user_id,(runtime_state->>'versionId') version_id
    from ai_workbench_runs where organization_id=$1::uuid and run_kind='root' and scope=$2::jsonb and task=$3::text order by id`,
  [f.organizationId,JSON.stringify(row.payload.scope),row.payload.task])).rows;
  check(roots.length <= 1 && roots.every(r => r.mode === "act" && r.agent_id === f.agentId && r.actor_user_id === f.initiatorUserId && r.version_id === f.versionId),
    "crm022_unambiguous_owned_root_required");
  const runId = roots[0]?.id;
  const ids = [f.organizationId,runId??null];
  const proposals = (await client.query(`select id,status,tool_name,tool_args->>'lead_id' lead_id,tool_args->>'to_stage_id' target_stage_id
    from ai_agent_action_proposals where organization_id=$1::uuid and run_id=$2::uuid order by id`, ids)).rows;
  const jobs = (await client.query(`select id,source_event_id,kind,status,attempts
    from job_queue where organization_id=$1::uuid and payload->>'runId'=($2::uuid)::text order by id`, ids)).rows;
  const effects = (await client.query(`select payload->>'proposalId' proposal_id,payload->>'tool' tool
    from ai_agent_run_events where organization_id=$1::uuid and run_id=$2::uuid and event_type='crm_state_changed' order by sequence`, ids)).rows;
  const [queue] = (await client.query("select count(*)::int busy from job_queue where status in ('pending','running')")).rows;
  return { lead:result.rows[0], root:roots[0]??null, proposals, jobs, effects, queueBusy:queue.busy };
}

async function verifyAgent(client, f) {
  const { rows: [row] } = await client.query(`select a.id,v.id version_id,v.provider,v.model,v.tool_ids,v.pipeline_ids,v.knowledge_source_ids,
    v.max_steps,v.token_budget,v.cost_budget_cents,encode(sha256(convert_to(v.system_prompt,'UTF8')),'hex') prompt_hash,
    (select supports_tools and deprecated_at is null from ai_models where provider=$4 and model_id=$5) model_ready,
    exists(select 1 from ai_provider_credentials where organization_id=$1::uuid and provider=$4 and is_active and validated_at is not null) credentials_validated
    from ai_agents a join ai_agent_versions v on v.organization_id=a.organization_id and v.agent_id=a.id
    where a.organization_id=$1::uuid and a.id=$2::uuid and v.id=$3::uuid and a.is_active and a.archived_at is null and a.paused_at is null`,
  [f.organizationId,f.agentId,f.versionId,provider,model]);
  check(row?.id === f.agentId && row.version_id === f.versionId && row.provider === provider && row.model === model &&
    JSON.stringify(row.tool_ids) === JSON.stringify(tools) && JSON.stringify(row.pipeline_ids) === JSON.stringify([f.pipelineId]) &&
    (row.knowledge_source_ids?.length??0) === 0 && row.max_steps === budgets.maxSteps && row.token_budget === budgets.tokenBudget &&
    row.cost_budget_cents === budgets.costBudgetCents && row.prompt_hash === sha(system) && row.model_ready && row.credentials_validated,
  "crm022_agent_configuration_changed");
  return row;
}

async function create(env, f, row, directory) {
  const { before, agent } = await database(env,f,false,async client => ({ before:await snapshot(client,f,row),agent:await verifyAgent(client,f) }));
  check(!before.root && before.lead.stage_id === f.initialStageId && before.lead.stage_effects === 0 && before.queueBusy === 0,
    "crm022_fresh_case_and_idle_queue_required");
  return transport(env,{...f,...row},"initiator",async request => {
    await artifact(directory,`${row.scenario}-create-intent.json`,{ at:now(), payload:row.payload, agent, maximumPosts:1 });
    const r = await request(runsPath,"POST",row.payload);
    const runId = uu.test(r.data?.run_id ?? "") ? r.data.run_id : null;
    return artifact(directory,`${row.scenario}-create-receipt.json`,{ at:now(), httpStatus:r.httpStatus, runId, accepted:r.httpStatus === 201 && !!runId });
  });
}

async function stagePending(env, f, row, directory) {
  const receipt=JSON.parse(await readFile(resolve(directory,`${row.scenario}-create-receipt.json`),"utf8"));
  const before=await database(env,f,false,client=>snapshot(client,f,row));
  check(receipt.accepted && before.root?.id===receipt.runId && before.root.status==="queued" && before.queueBusy===1 &&
    before.jobs.length===1 && before.jobs[0].kind==="workbench_start" && before.jobs[0].status==="pending" && before.jobs[0].attempts===0,
  "crm022_unique_queued_start_required");
  await verifyWorkerPortFree();
  await artifact(directory,`${row.scenario}-stage-intent.json`,{at:now(),runId:receipt.runId,jobId:before.jobs[0].id});
  const owned=startWorker(f,{runId:receipt.runId},"normal",{api:new URL(env.NEXT_PUBLIC_SUPABASE_URL),db:new URL(env.SUPABASE_DB_URL)},
    {...process.env,...env});
  const report={at:now(),status:"unknown",runId:receipt.runId,worker:owned.state};
  try {
    const found=await poll(()=>database(env,f,false,client=>snapshot(client,f,row)),s=>
      owned.state.exit || (s.jobs[0]?.status==="done" && ["awaiting_confirmation","completed","partial","failed","cancelled"].includes(s.root?.status)),
    180_000,"crm022_stage_pending_deadline",1000);
    report.snapshot=found;
    report.status=found.root?.status==="awaiting_confirmation" && found.queueBusy===0 && found.jobs[0]?.attempts===1 &&
      found.proposals.length===1 && found.proposals[0].status==="pending" && found.proposals[0].tool_name===tool &&
      found.proposals[0].lead_id===row.leadId && found.proposals[0].target_stage_id===f.targetStageId ? "pass" : "fail";
  } catch(error) { report.failure=/^crm022_[a-z_]+$/.test(error.message??"")?error.message:"crm022_stage_pending_failed"; }
  finally { try { await stopWorker(owned); } catch { report.status="unknown";report.failure="crm022_stage_worker_cleanup_failed"; } }
  const result=await artifact(directory,`${row.scenario}-stage-result.json`,report);
  if(report.status!=="pass") process.exitCode=1;
  return {...result,status:report.status,proposalId:report.status==="pass"?report.snapshot.proposals[0].id:null};
}

async function decide(env, f, row, directory, proposalId) {
  const before = await database(env,f,false,client => snapshot(client,f,row));
  check(uu.test(proposalId ?? "") && before.root?.status === "awaiting_confirmation" && before.proposals.length === 1 &&
    before.proposals[0].id === proposalId && before.proposals[0].status === "pending" && before.proposals[0].tool_name === tool &&
    before.proposals[0].lead_id === row.leadId && before.proposals[0].target_stage_id === f.targetStageId &&
    before.lead.stage_id === f.initialStageId && before.lead.stage_effects === 0 && before.effects.length === 0 && before.queueBusy === 0,
  "crm022_exact_pending_safe_proposal_required");
  // The isolated operator leaves the resume job pending until the exclusive fault worker starts.
  try {
    await fetch("http://127.0.0.1:8795/healthz", { signal: AbortSignal.timeout(800), redirect: "error" });
    check(false,"crm022_worker_still_serving");
  } catch(error) {
    check(error.cause?.code === "ECONNREFUSED", "crm022_worker_stop_not_proven");
  }
  const decisions = row.scenario === "retry" ? ["approve","approve"] : ["reject","approve"];
  const path = `${runsPath}/${before.root.id}/proposals/${proposalId}/decision`;
  const receipts = [];
  await transport(env,{...f,...row},"decider",async request => {
    await artifact(directory,`${row.scenario}-decision-intent.json`,{ at:now(), path, actorUserId:f.deciderUserId, decisions,
      concurrent:row.scenario === "retry", before, maximumPosts:2 });
    const post = async decision => {
      const startedAt = now(), start = performance.now();
      try {
        const r = await request(path,"POST",{ decision, reason:"CRM022 合成隔离可靠性核验" });
        return { decision, startedAt, elapsedMs:Math.round(performance.now()-start), httpStatus:r.httpStatus };
      } catch {
        return { decision, startedAt, elapsedMs:Math.round(performance.now()-start), httpStatus:null, status:"unknown" };
      }
    };
    if (row.scenario === "retry") receipts.push(...await Promise.all(decisions.map(post)));
    else {
      receipts.push(await post("reject"));
      if (receipts[0].httpStatus === 200) receipts.push(await post("approve"));
    }
    await artifact(directory,`${row.scenario}-decision-receipts.json`,{ at:now(), receipts });
  });
  const after = await database(env,f,false,client => snapshot(client,f,row));
  const approved = row.scenario === "retry";
  const expectedStageId = approved ? f.targetStageId : f.initialStageId;
  const proposalStatus = approved ? "executed" : "rejected";
  const resume = after.jobs.filter(job => job.kind === "workbench_resume" && job.source_event_id === proposalId);
  const httpPassed = receipts.length === 2 && (approved ? receipts.map(r=>r.httpStatus).sort().join(",") === "200,409" :
    receipts[0].httpStatus === 200 && receipts[1].httpStatus === 409);
  const businessPassed = after.lead.stage_id === expectedStageId && after.lead.stage_effects === +approved &&
    (approved ? before.lead.updated_at !== after.lead.updated_at : before.lead.updated_at === after.lead.updated_at) &&
    after.proposals.length === 1 && after.proposals[0].status === proposalStatus && after.effects.length === +approved &&
    after.effects.every(e=>e.proposal_id === proposalId && e.tool === tool);
  const queuePassed = resume.length === 1 && resume[0].status === "pending" && resume[0].attempts === 0 && after.queueBusy === 1;
  const pass = httpPassed && businessPassed && queuePassed;
  const frozenCase = pass ? { scenario:row.scenario, runId:before.root.id, jobId:resume[0].id, proposalId,
    leadId:row.leadId, contactId:row.contactId, pipelineId:f.pipelineId, proposalStatus, expectedStageId,
    expectedStageEffects:+approved, expectedEffectEvents:+approved } : null;
  return artifact(directory,`${row.scenario}-decision-result.json`,{ at:now(), status:pass?"pass":receipts.some(r=>r.httpStatus===null)?"unknown":"fail",
    receipts,before,after,httpPassed,businessPassed,queuePassed,frozenCase });
}

async function main(args) {
  const [mode,id,hash,scenario,proposalId] = args;
  if (!mode || mode === "--help") {
    console.log("prepare <orgId> <orgSlug> <pgSystemId> <initiatorId> <deciderId>; seed|rebind <batchId> <fixtureSha>; inspect|create|stage|decide <batchId> <fixtureSha> <retry|interrupt> [proposalId]");
    return;
  }
  if (mode === "prepare") return prepare(args.slice(1));
  if (mode === "rebind" && args.length===3) return rebind(id,hash);
  check(["seed","inspect","create","stage","decide"].includes(mode),"crm022_fixture_command_invalid");
  const { f,directory } = await load(id,hash);
  const env = await loadEnvironment();
  const row = f.cases.find(value => value.scenario === scenario);
  check(mode === "seed" ? args.length === 3 : row && args.length === (mode === "decide" ? 5 : 4), "crm022_fixture_command_invalid");
  if (mode === "inspect") {
    const value = await database(env,f,false,client => snapshot(client,f,row));
    console.log(JSON.stringify(value));
    return;
  }
  check(process.env.CRM022_RELIABILITY_EXECUTE === "1", "crm022_explicit_execution_required");
  const receipt = mode === "seed" ? await seed(env,f,directory,hash) : mode === "create" ? await create(env,f,row,directory) :
    mode === "stage" ? await stagePending(env,f,row,directory) : await decide(env,f,row,directory,proposalId);
  console.log(JSON.stringify(receipt));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    const code = error.code && /^[A-Z0-9]{5}$/.test(error.code) ? error.code : /^crm022_[a-z_]+$/.test(error.message ?? "")
      ? error.message : "crm022_reliability_fixture_failed";
    console.error(JSON.stringify({ error:code }));
    process.exitCode = 1;
  });
}
