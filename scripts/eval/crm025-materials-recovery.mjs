/** Append-only restoration of the exact CRM-025 synthetic comparison environment. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv, isDeepStrictEqual as same } from 'node:util';
import { at, business, digest, one, optional, read, seal, sha, uuid } from './crm024-fixtures.mjs';
import { MATERIAL_ROOT, FIXTURE_FILE, PLAN_FILE, PREFLIGHT_FILE, RUNTIME_FILE, RECOVERED_FIXTURE_FILE,
  RECOVERED_RUNTIME_FILE, crm025Context, crm025Transaction, loadMaterials } from './crm025-materials-context.mjs';
import { ALPHA_TENANT, createWikiAccess, grantFor, inspectWiki, pagePath, retrieve, revokeWikiAccess, wikiAccessProof,
  wikiTransaction } from './crm025-materials-wiki.mjs';
import { activeIds, appendDraft, latestDrafts, originalsMatch, setOldSourceActive, source, triggers, verifyNativeIsolatedReseed,
  withoutPending } from './crm025-materials-source-scope.mjs';

const local = path => resolve(MATERIAL_ROOT, path);
const planFile = local('environment-recovery-plan.json');
const intentFile = local('environment-recovery-intent.json');
const crmReceiptFile = local('environment-recovery-crm-receipt.json');
const keyIntentFile = local('environment-recovery-key-intent.json');
const keyReceiptFile = local('environment-recovery-key-receipt.json');
const originalFreezeHash = '1430c9c6ef5b7777e4bba0dfa8ca6985dd9ec56475b0405e9ce865755d7da709';
const cleanupHashes = {
  crm: 'c85f4791cec13caa6fb20359a41932292669015b16a41cde4709971f95462899',
  wiki: 'd360ebc8c086a4bf6a3ddb858acdfdcc353915a78a8a3c923a6e25a7d8a3e093',
  beta: '26cf17c1953426ffa1dc73f02ad23e4dfabbd0663c81a466eeae768dd7176658',
};
const allowedDenied = status => [401, 403, 404].includes(status);
const optIn = hash => assert(sha.test(hash ?? '') && process.env.CRM025_MATERIALS_EXECUTE === hash,
  'crm025_recovery_exact_opt_in_required');
const sourceMetadata = kb => ({ provider: 'weknora', knowledge_base_id: kb, visibility: 'organization' });
const recoveredGrant = (plan, recoveryId) => ({ ...plan, batch: recoveryId });

async function archived(fixtureHash) {
  const [c, freeze, fixture, crm, wiki, beta, isolationReceipt] = await Promise.all([
    crm025Context(), read(local('baseline/freeze.json'), originalFreezeHash), read(FIXTURE_FILE, fixtureHash),
    read(local('cleanup-crm-receipt.json'), cleanupHashes.crm), read(local('cleanup-result.json'), cleanupHashes.wiki),
    read(local('beta-close-result.json'), cleanupHashes.beta), read(local('source-isolation-result.json')),
  ]);
  const [plan, preflight, isolation] = await Promise.all([read(PLAN_FILE, fixture.planHash), read(PREFLIGHT_FILE, freeze.preflightHash),
    read(local('source-isolation-plan.json'), isolationReceipt.planHash)]);
  assert(freeze.fixtureHash === fixtureHash && freeze.datasetHash === fixture.datasetHash && preflight.ready && preflight.noModel &&
    preflight.fixtureHash === fixtureHash && preflight.environmentHash === fixture.environmentHash && preflight.positiveReads.length === 28 &&
    preflight.negativeReads.length === 3 && plan.betaOrg === beta.betaOrg && plan.source.foreign === beta.sourceId &&
    [crm, wiki, beta, isolation, isolationReceipt].every(row => row.fixtureHash === fixtureHash) &&
    wiki.restored && wiki.keyRevoked.id === fixture.keyId && wiki.keyRevoked.revoked_at && wiki.ownedKeyDenied === 401 &&
    beta.originalSingleOrganizationRestored && beta.wikiHistoryRetained && crm.crmRecordsRetained &&
    same(crm.actorsRevoked, [fixture.actorScopes.sales.id]) && same(crm.sourceIds, plan.before.ids) &&
    same(crm.restoredScope, wiki.restoredScope) && crm.restoredScope.originalSourceHashRestored &&
    crm.restoredScope.isolationPlanHash === isolationReceipt.planHash &&
    isolation.scriptHash === freeze.scriptHashes['crm025-materials-source-scope.mjs'] &&
    Object.keys(fixture.slots).length === 96 && Object.values(fixture.slots).flatMap(slot => slot.memories).length === 160,
  'crm025_recovery_archive_binding_changed');
  return { c, freeze, fixture, plan, crm, wiki, beta, isolation, oldPreflightHash: freeze.preflightHash,
    archiveIdentity: { fixtureHash, freezeHash: originalFreezeHash, preflightHash: freeze.preflightHash, isolationPlanHash: isolationReceipt.planHash,
      cleanupHashes } };
}

async function ownedSources(q, c) {
  return q(`select id,organization_id,is_active,status,source_type,source_metadata,updated_at::text from ai_knowledge_sources
    where id=any($1::uuid[]) order by id`, [Object.values(c.plan.source)]);
}

function exactSource(rows, c, kind, active) {
  const row = rows.find(item => item.id === c.plan.source[kind]);
  return row?.organization_id === (kind === 'foreign' ? c.betaOrg : c.org) && row.is_active === active &&
    row.status === (active ? 'ready' : 'archived') && row.source_type === 'wiki' &&
    same(row.source_metadata, sourceMetadata(c.plan.kb[kind]));
}

async function membership(q, c, fixture) {
  const sales = fixture.actorScopes.sales;
  return one(await q(`select m.id,m.user_id,m.organization_id,m.role,m.accepted_at::text,m.revoked_at::text,
    a.raw_user_meta_data->>'synthetic_fixture' batch, a.email_confirmed_at is not null confirmed
    from user_organizations m join auth.users a on a.id=m.user_id where m.organization_id=$1 and m.user_id=$2`, [c.org, sales.id]));
}

async function originalScopes(q, c, fixture) {
  const slots = Object.values(fixture.slots);
  const roots = await q(`select id,scope->>'leadId' lead_id from ai_workbench_runs where organization_id=$1 and run_kind='root'
    and scope->>'leadId'=any($2::text[]) order by lead_id`, [c.org, slots.map(row => row.leadId)]);
  const before = slots.filter(row => row.phase === 'baseline' && ['D01', 'D02'].includes(row.caseId));
  assert(roots.length === 4 && before.every(row => roots.some(root => root.lead_id === row.leadId)), 'crm025_recovery_original_slots_changed');
  for (const slot of slots) {
    assert(same(await business(q, c, slot), slot.preState), 'crm025_recovery_existing_record_changed');
  }
  return roots;
}

async function beforeSnapshot(q, archive) {
  const { c, crm, fixture, isolation } = archive;
  await withoutPending(q, c);
  await originalsMatch(q, c, isolation);
  const oldSource = await source(q, c);
  const sources = await ownedSources(q, c);
  const drafts = await latestDrafts(q, c);
  const sales = await membership(q, c, fixture);
  const triggerState = await triggers(q);
  const expectedIds = [...crm.restoredScope.draftIds, crm.restoredVersionId].sort();
  const builtins = drafts.filter(row => row.origin === 'builtin');
  assert(same(oldSource, isolation.before.old) && same(triggerState, isolation.before.triggerState) &&
    same(await activeIds(q, c), crm.sourceIds) && sources.length === 2 && exactSource(sources, c, 'current', false) &&
    exactSource(sources, c, 'withdrawn', false) && same(builtins.map(row => row.version_id).sort(), expectedIds) &&
    builtins.every(row => row.status === 'draft' && same(row.knowledge_source_ids, crm.sourceIds)) &&
    sales.role === 'agent' && sales.role === fixture.actorScopes.sales.role && sales.accepted_at && sales.revoked_at &&
    sales.batch === c.plan.batch && sales.confirmed, 'crm025_restored_environment_changed');
  return { oldSource, sources, drafts, sales, triggerState, roots: await originalScopes(q, c, fixture) };
}

async function planRecovery(hash) {
  const archive = await archived(hash);
  const { c, plan, fixture } = archive;
  assert(!(await optional(intentFile)), 'crm025_recovery_already_requested');
  const [before, wiki, oldKey] = await Promise.all([
    crm025Transaction(c, true, q => beforeSnapshot(q, archive), { initial: true }),
    inspectWiki(plan, fixture.pages), wikiAccessProof(plan, fixture.keyId, true),
  ]);
  assert(same(oldKey, archive.wiki.keyRevoked) && wiki.currentCount === 28 && wiki.documentCount === 31 && wiki.historyCount === 1,
    'crm025_recovery_wiki_archive_mismatch');
  const recoveryId = randomUUID();
  return seal(planFile, { version: 1, at: at(), recoveryId, datasetHash: fixture.datasetHash, archive: archive.archiveIdentity,
    scriptHash: digest(await readFile(import.meta.filename)), org: c.org, databaseId: c.databaseId, before, wiki, oldKey,
    grant: grantFor(recoveredGrant(plan, recoveryId)), drafts: before.drafts.filter(row => row.origin === 'builtin').map(row =>
      ({ agentId: row.agent_id, activate: randomUUID(), restore: randomUUID() })),
    evidenceIds: Object.fromEntries(Object.entries(fixture.pages).map(([id, row]) =>
      [id, row.sourceId === plan.source.withdrawn ? row.evidenceId : randomUUID()])) });
}

function checkPlan(archive, recovery) {
  const { c, fixture, plan } = archive;
  const ids = recovery.drafts.flatMap(row => [row.activate, row.restore]);
  assert(recovery.version === 1 && recovery.org === c.org && recovery.databaseId === c.databaseId && uuid.test(recovery.recoveryId) &&
    recovery.datasetHash === fixture.datasetHash && same(recovery.archive, archive.archiveIdentity) &&
    same(recovery.grant, grantFor(recoveredGrant(plan, recovery.recoveryId))) && recovery.drafts.length === 4 &&
    new Set(ids).size === 8 && ids.every(id => uuid.test(id)) && recovery.drafts.every(row =>
      recovery.before.drafts.some(draft => draft.origin === 'builtin' && draft.agent_id === row.agentId)) &&
    Object.keys(recovery.evidenceIds).length === 31 && new Set(Object.values(recovery.evidenceIds)).size === 31 &&
    Object.entries(fixture.pages).every(([id, page]) => uuid.test(recovery.evidenceIds[id]) &&
      (page.sourceId === plan.source.withdrawn ? recovery.evidenceIds[id] === page.evidenceId : recovery.evidenceIds[id] !== page.evidenceId)),
  'crm025_recovery_plan_identity_changed');
}

async function restoreCrm(q, archive, recovery) {
  const { c, plan, fixture, isolation } = archive;
  assert(same(await beforeSnapshot(q, archive), recovery.before), 'crm025_recovery_pre_state_changed');
  one(await q(`insert into organizations(id,slug,legal_name,display_name,timezone,locale,settings)
    values($1::uuid,$2,$3,$3,'Asia/Shanghai','zh-CN',$4::jsonb) returning id`, [plan.betaOrg, plan.betaSlug, 'CRM 合成外部组织',
    JSON.stringify({ synthetic: true, crm025: plan.batch })]));
  one(await q(`insert into ai_knowledge_sources(id,organization_id,source_type,name,status,is_active,source_metadata)
    values($1::uuid,$2::uuid,'wiki','销售服务条款','ready',true,$3::jsonb) returning id`,
  [plan.source.foreign, plan.betaOrg, JSON.stringify(sourceMetadata(plan.kb.foreign))]));
  const oldSource = await setOldSourceActive(q, c, isolation, false);
  one(await q(`update ai_knowledge_sources set is_active=true,status='ready' where id=$1 and organization_id=$2
    and not is_active and status='archived' and source_metadata=$3::jsonb returning id`,
  [plan.source.current, c.org, JSON.stringify(sourceMetadata(plan.kb.current))]));
  const sales = recovery.before.sales;
  one(await q(`update user_organizations set revoked_at=null where id=$1 and organization_id=$2 and user_id=$3
    and role='agent' and revoked_at=$4::timestamptz returning id`, [sales.id, c.org, sales.user_id, sales.revoked_at]));
  for (const item of recovery.drafts) {
    const prior = one(recovery.before.drafts.filter(row => row.agent_id === item.agentId));
    await appendDraft(q, c, prior, item.activate, prior.version_number + 1, fixture.sourceIds);
  }
  const sources = await ownedSources(q, c);
  const drafts = await latestDrafts(q, c);
  const active = await activeIds(q, c);
  assert(sources.length === 3 && exactSource(sources, c, 'current', true) && exactSource(sources, c, 'foreign', true) &&
    exactSource(sources, c, 'withdrawn', false) && same(active, fixture.sourceIds) &&
    recovery.drafts.every(item => drafts.some(row => row.agent_id === item.agentId && row.version_id === item.activate &&
      row.status === 'draft' && same(row.knowledge_source_ids, fixture.sourceIds))), 'crm025_recovered_source_scope_mismatch');
  return { oldSource, sources, drafts, actor: await membership(q, c, fixture), activeSourceIds: active };
}

async function installRuntime(archive, token) {
  const raw = await readFile(RUNTIME_FILE, 'utf8');
  const { AI_INTEGRATION_BINDINGS: priorBinding } = parseEnv(raw);
  const [wiki] = JSON.parse(priorBinding);
  assert(wiki.api_key !== token && wiki.organization_id === archive.c.org &&
    same(wiki.knowledge_base_ids, [archive.plan.kb.current]), 'crm025_recovered_runtime_bad_binding');
  const body = JSON.stringify([{ ...wiki, api_key: token }]);
  assert(!/['\r\n]/.test(body), 'crm025_recovery_invalid_runtime_binding');
  const value = raw.replace(/^[ \t]*AI_INTEGRATION_BINDINGS[ \t]*=.*$/gm, `AI_INTEGRATION_BINDINGS='${body}'`);
  assert(parseEnv(value).AI_INTEGRATION_BINDINGS === body, 'crm025_recovery_runtime_roundtrip_failed');
  await writeFile(RECOVERED_RUNTIME_FILE, value, { flag: 'wx', mode: 0o600 });
  return digest(value);
}

async function resumeRecovery(planHash, recovery, archive) {
  const { c, plan, fixture } = archive;
  const intent = await read(intentFile);
  assert(intent.planHash === planHash && intent.recoveryId === recovery.recoveryId &&
    intent.originalFixtureHash === recovery.archive.fixtureHash && intent.crmOnlyAndNoModel &&
    !(await optional(RECOVERED_FIXTURE_FILE)), 'crm025_recovery_intent_not_owned');
  let crm = await optional(crmReceiptFile);
  if (!crm) {
    const restored = await crm025Transaction(c, false, q => restoreCrm(q, archive, recovery), { initial: true });
    crm = { at: at(), planHash, recoveryId: recovery.recoveryId, ...restored };
    await seal(crmReceiptFile, crm, false);
  }
  assert(crm.planHash === planHash && crm.recoveryId === recovery.recoveryId &&
    recovery.drafts.every(row => crm.drafts.some(draft => draft.agent_id === row.agentId && draft.version_id === row.activate)),
  'crm025_recovery_crm_receipt_changed');
  await crm025Transaction(c, true, async q => {
    await withoutPending(q, c);
    assert(same(await ownedSources(q, c), crm.sources) && same(await latestDrafts(q, c), crm.drafts) &&
      same(await membership(q, c, fixture), crm.actor) && same(await source(q, c), crm.oldSource), 'crm025_recovered_crm_state_changed');
  });
  const grantPlan = recoveredGrant(plan, recovery.recoveryId);
  let key = await optional(keyReceiptFile);
  if (!key) {
    assert(!(await optional(keyIntentFile)), 'crm025_recovery_key_creation_unknown_do_not_repeat');
    const active = await wikiTransaction(true, q => q(`select id from tenant_api_keys where tenant_id=$1 and name=$2 and revoked_at is null`,
      [ALPHA_TENANT, recovery.grant.name]));
    assert(active.length === 0, 'crm025_recovery_key_name_already_exists');
    await seal(keyIntentFile, { at: at(), planHash, recoveryId: recovery.recoveryId, grant: recovery.grant }, false);
    const created = await createWikiAccess(grantPlan);
    const proof = await wikiAccessProof(grantPlan, created.keyId, false);
    const environmentHash = await installRuntime(archive, created.token);
    assert(proof.id !== fixture.keyId, 'crm025_recovery_key_not_rotated');
    key = { at: at(), planHash, recoveryId: recovery.recoveryId, status: created.status, environmentHash, proof };
    await seal(keyReceiptFile, key, false);
  }
  assert(key.planHash === planHash && key.recoveryId === recovery.recoveryId && key.status === 201 && key.proof.id !== fixture.keyId &&
    key.environmentHash === digest(await readFile(RECOVERED_RUNTIME_FILE)) &&
    same(key.proof, await wikiAccessProof(grantPlan, key.proof.id, false)), 'crm025_recovery_key_receipt_changed');
  const runtime = parseEnv(await readFile(RECOVERED_RUNTIME_FILE, 'utf8'));
  const [newBinding] = JSON.parse(runtime.AI_INTEGRATION_BINDINGS);
  const [retiredBinding] = JSON.parse(c.env.AI_INTEGRATION_BINDINGS);
  const page = Object.values(fixture.pages).find(row => row.orgId === c.org && row.state === 'published');
  const [current, denied] = await Promise.all([
    retrieve(newBinding.api_key, pagePath(page)), retrieve(retiredBinding.api_key, pagePath(page)),
  ]);
  assert(current.status === 200 && current.body?.id === page.pageId && current.body.version === page.version &&
    digest(current.body.content ?? '') === page.bodyHash && allowedDenied(denied.status), 'crm025_recovery_wiki_key_readback_failed');
  const sales = one(crm.drafts.filter(row => row.builtin_key === 'sales_operations'));
  const agent = { ...fixture.agent, versionId: sales.version_id, versionNumber: sales.version_number, profileHash: sales.version_hash };
  return seal(RECOVERED_FIXTURE_FILE, { ...fixture, at: at(), environmentHash: key.environmentHash, keyId: key.proof.id, agent,
    recovery: { ...recovery.archive, originalFixtureHash: recovery.archive.fixtureHash, originalPreflightHash: recovery.archive.preflightHash,
      originalFreezeHash: recovery.archive.freezeHash, recoveryPlanHash: planHash, grantBatch: recovery.recoveryId,
      bootReadback: { currentKey: current.status, originalRetiredKey: denied.status },
      evidenceIds: recovery.evidenceIds, crmReceiptHash: digest(await readFile(crmReceiptFile)), keyReceiptHash: digest(await readFile(keyReceiptFile)) } });
}

export async function verifyRecoveredReseed(c) {
  const { recovery } = c.materials;
  const [archive, sealed, crm] = await Promise.all([archived(recovery.originalFixtureHash), read(planFile, recovery.recoveryPlanHash),
    read(crmReceiptFile, recovery.crmReceiptHash)]);
  checkPlan(archive, sealed);
  assert(c.materials.recovery.grantBatch === sealed.recoveryId && crm.planHash === recovery.recoveryPlanHash &&
    crm.recoveryId === sealed.recoveryId, 'crm025_recovered_source_scope_mismatch');
  return verifyNativeIsolatedReseed(c, crm.oldSource, crm.drafts, archive.isolation, recovery.isolationPlanHash);
}

async function unusedBeta(q, c, fixture) {
  const { plan } = c;
  const owned = one(await q('select slug::text,settings from organizations where id=$1', [plan.betaOrg]));
  assert(owned.slug === plan.betaSlug && owned.settings?.synthetic === true && owned.settings?.crm025 === plan.batch,
    'crm025_recovered_beta_identity_changed');
  const activity = one(await q(`select
    (select count(*)::int from user_organizations where organization_id=$1) members,
    (select count(*)::int from ai_workbench_runs where organization_id=$1) workbench,
    (select count(*)::int from job_queue where organization_id=$1) jobs,
    (select count(*)::int from crm_leads where organization_id=$1) leads,
    (select count(*)::int from contacts where organization_id=$1) contacts,
    (select count(*)::int from llm_calls where organization_id=$1) model,
    (select count(*)::int from conversations where organization_id=$1) conversations,
    (select count(*)::int from messages where organization_id=$1) messages,
    (select count(*)::int from ai_customer_memories where organization_id=$1) memories`, [plan.betaOrg]));
  const sources = await q(`select id,organization_id,is_active,status,source_type,source_metadata,updated_at::text
    from ai_knowledge_sources where organization_id=$1`, [plan.betaOrg]);
  const page = one(Object.values(fixture.pages).filter(row => row.orgId === plan.betaOrg));
  const receipts = await q(`select id,source_id,manifest->>'page_id' page_id,manifest->>'content_hash' content_hash
    from ai_wiki_evidence where organization_id=$1`, [plan.betaOrg]);
  assert(Object.values(activity).every(count => count === 0) && sources.length === 1 && exactSource(sources, c, 'foreign', true) &&
    receipts.length <= 1 && receipts.every(row => row.id === fixture.recovery.evidenceIds[page.logicalId] && row.source_id === page.sourceId &&
      row.page_id === page.pageId && row.content_hash === page.bodyHash), 'crm025_recovered_beta_has_other_activity');
  return { org: plan.betaOrg, sourceId: plan.source.foreign, activity, evidenceIds: receipts.map(row => row.id) };
}

async function cleanupRecoveredCrm(q, c, archive, recovery, activated) {
  const { plan, materials } = c;
  await withoutPending(q, c);
  await originalsMatch(q, c, archive.isolation);
  assert(same(await source(q, c), activated.oldSource) && same(await latestDrafts(q, c), activated.drafts) &&
    same(await ownedSources(q, c), activated.sources) && same(await membership(q, c, materials), activated.actor),
  'crm025_recovered_cleanup_inputs_changed');
  const beta = await unusedBeta(q, c, materials);
  const old = await setOldSourceActive(q, c, archive.isolation, true);
  one(await q(`update ai_knowledge_sources set status='archived',is_active=false where organization_id=$1 and id=$2 and is_active
    and status='ready' and source_metadata=$3::jsonb returning id`, [c.org, plan.source.current, JSON.stringify(sourceMetadata(plan.kb.current))]));
  one(await q(`update user_organizations set revoked_at=clock_timestamp() where id=$1 and user_id=$2 and organization_id=$3
    and role='agent' and revoked_at is null returning id`, [activated.actor.id, activated.actor.user_id, c.org]));
  for (const row of recovery.drafts) {
    const initial = one(recovery.before.drafts.filter(item => item.agent_id === row.agentId));
    const current = one(activated.drafts.filter(item => item.agent_id === row.agentId));
    await appendDraft(q, c, initial, row.restore, current.version_number + 1, initial.knowledge_source_ids);
  }
  one(await q(`delete from organizations where id=$1 and slug::text=$2 and settings->>'crm025'=$3
    and settings->>'synthetic'='true' returning id`, [beta.org, plan.betaSlug, plan.batch]));
  const drafts = await latestDrafts(q, c);
  assert(same(old, recovery.before.oldSource) && same(await activeIds(q, c), archive.crm.sourceIds) &&
    recovery.drafts.every(row => drafts.some(item => item.agent_id === row.agentId && item.version_id === row.restore &&
      item.status === 'draft' && same(item.knowledge_source_ids, archive.crm.sourceIds))), 'crm025_recovered_cleanup_scope_not_restored');
  return { beta, oldSourceRestored: true, drafts, sources: await ownedSources(q, c), membership: await membership(q, c, materials) };
}

async function cleanup(hash, resume) {
  const c = await loadMaterials(hash, { recovered: true });
  const { materials, plan } = c;
  const { recoveryPlanHash, originalFixtureHash, crmReceiptHash, grantBatch } = materials.recovery;
  const [archive, recovery, activated] = await Promise.all([
    archived(originalFixtureHash), read(planFile, recoveryPlanHash), read(crmReceiptFile, crmReceiptHash),
  ]);
  checkPlan(archive, recovery);
  assert(grantBatch === recovery.recoveryId && activated.planHash === recoveryPlanHash, 'crm025_recovered_cleanup_plan_changed');
  const cleanupIntentFile = local('environment-recovered-cleanup-intent.json');
  const cleanupReceiptFile = local('environment-recovered-cleanup-crm-receipt.json');
  const cleanupKeyIntent = local('environment-recovered-cleanup-key-intent.json');
  const cleanupResultFile = local('environment-recovered-cleanup-result.json');
  const identity = { fixtureHash: hash, recoveryPlanHash, keyId: materials.keyId, betaOrg: plan.betaOrg };
  if (resume) {
    const previous = await read(cleanupIntentFile);
    assert(same(previous, { at: previous.at, ...identity }), 'crm025_recovered_cleanup_intent_changed');
  } else await seal(cleanupIntentFile, { at: at(), ...identity }, false);
  let crm = await optional(cleanupReceiptFile);
  if (!crm) {
    const rollback = await crm025Transaction(c, false, q => cleanupRecoveredCrm(q, c, archive, recovery, activated));
    crm = { at: at(), ...identity, ...rollback };
    await seal(cleanupReceiptFile, crm, false);
  }
  assert(crm.fixtureHash === hash && crm.recoveryPlanHash === recoveryPlanHash && same(crm.beta.org, plan.betaOrg) &&
    crm.keyId === materials.keyId && crm.oldSourceRestored, 'crm025_recovered_cleanup_receipt_changed');
  await crm025Transaction(c, true, async q => {
    await withoutPending(q, c);
    assert(same(await source(q, c), recovery.before.oldSource) && same(await ownedSources(q, c), crm.sources) &&
      same(await latestDrafts(q, c), crm.drafts) && same(await membership(q, c, materials), crm.membership) && crm.membership.revoked_at,
    'crm025_recovered_cleanup_post_state_changed');
  }, { initial: true });
  const originalPath = `/api/v1/knowledgebase/${encodeURIComponent(c.oldFixture.sourceKb)}/wiki/search?q=${encodeURIComponent('审批')}&limit=1`;
  const originalBefore = await retrieve(c.binding.api_key, originalPath);
  assert(originalBefore.status === 200 && !(await optional(cleanupKeyIntent)) && !(await optional(cleanupResultFile)),
    'crm025_recovered_cleanup_key_requires_reconciliation');
  await seal(cleanupKeyIntent, { at: at(), ...identity }, false);
  const keyRevoked = await revokeWikiAccess(recoveredGrant(plan, grantBatch), materials.keyId);
  const page = Object.values(materials.pages).find(row => row.orgId === c.org && row.state === 'published');
  const [bind] = JSON.parse(c.env.AI_INTEGRATION_BINDINGS);
  const [revoked, originalAfter] = await Promise.all([retrieve(bind.api_key, pagePath(page)), retrieve(c.binding.api_key, originalPath)]);
  assert(allowedDenied(revoked.status) && originalAfter.status === 200, 'crm025_recovered_cleanup_key_readback_failed');
  return seal(cleanupResultFile, { at: at(), ...identity, closure: 'recovered_crm_and_wiki', originalBefore: originalBefore.status,
    originalAfter: originalAfter.status, freshGrantDenied: revoked.status, originalSourceRestored: true,
    keyRevoked, beta: crm.beta, crmRecordsRetained: true, noModel: true });
}

async function main([mode, hash, ...extra]) {
  assert(extra.length === 0 && sha.test(hash ?? ''), 'crm025_recovery_command_arguments');
  if (mode === 'plan') return planRecovery(hash);
  optIn(hash);
  if (mode === 'preflight') {
    const { preflight } = await import('./crm025-materials-preflight.mjs');
    return preflight(hash, { recovered: true });
  }
  if (mode === 'cleanup' || mode === 'continue-cleanup') return cleanup(hash, mode === 'continue-cleanup');
  assert(['recover', 'continue'].includes(mode), 'crm025_recovery_command_required');
  const recovery = await read(planFile, hash);
  const archive = await archived(recovery.archive.fixtureHash);
  checkPlan(archive, recovery);
  assert(recovery.scriptHash === digest(await readFile(import.meta.filename)), 'crm025_recovery_source_not_frozen');
  if (mode === 'recover') {
    assert(!(await optional(intentFile)), 'crm025_recovery_already_requested');
    const preState = await crm025Transaction(archive.c, true, q => beforeSnapshot(q, archive), { initial: true });
    assert(same(preState, recovery.before) && same(await inspectWiki(archive.plan, archive.fixture.pages), recovery.wiki) &&
      same(await wikiAccessProof(archive.plan, archive.fixture.keyId, true), recovery.oldKey), 'crm025_recovery_plan_state_changed');
    await seal(intentFile, { at: at(), planHash: hash, recoveryId: recovery.recoveryId,
      originalFixtureHash: recovery.archive.fixtureHash, crmOnlyAndNoModel: true }, false);
  }
  return resumeRecovery(hash, recovery, archive);
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) main(process.argv.slice(2)).catch(error => {
  const safe = /^crm025_[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : 'crm025_environment_recovery_failed';
  console.error(JSON.stringify({ error: safe, ...(typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? { sqlState: error.code } : {}) }));
  process.exitCode = 1;
});
