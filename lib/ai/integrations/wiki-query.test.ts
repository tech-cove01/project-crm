import { describe, expect, it } from "vitest";
import { escapeWikiRegex, planWikiQuery, supportsWikiQuery } from "./wiki-query";

const longQuery = "Pi Native CRM 的客户记忆由什么服务提供向量检索，数据库是否是事实来源？";
const noAnswerQuery = "火星基地量子电池的政府采购合同编号是什么？";

describe("natural-language Wiki query boundaries", () => {
  it("escapes regex syntax and keeps non-Han queries literal-only", () => {
    const query = ".*|[fake](a+)?\\$^{}";
    const plan = planWikiQuery(query);
    expect(new RegExp(`^${plan.literal}$`).test(query)).toBe(true);
    expect(new RegExp(plan.literal).test("unrelated published product page")).toBe(false);
    expect(plan).toMatchObject({ terms: [], supportTerms: [], supportComplete: true, fallback: null });
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
    expect(supportsWikiQuery(["Pi Native CRM", "客户记忆由向量检索服务支持，数据库是事实来源。"], plan)).toBe(true);
    expect(supportsWikiQuery(["Pi Native CRM", "Pi Native CRM", "Pi Native CRM"], plan)).toBe(false);
  });

  it("does not turn the fixed no-answer question or generic product query into broad retrieval", () => {
    const plan = planWikiQuery(noAnswerQuery);
    expect(plan.terms.length).toBeGreaterThan(1);
    expect(supportsWikiQuery(["Pi Native CRM 产品资料", "人工确认与客户记忆"], plan)).toBe(false);
    expect(planWikiQuery("请查询公司产品相关资料").fallback).toBeNull();
    expect(planWikiQuery("产品").fallback).toBeNull();
    expect(planWikiQuery("产品14天").fallback).toBeNull();
    expect(planWikiQuery("产品1").fallback).toBeNull();
  });

  it("requires distinct terms and refuses Latin partial-word matches", () => {
    const mixed = planWikiQuery("设备 Pi customer");
    expect(supportsWikiQuery(["设备 pipeline stores customerish records"], mixed)).toBe(false);
    expect(supportsWikiQuery(["设备使用Pi customer记录"], mixed)).toBe(true);
    expect(supportsWikiQuery(["记忆", "记忆", "记忆"], planWikiQuery("记忆向量"))).toBe(false);
    expect(supportsWikiQuery(["客户记忆"], planWikiQuery("记忆"))).toBe(true);
    expect(supportsWikiQuery(["客户记忆"], planWikiQuery(""))).toBe(false);
  });

  it("bounds input before planning and deduplicates query terms", () => {
    expect(planWikiQuery(`${"x".repeat(2000)}客户记忆`).terms).toEqual([]);
    expect(planWikiQuery(`设备维护${" ".repeat(2000)}新约束`).fallback).toBeNull();
    expect(planWikiQuery("客户 客户 记忆 记忆").terms).toEqual(["客户", "记忆"]);
  });

  it("keeps later constraints for lexical support while limiting candidate discovery to six terms", () => {
    const plan = planWikiQuery("客户记忆向量检索事实来源保留引用自动归档周期");
    expect(plan.terms).toHaveLength(6);
    expect(plan.supportTerms.length).toBeGreaterThan(6);
    expect(supportsWikiQuery([plan.terms.join(" ")], plan)).toBe(false);
    expect(supportsWikiQuery([plan.supportTerms.join(" ")], plan)).toBe(true);
  });

  it("requires every non-generic support term rather than any two topical matches", () => {
    const plan = planWikiQuery("设备维护周期说明");
    expect(supportsWikiQuery(["设备维护说明，不涉及具体周期。"], plan)).toBe(true);
    // Negation still contains the terms: this gate is lexical coverage, not semantic entailment.
    expect(supportsWikiQuery(["设备维护说明"], plan)).toBe(false);
    expect(supportsWikiQuery(["设备", "维护", "周期"], plan)).toBe(true);
    expect(supportsWikiQuery(["任意正文"], planWikiQuery("公司产品相关资料"))).toBe(false);
  });

  it("does not treat a shared topic as support for a missing attribute", () => {
    const plan = planWikiQuery("设备保修的自动续约周期是多少？");
    expect(supportsWikiQuery(["设备保修", "保修设备可自动提醒，检查周期为一个月。"], plan)).toBe(false);
    expect(supportsWikiQuery(["设备保修", "保修自动续约周期为一年。"], plan)).toBe(true);
    expect(plan.supportTerms).not.toContain("多少");
  });

  it("keeps substantive constraints when normalizing question scaffolding and architecture terminology", () => {
    const plan = planWikiQuery("设备框架使用要求上有什么区别，哪些操作明确禁止？");
    expect(plan.supportTerms).not.toEqual(expect.arrayContaining(["使用", "要求", "上有", "区别"]));
    expect(plan.supportTerms).toEqual(expect.arrayContaining(["架构", "禁止"]));
    expect(supportsWikiQuery(["设备架构；明确不允许这些操作。"], plan)).toBe(false);
  });

  it("preserves case-insensitive Latin boundaries and leaves non-Han questions literal-only", () => {
    const plan = planWikiQuery("Acme Cloud 设备归档周期");
    expect(supportsWikiQuery(["ACME CLOUD", "设备归档周期为两周。"], plan)).toBe(true);
    expect(supportsWikiQuery(["ACME CLOUDS", "设备归档周期为两周。"], plan)).toBe(false);
    expect(planWikiQuery("Acme Cloud retention period")).toMatchObject({ supportTerms: [], fallback: null });
  });

  it("preserves supported long questions and refuses partial Latin names", () => {
    const plan = planWikiQuery(longQuery);
    expect(supportsWikiQuery(["Pi Native CRM", "客户记忆由向量检索支持，数据库是事实来源。"], plan)).toBe(true);
    expect(supportsWikiQuery(["Pi Native CRMs", "客户记忆向量检索事实来源"], plan)).toBe(false);
  });

  it("disables fallback if support cannot be fully represented within the term budget", () => {
    const plan = planWikiQuery(Array.from({ length: 33 }, (_, index) => `词汇 Brand${index}`).join("，"));
    expect(plan.supportComplete).toBe(false);
    expect(plan.supportTerms).toHaveLength(32);
    expect(plan.fallback).toBeNull();
    expect(supportsWikiQuery([plan.supportTerms.join(" ")], plan)).toBe(false);
  });

  it("normalizes architecture terminology without dropping the operation or a missing property", () => {
    expect(supportsWikiQuery(["设备架构执行多步工具调用。"], planWikiQuery("设备多步工具调用框架"))).toBe(true);
    expect(supportsWikiQuery(["设备架构执行单步工具调用。"], planWikiQuery("设备多步工具调用框架"))).toBe(false);
    expect(supportsWikiQuery(["设备架构执行多步工具调用。"], planWikiQuery("设备多步工具调用框架保修周期"))).toBe(false);
  });

  it("normalizes directional data transfer and beneficiary grammar while preserving missing attributes", () => {
    const query = "备份工具能否替用户把文件全自动搬过去？";
    const plan = planWikiQuery(query);
    expect(plan.supportTerms).toContain("迁移");
    expect(plan.supportTerms).not.toEqual(expect.arrayContaining(["用户", "过去"]));
    expect(supportsWikiQuery(["备份工具支持文件自动迁移。"], plan)).toBe(true);
    expect(supportsWikiQuery(["备份工具支持文件自动迁移。"], planWikiQuery(`${query}自动删除周期`))).toBe(false);
    expect(planWikiQuery("运输工具能否替用户把家具自动搬过去？").supportTerms).not.toContain("迁移");
    expect(supportsWikiQuery(["运输工具支持文件自动迁移。"], planWikiQuery("运输工具能否替用户把家具自动搬过去？"))).toBe(false);
    expect(planWikiQuery("用户记忆保存范围").supportTerms).toContain("用户");
  });

  it("uses a blanket negative communication policy for a requested outbound subchannel only in a permission question", () => {
    const title = "设备资料导出政策";
    const body = "设备资料导出须等待人工明确决定后执行。本政策不授权外部消息。";
    const query = "设备资料导出政策是否允许直接外发电子邮件？";
    const plan = planWikiQuery(query);
    expect(plan.permissionQuestion).toBe(true);
    expect(plan.supportTerms).toContain("邮件");
    expect(supportsWikiQuery([title, body], plan)).toBe(true);
    expect(supportsWikiQuery([title, "设备资料导出支持外部消息，须等待人工明确决定后执行。"], plan)).toBe(false);
    expect(supportsWikiQuery([title, body], planWikiQuery("设备资料导出的邮件加密协议"))).toBe(false);
    expect(supportsWikiQuery(["设备间接加热温度"], planWikiQuery("设备直接加热温度"))).toBe(false);
  });

  it.each([
    "本政策不授权外部消息，但指定账户除外。",
    "如果未经批准，本政策不授权外部消息。",
    "当获得许可时，本政策不授权外部消息。",
    "本政策不授权外部消息，获批后可外发。",
    "本政策并非不授权外部消息。",
    "本政策不禁止外部消息。",
    "本政策不授权外部消息。外部消息属于例外。",
    "本政策不授权外部消息。本政策允许外发消息。",
  ])("does not infer blanket channel coverage from a conditional or negated policy: %s", policy => {
    const fields = ["设备资料导出政策", `设备资料导出须等待人工明确决定后执行。${policy}`];
    expect(supportsWikiQuery(fields, planWikiQuery("设备资料导出政策是否允许直接外发邮件？"))).toBe(false);
  });

  it("retains dates, units and one-character quantities as strong constraints", () => {
    expect(supportsWikiQuery(["设备保修14天。"], planWikiQuery("设备保修14 天"))).toBe(true);
    expect(supportsWikiQuery(["设备保修14次。"], planWikiQuery("设备保修14天"))).toBe(false);
    expect(supportsWikiQuery(["设备保修140天。"], planWikiQuery("设备保修14天"))).toBe(false);
    expect(supportsWikiQuery(["设备培训十三场。"], planWikiQuery("设备培训三场"))).toBe(false);
    expect(supportsWikiQuery(["设备培训三场。"], planWikiQuery("设备培训三场"))).toBe(true);
    expect(supportsWikiQuery(["设备保修2027年11月1日结束。"], planWikiQuery("设备保修2026年11月1日"))).toBe(false);
  });

  it("treats a count as an enumeration operator only immediately after an explicit interrogative", () => {
    expect(planWikiQuery("哪些三类设备内容明确禁止上传？").supportTerms).not.toContain("三类");
    expect(planWikiQuery("哪3种设备内容明确禁止上传？").supportTerms).not.toContain("3种");
    const property = planWikiQuery("哪些设备最多支持三类文件？");
    expect(property.supportTerms).toContain("三类");
    expect(supportsWikiQuery(["设备最多支持两类文件。"], property)).toBe(false);
    expect(supportsWikiQuery(["设备最多支持三类文件。"], property)).toBe(true);
  });

  it.each(["三场", "14天", "14 天", "3种", "2026年"])("does not use a quantity-only query as a topic: %s", query => {
    const plan = planWikiQuery(query);
    expect(plan).toMatchObject({ hasTopic: false, fallback: null });
    expect(supportsWikiQuery([query], plan)).toBe(false);
    const withTopic = planWikiQuery(`设备培训${query}`);
    expect(withTopic.hasTopic).toBe(true);
    expect(withTopic.fallback).not.toBeNull();
    expect(supportsWikiQuery([`设备培训${query}`], withTopic)).toBe(true);
  });
});
