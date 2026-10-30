// The Wiki endpoint accepts a PostgreSQL regex; CRM callers supply natural language.
const genericWords = new Set([
  "一下", "什么", "哪些", "怎么", "如何", "为何", "哪里", "是否", "能否", "有没有", "请问",
  "帮忙", "帮我", "我们", "你们", "这个", "那个", "这些", "那些", "关于", "相关", "以及",
  "查询", "查找", "查看", "告诉", "介绍", "提供", "回答", "说明", "需要", "可以", "进行",
  "公司", "企业", "产品", "服务", "系统", "资料", "信息", "数据", "知识", "知识库",
  "内容", "情况", "结果", "答案", "问题", "当前", "现有", "所有", "本次",
  // Question operators and request scaffolding, not domain attributes or synonyms.
  "当作", "使用", "要求", "区别", "上有", "哪种", "多少", "几天",
  "a", "an", "the", "and", "or", "of", "to", "for", "what", "which", "how", "is", "are", "please", "crm",
]);

export function escapeWikiRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function keywordPattern(term: string): string {
  const literal = escapeWikiRegex(term);
  // Han can adjoin a Latin name, but another Latin word must not partially match it.
  return /[a-z0-9]/i.test(term)
    ? `(^|[^A-Za-z0-9_])${literal}($|[^A-Za-z0-9_])`
    : literal;
}

export function planWikiQuery(query: string) {
  const bounded = query.slice(0, 2000);
  const supportTerms: string[] = [];
  let supportComplete = query.length <= bounded.length;
  if (/\p{Script=Han}/u.test(bounded)) {
    const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
    // Preserve a contiguous Latin phrase as one term rather than counting its words as independent hits.
    const runs = bounded.match(/[\p{Script=Han}]+|[a-z0-9]+(?:[ \t_-]+[a-z0-9]+)*/giu) ?? [];
    const seen = new Set<string>();
    for (const run of runs) {
      const words = /\p{Script=Han}/u.test(run)
        ? [...segmenter.segment(run)].filter(word => word.isWordLike).map(word => word.segment)
        : [run.replace(/[ \t]+/g, " ")];
      for (const word of words) {
        const key = word.toLowerCase();
        if (word.length < 2 || genericWords.has(key) || seen.has(key) || /^\d+$/.test(word)) continue;
        seen.add(key);
        if (supportTerms.length === 32) {
          supportComplete = false;
          break;
        }
        supportTerms.push(word);
      }
      if (!supportComplete) break;
    }
  }
  // Candidate discovery stays small; support checks must not lose later constraints.
  const terms = supportTerms.slice(0, 6);
  return {
    literal: escapeWikiRegex(bounded),
    terms,
    supportTerms,
    supportComplete,
    fallback: supportComplete && terms.length ? `(${terms.map(keywordPattern).join("|")})` : null,
  };
}

/** Lexical coverage only: matching every term does not establish an answer's truth or completeness. */
export function supportsWikiQuery(fields: string[], plan: ReturnType<typeof planWikiQuery>): boolean {
  return plan.supportComplete && plan.supportTerms.length > 0 && plan.supportTerms.every(term => {
    const pattern = new RegExp(keywordPattern(term), "iu");
    return fields.some(field => pattern.test(field));
  });
}
