import { describe, expect, it } from "vitest";
import { escapeWikiRegex, matchesWikiKeywords, planWikiQuery } from "./wiki-query";

const longQuery = "Pi Native CRM 的客户记忆由什么服务提供向量检索，数据库是否是事实来源？";
const noAnswerQuery = "火星基地量子电池的政府采购合同编号是什么？";

describe("natural-language Wiki query boundaries", () => {
  it("escapes regex syntax and keeps non-Han queries literal-only", () => {
    const query = ".*|[fake](a+)?\\$^{}";
    const plan = planWikiQuery(query);
    expect(new RegExp(`^${plan.literal}$`).test(query)).toBe(true);
    expect(new RegExp(plan.literal).test("unrelated published product page")).toBe(false);
    expect(plan).toMatchObject({ terms: [], fallback: null });
    expect(escapeWikiRegex("产品.*[未知")).toBe("产品\\.\\*\\[未知");
  });

  it("extracts bounded meaningful terms and counts a Latin brand phrase as one", () => {
    const plan = planWikiQuery(longQuery);
    expect(plan.terms[0]).toBe("Pi Native CRM");
    expect(plan.terms).not.toContain("Pi");
    expect(plan.terms).not.toContain("Native");
    expect(plan.terms).not.toContain("CRM");
    expect(plan.terms).not.toEqual(expect.arrayContaining(["什么", "服务", "提供", "是否"]));
    expect(plan.terms.length).toBeLessThanOrEqual(6);
    expect(matchesWikiKeywords(["Pi Native CRM", "客户记忆由向量检索服务支持"], plan.terms)).toBe(true);
    expect(matchesWikiKeywords(["Pi Native CRM", "Pi Native CRM", "Pi Native CRM"], plan.terms)).toBe(false);
  });

  it("does not turn the fixed no-answer question or generic product query into broad retrieval", () => {
    const plan = planWikiQuery(noAnswerQuery);
    expect(plan.terms.length).toBeGreaterThan(1);
    expect(matchesWikiKeywords(["Pi Native CRM 产品资料", "人工确认与客户记忆"], plan.terms)).toBe(false);
    expect(planWikiQuery("请查询公司产品相关资料").fallback).toBeNull();
    expect(planWikiQuery("产品").fallback).toBeNull();
  });

  it("requires distinct terms and refuses Latin partial-word matches", () => {
    expect(matchesWikiKeywords(["pipeline stores customerish records"], ["Pi", "customer"])).toBe(false);
    expect(matchesWikiKeywords(["使用Pi存储customer记录"], ["Pi", "customer"])).toBe(true);
    expect(matchesWikiKeywords(["记忆", "记忆", "记忆"], ["记忆", "向量"])).toBe(false);
    expect(matchesWikiKeywords(["客户记忆"], ["记忆"])).toBe(true);
    expect(matchesWikiKeywords(["客户记忆"], [])).toBe(false);
  });

  it("bounds input before planning and deduplicates query terms", () => {
    expect(planWikiQuery(`${"x".repeat(2000)}客户记忆`).terms).toEqual([]);
    expect(planWikiQuery("客户 客户 记忆 记忆").terms).toEqual(["客户", "记忆"]);
  });
});
