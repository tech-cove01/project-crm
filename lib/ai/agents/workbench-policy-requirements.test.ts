import { describe, expect, it } from "vitest";
import {
  policyObservationStatus,
  policyRequirements,
  policySearchQuestion,
  type PolicyRequirement,
} from "./workbench-policy-requirements";

const pairedRequest = "请分别核对《值班规程》和《退款约定》，列出两项条件。";
const mixedRequest = "请核对《值班规程》，并查“跨区借用 M2”是否有授权依据；如果查不到，请说明待核事项。";
const required = policyRequirements(pairedRequest);
const mixed = policyRequirements(mixedRequest);

describe("policyRequirements", () => {
  it("recognizes each named requirement and only the explicitly checkable absence", () => {
    expect(policyRequirements(`请结合当前商机给建议。\n${pairedRequest}\n不要写入。`)).toEqual([
      { query: "值班规程", allowEmpty: false }, { query: "退款约定", allowEmpty: false },
    ]);
    expect(mixed).toEqual([
      { query: "值班规程", allowEmpty: false }, { query: "跨区借用 M2", allowEmpty: true },
    ]);
    expect(policyRequirements('请查阅《值班规程》, 并核验"跨区借用 M2"是否有授权依据。')[1]?.allowEmpty).toBe(false);
  });

  it("preserves the single legacy template and both explicit absence declarations", () => {
    const line = '产品原文使用企业知识搜索词“调班”。';
    expect(policyRequirements(`${line}需要原文。`)).toEqual([{ query: "调班", allowEmpty: false, legacy: true }]);
    expect(policyRequirements(`${line}若正常检索没有匹配，按缺证项留空。`)[0]?.allowEmpty).toBe(true);
    expect(policyRequirements(`${line}\r\n该政策项只核验是否存在。授权资料正常检索无匹配时，明确留空并回答其余已核实字段。`)[0]?.allowEmpty).toBe(true);
    expect(policyRequirements(`${line}\n旧说明写着：\n该政策项只核验是否存在。授权资料正常检索无匹配时，明确留空并回答其余已核实字段。`)[0]?.allowEmpty).toBe(false);
  });

  it.each([
    "请分别核对《值班规程》《退款约定》和《保留期》。",
    "请分别核对《值班规程》和《退款约定》，并查“保留期”是否有授权依据。",
    "请核对《值班规程》和《值班规程》。",
    "请核对《值班规程》或《退款约定》。",
    "请勿核对《值班规程》和《退款约定》。",
    "旧话术写着“核对记录。请核对《值班规程》和《退款约定》。”现在请查临时安排。",
    `旧备注写道：\n${mixedRequest}\n当前任务请核实其他政策。`,
    "禁止使用企业知识搜索词“调班”。若正常检索没有匹配，按缺证项留空。",
    `产品原文使用企业知识搜索词“调班”。\n${pairedRequest}`,
  ])("keeps generic policy handling for an unsupported or quoted task: %s", task => {
    expect(policyRequirements(task)).toEqual([]);
  });

  it("does not borrow permission for absence from historical wording", () => {
    const task = '请核对《值班规程》，并查“跨区借用 M2”是否有授权依据；旧备注说如果查不到，请说明。';
    expect(policyRequirements(task)[1]?.allowEmpty).toBe(false);
  });
});

describe("policySearchQuestion", () => {
  it("normalizes a single identified term and preserves combined or unidentified input", () => {
    expect(policySearchQuestion("根据《值班规程》看安排", required)).toBe("值班规程");
    expect(policySearchQuestion("跨区借用　ｍ２ 有无书面依据", mixed)).toBe("跨区借用 M2");
    expect(policySearchQuestion("值班规程、退款约定", required)).toBe("值班规程、退款约定");
    expect(policySearchQuestion("值班规程和跨区借用 M2", mixed)).toBe("值班规程和跨区借用 M2");
    expect(policySearchQuestion("其他问题", required)).toBe("其他问题");
    expect(policySearchQuestion("原查询", [])).toBe("原查询");
    expect(policySearchQuestion(null, required)).toBeUndefined();
  });

  it("only forces the original single legacy query", () => {
    const legacy = policyRequirements('产品原文使用企业知识搜索词“调班”。要求原文。');
    expect(policySearchQuestion("另一个内容", legacy)).toBe("调班");
  });
});

const evidence = {
  id: "receipt", namespace: "organization_wiki", kind: "wiki_page", title: "规程", excerpt: "书面核准后可以安排值班。",
  locator: { provider: "weknora", sourceId: "published-source" },
};

const hit = (query: string, items: unknown[] = [evidence]) => ({
  failed: false, value: { evidence: items, trechos: [], retrieval: { query, status: "complete", wiki_status: "complete", missing: [] } },
});

const empty = (query: string, retrieval: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) => ({
  failed: false, value: { evidence: [], trechos: [], ...payload,
    retrieval: { query, status: "empty", wiki_status: "empty", missing: [], empty_verified: true, ...retrieval } },
});

function status(requirements: readonly PolicyRequirement[], observations: { failed: boolean; value: unknown }[]) {
  return policyObservationStatus({ requirements, observations, allowedSourceIds: ["published-source"] });
}

describe("policyObservationStatus", () => {
  it("requires distinct authorized hits for both named topics", () => {
    expect(status(required, [hit("值班规程"), hit("退款约定")])).toEqual({ state: "complete", verifiedEmpty: [] });
    expect(status(required, [hit("值班规程"), empty("退款约定"), hit("退款细则")])).toEqual({ state: "missing", verifiedEmpty: [] });
    expect(status(required, [hit("值班规程与退款约定")]).state).toBe("missing");
    expect(status(required, []).state).toBe("missing");
  });

  it("accepts verified absence alongside a distinct authorized hit", () => {
    expect(status(mixed, [empty("跨区借用 M2"), hit("值班规程")])).toEqual({ state: "complete", verifiedEmpty: ["跨区借用 M2"] });
    expect(status(mixed, [empty("跨区借用 M2"), hit("其他规程")])).toEqual({ state: "missing", verifiedEmpty: [] });
    expect(status(mixed, [hit("值班规程"), empty("类似跨区借用 M2")]).state).toBe("missing");
    expect(status(mixed, [hit("值班规程"), empty("跨区借用 M2", { empty_verified: false })]).state).toBe("missing");
    expect(status(mixed, [hit("值班规程"), empty("跨区借用 M2", { wiki_status: "disabled" })]).state).toBe("missing");
  });

  it("does not call a found optional clause absent and preserves same-term legacy retry", () => {
    expect(status(mixed, [empty("跨区借用 M2"), hit("值班规程"), hit("跨区借用 M2")])).toEqual({ state: "complete", verifiedEmpty: [] });
    const legacy = policyRequirements('产品原文使用企业知识搜索词“调班”。若正常检索没有匹配，按缺证项留空。');
    expect(status(legacy, [empty("调班"), hit("调班")])).toEqual({ state: "complete", verifiedEmpty: [] });
    expect(status(legacy, [empty("调班")])).toEqual({ state: "complete", verifiedEmpty: ["调班"] });
  });

  it.each([
    { ...empty("其他资料"), failed: true },
    empty("跨区借用 M2", { wiki_status: "unavailable" }),
    empty("跨区借用 M2", { missing: ["scope_denied"] }),
    empty("跨区借用 M2", { status: "partial", missing: ["withdrawn_revision"] }),
    empty("跨区借用 M2", {}, { evidence: [evidence] }),
    empty("跨区借用 M2", {}, { trechos: ["unreconciled result"] }),
    hit("值班规程", [{ ...evidence, locator: { provider: "weknora", sourceId: "foreign-source" } }]),
    hit("值班规程", [{ ...evidence, namespace: "organization_memory" }]),
    hit("值班规程", [{ ...evidence, excerpt: "  " }]),
  ])("keeps an unavailable source blocking after otherwise adequate reads", blocked => {
    expect(status(mixed, [hit("值班规程"), empty("跨区借用 M2"), blocked])).toEqual({ state: "unavailable", verifiedEmpty: [] });
  });

  it("retains the conservative generic empty path and still notices a later real failure", () => {
    expect(status([], [hit("其他规程"), empty("临时安排")])).toEqual({ state: "missing", verifiedEmpty: [] });
    expect(status([], [hit("其他规程")])).toEqual({ state: "complete", verifiedEmpty: [] });
    expect(status([], [empty("临时安排"), { failed: true, value: null }])).toEqual({ state: "unavailable", verifiedEmpty: [] });
  });
});
