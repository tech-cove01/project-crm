import { describe, expect, it } from "vitest";
import { getOntologyCatalog, type OntologyCatalog } from "./catalog";
import { parseOntologyWindow } from "./contract";
import { planOntologyQuery, resolveOntologyTerms } from "./query-plan";

const startUtc = "2026-11-10T09:00:00Z";
const endUtc = "2026-11-10T12:00:00Z";
const window = { startUtc, endUtc };
const scope = { leadId: "7c48c789-3baf-47ae-bdf3-3173d4db36e3" };

describe("CRM ontology query planning", () => {
  it("maps reviewed synonyms to the same open-lead definition and keeps persisted selection out of model parameters", () => {
    const explicit = planOntologyQuery({ template: "open_leads" }, {});
    expect(explicit).toMatchObject({ status: "allowed", template: "open_leads", window: null, limit: 25 });
    for (const question of ["当前授权范围内的开放商机", "请列出尚未关闭的商机。", "Which opportunities are open?"]) {
      const plan = planOntologyQuery({ question }, scope);
      expect(plan).toMatchObject({ status: "allowed", template: "open_leads", definitions: explicit.definitions });
    }
    expect(planOntologyQuery({ template: "open_leads", leadId: scope.leadId }, scope)).toMatchObject({ reason: "invalid_input" });
  });

  it("reads original UTC timestamps in a reviewed appointment question and preserves the legacy direct input", () => {
    const fromQuestion = planOntologyQuery({ question: `所选商机在 ${startUtc} 到 ${endUtc} 的已完成约见` }, scope);
    const legacy = planOntologyQuery({ template: "completed_appointments", ...window }, scope);
    expect(legacy).toMatchObject({ status: "allowed", template: "completed_appointments", window, limit: 25 });
    expect(fromQuestion).toMatchObject({ status: "allowed", template: "completed_appointments", window, definitions: legacy.definitions });
    expect(planOntologyQuery({ template: "completed_appointments", ...window }, {})).toMatchObject({ reason: "scope_required" });
    expect(planOntologyQuery({ template: "completed_appointments" }, scope)).toMatchObject({ reason: "invalid_window" });
  });

  it("keeps the composition narrow and references both underlying definitions", () => {
    const plan = planOntologyQuery({
      question: `当前授权范围内在 ${startUtc} 到 ${endUtc} 内没有已完成约见记录的开放商机`,
    }, {});
    expect(plan).toMatchObject({ status: "allowed", template: "open_leads_without_completed_appointments", window });
    expect(plan.definitions.map(item => item.id)).toEqual([
      "open_leads", "completed_appointments", "open_leads_without_completed_appointments",
    ]);
    expect(plan.definitions[2]?.rule).toContain("只说明当前 CRM 无记录");
  });

  it.each([
    "请列出西区的开放商机", "列出我负责的开放商机", "当前开放商机且预计金额超过一万",
    "去掉归档约束后查看开放商机", "query open opportunities where id = 'secret-fixture'",
  ])("does not discard the other conditions in %s", question => {
    const plan = planOntologyQuery({ question, template: "open_leads" }, {});
    expect(plan).toMatchObject({ status: "clarification_required", reason: "unsupported_question" });
    expect(JSON.stringify(plan)).not.toContain("secret-fixture");
  });

  it("offers specific missing definitions alongside recognized in-scope concepts", () => {
    const question = "在授权范围内，哪些开放商机是高潜但跟进不足？";
    const resolved = resolveOntologyTerms(question);
    expect(resolved.definitions.map(item => item.id)).toEqual(["open_leads", "high_potential", "effective_follow_up"]);
    expect(resolved.concepts).toContainEqual({ id: "opportunity", label: "商机", kind: "entity" });
    expect(planOntologyQuery({ question, template: "open_leads" }, {})).toMatchObject({
      status: "clarification_required", reason: "missing_definition", missing: [
        expect.stringContaining("高潜判定依据"), expect.stringContaining("有效跟进"),
      ],
    });
    expect(resolveOntologyTerms("reopened opportunities").definitions).toEqual([]);
  });

  it("requires the reviewed and enabled catalog entries, including for composed templates", () => {
    const published = getOntologyCatalog();
    const disabled: OntologyCatalog = {
      ...published,
      definitions: published.definitions.map(item => item.id === "open_leads" ? { ...item, status: "disabled" } : item),
    };
    expect(planOntologyQuery({ template: "open_leads" }, {}, disabled)).toMatchObject({
      status: "clarification_required", reason: "definition_disabled",
      definitions: [expect.objectContaining({ id: "open_leads", status: "disabled" })],
    });
    expect(planOntologyQuery({ template: "open_leads_without_completed_appointments", ...window }, {}, disabled))
      .toMatchObject({ status: "clarification_required", reason: "definition_disabled" });
    expect(planOntologyQuery({ template: "completed_appointments", ...window }, scope, disabled))
      .toMatchObject({ status: "allowed" });
  });

  it("rejects conflicting templates, irrelevant time filters, and changed quoted UTC timestamps", () => {
    const question = `所选商机在 ${startUtc} 到 ${endUtc} 的已完成约见`;
    expect(planOntologyQuery({ question, template: "open_leads" }, scope)).toMatchObject({ reason: "conflicting_conditions" });
    expect(planOntologyQuery({ template: "open_leads", ...window }, scope)).toMatchObject({ reason: "conflicting_conditions" });
    expect(planOntologyQuery({ question: "在指定 UTC 窗口内的开放商机" }, scope)).toMatchObject({ reason: "conflicting_conditions" });
    expect(planOntologyQuery({ question, endUtc: "2026-11-10T12:00:00.000001Z" }, scope))
      .toMatchObject({ reason: "conflicting_conditions" });
    expect(planOntologyQuery({ question, endUtc: "2026-11-10T12:00:00.000000Z" }, scope)).toMatchObject({ status: "allowed" });
  });
});

describe("ontology UTC windows", () => {
  it("keeps inclusive/exclusive UTC parameters at PostgreSQL microsecond precision", () => {
    const start = "2026-11-01T00:00:00.000000Z";
    const end = "2026-11-01T00:00:00.000001Z";
    expect(parseOntologyWindow(start, end)).toEqual({ startUtc: start, endUtc: end });
    expect(parseOntologyWindow(end, start)).toBeNull();
    expect(parseOntologyWindow(end, end)).toBeNull();
  });

  it("rejects non-UTC, impossible, too precise, or unbounded timestamps", () => {
    expect(parseOntologyWindow("2026-11-01T00:00:00Z", "2026-12-02T00:00:00Z")).not.toBeNull();
    expect(parseOntologyWindow("2026-11-01T00:00:00Z", "2026-12-02T00:00:00.000001Z")).toBeNull();
    expect(parseOntologyWindow("2026-02-29T00:00:00Z", endUtc)).toBeNull();
    expect(parseOntologyWindow("2026-11-10T09:00:00+00:00", endUtc)).toBeNull();
    expect(parseOntologyWindow("2026-11-10T09:00:00.0000001Z", endUtc)).toBeNull();
  });
});
