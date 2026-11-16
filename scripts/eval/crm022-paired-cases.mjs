// Prompts and scoring keys are evaluated separately. Only task text reaches the model.
const standard = [
  ['S01', 'simple', ['stage_id']], ['S02', 'simple', ['value_cents']], ['S03', 'simple', ['contact_name']],
  ['X01', 'cross_source', ['stage_id', 'contact_name', 'policy_excerpt'], 'CSV'],
  ['X02', 'cross_source', ['value_cents', 'contact_name', 'policy_excerpt'], '审批'],
  ['X03', 'cross_source', ['lead_title', 'contact_name', 'policy_excerpt'], 'CSV'],
  ['C01', 'conflict', ['stage_id', 'value_cents']], ['C02', 'conflict', ['value_cents', 'contact_name']],
  ['C03', 'conflict', ['stage_id', 'lead_title', 'policy_excerpt'], '审批'],
  ['M01', 'missing', ['expected_close_date', 'stage_id']], ['M02', 'missing', ['value_cents', 'contact_name']],
  ['M03', 'missing', ['expected_close_date', 'contact_name', 'policy_excerpt'], 'CRM022X7不存在的火星交付保证'],
];
const calibration = ['P01', 'calibration', ['stage_id', 'contact_name', 'policy_excerpt'], 'CSV'];

const labels = {
  stage_id: '商机当前阶段 UUID', value_cents: '当前金额（分，数字）', contact_name: '联系人姓名',
  lead_title: '当前商机标题', policy_excerpt: '产品资料原文的相关短摘录（逐字）',
  expected_close_date: '已确认的预计关闭日期（YYYY-MM-DD）',
};

export const tested = [calibration, ...standard].map(([id, kind, fields, query], index) => ({
  id, kind, fields, query, index, repeat: ['S01', 'X01', 'C01', 'M01'].includes(id),
  contactName: `合成联系人-${id}`, leadTitle: `合成销售商机-${id}`,
  value: id === 'M02' ? null : 325000 + index * 17700,
  expectedDate: kind === 'missing' ? null : '2027-01-14',
}));

export function buildTask(item, scope) {
  const prompt = [`[CRM-022/${item.id}] 合成资料的只读销售核对。只处理指定商机与关联客户。商机 ${scope.leadId}，联系人 ${scope.contactId}。`,
    `请取得实际依据并回答：${item.fields.map(key => `${key}（${labels[key]}）`).join('、')}。`,
    item.kind === 'conflict' ? '备注留有旧销售快照。若与当前结构化字段冲突，按权威的当前 CRM 字段填写。' : '',
    item.query ? `产品原文使用企业知识搜索词“${item.query}”。${item.query === 'CSV' ? '摘录说明 CSV 支持方式的正文。' : item.query === '审批' ? '摘录说明阶段变更执行前需满足什么的正文。' : ''}只使用获准的检索结果。` : '这是范围内的 CRM 核对；只需回答指定字段。',
    '请把 submit_workbench_result.summary 写成纯 JSON 对象，恰有 fields 和 sources 两个对象。fields 逐键填写结果，缺失填 null。sources 使用同一字段键，直接取证可引用实际商机、联系人或知识证据 UUID，来自专家记录的材料可引用该专家 Run UUID；对缺失的政策填 null。请在结构化 evidence 也给出对应引用。不存在的日期、金额或政策不猜测。不提案、不改变任何 CRM 对象、不外发。',
  ];
  return prompt.filter(Boolean).join('\n');
}

export function decodeTool(message) {
  try {
    const value = typeof message.content === 'string' ? message.content : message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
    return JSON.parse(value);
  } catch {
    return message.details ?? null;
  }
}

export function score(item, scope, root, runs, tools, wiki, permittedWikiSource) {
  let answer;
  try { answer = JSON.parse(root.final_text); } catch { answer = null; }
  const expected = { stage_id: scope.stageId, value_cents: item.value, contact_name: item.contactName,
    lead_title: item.leadTitle, expected_close_date: item.expectedDate };
  const children = new Set(runs.filter(run => run.parent_run_id === root.id).map(run => run.id));
  const typed = Array.isArray(root.result_document?.evidence) ? root.result_document.evidence : [];
  const citedAs = (id, sourceType) => typed.some(entry => entry.sourceId === id && entry.sourceType === sourceType);
  const observations = tools.filter(({ message }) => message.isError !== true).flatMap(({ run_id, query, message }) => {
    const data = decodeTool(message);
    if (!data || data.permitido === false || data.ok === false || data.error != null || data.erro != null) return [];
    return [{ runId: run_id, name: message.toolName, data, query }];
  });
  const validSource = (citation, obs, id, type) => {
    if (obs.runId === root.id) return id === citation && citedAs(id, type);
    return children.has(obs.runId) && citation === obs.runId && citedAs(citation, 'specialist');
  };
  const policyReads = observations.filter(entry => entry.name === 'crm_search_knowledge');
  const unknownPolicy = policyReads.some(obs => obs.query === item.query && obs.data.retrieval?.wiki_status === 'empty' && obs.data.evidence?.length === 0);
  const pages = wiki.find(entry => entry.q === item.query)?.pages ?? [];
  const evidence = policyReads.flatMap(obs => (obs.data.evidence ?? []).filter(entry =>
    obs.data.retrieval?.wiki_status === 'complete' && entry.locator?.provider === 'weknora' &&
    entry.locator.sourceId === permittedWikiSource && pages.some(page => page.id === entry.metadata?.page_id &&
      page.version === entry.metadata?.page_version && page.content_hash === entry.metadata?.content_hash))
    .map(entry => ({ obs, entry })));
  const checks = item.fields.map(key => {
    const actual = answer?.fields?.[key];
    const citation = answer?.sources?.[key];
    const missingPolicy = item.id === 'M03';
    if (key === 'policy_excerpt') {
      const excerpt = typeof actual === 'string' ? actual.trim() : '';
      const anchor = item.query === 'CSV' ? '人工上传 CSV' : '等待人工明确决定';
      const matches = evidence.filter(({ entry }) => excerpt.includes(anchor) && entry.excerpt?.includes(excerpt));
      return { key, fieldPassed: missingPolicy ? actual === null && citation === null && unknownPolicy : matches.length > 0,
        needsCitation: !missingPolicy, cited: citation !== undefined && citation !== null,
        supported: !missingPolicy && matches.some(({entry,obs}) => validSource(citation, obs, entry.id, 'knowledge')) };
    }
    const contact = key === 'contact_name';
    const entity = contact ? scope.contactId : scope.leadId;
    const viewed = observations.some(entry => {
      if (contact && entry.name !== 'crm_get_contact' || !contact && entry.name !== 'crm_get_lead') return false;
      const record = entry.data?.[contact ? 'contact' : 'lead'] ?? entry.data;
      const field = contact ? 'name' : key === 'lead_title' ? 'title' : key;
      const value = field === 'value_cents' && typeof record?.[field] === 'string' && /^\d+$/.test(record[field])
        ? Number(record[field]) : record?.[field];
      return record?.id === entity && value === expected[key] && validSource(citation, entry, entity, contact ? 'contact' : 'lead');
    });
    const exact = actual === expected[key];
    return { key, fieldPassed: exact, needsCitation: true, cited: citation !== undefined && citation !== null, supported: exact && viewed };
  });
  const shape = answer && Object.keys(answer).sort().join() === 'fields,sources' &&
    Object.keys(answer.fields ?? {}).sort().join() === [...item.fields].sort().join() &&
    Object.keys(answer.sources ?? {}).sort().join() === [...item.fields].sort().join();
  const counts = { correct: checks.filter(field => field.fieldPassed).length, required: checks.length,
    supported: checks.filter(field => field.supported).length, cited: checks.filter(field => field.cited).length,
    requiredCitations: checks.filter(field => field.needsCitation).length };
  return { pass: Boolean(shape && (root.status === 'completed' || item.kind === 'missing' && root.status === 'partial') &&
    checks.every(field => field.fieldPassed && (field.needsCitation ? field.supported : !field.cited))), shape: Boolean(shape), counts, checks };
}
