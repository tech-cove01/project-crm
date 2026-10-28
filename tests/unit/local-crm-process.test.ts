// @vitest-environment node
import { fork, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import http from "node:http";
import { join, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// Runtime imports keep this Node-only operational script outside the app's TS graph.
const control = await import(pathToFileURL(resolve("scripts/local-crm.mjs")).href);
const supervisor = await import(pathToFileURL(resolve("scripts/local-crm-supervisor.mjs")).href);
const serviceUrl = pathToFileURL(resolve("scripts/local-crm-service.mjs")).href;
const temporaryRoots: string[] = [];
const children: ChildProcess[] = [];
const running: Promise<unknown>[] = [];

async function until(predicate: () => boolean, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (predicate()) return; await sleep(30); }
  throw new Error("fixture_deadline_exceeded");
}
async function unusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>(accept => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_port_missing");
  await new Promise<void>(accept => server.close(() => accept()));
  return address.port;
}
async function fixture() {
  const parent = resolve(".local");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "crm013-process-"));
  temporaryRoots.push(root);
  const config = { root, env: { ...process.env, CRM_TEST_SECRET: "fixture-control-secret" }, appUrl: `http://127.0.0.1:${await unusedPort()}`, workerUrl: `http://127.0.0.1:${await unusedPort()}` };
  const fixturePath = join(root, "service.mjs");
  writeFileSync(fixturePath, `
import http from 'node:http';
import { installServiceControl } from ${JSON.stringify(serviceUrl)};
const role=process.argv[2];
const ports=JSON.parse(process.argv[3]);
let server, timer, hang=false;
installServiceControl({graceMs:10000});
process.on('SIGTERM',()=>{if(hang)return;clearInterval(timer);server?.close();});
process.on('message',message=>{
  if(message.type==='hang'){hang=true;return;}
  if(message.type==='crash'){process.exit(7);}
  if(message.type!=='initialize')return;
  const loaded=()=>process.send?.({type:'loaded',role});
  const secret=process.env.CRM_TEST_SECRET;
  process.stdout.write(secret.slice(0,7));
  setTimeout(()=>process.stdout.write(secret.slice(7)+'\\n'),5);
  if(role==='web'||role==='worker'){
    server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({db:'ok',event_log_drain:{carregado:true}}));});
    server.listen(ports[role],'127.0.0.1',loaded);
  }else{timer=setInterval(()=>{},1000);loaded();}
});
`);
  const byRole: Record<string, ChildProcess> = {};
  const spawnService = (role: string) => {
    const child = fork(fixturePath, [role, JSON.stringify({ web: Number(new URL(config.appUrl).port), worker: Number(new URL(config.workerUrl).port) })], { env: config.env, execArgv: [], windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    children.push(child);
    byRole[role] = child;
    return child;
  };
  const sessionId = randomUUID();
  const token = randomBytes(32).toString("hex");
  control.acquireStartLock(config, sessionId, token);
  return { config, sessionId, token, spawnService, byRole };
}
afterEach(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await Promise.allSettled(running.splice(0));
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) await until(() => child.exitCode !== null || child.signalCode !== null);
  for (const root of temporaryRoots.splice(0)) {
    if (!resolve(root).startsWith(resolve(".local") + sep)) throw new Error("fixture_cleanup_outside_workspace");
    rmSync(root, { recursive: true, force: true });
  }
});

describe("managed local CRM process ownership", () => {
  it("refuses active/unknown queues but allows pending integration delivery", () => {
    const queues = { ok: true, jobQueue: { pending: 0, running: 0, dead: 2 }, integration: { pending: 9, processing: 0, dead: 1 } };
    expect(() => control.assertIdleQueues({ queues })).not.toThrow();
    expect(() => control.assertIdleQueues({ queues: { ...queues, jobQueue: { ...queues.jobQueue, pending: 1 } } })).toThrow("crm_queue_active");
    expect(() => control.assertIdleQueues({ queues: { ...queues, integration: { ...queues.integration, processing: 1 } } })).toThrow("crm_queue_active");
    expect(() => control.assertIdleQueues({ queues: { ok: false } })).toThrow("crm_queue_status_unknown");
  });

  it("refuses a foreign listener and does not steal an existing session lock", async () => {
    const f = await fixture();
    expect(() => control.acquireStartLock(f.config, randomUUID(), randomBytes(32).toString("hex"))).toThrow("crm_managed_lock_exists");
    control.releaseStartLock(f.config, randomUUID(), f.token);
    expect(existsSync(join(control.managedDirectory(f.config), "active.lock"))).toBe(true);
    const server = net.createServer();
    await new Promise<void>(accept => server.listen(Number(new URL(f.config.appUrl).port), "127.0.0.1", accept));
    try { await expect(control.assertPortsFree(f.config)).rejects.toThrow("crm_port_in_use"); expect(server.listening).toBe(true); }
    finally { await new Promise<void>(accept => server.close(() => accept())); }
  });

  it("stops all three real child processes naturally via IPC and preserves an unrelated process", async () => {
    const f = await fixture();
    const other = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { windowsHide: true, stdio: "ignore" });
    children.push(other);
    const task = supervisor.runSupervisor(f.config, { ...f, processHandlers: false, shutdownMs: 2000 });
    running.push(task);
    await until(() => control.readManagedState(f.config)?.phase === "running");
    writeFileSync(join(control.managedDirectory(f.config), f.sessionId, "stop.json"), JSON.stringify({ token: "incorrect" }));
    await sleep(350);
    expect(control.readManagedState(f.config)?.phase).toBe("running");
    const result = await control.stopManaged(f.config, { timeoutMs: 5000 });
    await task;
    expect(result.phase).toBe("stopped");
    expect(result.token).toBeUndefined();
    for (const record of Object.values(result.services) as { exitCode: number; graceful: boolean; forced: boolean }[]) {
      expect(record.exitCode).toBe(0); expect(record.graceful).toBe(true); expect(record.forced).toBe(false);
    }
    expect(other.exitCode).toBeNull();
    expect(other.signalCode).toBeNull();
    await control.assertPortsFree(f.config);
    const stdout = readFileSync(join(control.managedDirectory(f.config), f.sessionId, "worker.stdout.log"), "utf8");
    expect(stdout).toContain("[REDACTED]");
    expect(stdout).not.toContain(f.config.env.CRM_TEST_SECRET);
    const eventsText = readFileSync(join(control.managedDirectory(f.config), f.sessionId, "events.ndjson"), "utf8");
    expect(eventsText).not.toContain(f.token);
    const events = eventsText.trim().split("\n").map(line => JSON.parse(line));
    expect(events.filter(event => event.type === "service_stop_requested").map(event => event.service)).toEqual(["drain", "worker", "web"]);
    expect(events.findIndex(event => event.type === "service_stop_requested" && event.service === "worker")).toBeGreaterThan(events.findIndex(event => event.type === "service_exited" && event.service === "drain"));
    expect(events.findIndex(event => event.type === "service_stop_requested" && event.service === "web")).toBeGreaterThan(events.findIndex(event => event.type === "service_exited" && event.service === "worker"));
  });

  it("records an unexpected exit, stops its siblings, and never restarts", async () => {
    const f = await fixture();
    const task = supervisor.runSupervisor(f.config, { ...f, processHandlers: false, shutdownMs: 2000 });
    running.push(task);
    await until(() => control.readManagedState(f.config)?.phase === "running");
    f.byRole.worker!.send({ type: "crash" });
    const result = await task;
    expect(result.phase).toBe("failed");
    expect(result.services.worker.exitCode).toBe(7);
    expect(result.services.worker.graceful).toBe(false);
    expect(Object.keys(f.byRole)).toHaveLength(3);
    await control.assertPortsFree(f.config);
  });

  it("lets the real stop CLI close its owned session despite broken runtime configuration", async () => {
    const f = await fixture();
    const task = supervisor.runSupervisor(f.config, { ...f, processHandlers: false, shutdownMs: 2000 });
    running.push(task);
    await until(() => control.readManagedState(f.config)?.phase === "running");
    const scripts = join(f.config.root, "scripts");
    mkdirSync(scripts);
    for (const name of ["local-crm.mjs", "local-crm-config.mjs"]) copyFileSync(resolve("scripts", name), join(scripts, name));
    writeFileSync(join(f.config.root, ".env.local"), "SUPABASE_DB_URL=not-a-url\nAI_INTEGRATION_BINDINGS=invalid\n");
    const child = spawn(process.execPath, [join(scripts, "local-crm.mjs"), "stop"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let stdout = "";
    child.stdout!.on("data", chunk => { stdout += String(chunk); });
    await until(() => child.exitCode !== null || child.signalCode !== null, 5000);
    await task;
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(stdout).phase).toBe("stopped");
    expect(stdout).not.toContain(f.token);
    await control.assertPortsFree(f.config);
  });

  it("bounds shutdown and records forced termination separately", async () => {
    const f = await fixture();
    const task = supervisor.runSupervisor(f.config, { ...f, processHandlers: false, shutdownMs: 300, forceWaitMs: 1500 });
    running.push(task);
    await until(() => control.readManagedState(f.config)?.phase === "running");
    f.byRole.worker!.send({ type: "hang" });
    const before = Date.now();
    const result = await control.stopManaged(f.config, { timeoutMs: 5000 });
    await task;
    expect(Date.now() - before).toBeLessThan(4000);
    expect(result.services.worker.forced).toBe(true);
    expect(result.services.worker.graceful).toBe(false);
    await control.assertPortsFree(f.config);
  });

  it("refuses Worker readiness until its event-log drain has loaded", async () => {
    const f = await fixture();
    const task = supervisor.runSupervisor(f.config, {
      ...f, processHandlers: false, startupMs: 2500, shutdownMs: 1000,
      probe: async () => new Response(JSON.stringify({ db: "ok", event_log_drain: { carregado: false } }), { status: 200 }),
    });
    running.push(task);
    const result = await task;
    expect(result.phase).toBe("failed");
    expect(result.stopReason).toBe("startup_failed");
    expect(f.byRole.worker).toBeDefined();
    expect(f.byRole.drain).toBeUndefined();
    await control.assertPortsFree(f.config);
  });

  it("self-cleans a real service when its supervisor IPC connection disappears", async () => {
    const f = await fixture();
    const child = f.spawnService("worker");
    let loaded = false;
    child.on("message", message => { if ((message as { type: string }).type === "loaded") loaded = true; });
    child.send({ type: "initialize" });
    await until(() => loaded);
    child.disconnect();
    await until(() => child.exitCode !== null || child.signalCode !== null);
    expect(child.exitCode).toBe(0);
    await control.assertPortsFree(f.config);
  });

  it.each(["60000", "10000"])("records a real drain receipt and stops during its %s ms wait", async intervalMs => {
    const server = http.createServer((_req, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: { scanned: 2, done: 1, dead: 0, projected: 0 }, ignoredPrivateField: "must-not-be-logged" }));
    });
    await new Promise<void>(accept => server.listen(0, "127.0.0.1", accept));
    const address = server.address() as net.AddressInfo;
    const child = fork(resolve("scripts/local-crm-service.mjs"), ["drain"], {
      execArgv: ["--import", "tsx"], windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, NODE_ENV: "development", NEXT_PUBLIC_APP_URL: `http://127.0.0.1:${address.port}`, SUPABASE_DB_URL: "postgresql://fixture@127.0.0.1:55422/postgres", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55421", INTERNAL_CRON_SECRET: "fixture-drain-secret", CRM_LOCAL_INTEGRATION_INTERVAL_MS: intervalMs },
    });
    children.push(child);
    let stdout = "";
    child.stdout!.on("data", chunk => { stdout += String(chunk); });
    child.send({ type: "initialize", root: process.cwd(), graceMs: 3000 });
    try {
      await until(() => stdout.includes('"event":"integration_drain_tick"'));
      const receipt = JSON.parse(stdout.split("\n").find(line => line.includes('"event":"integration_drain_tick"'))!);
      expect(receipt).toMatchObject({ httpStatus: 200, ok: true, scanned: 2, done: 1, dead: 0 });
      expect(Number.isFinite(Date.parse(receipt.at))).toBe(true);
      expect(stdout).not.toContain("must-not-be-logged");
      expect(stdout).toContain(`interval ${intervalMs} ms`);
      child.send({ type: "stop" });
      await until(() => child.exitCode !== null || child.signalCode !== null, 3000);
      expect(child.exitCode).toBe(0);
    } finally { server.closeAllConnections(); await new Promise<void>(accept => server.close(() => accept())); }
  });

  it.each(["9999", "60001", "NaN"])("rejects an unsafe drain interval %s before HTTP", async intervalMs => {
    const child = fork(resolve("scripts/local-crm-service.mjs"), ["drain"], {
      execArgv: ["--import", "tsx"], windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, NODE_ENV: "development", NEXT_PUBLIC_APP_URL: "http://127.0.0.1:1", SUPABASE_DB_URL: "postgresql://fixture@127.0.0.1:55422/postgres", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55421", INTERNAL_CRON_SECRET: "fixture-drain-secret", CRM_LOCAL_INTEGRATION_INTERVAL_MS: intervalMs },
    });
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", chunk => { stdout += String(chunk); });
    child.stderr!.on("data", chunk => { stderr += String(chunk); });
    child.send({ type: "initialize", root: process.cwd(), graceMs: 3000 });
    await until(() => child.exitCode !== null || child.signalCode !== null);
    expect(child.exitCode).toBe(1);
    expect(stdout).not.toContain("integration_drain_tick");
    expect(stderr).toContain("local_crm_service_start_failed");
  });

  it("waits for an actual in-flight drain receipt before exiting on stop", async () => {
    let requested = false;
    let response: http.ServerResponse | null = null;
    const server = http.createServer((_request, currentResponse) => { requested = true; response = currentResponse; });
    await new Promise<void>(accept => server.listen(0, "127.0.0.1", accept));
    const address = server.address() as net.AddressInfo;
    const child = fork(resolve("scripts/local-crm-service.mjs"), ["drain"], {
      execArgv: ["--import", "tsx"], windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, NODE_ENV: "development", NEXT_PUBLIC_APP_URL: `http://127.0.0.1:${address.port}`, SUPABASE_DB_URL: "postgresql://fixture@127.0.0.1:55422/postgres", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55421", INTERNAL_CRON_SECRET: "fixture-drain-secret" },
    });
    children.push(child);
    child.send({ type: "initialize", root: process.cwd(), graceMs: 3000 });
    try {
      await until(() => requested);
      child.send({ type: "stop" });
      await sleep(250);
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      const receipt = response as http.ServerResponse | null;
      if (!receipt) throw new Error("fixture_request_not_received");
      receipt.setHeader("content-type", "application/json");
      receipt.end(JSON.stringify({ data: { scanned: 1, done: 1, dead: 0 } }));
      await until(() => child.exitCode !== null || child.signalCode !== null, 3000);
      expect(child.exitCode).toBe(0);
    } finally { server.closeAllConnections(); await new Promise<void>(accept => server.close(() => accept())); }
  });
});
