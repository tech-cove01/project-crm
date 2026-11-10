/* Deterministic example only: every run and replay still requires a real visitor click. */
(function () {
  'use strict';
  const lessons = window.CRM_GUIDE_LESSONS ||= {};
  const action = name => `[data-showcase-action="${name}"]`;
  lessons.evaluation = {
    title: '看看高分为什么仍然可能不合格',
    intro: '先运行一份正常回答，再亲自选择错引样例。比较规则与模拟语义分，最后重放已保存的原始失败。刷新会回到场景起点；这里不调用真实模型。',
    takeaway: '表达清楚不代表事实正确。字段和引用的硬失败不能被高语义分覆盖；保留原失败，才能重放同一问题检查回归。',
    principle: '../details.html#observation-evaluation',
    resumeAt: ({ state: s }) => s.report?.replay ? 5 : s.report?.rules === 'fail' ? 4 : s.sample !== 'normal' ? 3 : s.report ? 2 : 0,
    steps: [
      { id: 'normal', title: '先选择正常回答作为对照',
        text: '点“正常回答”，让我们从与当前 CRM、授权原文一致的回答开始。选择样例只更换待核对的内容，尚未评测。',
        target: action('evaluation-sample-normal'), action: 'evaluation-sample-normal',
        predicate: ({ state: s }) => s.sample === 'normal' && !s.report,
        resultTarget: '[data-evaluation-answer]',
        resultText: '这份回答写的是已联系、¥52,000、年度服务政策 v3，并保留交期待确认。下一步运行评测，不能只凭读起来通顺就判合格。' },
      { id: 'run-normal', title: '核对规则与模拟语义评价',
        text: '点“运行规则与模拟 Judge”。浏览器会实际比较固定字段与引用；Judge 分数是预设模拟值，没有模型调用。',
        target: action('evaluation-run'), action: 'evaluation-run',
        predicate: ({ state: s }) => s.sample === 'normal' && s.report?.rules === 'pass' && s.report.merged === 'pass',
        resultTarget: () => document.querySelector('[data-evaluation-merged]')?.closest('article'),
        resultText: '规则 pass，模拟 Judge 94分，合并 pass：这一个固定样例通过。它不能代表项目整体准确率。接着换一份听起来流畅、但引用错误的回答。' },
      { id: 'wrong-citation', title: '亲自换成错引资料的回答',
        text: '点“错引资料”。这份回答引用草稿政策 v1，还承诺两周交付；当前授权原文并不支持这些内容。',
        target: action('evaluation-sample-citation'), action: 'evaluation-sample-citation',
        predicate: ({ state: s }) => s.sample === 'citation' && !s.report,
        resultTarget: '[data-evaluation-answer]',
        resultText: '错引回答已选中，尚未评测。对照当前授权的年度服务政策 v3，草稿 v1 和保证两周交付都缺少合格依据。' },
      { id: 'run-failure', title: '检查高分能否覆盖错引',
        text: ({ state: s }) => `点“运行规则与模拟 Judge”，比较${s.sample === 'field' ? '字段误述' : '错引资料'}的规则结果和模拟语义分。结论应保留更严格的一项。`,
        target: action('evaluation-run'), action: 'evaluation-run',
        predicate: ({ state: s }) => s.sample !== 'normal' && s.report?.rules === 'fail' && s.report.merged === 'fail' && s.history.length > 0,
        resultTarget: () => document.querySelector('[data-evaluation-merged]')?.closest('article'),
        resultText: ({ state: s }) => `这是预期保护：规则发现${s.sample === 'field' ? '阶段字段与 CRM 不一致' : '引用版本不合格、交付承诺无依据'}，即使模拟 Judge 给了${s.report.judge.score}分，合并仍为 fail。原失败已保存，下一步重放它。` },
      { id: 'replay', title: '重放同一份失败材料',
        text: '点“重放失败回归”。会用最后一份已保存失败的原始材料重新计算，保留原记录，不会换成正常样例冒充修复成功。',
        target: action('evaluation-replay'), action: 'evaluation-replay',
        predicate: ({ state: s }) => s.report?.replay && s.report.merged === 'fail' && s.history.some(item => item.id === s.report.originalId),
        resultTarget: '[data-evaluation-history]',
        resultText: ({ state: s }) => `这是预期保护：原失败 ${s.report.originalId} 仍在历史中，同一份材料重放后仍为 fail。这里只演示失败可追溯、可重放，没有声称这个错误已被修复。` }
    ]
  };
})();
