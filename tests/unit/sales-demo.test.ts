// @vitest-environment node
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";

const demo = await import(pathToFileURL(resolve("scripts/sales-demo.mjs")).href);
const roots: string[] = [];
const ids = Object.fromEntries(["org", "lead", "pipeline", "oldStage", "newStage", "contact", "memory", "source", "kb", "inspect", "approval", "inspectVersion", "approvalVersion", "confirmer"].map(key => [key, randomUUID()])) as Record<string, string>;
function fixture() {
  const parent = resolve(".local"); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "crm014-safety-")); roots.push(root);
  mkdirSync(join(root, ".local"));
  const put = (name: string, value: unknown) => writeFileSync(join(root, ".local", name), JSON.stringify(value));
  put("approval-synthetic-case.json", { leadId: ids.lead, pipelineId: ids.pipeline, oldStage: ids.oldStage, newStage: ids.newStage, ignoredSecret: "do-not-copy-fixture-extra" });
  put("mem0-crm-case.json", { contactId: ids.contact, memoryId: ids.memory });
  put("weknora-crm-case.json", { sourceId: ids.source, kb: ids.kb });
  const config = { root, appUrl: "http://localhost:3000", env: { SUPABASE_DB_URL: "postgresql://fixture-password@127.0.0.1:55422/postgres" }, bindings: ["mem0", "weknora", "langfuse"].map(provider => ({ organization_id: ids.org, provider, visibility: "organization", knowledge_base_ids: [ids.kb] })) };
  const rows: Record<string, unknown[]> = {
    crm_leads: [{ id: ids.lead, organization_id: ids.org, pipeline_id: ids.pipeline, stage_id: ids.oldStage, contact_id: null, title: "合成商机：本地审批验证", tags: ["synthetic-approval-test"], updated_at: "2026-10-28T01:00:00.000Z" }],
    contacts: [{ id: ids.contact, source_metadata: { synthetic: true, purpose: "initial-local-acceptance" }, is_anonymized: false, is_merged_into: null }],
    ai_customer_memories: [{ id: ids.memory, contact_id: ids.contact, confirmed_by: ids.confirmer, sync_state: "synced", write_outcome: "confirmed", deleted_at: null, body: "NEVER_COPY_ORIGINAL_CUSTOMER_FACT" }],
    ai_knowledge_sources: [{ id: ids.source, name: "本机合成产品 Wiki", source_type: "wiki", source_metadata: { provider: "weknora", knowledge_base_id: ids.kb, visibility: "organization" }, is_active: true, status: "ready", updated_at: "2026-10-28T01:00:00.000Z" }],
    ai_integration_settings: ["mem0", "weknora", "langfuse"].map(provider => ({ provider, enabled: true })),
    crm_pipelines: [{ id: ids.pipeline, is_archived: false }],
    crm_stages: [ids.oldStage, ids.newStage].map(id => ({ id, is_archived: false, is_won: false, is_lost: false })),
    organizations: [{ settings: { llm: { provider: "dashscope", default_model: "qwen3.8-flash" } } }],
    ai_models: [{ supports_tools: true, deprecated_at: null }],
    ai_agents: [
      { id: ids.inspect, version_id: ids.inspectVersion, builtin_key: "crm_intelligence", is_active: true, paused_at: null, archived_at: null, provider: "dashscope", model: "qwen3.8-flash", tool_ids: ["crm_get_contact", "crm_search_knowledge"], knowledge_source_ids: [ids.source] },
      { id: ids.approval, version_id: ids.approvalVersion, builtin_key: "sales_operations", is_active: true, paused_at: null, archived_at: null, provider: "dashscope", model: "qwen3.8-flash", tool_ids: ["crm_get_lead", "crm_move_lead_stage"], knowledge_source_ids: [] },
    ],
    ai_workbench_runs: [{ count: 0 }],
  };
  const queries: { sql: string; args: unknown[] }[] = [];
  let ended = false;
  const client = Object.assign(new EventEmitter(), { query: async (sql: string, args: unknown[] = []) => {
    queries.push({ sql, args });
    if (/^(begin|commit|rollback)\b/i.test(sql)) return { rows: [] };
    if (!/^select\b/i.test(sql)) throw new Error("fixture_business_write_attempt");
    const table = /\bfrom\s+([a-z_]+)/i.exec(sql)?.[1];
    if (!table || !rows[table]) throw new Error("fixture_unknown_read");
    return { rows: rows[table] };
  }, release: () => {} });
  const pool = Object.assign(new EventEmitter(), { connect: async () => client, end: async () => { ended = true; } });
  const createPool = () => pool;
  return { root, config, rows, queries, client, pool, createPool, ended: () => ended };
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(".local") + sep)) throw new Error("fixture_cleanup_outside_workspace");
    rmSync(root, { recursive: true, force: true });
  }
});

describe("read-only sales demonstration preparation", () => {
  it("defaults to help without requiring config, database or fixture files", () => {
    const f = fixture(); const scripts = join(f.root, "scripts"); mkdirSync(scripts);
    copyFileSync(resolve("scripts/sales-demo.mjs"), join(scripts, "sales-demo.mjs"));
    const result = spawnSync(process.execPath, [join(scripts, "sales-demo.mjs")], { encoding: "utf8", windowsHide: true });
    expect(result.status).toBe(0); expect(JSON.parse(result.stdout).usage).toContain("prepare");
    expect(existsSync(join(f.root, ".local", "sales-demo"))).toBe(false);
  });

  it("writes only local prompts from validated IDs inside a read-only SQL transaction", async () => {
    const f = fixture();
    const result = await demo.prepareDemo(f.config, { createPool: f.createPool });
    const session = JSON.parse(readFileSync(result.sessionPath, "utf8"));
    expect(f.queries[0]!.sql).toBe("begin isolation level repeatable read read only");
    expect(f.queries.at(-1)!.sql).toBe("commit");
    expect(f.ended()).toBe(true);
    expect(session.version).toBe(1);
    expect(Object.keys(session.runs)).toEqual(["inspect", "approval"]);
    expect(session.before).toEqual({ stageId: ids.oldStage, updatedAt: "2026-10-28T01:00:00.000Z" });
    expect(session.targetStageId).toBe(ids.newStage);
    expect(session.runs.inspect.mode).toBe("inspect"); expect(session.runs.approval.mode).toBe("act");
    expect(Object.keys(session.runs.inspect).sort()).toEqual(["agentId", "collaboration", "mode", "scope", "task"]);
    expect(session.runs.inspect.task).toContain("quantidade 参数为 5");
    expect(session.runs.approval.scope).toEqual({ leadId: ids.lead, pipelineId: ids.pipeline });
    expect(session.runs.approval.task).toContain("crm_move_lead_stage");
    expect(JSON.stringify(session)).not.toMatch(/NEVER_COPY_ORIGINAL_CUSTOMER_FACT|fixture-password|do-not-copy-fixture-extra/);
    expect(JSON.stringify(result)).not.toContain(session.runs.inspect.task);
    for (const query of f.queries.filter(query => /from (crm_leads|contacts|ai_customer_memories|ai_knowledge_sources|crm_pipelines|crm_stages|ai_agents|ai_workbench_runs)\b/.test(query.sql))) expect(query.args[0]).toBe(ids.org);
  });

  it("prepares three separate strict API bodies with bounded read-only contact and knowledge tasks", async () => {
    const f = fixture();
    const result = await demo.prepareDemo(f.config, { createPool: f.createPool, split: true });
    const session = JSON.parse(readFileSync(result.sessionPath, "utf8"));
    expect(session.version).toBe(2);
    expect(Object.keys(session.runs)).toEqual(["contact", "knowledge", "approval"]);
    expect(Object.keys(session.agents)).toEqual(["inspect", "approval"]);
    for (const run of Object.values(session.runs) as Record<string, unknown>[]) {
      expect(Object.keys(run).sort()).toEqual(["agentId", "collaboration", "mode", "scope", "task"]);
      expect(run.collaboration).toBe("disabled");
    }
    expect(session.runs.contact).toMatchObject({ agentId: ids.inspect, mode: "inspect", scope: { contactId: ids.contact } });
    expect(session.runs.knowledge).toMatchObject({ agentId: ids.inspect, mode: "inspect", scope: {} });
    expect(session.runs.approval).toMatchObject({ agentId: ids.approval, mode: "act", scope: { leadId: ids.lead, pipelineId: ids.pipeline } });
    expect([...new Set(session.runs.contact.task.match(/crm_[a-z_]+/g))]).toEqual(["crm_get_contact"]);
    expect(session.runs.contact.task).toContain("body 原文、id 和 confirmed");
    expect(session.runs.contact.task).toContain("不评判未来触达的渠道同意，也不建议外联");
    expect([...new Set(session.runs.knowledge.task.match(/crm_[a-z_]+/g))]).toEqual(["crm_search_knowledge"]);
    expect(session.runs.knowledge.task).toContain("pergunta 参数精确使用“产品”两个字，quantidade 参数为 5");
    expect(session.runs.knowledge.task).toContain("不要求推演产品信息或补齐全知识库目录");
    expect(session.runs.approval.task).toContain(`实际 stage_id 等于 ${ids.newStage}`);
    expect(session.runs.approval.task).toContain("批准后必须再调用 crm_get_lead");
    expect(session.runs.contact.task).toContain("真正阻止读取或核对返回事实的错误、缺口仍须如实报告");
    expect(session.runs.knowledge.task).toContain("工具真实失败或明确报告阻止本次查询的缺口时仍须如实报告");
    expect(JSON.stringify(session)).not.toMatch(/NEVER_COPY_ORIGINAL_CUSTOMER_FACT|fixture-password|do-not-copy-fixture-extra/);
    expect(JSON.stringify(result)).not.toContain(session.runs.contact.task);
    expect(f.queries[0]!.sql).toBe("begin isolation level repeatable read read only");
    expect(f.queries.at(-1)!.sql).toBe("commit");
  });

  it("requires --new to switch a legacy session to split mode and preserves the original snapshot", async () => {
    const f = fixture();
    const first = await demo.prepareDemo(f.config, { createPool: f.createPool });
    const original = readFileSync(first.sessionPath, "utf8");
    await expect(demo.prepareDemo(f.config, { createPool: f.createPool, split: true })).rejects.toThrow("sales_demo_session_exists");
    const second = await demo.prepareDemo(f.config, { createPool: f.createPool, split: true, newSession: true });
    expect(first.sessionPath).not.toBe(second.sessionPath);
    expect(readFileSync(first.sessionPath, "utf8")).toBe(original);
    expect(JSON.parse(original).version).toBe(1);
    expect(JSON.parse(readFileSync(second.sessionPath, "utf8")).version).toBe(2);
    const pointer = JSON.parse(readFileSync(join(f.root, ".local", "sales-demo", "current.json"), "utf8"));
    expect(pointer).toEqual({ version: 1, sessionId: second.sessionId, sessionPath: second.sessionPath });
  });

  it.each([
    [["--split"], "sales_demo_fixture_config_requested"],
    [["--new", "--split"], "sales_demo_fixture_config_requested"],
    [["--split", "--new"], "sales_demo_fixture_config_requested"],
    [["--split", "--split"], "sales_demo_usage_invalid"],
    [["--new", "--new"], "sales_demo_usage_invalid"],
    [["--split", "--unknown"], "sales_demo_usage_invalid"],
  ])("validates CLI flags %j before any database access", (flags, error) => {
    const f = fixture(); const scripts = join(f.root, "scripts"); mkdirSync(scripts);
    copyFileSync(resolve("scripts/sales-demo.mjs"), join(scripts, "sales-demo.mjs"));
    writeFileSync(join(scripts, "local-crm-config.mjs"), 'export function loadLocalConfig() { throw Object.assign(new Error("fixture"), { code: "sales_demo_fixture_config_requested" }); }');
    const result = spawnSync(process.execPath, [join(scripts, "sales-demo.mjs"), "prepare", ...flags], { encoding: "utf8", windowsHide: true });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toEqual({ error });
    expect(existsSync(join(f.root, ".local", "sales-demo"))).toBe(false);
  });

  it("refuses an existing session unless --new semantics preserve its prior snapshot", async () => {
    const f = fixture(); const first = await demo.prepareDemo(f.config, { createPool: f.createPool });
    const original = readFileSync(first.sessionPath, "utf8");
    await expect(demo.prepareDemo(f.config, { createPool: f.createPool })).rejects.toThrow("sales_demo_session_exists");
    const second = await demo.prepareDemo(f.config, { createPool: f.createPool, newSession: true });
    expect(first.sessionPath).not.toBe(second.sessionPath);
    expect(readFileSync(first.sessionPath, "utf8")).toBe(original);
    expect(JSON.parse(readFileSync(join(f.root, ".local", "sales-demo", "current.json"), "utf8")).sessionId).toBe(second.sessionId);
  });

  it("requires one trusted organization before reading any fixture-selected business row", async () => {
    const f = fixture();
    f.config.bindings[0]!.organization_id = randomUUID();
    await expect(demo.prepareDemo(f.config, { createPool: f.createPool })).rejects.toThrow("sales_demo_single_bound_organization_required");
    expect(f.queries.some(query => /^select\b/i.test(query.sql))).toBe(false);
  });

  it("handles an asynchronous client disconnect without writing a session or stranding its lock", async () => {
    const f = fixture(); const query = f.client.query;
    f.client.query = async (sql, args = []) => {
      if (sql.includes("from ai_customer_memories")) f.client.emit("error", new Error("fixture_private_disconnect_detail"));
      return query(sql, args);
    };
    await expect(demo.prepareDemo(f.config, { createPool: f.createPool })).rejects.toThrow("sales_demo_connection_failed");
    expect(existsSync(join(f.root, ".local", "sales-demo", "current.json"))).toBe(false);
    expect(existsSync(join(f.root, ".local", "sales-demo", "prepare.lock"))).toBe(false);
    expect(f.ended()).toBe(true);
  });

  it.each(["release", "end"])("releases its prepare lock even when database %s fails", async method => {
    const f = fixture();
    if (method === "release") f.client.release = () => { throw new Error("fixture_release_failed"); };
    else f.pool.end = async () => { throw new Error("fixture_end_failed"); };
    await expect(demo.prepareDemo(f.config, { createPool: f.createPool })).rejects.toThrow(`fixture_${method}_failed`);
    expect(existsSync(join(f.root, ".local", "sales-demo", "prepare.lock"))).toBe(false);
    if (method === "release") expect(f.ended()).toBe(true);
  });

  it("does not remove a replacement lock during a failed database cleanup", async () => {
    const f = fixture();
    f.pool.end = async () => {
      writeFileSync(join(f.root, ".local", "sales-demo", "prepare.lock"), JSON.stringify({ lockId: "foreign-owner" }));
      throw new Error("fixture_end_failed");
    };
    await expect(demo.prepareDemo(f.config, { createPool: f.createPool })).rejects.toThrow("fixture_end_failed");
    expect(JSON.parse(readFileSync(join(f.root, ".local", "sales-demo", "prepare.lock"), "utf8")).lockId).toBe("foreign-owner");
  });

  it.each([
    ["a real or anonymized contact", "contacts", (f: ReturnType<typeof fixture>) => { f.rows.contacts = [{ source_metadata: { synthetic: false } }]; }, "synthetic_contact"],
    ["unconfirmed memory", "memory", (f: ReturnType<typeof fixture>) => { f.rows.ai_customer_memories = []; }, "confirmed_synced"],
    ["an unauthorized or different-org source", "source", (f: ReturnType<typeof fixture>) => { f.rows.ai_knowledge_sources = []; }, "authorized_synthetic_wiki"],
    ["a completed sales stage", "stages", (f: ReturnType<typeof fixture>) => { (f.rows.crm_stages![0] as { is_won: boolean }).is_won = true; }, "two_open_stages"],
    ["a missing agent source grant", "grant", (f: ReturnType<typeof fixture>) => { (f.rows.ai_agents![0] as { knowledge_source_ids: string[] }).knowledge_source_ids = []; }, "wiki_not_authorized"],
    ["an old unfinished run or unresolved proposal", "run", (f: ReturnType<typeof fixture>) => { f.rows.ai_workbench_runs = [{ count: 1 }]; }, "unfinished_run"],
  ])("refuses %s without saving a session", async (_name, _key, change, code) => {
    const f = fixture(); change(f);
    await expect(demo.prepareDemo(f.config, { createPool: f.createPool, split: true })).rejects.toThrow(String(code));
    expect(existsSync(join(f.root, ".local", "sales-demo", "current.json"))).toBe(false);
    expect(existsSync(join(f.root, ".local", "sales-demo", "prepare.lock"))).toBe(false);
    expect(f.queries.at(-1)!.sql).toBe("rollback");
  });
});
