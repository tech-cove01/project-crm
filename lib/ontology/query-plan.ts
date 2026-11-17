// Adapted from Ontology Lite's literal term resolver and allowlisted query planner.
// Copyright (c) 2026 Rafael Melgaço. MIT, see the repository LICENSE.
import { z } from "zod";
import {
  definitionReference,
  getOntologyCatalog,
  type OntologyCatalog,
  type OntologyCatalogReference,
  type OntologyConcept,
  type OntologyDefinitionId,
  type OntologyDefinitionReference,
} from "./catalog";
import {
  ONTOLOGY_TEMPLATES,
  ontologyUtcMicroseconds,
  parseOntologyWindow,
  type OntologyTemplate,
  type OntologyWindow,
} from "./contract";

const queryInput = z.object({
  question: z.string().trim().min(1).max(2000).optional(),
  template: z.string().trim().min(1).max(80).optional(),
  startUtc: z.string().max(32).optional(),
  endUtc: z.string().max(32).optional(),
}).strict();
const templateSchema = z.enum(ONTOLOGY_TEMPLATES);

export type OntologyQueryScope = {
  leadId?: string | null;
  contactId?: string | null;
  pipelineId?: string | null;
  conversationId?: string | null;
};
type TermResolution = {
  catalog: OntologyCatalogReference;
  concepts: OntologyConcept[];
  definitions: OntologyDefinitionReference[];
};
export type OntologyPlanRejectionReason =
  | "invalid_input" | "missing_definition" | "unsupported_question" | "definition_disabled"
  | "scope_required" | "invalid_window" | "conflicting_conditions";
type AllowedTemplate =
  | { template: "open_leads"; window: null }
  | { template: Exclude<OntologyTemplate, "open_leads">; window: OntologyWindow };
export type AllowedOntologyQueryPlan = TermResolution & AllowedTemplate & { status: "allowed"; limit: number };
export type OntologyQueryPlan = AllowedOntologyQueryPlan | (TermResolution & {
  status: "clarification_required";
  reason: OntologyPlanRejectionReason;
  missing: string[];
});

function normalize(text: string): string {
  return text.normalize("NFKC").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

function latinWords(text: string): string {
  return ` ${text.replace(/[^a-z0-9_]+/g, " ").trim()} `;
}

/** Directory matches describe possible meanings. Only planning may admit a query. */
export function resolveOntologyTerms(question: string, catalog = getOntologyCatalog()): TermResolution {
  const result: TermResolution = { catalog: catalog.reference, concepts: [], definitions: [] };
  if (typeof question !== "string" || !question.trim() || question.length > 2000) return result;
  const normalized = normalize(question);
  const latin = latinWords(normalized);
  const mentions = ({ id, aliases }: { id: string; aliases: readonly string[] }) =>
    [id, ...aliases].some(alias => {
      const term = normalize(alias);
      return /\p{Script=Han}/u.test(term) ? normalized.includes(term) : latin.includes(latinWords(term));
    });
  const collect = (items: OntologyCatalog["entities"] | OntologyCatalog["relations"] | OntologyCatalog["definitions"],
    kind: OntologyConcept["kind"]) => items.filter(mentions).map(({ id, label }) => ({ id, label, kind }));
  return {
    catalog: catalog.reference,
    concepts: [...collect(catalog.entities, "entity"), ...collect(catalog.relations, "relation"),
      ...collect(catalog.definitions, "definition")],
    definitions: catalog.definitions.filter(mentions).map(definitionReference),
  };
}

const UTC_STAMP = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z/g;
const TWO_UTC_DATES = /(?:在\s*)?\[utc\]\s*(?:到|至|and|to|~|—)\s*\[utc\](?:\s*utc)?(?:\s*(?:之间的|区间内|时间窗内|之间|以内|期间|内|的))?/u;
const SELECTED_LEAD = /(?:(?:本次)?所选|当前选中|这笔)商机/u;
const EXPLICIT_WINDOW = /(?:在)?(?:指定|给定|明确)\s*(?:utc\s*)?(?:时间窗|窗口|时间窗口|时间范围)内(?:的)?/u;
const SELECTED_LEAD_PREFIX = new RegExp(`^${SELECTED_LEAD.source}(?:的)?\\s*`, "u");
const EXPLICIT_WINDOW_PREFIX = new RegExp(`^${EXPLICIT_WINDOW.source}\\s*`, "u");

// Only remove reviewed request wrappers. Keep business filters, negations,
// unfamiliar qualifiers, and disjoint requests so they prevent template selection.
function questionKey(text: string): string {
  return normalize(text)
    .replace(/^(?:请(?:帮我)?\s*)?(?:列出|查询|查看|看一下|显示|查找|找出|告诉我|我想知道)\s*/u, "")
    .replace(/^请\s*/u, "")
    .replace(/^(?:在\s*)?(?:当前\s*)?(?:已)?授权范围内(?:的)?[,:、\s]*/u, "")
    .replace(/^(?:当前\s*)?(?:crm\s*)?(?:中|里)?\s*(?:当前|目前)?\s*/u, "")
    .replace(SELECTED_LEAD_PREFIX, "")
    .replace(EXPLICIT_WINDOW_PREFIX, "")
    .replace(TWO_UTC_DATES, "")
    .replace(/^\s*的\s*/u, "")
    .replace(/(?:记录|列表|有哪些|都有哪些|是什么)+[。.!?？]*$/u, "")
    .replace(/[。.!?？]+$/u, "")
    .replace(/(\p{Script=Han})\s+(?=\p{Script=Han})/gu, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function matchesQuestion(question: string, catalog: OntologyCatalog): OntologyTemplate | undefined {
  const key = questionKey(question.replace(UTC_STAMP, "[utc]"));
  return catalog.definitions.find(definition => definition.template &&
    [...definition.aliases, ...definition.questions].some(phrase => questionKey(phrase) === key),
  )?.template ?? undefined;
}

/** Permission cannot be inferred from this plan. SQL rechecks persisted scope and membership. */
export function planOntologyQuery(input: unknown, scope: OntologyQueryScope, catalog = getOntologyCatalog()): OntologyQueryPlan {
  const parsed = queryInput.safeParse(input);
  const terms = resolveOntologyTerms(parsed.data?.question ?? "", catalog);
  function clarify(reason: OntologyPlanRejectionReason, missing: string[]) {
    return { ...terms, status: "clarification_required" as const, reason, missing };
  }
  if (!parsed.success) return clarify("invalid_input", ["请提供一个问题或许可查询名称。时间条件仅接受 UTC 起止点。"]);

  const { question, template: requestedTemplate, startUtc, endUtc } = parsed.data;
  const hasUndefinedTerms = terms.definitions.filter(definition => definition.status === "undefined");
  if (hasUndefinedTerms.length) {
    return clarify("missing_definition", catalog.definitions
      .filter(definition => hasUndefinedTerms.some(term => term.id === definition.id))
      .flatMap(definition => definition.missing));
  }
  const questionTemplate = question ? matchesQuestion(question, catalog) : undefined;
  const explicit = templateSchema.safeParse(requestedTemplate);
  if ((question && !questionTemplate) || (requestedTemplate && !explicit.success)) {
    return clarify("unsupported_question", ["当前问题的完整条件不对应已审核的查询。请明确口径和需要保留的筛选条件。"]);
  }
  if (explicit.success && questionTemplate && explicit.data !== questionTemplate) {
    return clarify("conflicting_conditions", ["指定查询与问题里的业务口径不同，请确认要查询的口径。"]);
  }
  const template = questionTemplate ?? explicit.data;
  if (!template) return clarify("unsupported_question", ["请指定一个已审核的业务口径。"]);

  const ids = new Set<OntologyDefinitionId>([template]);
  for (const id of ids) {
    const definition = catalog.definitions.find(item => item.id === id);
    if (!definition || definition.template !== id || definition.status !== "reviewed") {
      if (definition && !terms.definitions.some(term => term.id === id)) terms.definitions.push(definitionReference(definition));
      return clarify("definition_disabled", ["该查询所需的业务口径当前未启用，无法按此口径执行。"]);
    }
    for (const dependency of definition.dependencies) ids.add(dependency);
  }
  const definitions = catalog.definitions.filter(definition => ids.has(definition.id)).map(definitionReference);
  terms.definitions = definitions;
  if ((template === "completed_appointments" || SELECTED_LEAD.test(normalize(question ?? ""))) && !scope.leadId) {
    return clarify("scope_required", ["请在工作台明确选择一笔可读商机。"]);
  }
  const datesInQuestion = question?.match(UTC_STAMP) ?? [];
  const permittedResult = { ...terms, status: "allowed" as const, limit: catalog.limits.rows };
  if (template === "open_leads") {
    if (startUtc !== undefined || endUtc !== undefined || datesInQuestion.length ||
      EXPLICIT_WINDOW.test(normalize(question ?? ""))) {
      return clarify("conflicting_conditions", ["开放商机口径适用于当前状态，没有历史时间筛选。请确认所需范围。"]);
    }
    return { ...permittedResult, template, window: null };
  }

  const window = parseOntologyWindow(startUtc ?? datesInQuestion[0], endUtc ?? datesInQuestion[1]);
  const questionWindow = datesInQuestion.length === 2 ? parseOntologyWindow(datesInQuestion[0], datesInQuestion[1]) : null;
  if (!window || (datesInQuestion.length > 0 && !questionWindow)) {
    return clarify("invalid_window", ["请给出明确的 UTC 起止时间，使用含 Z 的 ISO 8601，且窗口最多 31 天。"]);
  }
  if (questionWindow && (ontologyUtcMicroseconds(questionWindow.startUtc) !== ontologyUtcMicroseconds(window.startUtc) ||
    ontologyUtcMicroseconds(questionWindow.endUtc) !== ontologyUtcMicroseconds(window.endUtc))) {
    return clarify("conflicting_conditions", ["查询参数与问题中的 UTC 时间窗不一致，请确认原始起止时间。"]);
  }
  return { ...permittedResult, template, window };
}
