import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installServiceControl } from "../local-crm-service.mjs";

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const resumeSelect = "id,agent_id,mission_id,task,mode,status,runtime_state,scope,budget,final_text";
const safetyMessage = "crm022_reliability_worker_preflight_failed";

export function isResumeRead(input, init, target) {
  const raw = input instanceof Request ? input.url : input;
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  if (String(method).toUpperCase() !== "GET") return false;
  let url;
  try { url = new URL(raw); } catch { return false; }
  return url.origin === target.origin && url.pathname === "/rest/v1/ai_workbench_runs" &&
    url.searchParams.getAll("organization_id").length === 1 &&
    url.searchParams.get("organization_id") === `eq.${target.organizationId}` &&
    url.searchParams.getAll("id").length === 1 &&
    url.searchParams.get("id") === `eq.${target.runId}` &&
    url.searchParams.get("select") === resumeSelect;
}

export function injectOneResumeRead(fetchImpl, target, notify) {
  let injected = false;
  return async (input, init) => {
    if (injected || !isResumeRead(input, init, target)) return fetchImpl(input, init);
    injected = true;
    notify({ type: "crm022-fault-observed", mode: target.mode, runId: target.runId, pid: process.pid });
    if (target.mode === "retry") {
      return new Response('{"code":"crm022_controlled_resume_read_failure"}', {
        // PostgREST retries 503/520 GETs internally. Use its non-retried 500
        // response once so the real queue sees the isolated transient failure.
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    // The parent verifies this child's real job lease before terminating its own child.
    // Parent exit or an unobserved pause must not leave a permanently hung worker.
    return new Promise((_, reject) => {
      let timer;
      const lost = () => {
        clearTimeout(timer);
        process.removeListener("disconnect", lost);
        reject(new Error("crm022_controlled_resume_pause_ended"));
      };
      timer = setTimeout(lost, 60_000);
      timer.unref();
      process.once("disconnect", lost);
    });
  };
}

function isolatedOrigin(raw) {
  const url = new URL(raw);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      !url.port || ["3000", "55421"].includes(url.port) || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) throw new Error(safetyMessage);
  return url.origin;
}

async function main() {
  const [mode, organizationId, runId, apiOrigin, pgPort, database] = process.argv.slice(2);
  const endpoint = new URL(process.env.SUPABASE_DB_URL ?? "");
  if (!process.send || !["retry", "interrupt", "normal"].includes(mode) || !uuid.test(organizationId ?? "") ||
      !uuid.test(runId ?? "") || isolatedOrigin(apiOrigin) !== isolatedOrigin(process.env.NEXT_PUBLIC_SUPABASE_URL) ||
      !["postgresql:", "postgres:"].includes(endpoint.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
      endpoint.port !== pgPort || !endpoint.port || ["5432", "55422"].includes(endpoint.port) ||
      endpoint.pathname !== `/${database}` || endpoint.search || endpoint.hash ||
      process.env.SENTRY_DSN !== "off" || process.env.NODE_ENV !== "development") {
    throw new Error(safetyMessage);
  }
  if (mode !== "normal") {
    globalThis.fetch = injectOneResumeRead(globalThis.fetch, { origin: apiOrigin, organizationId, runId, mode }, (event) => {
      if (process.connected) process.send(event);
    });
  }
  installServiceControl({ graceMs: 45_000 });
  await import("../../workers/agent-worker/main.ts");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error(safetyMessage);
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  });
}
