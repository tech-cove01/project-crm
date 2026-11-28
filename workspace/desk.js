import { deals } from "./data.js";
import { crmProfiles, crmTemplates } from "./crm-data.js";
import { addToCrmReplyDraft } from "./crm.js";

const byId = Object.fromEntries(deals.map((deal) => [deal.id, deal]));
const statusLabels = {
  scheduled: ["已预约", "gold"],
  completed: ["已完成", "green"],
  cancelled: ["已取消", "neutral"],
};
const channels = ["线上会议", "电话回访", "现场沟通"];
const planned = [
  { id: "slot-1", caseId: "bridge", title: "核对试点线路与车辆清单", date: "2026-08-25", time: "02:30", channel: "线上会议", status: "scheduled" },
  { id: "slot-2", caseId: "gallery", title: "确认展馆维护窗口", date: "2026-08-26", time: "06:00", channel: "电话回访", status: "scheduled" },
];
const fixedActivities = deals.flatMap(({ id, meeting }) => {
  if (!meeting) return [];
  const [date, time] = meeting.date.split(" ");
  return [{ id: meeting.id, caseId: id, title: meeting.title, date, time, channel: "技术访谈", status: "completed", fixed: true }];
});
const htmlEscapes = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escape = (text) => String(text).replace(/[&<>"']/g, (character) => htmlEscapes[character]);
const limited = (value, limit) => typeof value === "string" ? value.trim().slice(0, limit) : "";
const isDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const isTime = (value) => typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
const formatDay = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long", timeZone: "UTC" });

function sanitizedList(value, defaults, limit, readItem) {
  if (!Array.isArray(value)) return defaults.map((item) => ({ ...item }));
  const results = new Map();
  for (const item of value.slice(0, limit)) {
    const entry = readItem(item);
    if (entry) results.set(entry.id, entry);
  }
  return [...results.values()];
}

export function readDeskState(previous) {
  return {
    theme: previous?.theme === "night" ? "night" : "light",
    appointments: sanitizedList(previous?.appointments, planned, 40, (item) => {
      if (!item || !/^slot-\d{1,3}$/.test(item.id) || !Object.hasOwn(byId, item.caseId)
          || !isDate(item.date) || !isTime(item.time) || !Object.hasOwn(statusLabels, item.status)) return null;
      const title = limited(item.title, 64);
      if (!title || !channels.includes(item.channel)) return null;
      return { id: item.id, caseId: item.caseId, title, date: item.date, time: item.time, channel: item.channel, status: item.status };
    }),
    templates: sanitizedList(previous?.templates, crmTemplates, 30, (item) => {
      if (!item || !/^[a-z][a-z\d-]{0,15}$/.test(item.id)) return null;
      const label = limited(item.label, 30);
      const text = limited(item.text, 300);
      return label && text ? { id: item.id, label, text } : null;
    }),
    day: isDate(previous?.day) ? previous.day : "",
    status: Object.hasOwn(statusLabels, previous?.status) ? previous.status : "all",
    analyticsCase: Object.hasOwn(byId, previous?.analyticsCase) ? previous.analyticsCase : "all",
    booking: null,
    editor: null,
    deleting: null,
    notice: "",
  };
}

function getDesk(m) {
  m.state.desk ??= readDeskState();
  return m.state.desk;
}

function selectOptions(values, selected, nameOf) {
  return values.map((value) => `<option value="${escape(value)}"${value === selected ? " selected" : ""}>${escape(nameOf(value))}</option>`).join("");
}

function caseOptions(selected) {
  return selectOptions(Object.keys(byId), selected, (id) => `${byId[id].company} · ${byId[id].contact}`);
}

function deskButton(action, text, id, classes = "") {
  return `<button class="button button-small ${classes}" type="button" data-action="${action}"${id ? ` data-desk-id="${id}"` : ""}>${text}</button>`;
}

function contactLink(id, text = "") {
  return `<a href="#contacts" data-select="${id}">${text || escape(byId[id].contact)}</a>`;
}

function notice(desk) {
  return desk.notice ? `<p class="desk-notice" role="status">${escape(desk.notice)}</p>` : "";
}

function focusForm(kind) {
  queueMicrotask(() => document.querySelector(`[data-desk-form="${kind}"] input`)?.focus({ preventScroll: true }));
}

function appointmentForm(booking, desk) {
  return `<section class="desk-panel desk-editor" aria-labelledby="desk-book-title">
    <div class="desk-panel-header"><h2 id="desk-book-title">新增预约</h2></div>
    <form data-desk-form="appointment">
      <div class="desk-form-grid">
        <label class="desk-span">主题<input name="title" required maxlength="64" value="${escape(booking.title)}" placeholder="例如：核对技术方案"></label>
        <label class="desk-span">关联客户<select name="case" aria-label="关联客户">${caseOptions(booking.caseId)}</select></label>
        <label>日期（UTC）<input type="date" name="date" required value="${booking.date}"></label>
        <label>时间（UTC）<input type="time" name="time" required value="${booking.time}"></label>
        <label class="desk-span">沟通方式<select name="channel" aria-label="沟通方式">${selectOptions(channels, booking.channel, (channel) => channel)}</select></label>
      </div>
      ${notice(desk)}
      <div class="desk-actions"><button class="button button-primary" type="submit">保存预约</button>${deskButton("desk-book-close", "取消")}</div>
    </form>
  </section>`;
}

function agenda(dealModel) {
  const m = dealModel;
  const desk = getDesk(m);
  const appointments = [...fixedActivities, ...desk.appointments].sort((first, second) =>
    `${first.date}T${first.time}`.localeCompare(`${second.date}T${second.time}`));
  const active = appointments.filter((item) => (!desk.day || item.date === desk.day)
    && (desk.status === "all" || item.status === desk.status));
  const days = new Map();
  for (const item of active) {
    if (!days.has(item.date)) days.set(item.date, []);
    days.get(item.date).push(item);
  }
  const scope = `<div class="desk-toolbar">
    <label>日期 <input type="date" data-desk-control="day" value="${desk.day}"></label>
    <label>状态 <select data-desk-control="status" aria-label="预约状态">${selectOptions(["all", ...Object.keys(statusLabels)], desk.status, (status) =>
      statusLabels[status]?.[0] || "全部状态")}</select></label>
    ${desk.day || desk.status !== "all" ? deskButton("desk-agenda-reset", "清除筛选") : ""}
    <span class="desk-count">${active.length} 项</span>
  </div>`;
  return `${m.heading("日程预约", "把访谈、回访和下一次沟通排在同一份客户日程中。", m.button("desk-book-open", "新增预约", "button-primary"))}
    <div class="desk-layout${desk.booking ? " desk-layout-edit" : ""}">
      <section class="desk-panel" aria-label="预约列表">
        ${scope}${desk.booking ? "" : notice(desk)}
        ${days.size ? [...days].map(([day, items]) => `<section class="desk-day">
          <h2><time datetime="${day}">${formatDay.format(new Date(day + "T00:00:00Z"))}</time></h2>
          ${items.map((item) => {
            const [name, tone] = statusLabels[item.status];
            return `<article class="desk-entry" aria-label="${escape(item.title)}">
              <time class="desk-time" datetime="${item.date}T${item.time}Z">${item.time}<small>UTC</small></time>
              <div class="desk-entry-main">
                <h3>${escape(item.title)}</h3>
                <div class="desk-meta">${contactLink(item.caseId, escape(byId[item.caseId].company))}<span>${escape(item.channel)}</span>
                  ${item.fixed ? `<span class="desk-key">${escape(item.id)}</span>` : ""}</div>
              </div>
              <div class="desk-entry-side">${m.label(name, tone)}
                ${item.status === "scheduled" ? `<div class="desk-actions">${deskButton("desk-book-complete", "标记完成", item.id)}${deskButton("desk-book-cancel", "取消预约", item.id)}</div>`
                  : `<a href="#inbox" data-select="${item.caseId}" class="table-link">查看会话</a>`}
              </div>
            </article>`;
          }).join("")}
        </section>`).join("") : '<p class="desk-empty">当前筛选下没有预约。</p>'}
      </section>
      ${desk.booking ? appointmentForm(desk.booking, desk) : ""}
    </div>
    <p class="desk-footnote">新增预约和状态保存在演示标签页内。活动 ACT-1121 是 Agent 案例使用的固定取证记录。</p>`;
}

function templateForm(editor, desk) {
  return `<section class="desk-panel desk-editor" aria-labelledby="desk-template-title">
    <div class="desk-panel-header"><h2 id="desk-template-title">${editor.id ? "编辑模板" : "新增模板"}</h2></div>
    <form data-desk-form="reply">
      <div class="desk-form-grid">
        <label class="desk-span">模板名称<input name="label" maxlength="30" required value="${escape(editor.label)}"></label>
        <label class="desk-span">模板正文<textarea name="text" rows="6" maxlength="300" required>${escape(editor.text)}</textarea></label>
      </div>
      ${notice(desk)}
      <div class="desk-actions"><button type="submit" class="button button-primary">保存模板</button>${deskButton("desk-reply-close", "取消")}</div>
    </form>
  </section>`;
}

function replies(m) {
  const desk = getDesk(m);
  return `${m.heading("快捷回复", "整理常用说法，选定客户后插入会话草稿。", m.button("desk-reply-new", "新增模板", "button-primary"))}
    <div class="desk-layout${desk.editor ? " desk-layout-edit" : ""}">
      <section class="desk-panel" aria-label="模板库">
        <div class="desk-toolbar">
          <label>目标客户 <select data-control="selected" aria-label="快捷回复目标客户">${caseOptions(m.deal.id)}</select></label>
          <span class="desk-count">${desk.templates.length} 条模板</span>
          ${m.current.closed ? '<span class="desk-target-warning">该会话已结束，请另选客户插入草稿。</span>' : ""}
        </div>
        ${desk.editor ? "" : notice(desk)}
        ${desk.templates.length ? `<div class="desk-template-grid">${desk.templates.map((template) => `<article class="desk-template" aria-label="${escape(template.label)}">
          <h2>${escape(template.label)}</h2>
          <p>${escape(template.text)}</p>
          ${desk.deleting === template.id ? `<div class="desk-delete"><p>将从模板库移除，已有会话草稿继续保留。</p>
            <div class="desk-actions">${deskButton("desk-reply-delete-confirm", "确认删除", template.id)}${deskButton("desk-reply-delete-cancel", "取消删除")}</div></div>`
            : `<div class="desk-actions">
              <button class="button button-small button-primary" type="button" data-action="desk-reply-use" data-desk-id="${template.id}"${m.current.closed ? " disabled" : ""}>插入草稿</button>
              ${deskButton("desk-reply-edit", "编辑", template.id)}
              ${deskButton("desk-reply-delete", "删除", template.id)}
            </div>`}
        </article>`).join("")}</div>` : '<p class="desk-empty">模板库为空，可新增一条常用回复。</p>'}
      </section>
      ${desk.editor ? templateForm(desk.editor, desk) : ""}
    </div>`;
}

function metric(title, value, hint) {
  return `<div class="desk-metric"><span>${title}</span><strong>${value}</strong><small>${hint}</small></div>`;
}

function analytics(m) {
  const desk = getDesk(m);
  const scope = desk.analyticsCase === "all" ? m.deals : m.deals.filter(({ id }) => id === desk.analyticsCase);
  const scopeIds = new Set(scope.map(({ id }) => id));
  const scopeTasks = scope.filter(({ id }) => m.state.cases[id].taskDone).length;
  const approved = scope.filter(({ id }) => ["executed", "verified"].includes(m.state.cases[id].proposal)).length;
  const runs = (m.state.agent?.runs ?? []).filter(({ caseId }) => scopeIds.has(caseId));
  const appointments = [...fixedActivities, ...desk.appointments].filter(({ caseId }) => scopeIds.has(caseId));
  const grouped = new Map();
  for (const deal of scope) {
    const name = m.stageFor(deal);
    grouped.set(name, (grouped.get(name) || 0) + 1);
  }
  return `${m.heading("工作区指标", "从当前标签页的商机、审批、任务和日程重新汇总。")}
    <div class="desk-toolbar desk-analytics-toolbar"><label>统计范围 <select data-desk-control="analytics">${selectOptions(["all", ...Object.keys(byId)], desk.analyticsCase,
      (id) => id === "all" ? "全部客户" : byId[id].company)}</select></label></div>
    <div class="desk-metrics">
      ${metric("商机总额", m.money.format(scope.reduce((sum, deal) => sum + deal.amount, 0)), `${scope.length} 笔商机`)}
      ${metric("已执行阶段变更", approved, "获批且已执行的商机")}
      ${metric("已完成任务", `${scopeTasks} / ${scope.length}`, "完成数 / 当前范围内任务")}
      ${metric("Agent 运行", runs.length, "当前标签页创建的演示运行")}
    </div>
    <div class="desk-layout desk-analytics-layout">
      <section class="desk-panel"><div class="desk-panel-header"><h2>商机阶段分布</h2></div>
        <ul class="desk-chart">${[...grouped].map(([name, count]) => `<li>
          <div><span>${escape(name)}</span><strong>${count} 笔</strong></div>
          <progress value="${count}" max="${scope.length}">${count}/${scope.length}</progress>
        </li>`).join("")}</ul>
      </section>
      <section class="desk-panel"><div class="desk-panel-header"><h2>会话与预约</h2></div>
        <dl class="desk-data-list">
          <div><dt>人工接管且会话未结束</dt><dd>${scope.filter(({ id }) => !m.state.cases[id].closed && (m.state.crm?.byCase[id]?.human ?? crmProfiles[id].human)).length}</dd></div>
          <div><dt>已记录的本地回复和备注</dt><dd>${scope.reduce((sum, { id }) => sum + (m.state.crm?.byCase[id]?.entries.length || 0), 0)}</dd></div>
          <div><dt>已完成预约 / 预约总量</dt><dd>${appointments.filter(({ status }) => status === "completed").length} / ${appointments.length}</dd></div>
          <div><dt>客户待审记忆</dt><dd>${scope.filter(({ id }) => m.state.cases[id].memory === "pending").length}</dd></div>
        </dl>
      </section>
    </div>`;
}

function settings(m) {
  const desk = getDesk(m);
  const night = desk.theme === "night";
  return `${m.heading("工作区设置", "设置当前标签页的外观，或恢复最初的演示案例。")}
    <section class="desk-panel desk-settings" aria-label="演示设置">
      <div class="desk-setting"><div><h2>界面主题</h2><p>当前使用${night ? "深色" : "浅色"}界面。主题随当前演示标签页保留。</p></div>
        ${deskButton("desk-theme", night ? "切换为浅色" : "切换为深色")}</div>
      <div class="desk-setting"><div><h2>恢复初始数据</h2><p>清除当前标签页的预约、模板、审批和运行记录，重新体验固定案例。</p></div>
        ${m.button("reset", "恢复初始数据")}</div>
    </section>`;
}

export const deskScreens = { agenda, replies, analytics, settings };

export function handleDesk(action, control, m) {
  if (!action?.startsWith("desk-")) return undefined;
  const desk = getDesk(m);
  const id = control.dataset.deskId;
  desk.notice = "";
  switch (action) {
    case "desk-book-open":
      desk.booking ??= { title: "", caseId: m.deal.id, date: desk.day || "2026-08-27", time: "09:00", channel: channels[0] };
      focusForm("appointment");
      return "已打开预约表单。";
    case "desk-book-close":
      desk.booking = null;
      return "已关闭预约表单。";
    case "desk-book-complete":
    case "desk-book-cancel": {
      const appointment = desk.appointments.find((item) => item.id === id);
      if (appointment?.status !== "scheduled") return undefined;
      appointment.status = action === "desk-book-complete" ? "completed" : "cancelled";
      desk.notice = `「${appointment.title}」${statusLabels[appointment.status][0]}。`;
      return desk.notice;
    }
    case "desk-agenda-reset":
      desk.status = "all";
      desk.day = "";
      return "已清除筛选。";
    case "desk-reply-new":
      desk.editor = { id: "", label: "", text: "" };
      desk.deleting = null;
      focusForm("reply");
      return "已打开新模板表单。";
    case "desk-reply-edit": {
      const template = desk.templates.find((item) => item.id === id);
      if (!template) return undefined;
      desk.editor = { ...template };
      desk.deleting = null;
      focusForm("reply");
      return "已打开模板编辑。";
    }
    case "desk-reply-close":
      desk.editor = null;
      return "已结束模板编辑。";
    case "desk-reply-delete":
      if (!desk.templates.some((item) => item.id === id)) return undefined;
      desk.deleting = id;
      desk.editor = null;
      return "请确认是否移除该模板。";
    case "desk-reply-delete-cancel":
      desk.deleting = null;
      return "已取消删除。";
    case "desk-reply-delete-confirm":
      if (!desk.deleting || desk.deleting !== id) return undefined;
      desk.templates = desk.templates.filter((item) => item.id !== id);
      desk.deleting = null;
      desk.notice = "模板已移除。";
      return desk.notice;
    case "desk-reply-use": {
      const template = desk.templates.find((item) => item.id === id);
      if (!template) return undefined;
      const result = addToCrmReplyDraft(m, m.deal.id, template.text);
      if (result.error) {
        desk.notice = result.error;
        return desk.notice;
      }
      const crm = m.state.crm;
      crm.inboxFilter = "all";
      crm.inboxQuery = "";
      location.hash = "inbox";
      return `已将「${template.label}」插入${m.deal.contact}的回复草稿。`;
    }
    case "desk-theme":
      desk.theme = desk.theme === "night" ? "light" : "night";
      return `已切换为${desk.theme === "night" ? "深色" : "浅色"}界面。`;
    default:
      return undefined;
  }
}

export function handleDeskChange(event, m) {
  const { deskControl } = event.target.dataset;
  const { value } = event.target;
  const desk = getDesk(m);
  if (deskControl === "day") {
    desk.day = isDate(value) ? value : "";
    return "已按日期更新预约。";
  }
  if (deskControl === "status") {
    desk.status = Object.hasOwn(statusLabels, value) ? value : "all";
    return "已按状态更新预约。";
  }
  if (deskControl === "analytics") {
    desk.analyticsCase = Object.hasOwn(byId, value) ? value : "all";
    return "已更新统计范围。";
  }
  return undefined;
}

function nextId(entries, prefix) {
  const used = new Set(entries.map(({ id }) => id));
  let counter = 1;
  while (used.has(`${prefix}-${counter}`)) counter++;
  return `${prefix}-${counter}`;
}

function storeBooking(desk, values) {
  if (!desk.booking) return "";
  const caseId = values.get("case");
  const date = values.get("date");
  const time = values.get("time");
  const channel = values.get("channel");
  const title = limited(values.get("title"), 64);
  if (!title || !Object.hasOwn(byId, caseId) || !isDate(date) || !isTime(time) || !channels.includes(channel))
    return "请填写有效主题、关联客户、日期和时间。";
  desk.booking = { caseId, date, time, channel, title };
  if (desk.appointments.length >= 40) return "当前演示最多保存 40 项预约。";
  if (desk.appointments.some((item) => item.status === "scheduled" && item.caseId === caseId && item.date === date && item.time === time))
    return "该客户在同一时间已有预约，请选择其他时段。";
  desk.appointments.push({ ...desk.booking, id: nextId(desk.appointments, "slot"), status: "scheduled" });
  desk.day = date;
  desk.status = "all";
  desk.booking = null;
  return "预约已保存，已显示对应日期。";
}

function storeTemplate(desk, values) {
  if (!desk.editor) return "";
  const id = desk.editor.id;
  const label = limited(values.get("label"), 30);
  const text = limited(values.get("text"), 300);
  desk.editor = { id, label, text };
  if (!label || !text) return "请填写模板名称和正文。";
  if (desk.templates.some((item) => item.id !== id && item.label === label)) return "模板名称已存在，请换个名称。";
  if (!id && desk.templates.length >= 30) return "当前演示最多保存 30 条模板。";
  const original = desk.templates.find((item) => item.id === id);
  if (original) Object.assign(original, { label, text });
  else desk.templates.push({ id: nextId(desk.templates, "reply"), label, text });
  desk.editor = null;
  desk.deleting = null;
  return "模板已保存，可在收件箱中选择。";
}

export function handleDeskSubmit(event, m) {
  const kind = event.target.dataset.deskForm;
  if (kind !== "appointment" && kind !== "reply") return undefined;
  event.preventDefault();
  const desk = getDesk(m);
  const values = new FormData(event.target);
  desk.notice = kind === "appointment" ? storeBooking(desk, values) : storeTemplate(desk, values);
  if (kind === "appointment" ? desk.booking : desk.editor) focusForm(kind);
  return desk.notice;
}
