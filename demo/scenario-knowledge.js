(function () {
  'use strict';

  const panels = window.CRM_SHOWCASE_PANELS = window.CRM_SHOWCASE_PANELS || {};
  const question = '赵强的年度服务合同应怎样跟进，能否承诺交付？';
  const modes = [
    ['baseline', '正常资料'], ['edit', '修改记忆'], ['delete', '删除记忆'],
    ['mem0_down', 'Mem0 服务异常'], ['wiki_revision', '资料改版'],
    ['wiki_withdrawn', '资料撤回'], ['wiki_unauthorized', '资料越权']
  ];
  const originalPreference = '先收到书面方案，再安排内部评审';
  const editedPreference = '先确认技术范围，再安排内部评审';
  const oldPolicy = '合同范围与交付时间经业务负责人确认后，方可对外承诺。';
  const currentPolicy = '合同范围与交付时间须经业务负责人及资源排期书面确认后，方可对外承诺。';

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
    return { mode: 'baseline', sourceVisible: false, searched: false, currentWiki: false, result: null, searches: 0 };
  }

  function snapshot(state) {
    const edited = state.mode === 'edit';
    const removed = state.mode === 'delete';
    const revised = state.mode === 'wiki_revision';
    return {
      sqlStatus: removed ? '已删除 · m-101 · v2 · 不返回正文' : '当前确认事实 · m-101 · ' + (edited ? 'v2' : 'v1'),
      sqlBody: removed ? '这条偏好已删除，不能继续参与建议。' : edited ? editedPreference : originalPreference,
      projection: state.mode === 'mem0_down' ? 'Mem0 不可用，没有外部候选结果' : '旧投影候选 · m-101 · v1：' + originalPreference,
      pageVersion: revised ? 'v4 · hash-policy-v4' : 'v3 · hash-policy-v3',
      pageStatus: state.mode === 'wiki_withdrawn' ? '已撤回，禁止引用' : state.mode === 'wiki_unauthorized' ? '当前身份无读取权限，正文不返回' : '已发布，当前身份有读取权限',
      candidateVersion: revised && state.currentWiki ? 'v4' : 'v3',
      pageBody: revised ? currentPolicy : oldPolicy
    };
  }

  function retrieve(state) {
    const data = snapshot(state);
    const result = { facts: [], citations: [], rejected: [], advice: [], trace: [], status: '可用依据已核对' };
    if (state.mode === 'mem0_down') {
      result.trace.push('Mem0 模拟超时 → 跳过候选排序 → 直接读取本地 SQL 当前确认事实。');
      result.status = '本地 SQL 回退完成';
    } else {
      result.trace.push('辅助检索返回 m-101 v1 候选；候选只提供定位，不提供事实权威。');
    }
    if (state.mode === 'delete') {
      result.rejected.push('m-101 已在 SQL 删除：旧投影正文被剔除，已删除正文不参与建议。');
      result.advice.push('客户偏好暂无当前确认依据；先向客户重新确认跟进顺序，不沿用已删除内容。');
    } else {
      const version = state.mode === 'edit' ? 'v2' : 'v1';
      result.facts.push('SQL m-101 ' + version + ' 当前确认正文：' + data.sqlBody + '。');
      if (state.mode === 'edit') {
        result.rejected.push('Mem0 v1 旧投影不覆盖 SQL v2；旧的“先收到书面方案”不继续支撑建议。');
      }
      result.advice.push(state.mode === 'edit' ? '先与赵强确认技术范围，再协助安排内部评审。' : '先准备书面方案，再与赵强安排内部评审。');
    }
    result.trace.push('以候选 ID 回查 SQL 的存在性、确认状态、版本和当前正文。');
    if (state.mode === 'wiki_revision' && !state.currentWiki) {
      result.rejected.push('资料 P-17：检索候选 v3 与当前原文 v4 不一致，版本核验拒绝旧引用。');
      result.advice.push('当前没有通过版本核验的政策引用；读取当前原文后再检索，暂不承诺交付。');
      result.status = '旧版本引用被拒绝';
    } else if (state.mode === 'wiki_withdrawn') {
      result.rejected.push('资料 P-17 已撤回：即使旧索引仍命中 v3，也不返回或引用撤回正文。');
      result.advice.push('没有可引用的当前政策；向业务负责人补充合格依据，暂不承诺交付。');
      result.status = '撤回资料被拒绝';
    } else if (state.mode === 'wiki_unauthorized') {
      result.rejected.push('资料 P-17 当前身份无权读取：拒绝返回正文，旧候选不能绕过授权。');
      result.advice.push('没有当前身份可读取的政策依据；申请合适的授权或请有权限的负责人复核，暂不承诺交付。');
      result.status = '越权资料被拒绝';
    } else {
      result.citations.push('授权原文 P-17 · ' + data.candidateVersion + ' · ' + (data.candidateVersion === 'v4' ? 'hash-policy-v4' : 'hash-policy-v3') + '：' + data.pageBody);
      result.advice.push(data.candidateVersion === 'v4' ? '按 v4 补齐负责人及资源排期书面确认，再讨论交付承诺。' : '按 v3 先确认合同范围、交付时间与业务负责人意见，不直接承诺交付。');
      if (state.mode === 'wiki_revision') result.status = '当前原文 v4 核验通过';
    }
    result.trace.push('原文回查依次核对身份权限、发布资格、版本及内容指纹；不信任索引中的旧正文。');
    result.advice.push('客户偏好只决定沟通顺序，不等于公司政策，也不构成交付授权。');
    state.result = result;
    state.searched = true;
    state.searches += 1;
  }

  function act(state, action) {
    const prefix = 'knowledge-scenario-';
    if (action.indexOf(prefix) === 0) {
      const mode = action.slice(prefix.length);
      if (!modes.some(function (item) { return item[0] === mode; })) return;
      state.mode = mode;
      state.searched = false;
      state.currentWiki = false;
      state.result = null;
      return;
    }
    if (action === 'knowledge-source') state.sourceVisible = !state.sourceVisible;
    if (action === 'knowledge-search') retrieve(state);
    if (action === 'knowledge-current-wiki' && state.mode === 'wiki_revision' && state.searched) {
      state.currentWiki = true;
      retrieve(state);
    }
  }

  function render(state) {
    const data = snapshot(state);
    const result = state.result;
    let html = '<div class="showcase-panel" data-showcase-panel="knowledge">' +
      '<section class="showcase-card"><h3>同一问题，依据变化后还应怎样回答？</h3>' +
      '<p>起点：赵强的年度合同仍在已联系。先看记忆来源，再改变一项条件，检索相同问题，比较被采用与被拒绝的依据。</p>' +
      '<p class="showcase-note">固定问题：<strong>' + esc(question) + '</strong></p>' +
      '<div class="showcase-actions">' + modes.map(function (mode) {
        return button('knowledge-scenario-' + mode[0], mode[1], state.mode === mode[0], false);
      }).join('') + '</div></section>';
    html += '<div class="showcase-grid"><section class="showcase-card"><h3>1. 当前资料条件</h3>' +
      '<dl class="showcase-dl">' + pair('SQL 记忆', data.sqlStatus) + pair('辅助检索', data.projection) +
      pair('政策原文 P-17', data.pageStatus) + pair('原文当前版本', data.pageVersion) + '</dl>' +
      '<div class="showcase-actions">' + button('knowledge-source', state.sourceVisible ? '收起 SQL 记忆来源' : '查看 SQL 记忆来源', null, false) + '</div>';
    if (state.sourceVisible) {
      html += '<div class="showcase-note" data-knowledge-source><h4>SQL 当前事实来源</h4><dl class="showcase-dl">' +
        pair('记录', 'm-101 · 客户 C-101（赵强）· 客户确认的沟通偏好') + pair('状态与版本', data.sqlStatus) +
        pair('当前可用正文', data.sqlBody) + pair('确认依据', '示例客户跟进记录 F-09；这是客户偏好，不是企业政策') +
        '</dl></div>';
    }
    html += '</section><section class="showcase-card"><h3>2. 按当前条件检索</h3>' +
      '<p>每次检索都重读当前 SQL 和原文资格。切换条件后，上一份回答失效，需重新点击检索。</p>' +
      '<div class="showcase-actions">' + button('knowledge-search', '检索同一问题', null, false) + '</div>' +
      '<p class="showcase-status" role="status" aria-live="polite">' + esc(result ? result.status : '尚未检索；先选择条件，再检索同一问题。') + '</p>';
    if (state.mode === 'wiki_revision' && state.searched && !state.currentWiki) {
      html += '<p>旧索引命中 v3；原文已是 v4。可在此模拟读取当前授权版本并重新核验。</p><div class="showcase-actions">' +
        button('knowledge-current-wiki', '读取当前版本后重检', null, false) + '</div>';
    }
    html += '</section></div>';
    if (result) {
      html += '<section class="showcase-card" data-knowledge-result aria-live="polite"><h3>3. 本次回答与证据取舍</h3>' +
        '<h4>当前确认事实</h4>' + (result.facts.length ? list(result.facts) : '<p>没有可用的当前客户偏好事实。</p>') +
        '<h4>通过核验的政策引用</h4>' + (result.citations.length ? list(result.citations) : '<p>无；本次回答不能引用失效或无权读取的政策正文。</p>') +
        (result.rejected.length ? '<h4>拒绝使用的依据</h4>' + list(result.rejected) : '') +
        '<h4>由当前依据推导的建议</h4>' + list(result.advice) +
        '<details><summary>查看本次模拟检索轨迹</summary>' + list(result.trace) + '</details></section>';
    }
    return html + '</div>';
  }

  panels.knowledge = {
    title: '客户记忆与可信知识',
    intro: '让客户偏好、公司政策和旧索引各归其位：当前确认事实与授权原文决定本次回答。',
    create: create,
    render: render,
    act: act
  };
}());
