/** Read persisted telemetry only; no model, Judge, Run creation, or outbox mutation. */
import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { z } from "zod";
import { loadLocalConfig, ROOT } from "./local-crm-config.mjs";
import { readLangfuseObservations } from "../lib/ai/integrations/langfuse-readback";
import type { ExpectedLangfuseSpan } from "../lib/ai/integrations/langfuse-readback";
import type { IntegrationBinding } from "../lib/ai/integrations/config";

const safeCode = (error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  return /^(langfuse_readback_[a-z_]+|integration_http_\d{3})$/.test(message)
    ? message
    : "langfuse_readback_failed";
};
async function main() {
  const args = process.argv.slice(2);
  if (!args.length || (args.length === 1 && args[0] === "--help")) {
    console.info(
      "只读回查：node --import tsx scripts/readback-langfuse.ts <organization UUID> <Run UUID> [Run UUID ...]。报告仅写入 .local/langfuse-readbacks，不触发导出或模型。",
    );
    return;
  }
  const ids = z.array(z.string().uuid()).min(2).max(21).safeParse(args);
  if (!ids.success || new Set(args).size !== args.length)
    throw new Error("langfuse_readback_arguments_invalid");
  const [organizationId, ...runIds] = ids.data;
  const config = loadLocalConfig();
  const binding = config.bindings.find(
    (value: IntegrationBinding) =>
      value.organization_id === organizationId && value.provider === "langfuse",
  ) as IntegrationBinding | undefined;
  if (!binding) throw new Error("langfuse_readback_binding_missing");
  const pool = new pg.Pool({
    connectionString: config.env.SUPABASE_DB_URL,
    options: "-c default_transaction_read_only=on",
    max: 1,
    connectionTimeoutMillis: 5000,
    query_timeout: 8000,
    statement_timeout: 8000,
  });
  let disconnected = false;
  pool.on("error", () => {
    disconnected = true;
  });
  const report: {
    version: number;
    checkedAt: string;
    organizationId: string;
    boundaries: object;
    runs: Array<{ complete: boolean; [key: string]: unknown }>;
  } = {
    version: 1,
    checkedAt: new Date().toISOString(),
    organizationId: organizationId!,
    boundaries: {
      sqlReadOnly: true,
      remoteMethods: ["GET"],
      modelRequested: false,
      judgeRequested: false,
      outboxChanged: false,
    },
    runs: [],
  };
  let client: pg.PoolClient | undefined;
  try {
    client = await pool.connect();
    client.on("error", () => {
      disconnected = true;
    });
    await client.query("BEGIN READ ONLY");
    for (const runId of runIds) {
      const owned = await client.query(
        "select id from ai_workbench_runs where organization_id=$1 and id=$2",
        [organizationId, runId],
      );
      if (!owned.rows.length) throw new Error("langfuse_readback_owned_run_required");
      const { rows } = await client.query<{
        id: string;
        status: string;
        consumed: boolean;
        spans: ExpectedLangfuseSpan[] | null;
        score_count: number;
      }>(
        `select id,status,coalesce(consumed_by @> array['ai_integration.langfuse_v1']::text[],false) consumed,
         case when payload->>'kind'='spans' then payload->'spans' else null end spans,
         case when payload->>'kind'='scores' then jsonb_array_length(payload->'scores') else 0 end score_count
         from event_log where organization_id=$1 and entity_id=$2 and event_type='ai_integration.langfuse_export'
         order by created_at,id`,
        [organizationId, runId],
      );
      const expected = rows.flatMap((row) => row.spans ?? []);
      const projection = {
        runId,
        outbox: rows.map(({ id, status, consumed, score_count }) => ({
          id,
          status,
          consumed,
          scoreCount: score_count,
        })),
        scoreExportCount: rows.reduce((sum, row) => sum + row.score_count, 0),
      };
      try {
        const readback = await readLangfuseObservations(binding, expected);
        report.runs.push({
          ...projection,
          ...readback,
          complete: readback.complete && rows.every((row) => row.status === "done" && row.consumed),
        });
      } catch (error) {
        report.runs.push({ ...projection, complete: false, error: safeCode(error) });
      }
    }
    if (disconnected) throw new Error("langfuse_readback_database_disconnected");
    await client.query("ROLLBACK");
  } finally {
    try {
      client?.release();
    } finally {
      await pool.end();
    }
  }
  const directory = resolve(ROOT, ".local/langfuse-readbacks");
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, `readback-${Date.now()}-${randomUUID()}.json`);
  const text = JSON.stringify(report, null, 2) + "\n";
  await writeFile(path, text, { flag: "wx", mode: 0o600 });
  const complete = report.runs.length === runIds.length && report.runs.every((run) => run.complete);
  if (!complete) process.exitCode = 1;
  console.info(
    JSON.stringify({
      reportPath: path,
      sha256: createHash("sha256").update(text).digest("hex"),
      complete,
      runs: report.runs,
    }),
  );
}
main().catch((error: unknown) => {
  console.error(JSON.stringify({ error: safeCode(error) }));
  process.exitCode = 1;
});
