import { crmProfiles, crmTemplates } from "./crm-data.js";
import { pipelineStages } from "./data.js";

const inboxFilters = [
  ["all", "全部"],
  ["unread", "未读"],
  ["human", "人工接管"],
  ["assist", "智能辅助"],
];
const taskFilters = [["all", "全部"], ["open", "待完成"], ["done", "已完成"]];
const messageLimit = 500;
const opportunityNameLimit = 64;
const opportunityAmountLimit = 999999999.99;
const crmKeys = Object.keys(crmProfiles);
const crmMemoryNames = {
  none: ["暂无候选", "neutral"],
  pending: ["待审核", "gold"],
  confirmed: ["已确认", "green"],
  rejected: ["已驳回", "neutral"],
  withdrawn: ["已撤回", "neutral"],
};

const escape = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);

function readOpportunity(input, number) {
  const title = typeof input?.title === "string" ? input.title.trim() : "";
  const company = typeof input?.company === "string" ? input.company.trim() : "";
  if (!title || !company || title.length > opportunityNameLimit || company.length > opportunityNameLimit) return null;
  const { stage, amount } = input;
  if (!pipelineStages.some(({ name }) => name === stage)) return null;
  if (!Number.isFinite(amount) || amount < 0 || amount > opportunityAmountLimit) return null;
  return { id: `board-${number}`, title, company, stage, amount: Math.round(amount * 100) / 100 };
}

export function readCrmState(previous) {
  const byCase = Object.fromEntries(crmKeys.map((id) => {
    const prior = previous?.byCase?.[id];
    const entries = Array.isArray(prior?.entries) ? prior.entries : [];
    return [id, {
      human: typeof prior?.human === "boolean" ? prior.human : crmProfiles[id].human,
      read: prior?.read === true,
      mode: prior?.mode === "note" ? "note" : "reply",
      drafts: Object.fromEntries(["reply", "note"].map((mode) => [mode,
        typeof prior?.drafts?.[mode] === "string" ? prior.drafts[mode].slice(0, messageLimit) : ""])),
      entries: entries.slice(-30).filter((item) => (
        item?.kind === "reply" || item?.kind === "note"
      ) && typeof item.text === "string").map(({ kind, text }) => ({ kind, text: text.slice(0, messageLimit) })),
    }];
  }));
  const opportunities = [];
  for (const saved of Array.isArray(previous?.opportunities) ? previous.opportunities : []) {
    const opportunity = readOpportunity(saved, opportunities.length + 1);
    if (opportunity) opportunities.push(opportunity);
  }
  return { byCase, opportunities, inboxFilter: "all", inboxQuery: "", directoryQuery: "", pipelineStage: "all", taskFilter: "all" };
}

function getCrm(m) {
  m.state.crm ??= readCrmState();
  return m.state.crm;
}

function availableTemplates(m) {
  return m.state.desk?.templates ?? crmTemplates;
}

export function addToCrmReplyDraft(m, caseId, text) {
  const customer = getCrm(m).byCase[caseId];
  if (!customer || m.state.cases[caseId].closed) return { error: "当前会话已结束，无法插入回复草稿。" };
  const draft = [customer.drafts.reply, text].filter((part) => part.trim()).join("\n\n");
  if (draft.length > messageLimit) return { error: `插入后会超过 ${messageLimit} 字，请先缩短草稿。` };
  customer.drafts.reply = draft;
  customer.mode = "reply";
  return { draft };
}

function profile(deal) {
  return crmProfiles[deal.id];
}

function buttonAction(action, title, attrs = "", className = "button") {
  return `<button type="button" class="${className}" data-action="${action}" ${attrs}>${title}</button>`;
}

function caseLink(deal, route, title, className = "table-link") {
  return `<a class="${className}" href="#${route}" data-select="${deal.id}">${title}</a>`;
}

function filters(items, current, name, action) {
  return `<div class="crm-filters" role="group" aria-label="${name}">
    ${items.map(([id, label]) => buttonAction(action, label,
    `data-filter="${id}" aria-pressed="${id === current}"`, "crm-filter")).join("")}
  </div>`;
}

function initialMessages(deal) {
  return [...profile(deal).entries, {
    kind: "customer", time: deal.message.date, text: deal.message.quote, source: `客户原文 · ${deal.message.id}`,
  }];
}

function matches(deal, query, extra = []) {
  const keyword = query.trim().toLocaleLowerCase();
  return !keyword || [deal.contact, deal.company, deal.title, deal.role, ...extra].some((item) => (
    item.toLocaleLowerCase().includes(keyword)
  ));
}

function unreadFor(deal, crm) {
  return crm.byCase[deal.id].read ? 0 : profile(deal).unread;
}

function matchInbox(deal, crm) {
  if (crm.inboxFilter === "unread" && !unreadFor(deal, crm)) return false;
  if (crm.inboxFilter === "human" && !crm.byCase[deal.id].human) return false;
  if (crm.inboxFilter === "assist" && crm.byCase[deal.id].human) return false;
  return matches(deal, crm.inboxQuery, [
    ...initialMessages(deal).map((message) => message.text),
    ...crm.byCase[deal.id].entries.map((message) => message.text),
  ]);
}

function inboxItems(m) {
  const crm = getCrm(m);
  const items = m.deals.filter((deal) => matchInbox(deal, crm));
  return {
    count: items.length,
    markup: items.length ? items.map((deal) => {
      const active = m.deal.id === deal.id;
      const unread = unreadFor(deal, crm);
      return `<button type="button" class="crm-thread-item${active ? " is-selected" : ""}"
        data-action="crm-select-case" data-case="${deal.id}" aria-pressed="${active}">
        ${m.avatar(deal)}
        <span class="crm-thread-item-body">
          <span class="crm-thread-item-title"><strong>${deal.contact}</strong><small>${profile(deal).channel}</small></span>
          <span class="crm-thread-company">${deal.company}</span>
          <span class="crm-thread-snippet">${deal.message.quote}</span>
        </span>
        ${unread ? `<span class="crm-unread" aria-label="${unread} 条未读">${unread}</span>` : ""}
      </button>`;
    }).join("") : '<p class="crm-empty">没有符合当前筛选的会话。</p>',
  };
}

function messageMarkup(message, deal) {
  if (message.kind === "activity") {
    return `<li class="crm-conversation-event"><span>${escape(message.time)}</span><p>${escape(message.text)}</p></li>`;
  }
  const author = message.kind === "customer" ? deal.contact : message.kind === "team" ? profile(deal).owner : "林序";
  const note = message.kind === "note";
  const type = note ? "内部备注" : message.kind === "reply" ? "演示回复" : "";
  return `<li class="crm-message crm-message-${message.kind}">
    <div class="crm-message-meta"><strong>${author}</strong>${type ? `<span class="crm-message-kind">${type}</span>` : ""}
      <time>${escape(message.time ?? "本地操作")}</time></div>
    <div class="crm-bubble"><p>${escape(message.text)}</p>
      ${message.source ? `<span class="crm-source">${escape(message.source)}</span>` : ""}
    </div>
  </li>`;
}

function composer(customer, closed, templates) {
  if (closed) return '<div class="crm-composer crm-closed-note">会话已结束。后续核对可以从跟进任务或客户记忆继续。</div>';
  const isNote = customer.mode === "note";
  const draft = customer.drafts[customer.mode];
  return `<div class="crm-composer">
    <div class="crm-composer-tools">
      ${filters([["reply", "回复客户"], ["note", "内部备注"]], customer.mode, "内容类型", "crm-composer-mode")}
      ${isNote ? "" : `<label class="crm-select crm-template"><span class="sr-only">插入快捷回复</span>
        <select data-crm-control="template"><option value="">插入快捷回复</option>
          ${templates.map(({ id, label }) => `<option value="${escape(id)}">${escape(label)}</option>`).join("")}
        </select></label>`}
      <a class="table-link crm-library-link" href="#replies">管理快捷回复</a>
    </div>
    <p class="crm-template-feedback" data-crm-template-feedback role="status" hidden></p>
    <label class="sr-only" for="crm-draft">${isNote ? "内部备注内容" : "回复草稿"}</label>
    <textarea id="crm-draft" data-crm-control="draft" rows="3" maxlength="${messageLimit}"
      placeholder="${isNote ? "例如：等待对方补充试点范围。" : "写一条演示回复，或插入快捷回复。"}">${escape(draft)}</textarea>
    <div class="crm-composer-actions">
      <small>保存在当前标签页，页面刷新后可读回。</small>
      <button type="button" class="button button-primary button-small" data-action="crm-save-message"
        ${draft.trim() ? "" : "disabled"}>${isNote ? "保存内部备注" : "记录演示回复"}</button>
    </div>
  </div>`;
}

function contactContext(m, showContactLink = true) {
  const { current, deal } = m;
  const stage = m.stageFor(deal);
  const [memoryLabel, memoryColor] = crmMemoryNames[current.memory] ?? crmMemoryNames.none;
  const showsFact = current.memory === "pending" || current.memory === "confirmed";
  return `<aside class="crm-context" aria-label="当前客户信息">
    <section class="crm-context-block">
      <div class="crm-context-head"><h3>关联商机</h3>${m.label(stage, stage === "技术评估" ? "green" : "neutral")}</div>
      <strong class="crm-context-name">${deal.title}</strong>
      <div class="crm-context-total">${m.money.format(deal.amount)}</div>
      ${caseLink(deal, "pipeline", "查看销售管道")}
    </section>
    <section class="crm-context-block">
      <div class="crm-context-head"><h3>客户记忆</h3>${m.label(memoryLabel, memoryColor)}</div>
      <p>${showsFact ? deal.message.fact : "当前没有可供使用的已确认偏好。"}</p>
      ${showsFact ? `<small>来源 ${deal.message.id}</small>` : ""}
      ${caseLink(deal, "memory", current.memory === "pending" ? "审核这条候选" : "查看记忆与原文")}
    </section>
    <section class="crm-context-block">
      <div class="crm-context-head"><h3>跟进任务</h3>${m.label(current.taskDone ? "已完成" : "待完成", current.taskDone ? "green" : "neutral")}</div>
      <strong class="crm-context-name">${deal.task.label}</strong>
      <p>${deal.task.owner}负责 · ${deal.task.due}</p>
      ${caseLink(deal, "tasks", "查看跟进任务")}
    </section>
    ${showContactLink ? `<div class="crm-context-footer">${caseLink(deal, "contacts", "打开联系人档案")}</div>` : ""}
  </aside>`;
}

function inbox(m) {
  const crm = getCrm(m);
  const { deal, current } = m;
  const selected = crm.byCase[deal.id];
  const items = inboxItems(m);
  return `${m.heading("会话收件箱", "把客户原话、人工接管、商机和跟进放在同一处。")}
    <div class="crm-inbox">
      <section class="crm-inbox-list" aria-label="历史单聊列表">
        <div class="crm-list-header">
          <div class="crm-context-head"><h2>会话</h2><span class="muted" data-crm-inbox-count aria-live="polite">${items.count} 条</span></div>
          <label class="crm-search"><span class="sr-only">搜索联系人、企业或消息</span>
            <input type="search" data-crm-control="inbox-search" value="${escape(crm.inboxQuery)}"
              placeholder="搜索联系人、企业或消息" maxlength="80">
          </label>
          ${filters(inboxFilters, crm.inboxFilter, "筛选会话", "crm-inbox-filter")}
        </div>
        <div data-crm-inbox-results>${items.markup}</div>
      </section>
      <section class="crm-thread" aria-label="${deal.contact}的对话">
        <header class="crm-thread-header">
          <div class="crm-thread-top">${m.avatar(deal)}<div><h2>${deal.contact}</h2><p>${deal.company} · ${deal.role}</p></div></div>
          <div class="crm-thread-status">${m.label(profile(deal).channel)}${m.label(current.closed ? "已结束" :
          selected.human ? "人工接管中" : "智能辅助中", current.closed ? "neutral" : selected.human ? "gold" : "green")}</div>
          <div class="crm-thread-actions">
            ${current.closed ? "" : buttonAction("crm-handoff", selected.human ? "恢复智能辅助" : "转为人工接管", "", "button button-small")}
            ${caseLink(deal, "workbench", "在 Agent 工作台诊断", "button button-small")}
          </div>
        </header>
        <ol class="crm-messages" aria-label="示例消息">
          ${[...initialMessages(deal), ...selected.entries].map((message) => messageMarkup(message, deal)).join("")}
        </ol>
        ${composer(selected, current.closed, availableTemplates(m))}
        <div class="crm-thread-footer">${current.closed
          ? caseLink(deal, "memory", "查看本次会话的记忆候选")
          : buttonAction("crm-close", "结束会话并提取候选", "", "crm-text-button")}</div>
      </section>
      ${contactContext(m)}
    </div>`;
}

function riskFor(deal, current) {
  const info = profile(deal);
  if (!info.risk) return null;
  if (deal.id === "gallery" && current.memory === "confirmed") return null;
  return { detail: info.risk, action: current.taskDone ? "已完成相关跟进任务，可复核最新情况。" : deal.task.label };
}

function manualStageControl(deal, m) {
  const old = m.state.cases[deal.id]?.manualChange;
  return `<details class="board-adjust">
    <summary>调整阶段</summary>
    <form data-board-stage="${deal.id}">
      <label class="sr-only" for="stage-${deal.id}">${escape(deal.title)}的目标阶段</label>
      <select id="stage-${deal.id}" name="stage" required>
        <option value="">选择目标</option>
        ${pipelineStages.filter(({ name }) => name !== m.stageFor(deal)).map(({ name }) => `<option value="${name}">${name}</option>`).join("")}
      </select>
      <button class="button button-small" type="submit">确认调整</button>
    </form>
    ${old ? `<p class="board-guard">上一次人工调整 · ${old.from} → ${old.to}</p>` : ""}
  </details>`;
}

function opportunityDialog() {
  return `<dialog class="board-create-dialog" id="board-create-dialog" aria-labelledby="board-create-title">
    <h2 id="board-create-title">新建商机</h2>
    <p>创建后进入「初步接洽」，并保存在当前演示标签页。</p>
    <form data-board-create>
      <label>商机名称<input name="title" type="text" maxlength="${opportunityNameLimit}" required autofocus></label>
      <label>客户或公司<input name="company" type="text" maxlength="${opportunityNameLimit}" required></label>
      <label>预计金额（元）<input name="amount" type="number" min="0" max="${opportunityAmountLimit}" step="0.01" inputmode="decimal" placeholder="选填"></label>
      <p class="board-create-error" role="alert"></p>
      <div class="board-create-actions">
        <button type="button" class="button" data-action="crm-board-cancel">取消</button>
        <button type="submit" class="button button-primary">创建商机</button>
      </div>
    </form>
  </dialog>`;
}

export function createCrmOpportunity(form, crm) {
  const fields = new FormData(form);
  const opportunity = readOpportunity({
    title: fields.get("title"),
    company: fields.get("company"),
    amount: Number(fields.get("amount")),
    stage: pipelineStages[0].name,
  }, crm.opportunities.length + 1);
  if (!opportunity) {
    form.querySelector("[role=alert]").textContent = "请填写有效的商机名称、客户或公司和金额。";
    return null;
  }
  crm.opportunities.push(opportunity);
  crm.pipelineStage = "all";
  return opportunity;
}

function boardCard(deal, m) {
  const current = m.state.cases[deal.id];
  const guarded = ["pending", "approved", "executed"].includes(current?.proposal);
  return `<article class="crm-board-card" data-board-card="${deal.id}">
    <div class="crm-board-card-top">${current ? m.avatar(deal) : '<span class="case-avatar" aria-hidden="true">商</span>'}
      <div><h3>${escape(deal.title)}</h3><p>${escape(deal.company)}</p></div>
      ${guarded ? "" : '<span class="board-drag" draggable="true" title="拖到其他阶段" aria-hidden="true">⠿</span>'}
    </div>
    <strong>${m.money.format(deal.amount)}</strong>
    <div class="crm-board-card-tags">${current
      ? (riskFor(deal, current) ? m.label("需要跟进", "gold") : m.label("跟进中"))
      : m.label("手动创建")}
      ${deal.meeting ? m.label("有约见依据", "green") : ""}
    </div>
    ${guarded ? '<p class="board-guard">这笔商机有未结案的提案，需先在工作台处理。</p>' : manualStageControl(deal, m)}
    ${current ? `<div class="crm-board-card-actions">${caseLink(deal, "workbench", "查看商机")}${caseLink(deal, "inbox", "客户会话")}</div>` : ""}
  </article>`;
}

function pipeline(m) {
  const crm = getCrm(m);
  const stages = pipelineStages.filter((stage) => crm.pipelineStage === "all" || crm.pipelineStage === stage.id);
  const active = [...crm.opportunities].reverse().concat(m.deals)
    .filter((deal) => stages.some((stage) => m.stageFor(deal) === stage.name));
  return `${m.heading("销售管道", "拖动卡片或手动选择阶段；等待执行和回查的提案由 Agent 工作台处理。",
    buttonAction("crm-board-open", "新建商机", 'aria-haspopup="dialog" aria-controls="board-create-dialog"', "button button-primary"))}
    ${opportunityDialog()}
    <div class="crm-board-toolbar">
      <div><strong>${active.length} 笔商机</strong><span>${m.money.format(active.reduce((amount, deal) => amount + deal.amount, 0))}</span></div>
      <label class="crm-select"><span>筛选阶段</span><select data-crm-control="pipeline-stage">
        ${[["all", "全部阶段"], ...pipelineStages.map(({ id, name }) => [id, name])].map(([id, name]) =>
          `<option value="${id}" ${crm.pipelineStage === id ? "selected" : ""}>${name}</option>`).join("")}
      </select></label>
    </div>
    <p class="board-status" data-board-status tabindex="-1" role="status"></p>
    <div class="crm-board${stages.length === 1 ? " crm-board-filtered" : ""}">
      ${stages.map((stage) => {
        const cases = active.filter((deal) => m.stageFor(deal) === stage.name);
        return `<section class="crm-board-column crm-board-${stage.id}" aria-label="${stage.name}" data-board-drop="${stage.name}">
          <div class="crm-board-heading"><h2>${stage.name}</h2><small>${cases.length} 笔</small></div>
          <p>${stage.note}</p><strong class="crm-stage-amount">${m.money.format(cases.reduce((amount, deal) => amount + deal.amount, 0))}</strong>
          <div class="crm-board-cards">${cases.map((deal) => boardCard(deal, m)).join("") || '<div class="crm-board-empty"><small>暂无商机</small></div>'}</div>
        </section>`;
      }).join("")}
    </div>
    <p class="crm-board-foot">人工批准与执行后的商机阶段会同步显示在看板。</p>`;
}

function directoryItems(m) {
  const crm = getCrm(m);
  const items = m.deals.filter((deal) => matches(deal, crm.directoryQuery, [profile(deal).industry]));
  return items.map((deal) => {
    const selected = deal.id === m.deal.id;
    return `<button type="button" class="crm-contact-row${selected ? " is-selected" : ""}" data-action="crm-select-case"
        data-case="${deal.id}" aria-pressed="${selected}">
      ${m.avatar(deal)}
      <span><strong>${deal.contact}</strong><small>${deal.company} · ${deal.role}</small></span>
      <span class="crm-directory-industry">${profile(deal).industry}</span>
    </button>`;
  }).join("") || '<p class="crm-empty">未匹配到联系人。</p>';
}

function contacts(m) {
  const crm = getCrm(m);
  const { deal, current } = m;
  return `${m.heading("联系人", "查看公司、联系人和当前业务上下文，从档案进入同一条会话或工作台。")}
    <div class="crm-directory">
      <section class="panel crm-directory-list">
        <div class="panel-heading"><h2>联系人目录</h2></div>
        <label class="crm-search"><span class="sr-only">搜索联系人目录</span><input type="search"
          data-crm-control="directory-search" value="${escape(crm.directoryQuery)}" placeholder="联系人、公司或行业" maxlength="80"></label>
        <div data-crm-directory-results>${directoryItems(m)}</div>
      </section>
      <div>
        <section class="panel crm-contact-profile">
          <div class="crm-board-card-top">${m.avatar(deal)}<div><h2>${deal.contact}</h2><p>${deal.company} · ${deal.role}</p></div></div>
          <dl class="crm-summary-fields"><div><dt>业务负责人</dt><dd>${profile(deal).owner}</dd></div>
            <div><dt>沟通渠道</dt><dd>${profile(deal).channel}</dd></div>
            <div><dt>关联活动</dt><dd>${deal.meeting ? deal.meeting.title : "无已完成约见记录"}</dd></div>
            <div><dt>会话状态</dt><dd>${current.closed ? "已结束" : "跟进中"}</dd></div>
          </dl>
          <div class="crm-card-links">${caseLink(deal, "inbox", "查看客户会话", "button button-primary")}
            ${caseLink(deal, "workbench", "打开 Agent 工作台", "button")}</div>
        </section>
        ${contactContext(m, false)}
      </div>
    </div>`;
}

function risk(m) {
  const items = m.deals.filter((deal) => riskFor(deal, m.state.cases[deal.id]))
    .sort((a, b) => profile(b).stageDays - profile(a).stageDays);
  return `${m.heading("风险雷达", "根据商机阶段停留情况和未确认事项，选择需要先处理的客户。")}
    <div class="crm-risk-summary"><div><strong>${items.length}</strong><span>笔需关注商机</span></div>
      <p>当前演示按阶段停留时间排序。每张卡片保留待核对的依据和跟进任务。</p></div>
    <div class="crm-risk-list">${items.map((deal) => {
      const issue = riskFor(deal, m.state.cases[deal.id]);
      return `<article class="panel crm-risk-card">
        <div class="crm-board-card-top">${m.avatar(deal)}<div><h2>${deal.title}</h2><p>${deal.company} · ${deal.contact}</p></div></div>
        <div class="crm-risk-duration">${m.label(`当前阶段停留 ${profile(deal).stageDays} 天`, "gold")}</div>
        <p>${issue.detail}</p>
        <dl class="crm-summary-fields"><div><dt>当前阶段</dt><dd>${m.stageFor(deal)}</dd></div>
          <div><dt>建议跟进</dt><dd>${issue.action}</dd></div></dl>
        <div class="crm-card-links">${caseLink(deal, "inbox", "打开这条会话", "button button-primary button-small")}
          ${caseLink(deal, "workbench", "在工作台核对", "button button-small")}</div>
      </article>`;
    }).join("")}</div>`;
}

function tasks(m) {
  const crm = getCrm(m);
  const awaiting = m.deals.filter((deal) => !m.state.cases[deal.id].taskDone).length;
  const items = m.deals.filter((deal) => crm.taskFilter === "all"
    || Boolean(m.state.cases[deal.id].taskDone) === (crm.taskFilter === "done"))
    .sort((first, second) => Number(second.id === m.deal.id) - Number(first.id === m.deal.id));
  return `${m.heading("跟进任务", "任务保留负责人、到期日、客户与商机入口。完成后可核对对应的记忆候选。")}
    <section class="panel crm-task-panel">
      <div class="crm-task-toolbar"><h2>任务清单 <small>${awaiting} 项待完成</small></h2>
        ${filters(taskFilters, crm.taskFilter, "筛选任务", "crm-task-filter")}</div>
      ${items.map((deal) => {
        const done = m.state.cases[deal.id].taskDone;
        return `<article class="crm-task-row${deal.id === m.deal.id ? " is-current" : ""}">
          <div class="crm-task-dot" aria-hidden="true">${done ? "✓" : ""}</div>
          <div class="crm-task-content"><h3>${deal.task.label}</h3>
            <p>${deal.company} · ${deal.task.owner} · 到期 ${deal.task.due}</p>
            <div class="crm-task-links">${caseLink(deal, "inbox", "相关会话")}${caseLink(deal, "memory", "该客户的记忆")}</div>
          </div>
          <div class="crm-task-status">${m.label(`${profile(deal).priority}优先级`, profile(deal).priority === "高" ? "gold" : "neutral")}
            ${done ? m.label("已完成", "green") : buttonAction("crm-task-complete", "标记完成",
              `data-case="${deal.id}" aria-label="完成任务：${deal.task.label}"`, "button button-small")}</div>
        </article>`;
      }).join("") || '<p class="crm-empty">当前筛选下没有任务。</p>'}
    </section>`;
}

export const crmScreens = { inbox, pipeline, contacts, risk, tasks };

export function handleCrm(action, control, m) {
  if (!action?.startsWith("crm-")) return undefined;
  const crm = getCrm(m);
  const target = m.deals.find(({ id }) => id === (control.dataset.case || m.deal.id));
  if (!target) return undefined;
  const current = m.state.cases[target.id];
  const customer = crm.byCase[target.id];
  const option = control.dataset.filter;
  switch (action) {
    case "crm-board-open": {
      const dialog = document.getElementById("board-create-dialog");
      dialog.querySelector("form").reset();
      dialog.querySelector("[role=alert]").textContent = "";
      dialog.showModal();
      return undefined;
    }
    case "crm-board-cancel":
      control.closest("dialog").close();
      return undefined;
    case "crm-select-case":
      m.state.selected = target.id;
      customer.read = true;
      return `已打开${target.contact}的资料。`;
    case "crm-inbox-filter":
      if (!inboxFilters.some(([id]) => id === option)) return undefined;
      crm.inboxFilter = option;
      return "已更新会话筛选。";
    case "crm-task-filter":
      if (!taskFilters.some(([id]) => id === option)) return undefined;
      crm.taskFilter = option;
      return "已更新任务筛选。";
    case "crm-composer-mode":
      if (current.closed || !["reply", "note"].includes(option)) return undefined;
      customer.mode = option;
      return option === "note" ? "正在编辑内部备注。" : "正在编辑回复草稿。";
    case "crm-handoff":
      if (current.closed) return undefined;
      customer.human = !customer.human;
      customer.read = true;
      return customer.human ? "已切换为人工接管。" : "已恢复智能辅助。";
    case "crm-close":
      if (current.closed) return undefined;
      current.closed = true;
      customer.read = true;
      m.log(target, "closed");
      m.makeCandidate(target, current);
      return "会话已结束，处理结果可在客户记忆中查看。";
    case "crm-save-message": {
      const kind = customer.mode;
      const draft = customer.drafts[kind].trim();
      if (current.closed || !draft) return undefined;
      customer.entries.push({ kind, text: draft.slice(0, messageLimit) });
      customer.entries = customer.entries.slice(-30);
      customer.drafts[kind] = "";
      customer.read = true;
      queueMicrotask(() => {
        const thread = document.querySelector(".crm-messages");
        if (thread) thread.scrollTop = thread.scrollHeight;
      });
      return kind === "note" ? "内部备注已保存在此标签页。" : "演示回复已写入本地会话。";
    }
    case "crm-task-complete":
      if (current.taskDone) return undefined;
      current.taskDone = true;
      m.log(target, "taskDone");
      m.makeCandidate(target, current);
      return "已完成跟进任务，处理结果可在客户记忆中查看。";
    default:
      return undefined;
  }
}

export function handleCrmInput(event, m) {
  const control = event.target;
  const name = control.dataset.crmControl;
  if (!name) return false;
  const crm = getCrm(m);
  if (name === "inbox-search") {
    crm.inboxQuery = control.value.slice(0, 80);
    const { count, markup } = inboxItems(m);
    document.querySelector("[data-crm-inbox-count]").textContent = `${count} 条`;
    document.querySelector("[data-crm-inbox-results]").innerHTML = markup;
    return true;
  }
  if (name === "directory-search") {
    crm.directoryQuery = control.value.slice(0, 80);
    document.querySelector("[data-crm-directory-results]").innerHTML = directoryItems(m);
    return true;
  }
  if (name === "draft") {
    const value = control.value.slice(0, messageLimit);
    const customer = crm.byCase[m.deal.id];
    customer.drafts[customer.mode] = value;
    document.querySelector('[data-action="crm-save-message"]').disabled = !value.trim();
    return true;
  }
  return false;
}

export function handleCrmChange(event, m) {
  const { target } = event;
  const name = target.dataset.crmControl;
  if (name === "template") {
    const selected = availableTemplates(m).find(({ id }) => id === target.value);
    const input = document.querySelector("#crm-draft");
    if (selected && input) {
      const result = addToCrmReplyDraft(m, m.deal.id, selected.text);
      const notice = document.querySelector("[data-crm-template-feedback]");
      notice.hidden = false;
      notice.textContent = result.error || "已插入快捷回复，草稿仍可编辑。";
      if (!result.error) {
        input.value = result.draft;
        handleCrmInput({ target: input }, m);
        input.focus();
      }
    }
    target.value = "";
    return true;
  }
  if (name === "pipeline-stage") {
    const crm = getCrm(m);
    const stage = pipelineStages.find(({ id }) => id === target.value);
    crm.pipelineStage = stage?.id ?? "all";
    return "已更新商机阶段筛选。";
  }
  return false;
}
