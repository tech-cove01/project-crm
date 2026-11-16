import { buildTask as priorPrompt, tested } from './crm022-paired-cases.mjs';

export const model = Object.freeze({ provider: 'dashscope', model: 'qwen3.8-flash', temperature: 0,
  maxSteps: 12, tokenBudget: 36_000, reportedStop: 750_000, reserve: 72_000 });
export const arms = ['disabled', 'auto'];
export const calibrationIds = ['X02','M03'];
export const regressionIds = ['S02','X02','C01','M03'];
export const holdoutIds = ['N01','N02','N03','N04'];
export const policyTerms = {
  approvals: { query: '审批', anchor: '等待人工明确决定', expect: 'excerpt' },
  csv: { query: 'CSV', anchor: '人工上传 CSV', expect: 'excerpt' },
  missing: { query: 'CRM022X7不存在的火星交付保证', expect: 'empty' },
  missingEscalation: { query: 'CRM023R4月球试点跨境免审条例', expect: 'empty' },
};
export const known = Object.fromEntries(tested.filter(item => regressionIds.includes(item.id)).map(item => [item.id, {
  ...item,
  ...(item.query ? { policy: { policy_excerpt: item.id === 'M03' ? policyTerms.missing : policyTerms.approvals } } : {}),
  allowPartial: item.id === 'M03',
}]));

export const holdouts = {
  N01: {
    id: 'N01', kind: 'simple', fields: ['status','currency'],
    question: '核对这笔商机当前是否仍开放，并确认金额使用的币种。只核这两个 CRM 字段，不需要政策或企业资料。',
    hints: 'status 使用 CRM 原值，currency 使用币种原值。',
    crm: { status: { sourceType: 'lead', field: 'status' }, currency: { sourceType: 'lead', field: 'currency' } },
    expected: { status: 'open', currency: 'CNY' }, value: 680_000, expectedDate: '2027-03-11',
  },
  N02: {
    id: 'N02', kind: 'cross_source', fields: ['expected_close_date','policy_excerpt'],
    question: '销售要说明当前预计关单日期，并说明合成产品支持怎样把历史清单导入。分别核对当前 CRM 和产品原文，区分当前销售日期和产品功能。',
    hints: 'expected_close_date 用 YYYY-MM-DD；policy_excerpt 摘录 CSV 支持方式的原句。',
    policy: { policy_excerpt: policyTerms.csv }, value: 837_500, expectedDate: '2027-04-12',
  },
  N03: {
    id: 'N03', kind: 'conflict', fields: ['expected_close_date','currency','contact_name'],
    question: '旧备注留有预计关单日期和币种。核对当前权威 CRM 的日期、币种和关联联系人，按当前结构化记录回答。只核 CRM 字段，不需要政策或企业资料。',
    hints: 'expected_close_date 若为 null 就留空并引用实际商机；currency 及 contact_name 使用当前原值。',
    crm: { currency: { sourceType: 'lead', field: 'currency' } }, expected: { currency: 'CNY' },
    value: 492_300, expectedDate: null, description: '旧人工短笺（已失效）：预计 2027-02-19 关单，报价换算为 USD。请以当前 CRM 字段为准。',
  },
  N04: {
    id: 'N04', kind: 'missing', fields: ['value_cents','currency','policy_excerpt'],
    question: '核对商机金额和币种，再核验是否有授权资料支持“月球试点跨境可免审”。只有真实检索为空才确认无匹配，不得给出免审承诺。',
    hints: 'value_cents 使用分单位的数字；currency 使用当前原值；没有符合条件的政策时 policy_excerpt 与其引用均填 null。',
    crm: { currency: { sourceType: 'lead', field: 'currency' } }, expected: { currency: 'CNY' },
    policy: { policy_excerpt: policyTerms.missingEscalation }, value: 720_250, expectedDate: null, allowPartial: true,
  },
};

for (const item of Object.values(holdouts)) {
  item.contactName = `CRM023 合成联系人-${item.id}`;
  item.leadTitle = `CRM023 合成商机-${item.id}`;
}
export const cases = { ...known, ...holdouts };

export function taskFor(item, scope) {
  if (known[item.id]) {
    const prompt = priorPrompt(item, scope);
    return item.id === 'M03' ? `${prompt}\n该政策项只核验是否存在。授权资料正常检索无匹配时，明确留空并回答其余已核实字段。` : prompt;
  }
  const policy = item.policy?.policy_excerpt;
  return [
    `[CRM-023/${item.id}] 合成资料的只读销售核对。只处理指定商机 ${scope.leadId} 及关联联系人 ${scope.contactId}。`,
    item.question,
    policy ? `产品原文使用企业知识搜索词“${policy.query}”。${policy.expect === 'empty' ? '若正常检索没有匹配，按缺证项留空。' : '本次需要该政策依据。'}` :
      '这是范围内的 CRM 核对；只需回答指定字段。',
    item.hints,
    `submit_workbench_result.summary 只交 JSON 对象，恰含 fields 和 sources，两个对象都使用这些键：${item.fields.join('、')}。`,
    'sources 用同键引用本次成功观察的 CRM 对象、授权知识回执 UUID 或实际专家 Run UUID。正常空政策项的引用填 null。结构化 evidence 同时列出真实引用。禁止提案、修改、通知或外发。',
  ].join('\n');
}

export const budget = Object.freeze({ calibrationRoots: 8, formalRoots: 16, calibrationRounds: 2,
  extraApprovalsIfGateChanged: 1, extraRejectionsIfGateChanged: 1, judgeDefault: 0, judgeMax: 2, memoryRequests: 0 });
