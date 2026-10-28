import { test } from "node:test";
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadLocalConfig } from "../../scripts/local-crm-config.mjs";
import { collectStatus, queueStatus } from "../../scripts/local-crm-status.mjs";

const base = {
  NODE_ENV: "development",
  SUPABASE_DB_URL: "postgres://postgres:fake-password@127.0.0.1:55422/postgres",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55421",
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  SUPABASE_SERVICE_ROLE_KEY: "fake-service-key",
};
function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), "crm013-status-"));
  try {
    return run(directory);
  } finally {
    assert(
      resolve(directory).startsWith(resolve(tmpdir()) + "\\") ||
        resolve(directory).startsWith(resolve(tmpdir()) + "/"),
    );
    rmSync(directory, { recursive: true, force: true });
  }
}

test("refuse foreign/remote endpoints before a probe or mutation", () =>
  fixture((directory) => {
    for (const patch of [
      { SUPABASE_DB_URL: "postgres://secret@db.example.com:55422/postgres" },
      { SUPABASE_DB_URL: "postgres://secret@127.0.0.1:5432/postgres" },
      { NEXT_PUBLIC_SUPABASE_URL: "https://real-project.supabase.co" },
      { NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000/?secret=canary" },
      { NODE_ENV: "production" },
    ]) {
      assert.throws(
        () => loadLocalConfig({ directory, sourceEnv: { ...base, ...patch } }),
        (error) => !error.message.includes("secret") && !error.message.includes("canary"),
      );
    }
  }));

test("one generated binding overrides stale ambient binding; configuration never mutates ambient env", () =>
  fixture((directory) => {
    const binding = {
      organization_id: "11111111-1111-4111-8111-111111111111",
      provider: "mem0",
      base_url: "http://127.0.0.1:8888",
      api_key: "private-canary",
    };
    mkdirSync(join(directory, "infra/local-agent-services"), { recursive: true });
    writeFileSync(
      join(directory, "infra/local-agent-services/.env.crm.generated"),
      `AI_INTEGRATION_BINDINGS='${JSON.stringify([binding])}'\n`,
    );
    writeFileSync(join(directory, ".env.local"), "SENTRY_DSN=off\n");
    const sourceEnv = { ...base, AI_INTEGRATION_BINDINGS: "stale" };
    const config = loadLocalConfig({ directory, sourceEnv });
    assert.equal(config.bindings[0].api_key, "private-canary");
    assert.equal(sourceEnv.AI_INTEGRATION_BINDINGS, "stale");
    assert.equal(sourceEnv.HEALTH_HOST, undefined);
    assert.equal(config.env.HEALTH_HOST, "127.0.0.1");
    assert.equal(config.env.SENTRY_DSN, "off");
    assert.equal(config.env.FLYWHEEL_INTERVAL_MS, "0");
  }));

test("reject malformed or foreign integration bindings without reflecting secrets", () =>
  fixture((directory) => {
    for (const bindings of [
      "private-canary",
      JSON.stringify([{ provider: "mem0", api_key: "private-canary" }]),
      JSON.stringify([
        {
          organization_id: "11111111-1111-4111-8111-111111111111",
          provider: "mem0",
          base_url: "https://remote.example.com",
          api_key: "private-canary",
        },
      ]),
    ]) {
      assert.throws(
        () =>
          loadLocalConfig({ directory, sourceEnv: { ...base, AI_INTEGRATION_BINDINGS: bindings } }),
        (error) => !error.message.includes("private-canary"),
      );
    }
  }));

test("status preserves degraded Web and incomplete Worker readiness and only emits whitelisted metadata", async () => {
  const config = {
    appUrl: "http://localhost:3000",
    workerUrl: "http://127.0.0.1:8787",
    env: base,
    bindings: [
      {
        organization_id: "demo",
        provider: "mem0",
        base_url: "http://127.0.0.1:8888",
        api_key: "private-canary",
      },
    ],
  };
  const result = await collectStatus(config, {
    queues: async () => ({
      ok: true,
      jobQueue: { pending: 0, running: 0, dead: 0 },
      integration: { pending: 1, processing: 0 },
    }),
    probe: async (url) => ({
      reachable: true,
      httpStatus: 200,
      ok: true,
      json: url.includes("/healthz")
        ? { db: "ok", event_log_drain: { carregado: false }, secret: "private-canary" }
        : { data: { status: "degraded" }, secret: "private-canary" },
    }),
  });
  assert.equal(result.web.reportedStatus, "degraded");
  assert.equal(result.worker.eventLogDrainLoaded, false);
  assert.equal(result.integrations[0].authenticatedAccessVerified, false);
  assert.equal(result.queues.integration.pending, 1);
  assert.equal(JSON.stringify(result).includes("private-canary"), false);
});

test("binding field types match the application's optional credential and visibility contract", () =>
  fixture((directory) => {
    const binding = {
      organization_id: "11111111-1111-4111-8111-111111111111",
      provider: "mem0",
      base_url: "http://127.0.0.1:8888",
      api_key: "fake-key",
    };
    for (const patch of [
      { api_key: 42 },
      { base_url: ["http://127.0.0.1:8888"] },
      { public_key: true },
      { secret_key: {} },
      { visibility: "public" },
      { knowledge_base_ids: [] },
      { knowledge_base_ids: [42] },
      { organization_id: "11111111-1111-1111-1111-111111111111" },
    ]) {
      assert.throws(
        () =>
          loadLocalConfig({
            directory,
            sourceEnv: {
              ...base,
              AI_INTEGRATION_BINDINGS: JSON.stringify([{ ...binding, ...patch }]),
            },
          }),
        { code: "local_bindings_invalid" },
      );
    }
  }));

test("pool, checked-out client and query/close failures become unknown without exposing driver messages", async () => {
  for (const kind of ["pool", "client", "query", "close"]) {
    const pool = new EventEmitter();
    let connected = false;
    pool.query = async () => {
      if (!connected) {
        connected = true;
        const client = new EventEmitter();
        pool.emit("connect", client);
        if (kind === "pool") pool.emit("error", new Error("private-canary"));
        if (kind === "client") client.emit("error", new Error("private-canary"));
      }
      if (kind === "query") throw new Error("private-canary");
      return { rows: [] };
    };
    pool.end = async () => {
      if (kind === "close") throw new Error("private-canary");
    };
    const result = await queueStatus({ env: base }, { poolFactory: () => pool });
    assert.equal(result.ok, false);
    assert.equal(result.jobQueue, null);
    assert.equal(JSON.stringify(result).includes("private-canary"), false);
  }
});
