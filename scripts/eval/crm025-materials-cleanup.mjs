import assert from 'node:assert/strict';
import { isDeepStrictEqual as same } from 'node:util';
import { resolve } from 'node:path';
import { at, idle, one, optional, read, seal, sha } from './crm024-fixtures.mjs';
import { MATERIAL_ROOT, loadMaterials, crm025Transaction } from './crm025-materials-context.mjs';

const local = name => resolve(MATERIAL_ROOT, name);

async function checkUnusedBeta(q, c) {
  await idle(q, c);
  const { plan, materials } = c;
  const owned = one(await q(`select id,slug::text,settings from organizations where id=$1::uuid`, [plan.betaOrg]));
  assert(owned.slug === plan.betaSlug && owned.settings?.synthetic === true && owned.settings?.crm025 === plan.batch,
    'crm025_beta_ownership_changed');
  const scopes = one(await q(`select
    (select count(*)::int from user_organizations where organization_id=$1::uuid) members,
    (select count(*)::int from ai_workbench_runs where organization_id=$1::uuid) workbench,
    (select count(*)::int from job_queue where organization_id=$1::uuid) jobs,
    (select count(*)::int from crm_leads where organization_id=$1::uuid) leads,
    (select count(*)::int from contacts where organization_id=$1::uuid) contacts,
    (select count(*)::int from llm_calls where organization_id=$1::uuid) model,
    (select count(*)::int from ai_customer_memories where organization_id=$1::uuid) memories`, [plan.betaOrg]));
  assert(Object.values(scopes).every(n => n === 0), 'crm025_beta_adopted_by_other_work');
  const sources = await q(`select id,status,is_active,source_metadata from ai_knowledge_sources where organization_id=$1::uuid`, [plan.betaOrg]);
  assert(sources.length === 1 && sources[0].id === plan.source.foreign && sources[0].status === 'archived' && !sources[0].is_active &&
    sources[0].source_metadata?.knowledge_base_id === plan.kb.foreign, 'crm025_beta_source_scope_changed');
  const page = one(Object.values(materials.pages).filter(item => item.orgId === plan.betaOrg));
  const evidence = await q(`select id,source_id,manifest->>'page_id' page_id,manifest->>'content_hash' content_hash from ai_wiki_evidence
    where organization_id=$1::uuid`, [plan.betaOrg]);
  assert(evidence.length <= 1 && evidence.every(row => row.id === page.evidenceId && row.source_id === page.sourceId &&
    row.page_id === page.pageId && row.content_hash === page.bodyHash), 'crm025_beta_evidence_scope_changed');
  return { betaOrg: plan.betaOrg, sourceId: plan.source.foreign, evidenceIds: evidence.map(row => row.id), scopes };
}

/** Remove only the entirely unused CRM-side foreign security fixture after main cleanup. Its Wiki remains for evidence. */
async function closeForeignFixture(fixtureHash) {
  assert(sha.test(fixtureHash ?? '') && process.env.CRM025_MATERIALS_EXECUTE === fixtureHash, 'crm025_beta_cleanup_exact_opt_in_required');
  const [c, cleanup] = await Promise.all([loadMaterials(fixtureHash), read(local('cleanup-result.json'))]);
  assert(cleanup.fixtureHash === fixtureHash && cleanup.restored === true && cleanup.keyRevoked.id === c.materials.keyId &&
    cleanup.keyRevoked.revoked_at && !(await optional(local('beta-close-intent.json'))), 'crm025_beta_requires_verified_primary_cleanup');
  const proof = await crm025Transaction(c, true, q => checkUnusedBeta(q, c));
  await seal(local('beta-close-intent.json'), { at: at(), fixtureHash, ...proof }, false);
  await crm025Transaction(c, false, async q => {
    assert(same(await checkUnusedBeta(q, c), proof), 'crm025_beta_cleanup_snapshot_changed');
    one(await q(`delete from organizations where id=$1::uuid and slug::text=$2
      and settings->>'crm025'=$3 and settings->>'synthetic'='true' returning id`, [proof.betaOrg, c.plan.betaSlug, c.plan.batch]));
  });
  await crm025Transaction(c, true, async q => {
    assert.equal(one(await q('select count(*)::int count from organizations')).count, 1, 'crm025_single_isolated_organization_not_restored');
    await idle(q, c);
  }, { initial: true });
  return seal(local('beta-close-result.json'), { at: at(), fixtureHash, ...proof, originalSingleOrganizationRestored: true, wikiHistoryRetained: true });
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) closeForeignFixture(process.argv[2]).catch(error => {
  const safe = /^crm025_[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : 'crm025_beta_cleanup_failed';
  console.error(JSON.stringify({ error: safe, ...(typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? { sqlState: error.code } : {}) }));
  process.exitCode = 1;
});
