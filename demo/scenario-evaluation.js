/* Deterministic simulated evaluation. No model or Judge request is sent. */
(function () {
  'use strict';
  const panels = window.CRM_SHOWCASE_PANELS ||= {};
  const h = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const evidence = { stage: '已联系', amount: 52000, sourceId: 'ANNUAL-POLICY', version: 3, authorized: true, deliveryConfirmed: false };
  const samples = {
    normal: { name: '正常回答', stage: '已联系', amount: 52000, sourceId: 'ANNUAL-POLICY', version: 3, deliveryConfirmed: false, answer: '商机目前处于已联系，金额 ¥52,000。依据年度服务政策 v3，可以准备方案沟通；报价与交期仍待确认。', judge: 94 },
    citation: { name: '错引资料', stage: '已联系', amount: 52000, sourceId: 'DRAFT-POLICY', version: 1, deliveryConfirmed: true, answer: '商机目前处于已联系，金额 ¥52,000。依据草稿政策 v1，可以保证两周内交付。', judge: 96 },
    field: { name: '字段误述', stage: '方案沟通', amount: 52000, sourceId: 'ANNUAL-POLICY', version: 3, deliveryConfirmed: false, answer: '商机目前已进入方案沟通，金额 ¥52,000。依据年度服务政策 v3，报价与交期仍待确认。', judge: 95 }
  };
  const create = () => ({ sample: 'normal', report: null, history: [], runs: 0, replayCount: 0 });
  function evaluate(sample) {
    const findings = [];
    if (sample.stage !== evidence.stage) findings.push({ code: 'crm.stage_mismatch', tool: 'crm.get_opportunity', expected: evidence.stage, actual: sample.stage, text: '字段误述：回答阶段与 CRM 工具结果不一致。' });
    if (sample.amount !== evidence.amount) findings.push({ code: 'crm.amount_mismatch', tool: 'crm.get_opportunity', expected: evidence.amount, actual: sample.amount, text: '金额与工具结果不一致。' });
    if (!evidence.authorized || sample.sourceId !== evidence.sourceId || sample.version !== evidence.version) findings.push({ code: 'citation.source_or_version_invalid', tool: 'wiki.read_authorized', expected: `${evidence.sourceId} v${evidence.version}`, actual: `${sample.sourceId} v${sample.version}`, text: '错引资料：引用不是当前已授权的政策原文与版本。' });
    if (sample.deliveryConfirmed && !evidence.deliveryConfirmed) findings.push({ code: 'claim.delivery_unsupported', tool: 'wiki.read_authorized', expected: '交期未确认', actual: '保证两周交付', text: '交付承诺没有当前原文支持。' });
    const rules = findings.length ? 'fail' : 'pass';
    const judge = { status: 'pass', score: sample.judge, note: '模拟语义评价：表达清晰、建议易读；单靠语义评分未识别全部字段与引用问题。' };
    const severity = { pass: 0, needs_review: 1, fail: 2 };
    const merged = severity[rules] >= severity[judge.status] ? rules : judge.status;
    return { rules, judge, merged, findings, sample: structuredClone(sample), replay: false };
  }
  function act(s, action) {
    const selected = action.replace('evaluation-sample-', '');
    if (action.startsWith('evaluation-sample-') && samples[selected]) { s.sample = selected; s.report = null; }
    if (action === 'evaluation-run') {
      s.report = evaluate(samples[s.sample]); s.runs++;
      if (s.report.rules === 'fail') s.history.push({ id: `DEMO-FAIL-${s.history.length + 1}`, sample: s.sample, report: structuredClone(s.report) });
    }
    if (action === 'evaluation-replay' && s.history.length) {
      const old = s.history.at(-1); s.sample = old.sample;
      s.report = evaluate(old.report.sample); s.report.replay = true; s.report.originalId = old.id; s.runs++; s.replayCount++;
    }
  }
  function render(s) {
    const sample = samples[s.sample], r = s.report;
    return `<p class="showcase-start">起点：同一份 CRM 工具结果与授权原文，对比三种回答。点击运行后，规则逐项比较字段和引用；模拟 Judge 单独给语义分，再保留更严格结论。</p>
      <ol class="showcase-steps"><li>选择回答样例</li><li>运行规则与模拟 Judge</li><li>定位证据</li><li>重放已保存失败</li></ol>
      <div class="showcase-actions" aria-label="选择评测回答">${Object.entries(samples).map(([id, item]) => `<button type="button" class="showcase-button${s.sample === id ? ' selected' : ''}" data-showcase-action="evaluation-sample-${id}" aria-pressed="${s.sample === id}">${item.name}</button>`).join('')}</div>
      <div class="showcase-grid"><article class="showcase-card"><span class="showcase-label">当前工具事实与原文 · 固定真值</span><h3>先看依据</h3><dl class="showcase-dl"><dt>CRM 阶段</dt><dd>已联系</dd><dt>金额</dt><dd>¥52,000</dd><dt>授权原文</dt><dd>年度服务政策 v3 · ANNUAL-POLICY</dd></dl><blockquote>服务范围及交付日期需要单独确认。</blockquote></article>
      <article class="showcase-card"><span class="showcase-label">${h(sample.name)} · 模拟回答</span><h3>待核对的最终回答</h3><p data-evaluation-answer>${h(sample.answer)}</p></article></div>
      <div class="showcase-actions"><button type="button" class="showcase-button primary" data-showcase-action="evaluation-run">运行规则与模拟 Judge</button><button type="button" class="showcase-button" data-showcase-action="evaluation-replay"${s.history.length ? '' : ' disabled'}>重放失败回归</button></div>
      ${r ? `<div class="showcase-score-grid"><article class="showcase-card"><span class="showcase-label">确定性规则</span><h3 data-evaluation-rules class="${r.rules === 'fail' ? 'showcase-fail' : 'showcase-pass'}">${r.rules}</h3><p>${r.findings.length ? `${r.findings.length} 项硬失败` : '阶段、金额、引用版本及承诺均与依据一致。'}</p></article><article class="showcase-card"><span class="showcase-label">模拟 Judge · 非真实调用</span><h3>pass · ${r.judge.score} / 100</h3><p>${h(r.judge.note)}</p></article><article class="showcase-card"><span class="showcase-label">合并结论 · 保留更严格结果</span><h3 data-evaluation-merged class="${r.merged === 'fail' ? 'showcase-fail' : 'showcase-pass'}">${r.merged}</h3><p>${r.merged === 'fail' ? '高语义分不能覆盖确定性失败，需复核后再使用回答。' : '此固定样例通过；不是项目整体准确率。'}</p></article></div>
      <p class="showcase-status" role="status" aria-live="polite">${r.replay ? '本次回归仍失败 · 原失败记录保留' : `评测完成：规则 ${r.rules} · 模拟 Judge pass/${r.judge.score} · 合并 ${r.merged}`}</p>
      ${r.findings.length ? `<article class="showcase-card"><h3>从问题回到工具与证据</h3><ul class="showcase-list">${r.findings.map(f => `<li><strong>${h(f.text)}</strong><p>${h(f.code)} → ${h(f.tool)}；预期：${h(f.expected)}；回答：${h(f.actual)}。</p></li>`).join('')}</ul></article>` : ''}
      <details class="showcase-details"><summary>展开脱敏轨迹</summary><p class="showcase-note">以下为本地模拟观察值，无客户消息、密钥、隐藏推理或实际模型用量。</p><ol class="showcase-list"><li><strong>crm.get_opportunity</strong><p>目标：DEMO-OPPORTUNITY；客户：客户 A；阶段：已联系；金额：52000。</p></li><li><strong>wiki.read_authorized</strong><p>知识库：DEMO-PRODUCTS；原文 ANNUAL-POLICY；页版本：3；authorized=true；交期未确认。</p></li><li><strong>rules.evaluate</strong><p>字段与来源断言：${h(r.rules)}；${r.findings.map(f => h(f.code)).join(' / ') || '无失败'}。</p></li><li><strong>semantic_judge · 模拟</strong><p>pass/${r.judge.score}；Rubric：demo-v1；真实模型调用：0。</p></li><li><strong>evaluation.merge</strong><p>按严重程度合并：${h(r.merged)}。${r.replay ? `回放来源：${h(r.originalId)}，没有覆盖原记录。` : ''}</p></li></ol></details>` : '<p class="showcase-status" role="status">选择样例后运行，查看字段、引用、语义分与合并结果。</p>'}
      <article class="showcase-card"><h3>历史失败保留 · ${s.history.length} 条</h3>${s.history.length ? `<ul class="showcase-list">${s.history.map(f => `<li>${h(f.id)} · ${h(samples[f.sample].name)} · 原规则 fail / 合并 fail</li>`).join('')}</ul><p>已回放 ${s.replayCount} 次；回放重新计算同一份固定材料，原始失败仍留在列表中。</p>` : '<p>先运行错引或字段误述样例，再重放失败回归。重置本场景才会清空这些示例记录。</p>'}</article>
      <details class="showcase-details"><summary>模拟、历史评测与真实轨迹的边界</summary><p>这里的规则由浏览器实际比较固定字段与引用；Judge 分数为预设模拟值，没有调用模型。正式系统按需单独调用 Judge，并保存规则、Rubric、指纹和版本；Judge 是辅助复核，不是独立真值。</p><p>公开记录中的真实评测保留 needs_review 与原失败，不能从本页样例推导整体准确率或已校准。</p><a href="https://github.com/tech-cove01/project-crm/blob/main/docs/evidence/CRM-020f-observation-evaluation.md" target="_blank" rel="noopener">查看公开真实评测记录及限制</a></details>`;
  }
  panels.evaluation = { title: 'Agent 观测与评测回归', intro: '把正常回答、错引和字段误述放回相同证据中核验，高分不能覆盖硬失败。', create, render, act };
})();
