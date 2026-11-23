import { deals } from "./data.js";

const kinds = {
  wait: { name: "等待", symbol: "◷", detail: "从当前预计执行时间向后顺延。", initial: 24 },
  task: { name: "创建内部跟进任务", symbol: "＋", detail: "给商机负责人预留一条内部任务。", initial: "核对访谈纪要与下一步安排" },
  review: { name: "提醒负责人复核资料", symbol: "◇", detail: "提醒负责人核对资料版本和业务依据。", initial: "复核访谈纪要和现有企业资料" },
  note: { name: "准备内部跟进草稿", symbol: "✎", detail: "只记录供负责人查看的草稿内容。", initial: "整理本次访谈里尚待确认的事项" },
};
const tabs = { editor: "编辑流程", queue: "预演队列", versions: "版本记录" };
const states = {
  queued: ["进入队列", "green", "找到当前商机的已完成约见。"],
  ineligible: ["缺少已完成约见", "gold", "当前商机没有命中流程触发条件。"],
  paused: ["规则暂停", "neutral", "预演时规则处于暂停状态。"],
  cancelled: ["已取消", "neutral", "本条浏览器预演已由负责人取消。"],
};
const initialNodes = [
  { id: 1, type: "wait", value: 48 },
  { id: 2, type: "task", value: kinds.task.initial },
];
const caseIds = new Set(deals.map(({ id }) => id));
const limits = { node: 8, revision: 30, queue: 40, detail: 72, wait: 168 };
const utc = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC", hourCycle: "h23" });

function escapeText(text) {
  const replacements = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return text.replace(/[&<>"']/g, (character) => replacements[character]);
}

const copyNodes = (nodes) => nodes.map((node) => ({ ...node }));
const equalNodes = (first, second) => JSON.stringify(first) === JSON.stringify(second);
const versionLabel = (version) => `版本 ${version}`;
const latest = (state) => state.versions[0];

function safeNodes(raw, fallback = initialNodes) {
  if (!Array.isArray(raw)) return copyNodes(fallback);
  const seen = new Set();
  return raw.slice(0, limits.node).flatMap((node) => {
    if (!Number.isSafeInteger(node?.id) || node.id < 1 || seen.has(node.id) || !Object.hasOwn(kinds, node.type)) return [];
    seen.add(node.id);
    const value = node.type === "wait"
      ? (Number.isInteger(node.value) && node.value >= 1 && node.value <= limits.wait ? node.value : kinds.wait.initial)
      : (typeof node.value === "string" && node.value.trim() ? node.value.trim().slice(0, limits.detail) : kinds[node.type].initial);
    return [{ id: node.id, type: node.type, value }];
  });
}

function legacyNodes(config) {
  const action = config?.action === "review" ? "review" : "task";
  const wait = [24, 48, 72].includes(config?.wait) ? config.wait : 48;
  return [{ id: 1, type: "wait", value: wait }, { id: 2, type: action, value: kinds[action].initial }];
}

function validVersion(item) {
  return Number.isInteger(item?.revision) && item.revision >= 1 && item.revision <= limits.revision;
}

export function readWorkflowState(previous, legacyLab) {
  const revs = new Set();
  let versions = Array.isArray(previous?.versions)
    ? previous.versions.filter(validVersion).slice(0, limits.revision).flatMap((item) => {
      if (revs.has(item.revision)) return [];
      const nodes = safeNodes(item.nodes);
      if (nodes.every(({ type }) => type === "wait")) return [];
      revs.add(item.revision);
      return [{ revision: item.revision, nodes, restoredFrom: Number.isInteger(item.restoredFrom) ? item.restoredFrom : null }];
    }).sort((a, b) => b.revision - a.revision) : [];
  if (!versions.length && Array.isArray(legacyLab?.versions)) {
    const short = legacyLab.versions.slice(0, limits.revision);
    versions = short.map((config, index) => ({ revision: short.length - index, nodes: legacyNodes(config), restoredFrom: null }));
  }
  if (!versions.length) versions = [{ revision: 1, nodes: copyNodes(initialNodes), restoredFrom: null }];
  const published = versions[0].nodes;
  const saved = previous
    ? safeNodes(previous.saved, published) : legacyLab?.draft ? legacyNodes(legacyLab.draft) : copyNodes(published);
  const draft = safeNodes(previous?.draft, saved);
  const usedIds = new Set();
  const queueEntries = previous?.queue ?? legacyLab?.queue;
  const queue = Array.isArray(queueEntries) ? queueEntries.slice(0, limits.queue).flatMap((item, index) => {
    const id = Number.isSafeInteger(item?.id) && item.id > 0 ? item.id : queueEntries.length - index;
    if (!caseIds.has(item?.caseId) || !Object.hasOwn(states, item.status) || usedIds.has(id) ||
        !versions.some(({ revision }) => revision === item.version)) return [];
    usedIds.add(id);
    return [{ id, caseId: item.caseId, version: item.version, status: item.status }];
  }) : [];
  const selectedId = previous?.selected;
  const selected = selectedId === "start" || selectedId === "end" || draft.some(({ id }) => id === selectedId)
    ? selectedId : draft[0]?.id ?? "start";
  return {
    draft, saved, versions, queue, selected,
    enabled: (previous ? previous.enabled : legacyLab?.enabled) !== false,
    tab: Object.hasOwn(tabs, previous?.tab) ? previous.tab : "editor",
    filterStatus: Object.hasOwn(states, previous?.filterStatus) ? previous.filterStatus : "all",
    filterVersion: versions.some(({ revision }) => revision === previous?.filterVersion) ? previous.filterVersion : "all",
    message: "",
  };
}

function flowButton(action, text, value, { selected, primary, disabled } = {}) {
  return `<button type="button" class="button ${primary ? "button-primary" : "button-small"}" data-action="${action}"
    ${value !== undefined ? `data-value="${value}"` : ""}${selected !== undefined ? ` aria-pressed="${selected}"` : ""}
    ${disabled ? "disabled" : ""}>${text}</button>`;
}

function nodeLabel(node) {
  return node.type === "wait" ? `顺延 ${node.value} 小时` : escapeText(node.value);
}

function renderNode(node, selected) {
  const active = selected === node.id;
  const { name, symbol } = kinds[node.type];
  return `<li class="flow-node is-${node.type}"><button type="button" data-action="flow-select" data-value="${node.id}" aria-pressed="${active}">
    <span class="flow-node-symbol" aria-hidden="true">${symbol}</span><span><strong>${name}</strong><small>${nodeLabel(node)}</small></span>
  </button></li>`;
}

function renderBoundary(id, selected) {
  const start = id === "start";
  return `<li class="flow-node is-boundary"><button type="button" data-action="flow-select" data-value="${id}" aria-pressed="${selected === id}">
    <span class="flow-node-symbol" aria-hidden="true">${start ? "⌁" : "■"}</span>
    <span><strong>${start ? "已完成约见" : "预演结束"}</strong><small>${start ? "从活动记录启动" : "记录每项内部动作的时间"}</small></span>
  </button></li>`;
}

function statusBlock(state, m) {
  const saved = equalNodes(state.draft, state.saved);
  const matchesRelease = equalNodes(state.draft, latest(state).nodes);
  return `<section class="flow-controls panel" aria-label="流程版本与草稿">
    <div class="flow-release-status"><strong>访谈后内部跟进</strong>
      <div><span>当前发布 · ${versionLabel(latest(state).revision)}</span>
        ${m.label(state.enabled ? "已启用" : "已暂停", state.enabled ? "green" : "gold")}
        ${m.label(!saved ? "有未保存修改" : matchesRelease ? "与发布版本一致" : "草稿已保存", saved ? "neutral" : "gold")}</div></div>
    <div class="flow-actions">
      ${flowButton("flow-save", "保存草稿", undefined, { disabled: saved })}
      ${flowButton("flow-publish", "发布新版本", undefined, { primary: true, disabled: matchesRelease })}
      ${flowButton("flow-reset", "还原草稿", undefined, { disabled: saved && matchesRelease })}
      ${flowButton("flow-toggle", state.enabled ? "暂停规则" : "恢复规则")}
    </div>
  </section>`;
}

function flowCanvas(state) {
  return `<section class="panel flow-canvas" aria-label="流程画布">
    <div class="panel-heading"><h2>流程路径</h2>
      <span class="muted">${state.draft.length} 个可配置节点</span>
      <button type="button" class="button button-small flow-mobile-settings" data-action="flow-settings">查看节点设置</button>
    </div>
    <div role="group" aria-label="添加节点" class="flow-actions flow-toolbox">
      ${[["wait", "添加等待"], ["task", "添加内部任务"], ["review", "添加复核提醒"], ["note", "添加草稿"]]
        .map(([type, label]) => flowButton("flow-add", label, type, { disabled: state.draft.length >= limits.node })).join("")}
    </div>
    <ol class="flow-path">${renderBoundary("start", state.selected)}${state.draft.map((node) => renderNode(node, state.selected)).join("")}${renderBoundary("end", state.selected)}</ol>
  </section>`;
}

function nodeInspector(state, m) {
  const position = state.draft.findIndex(({ id }) => id === state.selected);
  const node = state.draft[position];
  const selectedTitle = node ? kinds[node.type].name : state.selected === "end" ? "预演结束" : "已完成约见";
  const description = node ? kinds[node.type].detail : state.selected === "end"
    ? "列出当前发布版本计算出的内部动作。"
    : "预演锁定所选商机，并检查其是否有已完成约见记录。";
  const input = node?.type === "wait"
    ? `<label class="flow-field">等待小时<input type="number" data-flow-value min="1" max="${limits.wait}" step="1" value="${node.value}"></label>`
    : node ? `<label class="flow-field">节点内容<textarea data-flow-value rows="3" maxlength="${limits.detail}">${escapeText(node.value)}</textarea></label>` : "";
  return `<aside class="panel flow-inspector" data-flow-inspector tabindex="-1" aria-label="节点设置">
    <div class="panel-heading"><h2>节点设置</h2>${m.label(node ? `步骤 ${position + 1}` : "固定节点")}</div>
    <h3>${selectedTitle}</h3><p>${description}</p>${input}
    ${node ? `<div class="flow-actions">${flowButton("flow-apply", "应用节点设置", undefined, { primary: true })}</div>
      <div class="flow-actions flow-order" aria-label="节点操作">
        ${flowButton("flow-move", "上移节点", "up", { disabled: position === 0 })}
        ${flowButton("flow-move", "下移节点", "down", { disabled: position === state.draft.length - 1 })}
        ${flowButton("flow-remove", "删除节点")}
      </div>` : ""}
  </aside>`;
}

function editor(state, m) {
  return `${statusBlock(state, m)}
    <div class="flow-layout">${flowCanvas(state)}<div class="flow-side">
      ${nodeInspector(state, m)}
      <section class="panel flow-preview"><div class="panel-heading"><h2>运行预演</h2>${m.label(versionLabel(latest(state).revision), "green")}</div>
        <p>按已发布版本计算所选商机的下一步，结果保存在当前演示。</p>
        ${m.caseSelect(m.deal, "预演商机")}
        ${flowButton("flow-preview", "预演当前商机", undefined, { primary: true })}
      </section></div>
    </div>`;
}

function options(values, current) {
  return values.map(([key, text]) => `<option value="${key}" ${String(key) === String(current) ? "selected" : ""}>${text}</option>`).join("");
}

function actionTimeline(published, deal) {
  const source = deal.meeting?.date;
  if (!source) return [];
  let time = Date.parse(source.replace(" UTC", "Z").replace(" ", "T"));
  return published.nodes.flatMap(({ type, value }) => {
    if (type === "wait") {
      time += value * 3600_000;
      return [];
    }
    return [{ time: utc.format(time), label: kinds[type].name, value: escapeText(value) }];
  });
}

function receiptRow(entry, state, m) {
  const deal = m.deals.find((item) => item.id === entry.caseId);
  const version = state.versions.find(({ revision }) => revision === entry.version);
  const [name, tone, detail] = states[entry.status];
  const schedule = ["queued", "cancelled"].includes(entry.status) ? actionTimeline(version, deal) : [];
  const hours = version.nodes.filter(({ type }) => type === "wait").reduce((sum, node) => sum + node.value, 0);
  return `<li class="flow-receipt">
    <div class="flow-receipt-heading"><div>${m.avatar(deal)}<span><a href="#workbench" data-select="${deal.id}">${deal.title}</a>
      <small>${deal.company} · 规则 v${entry.version}</small></span></div>${m.label(name, tone)}</div>
    <p>${detail}</p>
    ${schedule.length ? `<p>预计执行 ${schedule[0].time} UTC · 来源 ${deal.meeting.id}</p>
      <details><summary>查看预演步骤</summary><ol>${schedule.map((item) => `<li><strong>${item.label}</strong><small>${item.time} UTC</small><p>${item.value}</p></li>`).join("")}</ol>
      ${hours ? `<p>本版本共设定等待 ${hours} 小时。</p>` : ""}</details>` : ""}
    ${entry.status === "queued" ? flowButton("flow-cancel", "取消此条预演", entry.id) : ""}
  </li>`;
}

function queueView(state, m) {
  const filters = state.queue.filter(({ status, version }) =>
    (state.filterStatus === "all" || status === state.filterStatus) && (state.filterVersion === "all" || version === state.filterVersion));
  return `<section class="panel flow-queue"><div class="panel-heading"><h2>预演队列</h2>${m.label(`${filters.length} 条 · 当前浏览器`)}</div>
    <div class="flow-queue-filters">
      <label class="flow-field">队列状态<select data-control="flow-filter-status">${options([["all", "全部状态"], ...Object.entries(states).map(([key, [text]]) => [key, text])], state.filterStatus)}</select></label>
      <label class="flow-field">流程版本<select data-control="flow-filter-version">${options([["all", "全部版本"], ...state.versions.map(({ revision }) => [revision, versionLabel(revision)])], state.filterVersion)}</select></label>
      ${flowButton("flow-tab", "回到流程", "editor")}
    </div>
    ${filters.length ? `<ul>${filters.map((entry) => receiptRow(entry, state, m)).join("")}</ul>`
      : `<p>${state.queue.length ? "没有符合当前筛选的预演记录。" : "预演一笔商机后，预计时刻、版本与原因会出现在这里。"}</p>`}
  </section>`;
}

function versionView(state, m) {
  return `<section class="panel flow-versions"><div class="panel-heading"><h2>发布记录</h2></div>
    <ul>${state.versions.map((config, index) => `<li><div><strong>${versionLabel(config.revision)}</strong>
      <p>${config.nodes.map((node) => node.type === "wait" ? `等待 ${node.value} 小时` : kinds[node.type].name).join(" · ")}</p>
      ${config.restoredFrom ? `<small>从${versionLabel(config.restoredFrom)} 恢复</small>` : ""}</div>
      ${index === 0 ? m.label("当前使用", "green") : flowButton("flow-restore", `从${versionLabel(config.revision)} 恢复草稿`, config.revision)}
    </li>`).join("")}</ul></section>`;
}

const views = { editor, queue: queueView, versions: versionView };

function followups(m) {
  const state = m.state.workflow;
  return `${m.heading("跟进流程", "编辑内部规则，发布独立版本，再按实际记录预演不同商机。")}
    <div class="flow-actions flow-tabs" role="group" aria-label="流程视图">
      ${Object.entries(tabs).map(([id, title]) => flowButton("flow-tab", title, id, { selected: state.tab === id })).join("")}
    </div>
    ${state.message ? `<p class="flow-feedback">${state.message}</p>` : ""}
    ${views[state.tab](state, m)}`;
}

export const workflowScreens = { followups };

export function handleWorkflowChange(event, m) {
  const control = event.target.dataset.control;
  const state = m.state.workflow;
  if (control === "flow-filter-status") {
    state.filterStatus = Object.hasOwn(states, event.target.value) ? event.target.value : "all";
  } else if (control === "flow-filter-version") {
    const version = Number(event.target.value);
    state.filterVersion = state.versions.some(({ revision }) => version === revision) ? version : "all";
  } else {
    return false;
  }
  state.message = "已更新预演队列筛选。";
  return state.message;
}

function applyNodeSetting(control, node) {
  const raw = control.closest("[data-flow-inspector]")?.querySelector("[data-flow-value]")?.value?.trim() ?? "";
  if (node.type === "wait") {
    const hours = Number(raw);
    if (!Number.isInteger(hours) || hours < 1 || hours > limits.wait)
      return `等待时长必须是 1–${limits.wait} 的整数小时。`;
    node.value = hours;
  } else {
    if (!raw || raw.length > limits.detail) return `请填写不超过 ${limits.detail} 字的内部动作内容。`;
    node.value = raw;
  }
  return "节点设置已应用到草稿。";
}

function publishVersion(state) {
  const published = latest(state);
  if (equalNodes(published.nodes, state.draft)) return "草稿内容与当前发布版本一致。";
  if (state.draft.every(({ type }) => type === "wait")) return "发布前至少添加一个内部动作节点。";
  if (published.revision >= limits.revision) return "本次演示已达到版本上限。";
  const revision = published.revision + 1;
  const nodes = copyNodes(state.draft);
  const previous = state.versions.find((version) => equalNodes(version.nodes, nodes));
  state.versions.unshift({ revision, nodes, restoredFrom: previous?.revision ?? null });
  state.saved = copyNodes(nodes);
  return `${versionLabel(revision)}已发布，已有预演保留原版本。`;
}

function updateWorkflow(action, control, m, state) {
  const value = control.dataset.value;
  const index = state.draft.findIndex(({ id }) => id === state.selected);
  const node = state.draft[index];
  switch (action) {
    case "flow-settings":
      control.closest(".flow-layout")?.querySelector("[data-flow-inspector]")?.focus();
      return;
    case "flow-tab":
      if (!Object.hasOwn(tabs, value)) return;
      state.tab = value;
      return `已打开${tabs[value]}。`;
    case "flow-select": {
      const selected = ["start", "end"].includes(value) ? value : Number(value);
      if (typeof selected === "number" && !state.draft.some(({ id }) => id === selected)) return;
      state.selected = selected;
      return "已打开该节点的设置。";
    }
    case "flow-add": {
      if (!Object.hasOwn(kinds, value) || state.draft.length >= limits.node) return;
      const id = Math.max(0, ...state.draft.map((item) => item.id)) + 1;
      const target = state.selected === "start" ? 0 : index >= 0 ? index + 1 : state.draft.length;
      state.draft.splice(target, 0, { id, type: value, value: kinds[value].initial });
      state.selected = id;
      return `已添加${kinds[value].name}节点。`;
    }
    case "flow-apply":
      if (node) return applyNodeSetting(control, node);
      return;
    case "flow-move": {
      if (!node || !["up", "down"].includes(value)) return;
      const target = index + (value === "up" ? -1 : 1);
      if (target < 0 || target >= state.draft.length) return;
      [state.draft[index], state.draft[target]] = [state.draft[target], state.draft[index]];
      return "草稿执行顺序已更新。";
    }
    case "flow-remove":
      if (!node) return;
      state.draft.splice(index, 1);
      state.selected = state.draft[index]?.id ?? state.draft[index - 1]?.id ?? "start";
      return "已从草稿删除所选节点。";
    case "flow-save":
      state.saved = copyNodes(state.draft);
      return "草稿已保存到本次浏览器演示。";
    case "flow-publish":
      return publishVersion(state);
    case "flow-reset":
      state.draft = copyNodes(latest(state).nodes);
      state.saved = copyNodes(state.draft);
      state.selected = state.draft[0]?.id ?? "start";
      return "草稿已还原为当前发布版本。";
    case "flow-restore": {
      const version = state.versions.find((item) => item.revision === Number(value));
      if (!version || version === latest(state)) return;
      state.draft = copyNodes(version.nodes);
      state.selected = state.draft[0]?.id ?? "start";
      state.tab = "editor";
      return `已将${versionLabel(version.revision)} 载入草稿。发布后才会更换当前版本。`;
    }
    case "flow-toggle":
      state.enabled = !state.enabled;
      return state.enabled ? "规则已恢复。" : "规则已暂停。后续预演会标记为暂停。";
    case "flow-preview": {
      const id = (state.queue[0]?.id ?? 0) + 1;
      const status = !state.enabled ? "paused" : m.deal.meeting ? "queued" : "ineligible";
      state.queue = [{ id, caseId: m.deal.id, version: latest(state).revision, status }, ...state.queue].slice(0, limits.queue);
      state.tab = "queue";
      state.filterStatus = "all";
      state.filterVersion = "all";
      return `已预演${m.deal.title}。`;
    }
    case "flow-cancel": {
      const receipt = state.queue.find(({ id }) => id === Number(value));
      if (receipt?.status !== "queued") return;
      receipt.status = "cancelled";
      return "已取消这条预演记录。";
    }
  }
}

export function handleWorkflow(action, control, m) {
  const state = m.state.workflow;
  const message = updateWorkflow(action, control, m, state);
  if (!message) return;
  state.message = action === "flow-tab" || action === "flow-select" ? "" : message;
  return message;
}
