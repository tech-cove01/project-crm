import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual as same } from 'node:util';
import { resolve } from 'node:path';
import { at, digest, one, optional, read, seal } from './crm024-fixtures.mjs';
import { MATERIAL_ROOT, PREFLIGHT_FILE, RECOVERED_PREFLIGHT_FILE, WORKBENCH, crm025Transaction, crm025Transport,
  loadMaterials } from './crm025-materials-context.mjs';
import { documentPath, inspectWiki, pagePath, retrieve, wikiAccessProof } from './crm025-materials-wiki.mjs';
import { inspectCrm } from './crm025-materials.mjs';
import { verifyIsolatedReseed } from './crm025-materials-source-scope.mjs';

const local = file => resolve(MATERIAL_ROOT, file);
const sourceEndpoint = id => `/api/v1/ai/knowledge/sources/${id}`;
const evidenceEndpoint = id => `/api/v1/ai/integrations/wiki/evidence/${id}`;
const denied = status => [401, 403, 404].includes(status);
const authority = 'derived_company_knowledge_not_commercial_approval';

async function limitedMap(inputs, work) {
  const output = [];
  const parallel = 4;
  for (let i = 0; i < inputs.length; i += parallel) {
    output.push(...await Promise.all(inputs.slice(i, i + parallel).map(work)));
  }
  return output;
}

function documentDto(raw) {
  const { id, knowledge_base_id, title, updated_at, file_hash, parse_status, enable_status, deleted_at } = raw;
  return { id, knowledge_base_id, title, updated_at, ...(file_hash === undefined ? {} : { file_hash }), parse_status, enable_status,
    ...(deleted_at === undefined ? {} : { deleted_at }) };
}

function pageDto(row, entry, observation) {
  return {
    knowledge_base_id: row.kbId, page_id: row.pageId, slug: row.slug, title: entry.title, page_version: row.version,
    page_updated_at: observation?.page.updated_at ?? new Date(row.updatedAt).toISOString(),
    content_hash: row.bodyHash, chunk_ids: observation?.page.chunk_refs ?? [],
  };
}

async function retrieveCurrent(token, row, entry) {
  const [page, doc] = await Promise.all([retrieve(token, pagePath(row)), retrieve(token, documentPath(row))]);
  const article = page.body, file = doc.body?.data;
  assert(page.status === 200 && article?.id === row.pageId && article.knowledge_base_id === row.kbId &&
    article.title === entry.title && article.slug === row.slug && article.version === row.version && article.status === 'published' &&
    digest(article.content ?? '') === row.bodyHash && same(article.source_refs, [row.documentId]) &&
    Date.parse(article.updated_at) === Date.parse(row.updatedAt), 'crm025_scoped_wiki_page_positive_failed');
  assert(doc.status === 200 && file?.id === row.documentId && file.knowledge_base_id === row.kbId && file.title === entry.title &&
    file.file_hash === row.bodyHash && file.parse_status === 'completed' && ['enable', 'enabled'].includes(file.enable_status) &&
    Date.parse(file.updated_at) === Date.parse(row.documentUpdatedAt), 'crm025_scoped_wiki_document_positive_failed');
  return { page: article, doc: documentDto(file), pageStatus: page.status, documentStatus: doc.status };
}

async function verifyCrmSubjects(c, fixture, dataset) {
  const slots = Object.values(fixture.slots);
  const cases = new Map(dataset.cases.map(entry => [entry.id, entry]));
  return Promise.all(['initiator', 'sales'].map(actor => {
    const selected = slots.filter(slot => slot.actor === actor);
    return crm025Transport(c, selected[0], async (request, auth) => {
      const leadIds = selected.map(slot => slot.leadId);
      const contactIds = selected.map(slot => slot.contactId);
      const [contactProbe, workbenchProbe, leads, contacts] = await Promise.all([
        request(`/api/v1/contacts/${selected[0].contactId}`, 'GET'), request(WORKBENCH, 'GET'),
        auth.from('crm_leads').select('id,organization_id,contact_id,pipeline_id,stage_id,status,title,description,value_cents,currency,expected_close_date,custom_fields')
          .eq('organization_id', c.org).in('id', leadIds),
        auth.from('contacts').select('id,organization_id').eq('organization_id', c.org).in('id', contactIds),
      ]);
      const expected = actor === 'sales' ? 403 : 200;
      assert(contactProbe.httpStatus === 200 && contactProbe.data?.id === selected[0].contactId && contactProbe.data.organization_id === c.org &&
        workbenchProbe.httpStatus === expected && !leads.error && leads.data?.length === selected.length && !contacts.error &&
        contacts.data?.length === selected.length && selected.every(slot => {
          const lead = leads.data.find(row => row.id === slot.leadId);
          const expected = cases.get(slot.caseId).business.lead;
          return lead?.organization_id === c.org && lead.contact_id === slot.contactId && lead.pipeline_id === slot.pipelineId && lead.stage_id === slot.stageId &&
            lead.status === expected.status && lead.title === expected.title && lead.description === (expected.description ?? null) &&
            lead.value_cents != null && Number(lead.value_cents) === expected.valueCents && lead.currency === expected.currency &&
            lead.expected_close_date === expected.expectedCloseDate &&
            same(lead.custom_fields, expected.customFields) && contacts.data.some(row => row.id === slot.contactId && row.organization_id === c.org);
        }), 'crm025_authenticated_crm_scope_mismatch');
      return { actor, userId: selected[0].actorUserId, role: selected[0].expectedRole, workbenchGetStatus: workbenchProbe.httpStatus,
        workbenchErrorCode: workbenchProbe.errorCode, contactStatus: contactProbe.httpStatus, contacts: contacts.data.length,
        leads: leads.data.length, businessFieldsVerified: true, observedVia: 'authenticated_postgrest_by_ids' };
    });
  }));
}

async function verifyCustomerFacts(c, fixture) {
  const before = process.env.AI_INTEGRATION_BINDINGS;
  process.env.AI_INTEGRATION_BINDINGS = c.env.AI_INTEGRATION_BINDINGS;
  try {
    const { readConfirmedCustomerMemory } = await import('../../lib/ai/integrations/mem0.ts');
    return crm025Transaction(c, true, async q => {
      const store = { query: async ({ text, values }) => {
        assert(/^\s*select\b/i.test(text) && values[0] === c.org, 'crm025_confirmation_read_only');
        return { rows: await q(text, values) };
      } };
      const outputs = {};
      for (const slot of Object.values(fixture.slots)) {
        const read = await readConfirmedCustomerMemory(store, c.org, slot.contactId, undefined, AbortSignal.timeout(5000));
        assert(read.status === 'local' && read.providerStatus === 'disabled' && read.coverage === 'complete' &&
          slot.memories.length === read.memories.length && slot.memories.every(expected => read.memories.some(actual =>
            expected.id === actual.id && expected.category === actual.category && expected.revision === actual.revision &&
            expected.bodyHash === digest(actual.body) && actual.confirmed === true)), 'crm025_confirmed_customer_facts_not_available');
        outputs[slot.key] = { count: read.memories.length, status: read.status, coverage: read.coverage };
      }
      return outputs;
    });
  } finally {
    if (before === undefined) delete process.env.AI_INTEGRATION_BINDINGS;
    else process.env.AI_INTEGRATION_BINDINGS = before;
  }
}

async function archiveWithdrawal(c, fixture, fixtureHash, managerSlot) {
  const sourceId = c.plan.source.withdrawn;
  const prior = await optional(local('withdrawal-intent.json'));
  return crm025Transport(c, { ...managerSlot, canWithdraw: true }, async request => {
    const before = await request(sourceEndpoint(sourceId), 'GET');
    assert(before.httpStatus === 200 && before.data?.id === sourceId && before.data.organization_id === c.org,
      'crm025_owned_withdrawal_source_unavailable');
    if (prior) {
      assert(prior.fixtureHash === fixtureHash && prior.sourceId === sourceId && before.data.status === 'archived' && before.data.is_active === false,
        'crm025_withdrawal_result_unknown_do_not_repeat');
      return await optional(local('withdrawal-receipt.json')) ?? { at: at(), sourceId, fixtureHash, confirmedByGet: true, status: 'archived' };
    }
    assert(before.data.status === 'ready' && before.data.is_active === true &&
      before.data.source_metadata.knowledge_base_id === c.plan.kb.withdrawn && !fixture.sourceIds.includes(sourceId),
    'crm025_named_withdrawal_scope_not_ready');
    await seal(local('withdrawal-intent.json'), { at: at(), fixtureHash, sourceId, actorId: managerSlot.actorUserId }, false);
    const response = await request(sourceEndpoint(sourceId), 'DELETE');
    const after = await request(sourceEndpoint(sourceId), 'GET');
    assert(response.httpStatus === 200 && response.data?.id === sourceId && response.data?.status === 'archived' &&
      after.httpStatus === 200 && after.data?.status === 'archived' && after.data.is_active === false,
    'crm025_withdrawal_response_unknown_do_not_repeat');
    const receipt = { at: at(), fixtureHash, sourceId, status: 'archived', beforeStatus: before.httpStatus,
      deleteStatus: response.httpStatus, afterStatus: after.httpStatus, requestId: response.requestId };
    await seal(local('withdrawal-receipt.json'), receipt, false);
    return receipt;
  });
}

/** Preflight evidence rows are derived only from exact authorised by-ID reads and the owned historical fixtures. */
async function installReadbackReceipts(c, fixture, data, observations, sourceRows, ids) {
  return crm025Transaction(c, false, async q => {
    const rows = {};
    for (const entry of data.corpus) {
      const row = fixture.pages[entry.id];
      const receiptId = ids?.[entry.id] ?? row.evidenceId;
      const observation = observations[entry.id];
      const manifest = {
        provider: 'weknora', ...pageDto(row, entry, observation),
        source_revision: String(one(sourceRows.filter(source => source.id === row.sourceId)).updated_at),
        sources: [observation?.doc ?? { id: row.documentId, knowledge_base_id: row.kbId, title: entry.title,
          updated_at: new Date(row.documentUpdatedAt).toISOString(), file_hash: row.bodyHash, parse_status: 'completed', enable_status: 'enabled' }],
        authority,
      };
      const revision = digest(JSON.stringify(manifest));
      await q(`insert into ai_wiki_evidence(id,organization_id,source_id,manifest_hash,manifest,content)
        values($1::uuid,$2::uuid,$3::uuid,$4,$5::jsonb,$6) on conflict(organization_id,source_id,manifest_hash) do nothing`,
      [receiptId, row.orgId, row.sourceId, revision, JSON.stringify(manifest), entry.content]);
      const saved = one(await q(`select id,manifest_hash from ai_wiki_evidence
        where organization_id=$1::uuid and source_id=$2::uuid and manifest_hash=$3`, [row.orgId, row.sourceId, revision]));
      assert(saved.id === receiptId && saved.manifest_hash === revision, 'crm025_preflight_evidence_receipt_collision');
      rows[entry.id] = { id: receiptId, revision };
    }
    return rows;
  });
}

async function verifyRestoredWithdrawal(c, fixture, managerSlot) {
  const old = await read(PREFLIGHT_FILE, fixture.recovery.originalPreflightHash);
  const { withdrawal, fixtureHash } = old;
  assert(fixtureHash === fixture.recovery.originalFixtureHash && withdrawal.sourceId === c.plan.source.withdrawn &&
    withdrawal.status === 'archived', 'crm025_recovered_withdrawal_not_same');
  const response = await crm025Transport(c, managerSlot, request => request(sourceEndpoint(withdrawal.sourceId), 'GET'));
  assert(response.httpStatus === 200 && response.data?.id === withdrawal.sourceId && response.data.organization_id === c.org &&
    response.data.status === 'archived' && response.data.is_active === false &&
    response.data.source_metadata.knowledge_base_id === c.plan.kb.withdrawn, 'crm025_recovered_withdrawal_not_same');
  return { originalPreflightHash: fixture.recovery.originalPreflightHash, sourceId: withdrawal.sourceId,
    status: 'archived', confirmedByGet: true, requestId: response.requestId };
}

export async function preflight(fixtureHash, { recovered = false } = {}) {
  const preflightFile = recovered ? RECOVERED_PREFLIGHT_FILE : PREFLIGHT_FILE;
  assert(!(await optional(preflightFile)), 'crm025_environment_already_frozen');
  const c = await loadMaterials(fixtureHash, { recovered });
  const fixture = c.materials, data = c.dataset, plan = c.plan;
  const betaAndWithdrawn = data.corpus.filter(entry => entry.organizationId === 'org_beta' || entry.state === 'withdrawn');
  const published = data.corpus.filter(entry => entry.organizationId === 'org_alpha' && entry.state === 'published');
  const token = JSON.parse(c.env.AI_INTEGRATION_BINDINGS)[0].api_key;
  const managerSlot = Object.values(fixture.slots).find(slot => slot.actor === 'initiator');
  const grantPlan = recovered ? { ...plan, batch: fixture.recovery.grantBatch } : plan;
  const [wiki, grant, observations, customerFacts, actorScope] = await Promise.all([
    inspectWiki(plan, fixture.pages), wikiAccessProof(grantPlan, fixture.keyId, false),
    limitedMap(published, async entry => [entry.id, await retrieveCurrent(token, fixture.pages[entry.id], entry)]).then(Object.fromEntries),
    verifyCustomerFacts(c, fixture), verifyCrmSubjects(c, fixture, data),
  ]);
  assert(wiki.currentCount === 28 && Object.keys(observations).length === published.length, 'crm025_shared_candidate_pool_coverage');
  const providerDenials = Object.fromEntries(await limitedMap(betaAndWithdrawn, async entry => {
    const page = fixture.pages[entry.id];
    const [pageResult, documentResult] = await Promise.all([retrieve(token, pagePath(page)), retrieve(token, documentPath(page))]);
    assert(denied(pageResult.status) && denied(documentResult.status), 'crm025_upstream_negative_fixture_exposed');
    return [entry.id, { pageStatus: pageResult.status, documentStatus: documentResult.status }];
  }));
  const old = one(data.corpus.filter(entry => entry.state === 'superseded'));
  const historicalFile = await retrieve(token, documentPath(fixture.pages[old.id]));
  assert(denied(historicalFile.status), 'crm025_historical_document_still_accessible');
  providerDenials[old.id] = { historyExists: true, currentVersion: 2, documentStatus: historicalFile.status };
  const withdrawal = recovered ? await verifyRestoredWithdrawal(c, fixture, managerSlot) :
    await archiveWithdrawal(c, fixture, fixtureHash, managerSlot);
  const sourceIsolation = recovered ? await (await import('./crm025-materials-recovery.mjs')).verifyRecoveredReseed(c) :
    await verifyIsolatedReseed(c, fixtureHash);
  const crm = await inspectCrm(c, fixture, data, true);
  const readbacks = await installReadbackReceipts(c, fixture, data, observations, crm.sources, fixture.recovery?.evidenceIds);
  const scopedSlot = { ...managerSlot, evidenceIds: Object.values(readbacks).map(row => row.id) };
  const receipts = await crm025Transport(c, scopedSlot, async request => {
    const records = await limitedMap(data.corpus, async entry => {
      const page = fixture.pages[entry.id];
      const reference = readbacks[entry.id];
      const response = await request(evidenceEndpoint(reference.id), 'GET');
      if (Object.hasOwn(observations, entry.id)) {
        assert(response.httpStatus === 200 && response.data?.id === reference.id && digest(response.data.content ?? '') === page.bodyHash &&
          response.data.manifest?.page_id === page.pageId && response.data.manifest?.page_version === page.version &&
          response.data.manifest?.knowledge_base_id === page.kbId && response.data.manifest?.content_hash === page.bodyHash,
        'crm025_positive_crm_evidence_readback_failed');
      } else assert(response.httpStatus === 404 && response.data === null, 'crm025_negative_crm_evidence_should_be_denied');
      return [entry.id, { ...reference, httpStatus: response.httpStatus, requestId: response.requestId }];
    });
    const foreign = one(betaAndWithdrawn.filter(entry => entry.organizationId === 'org_beta'));
    const sourceDeny = await request(sourceEndpoint(fixture.pages[foreign.id].sourceId), 'GET');
    assert(sourceDeny.httpStatus === 404 && sourceDeny.data === null, 'crm025_foreign_crm_source_should_be_denied');
    return { entries: Object.fromEntries(records), foreignSourceStatus: sourceDeny.httpStatus };
  });
  const positiveReads = published.map(entry => {
    const { pageStatus, documentStatus } = observations[entry.id];
    const row = fixture.pages[entry.id];
    return { logicalId: entry.id, pageId: row.pageId, documentId: row.documentId, version: row.version,
      bodyHash: row.bodyHash, pageStatus, documentStatus, evidence: receipts.entries[entry.id] };
  });
  const negativeReads = data.corpus.filter(entry => !Object.hasOwn(observations, entry.id)).map(entry => ({
    logicalId: entry.id, state: entry.organizationId === 'org_beta' ? 'foreign' : entry.state,
    provider: providerDenials[entry.id] ?? { historyExists: true, currentVersion: 2 }, evidence: receipts.entries[entry.id],
  }));
  return seal(preflightFile, { version: 1, at: at(), datasetHash: c.datasetHash, fixtureHash, environmentHash: c.environmentHash,
    preflightSourceHash: digest(await readFile(import.meta.filename)),
    ready: true, noModel: true, usedSearchForPreflight: false, sourceIds: fixture.sourceIds, wiki, grant, positiveReads,
    negativeReads, actorScope, customerFacts, withdrawal, sourceIsolation, foreignSourceHttpStatus: receipts.foreignSourceStatus,
    scopedObjects: crm.scopedObjects, ...(recovered ? { recovery: fixture.recovery } : {}) });
}
