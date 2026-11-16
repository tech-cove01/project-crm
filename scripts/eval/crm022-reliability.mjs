/** CRM-022隔离评测. Execute only a reviewed plan with its exact content digest. */
import { fork, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { z } from "zod";

const root = resolve(import.meta.dirname, "../..");
const privateRoot = resolve(root, ".local/crm022");
const sourcePaths = [
  "scripts/eval/crm022-reliability.mjs", "scripts/eval/crm022-reliability-worker.mjs",
  "workers/agent-worker/main.ts", "lib/agent-engine/queue/queue.ts", "lib/ai/agents/workbench-resume-job.ts",
  "lib/ai/integrations/langfuse-readback.ts", "lib/event-log/drain.ts", "scripts/dev-integration-drain.ts",
];
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const canonical = value => JSON.stringify(value);
const scopes = ["retry", "interrupt"];
const terminal = new Set(["completed", "partial", "failed", "cancelled", "awaiting_confirmation"]);
const visibilityTimeoutMs = 120_000;
const check = (condition, code) => {
  if (!condition) throw Object.assign(new Error(code), { safeCode: code });
};
const safe = error => /^crm022_[a-z0-9_]+$/.test(error?.safeCode ?? "") ||
  /^langfuse_readback_[a-z0-9_]+$|^integration_http_\d{3}$/.test(error?.message ?? "")
  ? error.safeCode ?? error.message : "crm022_reliability_instrument_failed";
const id = z.string().uuid();
const caseSchema = z.object({
  scenario: z.enum(scopes),
  runId: id,
  jobId: id,
  proposalId: id,
  leadId: id,
  contactId: id,
  pipelineId: id,
  proposalStatus: z.enum(["executed", "rejected"]),
  expectedStageId: id,
  expectedStageEffects: z.union([z.literal(0), z.literal(1)]),
  expectedEffectEvents: z.union([z.literal(0), z.literal(1)]),
}).strict();

export const planSchema = z.object({
  version: z.literal(1),
  batchId: id,
  head: z.string().regex(/^[a-f0-9]{40}$/),
  organizationId: id,
  organizationSlug: z.string().regex(/^crm022-[a-z0-9-]{1,80}$/),
  database: z.object({ name: z.string().regex(/^[a-z0-9_]+$/), systemIdentifier: z.string().regex(/^\d{10,24}$/) }).strict(),
  cases: z.array(caseSchema).max(2),
  telemetryRootIds: z.array(id).max(20),
  langfuseOrigin: z.string().optional(),
  sourceHashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  fixtureHash: z.string().regex(/^[a-f0-9]{64}$/),
  evidence: z.array(z.object({ name: z.string().regex(/^[a-z0-9-]+\.json$/), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(2),
}).strict().superRefine((plan, ctx) => {
  if ((!plan.cases.length && !plan.telemetryRootIds.length) || (plan.cases.length && plan.telemetryRootIds.length))
    ctx.addIssue({ code: "custom", path: ["cases"], message: "exactly_one_kind_of_plan_required" });
  for (const key of ["scenario", "runId", "jobId", "proposalId", "leadId"]) {
    if (new Set(plan.cases.map(row => row[key])).size !== plan.cases.length)
      ctx.addIssue({ code: "custom", path: ["cases"], message: "unique_case_identity_required" });
  }
  if (new Set(plan.telemetryRootIds).size !== plan.telemetryRootIds.length)
    ctx.addIssue({ code: "custom", path: ["telemetryRootIds"], message: "unique_telemetry_ids_required" });
  for (const row of plan.cases) {
    const expected = row.proposalStatus === "executed" ? 1 : 0;
    if (row.expectedStageEffects !== expected || row.expectedEffectEvents !== expected)
      ctx.addIssue({ code: "custom", path: ["cases"], message: "effect_oracle_conflicts_with_decision" });
  }
});

function urlOf(raw) {
  try { return new URL(raw ?? ""); } catch { check(false, "crm022_isolated_endpoint_required"); }
}
function loopback(url) { return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname); }
function configuredEnvironment(plan) {
  const db = urlOf(process.env.SUPABASE_DB_URL);
  const api = urlOf(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const app = urlOf(process.env.NEXT_PUBLIC_APP_URL);
  check(loopback(db) && ["postgresql:", "postgres:"].includes(db.protocol) && db.port === "55522" &&
    db.pathname === `/${plan.database.name}` && !db.search && !db.hash &&
    loopback(api) && api.protocol === "http:" && api.port === "55521" && api.pathname === "/" &&
    !api.username && !api.password && !api.search && !api.hash &&
    loopback(app) && app.protocol === "http:" && app.port === "3415" && app.pathname === "/" &&
    !app.username && !app.password && !app.search && !app.hash && process.env.NODE_ENV === "development",
  "crm022_isolated_endpoint_required");
  return { db, api, app };
}

async function readPlan(pathArg, expected) {
  const path = resolve(pathArg ?? "");
  check(path.startsWith(privateRoot + sep) && /^[a-f0-9]{64}$/.test(expected ?? ""), "crm022_exact_plan_required");
  const bytes = await readFile(path);
  check(sha(bytes) === expected, "crm022_plan_digest_changed");
  const parsed = planSchema.safeParse(JSON.parse(bytes.toString("utf8")));
  check(parsed.success, "crm022_plan_invalid");
  const current = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true }).trim();
  check(current === parsed.data.head, "crm022_plan_head_changed");
  check(canonical(Object.keys(parsed.data.sourceHashes).sort()) === canonical([...sourcePaths].sort()), "crm022_source_manifest_required");
  for (const name of sourcePaths)
    check(sha(await readFile(resolve(root, name))) === parsed.data.sourceHashes[name], "crm022_planned_source_changed");
  const batch = resolve(privateRoot, "reliability", parsed.data.batchId);
  check(dirname(path) === batch, "crm022_exact_batch_fixture_required");
  await fixtureByHash(batch, parsed.data.fixtureHash);
  for (const evidence of parsed.data.evidence)
    check(sha(await readFile(resolve(batch,evidence.name))) === evidence.sha256, "crm022_frozen_evidence_changed");
  return parsed.data;
}

async function seal(directory, name, data) {
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, name);
  const text = JSON.stringify(data, null, 2) + "\n";
  await writeFile(path, text, { flag: "wx", mode: 0o600 });
  return { path, sha256: sha(text) };
}

async function query(pool, text, values = []) {
  check(/^\s*select\b/i.test(text), "crm022_report_sql_must_be_read_only");
  return (await pool.query(text, values)).rows;
}
async function verifyDatabase(pool, plan) {
  const [identity] = await query(pool, "select current_database() as name, system_identifier::text as system_identifier, (select count(*)::int from organizations) organization_count from pg_control_system()");
  const [org] = await query(pool, "select id,slug from organizations where id=$1::uuid", [plan.organizationId]);
  check(identity?.name === plan.database.name && identity.system_identifier === plan.database.systemIdentifier &&
    org?.id === plan.organizationId && org.slug === plan.organizationSlug && identity.organization_count === 1,
    "crm022_database_identity_mismatch");
}

async function jobSnapshot(pool, plan, target) {
  const [row] = await query(pool, `select j.id,j.status,j.attempts,j.max_attempts,j.locked_by,j.locked_at::text,
    j.run_after::text,round(extract(epoch from (j.run_after-clock_timestamp()))*1000)::int backoff_remaining_ms,
    j.last_error='workbench_resume_run_read_failed' as controlled_read_failure,
    r.status as run_status,r.error_code as run_error_code,r.completed_at::text as run_completed_at
    from job_queue j join ai_workbench_runs r on r.organization_id=j.organization_id
      and r.id=$3::uuid and j.payload->>'runId'=r.id::text
    where j.organization_id=$1::uuid and j.id=$2::uuid and j.kind='workbench_resume'
      and j.source_event_id=$4::uuid and r.run_kind='root' and r.mode='act' and r.mission_id is null
      and r.scope->>'leadId'=$5::text and r.scope->>'contactId'=$6::text and r.scope->>'pipelineId'=$7::text`,
  [plan.organizationId, target.jobId, target.runId, target.proposalId, target.leadId, target.contactId, target.pipelineId]);
  check(row?.id === target.jobId, "crm022_owned_resume_job_not_found");
  return row;
}

async function consequence(pool, plan, target) {
  const [row] = await query(pool, `select l.id,l.stage_id,l.updated_at::text,p.status as proposal_status,
    count(a.id)::int as stage_effects,
    (select count(*)::int from ai_agent_run_events e where e.organization_id=$1::uuid and e.run_id=$3::uuid
      and e.event_type='crm_state_changed' and e.payload->>'proposalId'=($4::uuid)::text) as effect_events,
    (select count(*)::int from job_queue j where j.organization_id=$1::uuid and j.source_event_id=$4::uuid
      and j.payload->>'runId'=($3::uuid)::text and j.kind='workbench_resume') as resume_jobs,
    (select count(*)::int from ai_agent_action_proposals p2 where p2.organization_id=$1::uuid and p2.run_id=$3::uuid
      and p2.id<>$4::uuid) as extra_proposals,
    (select count(*)::int from llm_calls c where c.organization_id=$1::uuid and c.workbench_run_id=$3::uuid) as model_rows
    from crm_leads l join ai_agent_action_proposals p on p.organization_id=l.organization_id and p.run_id=$3::uuid
      and p.id=$4::uuid and p.tool_name='crm_move_lead_stage' and p.tool_args->>'lead_id'=l.id::text
    left join crm_lead_activities a on a.organization_id=l.organization_id and a.lead_id=l.id and a.type='stage_changed'
    where l.organization_id=$1::uuid and l.id=$2::uuid and l.contact_id=$5::uuid and l.pipeline_id=$6::uuid
    group by l.id,p.status`, [plan.organizationId, target.leadId, target.runId, target.proposalId, target.contactId, target.pipelineId]);
  check(row?.id === target.leadId, "crm022_owned_lead_or_proposal_not_found");
  return row;
}

function expectedEffect(row, target) {
  return row.stage_id === target.expectedStageId && row.proposal_status === target.proposalStatus &&
    row.stage_effects === target.expectedStageEffects && row.effect_events === target.expectedEffectEvents &&
    row.resume_jobs === 1 && row.extra_proposals === 0;
}

async function verifyExclusiveQueue(pool, target) {
  const rows = await query(pool, "select id from job_queue where status in ('pending','running') order by id limit 2");
  check(rows.length === 1 && rows[0].id === target.jobId, "crm022_exclusive_worker_queue_required");
  const [channels] = await query(pool, "select exists(select 1 from channel_sessions) any_channel_session");
  check(channels?.any_channel_session === false, "crm022_customer_channels_must_be_absent");
}

export async function poll(read, matches, ms, code, intervalMs = 150) {
  const end = performance.now() + ms;
  do {
    const value = await read();
    if (matches(value)) return value;
    await sleep(intervalMs);
  } while (performance.now() < end);
  check(false, code);
}

export function startWorker(plan, target, mode, endpoints, environment = process.env) {
  // Keep the fault local to the dedicated child. The app, normal worker, and PG remain unpatched.
  const env = { ...environment };
  for (const variable of ["WAHA_API_BASE_URL", "WAHA_API_KEY", "WACALLS_API_BASE_URL", "WACALLS_API_TOKEN", "NODE_OPTIONS"])
    delete env[variable];
  const child = fork(resolve(import.meta.dirname, "crm022-reliability-worker.mjs"), [mode, plan.organizationId,
    target.runId, endpoints.api.origin, endpoints.db.port, plan.database.name], {
    cwd: root,
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
    env: { ...env, HEALTH_HOST: "127.0.0.1", HEALTH_PORT: "8795", SENTRY_DSN: "off", FLYWHEEL_INTERVAL_MS: "0",
      QUEUE_MAX_CONCURRENCY: "1", QUEUE_VISIBILITY_TIMEOUT_MS: String(visibilityTimeoutMs), QUEUE_REAPER_INTERVAL_MS: "1000", QUEUE_POLL_INTERVAL_MS: "500" },
  });
  const state = { pid: child.pid, mode, stdoutBytes: 0, stderrBytes: 0, fault: null, exit: null, spawnError: false };
  child.stdout.on("data", value => { state.stdoutBytes += Buffer.byteLength(value); });
  child.stderr.on("data", value => { state.stderrBytes += Buffer.byteLength(value); });
  child.on("error", () => { state.spawnError = true; });
  child.on("exit", (code, signal) => { state.exit = { code, signal }; });
  child.on("message", message => {
    if (message?.type === "crm022-fault-observed" && message.pid === child.pid && message.runId === target.runId && message.mode === mode) {
      state.fault = { mode, pid: child.pid, at: new Date().toISOString() };
    }
  });
  return { child, state };
}

export async function stopWorker(worker, hard = false) {
  if (!worker || worker.state.exit || worker.state.spawnError) return;
  if (hard) {
    check(worker.child.kill("SIGKILL"), "crm022_owned_worker_interrupt_failed");
  } else if (worker.child.connected) {
    worker.child.send({ type: "stop" });
  }
  try {
    await poll(() => Promise.resolve(worker.state.exit), Boolean, hard ? 5000 : 45_000, "crm022_worker_completion_timeout");
  } catch (error) {
    if (!worker.state.exit && worker.child.kill("SIGKILL"))
      await poll(() => Promise.resolve(worker.state.exit), Boolean, 5000, "crm022_owned_worker_cleanup_failed");
    throw error;
  }
}

export async function verifyWorkerPortFree() {
  try {
    await fetch("http://127.0.0.1:8795/healthz", { signal: AbortSignal.timeout(800), redirect: "error" });
  } catch (error) {
    check(error?.cause?.code === "ECONNREFUSED", "crm022_worker_port_not_proven_free");
    return;
  }
  check(false, "crm022_worker_port_already_serving");
}

async function fault(pool, plan, target, endpoints, report) {
  const before = await jobSnapshot(pool, plan, target);
  const effectsBefore = await consequence(pool, plan, target);
  report.before = { job: before, effects: effectsBefore };
  check(before.status === "pending" && before.attempts === 0 && before.max_attempts > 1 && before.run_status === "running" &&
    expectedEffect(effectsBefore, target), "crm022_clean_pending_resume_required");
  await verifyExclusiveQueue(pool, target);
  await verifyWorkerPortFree();
  let first, replacement;
  try {
    first = startWorker(plan, target, target.scenario, endpoints);
    report.firstWorker = first.state;
    await poll(() => Promise.resolve(first.state), value => value.fault || value.exit || value.spawnError,
      60_000, "crm022_worker_never_reached_fault");
    check(first.state.fault && !first.state.exit, "crm022_worker_exit_before_fault");
    const faultAt = performance.now();
    if (target.scenario === "interrupt") {
      const live = await jobSnapshot(pool, plan, target);
      const atInterrupt = await consequence(pool, plan, target);
      const owner = `agent-engine-${hostname()}-${first.state.pid}`;
      check(live.status === "running" && live.attempts === 1 && live.locked_by === owner && live.locked_at &&
        atInterrupt.model_rows === effectsBefore.model_rows && expectedEffect(atInterrupt, target), "crm022_interrupt_lease_or_model_boundary_mismatch");
      report.interruption = { lease: live, noAdditionalModelRowsAtFault: true };
      await stopWorker(first, true);
      const abandoned = await jobSnapshot(pool, plan, target);
      report.abandoned = abandoned;
      check(abandoned.status === "running" && abandoned.locked_by === owner, "crm022_abandoned_lease_not_preserved");
      await verifyWorkerPortFree();
      replacement = startWorker(plan, target, "normal", endpoints);
      report.replacementWorker = replacement.state;
    } else {
      const rescheduled = await poll(() => jobSnapshot(pool, plan, target), value => value.status === "pending" && value.attempts === 1,
        5000, "crm022_retry_not_observed");
      const failureEffects = await consequence(pool, plan, target);
      report.retry = { rescheduled, noAdditionalModelRowsAtFault: failureEffects.model_rows === effectsBefore.model_rows };
      check(rescheduled.controlled_read_failure && rescheduled.backoff_remaining_ms > 7500 && rescheduled.backoff_remaining_ms <= 10_000 &&
        failureEffects.model_rows === effectsBefore.model_rows && expectedEffect(failureEffects, target), "crm022_retry_schedule_or_effect_mismatch");
    }
    const expectedWorker = `agent-engine-${hostname()}-${(replacement ?? first).state.pid}`;
    const recovered = await poll(async () => {
      const sampled = await jobSnapshot(pool, plan, target);
      if (!report.recoveredLease && sampled.status === "running" && sampled.attempts === 2 && sampled.locked_by === expectedWorker)
        report.recoveredLease = sampled;
      return sampled;
    }, value => (value.status === "done" && terminal.has(value.run_status)) || ["dead", "failed"].includes(value.status),
    240_000, "crm022_recovery_deadline");
    const effectsAfter = await consequence(pool, plan, target);
    report.after = { job: recovered, effects: effectsAfter };
    report.recoveryElapsedMs = Math.round(performance.now() - faultAt);
    report.queueRecovered = recovered.status === "done" && recovered.attempts === 2;
    report.resumeModelObserved = effectsAfter.model_rows > effectsBefore.model_rows;
    report.modelCompleted = recovered.run_status === "completed";
    report.businessEffectIntact = expectedEffect(effectsAfter, target) && effectsBefore.updated_at === effectsAfter.updated_at;
    report.duplicateBusinessWrites = Math.max(0, effectsAfter.stage_effects - target.expectedStageEffects);
    report.rejectedWrongExecution = target.proposalStatus === "rejected" &&
      (effectsAfter.stage_effects > 0 || effectsAfter.effect_events > 0 || effectsAfter.stage_id !== target.expectedStageId);
    report.status = report.queueRecovered && report.resumeModelObserved && report.businessEffectIntact && !report.rejectedWrongExecution ? "pass" : "fail";
  } finally {
    try { await stopWorker(replacement); } finally { await stopWorker(first); }
  }
}

function outboxReceipts(snapshot) {
  return snapshot.flatMap(run => run.outbox.map(({ id, payload_sha256 }) => [id, payload_sha256])).sort();
}
function businessDigest(snapshot) {
  return sha(canonical(snapshot.map(({ runId, roots, jobs, calls, proposals, leads, stageActivities }) =>
    ({ runId, roots, jobs, calls, proposals, leads, stageActivities }))));
}

async function telemetrySnapshot(pool, plan, binding) {
  const client = await pool.connect();
  const snapshots = [];
  try {
    await client.query("begin isolation level repeatable read read only");
    for (const runId of plan.telemetryRootIds) {
      const roots = await query(client, `select id,parent_run_id,run_kind,status,error_code,completed_at::text,
        scope->>'leadId' as lead_id from ai_workbench_runs where organization_id=$1::uuid and
        ((id=$2::uuid and run_kind='root') or (parent_run_id=$2::uuid and run_kind='specialist')) order by id`, [plan.organizationId, runId]);
      check(roots.some(row => row.id === runId && terminal.has(row.status)), "crm022_owned_terminal_trace_required");
      const runIds = roots.map(row => row.id);
      const args = [plan.organizationId, runIds];
      const jobs = await query(client, `select id,kind,status,attempts from job_queue where organization_id=$1::uuid
        and payload->>'runId'=any($2::text[]) order by id`, args);
      const calls = await query(client, `select id,workbench_run_id,job_id,provider,model,purpose,status,
        input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_cents from llm_calls
        where organization_id=$1::uuid and workbench_run_id=any($2::uuid[]) order by id`, args);
      const proposals = await query(client, `select id,run_id,tool_name,status from ai_agent_action_proposals
        where organization_id=$1::uuid and run_id=any($2::uuid[]) order by id`, args);
      const leadIds = roots.map(row => row.lead_id).filter(Boolean);
      const leads = await query(client, `select id,stage_id,updated_at::text from crm_leads where organization_id=$1::uuid
        and id::text=any($2::text[]) order by id`, [plan.organizationId, leadIds]);
      const stageActivities = await query(client, `select id,lead_id,created_at::text from crm_lead_activities where organization_id=$1::uuid
        and lead_id::text=any($2::text[]) and type='stage_changed' order by id`, [plan.organizationId, leadIds]);
      const outbox = await query(client, `select id,entity_id,status,attempts,next_attempt_at::text,
        coalesce(consumed_by @> array['ai_integration.langfuse_v1']::text[],false) consumed,
        encode(sha256(convert_to(payload::text,'UTF8')),'hex') as payload_sha256,
        case when payload->>'kind'='spans' then (select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
          'traceId',value->>'traceId','spanId',value->>'spanId','parentSpanId',value->>'parentSpanId','name',value->>'name',
          'startTimeUnixNano',value->>'startTimeUnixNano','endTimeUnixNano',value->>'endTimeUnixNano')))
          from jsonb_array_elements(payload->'spans')) else null end spans
        from event_log where organization_id=$1::uuid and entity_id=any($2::uuid[])
          and event_type='ai_integration.langfuse_export' order by created_at,id`, args);
      snapshots.push({ runId, roots, jobs, calls, proposals, leads, stageActivities, outbox });
    }
    await client.query("commit");
  } finally {
    try { await client.query("rollback"); } finally { client.release(); }
  }
  const { readLangfuseObservations } = await import("../../lib/ai/integrations/langfuse-readback.ts");
  return Promise.all(snapshots.map(async snapshot => {
    const expected = snapshot.outbox.flatMap(event => event.spans ?? []);
    const lifecycleCoverage = snapshot.roots.every(row => snapshot.outbox.some(event => event.entity_id === row.id &&
      event.spans?.some(span => span.name === (row.parent_run_id ? "crm.specialist" : "crm.run"))));
    const byId = new Map(expected.map(span => [span.spanId, span]));
    const sqlParentCoverage = [...byId.values()].every(span => {
      const parent = byId.get(span.parentSpanId);
      if (span.name === "crm.run") return !span.parentSpanId;
      if (span.name === "crm.specialist") return parent?.name === "crm.run";
      if (span.name === "crm.call") return ["crm.run", "crm.specialist"].includes(parent?.name);
      return ["crm.model", "crm.tool"].includes(span.name) && parent?.name === "crm.call";
    });
    const modelCallCoverage = snapshot.roots.every(row => {
      const calls = snapshot.calls.filter(call => call.workbench_run_id === row.id).length;
      const spanCalls = new Set(snapshot.outbox.filter(event => event.entity_id === row.id)
        .flatMap(event => event.spans ?? []).filter(span => span.name === "crm.call").map(span => span.spanId)).size;
      return calls === spanCalls;
    });
    let remote;
    try {
      remote = await readLangfuseObservations(binding, expected);
    } catch (error) {
      remote = { complete: false, error: safe(error) };
    }
    return { ...snapshot, lifecycleCoverage, sqlParentCoverage, modelCallCoverage,
      expectedStableIds: [...new Set(expected.map(span => span.spanId))].sort(),
      remote, complete: lifecycleCoverage && sqlParentCoverage && modelCallCoverage && remote.complete &&
        snapshot.outbox.length > 0 && snapshot.outbox.every(event => event.status === "done" && event.consumed) };
  }));
}

async function readback(pool, plan, mode, directory, report) {
  const origin = urlOf(plan.langfuseOrigin);
  check(loopback(origin) && origin.protocol === "http:" && origin.port === "3006" &&
    !origin.username && !origin.password && !origin.search && !origin.hash && origin.pathname === "/" &&
    plan.telemetryRootIds.length > 0, "crm022_telemetry_target_required");
  const { integrationBindings } = await import("../../lib/ai/integrations/config.ts");
  const binding = integrationBindings().find(row => row.organization_id === plan.organizationId && row.provider === "langfuse");
  check(binding && urlOf(binding.base_url).origin === origin.origin, "crm022_isolated_langfuse_binding_required");
  const current = await telemetrySnapshot(pool, plan, binding);
  report.runs = current;
  report.businessFingerprint = businessDigest(current);
  report.outboxReceipts = outboxReceipts(current);
  report.pending = current.flatMap(run => run.outbox).filter(row => row.status === "pending").length;
  report.complete = current.every(run => run.complete);
  report.expectedStableSpans = current.reduce((total, run) => total + run.expectedStableIds.length, 0);
  report.visibleSpans = current.every(run => typeof run.remote.observationCount === "number")
    ? current.reduce((total, run) => total + run.remote.observationCount, 0) : null;
  if (mode === "delivery-before") {
    report.status = report.pending > 0 && !report.complete ? "pass" : "unknown";
    return;
  }
  const before = JSON.parse(await readFile(resolve(directory, "delivery-before.json"), "utf8"));
  check(before.planHash === report.planHash && before.pending > 0 && before.complete === false, "crm022_delivery_pause_proof_required");
  const beforeAt = Date.parse(before.at), afterAt = Date.parse(report.at);
  check(Number.isFinite(beforeAt) && afterAt >= beforeAt, "crm022_delivery_observation_clock_invalid");
  report.pauseToReadbackMs = afterAt - beforeAt;
  report.businessUnchanged = before.businessFingerprint === report.businessFingerprint;
  report.outboxPayloadsUnchanged = canonical(before.outboxReceipts) === canonical(report.outboxReceipts);
  report.status = report.complete && report.businessUnchanged && report.outboxPayloadsUnchanged ? "pass" : "fail";
}

async function sourceManifest() {
  return Object.fromEntries(await Promise.all(sourcePaths.map(async name => [name, sha(await readFile(resolve(root, name)))])));
}

export async function fixtureByHash(directory, expected) {
  check(/^[a-f0-9]{64}$/.test(expected??""),"crm022_exact_fixture_required");
  for (const candidate of ["fixture.json", "fixture-execution.json", `fixture-execution-${expected}.json`]) {
    const bytes = await readFile(resolve(directory,candidate)).catch(error => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (bytes && sha(bytes) === expected) return JSON.parse(bytes);
  }
  check(false, "crm022_fixture_digest_changed");
}

async function prepare(args) {
  const [batchId, fixtureHash, mode, ...hashes] = args;
  check(id.safeParse(batchId).success && /^[a-f0-9]{64}$/.test(fixtureHash ?? "") &&
    [...scopes,"delivery"].includes(mode) && hashes.length >= 1 && hashes.length <= (mode === "delivery" ? 2 : 1) &&
    hashes.every(value => /^[a-f0-9]{64}$/.test(value)), "crm022_prepare_arguments_invalid");
  const directory = resolve(privateRoot,"reliability",batchId);
  const fixture = await fixtureByHash(directory,fixtureHash);
  const head = execFileSync("git",["rev-parse","HEAD"],{cwd:root,encoding:"utf8",windowsHide:true}).trim();
  check(fixture.id === batchId && fixture.head === head, "crm022_plan_head_changed");
  const evidence = [];
  const cases = [], telemetryRootIds = [];
  if (mode === "delivery") {
    for (const expected of hashes) {
      const { readdir } = await import("node:fs/promises");
      let picked;
      for (const name of await readdir(directory)) {
        if (!/^(retry|interrupt)-report-\d+-[a-f0-9-]+\.json$/.test(name)) continue;
        const bytes = await readFile(resolve(directory,name));
        if (sha(bytes) === expected) picked = { name, parsed:JSON.parse(bytes) };
      }
      check(picked?.parsed.after?.job?.status === "done" && id.safeParse(picked.parsed.runId).success,
        "crm022_exact_terminal_fault_report_required");
      evidence.push({ name:picked.name,sha256:expected });
      telemetryRootIds.push(picked.parsed.runId);
    }
  } else {
    const name = `${mode}-decision-result.json`;
    const bytes = await readFile(resolve(directory,name));
    check(sha(bytes) === hashes[0], "crm022_exact_decision_report_required");
    const decision = JSON.parse(bytes);
    const row = fixture.cases.find(row=>row.scenario===mode);
    check(decision.status === "pass" && decision.frozenCase?.scenario === mode && decision.frozenCase.leadId === row?.leadId &&
      decision.frozenCase.contactId === row.contactId && decision.frozenCase.pipelineId === fixture.pipelineId,
    "crm022_decision_report_target_mismatch");
    evidence.push({name,sha256:hashes[0]});
    cases.push(decision.frozenCase);
  }
  const plan = planSchema.parse({ version:1,batchId,head,organizationId:fixture.organizationId,organizationSlug:fixture.organizationSlug,
    database:fixture.database,cases,telemetryRootIds,...(mode === "delivery" ? { langfuseOrigin:"http://127.0.0.1:3006" } : {}),
    sourceHashes:await sourceManifest(),fixtureHash,evidence });
  console.log(JSON.stringify({...await seal(directory,`plan-${mode}.json`,plan),requests:0}));
}

export async function main(args = process.argv.slice(2)) {
  const [mode, planPath, planHash] = args;
  if (!mode || mode === "--help") {
    console.log("prepare <batchId> <fixtureSha> <retry|interrupt|delivery> <evidenceSha> [evidenceSha]; node --env-file=.local/crm022/runtime.env --import tsx scripts/eval/crm022-reliability.mjs <check-plan|retry|interrupt|delivery-before|delivery-after> <plan.json> <sha256>");
    return;
  }
  if (mode === "source-manifest" && args.length === 1) {
    console.log(JSON.stringify(await sourceManifest()));
    return;
  }
  if (mode === "prepare") return prepare(args.slice(1));
  check(args.length === 3 && ["check-plan", ...scopes, "delivery-before", "delivery-after"].includes(mode), "crm022_reliability_command_invalid");
  const plan = await readPlan(planPath, planHash);
  if (mode === "check-plan") {
    console.log(JSON.stringify({ planHash, cases: plan.cases.map(row => row.scenario), requests: 0 }));
    return;
  }
  const telemetry = mode.startsWith("delivery-");
  const target = plan.cases.find(row => row.scenario === mode);
  check((target || telemetry) && process.env.CRM022_RELIABILITY_EXECUTE === "1", "crm022_frozen_execution_required");
  const endpoints = configuredEnvironment(plan);
  const directory = resolve(privateRoot, "reliability", plan.batchId);
  const report = { version: 1, planHash, at: new Date().toISOString(), scenario: mode, status: "unknown",
    ...(telemetry ? { sqlReadOnly: true, remoteMethods: ["GET"], noNewBusinessOrModelRequest: true } : {
      runId: target.runId, jobId: target.jobId, effect: "approved_safe_stage_only", syntheticControlledFault: true,
      visibilityTimeoutMs, pollIntervalMs: 150, noNewRunOrDecisionByFaultDriver: true,
    }) };
  const pool = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL, options: "-c default_transaction_read_only=on",
    max: 1, connectionTimeoutMillis: 5000, statement_timeout: 5000, query_timeout: 6000 });
  let lost = false;
  pool.on("error", () => { lost = true; });
  pool.on("connect", client => client.on("error", () => { lost = true; }));
  try {
    await verifyDatabase(pool, plan);
    if (telemetry) {
      await readback(pool, plan, mode, directory, report);
    } else {
      await seal(directory, `${mode}-intent.json`, { at: report.at, planHash, runId: target.runId, jobId: target.jobId });
      await fault(pool, plan, target, endpoints, report);
    }
    check(!lost, "crm022_observer_database_disconnected");
  } catch (error) {
    report.status = "unknown";
    report.failure = safe(error);
  } finally {
    try { await pool.end(); } catch { report.status = "unknown"; report.failure = "crm022_observer_database_close_failed"; }
  }
  const name = telemetry && mode === "delivery-before" && report.status === "pass"
    ? "delivery-before.json" : `${mode}-report-${Date.now()}-${randomUUID()}.json`;
  const artifact = await seal(directory, name, report);
  console.log(JSON.stringify({ ...artifact, status: report.status, failure: report.failure, runId: target?.runId,
    ...(telemetry ? { pending:report.pending, expectedStableSpans:report.expectedStableSpans,visibleSpans:report.visibleSpans } : {
      recoveryElapsedMs:report.recoveryElapsedMs,queueRecovered:report.queueRecovered,modelCompleted:report.modelCompleted,
      duplicateBusinessWrites:report.duplicateBusinessWrites,rejectedWrongExecution:report.rejectedWrongExecution,
    }) }));
  if (report.status !== "pass") process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(JSON.stringify({ code: safe(error) }));
    process.exitCode = 1;
  });
}
