import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import { digest, optional, read, sha, uuid } from './crm024-fixtures.mjs';
import { scopedTransaction } from './crm025-materials-context.mjs';
import {
  ARMS, FILES, MEMORY_ROOT, MODEL, PRODUCT_COMMIT, WEB, buildRuntime, dbIdentity, guardForeignWork,
  guardMemoryDatabase, loadMemoryEnvironment, memoryTransaction, readEnvironmentTarget, seal, sourceLlm, validateMemoryInput,
} from './crm026-memory-environment-config.mjs';

export { FILES, MEMORY_ROOT, loadMemoryEnvironment, memoryTransaction };

const WORKBENCH = '/api/v1/ai/workbench/runs';
const MEMORY = '/api/v1/ai/customer-memory';
const AGENTS = '/api/v1/ai/agents';
const SALES = 'sales_operations';
const SETUP_PRIVATE = resolve(MEMORY_ROOT, 'setup.private.json');

function planMemory(input, inputHash, target, databaseId, source) {
  const batch = randomUUID();
  const identities = Object.fromEntries(ARMS.map(arm => [arm, {
    email: `crm026-${batch}-${arm}@example.test`, password: randomBytes(32).toString('base64url'),
  }]));
  const arms = {};
  const slots = {};
  for (const arm of ARMS) {
    const organizationId = randomUUID();
    const slug = `crm026-${batch.slice(0, 8)}-memory-${arm}`;
    const contacts = {};
    for (const trajectory of input.trajectories) {
      const contactId = randomUUID();
      const oldConversationId = randomUUID();
      const oldChannelSessionId = randomUUID();
      const oldMessages = trajectory.history.map(body => ({ id: randomUUID(), bodyHash: digest(body) }));
      const decoys = Object.fromEntries((trajectory.decoys ?? []).map(decoy => [decoy.id, randomUUID()]));
      contacts[trajectory.id] = { contactId, oldConversationId, oldChannelSessionId, oldMessages, decoys };
      for (const check of trajectory.checks) {
        const key = `${check.id}.${arm}`;
        const conversationId = randomUUID();
        slots[key] = { key, checkId: check.id, trajectoryId: trajectory.id, arm, organizationId,
          contactId, conversationId, channelSessionId: randomUUID(), currentMessageId: randomUUID(), oldConversationId,
          oldChannelSessionId, decoys, taskHash: digest(check.task), crmScope: { contactId, conversationId } };
      }
    }
    arms[arm] = { organizationId, slug, contacts };
  }
  const compiled = { batch, arms, slots, internalSecret: randomBytes(32).toString('hex'), cronSecret: randomBytes(32).toString('hex') };
  const runtime = buildRuntime(target, compiled, source);
  const intent = { version: 1, batch, inputHash, targetHash: target.targetHash, productCommit: PRODUCT_COMMIT,
    database: { mode: target.mode, id: databaseId, worker: target.mode === 'fresh' ? 'full' : 'scoped-only' },
    runtimeHash: digest(JSON.stringify(runtime, null, 2) + '\n'), arms, slots };
  return { intent, privatePlan: { identities, runtime } };
}

function authClient(origin, key) {
  return createClient(origin, key, { auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: (req, init = {}) => fetch(req, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) }) } });
}

async function provisionActors(target, plan, existing) {
  const admin = authClient(target.authOrigin, target.service);
  const actors = {};
  for (const arm of ARMS) {
    const identity = plan.identities[arm];
    if (!existing[arm]) {
      const { data, error } = await admin.auth.admin.createUser({ ...identity, email_confirm: true });
      assert(!error && uuid.test(data.user?.id ?? ''), 'crm026_memory_auth_create');
      existing[arm] = data.user.id;
    }
    const auth = authClient(target.authOrigin, target.anon);
    const { data, error } = await auth.auth.signInWithPassword(identity);
    assert(!error && data.user?.id === existing[arm], 'crm026_memory_auth_mismatch');
    actors[arm] = { id: data.user.id, ...identity };
  }
  return actors;
}

async function insertConversation(q, slot, channelId, conversationId, messageRows) {
  await q(`insert into channel_sessions (id,organization_id,waha_session_name,status,webhook_secret_encrypted)
    values ($1,$2,$3,'STOPPED',decode('00','hex'))`, [channelId, slot.organizationId, `crm026-${channelId}`]);
  await q(`insert into conversations (id,organization_id,contact_id,channel_session_id,status,is_group)
    values ($1,$2,$3,$4,'open',false)`, [conversationId, slot.organizationId, slot.contactId, channelId]);
  for (const [index, row] of messageRows.entries())
    await q(`insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,
      type,direction,status,sent_via,body,sent_at)
      values ($1,$2,$3,$4,$5,'text','inbound','received','external_device',$6,$7)`,
    [row.id, slot.organizationId, conversationId, channelId, slot.contactId, row.body,
      new Date(Date.UTC(2026, 10, 16 + Number(conversationId === slot.conversationId), 2, 0, index)).toISOString()]);
}

async function seedMemory(q, input, intent, actors, credential) {
  const llm = { provider: MODEL.provider, default_model: MODEL.model, enabled_models: [MODEL.model],
    params: { temperature: MODEL.temperature } };
  for (const arm of ARMS) {
    const { organizationId, slug, contacts } = intent.arms[arm];
    const actorId = actors[arm].id;
    await q(`insert into organizations (id,slug,legal_name,display_name,timezone,locale,created_by,onboarded_at,settings)
      values ($1,$2,'CRM 合成客户评测','CRM 合成客户评测','Asia/Shanghai','zh-CN',$3,now(),$4::jsonb)`,
    [organizationId, slug, actorId, JSON.stringify({ llm, crm026: intent.batch, synthetic: true })]);
    await q(`insert into user_organizations (user_id,organization_id,role,accepted_at)
      values ($1,$2,'admin',now())`, [actorId, organizationId]);
    await q(`insert into ai_provider_credentials (organization_id,provider,label,api_key_encrypted,api_key_iv,
      api_key_tag,api_key_last4,validated_at,models_available,created_by)
      values ($1,$2,'CRM026 isolated BYOK',$3,$4,$5,$6,$7,$8,$9)`,
    [organizationId, MODEL.provider, credential.api_key_encrypted, credential.api_key_iv, credential.api_key_tag,
      credential.api_key_last4, credential.validated_at, [MODEL.model], actorId]);
    await q(`insert into ai_integration_settings (organization_id,provider,enabled) values ($1,'mem0',$2)`,
    [organizationId, arm === 'mem0']);
    for (const trajectory of input.trajectories) {
      const { contactId, oldConversationId, oldChannelSessionId, oldMessages, decoys } = contacts[trajectory.id];
      const rows = [[contactId, trajectory.customerName], ...(trajectory.decoys ?? []).map(row => [decoys[row.id], row.name])];
      for (const [id, name] of rows)
        await q('insert into contacts (id,organization_id,name,display_name) values ($1,$2,$3,$3)', [id, organizationId, name]);
      await insertConversation(q, { organizationId, contactId }, oldChannelSessionId, oldConversationId,
        oldMessages.map((row, index) => ({ id: row.id, body: trajectory.history[index] })));
      for (const check of trajectory.checks) {
        const slot = intent.slots[`${check.id}.${arm}`];
        await insertConversation(q, slot, slot.channelSessionId, slot.conversationId,
          [{ id: slot.currentMessageId, body: check.task }]);
      }
    }
  }
}

async function verifySeed(q, intent, actors) {
  for (const arm of ARMS) {
    const { organizationId, contacts } = intent.arms[arm];
    const [row] = await q(`select
      (select role from user_organizations where organization_id=$1 and user_id=$2 and accepted_at is not null and revoked_at is null) as role,
      (select enabled from ai_integration_settings where organization_id=$1 and provider='mem0') mem0,
      (select count(*)::int from contacts where organization_id=$1) contacts,
      (select count(*)::int from channel_sessions where organization_id=$1 and status='STOPPED') stopped,
      (select count(*)::int from channel_sessions where organization_id=$1) channels,
      (select count(*)::int from crm_leads where organization_id=$1) leads,
      (select count(*)::int from ai_customer_memories where organization_id=$1) memories,
      (select count(*)::int from ai_knowledge_sources where organization_id=$1) knowledge,
      (select count(*)::int from lead_checkpoints where organization_id=$1) checkpoints,
      (select count(*)::int from ai_workbench_runs where organization_id=$1) runs,
      (select count(*)::int from llm_calls where organization_id=$1) calls`, [organizationId, actors[arm].id]);
    const contactCount = Object.values(contacts).reduce((total, contact) => total + 1 + Object.keys(contact.decoys).length, 0);
    assert(row.role === 'admin' && row.mem0 === (arm === 'mem0') && row.contacts === contactCount &&
      row.channels === 9 && row.stopped === row.channels && row.leads === 0 && row.memories === 0 &&
      row.knowledge === 0 && row.checkpoints === 0 && row.runs === 0 && row.calls === 0,
    'crm026_memory_seed_scope_drift');
    const rows = await q(`select c.id,c.contact_id,c.channel_session_id,
      array(select m.id from messages m where m.organization_id=c.organization_id and m.conversation_id=c.id order by m.sent_at) ids,
      array(select m.body from messages m where m.organization_id=c.organization_id and m.conversation_id=c.id order by m.sent_at) bodies,
      not exists(select 1 from messages m where m.organization_id=c.organization_id and m.conversation_id=c.id and m.direction <> 'inbound') no_outbound
      from conversations c where c.organization_id=$1`, [organizationId]);
    assert(rows.length === 9, 'crm026_memory_seed_conversations');
    const requireRows = (id, contactId, channelId, messages) => {
      const scope = rows.find(row => row.id === id);
      assert(scope?.contact_id === contactId && scope.channel_session_id === channelId && scope.no_outbound &&
        same(scope.ids, messages.map(row => row.id)) && same(scope.bodies.map(digest), messages.map(row => row.bodyHash)),
      'crm026_memory_seed_message_scope');
    };
    for (const contact of Object.values(contacts))
      requireRows(contact.oldConversationId, contact.contactId, contact.oldChannelSessionId, contact.oldMessages);
    for (const slot of Object.values(intent.slots).filter(row => row.arm === arm))
      requireRows(slot.conversationId, slot.contactId, slot.channelSessionId, [{ id: slot.currentMessageId, bodyHash: slot.taskHash }]);
  }
}

export async function initializeMemory(targetPath, inputPath, inputHash) {
  assert(sha.test(inputHash ?? ''), 'crm026_memory_freeze_hash_required');
  assert(!(await optional(FILES.fixture)), 'crm026_memory_fixture_already_sealed');
  const [target, input, source] = await Promise.all([
    readEnvironmentTarget(targetPath), read(inputPath, inputHash).then(validateMemoryInput), sourceLlm(),
  ]);
  const options = { connectionString: target.dbUrl };
  const databaseId = await scopedTransaction(options, true, dbIdentity);
  const pending = await optional(FILES.intent);
  let planned;
  if (pending) {
    const privatePlan = await read(SETUP_PRIVATE, pending.privatePlanHash);
    assert(pending.inputHash === inputHash && pending.targetHash === target.targetHash &&
      pending.database.id === databaseId && pending.database.mode === target.mode, 'crm026_memory_resume_scope');
    planned = { intent: pending, privatePlan };
  } else {
    await scopedTransaction(options, true, async q => {
      await guardMemoryDatabase(q, target.mode, databaseId);
      await guardForeignWork(q, target.mode, []);
    });
    planned = planMemory(input, inputHash, target, databaseId, source);
    await mkdir(MEMORY_ROOT, { recursive: true });
    // Seal the exact entity IDs and authentication inputs before contacting GoTrue.
    planned.intent.privatePlanHash = await seal(SETUP_PRIVATE, planned.privatePlan);
    await seal(FILES.intent, planned.intent);
  }
  const { intent, privatePlan } = planned;
  const existing = await scopedTransaction(options, true, async q => {
    const { owned } = await guardMemoryDatabase(q, target.mode, databaseId, intent);
    assert(owned.length === 0 || owned.length === ARMS.length, 'crm026_memory_seed_partial_orgs');
    await guardForeignWork(q, target.mode, Object.values(intent.arms).map(row => row.organizationId));
    const emails = Object.values(privatePlan.identities).map(row => row.email);
    const rows = await q('select id,email from auth.users where email=any($1::text[])', [emails]);
    return Object.fromEntries(ARMS.map(arm => [arm, rows.find(row => row.email === privatePlan.identities[arm].email)?.id]));
  });
  const actors = await provisionActors(target, privatePlan, existing);
  await scopedTransaction(options, false, async q => {
    const { owned } = await guardMemoryDatabase(q, target.mode, databaseId, intent);
    await guardForeignWork(q, target.mode, Object.values(intent.arms).map(row => row.organizationId));
    if (owned.length === 0) await seedMemory(q, input, intent, actors, source.credential);
    else assert(owned.length === ARMS.length, 'crm026_memory_seed_partial_orgs');
    await verifySeed(q, intent, actors);
  });
  const environmentHash = await sealOrConfirm(FILES.runtime, privatePlan.runtime);
  const actorsHash = await sealOrConfirm(FILES.actors, actors);
  assert(environmentHash === intent.runtimeHash, 'crm026_memory_runtime_intent_drift');
  const arms = Object.fromEntries(ARMS.map(arm => [arm, { ...intent.arms[arm], actorUserId: actors[arm].id }]));
  const slots = Object.fromEntries(Object.entries(intent.slots).map(([key, slot]) =>
    [key, { ...slot, actorUserId: actors[slot.arm].id }]));
  const intentHash = digest(await readFile(FILES.intent));
  const fixtureHash = await seal(FILES.fixture, { version: 1, batch: intent.batch, database: intent.database,
    productCommit: PRODUCT_COMMIT, inputHash, intentHash, environmentHash, actorsHash, arms, slots });
  return { fixtureHash, environmentHash, checks: Object.keys(slots).length, worker: intent.database.worker };
}

async function sealOrConfirm(path, value) {
  const previous = await optional(path);
  if (!previous) return seal(path, value);
  assert(same(previous, value), 'crm026_memory_existing_private_file_drift');
  return digest(await readFile(path));
}

export function confirmFullWorker(c) {
  assert(c.fixture.database.mode === 'fresh', 'crm026_memory_full_worker_requires_fresh_stack');
  return memoryTransaction(c, true, q => guardForeignWork(q, 'fresh',
    Object.values(c.fixture.arms).map(arm => arm.organizationId)));
}

async function armRequest(c, arm, callback) {
  const actor = c.actors[arm];
  const org = c.fixture.arms[arm];
  assert(actor?.id === org?.actorUserId && uuid.test(org.organizationId), 'crm026_memory_actor_scope_mismatch');
  const cookies = new Map();
  const auth = createServerClient(c.env.NEXT_PUBLIC_SUPABASE_URL, c.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookieOptions: { name: 'sb-pi-native-auth' },
    cookies: {
      getAll: () => Array.from(cookies, ([name, value]) => ({ name, value })),
      setAll: values => {
        for (const { name, value } of values) {
          if (value) cookies.set(name, value);
          else cookies.delete(name);
        }
      },
    },
    global: { fetch: (req, init = {}) => fetch(req, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) }) },
  });
  const login = await auth.auth.signInWithPassword({ email: actor.email, password: actor.password });
  const current = await auth.auth.getUser();
  assert(!login.error && !current.error && login.data.user?.id === actor.id && current.data.user?.id === actor.id,
    'crm026_memory_actor_authentication');
  cookies.set('active_org', org.organizationId);
  return callback(async (path, method = 'GET', data) => {
    const headers = { Origin: WEB, Cookie: Array.from(cookies, ([name, value]) => `${name}=${encodeURIComponent(value)}`).join('; ') };
    if (data) headers['Content-Type'] = 'application/json';
    const response = await fetch(WEB + path, { method, headers, redirect: 'error', signal: AbortSignal.timeout(90_000),
      ...(data ? { body: JSON.stringify(data) } : {}) });
    const body = await response.json().catch(() => null);
    return { httpStatus: response.status, data: body?.data ?? null, errorCode: body?.error?.code ?? null,
      requestId: body?.meta?.request_id ?? response.headers.get('x-request-id') };
  });
}

export function memoryTransport(c, slot, callback) {
  assert(slot && same(c.fixture.slots[slot.key], slot), 'crm026_memory_transport_requires_frozen_slot');
  const contacts = [slot.contactId, ...Object.values(slot.decoys)];
  return armRequest(c, slot.arm, request => callback(async (path, method = 'GET', data) => {
    if (method === 'POST' && path === WORKBENCH) {
      const agentId = c.profiles?.profiles?.[slot.arm]?.agentId;
      assert(uuid.test(agentId ?? '') && same(data, {
        agentId, task: data?.task, mode: 'inspect', collaboration: 'disabled', scope: slot.crmScope,
      }) && typeof data.task === 'string' && digest(data.task) === slot.taskHash, 'crm026_memory_submission_scope');
    } else if (method === 'POST' && path === MEMORY) {
      assert(slot.arm !== 'none' && contacts.includes(data?.contact_id) && data.confirmed === true,
        'crm026_memory_confirmation_scope');
    } else if (method === 'DELETE' && path === MEMORY) {
      assert(slot.arm !== 'none' && uuid.test(data?.id ?? ''), 'crm026_memory_withdrawal_scope');
      const [row] = await memoryTransaction(c, true, q => q(`select contact_id from ai_customer_memories
        where organization_id=$1 and id=$2`, [slot.organizationId, data.id]));
      assert(contacts.includes(row?.contact_id), 'crm026_memory_withdrawal_not_owned');
    } else {
      assert(method === 'GET' && !data && (path === `/api/v1/conversations/${slot.conversationId}/messages` ||
        path === `/api/v1/conversations/${slot.oldConversationId}/messages` || contacts.some(id =>
          path === `/api/v1/contacts/${id}` || path === `${MEMORY}?contact_id=${id}`)), 'crm026_memory_request_scope');
    }
    return request(path, method, data);
  }));
}

export function readForeignContact(c, arm, foreignContactId) {
  const target = Object.entries(c.fixture.arms).find(([key, row]) => key !== arm && Object.values(row.contacts)
    .some(contact => contact.contactId === foreignContactId));
  assert(target, 'crm026_memory_foreign_probe_not_owned');
  return armRequest(c, arm, request => request(`/api/v1/contacts/${foreignContactId}`));
}

export async function freezeMemoryProfiles(fixtureHash) {
  const c = await loadMemoryEnvironment(fixtureHash);
  assert(!c.profiles, 'crm026_memory_profiles_already_sealed');
  const receipt = {};
  for (const arm of ARMS) {
    const result = await armRequest(c, arm, request => request(AGENTS));
    assert(result.httpStatus === 200 && Array.isArray(result.data), 'crm026_memory_native_agent_seed_failed');
    const [row] = await memoryTransaction(c, true, q => q(`select a.id "agentId",a.builtin_revision "builtinRevision",
      v.id "versionId",v.provider,v.model,v.system_prompt prompt,v.tool_ids "toolIds",v.max_steps "maxSteps",
      v.token_budget "tokenBudget",v.cost_budget_cents "storedCostBudgetCents",v.knowledge_source_ids "sourceIds",
      o.settings->'llm'->'params'->'temperature' temperature,
      (select count(*)::int from llm_calls where organization_id=$1) calls,
      (select count(*)::int from ai_workbench_runs where organization_id=$1) runs
      from ai_agents a join organizations o on o.id=a.organization_id
      join ai_agent_versions v on v.organization_id=a.organization_id and v.agent_id=a.id
      where a.organization_id=$1 and a.origin='builtin' and a.builtin_key=$2 and v.status='draft'
      order by v.version_number desc limit 1`, [c.fixture.arms[arm].organizationId, SALES]));
    assert(row?.agentId && result.data.some(item => item.id === row.agentId) &&
      row.provider === MODEL.provider && row.model === MODEL.model && row.temperature === MODEL.temperature &&
      row.maxSteps === MODEL.maxSteps && row.tokenBudget === MODEL.tokenBudget &&
      row.toolIds.includes('crm_get_contact') && row.toolIds.includes('crm_get_conversation_history') &&
      row.sourceIds.length === 0 && row.runs === 0 && row.calls === 0, 'crm026_memory_native_agent_profile');
    const { prompt, agentId, versionId, ...invariant } = row;
    const promptHash = digest(prompt);
    receipt[arm] = { agentId, versionId, ...invariant, promptHash, profileHash: digest(JSON.stringify({ ...invariant, promptHash })),
      routeRequestId: result.requestId };
  }
  assert(new Set(Object.values(receipt).map(row => row.profileHash)).size === 1, 'crm026_memory_profiles_not_equivalent');
  const profilesHash = await seal(FILES.profiles, { version: 1, at: new Date().toISOString(), fixtureHash,
    environmentHash: c.environmentHash, profiles: receipt });
  return { fixtureHash, profilesHash, arms: ARMS.length, generatedRoots: 0 };
}

async function main() {
  const [command, first, second, third] = process.argv.slice(2);
  let result;
  if (command === 'initialize') result = await initializeMemory(first, second, third);
  else if (command === 'profiles') result = await freezeMemoryProfiles(first);
  else if (command === 'worker-guard') result = await confirmFullWorker(await loadMemoryEnvironment(first));
  else throw new Error('crm026_memory_command_required');
  console.info(JSON.stringify(result));
}

function failureCode(error) {
  for (const value of [error?.code, error?.message]) {
    if (typeof value === 'string' && /^(?:[A-Z0-9_]{2,20}|crm026_memory_[a-z_]+)$/.test(value)) return value;
  }
  return 'crm026_memory_environment_failed';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  main().catch(error => {
    console.error(failureCode(error));
    process.exitCode = 1;
  });
