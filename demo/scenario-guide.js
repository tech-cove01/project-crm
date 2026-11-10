/* Follow real scene controls. No action, approval, or model run is performed by a lesson. */
(function () {
  'use strict';
  const SEEN_KEY = 'project-crm.scenario-guide.seen.v1';
  const order = ['execution', 'knowledge', 'collaboration', 'evaluation'];
  const principles = { execution: 'controlled-execution', knowledge: 'trusted-context', collaboration: 'expert-collaboration', evaluation: 'observation-evaluation' };
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sessions = {};
  let sceneId = null, mode = null, index = 0, result = false, attempted = false, failure = '', pending = null;
  let returnFocus = null, frame = null, bypass = false, sceneURL = '', scrollRequested = false;
  const definition = () => window.CRM_GUIDE_LESSONS?.[sceneId];
  const lesson = () => definition()?.steps[index];
  const context = () => ({ sceneId, state: window.CRM_SHOWCASE?.getState().state, showcase: window.CRM_SHOWCASE?.getState() });
  const value = item => typeof item === 'function' ? item(context()) : item;
  const button = (action, label, primary = false) => `<button type="button" class="scenario-guide-button${primary ? ' primary' : ''}" data-guide-action="${action}">${escape(label)}</button>`;
  function markSeen() { try { sessionStorage.setItem(SEEN_KEY, '1'); } catch { /* Optional preference. */ } }
  function save() {
    if (sceneId && mode && mode !== 'welcome') sessions[sceneId] = { index, result, attempted, failure, complete: mode === 'complete', fingerprint: JSON.stringify(context().state) };
  }
  function find(spec) {
    for (const item of Array.isArray(spec) ? spec : [spec]) {
      const candidate = value(item);
      const element = typeof candidate === 'string' ? document.querySelector(candidate) : candidate;
      if (element instanceof Element && element.getClientRects().length) return element;
    }
    return null;
  }
  function clearMarks() {
    document.querySelectorAll('[data-guide-target],[data-guide-result]').forEach(el => { el.removeAttribute('data-guide-target'); el.removeAttribute('data-guide-result'); });
    document.querySelectorAll('.scenario-guide-muted').forEach(el => el.classList.remove('scenario-guide-muted'));
  }
  function layer() {
    let element = document.getElementById('scenario-guide');
    if (!element) {
      element = document.createElement('div'); element.id = 'scenario-guide'; element.className = 'scenario-guide-layer';
      element.innerHTML = '<div class="scenario-guide-spotlight" aria-hidden="true"></div><section class="scenario-guide-card" data-guide-card role="dialog" aria-labelledby="scenario-guide-title" aria-describedby="scenario-guide-description" tabindex="-1"></section>';
      document.body.append(element);
    }
    return element;
  }
  function focusCard(action) {
    const card = document.querySelector('[data-guide-card]');
    (card?.querySelector(`[data-guide-action="${action}"]`) || card)?.focus({ preventScroll: true });
  }
  function entrypoints() {
    const current = window.CRM_SHOWCASE?.getState().scenario;
    const side = document.querySelector('.project-sidebar-links');
    if (side && !side.querySelector('[data-scenario-guide]')) side.insertAdjacentHTML('beforeend', '<button type="button" class="tutorial-entry" data-scenario-guide>跟我操作</button>');
    const header = document.querySelector('.agent-header-actions');
    if (header && !header.querySelector('[data-scenario-guide]')) header.insertAdjacentHTML('afterbegin', '<button type="button" class="btn tutorial-entry" data-scenario-guide>跟我操作</button>');
    document.querySelectorAll('[data-demo-tutorial]').forEach(el => { el.textContent = current ? '跟我操作' : '旧版完整教程'; });
  }
  function open(id, opener) {
    const recommendOnly = !id && !window.CRM_SHOWCASE?.getState().scenario;
    id ||= window.CRM_SHOWCASE?.getState().scenario || 'execution';
    if (!window.CRM_GUIDE_LESSONS?.[id]) return false;
    if (state.busy || window.CRM_TUTORIAL?.getState().open) { toast('请先结束当前任务或退出旧版教程，再开始跟随操作。'); return false; }
    if (mode && sceneId !== id) return requestChange('open', id);
    if (!recommendOnly && window.CRM_SHOWCASE?.getState().scenario !== id) {
      if (!window.CRM_SHOWCASE.open(id)) return false;
    }
    save(); sceneId = id; mode = 'welcome'; pending = null; result = false; attempted = false; failure = '';
    sceneURL = location.href; returnFocus = opener || document.activeElement; markSeen();
    update(); focusCard(window.CRM_SHOWCASE.isPristine() && !sessions[id] ? 'start' : 'continue-existing');
    return true;
  }
  function resumeIndex() {
    let saved = sessions[sceneId];
    if (saved && saved.fingerprint !== JSON.stringify(context().state)) { delete sessions[sceneId]; saved = null; }
    if (saved) { index = saved.index; result = saved.result; attempted = saved.attempted; failure = saved.failure; return; }
    const resume = definition().resumeAt;
    if (resume) { index = Math.max(0, Math.min(definition().steps.length, Number(resume(context())) || 0)); return; }
    const available = definition().steps.findIndex(step => step.action !== 'observe' && find(step.target)?.matches('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]'));
    index = Math.max(0, available);
  }
  function start(continueExisting = false) {
    if (state.busy) return;
    if (window.CRM_SHOWCASE.getState().scenario !== sceneId) {
      bypass = true; const opened = window.CRM_SHOWCASE.open(sceneId); bypass = false;
      if (!opened) return;
      sceneURL = location.href;
    }
    result = false; attempted = false; failure = ''; index = 0;
    if (continueExisting) resumeIndex();
    mode = index >= definition().steps.length ? 'complete' : 'step';
    save(); showStep();
  }
  function restart() {
    // This explicit control states that it clears the scene; merely opening a guide never does.
    bypass = true;
    if (window.CRM_SHOWCASE.getState().scenario !== sceneId && !window.CRM_SHOWCASE.open(sceneId)) { bypass = false; return; }
    const reset = window.CRM_SHOWCASE.reset();
    bypass = false;
    if (!reset) return;
    sceneURL = location.href;
    delete sessions[sceneId]; index = 0; result = false; attempted = false; failure = ''; mode = 'step';
    save(); showStep();
  }
  function showStep() {
    scrollRequested = true; update();
    if (mode === 'step' && !result && lesson()?.action !== 'observe') find(lesson().target)?.focus({ preventScroll: true });
    else focusCard('continue');
    schedulePosition();
  }
  function next() {
    if (mode !== 'step' || (!result && lesson()?.action !== 'observe')) return;
    index++; result = false; attempted = false; failure = '';
    if (index >= definition().steps.length) mode = 'complete';
    save(); showStep();
  }
  function update() {
    if (!mode) return;
    const element = layer(), card = element.querySelector('[data-guide-card]');
    const focusAction = card.contains(document.activeElement) ? document.activeElement.dataset.guideAction : null;
    const oldScroll = card.scrollTop;
    const data = definition(), step = lesson();
    let body = '', phase = mode;
    const top = `<div class="scenario-guide-topline"><span>${escape(data?.title || '跟我操作')}</span><button type="button" class="scenario-guide-close" data-guide-action="close" aria-label="关闭引导，保留当前进度">关闭 ×</button></div>`;
    if (mode === 'welcome') {
      const existing = !window.CRM_SHOWCASE.isPristine() || Boolean(sessions[sceneId]);
      body = `<h2 id="scenario-guide-title">${existing ? '继续这次操作，还是从头走？' : '跟着提示，亲手完成这个场景'}</h2><p id="scenario-guide-description">${escape(data.intro || '每次只做一个操作。点亮的按钮就是下一步，完成后一起看看结果。')}</p><p class="scenario-guide-note">${existing ? '本场景已有操作或引导进度。继续会保留它；从头开始会清空本场景。' : `${data.steps.length} 个操作 · 可随时关闭或自由体验。刷新会回到本场景起点。`}</p><div class="scenario-guide-controls">${existing ? button('continue-existing', '继续已有状态', true) + button('restart', '清空本场景并从头开始') : button('start', '开始跟随操作', true)}${button('skip', '跳过，自己体验')}</div>`;
    } else if (mode === 'confirm') {
      body = `<h2 id="scenario-guide-title">先保留当前引导进度</h2><p id="scenario-guide-description">${pending?.kind === 'reset' ? '重置会清空本场景的业务状态。当前引导暂停后，你可以从头开始。' : '离开后会暂停这条引导，当前业务状态和引导进度仍保留。回到本场景可选择继续。'}</p><div class="scenario-guide-controls">${button('keep', '留下继续当前步', true)}${button('leave', pending?.kind === 'reset' ? '确认清空并重新开始' : '暂停引导并离开')}</div>`;
    } else if (mode === 'complete') {
      const nextScene = order[order.indexOf(sceneId) + 1];
      body = `<p class="scenario-guide-step" data-guide-step>已完成 · ${data.steps.length} / ${data.steps.length}</p><h2 id="scenario-guide-title" data-guide-completed>这条场景已经走通</h2><p id="scenario-guide-description">${escape(data.takeaway || data.summary || '先核对依据，再作决定，并通过可见结果确认发生了什么。')}</p><div class="scenario-guide-controls">${nextScene && window.CRM_GUIDE_LESSONS?.[nextScene] ? button('next-scene', '体验下一条', true) : ''}${button('principle', '查看原理')}${button('restart', '清空本场景并重新走')}${button('free', '结束引导，自由体验')}</div>`;
    } else if (step) {
      phase = result ? 'result' : 'action';
      body = `<p class="scenario-guide-step" data-guide-step>第 ${index + 1} 步 / 共 ${data.steps.length} 步</p><h2 id="scenario-guide-title">${escape(result ? (step.resultTitle || '看看刚才的结果') : step.title)}</h2><p id="scenario-guide-description"${result ? ' data-guide-result-text role="status"' : ''}>${escape(value(result ? step.resultText : step.text) || '')}</p>${failure ? `<p class="scenario-guide-failure" role="status">${escape(failure)}</p>` : ''}<div class="scenario-guide-controls">${result || step.action === 'observe' ? button('continue', index === data.steps.length - 1 ? '完成，看看收获' : '看懂了，继续', true) : '<span class="scenario-guide-action-hint">请亲自点击高亮的页面按钮</span>'}${button('locate', result ? '定位这个结果' : '定位当前按钮')}${button('skip', '暂停引导，自由体验')}</div>`;
    }
    element.dataset.guidePhase = phase; element.dataset.guideScene = sceneId;
    element.dataset.guideKind = mode === 'step' ? step?.action === 'observe' ? 'observe' : 'operation' : '';
    card.innerHTML = top + body; card.scrollTop = oldScroll;
    if (focusAction) focusCard(focusAction);
    clearMarks();
    if (mode === 'step' && step) {
      const target = find(result ? step.resultTarget || step.target : step.target);
      document.querySelectorAll('#showcase-scenario .showcase-details[open]').forEach(details => { if (!target || !details.contains(target)) details.open = false; });
      target?.setAttribute(result ? 'data-guide-result' : 'data-guide-target', '');
      document.querySelectorAll('#showcase-scenario [data-showcase-action]').forEach(el => { if (el !== target) el.classList.add('scenario-guide-muted'); });
    }
    document.body.classList.add('scenario-guide-active'); schedulePosition();
  }
  function evaluate(detail) {
    if (mode !== 'step' || result || !attempted || detail.scenario !== sceneId) return;
    const step = lesson();
    if (!step || detail.action !== attempted) return;
    if (step.action !== 'click' && step.action !== detail.action) return;
    let passed = false;
    try { passed = step.predicate ? Boolean(step.predicate(context())) : true; } catch { passed = false; }
    if (passed) { result = true; failure = ''; save(); scrollRequested = true; update(); focusCard('continue'); }
    else {
      failure = value(step.failureText) || '这次操作还没有得到预期结果。请查看页面状态，并再次点击高亮按钮；也可以暂停引导后自由检查。';
      save(); update(); focusCard('locate');
    }
  }
  function requestChange(kind, id, callback) {
    if (!mode || bypass) return true;
    if ((kind === 'open' || kind === 'history') && id === sceneId && state.page === '/app/ai/workbench') return true;
    if (kind === 'reset' && mode === 'step' && !result && lesson()?.action === 'reset' && attempted === 'reset') return true;
    if (mode === 'confirm') return false;
    save(); pending = { kind, id, callback, previousMode: mode }; mode = 'confirm'; update(); focusCard('keep');
    return false;
  }
  function keep() {
    if (!pending) return;
    mode = pending.previousMode; pending = null; update(); focusCard(result ? 'continue' : null);
  }
  function leave() {
    const change = pending;
    if (!change) return;
    mode = change.previousMode; pending = null;
    if (change.kind === 'reset') { restart(); return; }
    exit(); bypass = true;
    try {
      if (change.callback) change.callback();
      else if (change.kind === 'open' || change.kind === 'history') {
        if (order.includes(change.id)) { window.CRM_SHOWCASE.open(change.id); open(change.id); }
        else window.CRM_SHOWCASE.close();
      } else if (change.kind === 'close') window.CRM_SHOWCASE.close();
    } finally { bypass = false; }
  }
  function exit() {
    if (!mode) return;
    if (mode === 'confirm' && pending) mode = pending.previousMode;
    save(); markSeen(); mode = null; pending = null; attempted = false;
    clearMarks(); document.body.classList.remove('scenario-guide-active'); document.getElementById('scenario-guide')?.remove();
    (returnFocus?.isConnected ? returnFocus : document.querySelector('#showcase-scenario [data-scenario-guide]') || document.querySelector('[data-scenario-guide]'))?.focus({ preventScroll: true });
  }
  function schedulePosition() { if (!frame) frame = requestAnimationFrame(position); }
  function viewport() {
    const vv = window.visualViewport;
    return { left: vv?.offsetLeft || 0, top: vv?.offsetTop || 0, width: vv?.width || innerWidth, height: vv?.height || innerHeight };
  }
  function position() {
    frame = null;
    const element = document.getElementById('scenario-guide');
    if (!mode || !element) return;
    const card = element.querySelector('[data-guide-card]'), spot = element.querySelector('.scenario-guide-spotlight');
    const vp = viewport(), gap = 14, mobile = vp.width <= 680;
    card.style.width = Math.min(370, vp.width - 24) + 'px';
    card.style.maxHeight = Math.max(130, Math.min(mode === 'step' ? 340 : 480, vp.height * (mode === 'step' ? .48 : .84))) + 'px';
    let target = mode === 'step' ? find(result ? lesson()?.resultTarget || lesson()?.target : lesson()?.target) : null;
    const shouldRelocate = scrollRequested;
    if (shouldRelocate && target) { scrollRequested = false; target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); }
    let raw = target?.getBoundingClientRect(), bounds = card.getBoundingClientRect();
    const scrollBounds = target?.closest('#showcase-scenario')?.getBoundingClientRect();
    const visibleTop = Math.max(vp.top + 8, (scrollBounds?.top || vp.top) + 4);
    const visibleBottom = Math.min(vp.top + vp.height - 8, scrollBounds?.bottom || vp.top + vp.height);
    if (raw && (raw.bottom <= visibleTop || raw.top >= visibleBottom)) raw = null;
    let left = vp.left + (vp.width - bounds.width) / 2, top = vp.top + (vp.height - bounds.height) / 2;
    if (!raw && mode === 'step') { left = vp.left + vp.width - bounds.width - 12; top = vp.top + vp.height - bounds.height - 12; }
    if (raw) {
      const minX = vp.left + 12, maxX = vp.left + vp.width - bounds.width - 12;
      const minY = vp.top + 12, maxY = vp.top + vp.height - bounds.height - 12;
      if (!mobile && raw.right + gap + bounds.width <= vp.left + vp.width - 12) { left = raw.right + gap; top = Math.max(minY, Math.min(raw.top, maxY)); }
      else if (!mobile && raw.left - gap - bounds.width >= minX) { left = raw.left - gap - bounds.width; top = Math.max(minY, Math.min(raw.top, maxY)); }
      else {
        left = Math.max(minX, Math.min(raw.left, maxX));
        const below = vp.top + vp.height - raw.bottom - gap, above = raw.top - vp.top - gap;
        if (below >= bounds.height) top = raw.bottom + gap;
        else if (above >= bounds.height) top = raw.top - bounds.height - gap;
        else {
          const cardAtBottom = raw.top < vp.top + vp.height / 2;
          top = cardAtBottom ? maxY : minY;
          const scroller = target.closest('#showcase-scenario');
          if (scroller && shouldRelocate) {
            const roomTop = cardAtBottom ? Math.max(vp.top + 12, scroller.getBoundingClientRect().top + 10) : top + bounds.height + gap;
            const roomBottom = cardAtBottom ? top - gap : vp.top + vp.height - 12;
            const targetTop = roomTop + Math.max(0, (roomBottom - roomTop - Math.min(raw.height, 70)) / 2);
            scroller.scrollTop += raw.top - targetTop;
            raw = target.getBoundingClientRect();
          }
        }
      }
    }
    card.style.left = Math.max(vp.left + 12, Math.min(left, vp.left + vp.width - bounds.width - 12)) + 'px';
    card.style.top = Math.max(vp.top + 12, Math.min(top, vp.top + vp.height - bounds.height - 12)) + 'px';
    if (!raw) { spot.hidden = true; return; }
    spot.hidden = false;
    const clippedLeft = Math.max(vp.left + 4, raw.left - 5), clippedTop = Math.max(visibleTop, raw.top - 5);
    spot.style.left = clippedLeft + 'px'; spot.style.top = clippedTop + 'px';
    spot.style.width = Math.max(0, Math.min(vp.left + vp.width - 4, raw.right + 5) - clippedLeft) + 'px';
    spot.style.height = Math.max(0, Math.min(visibleBottom, raw.bottom + 5) - clippedTop) + 'px';
  }
  const previousRender = render;
  render = function () {
    const focusedTarget = document.activeElement?.hasAttribute('data-guide-target');
    previousRender(); entrypoints();
    if (mode) {
      update();
      if (focusedTarget) find(result ? lesson()?.resultTarget || lesson()?.target : lesson()?.target)?.focus?.({ preventScroll: true });
    }
  };
  const previousNavigate = navigate;
  navigate = function (path, replace) {
    if (mode && path !== '/app/ai/workbench' && !bypass) {
      const destination = location.href;
      if (sceneURL) history.replaceState(history.state, '', sceneURL);
      return requestChange('route', null, () => { if (destination !== sceneURL) history.pushState(history.state, '', destination); previousNavigate(path, replace); });
    }
    return previousNavigate(path, replace);
  };
  document.addEventListener('click', event => {
    const launcher = event.target.closest('[data-scenario-guide]');
    if (launcher) { event.preventDefault(); event.stopImmediatePropagation(); open(null, launcher); return; }
    const control = event.target.closest('[data-guide-action]');
    if (control) {
      event.preventDefault(); event.stopImmediatePropagation();
      const actions = { start: () => start(), 'continue-existing': () => start(true), restart, continue: next, locate: () => { scrollRequested = true; schedulePosition(); }, skip: exit, close: exit, free: exit, keep, leave,
        'next-scene': () => { const id = order[order.indexOf(sceneId) + 1]; exit(); window.CRM_SHOWCASE.open(id); open(id); },
        principle: () => { const anchor = principles[sceneId]; exit(); location.href = '../details.html#' + anchor; } };
      actions[control.dataset.guideAction]?.(); return;
    }
    if (!mode) return;
    const actual = event.target.closest('[data-showcase-action],[data-showcase-reset]');
    if (actual && mode === 'step' && !result && actual === find(lesson()?.target)) {
      attempted = actual.hasAttribute('data-showcase-reset') ? 'reset' : actual.dataset.showcaseAction; failure = ''; return;
    }
    if (actual?.hasAttribute('data-showcase-action')) {
      event.preventDefault(); event.stopImmediatePropagation();
      failure = mode === 'step' && result ? '先看清这一步的结果，再点击“看懂了，继续”。' : '请先完成当前高亮的操作，或暂停引导后自由体验。'; update(); focusCard('locate'); return;
    }
    const explorationAction = event.target.closest('#app [data-action="run"],#app [data-action="approve"],#app [data-action="reject"]');
    if (explorationAction) {
      event.preventDefault(); event.stopImmediatePropagation();
      toast('请先关闭或跳过跟随操作，再运行自由探索任务。'); return;
    }
    const explorationReset = event.target.closest('.topbar [data-action="reset"]');
    if (explorationReset && !window.CRM_SHOWCASE.getState().scenario) {
      event.preventDefault(); event.stopImmediatePropagation();
      requestChange('route', null, () => explorationReset.click()); return;
    }
    const link = event.target.closest('a[href]');
    if (link && !link.hasAttribute('data-showcase-open') && !link.closest('#scenario-guide')) {
      event.preventDefault(); event.stopImmediatePropagation(); requestChange('route', null, () => { location.href = link.href; });
    }
  }, true);
  document.addEventListener('keydown', event => {
    if (!mode) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); event.stopImmediatePropagation(); return; }
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); exit(); return; }
    if (event.key !== 'Tab') return;
    const target = mode === 'step' && !result ? find(lesson()?.target) : null;
    const items = [target, ...document.querySelectorAll('#scenario-guide button:not(:disabled),#scenario-guide a[href]')].filter(Boolean);
    const active = items.indexOf(document.activeElement);
    event.preventDefault(); event.stopImmediatePropagation();
    items[(active + (event.shiftKey ? -1 : 1) + items.length) % items.length]?.focus({ preventScroll: true });
  }, true);
  window.addEventListener('crm:showcase-change', event => {
    if (!mode && (event.detail.type === 'action' || event.detail.type === 'reset')) delete sessions[event.detail.scenario];
    if (event.detail.type === 'action' || event.detail.type === 'reset') evaluate(event.detail);
    if (!mode && event.detail.type === 'open') queueMicrotask(() => { if (!mode) open(event.detail.scenario); });
    entrypoints();
  });
  const relocate = () => { scrollRequested = true; schedulePosition(); };
  window.addEventListener('resize', relocate);
  window.visualViewport?.addEventListener('resize', relocate);
  window.visualViewport?.addEventListener('scroll', schedulePosition);
  document.addEventListener('scroll', schedulePosition, true);
  window.CRM_SCENARIO_GUIDE = { open, exit, beforeChange: requestChange, getState: () => ({ open: Boolean(mode), sceneId, mode, step: mode === 'step' ? index + 1 : null, total: definition()?.steps.length || 0, phase: mode === 'step' ? result ? 'result' : 'action' : mode, pendingAction: pending?.kind || null }) };
  entrypoints();
  const entryURL = new URL(location.href), explicitLegacy = entryURL.searchParams.get('tutorial') === '1' && !window.CRM_SHOWCASE.getState().scenario;
  const requestedGuide = entryURL.searchParams.get('guide') === '1';
  let seen = false; try { seen = Boolean(sessionStorage.getItem(SEEN_KEY)); } catch { /* Optional preference. */ }
  if (requestedGuide) { entryURL.searchParams.delete('guide'); history.replaceState(history.state, '', entryURL); }
  if (!explicitLegacy && state.page === '/app/ai/workbench' && (requestedGuide || window.CRM_SHOWCASE.getState().scenario || !seen)) queueMicrotask(() => open());
})();
