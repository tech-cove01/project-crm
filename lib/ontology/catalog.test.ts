import { describe, expect, it } from "vitest";
import { definitionReference, getOntologyCatalog, resolveOntologyCatalog } from "./catalog";

describe("published CRM ontology", () => {
  it("keeps an immutable version and digest for historical receipts", () => {
    const catalog = getOntologyCatalog();
    const reference = {
      version: "1.0.0",
      digest: "5102aecfbd6ac810320cf12bd648db9e78b82d37238df0247851acd199fdbb9f",
    };
    expect(catalog.reference).toEqual(reference);
    expect(resolveOntologyCatalog(reference)).toBe(catalog);
    expect(catalog.definitions[0]?.aliases).toBeDefined();
    expect(Object.isFrozen(catalog.definitions[0]?.aliases)).toBe(true);
    expect(() => resolveOntologyCatalog({ ...reference, digest: "0".repeat(64) })).toThrow("ontology_catalog_digest_mismatch");
    expect(() => getOntologyCatalog("1.0.1")).toThrow("ontology_catalog_version_not_found");
  });

  it("describes the physical join and provenance fields for use by both query templates", () => {
    const catalog = getOntologyCatalog();
    expect(catalog.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "opportunity", table: "crm_leads" }),
      expect.objectContaining({ id: "activity", table: "crm_lead_activities" }),
    ]));
    expect(catalog.relations).toEqual([expect.objectContaining({
      from: "activity", to: "opportunity", fields: ["crm_lead_activities.lead_id", "crm_leads.id"],
    })]);
    const open = catalog.definitions.find(definition => definition.id === "open_leads")!;
    expect(open.fields).toEqual(expect.arrayContaining([
      "crm_leads.status", "crm_leads.pipeline_id", "crm_leads.stage_id", "crm_pipelines.is_archived",
    ]));
    const reference = definitionReference(open);
    expect(definitionReference({ ...open }).digest).toBe(reference.digest);
    expect(definitionReference({ ...open, status: "disabled" }).digest).not.toBe(reference.digest);
  });
});
