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
  if (/^[〇零一二两三四五六七八九十百千万]+(?:年|月|日|天|小时|分钟|秒|元|个|条|场|次|席|人|类|种)$/.test(term))
    return `(^|[^〇零一二两三四五六七八九十百千万0-9])${literal}`;
  // Han can adjoin a Latin name, but another Latin word must not partially match it.
  return /[a-z0-9]/i.test(term)
    ? `(^|[^A-Za-z0-9_])${literal}($|[^A-Za-z0-9_])`
    : literal;
}

function normalizeLexicalVariants(value: string): string {
  return value
    .replace(/框架/g, "架构")
    .replace(/电子邮件/g, "邮件")
    .replace(/(\d+)\s+(年|月|日|天|小时|分钟|秒|元|个|条|场|次|席|人|类|种|%|％)/g, "$1$2")
    // A directional move is a transfer only when its immediate object is digital material.
    // Do not treat moving people, furniture or a warehouse as a data migration.
    .replace(/(?:数据|文件|记录|资料)(?:(?:全部|一并|都|全|自动|手动|人工|被|将|要|需|的)){0,5}(?:搬过来|搬过去|搬进来|搬出去|搬入|搬出|搬迁)/g,
      phrase => phrase.replace(/搬过来|搬过去|搬进来|搬出去|搬入|搬出|搬迁/, "迁移"));
}

function asksPermission(query: string): boolean {
  return /(?:是否允许|是否可以|能否|可否|允不允许|允许吗|可以吗)/.test(query) &&
    /(?:约定|政策|规则|规定|权限|许可|授权|审批)/.test(query);
}

const policyException = /(?:但是|但|除|例外|仅|只在|只要|如果|倘若|若|视情况|前提|条件|当[^，。！？；;\n]{0,30}(?:时|后|才|则)|获批后|(?:批准|授权|许可)后[^，。！？；;\n]{0,8}(?:允许|可以|可外发|可发送))/;
const doubleNegative = /(?:并非|并不|没有|不|未)(?:(?:完全|绝对|一概|应该|应当|应|会|再|曾|仍|都|是)){0,2}(?:禁止|不得|不允许|不授权|不支持)/;

function policyClauses(fields: string[]): string[] {
  return fields.flatMap(field => field.split(/[。！？；;\n]/)).filter(Boolean);
}

function coversOutboundChannel(fields: string[], term: string): boolean {
  const clauses = policyClauses(fields);
  const channelOrParent = new RegExp(`${escapeWikiRegex(term)}|外部消息|外发消息|对外消息|客户渠道`);
  // A conditional exception or a negated prohibition cannot establish a blanket policy.
  if (clauses.some(clause => channelOrParent.test(clause) &&
    (policyException.test(clause) || doubleNegative.test(clause)))) return false;
  // A specific positive permission also prevents treating the broader denial as unconditional.
  if (clauses.some(clause => new RegExp(`(?<!不|未)(?:允许|授权|支持|可以).{0,8}(?:${channelOrParent.source})`).test(clause)))
    return false;
  return clauses.some(clause =>
    /(?:不授权|不允许|不准许|禁止|不得)[^，,]{0,16}(?:外部消息|外发消息|对外消息|任何客户渠道联系)/.test(clause) &&
    !policyException.test(clause) && !doubleNegative.test(clause));
}

function requiresPriorDecision(fields: string[]): boolean {
  return policyClauses(fields).some(clause =>
    !policyException.test(clause) && !doubleNegative.test(clause) &&
    /(?:等待|须|必须|需要|应当|经过)[^。！？；;\n]{0,40}(?:人工|批准|决定|确认)[^。！？；;\n]{0,20}(?:后|方可)/.test(clause));
}

export function planWikiQuery(query: string) {
  const bounded = query.slice(0, 2000);
  const permissionQuestion = asksPermission(bounded);
  const outboundChannels = permissionQuestion && /(?:外发|发送|发出|对外)[^。！？；;\n]{0,8}(?:电子邮件|邮件|短信)/.test(bounded)
    ? ["邮件", "短信"].filter(channel => normalizeLexicalVariants(bounded).includes(channel))
    : [];
  let supportQuery = normalizeLexicalVariants(bounded)
    // This construction names the beneficiary, not an attribute of the material being queried.
    .replace(/(?:替|帮|为)(?:客户|用户|团队|使用者)(?=把|将)/g, "")
    // "Which three kinds" requests an enumeration; "supports at most three kinds" states a property.
    // This does not infer a list's cardinality or certify that the requested count is present.
    .replace(/(哪(?:些)?)[ \t]*(?:\d+|[〇零一二两三四五六七八九十百千万]+)(?:类|种)/g, "$1");
  if (permissionQuestion)
    supportQuery = supportQuery.replace(/(?:是否允许|是否可以|允不允许|允许吗|可以吗)/g, "");
  const supportTerms: string[] = [];
  let supportComplete = query.length <= bounded.length;
  if (/\p{Script=Han}/u.test(bounded)) {
    const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
    // Preserve a contiguous Latin phrase as one term rather than counting its words as independent hits.
    const runs = supportQuery.match(/[\p{Script=Han}]+|[a-z0-9]+(?:[ \t_-]+[a-z0-9]+)*/giu) ?? [];
    const seen = new Set<string>();
    const addTerm = (word: string) => {
      const key = word.toLowerCase();
      if ((!/^\d+$/.test(word) && word.length < 2) || genericWords.has(key) || seen.has(key)) return;
      seen.add(key);
      if (supportTerms.length === 32) {
        supportComplete = false;
        return;
      }
      supportTerms.push(word);
    };
    for (const run of runs) {
      const words = /\p{Script=Han}/u.test(run)
        ? [...segmenter.segment(run)].filter(word => word.isWordLike).map(word => word.segment)
        : [run.replace(/[ \t]+/g, " ")];
      for (const word of words) {
        addTerm(word);
        if (!supportComplete) break;
      }
      if (!supportComplete) break;
    }
    // Segmenter may separate a one-character quantity from its unit. Preserve it as a constraint.
    for (const quantity of supportQuery.match(/(?:\d+|[〇零一二两三四五六七八九十百千万]+)(?:年|月|日|天|小时|分钟|秒|元|个|条|场|次|席|人|类|种|%|％)/g) ?? []) {
      if (!supportComplete) break;
      addTerm(quantity);
    }
  }
  // Candidate discovery stays small; support checks must not lose later constraints.
  const terms = supportTerms.slice(0, 6);
  const hasTopic = supportTerms.some(term => /[a-z\p{Script=Han}]/iu.test(term) &&
    !/^(?:\d+|[〇零一二两三四五六七八九十百千万]+)(?:年|月|日|天|小时|分钟|秒|元|个|条|场|次|席|人|类|种|%|％)$/.test(term));
  return {
    literal: escapeWikiRegex(bounded),
    terms,
    supportTerms,
    supportComplete,
    hasTopic,
    permissionQuestion,
    outboundChannels,
    fallback: supportComplete && hasTopic && terms.length ? `(${terms.map(keywordPattern).join("|")})` : null,
  };
}

/** Lexical coverage only: matching every term does not establish an answer's truth or completeness. */
export function supportsWikiQuery(fields: string[], plan: ReturnType<typeof planWikiQuery>): boolean {
  const normalized = fields.map(normalizeLexicalVariants);
  return plan.supportComplete && plan.hasTopic && plan.supportTerms.length > 0 && plan.supportTerms.every(term => {
    const pattern = new RegExp(keywordPattern(term), "iu");
    if (normalized.some(field => pattern.test(field))) return true;
    if (!plan.permissionQuestion) return false;
    if (term === "直接") return requiresPriorDecision(normalized);
    return plan.outboundChannels.includes(term) && coversOutboundChannel(normalized, term);
  });
}
