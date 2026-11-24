import { deals, events, pipelineStages, routes } from "./data.js";
import { agentScreens, handleAgent, handleAgentInput, handleAgentSubmit, readAgentState } from "./agent.js";
import { createCrmOpportunity, crmScreens, handleCrm, handleCrmChange, handleCrmInput, readCrmState } from "./crm.js";
import { deskScreens, handleDesk, handleDeskChange, handleDeskSubmit, readDeskState } from "./desk.js";
import { handleLab, handleLabChange, labScreens, resetLabControls } from "./lab.js";
import { handleWorkflow, handleWorkflowChange, workflowScreens, readWorkflowState } from "./workflow.js";
import { handleReview, handleReviewChange, reviewScreen, resetReview } from "./review.js";

const storeKey = "pi-crm-showcase-workspace-v1";
const page = document.querySelector("#workspace-content");
const dialog = document.querySelector("#reset-dialog");
const searchDialog = document.querySelector("#search-dialog");
const searchInput = document.querySelector("#workspace-search");
const searchResults = document.querySelector("#search-results");
const railToggle = document.querySelector(".rail-toggle");
const announcement = document.querySelector("#announcement");
const caseById = Object.fromEntries(deals.map((deal) => [deal.id, deal]));
const proposalStates = ["none", "blocked", "pending", "approved", "rejected", "executed", "verified"];
const memoryStates = ["none", "pending", "confirmed", "rejected", "withdrawn"];
const stageNames = new Set(pipelineStages.map(({ name }) => name));
const money = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", minimumFractionDigits: 0, maximumFractionDigits: 2 });

function freshState() {
  return {
    selected: "ridge",
    cases: Object.fromEntries(deals.map(({ id }) => [id, {
      proposal: "none", memory: "none", closed: false, taskDone: false, reading: null,
    }])),
    logs: [],
    agent: readAgentState(),
    crm: readCrmState(),
    desk: readDeskState(),
    workflow: readWorkflowState(),
  };
}

function readState() {
  const fallback = freshState();
  try {
    const previous = JSON.parse(sessionStorage.getItem(storeKey));
    if (!previous || !previous.cases) return fallback;
    if (Object.hasOwn(caseById, previous.selected)) fallback.selected = previous.selected;
    fallback.agent = readAgentState(previous.agent);
    fallback.crm = readCrmState(previous.crm);
    fallback.desk = readDeskState(previous.desk);
    fallback.workflow = readWorkflowState(previous.workflow, previous.lab);
    for (const { id } of deals) {
      const entry = previous.cases[id];
      if (!entry) continue;
      const current = fallback.cases[id];
      if (proposalStates.includes(entry.proposal)) current.proposal = entry.proposal;
      if (memoryStates.includes(entry.memory)) current.memory = entry.memory;
      current.closed = entry.closed === true;
      current.taskDone = entry.taskDone === true;
      if (typeof entry.reading === "boolean") current.reading = entry.reading;
      if (stageNames.has(entry.manualStage)) current.manualStage = entry.manualStage;
      if (stageNames.has(entry.manualChange?.from) && stageNames.has(entry.manualChange?.to))
        current.manualChange = { from: entry.manualChange.from, to: entry.manualChange.to };
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
let stageFeedback = "";
let draggedCase = null;
function save() {
  try {
    sessionStorage.setItem(storeKey, JSON.stringify(state));
  } catch {
    // The workspace still works if the browser has disabled storage.
  }
}

function selectCase(id, route) {
  if (!Object.hasOwn(caseById, id)) return false;
  state.selected = id;
  // Cross-page links must make the selected customer visible in the target list.
  if (route === "#inbox") {
    state.crm.inboxFilter = "all";
    state.crm.inboxQuery = "";
  }
  if (route === "#contacts") state.crm.directoryQuery = "";
  if (route === "#pipeline") state.crm.pipelineStage = "all";
  if (route === "#tasks") state.crm.taskFilter = "all";
  return true;
}

const entryUrl = new URL(location.href);
if (selectCase(entryUrl.searchParams.get("case"), entryUrl.hash)) {
  entryUrl.searchParams.delete("case");
  history.replaceState(history.state, "", entryUrl);
  save();
}

function activeRoute() {
  const slug = location.hash.slice(1);
  return Object.hasOwn(routes, slug) ? slug : "overview";
}

function log(deal, kind) {
  state.logs.push({ id: deal.id, kind });
}

function stageFor(deal) {
  const current = state.cases[deal.id];
  if (!current) return deal.stage;
  return current.manualStage ?? (["executed", "verified"].includes(current.proposal) ? "技术评估" : deal.stage);
}

function moveStage(id, target) {
  const deal = Object.hasOwn(caseById, id) ? caseById[id] : state.crm.opportunities.find((item) => item.id === id);
  if (!deal || !stageNames.has(target)) return "请选择有效商机和阶段。";
  const current = state.cases[id];
  if (["pending", "approved", "executed"].includes(current?.proposal))
    return "这笔商机有未结案的提案，请在工作台处理后再调整阶段。";
  const from = stageFor(deal);
  if (from === target) return "这笔商机已在该阶段。";
  if (current) {
    current.manualStage = target;
    current.manualChange = { from, to: target };
    log(deal, "manualStage");
  } else {
    deal.stage = target;
  }
  state.crm.pipelineStage = "all";
  return `${deal.title} · ${from} → ${target}`;
}

const stageBadge = (stage) => `<span class="pill ${stage === "技术评估" ? "pill-green" : "pill-neutral"}">${stage}</span>`;
const label = (text, variant = "neutral") => `<span class="pill pill-${variant}">${text}</span>`;
const avatar = (deal) => `<span class="case-avatar avatar-${deal.color}" aria-hidden="true">${deal.initials}</span>`;
const button = (action, text, mode = "") => `<button type="button" class="button ${mode}" data-action="${action}">${text}</button>`;

function heading(title, detail, action = "") {
  return `<div class="page-heading"><div><h1>${title}</h1>${detail ? `<p>${detail}</p>` : ""}</div>${action}</div>`;
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
  const distribution = pipelineStages.map(({ name }) => ({ name, count: deals.filter((deal) => stageFor(deal) === name).length }));
  const ridge = state.cases.ridge;
  const journeyStep = { none: 0, pending: 1, approved: 1, executed: 2, verified: 3, blocked: 0, rejected: 1 }[ridge.proposal];
  const path = [
    { title: "核对约见与客户原话", route: "workbench" },
    { title: "由负责人决定提案", route: "workbench" },
    { title: "核对回执和实际阶段", route: "runs" },
  ];
  return `${heading("工作区概览", "查看商机、客户会话与当前等待你处理的事项。", '<a class="button button-primary" href="#workbench">进入 Agent 工作台</a>')}
    <div class="metrics">
      <a class="metric" href="#pipeline"><span>开放商机金额</span><strong>${money.format(deals.reduce((sum, deal) => sum + deal.amount, 0))}</strong><small>${deals.length} 笔开放商机</small></a>
      <a class="metric" href="#tasks"><span>未完成任务</span><strong>${openTasks}</strong><small>查看跟进安排</small></a>
      <a class="metric" href="#workbench"><span>待审批提案</span><strong>${pending}</strong><small>人工决定阶段变更</small></a>
      <a class="metric" href="#memory"><span>待审核记忆</span><strong>${memoryQueue}</strong><small>核对客户原话</small></a>
    </div>
    <div class="overview-grid">
      <article class="feature-case">
        <div><span class="feature-kicker">栖岭能源 · 储能站点试点</span><h2>访谈之后，商机怎么推进？</h2>
        <p>从技术访谈取证到执行回查，跟着一笔商机看完整链路。</p>
        <div class="overview-actions"><a class="button button-mint" href="#workbench" data-select="ridge">打开储能试点</a>
        <a href="../about/#run-states">查看 Run 状态图</a></div></div>
        <ol class="journey" aria-label="当前商机处理进度">
          ${path.map(({ title, route }, index) => `<li class="${index < journeyStep ? "journey-done" : ""}">
            <a href="#${route}" data-select="ridge"><i aria-hidden="true"></i><span>${title}</span>${index < journeyStep ? '<span class="sr-only">（已通过此步骤）</span>' : ""}</a></li>`).join("")}
        </ol>
      </article>
      <article class="panel pipeline-summary">
        <div class="panel-heading"><h2>管道分布</h2><a href="#pipeline">查看管道</a></div>
        <p>当前开放商机按阶段统计</p>
        <div class="distribution" aria-label="${distribution.map(({ name, count }) => `${name} ${count} 笔`).join("，")}">
          ${distribution.map(({ count }, index) => `<i class="stage-tone-${index}" style="--portion:${count}"${count === 0 ? " hidden" : ""}></i>`).join("")}
        </div>
        <dl class="stage-summary">${distribution.map(({ name, count }, index) => `<div class="stage-tone-${index}"><dt>${name}</dt><dd>${count} 笔</dd></div>`).join("")}</dl>
      </article>
    </div>
    <section class="panel"><div class="panel-heading"><h2>开放商机</h2><span class="muted">2026 年 11 月 · 演示数据</span></div>
      ${dealRows(deals)}
    </section>
    <section class="panel overview-queue"><div class="panel-heading"><h2>最近的跟进任务</h2><a href="#tasks">查看任务列表</a></div>
      ${deals.map((deal) => `<article>${avatar(deal)}<div><a href="#inbox" data-select="${deal.id}">${deal.task.label}</a><small>${deal.company} · ${deal.task.owner} · ${deal.task.due}</small></div>
        ${state.cases[deal.id].taskDone ? label("已完成", "green") : label("未完成")}</article>`).join("")}
    </section>`;
}

const screens = { overview, ...crmScreens, ...agentScreens, ...labScreens, ...deskScreens, ...workflowScreens, evaluation: reviewScreen };

function getModel() {
  const deal = caseById[state.selected];
  return {
    state, deal, current: state.cases[deal.id], deals, stageFor, stageBadge, money,
    heading, label, avatar, button, log, makeCandidate, changeProposal, caseSelect, dealRows,
  };
}

function render() {
  const slug = activeRoute();
  const scrollOffsets = Object.fromEntries([...page.querySelectorAll("[data-workbench-scroll]")].map((panel) => [
    panel.dataset.workbenchScroll, panel.scrollTop,
  ]));
  document.querySelector("#workspace-location").textContent = routes[slug];
  for (const item of document.querySelectorAll("[data-route]")) {
    if (item.dataset.route === slug) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  }
  document.title = `${routes[slug]} · Pi Native CRM`;
  document.documentElement.dataset.deskTheme = state.desk.theme;
  page.innerHTML = screens[slug](getModel());
  for (const panel of page.querySelectorAll("[data-workbench-scroll]")) {
    panel.scrollTop = scrollOffsets[panel.dataset.workbenchScroll] ?? 0;
  }
  const boardStatus = page.querySelector("[data-board-status]");
  if (boardStatus) boardStatus.textContent = stageFeedback;
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
  if (action === "execute") {
    if (state.agent.executionPaused) return "当前暂停执行。";
    if (stageFor(deal) !== "初步接洽") return "当前商机阶段与提案不一致，请重新核对。";
    delete current.manualStage;
  }
  current.proposal = rule[1];
  log(deal, rule[1]);
  return events[rule[1]][1];
}

function handleAction(action, control) {
  const deal = caseById[control.dataset.case] ?? caseById[state.selected];
  const current = state.cases[deal.id];
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
  const model = getModel();
  return handleAgent(action, control, model) ?? handleCrm(action, control, model) ??
    handleLab(action, control, model) ?? handleDesk(action, control, model) ??
    handleWorkflow(action, control, model) ?? handleReview(action, control, model);
}

document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-select]");
  if (link && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.button === 0) {
    if (searchDialog.open) searchDialog.close();
    if (!selectCase(link.dataset.select, link.hash)) return;
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
  if (control.dataset.action === "search") {
    openSearch();
    return;
  }
  const message = handleAction(control.dataset.action, control);
  if (!message) return;
  const prevTop = window.scrollY;
  save();
  render();
  window.scrollTo(0, prevTop);
  const keys = Object.keys(control.dataset);
  const replacement = [...page.querySelectorAll("button[data-action]")].find((item) =>
    keys.every((key) => item.dataset[key] === control.dataset[key]),
  );
  (replacement ?? page).focus({ preventScroll: true });
  announcement.textContent = message;
});

page.addEventListener("change", (event) => {
  const control = event.target.dataset.control;
  if (control === "selected") {
    if (!Object.hasOwn(caseById, event.target.value)) return;
    state.selected = event.target.value;
  } else {
    const model = getModel();
    const crmResult = handleCrmChange(event, model);
    if (crmResult === true) {
      save();
      return;
    }
    const result = crmResult || handleDeskChange(event, model) || handleWorkflowChange(event, model) ||
      handleLabChange(event, model) || handleReviewChange(event, model);
    if (typeof result === "string") announcement.textContent = result;
    else if (!result) return;
  }
  save();
  render();
  const name = Object.keys(event.target.dataset).find((key) => key === "control" || key.endsWith("Control"));
  if (name) {
    const attribute = `data-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
    page.querySelector(`[${attribute}="${CSS.escape(event.target.dataset[name])}"]`)?.focus({ preventScroll: true });
  }
});

page.addEventListener("input", (event) => {
  const model = getModel();
  if (handleCrmInput(event, model) || handleAgentInput(event, model)) save();
});

function finishForm(message, focusSelector) {
  if (!message) return;
  const top = window.scrollY;
  save();
  render();
  window.scrollTo(0, top);
  (page.querySelector(focusSelector) ?? page).focus({ preventScroll: true });
  announcement.textContent = message;
}

page.addEventListener("submit", (event) => {
  if (event.target.matches("[data-board-create]")) {
    event.preventDefault();
    const opportunity = createCrmOpportunity(event.target, state.crm);
    if (!opportunity) return;
    event.target.closest("dialog").close();
    stageFeedback = `已创建「${opportunity.title}」，当前阶段为${opportunity.stage}。`;
    finishForm(stageFeedback, "[data-board-status]");
    return;
  }
  if (event.target.matches("[data-board-stage]")) {
    event.preventDefault();
    stageFeedback = moveStage(event.target.dataset.boardStage, new FormData(event.target).get("stage"));
    finishForm(stageFeedback, "[data-board-status]");
    return;
  }
  const model = getModel();
  const message = handleAgentSubmit(event, model) ?? handleDeskSubmit(event, model);
  finishForm(message, "[aria-invalid='true']");
});

page.addEventListener("dragstart", (event) => {
  const handle = event.target.closest(".board-drag");
  if (!handle) return;
  draggedCase = handle.closest("[data-board-card]").dataset.boardCard;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", draggedCase);
});

page.addEventListener("dragover", (event) => {
  const column = event.target.closest("[data-board-drop]");
  if (!draggedCase || !column) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  const last = page.querySelector(".is-drop-target");
  if (last !== column) {
    last?.classList.remove("is-drop-target");
    column.classList.add("is-drop-target");
  }
});

page.addEventListener("drop", (event) => {
  const column = event.target.closest("[data-board-drop]");
  if (!draggedCase || !column) return;
  event.preventDefault();
  stageFeedback = moveStage(draggedCase, column.dataset.boardDrop);
  draggedCase = null;
  finishForm(stageFeedback, "[data-board-status]");
});

page.addEventListener("dragend", () => {
  draggedCase = null;
  page.querySelector(".is-drop-target")?.classList.remove("is-drop-target");
});
document.querySelector(".skip-link").addEventListener("click", (event) => {
  event.preventDefault();
  page.focus();
});

function renderSearchResults() {
  const query = searchInput.value.trim().toLowerCase();
  const matchingDeals = deals.filter((deal) => `${deal.company} ${deal.contact} ${deal.title}`.toLowerCase().includes(query));
  const matchingViews = Object.entries(routes).filter(([, title]) => title.toLowerCase().includes(query));
  searchResults.innerHTML = matchingDeals.length || matchingViews.length
    ? `${matchingDeals.length ? `<h3>客户与商机</h3>${matchingDeals.map((deal) =>
      `<a href="#inbox" data-select="${deal.id}">${avatar(deal)}<span><strong>${deal.company} · ${deal.contact}</strong><small>${deal.title}</small></span></a>`).join("")}` : ""}
      ${matchingViews.length ? `<h3>页面</h3>${matchingViews.map(([route, title]) =>
        `<a href="#${route}">${title}</a>`).join("")}` : ""}`
    : '<p class="muted">没有找到匹配的客户、商机或页面。</p>';
}

function openSearch() {
  if (searchDialog.open || dialog.open || page.querySelector("dialog[open]")) return;
  searchInput.value = "";
  renderSearchResults();
  searchDialog.showModal();
  searchInput.focus();
}

searchInput.addEventListener("input", renderSearchResults);
searchResults.addEventListener("click", (event) => {
  if (event.target.closest("a:not([data-select])") && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) searchDialog.close();
});
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    openSearch();
  }
});
railToggle.addEventListener("click", () => {
  railToggle.setAttribute("aria-expanded", railToggle.getAttribute("aria-expanded") === "true" ? "false" : "true");
});

window.addEventListener("hashchange", () => {
  railToggle.setAttribute("aria-expanded", "false");
  render();
  window.scrollTo(0, 0);
  page.focus({ preventScroll: true });
});

dialog.addEventListener("close", () => {
  if (dialog.returnValue !== "confirm") return;
  state = freshState();
  resetLabControls();
  resetReview();
  stageFeedback = "";
  save();
  render();
  announcement.textContent = "演示已重置。";
});

render();
