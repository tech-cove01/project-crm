import { normalizeKnowledgeEvidence } from "@/lib/ai/knowledge/evidence";

export interface PolicyRequirement {
  query: string;
  allowEmpty: boolean;
  legacy?: true;
}

const title = String.raw`《([^《》\r\n]{1,180})》`;
const quotedTerm = String.raw`[“"]([^“”"\r\n]{1,180})[”"]`;
const legacySearch = new RegExp(`^产品原文使用企业知识搜索词${quotedTerm}。(?:(若正常检索没有匹配，按缺证项留空。)$)?`);
const legacyAbsence = "该政策项只核验是否存在。授权资料正常检索无匹配时，明确留空并回答其余已核实字段。";
const twoTitles = new RegExp(
  `^请(?:分别)?(?:核对|查阅|查询)\\s*${title}\\s*(?:以及|和|与|及|、)\\s*${title}(?=\\s*[,，;；]|\\s*$)`,
);
const titleAndCheck = new RegExp(
  `^请(?:核对|查阅|查询)\\s*${title}\\s*[,，]\\s*并(?:查|核验)\\s*${quotedTerm}\\s*是否有授权依据` +
    `(?=\\s*[,，;；]|\\s*$)(\\s*[;；]\\s*(?:如果|若)(?:查不到|没有匹配)[,，]?\\s*(?:请)?(?:如实|明确)?说明)?`,
);

const quotes = new Map([
  ["“", "”"], ["‘", "’"], ["「", "」"], ["『", "』"], ['"', '"'], ["`", "`"], ["《", "》"],
]);

function taskClauses(task: string): { text: string; line: string | undefined }[] {
  const clauses: { text: string; line: string | undefined }[] = [];
  let from = 0;
  let closingQuote: string | undefined;
  for (let i = 0; i <= task.length; i += 1) {
    const char = task[i];
    if (char !== undefined && closingQuote) {
      if (char === closingQuote) closingQuote = undefined;
      continue;
    }
    if (char !== undefined && quotes.has(char)) {
      closingQuote = quotes.get(char);
      continue;
    }
    if (char !== undefined && !/[。！？!?\r\n]/.test(char)) continue;
    const text = task.slice(from, i).trim();
    if (text) {
      const lineStart = task.lastIndexOf("\n", from - 1) + 1;
      const lineEnd = task.indexOf("\n", from);
      const line = task.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
      clauses.push({ text, line: line.startsWith(text) ? line : undefined });
    }
    from = i + 1;
  }
  return clauses;
}

const compareTopic = (query: string) => query.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

export function policyRequirements(task: string): PolicyRequirement[] {
  // A pasted historical excerpt can start on the line after its introduction.
  const clauses = taskClauses(task).filter((_, index, all) =>
    !/(?:旧备注|旧说明|原文|手记|转述|引用)[^：:]*[：:]$/.test(all[index - 1]?.text ?? ""));
  const candidates: PolicyRequirement[][] = [];
  const mentionedTitles = [...task.matchAll(new RegExp(title, "g"))].length;
  for (const { text, line } of clauses) {
    const legacy = line?.startsWith("产品原文使用企业知识搜索词") ? legacySearch.exec(line) : null;
    if (legacy) {
      const [, query, absence] = legacy;
      if (query === undefined) return [];
      candidates.push([{ query: query.trim(), allowEmpty: Boolean(absence) ||
        clauses.some(clause => clause.line === legacyAbsence), legacy: true }]);
      continue;
    }
    const named = titleAndCheck.exec(text) ?? twoTitles.exec(text);
    if (named) {
      const [match, first, second, absence] = named;
      if (match === undefined || first === undefined || second === undefined ||
        mentionedTitles > 2 || /[《“"「『]/.test(text.slice(match.length))) return [];
      candidates.push([
        { query: first.trim(), allowEmpty: false },
        { query: second.trim(), allowEmpty: Boolean(absence) },
      ]);
    }
  }
  const requirements = candidates[0] ?? [];
  const topics = requirements.map(requirement => compareTopic(requirement.query));
  return candidates.length === 1 && topics.every(Boolean) && new Set(topics).size === topics.length ? requirements : [];
}

export function policySearchQuestion(original: unknown, requirements: readonly PolicyRequirement[]): string | undefined {
  const [first] = requirements;
  if (requirements.length === 1 && first?.legacy) return first.query;
  if (typeof original !== "string") return undefined;
  if (!requirements.length || requirements.length > 2) return original;
  const question = compareTopic(original);
  const contained = requirements.filter(requirement => question.includes(compareTopic(requirement.query)));
  const [topic] = contained;
  return contained.length === 1 && topic ? topic.query : original;
}

type PolicyObservation = { failed: boolean; value: unknown };
type PolicyEvidenceStatus = { state: "complete" | "missing" | "unavailable"; verifiedEmpty: string[] };

export function policyObservationStatus({ requirements, observations, allowedSourceIds }: {
  requirements: readonly PolicyRequirement[];
  observations: readonly PolicyObservation[];
  allowedSourceIds: readonly string[];
}): PolicyEvidenceStatus {
  const matched = new Set<string>();
  const verified = new Set<string>();
  let genericEmpty = false;
  for (const observation of observations) {
    const value = observation.value as {
      retrieval?: { query?: string; status?: string; wiki_status?: string; missing?: unknown; empty_verified?: boolean };
      evidence?: unknown;
      trechos?: unknown;
    } | null;
    const retrieval = value?.retrieval;
    if (observation.failed || !retrieval ||
        (retrieval.missing !== undefined && (!Array.isArray(retrieval.missing) || retrieval.missing.length > 0)) ||
        !["complete", "empty", "disabled"].includes(retrieval.wiki_status ?? "") ||
        (retrieval.status !== "complete" && retrieval.status !== "empty"))
      return { state: "unavailable", verifiedEmpty: [] };
    if (!requirements.length) {
      genericEmpty ||= retrieval.status === "empty";
      continue;
    }
    const requirement = requirements.find(item => item.query === retrieval.query);
    if (!requirement) continue;
    if (retrieval.status === "empty") {
      if (!Array.isArray(value?.evidence) || value.evidence.length || !Array.isArray(value?.trechos) || value.trechos.length)
        return { state: "unavailable", verifiedEmpty: [] };
      if (requirement.allowEmpty && retrieval.wiki_status === "empty" && retrieval.empty_verified === true)
        verified.add(requirement.query);
    } else {
      const authorized = normalizeKnowledgeEvidence(value).some(item => item.namespace === "organization_wiki" &&
        item.excerpt.trim().length > 0 && allowedSourceIds.includes(item.locator.sourceId));
      if (!authorized) return { state: "unavailable", verifiedEmpty: [] };
      matched.add(requirement.query);
    }
  }
  if (genericEmpty || requirements.some(({ query }) => !matched.has(query) && !verified.has(query)))
    return { state: "missing", verifiedEmpty: [] };
  return { state: "complete", verifiedEmpty: [...verified].filter(query => !matched.has(query)) };
}
