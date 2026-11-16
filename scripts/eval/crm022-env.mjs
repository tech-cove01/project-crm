import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';

const dir = '.local/crm022';
const slug = 'crm022-synthetic-eval';
const model = 'qwen3.8-flash';

function readEnv(path) {
  return parseEnv(readFileSync(path, 'utf8'));
}

function localDatabase(value, port) {
  const url = new URL(value);
  assert(['localhost', '127.0.0.1'].includes(url.hostname) && url.port === port && url.pathname === '/postgres');
  return url.href;
}

function writePrivate(path, content) {
  writeFileSync(path, content, { flag: 'wx', mode: 0o600 });
}

async function createActor(admin, name) {
  const email = `crm022-${name}-${randomUUID().slice(0, 8)}@example.test`;
  const password = randomBytes(32).toString('base64url');
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  assert(!error && data.user, 'eval_auth_actor_create');
  return { id: data.user.id, email, password };
}

async function main() {
  assert.equal(process.argv[2], 'initialize');
  const cli = readEnv(`${dir}/stack/status.private.env`);
  const previous = readEnv('.env.local');
  const sourceUrl = localDatabase(previous.SUPABASE_DB_URL, '55422');
  const databaseUrl = localDatabase(cli.DB_URL, '55522');
  const origin = 'http://127.0.0.1:55521';
  assert.equal(new URL(cli.API_URL).port, '55521');
  const anon = cli.ANON_KEY ?? cli.PUBLISHABLE_KEY;
  const service = cli.SERVICE_ROLE_KEY ?? cli.SECRET_KEY;
  assert(anon && service && previous.AI_CRED_AES_KEY, 'eval_connection_keys_missing');
  const source = new pg.Pool({ connectionString: sourceUrl, options: '-c default_transaction_read_only=on', max: 1 });
  const database = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const admin = createClient(origin, service, { auth: { autoRefreshToken: false, persistSession: false } });
  try {
    const { rows: [check] } = await database.query('select count(*)::int as orgs from public.organizations');
    assert.equal(check.orgs, 0, 'eval_database_must_be_fresh');
    const bindings = JSON.parse(readEnv('infra/local-agent-services/.env.crm.generated').AI_INTEGRATION_BINDINGS);
    assert(Array.isArray(bindings) && bindings.length > 0, 'local_integration_bindings_missing');
    const originalOrg = bindings[0].organization_id;
    const { rows: [credential] } = await source.query(`select api_key_encrypted, api_key_iv, api_key_tag, api_key_last4
      from public.ai_provider_credentials where organization_id=$1 and provider='dashscope'
      and is_active and validated_at is not null order by validated_at desc limit 1`, [originalOrg]);
    assert(credential, 'validated_dashscope_credential_missing');
    const { rows: [sourceConfig] } = await source.query(`select settings->'llm'->>'default_model' as model,
      (select count(*)::int from llm_calls where organization_id=$1 and provider='dashscope'
       and created_at >= date_trunc('month',current_timestamp)) as current_month_metered_rows
      from organizations where id=$1`, [originalOrg]);
    assert.equal(sourceConfig.model, model);
    const initiator = await createActor(admin, 'initiator');
    const decider = await createActor(admin, 'decider');
    const org = randomUUID();
    const db = await database.connect();
    try {
      await db.query('begin');
      await db.query(`insert into organizations(id,slug,legal_name,display_name,created_by,onboarded_at)
        values ($1,$2,'CRM022 Synthetic Evaluation','CRM022 Synthetic Evaluation',$3,now())`, [org, slug, initiator.id]);
      for (const actor of [initiator, decider]) {
        await db.query(`insert into user_organizations(user_id,organization_id,role,accepted_at)
          values ($1,$2,'admin',now())`, [actor.id, org]);
      }
      await db.query(`update organizations set settings = jsonb_set(settings,'{llm}',$2::jsonb,true)
        where id=$1`, [org, JSON.stringify({ provider: 'dashscope', default_model: model, enabled_models: [model], params: { temperature: 0 } })]);
      await db.query(`insert into ai_provider_credentials(organization_id,provider,label,api_key_encrypted,api_key_iv,
        api_key_tag,api_key_last4,validated_at,models_available,created_by)
        values ($1,'dashscope','CRM022 isolated BYOK',$2,$3,$4,$5,now(),$6,$7)`,
      [org, credential.api_key_encrypted, credential.api_key_iv, credential.api_key_tag, credential.api_key_last4, [model], initiator.id]);
      await db.query(`insert into ai_integration_settings(organization_id,provider,enabled)
        values ($1,'mem0',true),($1,'weknora',true),($1,'langfuse',true)`, [org]);
      await db.query('commit');
    } catch (error) {
      await db.query('rollback');
      throw error;
    } finally {
      db.release();
    }
    // The common eval processes use separate Supabase credentials; the BYOK key
    // remains encrypted in the test DB and is resolved in the caller's memory.
    const allowedBindings = bindings.filter(binding => binding.organization_id === originalOrg)
      .map(binding => ({ ...binding, organization_id: org }));
    const env = {
      NODE_ENV: 'development', NEXT_PUBLIC_SUPABASE_URL: origin,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: anon, SUPABASE_SERVICE_ROLE_KEY: service,
      SUPABASE_DB_URL: databaseUrl, NEXT_PUBLIC_APP_URL: 'http://localhost:3415',
      AI_CRED_AES_KEY: previous.AI_CRED_AES_KEY,
      INTERNAL_SECRET: randomBytes(32).toString('hex'), INTERNAL_CRON_SECRET: randomBytes(32).toString('hex'),
      NEXT_TELEMETRY_DISABLED: '1', CRM_EMBEDDING_PROVIDER: 'dashscope',
      CRM_LOCAL_WORKBENCH_UNPRICED_MODE: 'true', HEALTH_HOST: '127.0.0.1', HEALTH_PORT: '8795',
      QUEUE_MAX_CONCURRENCY: '1', QUEUE_POLL_INTERVAL_MS: '1000',
      AI_INTEGRATION_BINDINGS: JSON.stringify(allowedBindings),
      CRM022_ORG_ID: org, CRM022_ORG_SLUG: slug,
      CRM022_MEMORY_DB_URL: databaseUrl, CRM022_MEMORY_ORG_ID: org, CRM022_MEMORY_ORG_SLUG: slug,
    };
    writePrivate(`${dir}/runtime.env`, Object.entries(env).map(([key, value]) => `${key}='${value}'`).join('\n') + '\n');
    writePrivate(`${dir}/actors.private.json`, JSON.stringify({ initiator, decider }));
    console.log(JSON.stringify({ org, slug, initiator: initiator.id, decider: decider.id, model,
      sourceCurrentMonthMeteredRows: sourceConfig.current_month_metered_rows, integrationProviders: allowedBindings.map(b => b.provider) }));
  } finally {
    await Promise.all([source.end(), database.end()]);
  }
}

main().catch(error => {
  console.error('crm022_setup_failed', error.code ?? error.name, error.table ?? '', error.column ?? '');
  process.exitCode = 1;
});
