import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { z } from "zod";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function localError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function localUrl(value, protocols, port, code) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw localError(code);
  }
  if (
    !loopback.has(url.hostname) ||
    !protocols.includes(url.protocol) ||
    (port && url.port !== String(port)) ||
    url.search ||
    url.hash
  )
    throw localError(code);
  return url;
}

export function loadLocalConfig({ directory = ROOT, sourceEnv = process.env } = {}) {
  const root = resolve(directory);
  let files = {};
  try {
    for (const name of [".env", ".env.local"]) {
      const path = resolve(root, name);
      if (existsSync(path)) files = { ...files, ...parseEnv(readFileSync(path, "utf8")) };
    }
  } catch {
    throw localError("local_env_unreadable");
  }
  const env = { ...files, ...sourceEnv };
  env.NODE_ENV ??= "development";
  if (env.NODE_ENV !== "development") throw localError("local_development_required");
  const database = localUrl(
    env.SUPABASE_DB_URL,
    ["postgres:", "postgresql:"],
    55422,
    "crm_local_database_required",
  );
  if (database.pathname !== "/postgres") throw localError("crm_local_database_required");
  const supabase = localUrl(
    env.NEXT_PUBLIC_SUPABASE_URL,
    ["http:"],
    55421,
    "crm_local_supabase_required",
  );
  const app = localUrl(
    env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
    ["http:"],
    3000,
    "crm_local_web_required",
  );
  for (const url of [supabase, app]) {
    if (url.username || url.password || url.pathname !== "/")
      throw localError("local_origin_required");
  }
  if (!env.SUPABASE_SERVICE_ROLE_KEY) throw localError("local_service_role_missing");
  const bindingPath = resolve(root, "infra/local-agent-services/.env.crm.generated");
  if (existsSync(bindingPath)) {
    let generated;
    try {
      generated = parseEnv(readFileSync(bindingPath, "utf8"));
    } catch {
      throw localError("local_bindings_unreadable");
    }
    if (!generated.AI_INTEGRATION_BINDINGS) throw localError("local_bindings_missing");
    // A single authoritative binding file for Web, Worker and drain; never print its value.
    env.AI_INTEGRATION_BINDINGS = generated.AI_INTEGRATION_BINDINGS;
  }
  let bindings = [];
  if (env.AI_INTEGRATION_BINDINGS?.trim()) {
    try {
      bindings = JSON.parse(env.AI_INTEGRATION_BINDINGS);
    } catch {
      throw localError("local_bindings_invalid");
    }
    if (!Array.isArray(bindings) || bindings.length > 1000)
      throw localError("local_bindings_invalid");
    const identities = new Set();
    const projects = new Set();
    const fields = new Set([
      "organization_id",
      "provider",
      "base_url",
      "allow_insecure_http",
      "api_key",
      "public_key",
      "secret_key",
      "knowledge_base_ids",
      "visibility",
    ]);
    for (const binding of bindings) {
      if (
        !binding ||
        typeof binding !== "object" ||
        typeof binding.base_url !== "string" ||
        Object.keys(binding).some((key) => !fields.has(key)) ||
        !z.string().uuid().safeParse(binding.organization_id).success ||
        !["mem0", "weknora", "langfuse"].includes(binding.provider)
      )
        throw localError("local_bindings_invalid");
      for (const key of ["api_key", "public_key", "secret_key"]) {
        if (binding[key] !== undefined && !z.string().min(1).safeParse(binding[key]).success)
          throw localError("local_bindings_invalid");
      }
      if (binding.visibility !== undefined && binding.visibility !== "organization")
        throw localError("local_bindings_invalid");
      if (
        binding.knowledge_base_ids !== undefined &&
        !z.array(z.string().min(1).max(200)).min(1).safeParse(binding.knowledge_base_ids).success
      )
        throw localError("local_bindings_invalid");
      const endpoint = localUrl(
        binding.base_url,
        ["http:", "https:"],
        null,
        "local_binding_endpoint_required",
      );
      if (
        endpoint.username ||
        endpoint.password ||
        endpoint.pathname !== "/" ||
        (binding.allow_insecure_http !== undefined && binding.allow_insecure_http !== true)
      )
        throw localError("local_bindings_invalid");
      const identity = `${binding.organization_id}:${binding.provider}`;
      if (identities.has(identity)) throw localError("local_bindings_duplicate");
      identities.add(identity);
      if (binding.provider === "langfuse") {
        if (!binding.public_key || !binding.secret_key)
          throw localError("local_binding_credentials_missing");
        const project = `${endpoint.origin}:${binding.public_key}`;
        if (projects.has(project)) throw localError("local_bindings_duplicate");
        projects.add(project);
      } else if (!binding.api_key) throw localError("local_binding_credentials_missing");
      if (
        binding.provider === "weknora" &&
        (binding.visibility !== "organization" ||
          !Array.isArray(binding.knowledge_base_ids) ||
          !binding.knowledge_base_ids.length ||
          binding.knowledge_base_ids.some((id) => typeof id !== "string" || !id || id.length > 200))
      )
        throw localError("local_bindings_invalid");
    }
  }
  env.HEALTH_HOST = "127.0.0.1";
  env.HEALTH_PORT = "8787";
  env.NEXT_TELEMETRY_DISABLED = "1";
  env.FLYWHEEL_INTERVAL_MS = "0";
  return { root, env, appUrl: app.origin, workerUrl: "http://127.0.0.1:8787", bindings };
}
