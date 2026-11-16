/** CRM-022d evaluation harness. Default invocation only prints usage. */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import pg from "pg";
import { integrationBinding } from "@/lib/ai/integrations/config";
import { calibrationTasks, formalTasks, memoryContacts, orderedArms, type Arm } from "./crm022-memory-cases";
import { defaultMemoryQuery, digest, MemoryFixtureStore, requireCheck } from "./crm022-memory-db";
import { memoryModelSettings, modelInput, scoreMemoryAnswer } from "./crm022-memory-score";

const root = resolve(import.meta.dirname, "../..");
const base = resolve(root, ".local/crm022-memory");
const sourcePaths = [
  "scripts/eval/crm022-memory.ts", "scripts/eval/crm022-memory-db.ts", "scripts/eval/crm022-memory-cases.ts", "scripts/eval/crm022-memory-score.ts",
  "lib/ai/integrations/mem0.ts", "lib/mcp/tools/contacts.ts", "lib/agent-engine/agent/customer-memory.ts",
  "lib/ai/integrations/config.ts", "lib/ai/integrations/http.ts", "lib/ai/integrations/db.ts",
  "lib/agent-engine/edge/llm/credentials.ts", "pnpm-lock.yaml",
];
const providerEndpoint = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
type Phase = "calibration" | "formal";

async function seal(path: string, data: unknown) {
  const text = JSON.stringify(data, null, 2) + "\n";
  await writeFile(path, text, { flag: "wx", mode: 0o600 });
  return digest(text);
}

function safeError(error: unknown) {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && /^[a-z0-9_-]{1,100}$/i.test(code) ? code : "memory_eval_operation_failed";
}

function verifyMatrix() {
  requireCheck(memoryContacts.length === 6 && memoryContacts.reduce((sum, item) => sum + item.facts.length, 0) === 80, "matrix_size_unexpected");
  requireCheck(formalTasks.length === 6 && calibrationTasks.length === 1, "task_count_unexpected");
  for (const task of [...calibrationTasks, ...formalTasks]) {
    requireCheck(new Set(task.fields.map(field => field.key)).size === task.fields.length, "duplicate_field_key");
    const contact = memoryContacts.find(contact => contact.key === task.contact);
    requireCheck(contact && task.fields.every(field => (field.factKey === null) === (field.expected === null)), "field_oracle_invalid");
    for (const field of task.fields) {
      if (field.expected === null) continue;
      const currentBody = contact.mutation?.kind === "revise" && contact.mutation.key === field.factKey ? contact.mutation.currentBody
        : contact.facts.find(row => row.key === field.factKey)?.body;
      requireCheck(currentBody?.includes(field.expected), "answer_missing_from_frozen_fact");
    }
    requireCheck(task.fields.every(field => !modelInput(task, []).prompt.includes(field.expected ?? "\u0000")), "oracle_value_leaked_to_task");
  }
  requireCheck(memoryContacts.find(item => item.key === "boundary")?.facts.slice(0, 2).map(item => item.key).join("+") === "rank51+rank50", "boundary_fixture_order_changed");
}

async function planFor(batchId: string) {
  verifyMatrix();
  return {
    schemaVersion: 1, batchId, ticket: "CRM-022d", productHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    sourceSHA256: Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, digest(await readFile(resolve(root, path)))]))),
    settings: memoryModelSettings, backend: { sqlLimit: 50, outputFacts: 10, mem0Query: defaultMemoryQuery },
    contacts: memoryContacts, calibrationTasks, formalTasks,
    modelRequestLimit: { calibration: 3, formal: 18 },
    transportEntryLimit: { calibration: 15, formal: 554 },
    decisionRule: "Compare the arms per formal task and required field. One run per arm is descriptive. If ordering gain is unclear, unstable on this small sample, or outweighed by cost or stale use, record paused pending user references.",
  };
}

async function freeze() {
  const batchId = randomUUID();
  const folder = resolve(base, batchId);
  await mkdir(folder, { recursive: true });
  const path = resolve(folder, "plan.json");
  const sha256 = await seal(path, await planFor(batchId));
  console.info(JSON.stringify({ path, sha256, calibrationCases: 1, formalCases: 6, modelRequestsAllowed: 21, offline: true }));
}

function liveConfig() {
  const org = process.env.CRM022_ORG_ID ?? "";
  const mem0 = integrationBinding(org, "mem0");
  const config = {
    db: process.env.SUPABASE_DB_URL ?? "",
    org,
    orgSlug: process.env.CRM022_ORG_SLUG ?? "",
    mem0Origin: mem0?.base_url ?? "",
    mem0Key: mem0?.api_key ?? "",
  };
  requireCheck(config.db && uuid.test(config.org) && config.orgSlug && config.mem0Origin && config.mem0Key, "isolated_runtime_env_required");
  const db = new URL(config.db), localMem0 = new URL(config.mem0Origin);
  requireCheck(["postgresql:", "postgres:"].includes(db.protocol) && db.hostname === "127.0.0.1" && db.port === "55522", "isolated_pg_endpoint_required");
  requireCheck(localMem0.origin === "http://127.0.0.1:8888" && config.mem0Origin === localMem0.origin, "local_mem0_origin_required");
  return config;
}

async function checkLocal() {
  verifyMatrix();
  const cfg = liveConfig(), checkId = randomUUID();
  const dir = resolve(base, checkId);
  await mkdir(dir, { recursive: true });
  const report = { checkId, startedAt: new Date().toISOString(), scoringCases: 0, sqlOrderVerified: false, rollbackVerified: false,
    orgBindingVerified: false, modelBindingVerifiedWithoutCall: false, mem0ProtocolVerified: false,
    modelRequests: 0, mem0Writes: 0, error: null as string | null };
  const pool = new pg.Pool({ connectionString: cfg.db, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 8000 });
  const task = calibrationTasks[0]!, contact = memoryContacts.find(item => item.key === task.contact)!;
  let client: pg.PoolClient | undefined;
  let store: MemoryFixtureStore | undefined;
  try {
    const org = await pool.query("select id from organizations where id=$1 and slug=$2", [cfg.org, cfg.orgSlug]);
    const enabled = await pool.query("select enabled from ai_integration_settings where organization_id=$1 and provider='mem0'", [cfg.org]);
    requireCheck(org.rowCount === 1 && enabled.rowCount === 1 && enabled.rows[0]?.enabled === true, "isolated_org_binding_required");
    report.orgBindingVerified = true;
    const { resolveOrgLlmConfig } = await import("@/lib/agent-engine/edge/llm/credentials");
    const config = await resolveOrgLlmConfig(pool, {}, cfg.org, { provider: "dashscope" });
    requireCheck(config.provider === memoryModelSettings.provider && config.defaultModel === memoryModelSettings.model &&
      config.origemDaChave === "credencial_da_organizacao" && config.apiKey, "isolated_model_configuration_not_frozen");
    report.modelBindingVerifiedWithoutCall = true;
    const probe = await fetch(`${cfg.mem0Origin}/openapi.json`, { method: "GET", redirect: "error", signal: AbortSignal.timeout(8000),
      headers: { "X-API-Key": cfg.mem0Key } });
    requireCheck(probe.ok, `mem0_protocol_http_${probe.status}`);
    const schema = await probe.json();
    requireCheck(schema.components?.schemas?.MemoryCreate?.properties?.infer && schema.components.schemas.SearchRequest?.properties?.filters,
      "mem0_protocol_properties_missing");
    report.mem0ProtocolVerified = true;
    client = await pool.connect();
    await client.query("begin");
    store = new MemoryFixtureStore(client, cfg.org, cfg.mem0Origin, cfg.mem0Key, checkId, 0);
    await store.seed([contact]);
    const fixture = store.fixtures.get(task.contact)!;
    const visible = await store.read(fixture, "sql10");
    requireCheck(visible.memories.length === 2 && visible.memories[0]?.id === fixture.rows[1]?.id, "calibration_sql_order_wrong");
    report.sqlOrderVerified = true;
    const ids = new Map(fixture.rows.map(row => [row.key, row.id]));
    const field = task.fields[0]!;
    const answer = (value: string | null, evidenceId: string | null) => JSON.stringify({ answers: { [field.key]: { value, evidence_id: evidenceId } } });
    const correct = scoreMemoryAnswer(task, visible.memories, ids, answer(field.expected, ids.get(field.factKey!)!));
    const wrongId = scoreMemoryAnswer(task, visible.memories, ids, answer(field.expected, fixture.rows[1]!.id));
    const omitted = scoreMemoryAnswer(task, [], ids, answer(null, null));
    const wrongFormat = scoreMemoryAnswer(task, visible.memories, ids, "未找到");
    const staleTask = formalTasks.find(item => item.category === "revision")!;
    const stale = scoreMemoryAnswer(staleTask, [], new Map(), staleTask.fields[0]!.forbidden[0]!);
    const checks = [correct.taskPassed, !wrongId.taskPassed, !omitted.taskPassed && omitted.fields[0]?.appropriateAbstention,
      !wrongFormat.formatPassed, stale.fields[0]?.staleValueUsed];
    requireCheck(checks.every(Boolean), "offline_scoring_rule_check_failed");
    report.scoringCases = checks.length;
  } catch (error) { report.error = safeError(error); }
  finally {
    if (client) {
      try {
        await client.query("rollback");
        const id = store?.fixtures.get(task.contact)?.id;
        const { rows } = await client.query("select (select count(*) from contacts where organization_id=$1 and id=$2)+(select count(*) from ai_customer_memories where organization_id=$1 and contact_id=$2) as remaining", [cfg.org, id]);
        report.rollbackVerified = id !== undefined && Number(rows[0]?.remaining) === 0;
      } catch { report.error ??= "local_check_rollback_verification_failed"; }
    }
    client?.release();
    await pool.end().catch(() => {});
    const path = resolve(dir, "local-preflight-report.json"), sha256 = await seal(path, report);
    console.info(JSON.stringify({ path, sha256, ...report }));
  }
  if (report.error !== null || !report.rollbackVerified || report.scoringCases !== 5) process.exitCode = 1;
}

type TokenUsage = { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null };
const usageNumber = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const emptyUsage = (): TokenUsage => ({ input: null, output: null, cacheRead: null, cacheWrite: null });

async function callModel(system: string, prompt: string, key: string) {
  const started = performance.now();
  let status: number | null = null;
  let requestId: string | null = null;
  let usage = emptyUsage();
  try {
    const response = await fetch(providerEndpoint, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(memoryModelSettings.timeoutMs),
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: memoryModelSettings.model, temperature: memoryModelSettings.temperature,
        max_tokens: memoryModelSettings.maxOutputTokens, enable_thinking: false,
        messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
      }),
    });
    status = response.status;
    const id = response.headers.get("x-request-id");
    requestId = id && /^[\w.-]{1,160}$/.test(id) ? id : null;
    requireCheck(response.ok, `model_http_${status}`);
    const text = await response.text();
    requireCheck(text.length <= 100_000, "model_response_limit");
    const output = JSON.parse(text);
    usage = {
      input: usageNumber(output.usage?.prompt_tokens), output: usageNumber(output.usage?.completion_tokens),
      cacheRead: usageNumber(output.usage?.prompt_tokens_details?.cached_tokens),
      cacheWrite: usageNumber(output.usage?.prompt_tokens_details?.cache_write_tokens),
    };
    const answer = output.choices?.[0];
    requireCheck(typeof answer?.message?.content === "string", "model_final_text_missing");
    const finishReason = typeof answer.finish_reason === "string" && /^[\w-]{1,50}$/.test(answer.finish_reason) ? answer.finish_reason : null;
    return { finalText: answer.message.content as string, usage, status, requestId, elapsedMs: performance.now() - started, finishReason, cost: null, error: null };
  } catch (error) {
    return { finalText: null, usage, status, requestId, elapsedMs: performance.now() - started, finishReason: null, cost: null, error: safeError(error) };
  }
}

type ReportRow = {
  taskId: string; arm: Arm; trialId: string; inputBytes: number | null; memory: Awaited<ReturnType<MemoryFixtureStore["read"]>> | null;
  model: Awaited<ReturnType<typeof callModel>> | null; score: ReturnType<typeof scoreMemoryAnswer> | null; error: string | null;
};

function summarize(rows: ReportRow[], phase: Phase) {
  const tasks = phase === "formal" ? formalTasks : calibrationTasks;
  const expectedFields = tasks.reduce((sum, task) => sum + task.fields.length, 0);
  const required = tasks.flatMap(task => task.fields).filter(field => field.expected !== null).length;
  return (["none", "sql10", "mem0_10"] as const).map(arm => {
    const results = rows.filter(row => row.arm === arm);
    const fields = results.flatMap(row => row.score?.fields ?? []);
    const completions = results.filter(row => row.model && row.model.error === null);
    const sumUsage = (key: keyof TokenUsage) => {
      const counts = results.map(row => row.model?.usage[key] ?? null);
      return { knownCount: counts.filter(n => n !== null).length, total: counts.some(n => n !== null) ? counts.reduce<number>((sum, n) => sum + (n ?? 0), 0) : null };
    };
    return { arm, plan: tasks.length, attempted: results.length, completions: completions.length,
      tasksPassed: results.filter(row => row.score?.taskPassed === true).length, expectedFields,
      correctFields: fields.filter(field => field.correctValue).length,
      requiredConfirmedFields: required, requiredFieldsVisible: fields.filter(field => field.currentFactVisible).length,
      supportedFields: fields.filter(field => field.expectedHasValue && field.passed).length,
      citationsSubmitted: fields.filter(field => field.citationSubmitted).length,
      staleCases: tasks.filter(task => task.fields.some(field => field.forbidden.length > 0)).length,
      staleMisuseTasks: results.filter(row => row.score?.fields.some(field => field.staleValueUsed)).length,
      retrievalMs: results.map(row => row.memory?.durationMs ?? null), modelMs: results.map(row => row.model?.elapsedMs ?? null),
      endToEndMs: results.map(row => row.memory && row.model ? row.memory.durationMs + row.model.elapsedMs : null),
      input: sumUsage("input"), output: sumUsage("output"), cacheRead: sumUsage("cacheRead"), cacheWrite: sumUsage("cacheWrite"), cost: null };
  });
}

async function run(phase: Phase, pathInput: string, expectedHash: string) {
  const path = resolve(pathInput), dir = dirname(path), batchId = dir.slice(base.length + 1);
  requireCheck(uuid.test(batchId) && resolve(base, batchId, "plan.json") === path, "fixed_private_plan_required");
  const bytes = await readFile(path);
  requireCheck(/^[a-f0-9]{64}$/.test(expectedHash) && digest(bytes) === expectedHash, "plan_hash_mismatch");
  const plan = await planFor(batchId);
  requireCheck(JSON.stringify(JSON.parse(bytes.toString("utf8"))) === JSON.stringify(plan), "plan_sources_or_inputs_changed");
  if (phase === "formal") {
    const calibration = JSON.parse(await readFile(resolve(dir, "calibration-report.json"), "utf8"));
    requireCheck(calibration.phase === "calibration" && calibration.planSHA256 === expectedHash && calibration.completed && calibration.rows.length === 3 &&
      calibration.rows.every((row: ReportRow) => row.score?.formatPassed && !row.model?.error), "calibration_shape_or_operations_unverified");
  }
  const cfg = liveConfig();
  await seal(resolve(dir, `${phase}-intent.json`), { phase, batchId, planSHA256: expectedHash, at: new Date().toISOString() });
  const report = {
    phase, batchId, planSHA256: expectedHash, startedAt: new Date().toISOString(), finishedAt: "", completed: false, error: null as string | null,
    rows: [] as ReportRow[], modelRequests: 0, expectedTrials: plan.modelRequestLimit[phase], sourceSHA256: plan.sourceSHA256,
    runtime: { provider: "dashscope", model: memoryModelSettings.model, scope: "stateless_single_provider_completion_with_actual_crm_memory_projection" },
    fixtureContactCount: 0, fixtureMemoryCount: 0, rollbackVerified: false, transport: [] as unknown[], cleanup: [] as unknown[],
    outage: null as unknown, summaries: [] as ReturnType<typeof summarize>,
  };
  const pool = new pg.Pool({ connectionString: cfg.db, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 8000 });
  pool.on("error", () => { report.error = "postgres_pool_error"; });
  const originalBindings = process.env.AI_INTEGRATION_BINDINGS;
  let client: pg.PoolClient | undefined;
  let store: MemoryFixtureStore | undefined;
  let transactionOpen = false;
  try {
    const org = await pool.query("select id,slug from organizations where id=$1 and slug=$2", [cfg.org, cfg.orgSlug]);
    requireCheck(org.rowCount === 1, "isolated_org_marker_missing");
    const { rows: bindingRows } = await pool.query("select enabled from ai_integration_settings where organization_id=$1 and provider='mem0'", [cfg.org]);
    requireCheck(bindingRows.length === 1 && bindingRows[0]?.enabled === true, "isolated_mem0_setting_not_enabled");
    const { resolveOrgLlmConfig } = await import("@/lib/agent-engine/edge/llm/credentials");
    const llm = await resolveOrgLlmConfig(pool, {}, cfg.org, { provider: "dashscope" });
    requireCheck(llm.provider === memoryModelSettings.provider && llm.defaultModel === memoryModelSettings.model &&
      llm.origemDaChave === "credencial_da_organizacao" && llm.apiKey, "isolated_model_configuration_not_frozen");
    client = await pool.connect();
    await client.query("begin"); transactionOpen = true;
    await client.query("set local lock_timeout='2s'");
    await client.query("set local idle_in_transaction_session_timeout='90s'");
    store = new MemoryFixtureStore(client, cfg.org, cfg.mem0Origin, cfg.mem0Key, batchId, plan.transportEntryLimit[phase]);
    process.env.AI_INTEGRATION_BINDINGS = store.binding;
    const tasks = phase === "calibration" ? calibrationTasks : formalTasks;
    const contacts = memoryContacts.filter(contact => tasks.some(task => task.contact === contact.key));
    await store.seed(contacts);
    report.fixtureContactCount = contacts.length;
    report.fixtureMemoryCount = contacts.reduce((sum, contact) => sum + contact.facts.length, 0);
    await store.project();
    await store.mutate(contacts);
    for (const [i, task] of tasks.entries()) {
      const fixture = store.fixtures.get(task.contact);
      requireCheck(fixture, "task_fixture_missing");
      for (const arm of orderedArms(i)) {
        const trialId = randomUUID();
        await seal(resolve(dir, `${phase}-${task.id}-${arm}-intent.json`), { trialId, taskId: task.id, arm, planSHA256: expectedHash });
        const row: ReportRow = { trialId, taskId: task.id, arm, inputBytes: null, memory: null, model: null, score: null, error: null };
        report.rows.push(row);
        try {
          row.memory = await store.read(fixture, arm);
          const input = modelInput(task, row.memory.memories);
          row.inputBytes = input.inputBytes;
          requireCheck(report.modelRequests < plan.modelRequestLimit[phase], "model_call_budget_reached");
          report.modelRequests++;
          row.model = await callModel(input.system, input.prompt, llm.apiKey);
          row.score = scoreMemoryAnswer(task, row.memory.memories, new Map(fixture.rows.map(fact => [fact.key, fact.id])), row.model.finalText);
          row.error = row.model.error;
          if (phase === "calibration") requireCheck(!row.error && row.score.formatPassed, row.error ?? "calibration_output_shape_failed");
        } catch (error) {
          row.error = safeError(error);
          throw error;
        } finally {
          await seal(resolve(dir, `${phase}-${task.id}-${arm}-result.json`), row);
        }
      }
    }
    if (phase === "formal") {
      const fixture = store.fixtures.get("selection");
      requireCheck(fixture, "outage_fixture_missing");
      const prior = report.rows.find(row => row.taskId === "M03" && row.arm === "sql10")?.memory;
      const outage = await store.read(fixture, "mem0_10", true);
      requireCheck(prior && JSON.stringify(prior.memories) === JSON.stringify(outage.memories), "outage_fallback_differs_from_sql");
      report.outage = { injectedTransportFault: true, physicalServiceStopped: false, modelCalled: false,
        providerStatus: outage.providerStatus, status: outage.status, sameTenAndOrder: true, durationMs: outage.durationMs };
    }
  } catch (error) {
    report.error = safeError(error);
  } finally {
    if (store) {
      try { await store.removeProjections(); } catch { report.error ??= "remote_cleanup_verification_required"; }
      report.transport = store.transport;
      report.cleanup = store.cleanup;
    }
    if (transactionOpen && client) {
      try {
        await client.query("rollback");
        const ids = [...(store?.fixtures.values() ?? [])].map(fixture => fixture.id);
        const contacts = await client.query("select id from contacts where organization_id=$1 and id=any($2::uuid[])", [cfg.org, ids]);
        const memories = await client.query("select id from ai_customer_memories where organization_id=$1 and contact_id=any($2::uuid[])", [cfg.org, ids]);
        report.rollbackVerified = contacts.rowCount === 0 && memories.rowCount === 0;
      } catch { report.error ??= "sql_rollback_verification_required"; }
    }
    if (originalBindings === undefined) delete process.env.AI_INTEGRATION_BINDINGS;
    else process.env.AI_INTEGRATION_BINDINGS = originalBindings;
    client?.release();
    await pool.end().catch(() => {});
    report.summaries = summarize(report.rows, phase);
    report.completed = report.error === null && report.rollbackVerified && report.rows.length === report.expectedTrials &&
      report.rows.every(row => row.error === null) && store?.cleanup.length === report.fixtureMemoryCount &&
      store.cleanup.every(item => item.outcome === "deleted");
    report.finishedAt = new Date().toISOString();
    const out = resolve(dir, `${phase}-report.json`), sha256 = await seal(out, report);
    console.info(JSON.stringify({ report: out, sha256, phase, completed: report.completed, modelRequests: report.modelRequests,
      rows: report.rows.length, rollbackVerified: report.rollbackVerified, error: report.error }));
    if (!report.completed) process.exitCode = 1;
  }
}

const args = process.argv.slice(2);
async function main() {
  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) {
    console.info("CRM-022d: --freeze (offline). --check-local (SQL rollback and Mem0 protocol). --run calibration|formal PLAN_PATH PLAN_SHA256 (bounded live phase).");
  } else if (args.length === 1 && args[0] === "--freeze") await freeze();
  else if (args.length === 1 && args[0] === "--check-local") await checkLocal();
  else if (args.length === 4 && args[0] === "--run" && (args[1] === "calibration" || args[1] === "formal")) await run(args[1], args[2]!, args[3]!);
  else requireCheck(false, "explicit_memory_evaluation_command_required");
}

main().catch(error => { console.error(JSON.stringify({ error: safeError(error) })); process.exitCode = 1; });
