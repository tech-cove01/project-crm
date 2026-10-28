import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadLocalConfig } from "./local-crm-config.mjs";
import pg from "pg";

export async function probeHttp(url, { fetchImpl = fetch, timeout = 5000 } = {}) {
  try {
    const response = await fetchImpl(url, {
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
    });
    const json = await response.json().catch(() => null);
    return { reachable: true, httpStatus: response.status, ok: response.ok, json };
  } catch {
    return { reachable: false, httpStatus: null, ok: false, json: null };
  }
}

export async function queueStatus(
  config,
  { poolFactory = (options) => new pg.Pool(options) } = {},
) {
  const pool = poolFactory({
    connectionString: config.env.SUPABASE_DB_URL,
    max: 1,
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
    statement_timeout: 5000,
  });
  let connectionFailed = false;
  const onError = () => {
    connectionFailed = true;
  };
  pool.on("connect", (client) => client.on("error", onError));
  pool.on("error", onError);
  const unavailable = () => ({
    ok: false,
    error: "crm_database_unavailable",
    jobQueue: null,
    integration: null,
  });
  let result;
  try {
    const [jobs, integration] = await Promise.all([
      pool.query(
        "select status,count(*)::int as n from job_queue where status in ('pending','running','dead') group by status",
      ),
      pool.query(
        "select status,count(*)::int as n from event_log where event_type in ('ai_integration.mem0_sync','ai_integration.langfuse_export') group by status",
      ),
    ]);
    const counts = (rows, states) =>
      Object.fromEntries(
        states.map((state) => [state, rows.find((row) => row.status === state)?.n ?? 0]),
      );
    result = {
      ok: true,
      jobQueue: counts(jobs.rows, ["pending", "running", "dead"]),
      integration: counts(integration.rows, ["pending", "processing", "done", "dead"]),
    };
  } catch {
    result = unavailable();
  } finally {
    try {
      await pool.end();
    } catch {
      connectionFailed = true;
    }
  }
  return connectionFailed ? unavailable() : result;
}

export async function collectStatus(config, { probe = probeHttp, queues = queueStatus } = {}) {
  const [webProbe, workerProbe, queue, integrationProbes] = await Promise.all([
    probe(`${config.appUrl}/api/v1/health`),
    probe(`${config.workerUrl}/healthz`),
    queues(config),
    Promise.all(
      config.bindings.map(async (binding) => {
        const origin = new URL(binding.base_url).origin;
        const path = { mem0: "/docs", weknora: "/health", langfuse: "/api/public/health" }[
          binding.provider
        ];
        const result = await probe(origin + path);
        return {
          organizationId: binding.organization_id,
          provider: binding.provider,
          origin,
          probePath: path,
          reachable: result.reachable,
          httpStatus: result.httpStatus,
          endpointOk: result.ok,
          authenticatedAccessVerified: false,
        };
      }),
    ),
  ]);
  return {
    checkedAt: new Date().toISOString(),
    web: {
      origin: config.appUrl,
      reachable: webProbe.reachable,
      httpStatus: webProbe.httpStatus,
      reportedStatus:
        typeof webProbe.json?.data?.status === "string" ? webProbe.json.data.status : null,
    },
    worker: {
      origin: config.workerUrl,
      reachable: workerProbe.reachable,
      httpStatus: workerProbe.httpStatus,
      db: workerProbe.json?.db === "ok" ? "ok" : "unavailable",
      eventLogDrainLoaded: workerProbe.json?.event_log_drain?.carregado === true,
      uptimeSeconds:
        typeof workerProbe.json?.uptime_s === "number" ? workerProbe.json.uptime_s : null,
    },
    queues: queue,
    integrations: integrationProbes,
    bindingsConfigured: config.bindings.length,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await collectStatus(loadLocalConfig()), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ error: error.code ?? "local_status_failed" }));
    process.exitCode = 1;
  }
}
