import { fork } from "node:child_process";
import { appendFileSync, createWriteStream, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { finished as streamFinished } from "node:stream/promises";
import { managedDirectory, releaseStartLock } from "./local-crm.mjs";

const scripts = dirname(fileURLToPath(import.meta.url));

export function secretRedactor(env) {
  const secrets = new Set();
  const sensitive = /secret|password|token|key|authorization|binding|dsn|db_url|database_url/i;
  const add = value => { if (typeof value === "string" && value.length >= 4) secrets.add(value); };
  const visit = value => {
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (sensitive.test(key)) add(item);
      if (typeof item === "object") visit(item);
    }
  };
  for (const [key, value] of Object.entries(env)) {
    if (!sensitive.test(key)) continue;
    add(value);
    try { const url = new URL(value); add(decodeURIComponent(url.password)); } catch { /* Not a URL. */ }
    try { visit(JSON.parse(value)); } catch { /* Not JSON. */ }
  }
  const values = [...secrets].sort((a, b) => b.length - a.length);
  return text => values.reduce((result, value) => result.split(value).join("[REDACTED]"), text);
}

function copyLog(source, path, redact) {
  const output = createWriteStream(path, { flags: "a", mode: 0o600 });
  const flushed = streamFinished(output).then(() => true, () => false);
  // Redact complete lines so a credential split across stream chunks is covered.
  let pending = "";
  source.setEncoding("utf8");
  source.on("data", chunk => {
    pending += chunk;
    const end = pending.lastIndexOf("\n");
    if (end >= 0) { output.write(redact(pending.slice(0, end + 1))); pending = pending.slice(end + 1); }
    // A malformed infinite line is discarded, never flushed before redaction.
    if (pending.length > 1024 * 1024) pending = "[overlong log line omitted]\n";
  });
  const finish = () => {
    if (output.writableEnded) return;
    if (pending) output.write(redact(pending));
    pending = "";
    output.end();
  };
  source.once("end", finish);
  source.once("error", finish);
  return async () => { source.removeAllListeners("data"); source.destroy(); finish(); return flushed; };
}

export function spawnLocalService(role, config) {
  return fork(join(scripts, "local-crm-service.mjs"), [role], {
    cwd: config.root, env: config.env, windowsHide: true,
    execArgv: role === "web" ? [] : ["--import", "tsx"],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
}

/** Owns only ChildProcess handles created during this session; never resolves PIDs to kill. */
export async function runSupervisor(config, {
  sessionId, token, spawnService = spawnLocalService, startupMs = 180_000,
  shutdownMs = 40_000, forceWaitMs = 3_000, probe = fetch, processHandlers = true,
} = {}) {
  if (!/^[a-f0-9-]{36}$/.test(sessionId) || !/^[a-f0-9]{64}$/.test(token)) throw new Error("invalid_managed_identity");
  const directory = managedDirectory(config);
  const session = join(directory, sessionId);
  const lock = JSON.parse(readFileSync(join(directory, "active.lock"), "utf8"));
  if (lock.sessionId !== sessionId || lock.token !== token) throw new Error("managed_lock_mismatch");
  mkdirSync(session, { recursive: true });
  const redact = secretRedactor(config.env);
  const state = { version: 1, sessionId, token, supervisorPid: process.pid, phase: "starting", startedAt: new Date().toISOString(), heartbeatAt: null, services: {} };
  const services = new Map();
  const aborted = new AbortController();
  let stopping = null;
  let failed = false;
  let finished;
  const completion = new Promise(accept => { finished = accept; });
  const event = (type, fields = {}) => appendFileSync(join(session, "events.ndjson"), JSON.stringify({ at: new Date().toISOString(), type, ...fields }) + "\n", { mode: 0o600 });
  const save = () => {
    state.heartbeatAt = new Date().toISOString();
    const temporary = join(directory, `state-${sessionId}.tmp`);
    writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(temporary, join(directory, "state.json"));
    writeFileSync(join(session, "state.json"), JSON.stringify(state, null, 2), { mode: 0o600 });
  };
  const alive = () => [...services.values()].filter(item => !item.exited);
  const stop = reason => {
    if (stopping) return stopping;
    stopping = (async () => {
      aborted.abort();
      state.phase = "stopping";
      state.stopReason = reason;
      event("stop_requested", { reason });
      save();
      const deadline = Date.now() + shutdownMs;
      // Drain and Worker may still call Web while finishing; keep their dependency
      // alive until they exit. Every stage consumes the same total grace budget.
      for (const role of ["drain", "worker", "web"]) {
        const item = services.get(role);
        if (!item || item.exited) continue;
        event("service_stop_requested", { service: role });
        if (item.child.connected) item.child.send({ type: "stop" }, () => {});
        while (!item.exited && Date.now() < deadline) await sleep(50);
      }
      for (const item of alive()) {
        item.record.forced = true;
        event("service_force_requested", { service: item.role });
        // This is the ChildProcess handle held since fork, never a PID from disk.
        item.child.kill("SIGKILL");
      }
      const forceDeadline = Date.now() + forceWaitMs;
      while (alive().length && Date.now() < forceDeadline) await sleep(50);
      if (alive().length) {
        failed = true;
        event("service_exit_unconfirmed", { services: alive().map(item => item.role) });
      }
      const logDeadline = Date.now() + 500;
      while ([...services.values()].some(item => !item.closed) && Date.now() < logDeadline) await sleep(20);
      for (const item of services.values()) {
        if (!item.closed) event("service_stdio_close_unconfirmed", { service: item.role });
        if ((await Promise.all(item.finishLogs.map(finish => finish()))).some(ok => !ok)) {
          failed = true;
          event("service_log_write_failed", { service: item.role });
        }
        if (item.child.connected) item.child.disconnect();
        item.child.unref();
      }
      state.phase = failed ? "failed" : "stopped";
      state.stoppedAt = new Date().toISOString();
      event("session_finished", { phase: state.phase });
      save();
      if (!alive().length) releaseStartLock(config, sessionId, token);
      finished();
    })();
    return stopping;
  };
  const heartbeat = setInterval(save, 1000);
  const controls = setInterval(() => {
    let request;
    const path = join(session, "stop.json");
    try { request = JSON.parse(readFileSync(path, "utf8")); } catch { return; }
    if (request?.token === token) void stop("operator");
    else event("control_request_rejected");
    rmSync(path, { force: true });
  }, 200);
  const onSignal = () => { void stop("supervisor_signal"); };
  if (processHandlers) {
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
  }
  const startupDeadline = Date.now() + startupMs;
  const waitUntil = async predicate => {
    while (!aborted.signal.aborted && Date.now() < startupDeadline) {
      if (await predicate()) return;
      await sleep(150);
    }
    throw new Error("managed_startup_incomplete");
  };
  const healthy = async role => {
    try {
      const response = await probe(role === "web" ? `${config.appUrl}/api/v1/health` : `${config.workerUrl}/healthz`, {
        redirect: "error", signal: AbortSignal.any([aborted.signal, AbortSignal.timeout(5000)]),
      });
      if (!response.ok) return false;
      if (role === "web") return true;
      const health = await response.json();
      return health.db === "ok" && health.event_log_drain?.carregado === true;
    } catch { return false; }
  };
  event("supervisor_started");
  save();
  try {
    for (const role of ["web", "worker", "drain"]) {
      if (aborted.signal.aborted) break;
      const child = spawnService(role, config);
      const record = { pid: child.pid ?? null, phase: "starting", startedAt: new Date().toISOString(), forced: false, stdout: `${sessionId}/${role}.stdout.log`, stderr: `${sessionId}/${role}.stderr.log` };
      state.services[role] = record;
      const item = { role, child, record, loaded: false, exited: false, closed: false, finishLogs: [] };
      services.set(role, item);
      item.finishLogs = [copyLog(child.stdout, join(session, `${role}.stdout.log`), redact), copyLog(child.stderr, join(session, `${role}.stderr.log`), redact)];
      child.on("message", message => { if (message?.type === "loaded" && message.role === role) item.loaded = true; });
      child.once("close", () => { item.closed = true; });
      child.once("error", () => {
        item.exited = true;
        record.phase = "failed";
        record.exitedAt = new Date().toISOString();
        event("service_spawn_failed", { service: role });
        failed = true;
        void stop("service_spawn_failed");
      });
      child.once("exit", (code, signal) => {
        item.exited = true;
        Object.assign(record, { phase: stopping ? "stopped" : "failed", exitedAt: new Date().toISOString(), exitCode: code, signal, graceful: Boolean(stopping) && !record.forced && (code === 0 || (role === "web" && code === 143)) });
        event("service_exited", { service: role, exitCode: code, signal, expected: Boolean(stopping), forced: record.forced, graceful: record.graceful });
        save();
        if (!stopping) { failed = true; void stop("unexpected_service_exit"); }
      });
      event("service_started", { service: role, pid: record.pid });
      save();
      child.send({ type: "initialize", root: config.root, appUrl: config.appUrl, graceMs: shutdownMs + 1000 }, error => {
        if (error && !stopping) { failed = true; void stop("service_initialize_failed"); }
      });
      await waitUntil(() => item.loaded && !item.exited);
      if (role !== "drain") await waitUntil(() => healthy(role));
      record.phase = "running";
      event("service_ready", { service: role });
      save();
    }
    if (!stopping) { state.phase = "running"; event("session_running"); save(); }
  } catch {
    if (!stopping) { failed = true; event("startup_failed"); void stop("startup_failed"); }
  }
  await completion;
  clearInterval(heartbeat);
  clearInterval(controls);
  if (processHandlers) {
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
  }
  return state;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const timer = setTimeout(() => process.exit(1), 10_000);
  process.once("message", async message => {
    if (message?.type !== "initialize") return;
    clearTimeout(timer);
    try {
      const state = await runSupervisor({ root: message.root, env: process.env, appUrl: message.appUrl, workerUrl: message.workerUrl }, message);
      process.exit(state.phase === "failed" ? 1 : 0);
    } catch { console.error("local_crm_supervisor_failed"); process.exit(1); }
  });
}
