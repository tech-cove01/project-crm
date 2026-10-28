/** Local-only scheduler for the dedicated external-integration queue. */
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
const secret = process.env.INTERNAL_CRON_SECRET || process.env.INTERNAL_SECRET;
if (!secret) throw new Error("cron_secret_required");

async function tick(): Promise<void> {
  try {
    const response = await fetch(new URL("/api/v1/cron/ai-integration-drain", base), {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      redirect: "error",
      signal: AbortSignal.timeout(70_000),
    });
    if (!response.ok) console.error(`integration drain HTTP ${response.status}`);
  } catch {
    console.error("integration drain unavailable");
  }
}

// Sequential scheduling prevents overlapping ticks when a remote service is slow.
async function main(): Promise<void> {
  for (;;) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  }
}
console.info("Local integration drain started; interval 60 seconds.");
void main();
