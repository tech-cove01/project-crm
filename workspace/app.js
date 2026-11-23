import { dateWindow, deals, events, routes } from "./data.js";

const storeKey = "pi-crm-showcase-workspace-v1";
const page = document.querySelector("#workspace-content");
const dialog = document.querySelector("#reset-dialog");
const announcement = document.querySelector("#announcement");
const caseById = Object.fromEntries(deals.map((deal) => [deal.id, deal]));
const proposalStates = ["none", "blocked", "pending", "approved", "rejected", "executed", "verified"];
const memoryStates = ["none", "pending", "confirmed", "rejected", "withdrawn"];
const money = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", maximumFractionDigits: 0 });

function freshState() {
  return {
    selected: "ridge",
    cases: Object.fromEntries(deals.map(({ id }) => [id, {
      proposal: "none", memory: "none", closed: false, taskDone: false, reading: null,
    }])),
    logs: [],
  };
}

function readState() {
  const fallback = freshState();
  try {
    const previous = JSON.parse(sessionStorage.getItem(storeKey));
    if (!previous || !previous.cases) return fallback;
    if (Object.hasOwn(caseById, previous.selected)) fallback.selected = previous.selected;
    for (const { id } of deals) {
      const entry = previous.cases[id];
      if (!entry) continue;
      const current = fallback.cases[id];
      if (proposalStates.includes(entry.proposal)) current.proposal = entry.proposal;
      if (memoryStates.includes(entry.memory)) current.memory = entry.memory;
      current.closed = entry.closed === true;
      current.taskDone = entry.taskDone === true;
      if (typeof entry.reading === "boolean") current.reading = entry.reading;
    }
    if (Array.isArray(previous.logs)) {
      fallback.logs = previous.logs.filter((item) =>
        item && Object.hasOwn(caseById, item.id) && Object.hasOwn(events, item.kind),
      ).map(({ id, kind }) => ({ id, kind }));
    }
  } catch {
    return fallback;
  }
  return fallback;
}

let state = readState();
let survey = "open";
let pipelineFilter = "all";

function save() {
  try {
    sessionStorage.setItem(storeKey, JSON.stringify(state));
  } catch {
    // The workspace still works if the browser has disabled storage.
  }
}

function activeRoute() {
  const slug = location.hash.slice(1);
  return Object.hasOwn(routes, slug) ? slug : "overview";
}

function log(deal, kind) {
  state.logs.push({ id: deal.id, kind });
}

function stageFor(deal) {
  return ["executed", "verified"].includes(state.cases[deal.id].proposal) ? "技术评估" : deal.stage;
}

const stageBadge = (stage) => `<span class="pill ${stage === "技术评估" ? "pill-green" : "pill-neutral"}">${stage}</span>`;
const label = (text, variant = "neutral") => `<span class="pill pill-${variant}">${text}</span>`;
const avatar = (deal) => `<span class="case-avatar avatar-${deal.color}" aria-hidden="true">${deal.initials}</span>`;
const button = (action, text, mode = "") => `<button type="button" class="button ${mode}" data-action="${action}">${text}</button>`;

function heading(title, detail, action = "") {
  return `<div class="page-heading"><div><h1>${title}</h1><p>${detail}</p></div>${action}</div>`;
}

function caseSelect(deal, prompt) {
  return `<label class="selector"><span>${prompt}</span><select data-control="selected">
    ${deals.map((item) => `<option value="${item.id}" ${item.id === deal.id ? "selected" : ""}>${item.company} · ${item.title}</option>`).join("")}
  </select></label>`;
}

function selectLink(deal, route, text) {
  return `<a class="table-link" href="#${route}" data-select="${deal.id}">${text}</a>`;
}

function dealRows(items, action = "查看商机") {
  if (!items.length) return '<p class="empty-note">当前筛选没有匹配商机。</p>';
  return `<table class="deal-table"><thead><tr><th scope="col">商机</th><th scope="col">金额</th><th scope="col">当前阶段</th><th scope="col"><span class="sr-only">操作</span></th></tr></thead><tbody>
    ${items.map((deal) => `<tr>
      <th scope="row"><span class="table-identity">${avatar(deal)}<span><strong>${deal.title}</strong><small>${deal.company}</small></span></span></th>
      <td>${money.format(deal.amount)}</td><td>${stageBadge(stageFor(deal))}</td>
      <td>${selectLink(deal, "workbench", action)}</td>
    </tr>`).join("")}</tbody></table>`;
}

function overview() {
  const queues = Object.values(state.cases);
  const openTasks = queues.filter((entry) => !entry.taskDone).length;
  const pending = queues.filter((entry) => entry.proposal === "pending").length;
  const memoryQueue = queues.filter((entry) => entry.memory === "pending").length;
  const stageCount = deals.filter((deal) => stageFor(deal) === "技术评估").length;
  return `${heading("工作区概览", "查看商机、客户会话与当前等待你处理的事项。", '<a class="button button-primary" href="#workbench">进入 Agent 工作台</a>')}
    <div class="metrics">
      <a class="metric" href="#pipeline"><span>开放商机金额</span><strong>${money.format(deals.reduce((sum, deal) => sum + deal.amount, 0))}</strong><small>${deals.length} 笔开放商机</small></a>
      <a class="metric" href="#tasks"><span>未完成任务</span><strong>${openTasks}</strong><small>查看跟进安排</small></a>
      <a class="metric" href="#workbench"><span>待审批提案</span><strong>${pending}</strong><small>人工决定阶段变更</small></a>
      <a class="metric" href="#memory"><span>待审核记忆</span><strong>${memoryQueue}</strong><small>核对客户原话</small></a>
    </div>
    <div class="overview-grid">
      <article class="feature-case">
        <div><span class="feature-kicker">建议先体验</span><h2>储能试点要推进到哪一步？</h2>
        <p>栖岭能源已完成技术访谈。先查原始记录，再走一次阶段提案、人工审批与结果回查。</p>
        <a class="button button-mint" href="#workbench" data-select="ridge">打开储能试点</a></div>
        <div class="journey" aria-label="建议、审批和回查示例">
          <span><i aria-hidden="true"></i>技术访谈已完成</span>
          <span><i aria-hidden="true"></i>审批阶段提案</span>
          <span><i aria-hidden="true"></i>回查实际阶段</span>
        </div>
      </article>
      <article class="panel pipeline-summary">
        <div class="panel-heading"><h2>管道分布</h2><a href="#pipeline">查看管道</a></div>
        <p>当前开放商机按阶段统计</p>
        <div class="distribution" aria-label="初步接洽 ${deals.length - stageCount} 笔，技术评估 ${stageCount} 笔">
          <i style="--portion:${deals.length - stageCount}"></i><i style="--portion:${stageCount}"></i>
        </div>
        <dl class="stage-summary"><div><dt>初步接洽</dt><dd>${deals.length - stageCount} 笔</dd></div><div><dt>技术评估</dt><dd>${stageCount} 笔</dd></div></dl>
      </article>
    </div>
    <section class="panel"><div class="panel-heading"><h2>开放商机</h2><span class="muted">2026 年 11 月 · 演示数据</span></div>
      ${dealRows(deals)}
    </section>`;
}

const proposalLabels = {
  none: ["尚未生成", "neutral"], blocked: ["缺少依据", "gold"], pending: ["待人工审批", "gold"],
  approved: ["已批准 · 待执行", "green"], rejected: ["已拒绝", "red"],
  executed: ["已执行", "green"], verified: ["已回查", "green"],
};

function proposalPanel(deal, current) {
  const [name, variant] = proposalLabels[current.proposal];
  const body = {
    none: "核对所选商机的约见记录后，由工作台生成阶段提案。",
    blocked: "该商机在示例时间窗内没有已完成约见记录。请补足依据后再推进。",
    pending: "请核对依据后决定是否推进。当前商机阶段保持原状。",
    approved: "批准已记录。执行后才会改变商机阶段。",
    rejected: "已记录拒绝决定。当前商机阶段和执行回执均保持原状。",
    executed: "阶段变更已写入本地演示数据。核对回执与当前商机阶段。",
    verified: "回执记录的目标阶段与当前商机阶段一致。",
  };
  let actions = "";
  if (current.proposal === "none") actions = button("propose", "生成阶段提案", "button-primary");
  if (current.proposal === "pending") actions = button("approve", "批准提案", "button-primary") + button("reject", "拒绝提案");
  if (current.proposal === "approved") actions = button("execute", "执行已批准动作", "button-primary");
  if (current.proposal === "executed") actions = button("verify", "回查商机与回执", "button-primary");
  const hasProposal = !["none", "blocked"].includes(current.proposal);
  return `<article class="panel proposal-panel">
      <div class="panel-heading"><h2>阶段提案</h2>${label(name, variant)}</div>
      ${hasProposal ? '<div class="transition"><span>初步接洽</span><b aria-hidden="true">→</b><span>技术评估</span></div>' : ""}
      <p>${body[current.proposal]}</p>
      <div class="business-state"><span>当前商机阶段</span>${stageBadge(stageFor(deal))}</div>
      ${actions ? `<div class="button-row">${actions}</div>` : ""}
    </article>`;
}

function receipt(deal, current) {
  const issued = ["executed", "verified"].includes(current.proposal);
  return `<section class="panel"><div class="panel-heading"><h2>执行回执</h2><span class="muted">${issued ? "1 条回执" : "0 条回执"}</span></div>
    ${issued ? `<dl class="key-values">
      <div><dt>变更编号</dt><dd>DEMO-EXEC-1124</dd></div>
      <div><dt>选中商机</dt><dd>${deal.title}</dd></div>
      <div><dt>实际变更</dt><dd>初步接洽 → 技术评估</dd></div>
      <div><dt>核对状态</dt><dd>${current.proposal === "verified" ? "当前阶段与回执一致" : "待回查"}</dd></div>
    </dl>` : '<p class="empty-note">执行获批动作后，回执将出现在这里。</p>'}
  </section>`;
}

function workbench(deal, current) {
  return `${heading("Agent 工作台", "核对已完成约见的证据，再决定是否推进商机。")}
    ${caseSelect(deal, "选择商机")}
    <div class="two-columns">
      <section class="panel">
        <div class="panel-heading"><h2>当前任务取证</h2>${label(deal.meeting ? "已找到依据" : "无匹配记录", deal.meeting ? "green" : "gold")}</div>
        <div class="case-head">${avatar(deal)}<div><strong>${deal.title}</strong><p>${deal.company} · ${money.format(deal.amount)}</p></div></div>
        <div class="source-note">
          <small>已完成约见 · ${dateWindow}</small>
          <h3>${deal.meeting?.title ?? "没有已完成约见记录"}</h3>
          <p>${deal.meeting?.note ?? "结果只代表这个时间窗里的 CRM 记录。"}</p>
          ${deal.meeting ? `<small>${deal.meeting.id} · ${deal.meeting.date}</small>` : ""}
        </div>
        <a class="table-link" href="#ontology">查看约见口径</a>
      </section>
      ${proposalPanel(deal, current)}
    </div>
    ${receipt(deal, current)}`;
}

function pipeline() {
  const filters = { all: "全部阶段", first: "初步接洽", review: "技术评估" };
  const filtered = deals.filter((deal) => pipelineFilter === "all" || stageFor(deal) === filters[pipelineFilter]);
  return `${heading("销售管道", "选择一笔开放商机，查看依据、阶段与审批状态。")}
    <section class="panel"><div class="panel-heading"><h2>开放商机 · ${filtered.length} 笔</h2>
      <label class="selector compact"><span class="sr-only">筛选阶段</span><select data-control="pipeline">
      ${Object.entries(filters).map(([id, name]) => `<option value="${id}" ${pipelineFilter === id ? "selected" : ""}>${name}</option>`).join("")}
      </select></label>
    </div>${dealRows(filtered)}</section>`;
}

function inbox(deal, current) {
  return `${heading("客户会话", "查看合成历史消息。结束单聊后，可以在客户记忆审核原话。")}
    <div class="inbox-layout">
      <section class="panel inbox-list"><div class="panel-heading"><h2>历史单聊</h2></div>
        ${deals.map((item) => `<button type="button" class="inbox-item ${item.id === deal.id ? "is-selected" : ""}" data-action="select-inbox" data-select="${item.id}" aria-pressed="${item.id === deal.id}">
          ${avatar(item)}<span><strong>${item.contact}</strong><small>${item.company}</small></span>
          ${state.cases[item.id].closed ? label("已结束") : ""}
        </button>`).join("")}
      </section>
      <section class="panel"><div class="panel-heading"><h2>${deal.contact} · ${deal.company}</h2>${label(current.closed ? "会话已结束" : "历史会话", current.closed ? "green" : "neutral")}</div>
        <p class="muted">${deal.role} · ${deal.message.date}</p>
        <div class="chat-message">${avatar(deal)}<blockquote><p>${deal.message.quote}</p><cite>${deal.contact} · ${deal.message.id}</cite></blockquote></div>
        <div class="button-row">${current.closed ? '<a class="button button-primary" href="#memory">去审核客户记忆</a>' : button("close", "结束会话", "button-primary")}</div>
      </section>
    </div>`;
}

function tasks() {
  return `${heading("跟进任务", "跟踪业务待办。任务完成后，相关客户原话可进入记忆审核。")}
    <section class="panel"><div class="panel-heading"><h2>近期跟进</h2></div><div class="task-list">
      ${deals.map((deal) => `<article class="task"><span class="task-icon" aria-hidden="true">${state.cases[deal.id].taskDone ? "✓" : "○"}</span>
        <div><h3>${deal.task.label}</h3><p>${deal.company} · ${deal.task.owner} · ${deal.task.due}</p></div>
        ${state.cases[deal.id].taskDone
          ? label("已完成", "green")
          : `<button type="button" class="button button-small" data-action="task" data-case="${deal.id}" aria-label="完成任务：${deal.task.label}">标记完成</button>`}
      </article>`).join("")}
    </div></section>`;
}

function candidateCard(deal, current) {
  const strings = {
    none: ["尚无候选", "结束单聊、完成关联的跟进任务，或主动从当前原文提取。", "neutral"],
    pending: ["待人工审核", "确认后才会在新会话读到这条记忆。", "gold"],
    confirmed: ["已确认", "这条偏好现在可以在新会话复用。", "green"],
    rejected: ["已驳回", "本候选已从可用记忆中排除。", "neutral"],
    withdrawn: ["已撤回", "下一次召回会跳过这条偏好。", "neutral"],
  };
  const [title, description, variant] = strings[current.memory];
  const output = ["pending", "confirmed"].includes(current.memory)
    ? `<div class="source-note"><small>沟通偏好</small><p class="memory-fact">${deal.message.fact}</p></div>` : "";
  const actions = {
    none: button("extract", "从历史消息提取", "button-primary"),
    pending: button("remember", "确认候选", "button-primary") + button("dismiss", "驳回候选"),
    confirmed: button("withdraw", "撤回记忆"), rejected: "", withdrawn: "",
  };
  return `<section class="panel"><div class="panel-heading"><h2>记忆候选</h2>${label(title, variant)}</div>
      <p>${description}</p>${output}${actions[current.memory] ? `<div class="button-row">${actions[current.memory]}</div>` : ""}
    </section>`;
}

function memory(deal, current) {
  const reading = current.reading === null ? "" : current.reading
    ? `<div class="result-box"><strong>已读回 1 条确认事实</strong><p>${deal.message.fact}</p></div>`
    : '<div class="result-box"><strong>读回 0 条确认事实</strong><p>当前没有可供这个会话使用的已确认偏好。</p></div>';
  return `${heading("客户记忆", "保留可追溯的原话，由人审核哪些偏好能在新会话复用。")}
    ${caseSelect(deal, "选择客户")}
    <div class="two-columns">
      <section class="panel"><div class="panel-heading"><h2>授权历史原文</h2>${label("入站消息")}</div>
        <div class="case-head">${avatar(deal)}<div><strong>${deal.contact}</strong><p>${deal.company} · ${deal.role}</p></div></div>
        <blockquote class="memory-quote"><p>${deal.message.quote}</p><cite>${deal.message.date} · ${deal.message.id}</cite></blockquote>
        <a class="table-link" href="#inbox">查看会话</a>
      </section>
      ${candidateCard(deal, current)}
    </div>
    <section class="panel"><div class="panel-heading"><h2>新会话召回</h2>${button("recall", "新会话读取", "button-small")}</div>
      <p>按当前客户和确认状态读取。</p>${reading}
    </section>`;
}

function ontology() {
  const filters = { open: "开放商机", missing: "近 30 天无已完成约见", undefined: "高潜客户" };
  const matched = survey === "missing" ? deals.filter((deal) => !deal.meeting) : deals;
  return `${heading("业务口径", "按明确的状态和活动规则查询销售记录。")}
    <section class="panel"><div class="panel-heading"><h2>选择查询</h2></div>
      <div class="filters">${Object.entries(filters).map(([id, text]) =>
        `<button class="button ${survey === id ? "button-filter-selected" : ""}" type="button" data-action="survey" data-filter="${id}" aria-pressed="${survey === id}">${text}</button>`).join("")}</div>
      ${survey === "undefined"
        ? '<div class="result-box"><strong>需要补充「高潜」定义</strong><p>请选择团队已审核的判断口径，例如某个阶段或已完成活动。</p></div>'
        : `<p class="subtle-line">${survey === "missing"
          ? `${dateWindow} · 仅统计 CRM 中标为已完成的约见活动。`
          : "开放范围包含初步接洽和技术评估阶段。"} </p>
          ${dealRows(matched)}`}
    </section>`;
}

function runs() {
  const rows = [...state.logs].reverse();
  return `${heading("运行记录", "按倒序查看当前标签页的取证、决定、执行与回查。")}
    <section class="panel"><div class="panel-heading"><h2>操作轨迹</h2><span class="muted">${rows.length} 条记录</span></div>
      ${rows.length ? `<ol class="event-list">${rows.map((entry) => {
        const [type, description] = events[entry.kind];
        return `<li><span class="event-pin" aria-hidden="true"></span><div><strong>${type} · ${caseById[entry.id].title}</strong><p>${description}</p></div></li>`;
      }).join("")}</ol>` : '<p class="empty-note">当前还没有记录。<a class="table-link" href="#workbench">从工作台开始一项任务</a>。</p>'}
    </section>
    <div class="further"><a href="../details.html#validation">项目验证方法和真实结果</a><a href="../demo/index.html?scenario=evaluation&amp;guide=1#/app/ai/workbench">深入体验评测与失败回放</a></div>`;
}

const screens = { overview, workbench, pipeline, inbox, tasks, memory, ontology, runs };

function render() {
  const slug = activeRoute();
  const deal = caseById[state.selected];
  document.querySelector("#workspace-location").textContent = routes[slug];
  for (const item of document.querySelectorAll("[data-route]")) {
    if (item.dataset.route === slug) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  }
  page.innerHTML = screens[slug](deal, state.cases[deal.id]);
}

function makeCandidate(deal, current) {
  if (current.memory !== "none") return;
  current.memory = "pending";
  current.reading = null;
  log(deal, "candidate");
}

function changeProposal(action, deal, current) {
  const rules = {
    approve: ["pending", "approved"],
    reject: ["pending", "rejected"],
    execute: ["approved", "executed"],
    verify: ["executed", "verified"],
  };
  if (action === "propose" && current.proposal === "none") {
    log(deal, deal.meeting ? "analyzed" : "blocked");
    current.proposal = deal.meeting ? "pending" : "blocked";
    if (deal.meeting) log(deal, "proposed");
    return deal.meeting ? "提案已提交，当前阶段未改变。" : "缺少已完成约见依据。";
  }
  const rule = rules[action];
  if (!rule || current.proposal !== rule[0]) return "";
  current.proposal = rule[1];
  log(deal, rule[1]);
  return events[rule[1]][1];
}

function handleAction(action, control) {
  const deal = caseById[control.dataset.case] ?? caseById[state.selected];
  const current = state.cases[deal.id];
  if (action === "survey") {
    survey = control.dataset.filter;
    return "已更新查询结果。";
  }
  if (action === "select-inbox") {
    state.selected = control.dataset.select;
    return "已打开所选单聊。";
  }
  if (action === "close" && !current.closed) {
    current.closed = true;
    log(deal, "closed");
    makeCandidate(deal, current);
    return "会话已结束。";
  }
  if (action === "task" && !current.taskDone) {
    current.taskDone = true;
    log(deal, "taskDone");
    makeCandidate(deal, current);
    return "跟进任务已完成。";
  }
  if (action === "extract") {
    makeCandidate(deal, current);
    return "候选已进入待审核。";
  }
  if (action === "remember" && current.memory === "pending" ||
      action === "dismiss" && current.memory === "pending" ||
      action === "withdraw" && current.memory === "confirmed") {
    const decisions = {
      remember: ["confirmed", "remembered"], dismiss: ["rejected", "dismissed"], withdraw: ["withdrawn", "withdrawn"],
    };
    const [next, kind] = decisions[action];
    current.memory = next;
    current.reading = null;
    log(deal, kind);
    return events[kind][1];
  }
  if (action === "recall") {
    current.reading = current.memory === "confirmed";
    log(deal, "recalled");
    return current.reading ? "读回一条确认事实。" : "读回零条确认事实。";
  }
  return changeProposal(action, deal, current);
}

document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-select]");
  if (link && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.button === 0) {
    state.selected = link.dataset.select;
    save();
    if (link.hash === location.hash) render();
  }
  const control = event.target.closest("button[data-action]");
  if (!control) return;
  if (control.dataset.action === "reset") {
    dialog.returnValue = "";
    dialog.showModal();
    return;
  }
  const message = handleAction(control.dataset.action, control);
  if (!message) return;
  const prevTop = window.scrollY;
  save();
  render();
  window.scrollTo(0, prevTop);
  const replacement = [...page.querySelectorAll("button[data-action]")].find((item) =>
    item.dataset.action === control.dataset.action &&
    item.dataset.select === control.dataset.select &&
    item.dataset.filter === control.dataset.filter &&
    item.dataset.case === control.dataset.case,
  );
  (replacement ?? page).focus({ preventScroll: true });
  announcement.textContent = message;
});

page.addEventListener("change", (event) => {
  const control = event.target.dataset.control;
  if (control === "selected") state.selected = event.target.value;
  else if (control === "pipeline") pipelineFilter = event.target.value;
  else return;
  save();
  render();
  page.querySelector(`select[data-control="${control}"]`).focus({ preventScroll: true });
});

document.querySelector(".skip-link").addEventListener("click", (event) => {
  event.preventDefault();
  page.focus();
});

window.addEventListener("hashchange", () => {
  render();
  window.scrollTo(0, 0);
  page.focus({ preventScroll: true });
});

dialog.addEventListener("close", () => {
  if (dialog.returnValue !== "confirm") return;
  state = freshState();
  survey = "open";
  pipelineFilter = "all";
  save();
  render();
  announcement.textContent = "演示已重置。";
});

render();
