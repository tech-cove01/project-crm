import { crmProfiles, crmTemplates } from "./crm-data.js";
import { pipelineStages } from "./data.js";

const inboxFilters = [
  ["all", "全部"],
  ["draft", "AI 草稿"],
  ["unread", "未读"],
  ["human", "人工接管"],
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
const tones = { pine: "blue", water: "teal", gold: "amber", clay: "rose", violet: "purple" };

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
    const draft = typeof prior?.aiDraft === "string" ? prior.aiDraft : (prior?.aiDraft === null ? "" : crmProfiles[id].aiDraft ?? "");
    return [id, {
      human: typeof prior?.human === "boolean" ? prior.human : crmProfiles[id].human,
      read: prior?.read === true,
      mode: prior?.mode === "note" ? "note" : "reply",
      aiDraft: draft.slice(0, messageLimit),
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
  return {
    byCase, opportunities, inboxFilter: "all", inboxQuery: "", directoryQuery: "",
    pipelineStage: "all", taskFilter: "all",
    detailOpen: typeof previous?.detailOpen === "boolean" ? previous.detailOpen : window.innerWidth > 1360,
  };
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

function filters(items, current, name, action, className = "crm-filter") {
  return `<div class="crm-filters" role="group" aria-label="${name}">
    ${items.map(([id, label]) => buttonAction(action, label,
    `data-filter="${id}" aria-pressed="${id === current}"`, className)).join("")}
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

function hasDraft(deal, crm) {
  return Boolean(crm.byCase[deal.id].aiDraft);
}

function avatarFor(deal, size = "md") {
  return `<span class="avatar ${size} tone-${tones[deal.color] ?? "blue"}" aria-hidden="true">${deal.initials}</span>`;
}

function channelIcon(kind) {
  const icon = kind === "mail" ? "i-template" : kind === "chat" ? "i-chat" : "i-users";
  return `<span class="ch-icon ${escape(kind)}" title="${escape(kind)}"><svg class="icon" aria-hidden="true"><use href="#${icon}"></use></svg></span>`;
}

function tagBadge(profileInfo) {
  const tag = profileInfo.tag;
  if (!tag) return "";
  return `<span class="badge ${tag.tone}"><span class="dot"></span>${escape(tag.text)}</span>`;
}

function matchInbox(deal, crm) {
  if (crm.inboxFilter === "unread" && !unreadFor(deal, crm)) return false;
  if (crm.inboxFilter === "draft" && !hasDraft(deal, crm)) return false;
  if (crm.inboxFilter === "human" && !crm.byCase[deal.id].human) return false;
  return matches(deal, crm.inboxQuery, [
    ...initialMessages(deal).map((message) => message.text),
    ...crm.byCase[deal.id].entries.map((message) => message.text),
  ]);
}

function previewText(deal, crm) {
  const entries = crm.byCase[deal.id].entries;
  const last = entries.length ? entries[entries.length - 1] : initialMessages(deal).slice(-1)[0];
  return last?.text ?? deal.message.quote;
}

function convItem(deal, m) {
  const crm = getCrm(m);
  const info = profile(deal);
  const active = m.deal.id === deal.id;
  const unread = unreadFor(deal, crm);
  const draft = hasDraft(deal, crm);
  return `<button type="button" class="conv-item${active ? " is-selected" : ""}${unread ? " is-unread" : ""}"
    data-action="crm-select-case" data-case="${deal.id}" aria-pressed="${active}" aria-label="${escape(deal.contact)} · ${escape(deal.company)}">
    <span class="conv-unread-bar" aria-hidden="true"></span>
    ${avatarFor(deal)}
    <span class="conv-body">
      <span class="conv-top"><span class="conv-name">${escape(deal.contact)}<span class="conv-company">${escape(deal.company)}</span></span>
        <span class="conv-time">${escape(info.at)}</span></span>
      <span class="conv-preview-row"><span class="conv-preview">${escape(previewText(deal, crm))}</span>
        ${unread ? `<span class="unread-count-pill" aria-label="${unread} 条未读">${unread}</span>` : ""}</span>
      <span class="conv-badges">
        ${draft ? '<span class="ai-draft-pill"><svg class="icon" aria-hidden="true"><use href="#i-sparkle"></use></svg>AI 草稿</span>' : ""}
        ${tagBadge(info)}
        ${channelIcon(info.channelKind)}
      </span>
    </span>
  </button>`;
}

function inboxItems(m) {
  const crm = getCrm(m);
  const items = m.deals.filter((deal) => matchInbox(deal, crm));
  const today = items.filter((deal) => profile(deal).day !== "earlier");
  const earlier = items.filter((deal) => profile(deal).day === "earlier");
  const group = (title, list) => list.length
    ? `<div class="conv-group-title">${title}</div>${list.map((deal) => convItem(deal, m)).join("")}`
    : "";
  return {
    count: items.length,
    markup: items.length
      ? `${group("今天", today)}${group("更早", earlier)}`
      : '<p class="crm-empty">没有符合当前筛选的会话。</p>',
  };
}

function counts(m) {
  const crm = getCrm(m);
  return {
    all: m.deals.length,
    draft: m.deals.filter((deal) => hasDraft(deal, crm)).length,
    unread: m.deals.filter((deal) => unreadFor(deal, crm)).length,
    human: m.deals.filter((deal) => crm.byCase[deal.id].human).length,
  };
}

function senderName(message, deal) {
  if (message.kind === "customer") return deal.contact;
  if (message.kind === "reply") return profile(deal).owner;
  return profile(deal).owner;
}

function messageMarkup(message, deal, current) {
  if (message.kind === "activity") {
    return `<div class="handoff-card"><svg class="icon" aria-hidden="true"><use href="#i-info"></use></svg>
      <span>${escape(message.text)}</span><time>${escape(message.time ?? "")}</time></div>`;
  }
  if (message.kind === "note") {
    return `<div class="msg-row note"><div class="msg-bubble">
      <div class="note-head"><svg class="icon" aria-hidden="true"><use href="#i-info"></use></svg>内部备注</div>
      <p>${escape(message.text)}</p></div></div>`;
  }
  const outbound = message.kind !== "customer";
  const ai = outbound && /引用知识库/.test(message.source ?? "");
  const kindLabel = message.kind === "reply"
    ? '<span class="badge purple">本机演示回复</span>'
    : ai ? '<span class="badge purple">AI 生成</span>' : "";
  return `<div class="msg-row ${outbound ? "outbound" : "inbound"}">
    <div class="msg-sender-line"><span class="msg-sender-name">${escape(senderName(message, deal))}</span>${kindLabel}</div>
    <div class="msg-bubble"><p>${escape(message.text)}</p>
      ${message.source ? `<span class="msg-source"><svg class="icon" aria-hidden="true"><use href="#i-layers"></use></svg>${escape(message.source)}</span>` : ""}
      <div class="msg-bubble-foot"><span>${escape(message.time ?? "本地操作")}</span>
        ${outbound ? '<span class="ticks" aria-label="已外发">✓✓</span>' : ""}</div>
    </div>
  </div>`;
}

function memoryNote(deal, current) {
  const fact = deal.message.fact.replace(/[。.]$/, "");
  if (current.memory === "confirmed") {
    return `<div class="msg-row note"><div class="msg-bubble"><div class="note-head">
      <svg class="icon" aria-hidden="true"><use href="#i-shield"></use></svg>系统记忆提示</div>
      <p>已确认的客户偏好：${escape(fact)}。新会话会复用这条记忆，写入前仍需人工确认。</p></div></div>`;
  }
  if (current.memory === "pending") {
    return `<div class="msg-row note"><div class="msg-bubble"><div class="note-head">
      <svg class="icon" aria-hidden="true"><use href="#i-shield"></use></svg>系统记忆提示</div>
      <p>从客户原话提取到一条待审候选：${escape(fact)}。审核通过后才可用于其他会话。</p></div></div>`;
  }
  return "";
}

function composer(customer, current, templates, deal, m) {
  if (current.closed) {
    return `<div class="composer"><div class="crm-closed-note">
      <span>会话已结束，不能继续外发。</span>
      ${caseLink(deal, "memory", "查看本次会话的记忆候选")}</div></div>`;
  }
  const isNote = customer.mode === "note";
  const value = customer.drafts[customer.mode] || (customer.mode === "reply" ? customer.aiDraft : "");
  const hasDraft = customer.mode === "reply" && Boolean(customer.aiDraft);
  return `<div class="composer">
    <div class="composer-unified">
      ${hasDraft ? `<div class="composer-draft-note"><svg class="icon" aria-hidden="true"><use href="#i-sparkle"></use></svg>
        AI 已起草一条回复，可直接编辑后发送；外发前需要人工确认。</div>` : ""}
      <label class="sr-only" for="crm-draft">${isNote ? "内部备注内容" : "回复内容"}</label>
      <textarea id="crm-draft" class="composer-input" data-crm-control="draft" rows="2" maxlength="${messageLimit}"
        placeholder="${isNote ? "写一条内部备注，仅团队可见。" : `回复 ${escape(deal.contact)}…`}">${escape(value)}</textarea>
      <div class="composer-bar">
        <div class="composer-bar-left">
          <span class="composer-user">${avatarFor(deal, "sm")}林序</span>
          <span class="composer-sep" aria-hidden="true">·</span>
          <button type="button" class="composer-pill-toggle" data-action="crm-composer-mode" data-filter="reply"
            aria-pressed="${!isNote}">回复</button>
          <button type="button" class="composer-pill-toggle" data-action="crm-composer-mode" data-filter="note"
            aria-pressed="${isNote}">内部备注</button>
          ${isNote ? "" : `<label class="sr-only" for="crm-template">插入模板</label>
            <select class="select" id="crm-template" data-crm-control="template">
              <option value="">模板…</option>
              ${templates.map(({ id, label }) => `<option value="${escape(id)}">${escape(label)}</option>`).join("")}
            </select>`}
        </div>
        <button type="button" class="btn sm primary" data-action="crm-save-message"
          ${value.trim() ? "" : "disabled"}>
          <svg class="icon" aria-hidden="true"><use href="#i-send"></use></svg>${isNote ? "保存备注" : "发送"}</button>
      </div>
    </div>
  </div>`;
}

function threadHeader(deal, current, customer, m) {
  const info = profile(deal);
  return `<div class="thread-header">
    <div class="entity-cell">${avatarFor(deal)}
      <div><h2>${escape(deal.contact)}</h2>
        <div class="thread-head-meta">
          ${current.closed ? '<span class="badge neutral">已结束</span>'
            : customer.human ? '<span class="badge warning"><span class="dot"></span>人工接管中</span>'
              : '<span class="badge success"><span class="dot"></span>AI 托管中</span>'}
          ${channelIcon(info.channelKind)}
          <span class="xs">${escape(info.channel)} · ${escape(deal.company)}</span>
        </div>
      </div>
    </div>
    <div class="thread-head-actions">
      ${buttonAction("crm-handoff", customer.human ? "恢复 AI 托管" : "转为人工接管",
    current.closed ? "disabled" : "", "thread-icon-btn")}
      ${caseLink(deal, "workbench", '<svg class="icon" aria-hidden="true"><use href="#i-sparkle"></use></svg>工作台诊断', "thread-icon-btn")}
      ${buttonAction("crm-detail-toggle", '<svg class="icon" aria-hidden="true"><use href="#i-panel"></use></svg>详情',
    `aria-pressed="${getCrm(m).detailOpen}"`, "thread-icon-btn is-active")}
    </div>
  </div>`;
}

function funnel(deal, m) {
  const currentStage = m.stageFor(deal);
  const index = Math.max(0, pipelineStages.findIndex(({ name }) => name === currentStage));
  return `<div class="funnel" aria-hidden="true">
      ${pipelineStages.map((stage, position) => `<span class="${position < index ? "is-done" : position === index ? "is-current" : ""}"></span>`).join("")}
    </div><div class="funnel-legend">${escape(currentStage)} · 第 ${index + 1} / ${pipelineStages.length} 阶段</div>`;
}

function memoryCards(deal, current, m) {
  const cards = [];
  if (current.memory === "confirmed") {
    cards.push(`<div class="mem-card"><p>${escape(deal.message.fact)}</p>
      <div class="mem-card-foot"><span class="badge success"><span class="dot"></span>已确认</span>
        ${buttonAction("withdraw", "撤回", `data-case="${deal.id}"`, "btn xs ghost")}</div></div>`);
  }
  if (current.memory === "pending") {
    cards.push(`<div class="mem-card"><p>${escape(deal.message.fact)}</p>
      <div class="mem-card-foot"><span class="badge warning"><span class="dot"></span>待审核</span>
        ${buttonAction("dismiss", "忽略", `data-case="${deal.id}"`, "btn xs ghost")}
        ${buttonAction("remember", "确认", `data-case="${deal.id}"`, "btn xs primary")}</div></div>`);
  }
  if (current.memory === "withdrawn") {
    cards.push(`<div class="mem-card"><p>${escape(deal.message.fact)}</p>
      <div class="mem-card-foot"><span class="badge neutral">已撤回</span></div></div>`);
  }
  return cards.length ? cards.join("") : `<div class="mem-card"><p>客户原话：${escape(deal.message.quote)}</p>
      <div class="mem-card-foot"><span class="badge neutral">原文</span>
        ${caseLink(deal, "memory", "去提取偏好", "btn xs ghost")}</div></div>
      <p class="mem-empty">偏好要经人工确认才会写入记忆，不会自动对外使用。</p>`;
}

function detailPanel(deal, current, customer, m) {
  const info = profile(deal);
  const memoryCount = ["pending", "confirmed"].includes(current.memory) ? 1 : 0;
  return `<aside class="inbox-crm-col" aria-label="客户详情">
    <div class="details-top-bar"><span>客户详情</span>
      ${buttonAction("crm-detail-toggle", '<svg class="icon" aria-hidden="true"><use href="#i-close"></use></svg>',
    'aria-label="收起客户详情"', "btn icon sm")}</div>
    <section class="details-section">
      <div class="details-entity">
        ${avatarFor(deal, "lg")}
        <h3>${escape(deal.contact)}</h3>
        <div class="role">${escape(deal.role)}</div>
        <div class="company"><svg class="icon" aria-hidden="true"><use href="#i-users"></use></svg>${escape(deal.company)}</div>
        <div class="details-actions">
          ${caseLink(deal, "contacts", "查看客户 360° 档案", "btn sm")}
          ${buttonAction("crm-handoff", customer.human ? "恢复 AI 托管" : "转人工接管",
    current.closed ? "disabled" : "", "btn sm")}
        </div>
      </div>
    </section>
    <section class="details-section">
      <div class="panel-section-title"><h4>CRM 与商机状态</h4>
        <span class="badge ${current.closed ? "neutral" : customer.human ? "warning" : "success"}">${current.closed ? "已结束" : customer.human ? "需人工接管" : "AI 托管"}</span></div>
      <div class="kv-grid">
        <span class="kv-label">关联商机</span><span class="kv-val">${escape(deal.title)}</span>
        <span class="kv-label">关联金额</span><span class="kv-val tabular">${m.money.format(deal.amount)}</span>
        <span class="kv-label">漏斗阶段</span><span class="kv-val">${funnel(deal, m)}</span>
        <span class="kv-label">渠道归属</span><span class="kv-val">${escape(info.channel)} · ${escape(info.owner)}</span>
        <span class="kv-label">托管模式</span><span class="kv-val"><span class="dot ${customer.human ? "" : "ok"}"></span>${customer.human ? "人工接管中" : "AI 托管中"}</span>
      </div>
    </section>
    <section class="details-section">
      <div class="panel-section-title"><h4>客户记忆闭环 (${memoryCount})</h4><span class="badge neutral">全部</span></div>
      <div class="mem-list">${memoryCards(deal, current, m)}</div>
    </section>
    <section class="details-section">
      <div class="panel-section-title"><h4>联系方式</h4></div>
      <div class="contact-row"><span>电话</span><strong>${escape(info.phone)}</strong></div>
      <div class="contact-row"><span>邮箱</span><strong>${escape(info.email)}</strong></div>
      ${caseLink(deal, "tasks", "＋ 为该客户创建跟进任务", "btn sm details-cta")}
    </section>
  </aside>`;
}

function inbox(m) {
  const crm = getCrm(m);
  const { deal, current } = m;
  const selected = crm.byCase[deal.id];
  const items = inboxItems(m);
  const nums = counts(m);
  return `<div class="inbox-shell">
    <div class="page-header">
      <div><h1 class="page-title">会话收件箱</h1>
        <p class="page-desc">全渠道客户会话归并一处，AI 起草回复，人工确认后才外发。</p></div>
      <div class="page-actions">
        <span class="xs"><span class="kbd">J</span><span class="kbd">K</span>切换会话</span>
        <a class="btn sm" href="#approvals">待拍板队列${nums.draft ? ` · ${nums.draft}` : ""}</a>
      </div>
    </div>
    <div class="inbox-layout${crm.detailOpen ? "" : " is-detail-off"}">
      <div class="inbox-list-col">
        <div class="inbox-list-head">
          <label class="input-search-wrap"><svg class="icon" aria-hidden="true"><use href="#i-search"></use></svg>
            <span class="sr-only">搜索联系人、企业或消息</span>
            <input class="input" type="search" data-crm-control="inbox-search" value="${escape(crm.inboxQuery)}"
              placeholder="搜索联系人、企业或消息…" maxlength="80"></label>
          <div class="inbox-tabs" role="group" aria-label="筛选会话">
            ${inboxFilters.map(([id, label]) => `<button type="button" class="inbox-tab"
              data-action="crm-inbox-filter" data-filter="${id}" aria-pressed="${crm.inboxFilter === id}">${label}
              <span class="tab-count">${nums[id]}</span></button>`).join("")}
          </div>
        </div>
        <div class="conv-scroll" data-crm-inbox-results>${items.markup}</div>
        <div class="inbox-list-foot"><span data-crm-inbox-count>共 ${items.count} 个会话</span>
          <span class="guard"><svg class="icon" aria-hidden="true"><use href="#i-shield"></use></svg>外发审批护栏已开启</span></div>
      </div>
      <div class="inbox-thread-col">
        ${threadHeader(deal, current, selected, m)}
        <div class="thread-messages" aria-label="${escape(deal.contact)}的对话">
          <div class="chat-day-divider">对话记录</div>
          ${[...initialMessages(deal), ...selected.entries].map((message) => messageMarkup(message, deal, current)).join("")}
          ${memoryNote(deal, current)}
        </div>
        ${composer(selected, current, availableTemplates(m), deal, m)}
      </div>
      ${detailPanel(deal, current, selected, m)}
    </div>
  </div>`;
}

function approvals(m) {
  const crm = getCrm(m);
  const pending = m.deals.filter((deal) => hasDraft(deal, crm));
  return `${m.heading("待人工拍板", "AI 已起草的回复集中在这里，批准后才会外发；退回后草稿作废。",
    `<a class="btn sm" href="#inbox">回到收件箱</a>`)}
    ${pending.length ? `<div class="approval-list">${pending.map((deal) => {
    const customer = crm.byCase[deal.id];
    const info = profile(deal);
    return `<article class="approval-card">
        <div class="approval-card-top">${avatarFor(deal)}
          <div><h3>${escape(deal.contact)} · ${escape(deal.company)}</h3>
            <div class="meta">${escape(info.channel)} · ${escape(deal.title)} · 意向 ${escape(info.priority)}</div></div>
          <span class="badge info"><span class="dot"></span>AI 草稿待拍板</span></div>
        <div class="approval-draft">${escape(customer.drafts.reply || customer.aiDraft)}</div>
        <div class="approval-actions">
          ${buttonAction("crm-draft-discard", "退回重写", `data-case="${deal.id}"`, "btn sm")}
          ${buttonAction("crm-draft-approve", "批准并发送", `data-case="${deal.id}"`, "btn sm primary")}
        </div>
      </article>`;
  }).join("")}</div>`
    : '<p class="approval-empty">当前没有等待拍板的草稿。断点会随会话状态自动回到这里。</p>'}`;
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
    <div class="crm-board-card-value"><strong>${m.money.format(deal.amount)}</strong>
      <div class="crm-board-card-tags">${current
        ? (riskFor(deal, current) ? m.label("需要跟进", "gold") : m.label("跟进中"))
        : m.label("手动创建")}
        ${deal.meeting ? m.label("有约见依据", "green") : ""}
      </div>
    </div>
    <div class="crm-board-card-footer">
      ${current ? `<div class="crm-board-card-actions">${caseLink(deal, "workbench", "查看商机")}${caseLink(deal, "inbox", "客户会话")}</div>` : ""}
      ${guarded ? '<p class="board-guard">这笔商机有未结案的提案，需先在工作台处理。</p>' : manualStageControl(deal, m)}
    </div>
  </article>`;
}

function pipeline(m) {
  const crm = getCrm(m);
  const stages = pipelineStages.filter((stage) => crm.pipelineStage === "all" || crm.pipelineStage === stage.id);
  const active = [...crm.opportunities].reverse().concat(m.deals)
    .filter((deal) => stages.some((stage) => m.stageFor(deal) === stage.name));
  return `${m.heading("销售漏斗", "拖动卡片右侧把手，或用「调整阶段」。",
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
          <div class="crm-board-heading"><div><h2>${stage.name}</h2><small>${cases.length} 笔</small></div>
            <strong class="crm-stage-amount">${m.money.format(cases.reduce((amount, deal) => amount + deal.amount, 0))}</strong>
          </div>
          <div class="crm-board-cards">${cases.map((deal) => boardCard(deal, m)).join("") || '<div class="crm-board-empty"><small>暂无商机</small></div>'}</div>
        </section>`;
      }).join("")}
    </div>`;
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
  return `${m.heading("客户与线索", "查看公司、联系人和当前业务上下文，从档案进入同一条会话或工作台。")}
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
            <div><dt>联系电话</dt><dd>${profile(deal).phone}</dd></div>
            <div><dt>联系邮箱</dt><dd>${profile(deal).email}</dd></div>
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
      ${caseLink(deal, "pipeline", "查看销售漏斗")}
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

function risk(m) {
  const items = m.deals.filter((deal) => riskFor(deal, m.state.cases[deal.id]))
    .sort((a, b) => profile(b).stageDays - profile(a).stageDays);
  return `${m.heading("停滞风险雷达", "根据商机阶段停留情况和未确认事项，选择需要先处理的客户。")}
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

export const crmScreens = { inbox, approvals, pipeline, contacts, risk, tasks };

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
      return `已打开${target.contact}的会话。`;
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
    case "crm-detail-toggle":
      crm.detailOpen = !crm.detailOpen;
      return crm.detailOpen ? "已展开客户详情。" : "已收起客户详情。";
    case "crm-handoff":
      if (current.closed) return undefined;
      customer.human = !customer.human;
      customer.read = true;
      return customer.human ? "已切换为人工接管，AI 自动外发暂停。" : "已恢复 AI 托管，外发仍需人工确认。";
    case "crm-close":
      if (current.closed) return undefined;
      current.closed = true;
      customer.read = true;
      m.log(target, "closed");
      m.makeCandidate(target, current);
      return "会话已结束，处理结果可在客户记忆中查看。";
    case "crm-save-message": {
      const kind = customer.mode;
      const text = (customer.drafts[kind] || (kind === "reply" ? customer.aiDraft : "")).trim();
      if (current.closed || !text) return undefined;
      customer.entries.push({ kind, text: text.slice(0, messageLimit) });
      customer.entries = customer.entries.slice(-30);
      customer.drafts[kind] = "";
      if (kind === "reply") customer.aiDraft = "";
      customer.read = true;
      queueMicrotask(() => {
        const thread = document.querySelector(".thread-messages");
        if (thread) thread.scrollTop = thread.scrollHeight;
      });
      return kind === "note" ? "内部备注已保存在此标签页。" : "演示回复已写入本地会话。";
    }
    case "crm-draft-approve": {
      const text = (customer.drafts.reply || customer.aiDraft).trim();
      if (!text) return undefined;
      customer.entries.push({ kind: "reply", text: text.slice(0, messageLimit) });
      customer.entries = customer.entries.slice(-30);
      customer.aiDraft = "";
      customer.drafts.reply = "";
      customer.human = false;
      customer.read = true;
      return `已批准并向${target.contact}外发演示回复。`;
    }
    case "crm-draft-discard":
      customer.aiDraft = "";
      customer.drafts.reply = "";
      customer.human = true;
      return "草稿已退回，会话保持人工接管。";
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
    const label = document.querySelector("[data-crm-inbox-count]");
    if (label) label.textContent = `共 ${count} 个会话`;
    const results = document.querySelector("[data-crm-inbox-results]");
    if (results) results.innerHTML = markup;
    return true;
  }
  if (name === "directory-search") {
    crm.directoryQuery = control.value.slice(0, 80);
    const results = document.querySelector("[data-crm-directory-results]");
    if (results) results.innerHTML = directoryItems(m);
    return true;
  }
  if (name === "draft") {
    const value = control.value.slice(0, messageLimit);
    const customer = crm.byCase[m.deal.id];
    customer.drafts[customer.mode] = value;
    const send = document.querySelector('[data-action="crm-save-message"]');
    if (send) send.disabled = !value.trim();
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
      addToCrmReplyDraft(m, m.deal.id, selected.text);
      const customer = getCrm(m).byCase[m.deal.id];
      input.value = customer.drafts.reply;
      customer.mode = "reply";
      customer.aiDraft = "";
      handleCrmInput({ target: input }, m);
      input.focus();
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
