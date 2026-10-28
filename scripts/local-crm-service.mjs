import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Windows IPC deliberately invokes the application's JS signal handlers. */
export function installServiceControl({ graceMs = 45_000 } = {}) {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    setTimeout(() => process.exit(1), graceMs).unref();
    // IPC itself would otherwise keep Worker/drain alive after graceful cleanup.
    if (process.connected) process.disconnect();
    if (process.listenerCount("SIGTERM") === 0) process.exit(0);
    process.emit("SIGTERM", "SIGTERM");
  };
  process.on("message", message => {
    if (message?.type === "stop") stop();
  });
  // An abruptly lost supervisor must not leave the application running forever.
  process.once("disconnect", stop);
  return stop;
}

export async function startService(role, { root, appUrl, graceMs }) {
  if (!["web", "worker", "drain"].includes(role)) throw new Error("invalid_service_role");
  process.chdir(root);
  installServiceControl({ graceMs });
  if (role === "web") {
    // The locked Next dev CLI forks another server and hard-kills it on Windows.
    // Use that same server in this owned host so its cleanup receives JS SIGTERM.
    process.env.__NEXT_DEV_SERVER = "1";
    process.env.TURBOPACK = "1";
    process.env.NEXT_PRIVATE_START_TIME = String(Date.now());
    delete process.env.NEXT_PRIVATE_WORKER;
    delete process.env.NEXT_MANUAL_SIG_HANDLE;
    const { startServer } = await import("next/dist/server/lib/start-server.js");
    await startServer({ dir: root, isDev: true, hostname: "127.0.0.1", port: Number(new URL(appUrl).port), allowRetry: false });
  } else {
    const entry = role === "worker" ? "workers/agent-worker/main.ts" : "scripts/dev-integration-drain.ts";
    await import(pathToFileURL(resolve(root, entry)).href);
  }
  process.send?.({ type: "loaded", role });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const timer = setTimeout(() => process.exit(1), 10_000);
  process.once("message", async message => {
    if (message?.type !== "initialize") return;
    clearTimeout(timer);
    try { await startService(process.argv[2], message); }
    catch {
      console.error("local_crm_service_start_failed");
      process.exit(1);
    }
  });
}
