(function () {
  'use strict';

  const panels = window.CRM_SHOWCASE_PANELS = window.CRM_SHOWCASE_PANELS || {};
  const modes = [
    ['normal', '正常取证'], ['field_conflict', '字段冲突'],
    ['version_conflict', '资料版本冲突'], ['partial', '专家缺证']
  ];
  const experts = [
    { id: 'facts', name: '客户事实专家', run: 'child-facts-01', tool: '只读 SQL 事实查询' },
    { id: 'opportunity', name: '商机诊断专家', run: 'child-opportunity-02', tool: '只读 CRM 商机查询' },
    { id: 'policy', name: '产品政策专家', run: 'child-policy-03', tool: '授权政策原文读取' }
  ];

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
    });
  }

  function button(action, label, selected, disabled) {
    return '<button type="button" class="showcase-button' + (selected ? ' is-active' : '') + '" data-showcase-action="' + esc(action) + '"' +
      (selected === null ? '' : ' aria-pressed="' + String(Boolean(selected)) + '"') + (disabled ? ' disabled' : '') + '>' + esc(label) + '</button>';
  }

  function list(items) {
    return '<ul class="showcase-list">' + items.map(function (item) { return '<li>' + esc(item) + '</li>'; }).join('') + '</ul>';
  }

  function pair(label, value) {
    return '<div><dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd></div>';
  }

  function create() {
    return {
      mode: 'normal', children: [], aggregated: false, rechecked: false,
      authority: null, verified: false, admitted: false, pending: [],
      message: '请按 1 → 2 → 3 逐个取证，子运行各自只读并保存证据。'
    };
  }

  function evidenceFor(mode, index) {
    if (index === 0) {
      return {
        status: 'completed',
        evidence: ['SQL m-101 v1：客户偏好为先收到书面方案，再安排内部评审。',
          mode === 'field_conflict' ? 'CRM O-204 旧快照 crm-r11：阶段为“方案沟通”。' : 'CRM O-204 · crm-r12：阶段为“已联系”。'],
        conclusion: '偏好决定沟通顺序，不能代替政策或批准阶段变更。'
      };
    }
    if (index === 1) {
      return {
        status: 'completed',
        evidence: ['CRM O-204 当前快照 crm-r12：阶段为“已联系”；尚未执行阶段调整。',
          mode === 'version_conflict' ? 'CRM 所引用政策元数据 P-17 当前版本为 v4 · hash-policy-v4。' : 'CRM 关联政策元数据 P-17 · v3 · hash-policy-v3。'],
        conclusion: '只形成可核对的推进判断，实际动作由父任务后续评审。'
      };
    }
    if (mode === 'partial') {
      return {
        status: 'partial', evidence: [],
        conclusion: '原文读取未获得合格证据；只保存失败状态，不编造政策摘要。'
      };
    }
    return {
      status: 'completed',
      evidence: ['授权原文 P-17 · v3 · hash-policy-v3：合同范围与交付时间经业务负责人确认后，方可对外承诺。'],
      conclusion: mode === 'version_conflict' ? '已保存的 v3 引用与其他专家的当前 v4 元数据不同，必须回查。' : '政策约束须保留，客户偏好不构成交付授权。'
    };
  }

  function pendingFor(state) {
    if (!state.aggregated) return [];
    if (state.mode === 'partial') return ['产品政策专家缺少可追溯的合格原文与版本：pending，不能用人工确认替代取证。'];
    if (state.mode === 'field_conflict' && !state.verified) return ['商机阶段冲突：旧快照“方案沟通 / crm-r11”与当前“已联系 / crm-r12”不同，pending。'];
    if (state.mode === 'version_conflict' && !state.verified) return ['政策版本冲突：子运行引用 v3，当前元数据为 v4，pending；旧政策不能继续作为权威依据。'];
    if (!state.rechecked) return ['当前证据尚未回查，等待 CRM 与原文核验。'];
    return [];
  }

  function act(state, action) {
    const modePrefix = 'collaboration-scenario-';
    if (action.indexOf(modePrefix) === 0) {
      const mode = action.slice(modePrefix.length);
      if (!modes.some(function (item) { return item[0] === mode; })) return;
      Object.assign(state, create(), { mode: mode });
      return;
    }
    const expertPrefix = 'collaboration-expert-';
    if (action.indexOf(expertPrefix) === 0) {
      const index = experts.findIndex(function (expert) { return expert.id === action.slice(expertPrefix.length); });
      if (index < 0 || index !== state.children.length || state.aggregated) return;
      const evidence = evidenceFor(state.mode, index);
      state.children.push({ id: experts[index].id, run: experts[index].run, status: evidence.status, evidence: evidence.evidence, conclusion: evidence.conclusion });
      state.message = experts[index].name + '的独立子运行已保存' + (evidence.status === 'partial' ? '缺证状态' : '证据') + '。' + (index < 2 ? '继续下一位专家。' : '现在可由父 Agent 汇总。');
      return;
    }
    if (action === 'collaboration-aggregate' && state.children.length === 3) {
      state.aggregated = true;
      state.message = state.mode === 'normal' ? '父 Agent 已汇总三个子运行；仍需回查当前 CRM 与原文后才能准入。' : '父 Agent 保留冲突或缺证为 pending，相关动作暂不准入。';
    }
    if (action === 'collaboration-recheck' && state.aggregated) {
      state.rechecked = true;
      state.verified = false;
      state.admitted = false;
      state.authority = null;
      state.message = state.mode === 'partial' ? '回查确认政策原文已撤回，缺证仍为 pending；人工不能凭空补出证据。' :
        state.mode === 'normal' ? '回查 CRM crm-r12 与合格政策 v3 一致；请再次核验与准入。' : '已回查当前权威值。请人工选择依据，随后再次核验；选择本身不解除阻断。';
    }
    if (action === 'collaboration-authority' && state.rechecked && (state.mode === 'field_conflict' || state.mode === 'version_conflict')) {
      state.authority = state.mode === 'field_conflict' ? 'CRM O-204 · crm-r12 · 已联系' : '政策原文 P-17 · v4 · hash-policy-v4';
      state.verified = false;
      state.admitted = false;
      state.message = '人工已选择当前权威依据，冲突仍为 pending；必须再次核验来源、版本和当前值。';
    }
    if (action === 'collaboration-verify' && state.aggregated && state.rechecked) {
      const needsAuthority = state.mode === 'field_conflict' || state.mode === 'version_conflict';
      const expected = state.mode === 'field_conflict' ? 'CRM O-204 · crm-r12 · 已联系' : '政策原文 P-17 · v4 · hash-policy-v4';
      if (state.mode === 'partial' || (needsAuthority && state.authority !== expected)) {
        state.verified = false;
        state.admitted = false;
        state.message = state.mode === 'partial' ? '再次核验未通过：缺少合格政策证据，pending 继续阻断动作。' : '再次核验未通过：尚未人工选择当前权威依据，冲突仍为 pending。';
      } else {
        state.verified = true;
        state.admitted = true;
        state.message = '再次核验通过：证据准入已开放，可进入后续提案评审。商机仍为已联系；本演示没有执行阶段调整。';
      }
    }
    state.pending = pendingFor(state);
  }

  function conflictHTML(state) {
    if (state.mode === 'normal') return '<p>三个专家的阶段与资料版本一致，未发现结构化冲突。</p>';
    if (state.mode === 'partial') return '<dl class="showcase-dl">' +
      pair('缺失项', '产品政策专家没有合格原文、版本与内容指纹') + pair('保存的子运行状态', 'child-policy-03 · partial；没有可引用正文') +
      pair('处置', '保持 pending；补取证据之前，人工不能一键确认通过') + '</dl>';
    const field = state.mode === 'field_conflict';
    return '<dl class="showcase-dl">' + pair('分歧对象', field ? '商机 O-204 的阶段字段' : '政策 P-17 的原文版本与约束') +
      pair('冲突前：专家 A 依据', field ? '客户事实专家：方案沟通 · crm-r11 · 旧 CRM 快照' : '产品政策专家：v3 · hash-policy-v3；业务负责人确认后方可承诺') +
      pair('冲突前：专家 B 依据', field ? '商机诊断专家：已联系 · crm-r12 · 当前 CRM 快照' : '商机诊断专家：当前政策元数据 v4 · hash-policy-v4') +
      pair('当前处理', state.verified ? '再次核验后已解决，旧值与旧版本保留用于追溯。' : 'pending；父 Agent 不自行挑选一个答案') + '</dl>';
  }

  function recheckHTML(state) {
    if (!state.rechecked) return '<p>尚未回查；专家结论不直接构成动作权限。</p>';
    let html = '<dl class="showcase-dl">' + pair('回查 CRM 当前值', 'O-204 · 已联系 · crm-r12；阶段尚未改变');
    if (state.mode === 'partial') {
      html += pair('回查原文资格', 'P-17 已撤回；不返回正文，无法补齐政策证据') + pair('缺证状态', 'pending；没有可供人工选择的合格政策依据');
    } else if (state.mode === 'version_conflict') {
      html += pair('回查原文当前版本', 'P-17 · 已发布且当前身份有权限 · v4 · hash-policy-v4') +
        pair('回查当前正文', '合同范围与交付时间须经业务负责人及资源排期书面确认后，方可对外承诺。') +
        pair('冲突后待选依据', 'v4 为当前授权原文；旧 v3 缺少资源排期书面确认要求，不再支撑建议');
    } else {
      html += pair('回查原文资格与版本', 'P-17 · 已发布且当前身份有权限 · v3 · hash-policy-v3') +
        pair('回查当前正文', '合同范围与交付时间经业务负责人确认后，方可对外承诺。');
      if (state.mode === 'field_conflict') html += pair('冲突后待选依据', '已联系 · crm-r12；旧 crm-r11 的方案沟通不能覆盖当前 CRM');
    }
    return html + pair('人工选择', state.authority || '尚未选择') + pair('再次核验', state.verified ? '来源、授权、版本及当前值一致；已准入' : '未通过或尚未执行；选择依据本身不解除阻断') + '</dl>';
  }

  function summaryHTML(state) {
    const facts = state.children.find(function (child) { return child.id === 'facts'; });
    const opportunity = state.children.find(function (child) { return child.id === 'opportunity'; });
    const policy = state.children.find(function (child) { return child.id === 'policy'; });
    const hasFacts = facts && facts.status === 'completed' && facts.evidence.length > 0;
    const hasOpportunity = opportunity && opportunity.status === 'completed' && opportunity.evidence.length > 0;
    const hasPolicy = policy && policy.status === 'completed' && policy.evidence.length > 0;
    const fieldPending = state.mode === 'field_conflict' && !state.verified;
    const versionPending = state.mode === 'version_conflict' && !state.verified;
    const summary = [];
    summary.push(hasFacts ? '客户准备：SQL m-101 v1 确认赵强希望先收到书面方案，再安排内部评审；这只决定沟通顺序。' : '客户准备：尚无已保存的客户确认事实，不能推断偏好。');
    if (fieldPending) {
      summary.push('商机判断待复核：两份阶段快照分别为“方案沟通 / crm-r11”和“已联系 / crm-r12”；父 Agent 暂不选取一个阶段作为推进依据。');
    } else if (hasOpportunity) {
      summary.push('商机现状：' + (state.verified ? '已再次核验当前 CRM' : '商机诊断专家保存的 CRM 快照') + ' O-204 为“已联系 / crm-r12”，本次尚未调整阶段。');
    } else {
      summary.push('商机现状：尚无已保存的 CRM 证据，不能形成推进判断。');
    }
    if (!hasPolicy) {
      summary.push('政策依据缺失：产品政策专家为 partial；没有合格原文可支撑交付承诺，人工选择不能替代取证。');
    } else if (versionPending) {
      summary.push('政策判断待复核：v3 已保存正文与 v4 当前元数据不一致；暂不使用其中任一版本形成交付条件结论。');
    } else if (state.mode === 'version_conflict' && state.verified) {
      summary.push('政策约束：再次核验采用当前授权原文 P-17 v4 · hash-policy-v4；合同范围与交付时间须经业务负责人及资源排期书面确认后，方可对外承诺。旧 v3 不再支撑建议。');
    } else {
      summary.push('政策约束：' + (state.verified ? '再次核验后的授权原文' : '专家保存、仍待最终核验的原文') + ' P-17 v3 要求合同范围与交付时间经业务负责人确认后，方可对外承诺。');
    }
    summary.push(state.mode === 'version_conflict' && state.verified ? '待确认：客户对书面方案的反馈、合同范围、业务负责人意见与资源排期书面确认；没有证据表明这些条件已完成。' : '待确认：客户对书面方案的反馈、合同范围、交付时间及业务负责人确认；现有偏好不能证明合同已获接受。');
    if (!hasPolicy || fieldPending || versionPending) {
      summary.push(state.authority ? '跟进建议：人工已选依据，但尚未再次核验，仍待复核并阻断相关动作；先完成核验，再形成推进建议。' : '跟进建议：先准备符合客户沟通偏好的书面问题清单，补齐或复核冲突依据；在 pending 解除前不提出已具备推进条件的结论。');
    } else if (!state.verified) {
      summary.push('跟进建议：按客户偏好准备书面方案，列出待确认事项；' + (state.rechecked ? '回查已完成，仍须再次核验' : '先回查 CRM 与原文并再次核验') + '，当前不准入阶段动作。');
    } else {
      summary.push('跟进建议：准备书面方案并约定内部评审，逐项收集上述确认；证据已准入后续提案评审，但不代表批准阶段调整或可以直接承诺交付。');
    }
    return '<div class="showcase-note" data-collaboration-summary><h4>父 Agent 的销售准备摘要</h4>' + list(summary) + '</div>';
  }

  function render(state) {
    const allDone = state.children.length === 3;
    const hasConflict = state.mode === 'field_conflict' || state.mode === 'version_conflict';
    let html = '<div class="showcase-panel" data-showcase-panel="collaboration"><section class="showcase-card">' +
      '<h3>三个专家取证之后，谁来决定下一步？</h3>' +
      '<p>起点：赵强年度合同商机 O-204 处于已联系。按 1 → 2 → 3 顺序启动独立子运行，保存各自证据，再由父 Agent 汇总与复核。</p>' +
      '<p class="showcase-note">本示例展示顺序执行的独立子运行。专家只有读取权限，不修改商机；“证据准入”仅允许进入后续提案评审。</p>' +
      '<div class="showcase-actions">' + modes.map(function (mode) { return button('collaboration-scenario-' + mode[0], mode[1], state.mode === mode[0], false); }).join('') + '</div></section>';
    html += '<div class="showcase-grid">' + experts.map(function (expert, index) {
      const child = state.children[index];
      return '<section class="showcase-card" data-collaboration-expert="' + esc(expert.id) + '"><h3>' + esc(String(index + 1) + '. ' + expert.name) + '</h3>' +
        '<dl class="showcase-dl">' + pair('独立子运行', expert.run) + pair('工具边界', expert.tool + '；禁止业务写入') +
        pair('状态', child ? child.status + ' · 已保存' : '尚未启动') + '</dl>' +
        (child ? '<div data-collaboration-evidence="' + esc(expert.id) + '"><h4>保存的证据</h4>' + (child.evidence.length ? list(child.evidence) : '<p>无合格证据；保留缺证状态。</p>') + '<p>' + esc(child.conclusion) + '</p></div>' : '<p>' + esc(index === state.children.length ? '轮到该专家独立取证。' : '等待前一位专家完成并保存状态。') + '</p>') +
        '<div class="showcase-actions">' + button('collaboration-expert-' + expert.id, String(index + 1) + '. ' + expert.name + '取证', null, index !== state.children.length || state.aggregated) + '</div></section>';
    }).join('') + '</div>';
    html += '<section class="showcase-card"><h3>4. 父 Agent 汇总与复核</h3><div class="showcase-actions">' +
      button('collaboration-aggregate', '父 Agent 汇总', null, !allDone || state.aggregated) +
      button('collaboration-recheck', '回查 CRM 与原文', null, !state.aggregated) + '</div>' +
      '<p class="showcase-status" role="status" aria-live="polite">' + esc(state.message) + '</p></section>';
    if (state.aggregated) {
      html += '<section class="showcase-card" data-collaboration-result><h3>汇总：分歧、回查与未解项</h3>' +
        summaryHTML(state) + conflictHTML(state) + '<div data-collaboration-recheck><h4>当前权威来源回查</h4>' + recheckHTML(state) + '</div>' +
        '<h4>未解决项</h4>' + (state.pending.length ? list(state.pending) : '<p>当前没有未解决的证据冲突或缺证项。</p>') +
        '<div class="showcase-actions">' +
        (hasConflict ? button('collaboration-authority', '选择当前权威依据', null, !state.rechecked || state.verified) : '') +
        button('collaboration-verify', '再次核验与准入', null, !state.rechecked || state.verified) + '</div>' +
        (state.mode === 'partial' ? '<p class="showcase-note">缺证不能人工一键消除。本固定分支没有合格政策原文可选，回查与再次核验都会保留 pending。</p>' : '') + '</section>';
    }
    html += '<section class="showcase-card" data-collaboration-admission aria-live="polite"><h3>动作准入状态</h3>' +
      '<p class="showcase-status">' + esc(state.admitted ? '证据核验已准入：允许进入后续提案评审。' : '证据未准入：相关动作被阻断。') + '</p>' +
      '<dl class="showcase-dl">' + pair('商机当前阶段', '已联系 · crm-r12（未执行变更）') +
      pair('业务写入', '0；专家只读，人工选择与再次核验也不会改变商机') + '</dl></section>';
    return html + '</div>';
  }

  panels.collaboration = {
    title: '多 Agent 协作与商机分析',
    intro: '把专家意见变成可回查的证据：冲突先保留，人工选择后仍须再次核验，缺证持续阻断动作。',
    create: create,
    render: render,
    act: act
  };
}());
