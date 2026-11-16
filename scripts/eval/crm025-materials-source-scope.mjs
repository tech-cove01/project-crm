import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual as same } from 'node:util';
import { at, digest, idle, one, read, seal, sha } from './crm024-fixtures.mjs';
import { MATERIAL_ROOT, crm025Transaction, loadMaterials } from './crm025-materials-context.mjs';

const local = name => resolve(MATERIAL_ROOT, name);
const path = local('source-isolation-plan.json');
const triggerName = 'trg_ai_knowledge_sources_updated_at';
const originalAuditor = 'trg_ai_knowledge_sources_audit';

async function triggers(q) {
  const rows = await q(`select tgname,tgenabled,pg_get_triggerdef(oid) definition,
    encode(sha256(convert_to(pg_get_functiondef(tgfoid),'utf8')),'hex') body_hash
    from pg_trigger where tgrelid='public.ai_knowledge_sources'::regclass and not tgisinternal order by tgname`);
  assert(rows.length === 2 && rows.some(row => row.tgname === triggerName && row.tgenabled === 'O' && row.definition.includes('fn_set_updated_at()')) &&
    rows.some(row => row.tgname === originalAuditor && row.tgenabled === 'O' && row.definition.includes('fn_audit_log_row()')),
  'crm025_original_source_triggers_changed');
  return rows;
}

async function source(q, c) {
  return one(await q(`select id,organization_id,is_active,status,updated_at::text,
    encode(sha256(convert_to(to_jsonb(s)::text,'utf8')),'hex') hash,
    encode(sha256(convert_to((to_jsonb(s)-'is_active')::text,'utf8')),'hex') preserved_hash,
    source_metadata from ai_knowledge_sources s where organization_id=$1::uuid and id=$2::uuid`, [c.org, c.oldFixture.sourceId]));
}

async function activeIds(q, c) {
  return (await q(`select id from ai_knowledge_sources where organization_id=$1::uuid and is_active order by id`, [c.org])).map(row => row.id);
}

async function latestDrafts(q, c) {
  return q(`select a.id agent_id,a.builtin_key,a.origin,a.published_version_id,
    encode(sha256(convert_to(to_jsonb(a)::text,'utf8')),'hex') agent_hash,
    v.id version_id,v.version_number,v.status,v.knowledge_source_ids,
    encode(sha256(convert_to(to_jsonb(v)::text,'utf8')),'hex') version_hash
    from ai_agents a join lateral (select * from ai_agent_versions where organization_id=$1::uuid and agent_id=a.id
      order by version_number desc limit 1) v on true
    where a.organization_id=$1::uuid and a.archived_at is null and a.is_active order by a.id`, [c.org]);
}

async function withoutPending(q, c) {
  await idle(q, c);
  const total = one(await q(`select count(*)::int rows from job_queue where status in ('pending','running')`, [])).rows;
  assert(total === 0, 'crm025_scope_requires_idle_isolated_stack');
}

async function isolationSnapshot(q, c) {
  await withoutPending(q, c);
  const old = await source(q, c);
  assert(old.is_active && old.status === 'ready' && old.source_metadata.provider === 'weknora' &&
    old.source_metadata.knowledge_base_id === c.oldFixture.sourceKb && old.source_metadata.visibility === 'organization' &&
    same(await activeIds(q, c), [old.id, c.plan.source.current, c.plan.source.withdrawn].sort()), 'crm025_original_source_scope_unexpected');
  const all = await latestDrafts(q, c);
  const builtins = all.filter(row => row.origin === 'builtin');
  const others = builtins.filter(row => row.agent_id !== c.materials.agent.id);
  const sales = one(builtins.filter(row => row.agent_id === c.materials.agent.id));
  assert(others.length === 3 && others.every(row => row.status === 'draft' && same(row.knowledge_source_ids, [old.id])) &&
    sales.status === 'draft' && sales.version_id === c.materials.agent.versionId && sales.version_hash === c.materials.agent.profileHash &&
    all.filter(row => row.origin !== 'builtin').every(row => !row.knowledge_source_ids.includes(old.id)),
  'crm025_legacy_agent_isolation_scope_unexpected');
  const originalSales = one(await q(`select encode(sha256(convert_to(to_jsonb(v)::text,'utf8')),'hex') hash from ai_agent_versions v
    where organization_id=$1::uuid and agent_id=$2::uuid and id=$3::uuid`, [c.org, sales.agent_id, c.plan.before.agent.versionId]));
  assert(originalSales.hash === c.plan.before.agent.profileHash, 'crm025_original_sales_version_changed');
  const roots = one(await q(`select count(*)::int rows from ai_workbench_runs where organization_id=$1::uuid and run_kind='root'
    and scope->>'leadId'=any($2::text[])`, [c.org, Object.values(c.materials.slots).map(slot => slot.leadId)]));
  assert(roots.rows === 0, 'crm025_source_scope_must_be_frozen_before_running');
  return { old, sales, others, activeAgents: all, triggerState: await triggers(q) };
}

async function planIsolation(fixtureHash) {
  const c = await loadMaterials(fixtureHash);
  const before = await crm025Transaction(c, true, q => isolationSnapshot(q, c));
  const proposal = { version: 1, at: at(), fixtureHash, environmentHash: c.environmentHash,
    scriptHash: digest(await readFile(import.meta.filename)), c: { org: c.org, databaseId: c.databaseId }, before,
    drafts: before.others.map(draft => ({ agentId: draft.agent_id, appended: randomUUID(), restored: randomUUID() })),
    effects: { oldSourceTemporarilyInactive: before.old.id, preserveSourceRevision: before.old.updated_at,
      activeDuringEvaluation: [c.plan.source.current], auditTriggerAlwaysEnabled: true } };
  return seal(path, proposal);
}

/** Keep the existing evidence revision stable while the exact original lab source is temporarily excluded. */
async function setOldSourceActive(q, c, state, active) {
  const expected = state.before.old;
  assert(same(await triggers(q), state.before.triggerState), 'crm025_source_trigger_identity_mismatch');
  const current = await source(q, c);
  assert(current.id === expected.id && current.organization_id === c.org && current.status === expected.status && current.is_active !== active &&
    current.updated_at === expected.updated_at && current.preserved_hash === expected.preserved_hash, 'crm025_old_source_not_owned_or_changed');
  // These three statements are transactional and only affect the named timestamp trigger.
  // The audit trigger, RLS and all evaluator/runtime gates stay in force.
  await q('alter table public.ai_knowledge_sources disable trigger trg_ai_knowledge_sources_updated_at');
  one(await q(`update ai_knowledge_sources set is_active=$3 where organization_id=$1::uuid and id=$2::uuid and is_active<>$3
    and source_metadata->>'knowledge_base_id'=$4 and updated_at=$5::timestamptz returning id`,
  [c.org, expected.id, active, c.oldFixture.sourceKb, expected.updated_at]));
  await q('alter table public.ai_knowledge_sources enable trigger trg_ai_knowledge_sources_updated_at');
  const after = await source(q, c);
  assert(after.is_active === active && after.preserved_hash === expected.preserved_hash && after.updated_at === expected.updated_at &&
    (!active || after.hash === expected.hash) && same(await triggers(q), state.before.triggerState), 'crm025_old_source_revision_changed');
  return after;
}

async function appendDraft(q, c, before, id, number, sourceIds) {
  return one(await q(`insert into ai_agent_versions select (jsonb_populate_record(null::ai_agent_versions,to_jsonb(v)||jsonb_build_object(
      'id',$4::uuid,'version_number',$5::int,'knowledge_source_ids',$6::uuid[],'created_at',clock_timestamp(),'created_by',$7::uuid,
      'status','draft','published_at',null,'superseded_at',null))).* from ai_agent_versions v
    where v.organization_id=$1::uuid and v.agent_id=$2::uuid and v.id=$3::uuid
      and encode(sha256(convert_to(to_jsonb(v)::text,'utf8')),'hex')=$8 returning id`,
  [c.org, before.agent_id, before.version_id, id, number, sourceIds, c.initiatorUserId, before.version_hash]));
}

async function isolate(hash) {
  assert(sha.test(hash ?? '') && process.env.CRM025_MATERIALS_EXECUTE === hash, 'crm025_source_scope_exact_opt_in_required');
  const sealed = await read(path, hash);
  const c = await loadMaterials(sealed.fixtureHash);
  assert(sealed.version === 1 && sealed.environmentHash === c.environmentHash && sealed.scriptHash === digest(await readFile(import.meta.filename)) &&
    sealed.c.org === c.org && sealed.c.databaseId === c.databaseId && same(sealed.effects.activeDuringEvaluation, c.materials.sourceIds),
  'crm025_source_scope_plan_changed');
  await seal(local('source-isolation-intent.json'), { at: at(), fixtureHash: sealed.fixtureHash, planHash: hash, oldSourceId: sealed.before.old.id }, false);
  const result = await crm025Transaction(c, false, async q => {
    assert(same(await isolationSnapshot(q, c), sealed.before), 'crm025_source_snapshot_changed_before_isolation');
    const oldSource = await setOldSourceActive(q, c, sealed, false);
    for (const draft of sealed.drafts) {
      const original = one(sealed.before.others.filter(row => row.agent_id === draft.agentId));
      await appendDraft(q, c, original, draft.appended, original.version_number + 1, c.materials.sourceIds);
    }
    const activeSourceIds = await activeIds(q, c);
    assert(same(activeSourceIds, [c.plan.source.current, c.plan.source.withdrawn].sort()), 'crm025_owned_current_and_withdrawal_only_required');
    return { oldSource, activeSourceIds, drafts: await latestDrafts(q, c) };
  });
  return seal(local('source-isolation-result.json'), { at: at(), fixtureHash: sealed.fixtureHash, planHash: hash, ...result,
    noModel: true, originalDraftsUnmodified: true });
}

async function readIsolation(c, fixtureHash) {
  const result = await read(local('source-isolation-result.json'));
  const plan = await read(path, result.planHash);
  assert(plan.fixtureHash === fixtureHash && result.fixtureHash === fixtureHash && plan.environmentHash === c.environmentHash &&
    plan.scriptHash === digest(await readFile(import.meta.filename)) && result.oldSource.id === plan.before.old.id &&
    result.oldSource.preserved_hash === plan.before.old.preserved_hash, 'crm025_isolation_chain_changed');
  return { result, plan };
}

async function originalsMatch(q, c, plan) {
  const originals = [...plan.before.others.map(row => ({ id: row.version_id, hash: row.version_hash })),
    { id: c.plan.before.agent.versionId, hash: c.plan.before.agent.profileHash }];
  const saved = await q(`select id,encode(sha256(convert_to(to_jsonb(v)::text,'utf8')),'hex') hash from ai_agent_versions v
    where organization_id=$1::uuid and id=any($2::uuid[])`, [c.org, originals.map(row => row.id)]);
  assert(saved.length === 4 && originals.every(original => saved.some(row => same(row, original))), 'crm025_historical_agent_versions_changed');
}

/** Exercise the exact native built-in reseeder the Workbench will call before model admission. */
export async function verifyIsolatedReseed(c, fixtureHash) {
  const scope = await readIsolation(c, fixtureHash);
  const before = await crm025Transaction(c, true, async q => {
    await withoutPending(q, c);
    assert(same(await activeIds(q, c), c.materials.sourceIds) && same(await source(q, c), scope.result.oldSource),
      'crm025_effective_candidate_pool_not_isolated');
    await originalsMatch(q, c, scope.plan);
    const drafts = await latestDrafts(q, c);
    assert(same(drafts, scope.result.drafts), 'crm025_lab_drafts_changed_before_reseed');
    return drafts;
  });
  const needed = Object.keys(c.env);
  const previous = Object.fromEntries(needed.map(name => [name, process.env[name]]));
  try {
    for (const name of needed) process.env[name] = c.env[name];
    const { ensureBuiltinAgents } = await import('../../lib/ai/agents/ensure-builtins.ts');
    await ensureBuiltinAgents(c.org);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  return crm025Transaction(c, true, async q => {
    await originalsMatch(q, c, scope.plan);
    const after = await latestDrafts(q, c);
    assert(same(after, before) && same(await activeIds(q, c), c.materials.sourceIds) &&
      after.filter(row => row.origin === 'builtin').every(row => same(row.knowledge_source_ids, c.materials.sourceIds)),
    'crm025_native_reseed_would_mutate_frozen_profiles');
    return { isolationPlanHash: scope.result.planHash, activeSourceIds: c.materials.sourceIds,
      nativeReseedKeptFrozenProfiles: true, originalProfilesPreserved: 4, oldSourceRevision: scope.result.oldSource.updated_at,
      oldSourceInactive: true, triggersUnchanged: same(await triggers(q), scope.plan.before.triggerState) };
  });
}

export async function restoreSourceScope(q, c, fixtureHash) {
  const { result, plan } = await readIsolation(c, fixtureHash);
  await withoutPending(q, c);
  await originalsMatch(q, c, plan);
  assert(same(await source(q, c), result.oldSource), 'crm025_original_source_scope_changed_before_cleanup');
  const profiles = await latestDrafts(q, c);
  assert(same(profiles, result.drafts), 'crm025_lab_profiles_changed_before_cleanup');
  for (const draft of plan.drafts) {
    const current = one(profiles.filter(row => row.agent_id === draft.agentId));
    const original = one(plan.before.others.filter(row => row.agent_id === draft.agentId));
    assert(current.version_id === draft.appended && current.status === 'draft' && current.version_number === original.version_number + 1 &&
      same(current.knowledge_source_ids, c.materials.sourceIds) && current.published_version_id === original.published_version_id,
    'crm025_sibling_draft_changed_before_cleanup');
    await appendDraft(q, c, original, draft.restored, current.version_number + 1, original.knowledge_source_ids);
  }
  const restored = await setOldSourceActive(q, c, plan, true);
  return { isolationPlanHash: result.planHash, sourceId: restored.id, updatedAt: restored.updated_at,
    originalSourceHashRestored: restored.hash === plan.before.old.hash, draftIds: plan.drafts.map(draft => draft.restored) };
}

async function main([mode, hash, ...extra]) {
  assert(extra.length === 0 && sha.test(hash ?? ''), 'crm025_source_scope_argument_invalid');
  if (mode === 'plan') return planIsolation(hash);
  if (mode === 'isolate') return isolate(hash);
  throw new Error('crm025_source_scope_commands_plan_isolate');
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) main(process.argv.slice(2)).catch(error => {
  const safe = /^crm025_[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : 'crm025_source_scope_command_failed';
  console.error(JSON.stringify({ error: safe, ...(typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? { sqlState: error.code } : {}) }));
  process.exitCode = 1;
});
