import { fork } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const scripts = dirname(fileURLToPath(import.meta.url));
const sessionPattern = /^[a-f0-9-]{36}$/;
export const managedDirectory = config => join(config.root, ".local", "local-crm");

export function readManagedState(config) {
  try { return JSON.parse(readFileSync(join(managedDirectory(config), "state.json"), "utf8")); }
  catch { return null; }
}

export function publicManagedState(state) {
  if (!state) return null;
  const { token: _token, ...safe } = state;
  return { ...safe, heartbeatFresh: Number.isFinite(Date.parse(state.heartbeatAt)) && Date.now() - Date.parse(state.heartbeatAt) < 10_000 };
}

function fail(code) { throw Object.assign(new Error(code), { code }); }

export function assertIdleQueues(status) {
  const queues = status?.queues;
  if (queues?.ok !== true || !queues.jobQueue || !queues.integration) fail("crm_queue_status_unknown");
  for (const count of [queues.jobQueue.pending, queues.jobQueue.running, queues.integration.processing]) {
    if (!Number.isInteger(count) || count < 0) fail("crm_queue_status_unknown");
    if (count > 0) fail("crm_queue_active_start_refused");
  }
}

export async function assertPortsFree(config) {
  for (const origin of [config.appUrl, config.workerUrl]) {
    await new Promise((accept, reject) => {
      const server = net.createServer();
      server.once("error", () => reject(Object.assign(new Error("crm_port_in_use_start_refused"), { code: "crm_port_in_use_start_refused" })));
      server.listen({ host: "127.0.0.1", port: Number(new URL(origin).port), exclusive: true }, () => server.close(accept));
    });
  }
}

export function acquireStartLock(config, sessionId, token) {
  const directory = managedDirectory(config);
  mkdirSync(directory, { recursive: true });
  let fd;
  try { fd = openSync(join(directory, "active.lock"), "wx", 0o600); }
  catch { fail("crm_managed_lock_exists_check_status_and_session_logs"); }
  try { writeFileSync(fd, JSON.stringify({ sessionId, token, requestedAt: new Date().toISOString() })); }
  finally { closeSync(fd); }
}

export function releaseStartLock(config, sessionId, token) {
  const path = join(managedDirectory(config), "active.lock");
  try {
    const lock = JSON.parse(readFileSync(path, "utf8"));
    if (lock.sessionId === sessionId && lock.token === token) rmSync(path);
  } catch { /* A foreign or unreadable lock is never removed. */ }
}

export async function startManaged(config, { collect, timeoutMs = 200_000 } = {}) {
  const sessionId = randomUUID();
  const token = randomBytes(32).toString("hex");
  acquireStartLock(config, sessionId, token);
  let child;
  let sent = false;
  try {
    await assertPortsFree(config);
    const status = await (collect ?? (await import("./local-crm-status.mjs")).collectStatus)(config);
    assertIdleQueues(status);
    // Check again immediately before launch; Next is explicitly forbidden to retry another port.
    await assertPortsFree(config);
    const directory = join(managedDirectory(config), sessionId);
    mkdirSync(directory, { recursive: true });
    const stdout = openSync(join(directory, "supervisor.stdout.log"), "a", 0o600);
    const stderr = openSync(join(directory, "supervisor.stderr.log"), "a", 0o600);
    try {
      child = fork(join(scripts, "local-crm-supervisor.mjs"), [], {
        cwd: config.root, env: config.env, detached: true, windowsHide: true,
        execArgv: [], stdio: ["ignore", stdout, stderr, "ipc"],
      });
    } finally { closeSync(stdout); closeSync(stderr); }
    await new Promise((accept, reject) => {
      child.once("error", () => reject(new Error("crm_supervisor_spawn_failed")));
      child.send({ type: "initialize", root: config.root, appUrl: config.appUrl, workerUrl: config.workerUrl, sessionId, token }, error => error ? reject(new Error("crm_supervisor_initialize_failed")) : accept());
    });
    sent = true;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = readManagedState(config);
      if (state?.sessionId === sessionId && state.phase === "running") return publicManagedState(state);
      if (state?.sessionId === sessionId && ["failed", "stopped"].includes(state.phase)) fail("crm_managed_start_failed_see_session_logs");
      if (child.exitCode !== null || child.signalCode !== null) fail("crm_supervisor_exited_see_session_logs");
      await sleep(200);
    }
    // Ownership stays with the supervisor; a second start remains locked out.
    fail("crm_managed_start_pending_check_status_and_session_logs");
  } catch (error) {
    if (!sent) {
      child?.kill();
      releaseStartLock(config, sessionId, token);
    }
    throw error;
  } finally {
    if (child?.connected) child.disconnect();
    child?.unref();
  }
}

export async function stopManaged(config, { timeoutMs = 60_000 } = {}) {
  let lock;
  try { lock = JSON.parse(readFileSync(join(managedDirectory(config), "active.lock"), "utf8")); }
  catch { return { phase: "not_managed", message: "No managed session; no process was stopped." }; }
  if (!sessionPattern.test(lock.sessionId) || !/^[a-f0-9]{64}$/.test(lock.token)) fail("crm_managed_control_invalid");
  const state = readManagedState(config);
  if (state?.sessionId !== lock.sessionId || state.token !== lock.token) fail("crm_managed_state_unknown_check_session_logs");
  const request = join(managedDirectory(config), lock.sessionId, "stop.json");
  writeFileSync(request, JSON.stringify({ token: lock.token, requestedAt: new Date().toISOString() }), { mode: 0o600 });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = readManagedState(config);
    if (current?.sessionId === lock.sessionId && ["stopped", "failed"].includes(current.phase) && !existsSync(join(managedDirectory(config), "active.lock"))) return publicManagedState(current);
    await sleep(200);
  }
  fail("crm_managed_stop_unconfirmed_check_status_and_session_logs_no_pid_kill");
}

export async function main(command) {
  if (!["start", "status", "stop"].includes(command)) fail("usage_node_scripts_local_crm_start_status_stop");
  const { loadLocalConfig, ROOT } = await import("./local-crm-config.mjs");
  // Stopping an owned session must remain possible after runtime config breaks.
  if (command === "stop") return stopManaged({ root: ROOT });
  const config = loadLocalConfig();
  if (command === "start") return startManaged(config);
  const { collectStatus } = await import("./local-crm-status.mjs");
  return { ...await collectStatus(config), managed: publicManagedState(readManagedState(config)) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.info(JSON.stringify(await main(process.argv[2]), null, 2)); }
  catch (error) {
    console.error(JSON.stringify({ error: /^[a-z0-9_]+$/.test(error.code ?? "") ? error.code : "crm_managed_operation_failed_see_local_logs" }));
    process.exitCode = 1;
  }
}
