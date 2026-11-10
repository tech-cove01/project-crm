/* Each child is started by the visitor; the guide never aggregates or selects authority. */
(function () {
  'use strict';
  const lessons = window.CRM_GUIDE_LESSONS ||= {};
  const action = name => `[data-showcase-action="${name}"]`;
  const conflict = s => s.mode !== 'normal';
  function experts(branch) {
    return [
      ['facts', '客户事实', '客户确认的沟通偏好和保存的 CRM 快照'],
      ['opportunity', '商机诊断', '当前商机阶段及所关联的政策版本'],
      ['policy', '产品政策', '政策原文、版本和交付约束']
    ].map(([id, name, evidence], i) => ({
      id: `${branch}-${id}`, title: `请第 ${i + 1} 位${name}专家取证`,
      text: `点“${i + 1}. ${name}专家取证”，保存${evidence}。各位专家按顺序独立读取，不会改动商机。`,
      target: action(`collaboration-expert-${id}`), action: `collaboration-expert-${id}`,
      predicate: ({ state: s }) => s.children.length === i + 1 && s.children[i].id === id,
      resultTarget: `[data-collaboration-evidence="${id}"]`,
      resultText: ({ state: s }) => s.children[i].status === 'partial'
        ? '这是预期保护：这位专家没有取得合格原文，缺证状态被保存，没有编造政策结论。父任务汇总时仍须保留这项缺口。'
        : `${name}专家的证据已单独保存。${id === 'facts' && s.mode === 'field_conflict' ? '这里的旧快照是“方案沟通 / crm-r11”，稍后要与当前 CRM 对照。' : id === 'opportunity' && s.mode === 'field_conflict' ? '当前 CRM 是“已联系 / crm-r12”，与第一位专家的旧快照不同。' : id === 'policy' ? '政策约束不能被客户偏好替代；是否可用还要由父任务回查。' : '这是只读证据，尚未批准或执行阶段变更。'}`
    }));
  }
  const aggregate = branch => ({
    id: `${branch}-aggregate`, title: '让父任务汇总三份证据',
    text: '点“父 Agent 汇总”。它需要保留各位专家的来源、约束和分歧，不能把三句成功拼成一项业务完成。',
    target: action('collaboration-aggregate'), action: 'collaboration-aggregate',
    predicate: ({ state: s }) => s.aggregated && s.children.length === 3,
    resultTarget: '[data-collaboration-summary] li:first-child',
    resultText: ({ state: s }) => conflict(s)
      ? '这是预期保护：摘要保留了分歧或缺证，相关动作仍被阻断。下一步回查当前 CRM 和原文，不能自行挑一个专家当作正确答案。'
      : '摘要已经形成：客户先收书面方案，商机仍为已联系，交付条件尚待确认。证据仍未最终准入，需要继续回查。'
  });
  const recheck = branch => ({
    id: `${branch}-recheck`, title: '回到当前记录与原文核实',
    text: '点“回查 CRM 与原文”。保存过的专家快照还要与当前阶段、原文权限和版本重新比较。',
    target: action('collaboration-recheck'), action: 'collaboration-recheck',
    predicate: ({ state: s }) => s.rechecked && !s.admitted,
    resultTarget: '[data-collaboration-recheck] .showcase-dl > div:first-child > dd',
    resultText: ({ state: s }) => s.mode === 'normal'
      ? '当前 CRM 与授权原文一致。回查完成仍不等于准入，下一步由你触发再次核验。'
      : s.mode === 'partial'
        ? '这是预期保护：回查确认原文已撤回，仍然缺少政策依据。没有合格依据可供人工选择，不能强行放行。'
        : `当前权威依据已回读：${s.mode === 'version_conflict' ? '原文是 v4，旧 v3 缺少资源排期书面确认要求' : '商机是“已联系 / crm-r12”，旧快照的方案沟通不能覆盖它'}。先亲自选择依据，再再次核验；当前仍阻断。`
  });
  const verify = branch => ({
    id: `${branch}-verify`, title: '再次核验，检查是否准入',
    text: '点“再次核验与准入”，检查当前来源与未解决项。准入只允许进入后续提案评审，不会直接修改商机。',
    target: action('collaboration-verify'), action: 'collaboration-verify',
    predicate: ({ state: s }) => s.mode === 'partial' ? s.rechecked && !s.admitted && s.pending.length > 0 : s.verified && s.admitted && s.pending.length === 0,
    resultTarget: '[data-collaboration-admission]',
    resultText: ({ state: s }) => s.mode === 'partial'
      ? '这是预期保护：缺证仍阻断动作，人工确认不能凭空补出原文。商机没有被改动。'
      : '来源和当前值再次核验一致，证据已准入后续提案评审。商机仍为已联系，业务写入0次；准入不等于批准阶段变更。'
  });
  lessons.collaboration = {
    title: '先合并证据，再亲自处理一次冲突',
    intro: '逐个启动三位只读专家，汇总后回查并核验。随后亲自切换字段冲突，看旧快照如何被保留、核实与解决。刷新会回到场景起点。',
    takeaway: '专家各自保存证据，父任务负责比较和复核。人工选择依据后仍要再次核验；冲突或缺证没有解决，相关动作就不能放行。',
    principle: '../details.html#expert-collaboration',
    resumeAt: ({ state: s }) => {
      // Keep a pre-existing missing-evidence example intact until the visitor explicitly changes branch.
      if (s.mode === 'partial') return 6;
      const offset = conflict(s) ? 7 : 0;
      if (s.verified || (s.mode === 'partial' && s.rechecked && s.message.startsWith('再次核验未通过'))) return conflict(s) ? 14 : 6;
      if (s.rechecked) return conflict(s) ? (s.mode === 'partial' || s.authority ? 13 : 12) : 5;
      if (s.aggregated) return offset + 4;
      return offset + s.children.length;
    },
    steps: [
      ...experts('normal'), aggregate('normal'), recheck('normal'), verify('normal'),
      { id: 'choose-conflict', title: '亲自切换，看看专家意见不一致时怎么办',
        text: '点“字段冲突”。这会清空刚才的本场景取证结果，准备一组旧快照与当前 CRM 不一致的示例；随后重新逐个取证。也可关闭引导保留正常结果。',
        target: action('collaboration-scenario-field_conflict'), action: 'collaboration-scenario-field_conflict',
        predicate: ({ state: s }) => s.mode === 'field_conflict' && s.children.length === 0 && !s.aggregated,
        resultTarget: '[data-collaboration-admission]',
        resultText: '字段冲突示例已由你打开，尚未取证，也没有动作准入。接着重新走三位专家，比较旧快照与当前值。' },
      ...experts('conflict'), aggregate('conflict'), recheck('conflict'),
      { id: 'authority', title: '亲自选择回查到的当前权威依据',
        text: '点“选择当前权威依据”。这只记录你选择当前 CRM 或授权原文作为复核依据，仍不会直接放行动作。',
        target: action('collaboration-authority'), action: 'collaboration-authority',
        predicate: ({ state: s }) => Boolean(s.authority) && !s.admitted && s.pending.length > 0,
        resultTarget: '[data-collaboration-recheck] .showcase-dl > div:nth-last-child(2) > dd',
        resultText: '这是预期保护：人工选择已记录，但冲突仍为待复核，动作继续阻断。必须再核验来源、版本与当前值，不能“一选就过”。' },
      verify('conflict')
    ]
  };
})();
