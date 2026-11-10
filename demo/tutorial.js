/* A guided, browser-only demonstration. The visitor's exploration state is restored on exit. */
(function () {
  'use strict';
  const SEEN_KEY = 'project-crm.demo-tutorial.seen.v1';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const lessons = [
    { title: '从一笔商机开始', text: '继续跟进赵强的年度服务合同。先核对客户问题和当前商机，再准备下一步建议与回复草稿；报价与交期仍待客户确认。', example: '赵强：“请再发一份年度合同，并确认预计什么时候开始。”', targets: ['.agent-contextbar', '#agent-task'], prepare() { navigate('/app/ai/workbench', true); } },
    { title: '先看商机卡在哪里', text: '看板把阶段、金额和下一次跟进放在一起。打开商机档案，可以看到相关客户、记录和业务任务。', example: '这笔商机已停滞 8 天。需要先确认服务范围与交期，再决定下一步。', targets: ['.drawer h2', '.drawer-body', '[data-lead-drag="l4"]'], prepare() { navigate('/app/pipelines/demo', true); state.drawer = { kind: 'lead', id: 'l4' }; render(); } },
    { title: '记住客户确认过的事实', text: '客户偏好、约束和约定放在客户档案里。确认事实由 SQL 保存，Mem0 辅助检索；检索命中后仍要重读当前事实。', example: '“客户希望某日上线”是客户诉求，并不等于公司已经承诺该日期。', targets: ['[data-service-contact="c4"]', '.drawer-body'], prepare() { navigate('/app/contacts', true); state.drawer = { kind: 'contact', id: 'c4' }; render(); } },
    { title: '产品承诺要有企业依据', text: '产品说明、FAQ 和公司政策属于企业知识。分析应核对允许使用的资料，资料改版或撤回后重新确认依据。', example: '客户记忆解释“客户想要什么”；企业资料说明“公司能提供什么”。', targets: ['[data-knowledge="k1"]', '.tablebox', '.settings-stack'], prepare() { navigate('/app/ai/knowledge/sources', true); } },
    { title: '运行一次分析示例', text: '现在把客户和商机带回工作台。运行固定示例，观察读取上下文、策略判断、创建可撤销的本地跟进，以及准备回复草稿。', example: '点击下方“运行演示分析”。这里复用现有浏览器演示，不请求真实模型。', targets: ['#agent-task', '#agent-conversation', '.agent-conversation'], prepare() { navigate('/app/ai/workbench', true); state.agent = 1; state.mode = 'act'; render(); } },
    { title: '由你决定是否批准', text: 'Agent 已准备好回复草稿。看看草稿，再选择批准或拒绝。这个决定只改变本地演示状态，不会向客户发送消息。', example: '内部可撤销操作与面向客户的动作有不同边界；模型说“完成”不能替代你的业务决定。', targets: ['.agent-sidepanel [data-action="approve"]', '.agent-panel-body'], prepare() { navigate('/app/ai/workbench', true); openAgentPanel('details'); } },
    { title: '最后，核对实际发生了什么', text: '核对明日跟进任务、草稿决定与未发送状态。报价与交期仍待客户确认，运行结束和模拟入队都不能证明合同已获客户接受。', example: '教程到此结束。完成后恢复进入前的页面和数据，你可以继续自由探索。', targets: ['.agent-trace', '.agent-panel-body'], prepare() { navigate('/app/ai/workbench', true); openAgentPanel('details'); } }
  ];
  let mode = null, index = 0, snapshot = null, tutorialState = null, returnFocus = null, oldOverflow = '', oldInert = false, frame = null;
  const button = (action, text, primary = false, disabled = false) => `<button type="button" class="tutorial-button${primary ? ' primary' : ''}" data-tutorial-action="${action}"${disabled ? ' disabled' : ''}>${text}</button>`;
  function markSeen() { try { sessionStorage.setItem(SEEN_KEY, '1'); } catch { /* The tour remains usable without storage. */ } }
  function entrypoints() {
    const scenarioGuide = Boolean(window.CRM_SHOWCASE?.getState().scenario);
    const header = document.querySelector('.agent-header-actions');
    if (header && !header.querySelector('[data-demo-tutorial]') && !(scenarioGuide && header.querySelector('[data-scenario-guide]'))) header.insertAdjacentHTML('afterbegin', '<button type="button" class="btn tutorial-entry" data-demo-tutorial>旧版完整教程</button>');
    const side = document.querySelector('.project-sidebar-links');
    if (side && !side.querySelector('[data-demo-tutorial]') && !(scenarioGuide && side.querySelector('[data-scenario-guide]'))) side.insertAdjacentHTML('beforeend', '<button type="button" class="tutorial-entry" data-demo-tutorial>旧版完整教程</button>');
    if (window.CRM_SHOWCASE?.getState().scenario) document.querySelectorAll('[data-demo-tutorial]').forEach(el => { el.textContent = '跟我操作'; });
  }
  function layer() {
    let element = document.getElementById('demo-tutorial');
    if (!element) {
      element = document.createElement('div'); element.id = 'demo-tutorial'; element.className = 'tutorial-layer';
      element.innerHTML = '<div class="tutorial-dim" aria-hidden="true"></div><div class="tutorial-spotlight" aria-hidden="true"></div><section class="tutorial-card" role="dialog" aria-modal="true" aria-labelledby="tutorial-title"></section>';
      document.body.append(element);
    }
    return element;
  }
  function lock() {
    const app = document.getElementById('app'); oldInert = app.hasAttribute('inert'); oldOverflow = document.body.style.overflow;
    app.setAttribute('inert', ''); document.body.style.overflow = 'hidden';
  }
  function focusAction(action = 'next') {
    const card = document.querySelector('.tutorial-card');
    (card?.querySelector(`[data-tutorial-action="${action}"]:not(:disabled)`) || card?.querySelector('button:not(:disabled)'))?.focus({ preventScroll: true });
  }
  function showWelcome(opener) {
    if (mode) return;
    if (window.CRM_SHOWCASE?.getState().scenario) { window.CRM_SCENARIO_GUIDE?.open(null, opener); return; }
    if (window.CRM_SCENARIO_GUIDE?.getState().open) window.CRM_SCENARIO_GUIDE.exit();
    returnFocus = opener || document.activeElement; mode = 'welcome'; lock(); updateCard(); focusAction('start');
  }
  function start() {
    if (state.busy) { updateCard(); focusAction('skip'); return; }
    markSeen();
    snapshot = { state, url: location.href, history: history.state, scrollX, scrollY, focusId: returnFocus?.id };
    state = fresh(); tutorialState = state; index = 0; mode = 'step'; showStep();
  }
  function showStep() {
    lessons[index].prepare(); updateCard();
    const target = findTarget(); target?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    schedulePosition(); focusAction();
  }
  function completedAnalysis() { return !!state.detail && state.detail.status === 'completed'; }
  function next() {
    if (mode !== 'step') return;
    if (index === 4 && !completedAnalysis()) return;
    if (index === 5 && state.detail?.proposal === 'pending') return;
    if (index === lessons.length - 1) { exit(); return; }
    index++; showStep();
  }
  function previous() { if (mode === 'step' && index > 0 && !state.busy) { index--; showStep(); } }
  function runExample() {
    if (mode !== 'step' || index !== 4 || state.busy || completedAnalysis()) return;
    state.task = '核对赵强的年度服务合同，整理下一步跟进并准备回复草稿，暂不发送。';
    state.agent = 1; state.mode = 'act'; runAgent(); updateCard(); focusAction('exit');
  }
  function decide(decision) {
    if (mode !== 'step' || index !== 5 || state.detail?.proposal !== 'pending') return;
    decideProposal(decision); updateCard(); focusAction();
  }
  function updateCard() {
    if (!mode) return;
    const element = layer(), card = element.querySelector('.tutorial-card');
    const focused = card.contains(document.activeElement) ? document.activeElement.dataset.tutorialAction : null;
    const oldScroll = card.scrollTop;
    element.dataset.layout = mode;
    if (mode === 'welcome') {
      card.innerHTML = `<div class="tutorial-topline"><span class="tutorial-kicker">演示教程 · 约 2 分钟</span><button type="button" class="tutorial-exit" data-tutorial-action="skip" aria-label="关闭演示教程邀请">关闭 ×</button></div><h2 id="tutorial-title">跟着一笔商机，体验 CRM</h2><p class="tutorial-description">沿着赵强的年度服务合同，核对客户问题与资料，准备跟进草稿，再由你作出决定。</p><p class="tutorial-story-link"><a href="../details.html#workflow">先阅读完整 CRM 的业务讲解 ↗</a></p><div class="tutorial-points"><span>7 个步骤</span><span>随时退出</span><span>不影响自由探索数据</span></div>${state.busy ? '<p class="tutorial-example" role="status">当前演示任务正在运行，结束或取消后就可以开始教程。</p>' : '<p class="tutorial-example">你也可以直接跳过，稍后从工作台或侧栏的“演示教程”重新打开。</p>'}<div class="tutorial-controls">${button('skip','暂不体验')} ${button('start','开始演示教程',true,state.busy)}</div><p class="tutorial-footnote">使用浏览器固定示例，无需账号，不调用真实模型或发送消息。</p>`;
    } else {
      const lesson = lessons[index], analysis = index === 4, decision = index === 5;
      const ready = completedAnalysis(), proposal = state.detail?.proposal;
      let operation = '';
      if (analysis) operation = `<div class="tutorial-operation">${button('run',state.busy ? '正在演示…' : ready ? '分析示例已完成' : '运行演示分析',true,state.busy || ready)}</div><p class="tutorial-status" role="status" aria-live="polite">${state.busy ? '正在展示工具与处理步骤，请稍候。' : ready ? '已生成本地跟进任务与回复草稿，下一步看看如何审核。' : '运行后将展示既有的固定分析流程。'}</p>`;
      if (decision) operation = `<div class="tutorial-operation">${button('approve','批准演示草稿',true,proposal !== 'pending')}${button('reject','拒绝演示草稿',false,proposal !== 'pending')}</div><p class="tutorial-status" role="status" aria-live="polite">${proposal === 'approved' ? '你选择了批准，已记录本地入队状态；没有实际发送。' : proposal === 'rejected' ? '你选择了拒绝，草稿不会进入后续发送。' : '请选择一种决定，继续查看记录。'}</p>`;
      const blocked = analysis && !ready || decision && proposal === 'pending';
      card.innerHTML = `<div class="tutorial-topline"><span class="tutorial-kicker">演示教程 · ${index + 1} / ${lessons.length}</span><button type="button" class="tutorial-exit" data-tutorial-action="exit">退出教程 ×</button></div><div class="tutorial-progress" aria-label="第 ${index+1} 步，共 ${lessons.length} 步">${lessons.map((_,i)=>`<span class="${i < index ? 'done' : i === index ? 'current' : ''}"></span>`).join('')}</div><h2 id="tutorial-title">${escape(lesson.title)}</h2><p class="tutorial-description">${escape(lesson.text)}</p><div class="tutorial-example">${escape(lesson.example)}</div>${operation}<div class="tutorial-controls">${button('previous','上一步',false,index === 0 || state.busy)}<div class="tutorial-control-right">${button('next',index === lessons.length-1 ? '完成，开始探索' : '下一步 →',true,blocked)}</div></div>`;
    }
    card.scrollTop = oldScroll;
    if (focused) focusAction(focused);
    schedulePosition();
  }
  function findTarget() {
    if (mode !== 'step') return null;
    for (const selector of lessons[index].targets) {
      const element = document.querySelector(selector);
      if (element && element.getBoundingClientRect().width && element.getBoundingClientRect().height) return element;
    }
    return null;
  }
  function schedulePosition() { if (frame) cancelAnimationFrame(frame); frame = requestAnimationFrame(position); }
  function position() {
    frame = null;
    const element = document.getElementById('demo-tutorial');
    if (!element || mode !== 'step') return;
    const card = element.querySelector('.tutorial-card'), spotlight = element.querySelector('.tutorial-spotlight');
    const width = innerWidth, height = window.visualViewport?.height || innerHeight, mobile = width <= 680;
    const target = findTarget(), raw = target?.getBoundingClientRect();
    const margin = mobile ? 12 : 18, panel = card.getBoundingClientRect();
    const mobileCardAtTop = mobile && raw && raw.top >= height * .5;
    if (mobile) { card.style.left = '12px'; card.style.top = (mobileCardAtTop ? margin : Math.max(margin, height - panel.height - margin)) + 'px'; }
    else {
      let left = width - panel.width - margin, top = height - panel.height - margin;
      if (raw) {
        if (raw.right + panel.width + 18 + margin <= width) { left = raw.right + 18; top = raw.top; }
        else if (raw.left - panel.width - 18 >= margin) { left = raw.left - panel.width - 18; top = raw.top; }
        else if (raw.bottom + panel.height + 18 + margin <= height) { left = Math.min(raw.left, width-panel.width-margin); top = raw.bottom + 18; }
        else if (raw.top - panel.height - 18 >= margin) { left = Math.min(raw.left, width-panel.width-margin); top = raw.top - panel.height - 18; }
      }
      card.style.left = Math.max(margin, left) + 'px'; card.style.top = Math.max(margin, Math.min(top, height-panel.height-margin)) + 'px';
    }
    if (!raw) { spotlight.style.display = 'none'; element.querySelector('.tutorial-dim').style.background = '#10244b99'; return; }
    spotlight.style.display = ''; element.querySelector('.tutorial-dim').style.background = '';
    const availableTop = mobileCardAtTop ? parseFloat(card.style.top)+panel.height+12 : 5;
    const left = Math.max(5,raw.left-5), top = Math.max(availableTop,raw.top-5);
    const availableBottom = mobile && !mobileCardAtTop ? parseFloat(card.style.top)-12 : height-5;
    spotlight.style.left = left+'px'; spotlight.style.top = top+'px';
    spotlight.style.width = Math.max(0,Math.min(width-5,raw.right+5)-left)+'px';
    spotlight.style.height = Math.max(0,Math.min(availableBottom,raw.bottom+5)-top)+'px';
  }
  function exit() {
    if (!mode) return;
    markSeen();
    if (snapshot && state === tutorialState && state.busy) { clearInterval(runTimer); runTimer = null; }
    const saved = snapshot; mode = null; snapshot = null; tutorialState = null;
    document.getElementById('demo-tutorial')?.remove();
    document.body.style.overflow = oldOverflow;
    if (saved) { state = saved.state; history.replaceState(saved.history,'',saved.url); render(); window.scrollTo(saved.scrollX,saved.scrollY); }
    const app = document.getElementById('app'); if (!oldInert) app.removeAttribute('inert');
    const focus = returnFocus?.isConnected && returnFocus.matches('button,a[href],input,textarea,select,[tabindex]') ? returnFocus : saved?.focusId ? document.getElementById(saved.focusId) : document.querySelector('.agent-header-actions [data-demo-tutorial]') || document.querySelector('[data-demo-tutorial]');
    focus?.focus({preventScroll:true}); returnFocus = null;
  }
  const originalRender = render;
  render = function () { originalRender(); entrypoints(); if (mode) { document.getElementById('app').setAttribute('inert',''); updateCard(); } };
  document.addEventListener('click', event => {
    const launcher = event.target.closest('[data-demo-tutorial]');
    if (launcher) { event.preventDefault(); showWelcome(launcher); return; }
    const action = event.target.closest('[data-tutorial-action]')?.dataset.tutorialAction;
    if (!action) return;
    ({ start, skip:exit, exit, next, previous, run:runExample, approve:()=>decide('approved'), reject:()=>decide('rejected') })[action]?.();
  });
  document.addEventListener('keydown', event => {
    if (!mode) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); event.stopImmediatePropagation(); return; }
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); exit(); return; }
    if (event.key !== 'Tab') return;
    event.stopImmediatePropagation();
    const items = [...document.querySelectorAll('.tutorial-card button:not(:disabled), .tutorial-card a[href]')];
    const first = items[0], last = items.at(-1);
    if (event.shiftKey && (document.activeElement === first || !document.querySelector('.tutorial-card')?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !document.querySelector('.tutorial-card')?.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
  }, true);
  window.addEventListener('resize',schedulePosition);
  window.visualViewport?.addEventListener('resize',schedulePosition);
  document.addEventListener('scroll',schedulePosition,true);
  window.CRM_TUTORIAL = { open:showWelcome, exit, getState:()=>({ open:!!mode, mode, step:mode==='step'?index+1:null, running:!!tutorialState?.busy }) };
  entrypoints();
  const entryURL = new URL(window.location.href);
  const requestedTutorial = entryURL.searchParams.get('tutorial') === '1';
  if (requestedTutorial) {
    entryURL.searchParams.delete('tutorial');
    history.replaceState(history.state, '', entryURL.href);
  }
  let seen = false; try { seen = !!sessionStorage.getItem(SEEN_KEY); } catch { /* Optional session preference. */ }
  const requestedScenario = ['execution','knowledge','collaboration','evaluation'].includes(entryURL.searchParams.get('scenario'));
  if (!requestedScenario && requestedTutorial && state.page === '/app/ai/workbench') queueMicrotask(()=>showWelcome());
})();
