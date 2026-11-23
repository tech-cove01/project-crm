import { deals } from "./data.js";

const demoCaseIds = new Set(deals.map(({ id }) => id));
const organizationRules = [
  { label: "证据有效性", text: "报价、交期和售后承诺须核对当前发布资料。客户原话只证明客户表达过这项要求。", source: "ORG-03 · 第 3 版" },
  { label: "人工审批", text: "阶段变更需要先提交提案。仅在批准并执行后，更新商机与回执。", source: "ORG-07 · 第 2 版" },
];

const memoryLabels = {
  none: ["暂无候选", "neutral"], pending: ["待审核", "gold"], confirmed: ["已确认", "green"],
  rejected: ["已驳回", "neutral"], withdrawn: ["已撤回", "red"],
};

const definitions = {
  open: { title: "开放商机", key: "open_leads", field: "CRM 商机状态为 open", details: "当前选定销售工作区的开放商机。状态以 CRM 记录为准。" },
  meeting: { title: "已完成约见", key: "completed_appointments", field: "活动类型为 appointment_completed", details: "所选商机的已完成活动，使用 UTC 起点含、终点不含的时间窗。" },
  missing: { title: "缺少约见记录", key: "open_leads_without_completed_appointments", field: "开放商机和活动以商机 ID 关联", details: "查询开放商机中找不到匹配活动的记录，结果只覆盖 CRM 已录入的渠道。" },
  undefined: { title: "高潜客户", key: "", field: "待补充团队定义", details: "需要可核对的指标、阈值和时间范围，才能确定要查询哪些记录。" },
};

const flowActions = { task: "创建内部跟进任务", review: "提醒负责人复核资料" };
const periods = { 24: "等待 24 小时", 48: "等待 48 小时", 72: "等待 72 小时" };
const defaultConfig = { wait: 48, action: "task" };
const displayUtc = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "medium", timeStyle: "short", timeZone: "UTC", hour12: false,
});

export function readLabState(previous) {
  const normalizeConfig = (config) => ({
    wait: Object.hasOwn(periods, config?.wait) ? Number(config.wait) : defaultConfig.wait,
    action: Object.hasOwn(flowActions, config?.action) ? config.action : defaultConfig.action,
  });
  const versions = Array.isArray(previous?.versions)
    ? previous.versions.slice(0, 30).map(normalizeConfig) : [];
  const applied = versions[0] ?? { ...defaultConfig };
  const queue = Array.isArray(previous?.queue) ? previous.queue.slice(0, 40).filter((row) =>
    row && demoCaseIds.has(row.caseId) &&
    Number.isInteger(row.version) && row.version >= 1 && row.version <= versions.length &&
    ["queued", "ineligible", "paused"].includes(row.status),
  ).map(({ caseId, version, status }) => ({ caseId, version, status })) : [];
  return {
    versions: versions.length ? versions : [applied],
    draft: previous?.draft ? normalizeConfig(previous.draft) : { ...applied },
    enabled: previous?.enabled !== false,
    queue,
  };
}

let queryType = "open";
let queryWindow = { from: "2026-10-26", to: "2026-11-25" };
let runQuery = null;
let flowTab = "editor";

const labButton = (action, text, value, selected) =>
  `<button class="button ${selected ? "button-filter-selected" : ""}" data-action="${action}" data-value="${value}" type="button" aria-pressed="${selected}">${text}</button>`;

function memoryRow(deal, m) {
  const [title, variant] = memoryLabels[m.state.cases[deal.id].memory];
  return `<button class="lab-customer ${deal.id === m.deal.id ? "is-active" : ""}" type="button" data-action="lab-contact" data-select="${deal.id}" aria-pressed="${deal.id === m.deal.id}">
    ${m.avatar(deal)}<span><strong>${deal.contact}</strong><small>${deal.company}</small></span>
    ${m.label(title, variant)}
  </button>`;
}

function memory(m) {
  const { current, deal } = m;
  const [memoryStatus, memoryVariant] = memoryLabels[current.memory];
  const active = ["confirmed", "pending"].includes(current.memory);
  const confirmed = m.deals.filter((item) => m.state.cases[item.id].memory === "confirmed").length;
  const pending = m.deals.filter((item) => m.state.cases[item.id].memory === "pending").length;
  const controls = {
    none: m.button("extract", "从历史消息提取", "button-primary"),
    pending: m.button("remember", "确认候选", "button-primary") + m.button("dismiss", "驳回候选"),
    confirmed: m.button("withdraw", "撤回记忆"),
    rejected: "", withdrawn: "",
  };
  return `${m.heading("记忆与组织规则", "核对原始消息，决定哪些客户偏好可以进入新会话。")}
    <div class="lab-memory-grid">
      <aside class="panel lab-roster"><div class="panel-heading"><h2>客户记忆队列</h2></div>
        <p class="lab-queue-count">${confirmed} 条已确认 · ${pending} 条待审核</p>
        ${m.deals.map((item) => memoryRow(item, m)).join("")}
      </aside>
      <div class="lab-memory-detail">
        <section class="panel"><div class="panel-heading"><h2>${deal.contact}的客户记录</h2><span class="muted">${deal.company} · ${deal.role}</span></div>
          <div class="lab-card-grid">
            <article class="lab-evidence"><span class="lab-small">客户原话 · ${deal.message.id}</span>
              <blockquote>${deal.message.quote}</blockquote><span class="lab-small">${deal.message.date}</span>
              <a href="#inbox">返回同一条会话</a>
            </article>
            <article class="lab-evidence"><div class="panel-heading"><h3>候选决定</h3>${m.label(memoryStatus, memoryVariant)}</div>
              ${active ? `<p class="lab-claim">${deal.message.fact}</p>` : '<p>当前没有可用于后续会话的确认偏好。</p>'}
              <div class="button-row">${controls[current.memory]}</div>
            </article>
          </div>
        </section>
        <section class="panel"><div class="panel-heading"><h2>新会话读取</h2>${m.button("recall", "新会话读取", "button-small")}</div>
          ${current.reading === null ? '<p>按当前客户和有效状态核对。可以在确认前、确认后和撤回后分别读取。</p>'
            : `<div class="result-box"><strong>${current.reading ? "已读回 1 条确认事实" : "读回 0 条确认事实"}</strong>
              ${current.reading ? `<p>${deal.message.fact} <span class="lab-small">来源 ${deal.message.id}</span></p>` : '<p>当前客户没有可使用的已确认偏好。</p>'}</div>`}
          ${m.button("agent-open-memory", "在 Agent 工作台查看记忆取证", "button-small")}
        </section>
      </div>
    </div>
    <section class="panel lab-rules"><div class="panel-heading"><h2>工作区规则</h2><span class="muted">组织规则与客户记忆分开读取</span></div>
      <div class="lab-card-grid">${organizationRules.map((rule) => `<article><h3>${rule.label}</h3><p>${rule.text}</p><span class="lab-small">${rule.source} · 演示版本</span></article>`).join("")}</div>
    </section>`;
}

function matchedMeetings(deals, window) {
  return deals.filter((deal) => {
    const date = deal.meeting?.date.slice(0, 10);
    return date && date >= window.from && date < window.to;
  });
}

function queryResult(m) {
  if (!runQuery) return '<p class="lab-query-placeholder">运行后查看模板、结果覆盖和来源标识。</p>';
  if (runQuery.invalid) return '<div class="result-box"><strong>时间窗无效</strong><p>请选择 UTC 起止日期，结束日期晚于起始日期，最多相差 31 天。</p></div>';
  if (runQuery.type === "undefined") return '<div class="result-box"><strong>需要补充「高潜」定义</strong><p>请选择团队已审核的判断口径，例如某个阶段或已完成活动。该请求没有执行查询。</p></div>';
  const def = definitions[runQuery.type];
  const meetings = matchedMeetings(m.deals, runQuery.window);
  const items = runQuery.type === "open" ? m.deals
    : runQuery.type === "missing" ? m.deals.filter((deal) => !meetings.includes(deal))
    : meetings.filter((deal) => deal.id === runQuery.caseId);
  const coverage = runQuery.type === "missing" ? "部分覆盖" : "已查询";
  return `<div class="lab-query-meta">
      <div><span>许可模板</span><code>${def.key}</code></div>
      <div><span>目录版本／范围</span><strong>1.0.0 · ${runQuery.type === "meeting"
        ? m.deals.find((deal) => deal.id === runQuery.caseId).title : "当前演示工作区"}</strong></div>
      <div><span>结果／覆盖</span><strong>${items.length} 条 · ${coverage}</strong></div>
    </div>
    ${runQuery.type !== "open" ? `<p class="muted">UTC ${runQuery.window.from} 00:00 至 ${runQuery.window.to} 00:00（不含结束）</p>` : ""}
    ${runQuery.type === "missing" ? '<p class="lab-inline-note">没有已完成约见记录并不足以判断客户从未被跟进。</p>' : ""}
    ${runQuery.type === "meeting" && items.length
      ? items.map((deal) => `<div class="result-box"><strong>${deal.meeting.title}</strong><p>${deal.meeting.id} · ${deal.meeting.date} · ${deal.title}</p><a class="table-link" href="#workbench" data-select="${deal.id}">进入对应商机</a></div>`).join("")
      : m.dealRows(items)}`;
}

function ontology(m) {
  const def = definitions[queryType];
  return `${m.heading("业务口径与查询回执", "从版本化目录选择许可口径，在示例范围内核对条件和结果。", '<a class="button" href="../about/#architecture">看语义层所在位置</a>')}
    <div class="lab-ontology-grid">
      <aside class="panel lab-roster"><div class="panel-heading"><h2>口径目录</h2>${m.label("v1.0.0", "green")}</div>
        ${Object.entries(definitions).map(([key, item]) => `<button class="lab-definition ${key === queryType ? "is-active" : ""}" type="button" data-action="lab-definition" data-value="${key}" aria-pressed="${key === queryType}"><strong>${item.title}</strong><small>${item.key || "未收录"}</small></button>`).join("")}
      </aside>
      <div class="lab-memory-detail">
        <section class="panel"><div class="panel-heading"><h2>${def.title}</h2>${m.label(def.key ? "已审核口径" : "需补定义", def.key ? "green" : "gold")}</div>
          <p>${def.details}</p><p class="lab-claim">${def.field}</p>
          ${queryType === "meeting" ? m.caseSelect(m.deal, "限定商机") : ""}
          ${["meeting", "missing"].includes(queryType) ? `<div class="lab-dates">
            <label>UTC 起始日期<input type="date" data-control="lab-from" value="${queryWindow.from}"></label>
            <label>UTC 结束日期<input type="date" data-control="lab-to" value="${queryWindow.to}"></label>
          </div>` : ""}
          <div class="button-row">${m.button("lab-query", "运行许可查询", "button-primary")}</div>
        </section>
        <section class="panel"><div class="panel-heading"><h2>查询回执</h2><a href="../details.html#ontology-walkthrough">真实查询的验证口径</a></div>${queryResult(m)}</section>
      </div>
    </div>`;
}

function waitSelect(draft) {
  return `<select data-control="lab-flow-wait" aria-label="等待时长">${Object.entries(periods).map(([id, name]) => `<option value="${id}" ${draft.wait === +id ? "selected" : ""}>${name}</option>`).join("")}</select>`;
}

function actionSelect(draft) {
  return `<select data-control="lab-flow-action" aria-label="跟进动作">${Object.entries(flowActions).map(([id, name]) => `<option value="${id}" ${draft.action === id ? "selected" : ""}>${name}</option>`).join("")}</select>`;
}

function flowEditor(m) {
  const { draft, versions, enabled } = m.state.lab;
  const applied = versions[0];
  const dirty = draft.wait !== applied.wait || draft.action !== applied.action;
  return `<div class="lab-flow-grid">
    <section class="panel lab-flow-canvas"><div class="panel-heading"><h2>访谈后的内部跟进</h2>${m.label(dirty ? "有未发布更改" : `版本 ${versions.length} · 已发布`, dirty ? "gold" : "green")}</div>
      <ol class="lab-flow-steps">
        <li><span class="flow-dot">✓</span><div><small>触发</small><strong>商机有已完成约见</strong><p>以当前 CRM 活动记录核对。</p></div></li>
        <li><span class="flow-dot">◷</span><div><small>等待</small><label><span class="sr-only">等待时长</span>${waitSelect(draft)}</label><p>从已完成活动时间开始计。</p></div></li>
        <li><span class="flow-dot">＋</span><div><small>动作</small><label><span class="sr-only">跟进动作</span>${actionSelect(draft)}</label><p>演示只生成队列预演记录。</p></div></li>
      </ol>
      <div class="button-row">${dirty ? m.button("lab-flow-publish", "发布新版本", "button-primary")
        : '<button class="button" type="button" disabled>已与发布版本一致</button>'}${dirty ? m.button("lab-flow-discard", "还原草稿") : ""}</div>
    </section>
    <aside class="panel"><div class="panel-heading"><h2>运行预演</h2>${m.label(enabled ? "已启用" : "已暂停", enabled ? "green" : "gold")}</div>
      <p>预演使用已发布版本。看看所选商机会进入队列、因缺证跳过，还是被暂停拦下。</p>
      ${m.caseSelect(m.deal, "预演商机")}
      <div class="button-row">${m.button("lab-flow-preview", "预演当前商机", "button-primary")}${m.button("lab-flow-toggle", enabled ? "暂停规则" : "恢复规则")}</div>
    </aside>
  </div>`;
}

function flowQueue(m) {
  const outcomes = { queued: ["进入队列", "green"], ineligible: ["缺少已完成约见", "gold"], paused: ["规则暂停", "neutral"] };
  const queue = m.state.lab.queue;
  if (!queue.length) return `<section class="panel"><div class="panel-heading"><h2>预演队列</h2></div><p>还没有预演。先到编辑流程选择一笔商机。</p>${m.button("lab-flow-editor", "回到流程")}</section>`;
  return `<section class="panel"><div class="panel-heading"><h2>预演队列</h2>${m.label(`${queue.length} 条本地记录`)}</div>
    <ul class="lab-queue">${queue.map((entry) => {
      const deal = m.deals.find((item) => item.id === entry.caseId);
      const [name, tone] = outcomes[entry.status];
      const original = m.state.lab.versions.at(-entry.version);
      const activityAt = deal.meeting?.date.replace(" UTC", "Z").replace(" ", "T");
      const dueAt = entry.status === "queued" && original && activityAt
        ? displayUtc.format(Date.parse(activityAt) + original.wait * 3600_000) : "";
      return `<li><div><a href="#workbench" data-select="${deal.id}">${deal.title}</a>
        <span class="lab-small">${deal.company} · 规则 v${entry.version}${dueAt ? ` · ${periods[original.wait]} · ${flowActions[original.action]}` : ""}</span>
        ${dueAt ? `<span class="lab-small">预计执行 ${dueAt} UTC · 来源 ${deal.meeting.id}</span>` : ""}</div>${m.label(name, tone)}</li>`;
    }).join("")}</ul></section>`;
}

function flowVersions(m) {
  const versions = m.state.lab.versions;
  return `<section class="panel"><div class="panel-heading"><h2>发布记录</h2></div>
    <ul class="lab-queue">${versions.map((config, index) => `<li><div><strong>版本 ${versions.length - index}</strong>
      <span class="lab-small">${periods[config.wait]} · ${flowActions[config.action]}</span></div>${m.label(index === 0 ? "当前使用" : "历史版本", index === 0 ? "green" : "neutral")}</li>`).join("")}</ul></section>`;
}

function followups(m) {
  const tabs = { editor: "编辑流程", queue: "预演队列", versions: "版本记录" };
  const contents = { editor: flowEditor, queue: flowQueue, versions: flowVersions };
  return `${m.heading("跟进流程", "编辑一条内部跟进规则，比较发布版本在不同商机上的预演结果。")}
    <nav class="filters lab-flow-tabs" aria-label="流程视图">${Object.entries(tabs).map(([id, name]) => labButton("lab-flow-tab", name, id, flowTab === id)).join("")}</nav>
    ${contents[flowTab](m)}`;
}

export const labScreens = { memory, ontology, followups };

export function resetLabControls() {
  queryType = "open";
  queryWindow = { from: "2026-10-26", to: "2026-11-25" };
  runQuery = null;
  flowTab = "editor";
}

export function handleLabChange(event, m) {
  const id = event.target.dataset.control;
  const { value } = event.target;
  if (id === "lab-from" || id === "lab-to") {
    queryWindow[id.slice(4)] = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
    return true;
  }
  if (id === "lab-flow-wait" && Object.hasOwn(periods, value)) {
    m.state.lab.draft.wait = Number(value);
    return true;
  }
  if (id === "lab-flow-action" && Object.hasOwn(flowActions, value)) {
    m.state.lab.draft.action = value;
    return true;
  }
  return false;
}

export function handleLab(action, control, m) {
  const lab = m.state.lab;
  if (action === "lab-contact") {
    m.state.selected = control.dataset.select;
    return "已打开该客户的记忆记录。";
  }
  if (action === "lab-definition") {
    queryType = control.dataset.value;
    runQuery = null;
    return "已切换口径，等待运行。";
  }
  if (action === "lab-query") {
    const duration = Date.parse(queryWindow.to) - Date.parse(queryWindow.from);
    const invalid = ["meeting", "missing"].includes(queryType) &&
      !(duration > 0 && duration <= 31 * 24 * 60 * 60 * 1000);
    runQuery = { type: queryType, window: { ...queryWindow }, caseId: m.deal.id, invalid };
    return invalid ? "请校正日期范围。" : "查询回执已更新。";
  }
  if (action === "lab-flow-editor" || action === "lab-flow-tab") {
    flowTab = action === "lab-flow-editor" ? "editor" : control.dataset.value;
    return "已切换流程视图。";
  }
  if (action === "lab-flow-toggle") {
    lab.enabled = !lab.enabled;
    return lab.enabled ? "已恢复规则。" : "已暂停规则。";
  }
  if (action === "lab-flow-discard") {
    lab.draft = { ...lab.versions[0] };
    return "草稿已恢复为当前发布版本。";
  }
  if (action === "lab-flow-publish") {
    // Keep version IDs stable for existing queue receipts.
    if (lab.versions.length >= 30) return "演示已有 30 个版本，可以重置后继续。";
    const published = lab.versions[0];
    if (published.wait === lab.draft.wait && published.action === lab.draft.action) return "";
    lab.versions.unshift({ ...lab.draft });
    return `版本 ${lab.versions.length} 已在当前演示发布。`;
  }
  if (action === "lab-flow-preview") {
    const status = !lab.enabled ? "paused" : m.deal.meeting ? "queued" : "ineligible";
    lab.queue = [{ caseId: m.deal.id, version: lab.versions.length, status }, ...lab.queue].slice(0, 40);
    flowTab = "queue";
    return "预演结果已写入当前演示队列。";
  }
}
