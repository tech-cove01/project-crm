/* Lessons only explain and observe visitor actions on the fixed knowledge example. */
(function () {
  'use strict';
  const lessons = window.CRM_GUIDE_LESSONS ||= {};
  const action = name => `[data-showcase-action="${name}"]`;
  lessons.knowledge = {
    title: '先看依据，再看看旧资料为什么不能用',
    intro: '先查看客户偏好的来源，再检索同一个问题。随后亲自切换资料改版，观察旧引用被拒绝，最后读取当前版本。刷新会回到场景起点。',
    takeaway: '检索命中只是找到线索。客户事实要重读当前记录，公司政策还要核对权限、版本与原文；旧知识不能继续支撑承诺。',
    principle: '../details.html#trusted-context',
    resumeAt: ({ state: s }) => s.mode === 'wiki_revision'
      ? (s.currentWiki && s.result?.citations.length ? 6 : s.searched ? 5 : 4)
      : s.searched ? 2 : s.sourceVisible ? 1 : 0,
    steps: [
      { id: 'source', title: '先看看客户偏好从哪里来',
        text: '点“查看 SQL 记忆来源”。这里保存客户确认过的沟通偏好，不是公司可以承诺交付的政策。',
        target: action('knowledge-source'), action: 'knowledge-source',
        predicate: ({ state: s }) => s.sourceVisible,
        resultTarget: '[data-knowledge-source]',
        resultText: ({ state: s }) => s.mode === 'delete'
          ? '这是预期保护：当前记录已删除，不返回旧偏好正文。接着检索，看看建议会怎样处理缺少的依据。'
          : `来源已展开：客户确认的偏好保存在当前 SQL 记录中。${s.mode === 'edit' ? '修改后的偏好以 v2 为准。' : '它只决定沟通顺序，不能替代公司授权。'}` },
      { id: 'search', title: '用当前依据回答同一个问题',
        text: '点“检索同一问题”。系统会重新读取当前事实和政策资格，而不是直接复制旧索引里的文字。',
        target: action('knowledge-search'), action: 'knowledge-search',
        predicate: ({ state: s }) => s.searched && Boolean(s.result),
        resultTarget: '[data-knowledge-facts]',
        resultText: ({ state: s }) => s.result.facts.length
          ? `本次采用了当前确认事实。${s.mode === 'mem0_down' ? '记忆服务异常时已回退读取本地 SQL。' : '辅助检索只负责定位，当前记录决定实际正文。'}下一步单独看政策引用。`
          : '这是预期保护：已删除的偏好没有混入回答。没有当前确认事实时，建议先向客户重新确认；接着再看政策引用。' },
      { id: 'citation', title: '把客户偏好与公司政策分开看',
        text: ({ state: s }) => s.result?.citations.length
          ? '高亮处是通过核验的公司政策引用。客户想先收方案，不等于可以承诺交期；引用仍要求先完成负责人等确认。看懂后点“继续”。'
          : '这是预期保护：当前没有通过资格核验的政策引用。不能根据客户偏好或旧索引直接承诺交付。看懂后点“继续”。',
        target: '[data-knowledge-citations]', action: 'observe' },
      { id: 'revision', title: '亲自切换到资料改版的情况',
        text: '点“资料改版”。这会清除本场景上一份检索回答：旧索引仍是 v3，当前授权原文已更新为 v4。然后需要重新检索。',
        target: action('knowledge-scenario-wiki_revision'), action: 'knowledge-scenario-wiki_revision',
        predicate: ({ state: s }) => s.mode === 'wiki_revision' && !s.searched && !s.result,
        resultTarget: '[data-knowledge-conditions]',
        resultText: '资料条件已经变为当前原文 v4，尚未重新检索。切换条件不能沿用上一份回答；下一步亲自检索。' },
      { id: 'reject-old', title: '看看命中旧版本会怎样',
        text: '点“检索同一问题”。这一次旧索引会命中 v3，但还要与当前原文 v4 比较。',
        target: action('knowledge-search'), action: 'knowledge-search',
        predicate: ({ state: s }) => s.mode === 'wiki_revision' && s.searched && !s.currentWiki && s.result?.citations.length === 0 && s.result.rejected.length > 0,
        resultTarget: '[data-knowledge-rejected]',
        resultText: '这是预期保护：旧 v3 引用被版本核验拒绝，回答没有采用它。目前不能据此承诺交付；需要再读当前授权原文。' },
      { id: 'current', title: '读取当前版本，重新核对引用',
        text: '点“读取当前版本后重检”。取得当前授权的 v4 原文后，才能重新形成政策依据。',
        target: action('knowledge-current-wiki'), action: 'knowledge-current-wiki',
        predicate: ({ state: s }) => s.mode === 'wiki_revision' && s.currentWiki && s.result?.citations.some(citation => citation.includes('v4')),
        resultTarget: '[data-knowledge-citations]',
        resultText: '当前 v4 引用已通过核验：除了负责人确认，还要求资源排期书面确认。回答按新条件更新，但不代表这些条件已经完成。' }
    ]
  };
})();
