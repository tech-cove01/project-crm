/** Local-only scheduler for the dedicated external-integration queue. */
import { setTimeout as sleep } from "node:timers/promises";

const shutdown = new AbortController();
process.once("SIGTERM", () => shutdown.abort());
process.once("SIGINT", () => shutdown.abort());
const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
const base = new URL(process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000");
const database = new URL(process.env.SUPABASE_DB_URL ?? "");
const supabase = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
if (
  process.env.NODE_ENV !== "development" ||
  !loopback.has(base.hostname) ||
  !loopback.has(database.hostname) ||
  !loopback.has(supabase.hostname) ||
  base.pathname !== "/" ||
  base.search ||
  base.hash
) throw new Error("local_development_endpoints_required");
const intervalMs = Number(process.env.CRM_LOCAL_INTEGRATION_INTERVAL_MS ?? "60000");
if (!Number.isSafeInteger(intervalMs) || intervalMs < 10_000 || intervalMs > 60_000)
  throw new Error("local_integration_interval_out_of_range");
const secret = process.env.INTERNAL_CRON_SECRET || process.env.INTERNAL_SECRET;
if (!secret) throw new Error("cron_secret_required");

async function tick(): Promise<void> {
  const at = new Date().toISOString();
  try {
    const response = await fetch(new URL("/api/v1/cron/ai-integration-drain", base), {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      redirect: "error",
      // The server does not cancel its database work when the client disconnects.
      // Finish an existing receipt before exiting; the supervisor bounds shutdown.
      signal: AbortSignal.timeout(70_000),
    });
    // Only bounded numeric receipts are logged, never the original response body.
    const result = await response.json().catch(() => null);
    const data = result?.data;
    const count = (key: string): number | null =>
      typeof data?.[key] === "number" && Number.isSafeInteger(data[key]) && data[key] >= 0
        ? data[key] : null;
    console.info(JSON.stringify({ at, event: "integration_drain_tick", httpStatus: response.status,
      ok: response.ok, scanned: count("scanned"), done: count("done"), dead: count("dead"), projected: count("projected") }));
  } catch {
    if (!shutdown.signal.aborted) console.error(JSON.stringify({ at, event: "integration_drain_tick", ok: false, error: "unavailable" }));
  }
}

// Sequential scheduling prevents overlapping ticks when a remote service is slow.
async function main(): Promise<void> {
  while (!shutdown.signal.aborted) {
    await tick();
    if (shutdown.signal.aborted) break;
    try { await sleep(intervalMs, undefined, { signal: shutdown.signal }); }
    catch { if (!shutdown.signal.aborted) throw new Error("integration_drain_wait_failed"); }
  }
  console.info("Local integration drain stopped.");
}
console.info(`Local integration drain started; interval ${intervalMs} ms.`);
void main();
