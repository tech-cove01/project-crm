/* Fixed browser fixture. No Pi, SQL, model or Worker runs in this page. */
(function () {
  'use strict';
  const panels = window.CRM_SHOWCASE_PANELS ||= {};
  const h = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const button = (action, label, disabled = false, primary = false) => `<button type="button" class="showcase-button${primary ? ' primary' : ''}" data-showcase-action="execution-${action}"${disabled ? ' disabled' : ''}>${label}</button>`;
  const create = () => ({ phase: 'idle', stage: '已联系', originalStage: '已联系', targetStage: '方案沟通', proposal: null, receipts: [], readback: null, events: [] });
  function record(s, tool, result) { s.events.push({ step: s.events.length + 1, tool, result }); }
  function act(s, action) {
    if (action === 'execution-analyze' && s.phase === 'idle') {
      record(s, 'crm.get_opportunity · 只读', '赵强 / 年度服务合同，阶段已联系，金额 ¥52,000；报价与交期尚待确认。');
      record(s, 'memory.read_current · 只读', '负责人已确认：客户希望先收到书面方案；这是客户偏好，不是公司承诺。');
      record(s, 'wiki.read_authorized · 只读', '年度服务政策 v3：方案沟通可以开始；报价和交期须单独确认。');
      s.proposal = { id: 'DEMO-PROPOSAL-01', from: s.stage, to: s.targetStage, decision: 'pending' };
      s.phase = 'waiting_approval';
      record(s, 'crm.propose_stage_change', '生成阶段提案，业务层暂停等待人工决定；未写入阶段。');
    }
    if (action === 'execution-approve' && s.phase === 'waiting_approval') {
      s.proposal.decision = 'approved'; s.phase = 'approved';
      record(s, 'human.approve', '批准已记录，尚未执行；商机仍为已联系。');
    }
    if (action === 'execution-reject' && s.phase === 'waiting_approval') {
      s.proposal.decision = 'rejected'; s.phase = 'rejected';
      record(s, 'human.reject', '拒绝已记录，不安排阶段变更；等待重读核对。');
    }
    if (action === 'execution-execute' && s.phase === 'approved' && !s.receipts.length) {
      s.stage = s.proposal.to;
      s.receipts.push({ id: 'DEMO-RECEIPT-01', proposal: s.proposal.id, from: s.proposal.from, to: s.stage, result: 'applied' });
      s.phase = 'executed';
      record(s, 'worker.apply_approved_action · 本地模拟', '阶段对象已改为方案沟通，写入唯一执行回执；尚未重读。');
    }
    if (action === 'execution-reread' && ['executed', 'rejected'].includes(s.phase)) {
      s.readback = { stage: s.stage, receiptCount: s.receipts.length, consistent: s.stage === (s.proposal.decision === 'approved' ? s.targetStage : s.originalStage) };
      s.phase = s.proposal.decision === 'approved' ? 'verified' : 'rejection_verified';
      record(s, 'crm.get_opportunity · 决定后独立重读', `当前阶段：${s.readback.stage}；执行回执 ${s.readback.receiptCount} 条；与人工决定一致。`);
    }
  }
  function render(s) {
    const labels = { idle: '待分析', waiting_approval: '等待人工批准', approved: '已批准 · 尚未执行', rejected: '已拒绝 · 尚未重读', executed: '已执行 · 尚未重读', verified: '重读核对一致', rejection_verified: '拒绝后重读一致' };
    return `<p class="showcase-start">起点：赵强需要年度服务方案。先核对依据，再把商机从“已联系”推进到“方案沟通”；这不代表签约或交期已确认。</p>
      <ol class="showcase-steps"><li>分析并查看提案</li><li>批准或拒绝</li><li>执行与回执</li><li>独立重读核对</li></ol>
      <div class="showcase-grid"><article class="showcase-card"><span class="showcase-label">固定示例商机</span><h3>赵强 · 年度服务合同</h3><dl class="showcase-dl"><dt>当前阶段</dt><dd data-execution-stage>${h(s.stage)}</dd><dt>金额</dt><dd>¥52,000</dd><dt>执行回执</dt><dd data-execution-receipts>${s.receipts.length} 条</dd><dt>报价与交期</dt><dd>尚待客户确认</dd></dl></article>
      <article class="showcase-card"><span class="showcase-label">任务与业务结果分开</span><h3 data-execution-status>${h(labels[s.phase])}</h3><p>${s.phase === 'verified' ? '阶段变更已有回执，并由第二次读取核对。合同是否被接受仍未确认。' : s.phase === 'rejection_verified' ? '拒绝后的重读确认阶段仍为已联系，没有执行回执。' : s.phase === 'waiting_approval' ? '分析已结束，业务动作仍待决定。待批时阶段保持不变。' : s.phase === 'approved' ? '人工批准只是执行前提。点击执行，才会修改这个浏览器示例对象。' : s.phase === 'executed' ? '已经产生本地阶段效果和回执。点击重读，核对决定与当前状态。' : '按下方步骤操作，观察任务、决定、业务效果与核对结果。'}</p></article></div>
      <div class="showcase-actions">${button('analyze', '分析并生成阶段提案', s.phase !== 'idle', true)}${button('approve', '批准阶段变更', s.phase !== 'waiting_approval')}${button('reject', '拒绝阶段变更', s.phase !== 'waiting_approval')}${button('execute', '执行已批准变更', s.phase !== 'approved')}${button('reread', '重读商机状态', !['executed', 'rejected'].includes(s.phase))}</div>
      ${s.proposal ? `<article class="showcase-card showcase-proposal"><h3>阶段变更提案</h3><p><strong>${h(s.proposal.from)} → ${h(s.proposal.to)}</strong></p><p>理由：客户已提出书面方案诉求，当前授权政策允许进入方案沟通。未提议成交，也未承诺交付日期。</p><dl class="showcase-dl"><dt>提案</dt><dd>${h(s.proposal.id)}</dd><dt>决定</dt><dd>${h({ pending: '待批准', approved: '已批准', rejected: '已拒绝' }[s.proposal.decision])}</dd></dl></article>` : ''}
      <p class="showcase-status" role="status" aria-live="polite">${h(labels[s.phase])} · 当前阶段 ${h(s.stage)} · 执行回执 ${s.receipts.length} 条${s.readback ? ` · 重读阶段 ${h(s.readback.stage)}` : ''}</p>
      ${s.receipts.length ? `<article class="showcase-card"><h3>执行回执 1 条</h3><p>${h(s.receipts[0].id)} · ${h(s.receipts[0].from)} → ${h(s.receipts[0].to)} · applied</p><p class="showcase-note">重复点击不会创建第二条回执；这里只证明本地固定状态转换。</p></article>` : ''}
      ${s.events.length ? `<details class="showcase-details" open><summary>查看工具步骤与续跑记录（${s.events.length}）</summary><ol class="showcase-list">${s.events.map(e => `<li><strong>${h(e.tool)}</strong><p>${h(e.result)}</p></li>`).join('')}</ol></details>` : ''}
      <details class="showcase-details"><summary>为什么这样执行？</summary><p>正式系统中 Pi 负责模型与工具循环，业务层检查组织、角色和对象范围；持久队列与独立 Worker 承接长任务及等待审批。本站用可检查的本地对象演示这些边界，没有实际运行 Pi、SQL 或 Worker。</p><p>批准后重读与拒绝分支分别说明：任务结束、人工决定、实际执行、业务完成是不同状态。</p><a href="https://github.com/tech-cove01/project-crm/blob/main/docs/evidence/CRM-021a-approved-chain.md" target="_blank" rel="noopener">查看公开真实批准记录及限制</a></details>`;
  }
  panels.execution = { title: 'Pi 内核与受控执行', intro: '先提出阶段建议，人工决定后执行，再读取当前商机核对结果。', create, render, act };
})();
