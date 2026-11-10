/* Four isolated browser fixtures; preserve the original CRM exploration state. */
(function () {
  'use strict';
  const panels = window.CRM_SHOWCASE_PANELS || {};
  const order = ['execution', 'knowledge', 'collaboration', 'evaluation'];
  const shortNames = { execution: '受控执行', knowledge: '记忆与知识', collaboration: '专家协作', evaluation: '观测与评测' };
  const h = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const valid = id => order.includes(id) && Boolean(panels[id]);
  const states = {};
  let selected = new URL(location.href).searchParams.get('scenario');
  let exploration = null;
  if (!valid(selected)) selected = null;
  const currentState = () => selected ? (states[selected] ||= panels[selected].create()) : null;
  function urlFor(id) {
    const url = new URL(location.href);
    if (id) url.searchParams.set('scenario', id); else url.searchParams.delete('scenario');
    url.hash = '/app/ai/workbench';
    return url;
  }
  function protectedFlow() {
    if (state.busy || window.CRM_TUTORIAL?.getState().open) {
      toast('请先结束当前任务或退出教程，再切换四场景演示。');
      return true;
    }
    return false;
  }
  function isolateExploration() {
    if (exploration) return;
    const returnURL = new URL(location.href); returnURL.searchParams.delete('scenario');
    exploration = { state, url: returnURL.href, focusId: document.activeElement?.id, scrollX, scrollY };
    state = structuredClone(state);
  }
  function open(id, updateHistory = true) {
    if (!valid(id) || protectedFlow()) return false;
    isolateExploration();
    selected = id; currentState();
    if (updateHistory) history.pushState(history.state, '', urlFor(id));
    navigate('/app/ai/workbench', true);
    document.querySelector('#showcase-title')?.focus({ preventScroll: true });
    return true;
  }
  function close() {
    if (protectedFlow()) return false;
    const saved = exploration;
    selected = null;
    exploration = null;
    if (saved) state = saved.state;
    history.pushState(history.state, '', saved?.url || urlFor(null));
    render();
    if (saved) window.scrollTo(saved.scrollX, saved.scrollY);
    (saved?.focusId ? document.getElementById(saved.focusId) : document.querySelector('[data-showcase-open]'))?.focus({ preventScroll: true });
    return true;
  }
  function reset() {
    if (!selected || protectedFlow()) return false;
    states[selected] = panels[selected].create(); render();
    document.querySelector('[data-showcase-reset]')?.focus({ preventScroll: true });
    return true;
  }
  function shell() {
    const panel = panels[selected];
    return `<section id="showcase-scenario" class="showcase-workspace" data-showcase-scenario="${selected}" aria-labelledby="showcase-title">
      <div class="showcase-topline"><a href="../details.html#${({ execution: 'controlled-execution', knowledge: 'trusted-context', collaboration: 'expert-collaboration', evaluation: 'observation-evaluation' })[selected]}">阅读该场景的业务讲解</a><button type="button" class="showcase-button" data-showcase-close>返回自由探索</button></div>
      <nav class="showcase-tabs" aria-label="四条亮点演示">${order.filter(valid).map((id, i) => `<button type="button" class="showcase-tab${selected === id ? ' active' : ''}" data-showcase-open="${id}" aria-current="${selected === id ? 'page' : 'false'}"><span>${i + 1}</span>${shortNames[id]}</button>`).join('')}</nav>
      <header class="showcase-heading"><div><p class="showcase-eyebrow">商机跟进 · 可操作的固定示例</p><h1 id="showcase-title" tabindex="-1">${h(panel.title)}</h1><p>${h(panel.intro)}</p></div><button type="button" class="showcase-button" data-showcase-reset>重置本场景</button></header>
      <p class="showcase-boundary">浏览器本地模拟 · 不调用 Pi、模型、Mem0、WeKnora 或后端 · 操作仅影响本场景，刷新回到起点</p>
      <div class="showcase-panel">${panel.render(currentState())}</div>
      <footer class="showcase-footer">可以切换对照分支并重复操作；“重置本场景”恢复本场景起点。模拟结果与公开真实记录分别标明。</footer>
    </section>`;
  }
  const previousWorkbench = workbenchView;
  workbenchView = function () { return selected ? shell() : previousWorkbench(); };
  function entrypoints() {
    const welcome = document.querySelector('.agent-welcome');
    if (welcome && !welcome.querySelector('.showcase-entry')) {
      const section = document.createElement('section');
      section.className = 'showcase-entry';
      section.innerHTML = `<h2>从四个场景体验一次商机跟进</h2><p>查看人工决定、可信依据、专家分歧与回答复核；每个场景都有可操作的正常和异常分支。</p><div class="showcase-entry-grid">${order.filter(valid).map((id, i) => `<a href="${h(urlFor(id).pathname.split('/').at(-1) + urlFor(id).search + urlFor(id).hash)}" data-showcase-open="${id}"><span>${i + 1}</span>${shortNames[id]}</a>`).join('')}</div>`;
      welcome.prepend(section);
    }
    const side = document.querySelector('.project-sidebar-links');
    if (side && !side.querySelector('[data-showcase-open]')) side.insertAdjacentHTML('afterbegin', '<button type="button" class="tutorial-entry" data-showcase-open="execution">四场景演示</button>');
  }
  const previousRender = render;
  render = function () { previousRender(); entrypoints(); };
  document.addEventListener('click', event => {
    const opener = event.target.closest('[data-showcase-open]');
    if (opener) { event.preventDefault(); open(opener.dataset.showcaseOpen); return; }
    if (event.target.closest('[data-showcase-reset]')) { reset(); return; }
    if (event.target.closest('[data-showcase-close]')) { close(); return; }
    const action = event.target.closest('#showcase-scenario [data-showcase-action]');
    if (!selected || !action || action.disabled) return;
    const name = action.dataset.showcaseAction;
    const scroller = document.querySelector('#showcase-scenario');
    const top = scroller?.scrollTop || 0;
    panels[selected].act(currentState(), name);
    render();
    const nextScroller = document.querySelector('#showcase-scenario'); if (nextScroller) nextScroller.scrollTop = top;
    const focus = [...document.querySelectorAll('#showcase-scenario [data-showcase-action]')].find(item => item.dataset.showcaseAction === name && !item.disabled);
    (focus || document.querySelector('#showcase-title'))?.focus({ preventScroll: true });
  });
  document.addEventListener('click', event => {
    if (selected && event.target.closest('.topbar [data-action="reset"]')) {
      event.preventDefault(); event.stopImmediatePropagation(); reset();
    }
  }, true);
  function syncURL() {
    const id = new URL(location.href).searchParams.get('scenario');
    if (protectedFlow()) {
      const url = new URL(location.href);
      if (selected) url.searchParams.set('scenario', selected); else url.searchParams.delete('scenario');
      history.replaceState(history.state, '', url);
      return;
    }
    if (valid(id)) isolateExploration();
    else if (exploration) { state = exploration.state; exploration = null; }
    selected = valid(id) ? id : null;
    if (selected) currentState();
    render();
  }
  window.addEventListener('popstate', syncURL);
  window.CRM_SHOWCASE = { open, reset, close, getState: () => ({ scenario: selected, state: currentState() ? structuredClone(currentState()) : null }) };
  if (selected) open(selected, false); else render();
})();
