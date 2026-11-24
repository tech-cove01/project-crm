import { deals, events, pipelineStages } from "./data.js";
import { proposalActions, proposalCopy, proposalInfo, publicEvidence, taskOptions, taskWindow } from "./agent-data.js";

const subjects = Object.fromEntries(deals.map((deal) => [deal.id, deal]));
const knownSourceIds = new Set(deals.flatMap(({ meeting, message }) => meeting ? [meeting.id, message.id] : [message.id]));
const modes = { controlled: "受控行动", read: "只读调查" };
const writableStage = "初步接洽";
const resultingStage = "技术评估";
const stageOptions = new Set(pipelineStages.map(({ name }) => name));
const own = Object.hasOwn;

export function readAgentState(previous) {
  const next = {
    preset: own(taskOptions, previous?.preset) ? previous.preset : "ontology",
    mode: own(modes, previous?.mode) ? previous.mode : "controlled",
    historyFilter: ["all", "review", "done"].includes(previous?.historyFilter) ? previous.historyFilter : "all",
    historyId: Number.isSafeInteger(previous?.historyId) ? previous.historyId : null,
    inspection: {},
    runs: [],
    draft: typeof previous?.draft === "string" ? previous.draft.slice(0, 120) : "",
    draftError: previous?.draftError === true,
    draftScopeError: false,
    executionPaused: previous?.executionPaused === true,
  };
  const seen = new Set();
  for (const saved of Array.isArray(previous?.runs) ? previous.runs : []) {
    if (!saved || !Number.isSafeInteger(saved.no) || saved.no < 1 || seen.has(saved.no)) continue;
    if (!own(subjects, saved.caseId) || !own(taskOptions, saved.kind) || !own(modes, saved.mode)) continue;
    seen.add(saved.no);
    const record = {
      no: saved.no,
      caseId: saved.caseId,
      kind: saved.kind,
      mode: saved.kind === "memory" ? "read" : saved.mode,
      started: Number.isFinite(saved.started) && saved.started > 0 && saved.started <= 8.64e15 ? saved.started : null,
      before: stageOptions.has(saved.before) ? saved.before : subjects[saved.caseId].stage,
      proposal: saved.kind === "ontology" && saved.mode === "controlled" && own(proposalInfo, saved.proposal) ? saved.proposal : "none",
      memoryMatch: saved.memoryMatch === true,
      continued: saved.continued === true,
    };
    const stored = saved.source;
    record.source = own(saved, "source")
      ? (own(subjects, stored?.caseId) && knownSourceIds.has(stored.id) ? { caseId: stored.caseId, id: stored.id } : null)
      : sourceFor(record);
    next.runs.push(record);
  }
  for (const name of ["workbench", "runs"]) {
    const saved = previous?.inspection?.[name];
    if (Number.isSafeInteger(saved?.no) && typeof saved.step === "string" && /^[a-z]+$/.test(saved.step))
      next.inspection[name] = { no: saved.no, step: saved.step };
  }
  return next;
}

function sourceFor(run) {
  if (run.continued) return null;
  const deal = subjects[run.caseId];
  const id = run.kind === "memory" ? (run.memoryMatch ? deal.message.id : null) : deal.meeting?.id;
  return id ? { caseId: run.caseId, id } : null;
}

function safeText(value) {
  return value.replace(/[&<>"']/g, (symbol) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[symbol]);
}

const code = (value) => `<code>${safeText(value)}</code>`;
const runName = (run) => run.no ? `RUN-${String(run.no).padStart(4, "0")}` : "旧版提案";
const executionId = (run) => run.no ? `ACT-${String(run.no).padStart(4, "0")}-01` : "DEMO-EXEC-1124";

function focusPanel(selector) {
  queueMicrotask(() => {
    const panel = document.querySelector(selector);
    panel?.scrollIntoView({ block: "nearest" });
    panel?.focus({ preventScroll: true });
  });
}

const runClock = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
});

function liveMode(agent, kind = agent.preset) {
  return kind === "memory" ? "read" : agent.mode;
}

function currentRun(m) {
  const { agent } = m.state;
  return agent.runs.findLast((run) => run.caseId === m.deal.id && run.kind === agent.preset && run.mode === liveMode(agent));
}

function hasReceipt(run) {
  return run.proposal === "executed" || run.proposal === "verified";
}

function ownedProposal(m) {
  return m.state.agent.runs.findLast((run) => run.caseId === m.deal.id && run.kind === "ontology" && run.mode === "controlled");
}

function legacyProposal(m) {
  if (m.current.proposal === "none" || ownedProposal(m)) return null;
  return {
    no: 0, caseId: m.deal.id, kind: "ontology", mode: "controlled",
    started: null, before: m.deal.stage, proposal: m.current.proposal,
    memoryMatch: false, continued: true,
  };
}

function statusFor(run) {
  if (run.kind === "memory") return run.memoryMatch ? { label: "完成 · 1 条事实", tone: "green" } : { label: "完成 · 0 条事实", tone: "neutral" };
  if (run.proposal !== "none") return proposalInfo[run.proposal];
  if (run.mode === "read") return { label: "只读完成", tone: "green" };
  return { label: "完成 · 阶段已达", tone: "neutral" };
}

function fields(rows) {
  return `<dl class="agent-fields">${rows.map(([name, value]) => `<div><dt>${name}</dt><dd>${value}</dd></div>`).join("")}</dl>`;
}

function traceStep(id, title, badge, tone, copy, rows) {
  return { id, title, badge, tone, copy, rows };
}

function inputScope(deal) {
  return `${deal.company} / ${deal.title}`;
}

function ontologyTrace(deal) {
  const scope = inputScope(deal);
  return [
    traceStep("resolve", "解析业务词条", "已匹配", "green",
      "将任务中的「已完成约见」落到版本化业务目录，保留原问题和审核口径。",
      [["工具", code(taskOptions.ontology.tool)], ["操作", code("resolve")], ["口径版本", code(taskWindow.version)],
        ["已审核条件", code("type = appointment_completed")], ["范围", scope]]),
    traceStep("plan", "判断可回答性", "可查询", "green",
      "当前商机和 UTC 时间窗完整，命中已审核查询模板。排期、取消和未到场不计入完成约见。",
      [["工具", code(taskOptions.ontology.tool)], ["操作", code("plan")], ["模板", code(taskWindow.template)],
        ["起点（含）", taskWindow.from], ["终点（不含）", taskWindow.to]]),
    traceStep("query", "执行许可查询", deal.meeting ? "命中 1 条" : "空结果", deal.meeting ? "green" : "gold",
      deal.meeting ? deal.meeting.note : "当前 CRM 记录在此窗口内没有匹配的已完成约见。阶段推进缺少依据。",
      [["工具", code(taskOptions.ontology.tool)], ["操作", code("query")], ["关系", code(taskWindow.relation)],
        ["命中数 / 演示上限", `${deal.meeting ? 1 : 0} / 25`],
        ["本次来源", deal.meeting ? `${code(deal.meeting.id)} · ${deal.meeting.date}` : "没有匹配记录"]]),
  ];
}

function memoryTrace(run, deal) {
  return [
    traceStep("scope", "核对客户范围", "同一客户", "green",
      "以选定商机定位单一客户，在现有授权范围内读取客户记录。",
      [["工具", code(taskOptions.memory.tool)], ["客户", `${deal.contact} · ${deal.company}`],
        ["范围", inputScope(deal)], ["访问方式", "只读"]]),
    traceStep("recall", "读取确认事实", run.memoryMatch ? "命中 1 条" : "空结果", run.memoryMatch ? "green" : "neutral",
      run.memoryMatch ? deal.message.fact : "这次读取没有已确认的客户偏好，可通过客户记忆页查看待审或撤回状态。",
      [["返回字段", code("confirmed_customer_memory")], ["事实来源", "CRM 已确认事实"], ["返回条数", run.memoryMatch ? "1" : "0"],
        ["原文定位", run.memoryMatch ? `${code(deal.message.id)} · ${deal.message.date}` : "无"]]),
  ];
}

function proposalTrace(run, deal) {
  const steps = [];
  if (run.mode === "read") return steps;
  if (run.proposal === "blocked") return [traceStep("verdict", "停止推进", "缺少依据", "gold",
    "没有已完成约见，未生成阶段提案。可以补齐活动记录后重新安排核对。",
    [["当前阶段", run.before], ["提案", "0"], ["执行回执", "0"]])];
  if (run.proposal === "none") return [traceStep("verdict", "保持当前阶段", "无需推进", "neutral",
    "当前商机不在本场景支持的初步接洽阶段。",
    [["当前阶段", run.before], ["提案", "0"]])];
  steps.push(traceStep("proposal", "登记阶段提案", "需人工审批", "gold",
    "把拟议变更和约见依据关联。待审时只记录提案，商机阶段维持原状。",
    [["对象", inputScope(deal)], ["变更内容", `${run.before} → ${resultingStage}`],
      ["依据", deal.meeting ? code(deal.meeting.id) : "既有提案"],
      ["提案登记时的阶段", run.before]]));
  if (run.proposal === "pending") return steps;
  const rejected = run.proposal === "rejected";
  steps.push(traceStep("decision", "记录人工决定", rejected ? "已拒绝" : "已批准", rejected ? "red" : "green",
    rejected ? "拒绝后停止该提案，保留原阶段。" : "批准让提案可执行，决定本身不改变商机阶段。",
    [["操作人", "林序 · 演示审核人"], ["决定时的商机阶段", run.before], ["决定时的回执", "0 条"]]));
  if (!hasReceipt(run)) return steps;
  steps.push(traceStep("execution", "执行已批准变更", "已执行", "green",
    "受控执行将商机推进到目标阶段。重放这次运行不会重新执行。",
    [["变更回执", code(executionId(run))], ["实际变更", `${run.before} → ${resultingStage}`], ["回执条数", "1"]]));
  if (run.proposal === "verified") steps.push(traceStep("readback", "回查商机与回执", "状态一致", "green",
    "再次读取商机及关联回执，确认目标阶段已生效。",
    [["商机阶段", resultingStage], ["关联回执", code(executionId(run))], ["核对结果", "阶段与回执一致"]]));
  return steps;
}

function traceFor(run) {
  const deal = subjects[run.caseId];
  const initial = run.continued
    ? [traceStep("resume", "接续旧版提案", "已接续", "neutral", "此前页面保留提案决定，本节补录继续审批和回查对应的状态。", [["对象", inputScope(deal)]])]
    : [traceStep("queue", "建立演示运行", "已记录", "neutral", "将选定客户、商机和访问方式保存在当前演示标签页。", [["运行编号", code(runName(run))], ["查看范围", inputScope(deal)], ["模式", modes[run.mode]]]),
       ...(run.kind === "ontology" ? ontologyTrace(deal) : memoryTrace(run, deal))];
  return [...initial, ...proposalTrace(run, deal)];
}

function selectedStep(m, run, area, steps) {
  const selection = m.state.agent.inspection[area];
  const selected = selection?.no === run.no && steps.find((step) => step.id === selection.step);
  const showSource = area === "workbench" && !hasReceipt(run) && run.proposal !== "rejected";
  return selected || (showSource && steps.find(({ id }) => id === "query" || id === "recall")) || steps.at(-1);
}

function taskPicker(m) {
  const { agent } = m.state;
  return `<div class="agent-toolbar-field">
    <span id="agent-task-label" class="agent-control-label">任务场景</span>
    <div class="agent-mode" role="group" aria-labelledby="agent-task-label">
      ${Object.entries(taskOptions).map(([name, task]) => `<button type="button" data-action="agent-preset" data-select="${name}" aria-pressed="${agent.preset === name}">${task.label}</button>`).join("")}
    </div>
  </div>`;
}

function workbenchControls(m) {
  const { agent } = m.state;
  const { preset } = agent;
  const mode = liveMode(agent);
  const primary = preset === "memory" ? "运行客户记忆读取"
    : mode === "read" ? "运行只读查询"
    : m.current.proposal === "blocked" ? "查看取证结果"
    : m.current.proposal !== "none" ? "继续现有提案"
    : "生成阶段提案";
  return `<div class="agent-toolbar">
    ${taskPicker(m)}
    <label class="agent-toolbar-field agent-scope"><span id="agent-scope-label" class="agent-control-label">选择商机</span><select data-control="selected" aria-labelledby="agent-scope-label">
      ${m.deals.map((deal) => `<option value="${deal.id}" ${m.deal.id === deal.id ? "selected" : ""}>${deal.company} · ${deal.title}</option>`).join("")}
    </select></label>
    <div class="agent-toolbar-field">
      <span id="agent-mode-label" class="agent-control-label">访问模式</span>
      <div class="agent-mode" role="group" aria-labelledby="agent-mode-label">
        ${Object.entries(modes).map(([id, name]) => `<button type="button" data-action="agent-mode" data-select="${id}" aria-pressed="${mode === id}" ${agent.preset === "memory" && id === "controlled" ? "disabled" : ""}>${name}</button>`).join("")}
      </div>
    </div>
    ${m.button("agent-start", primary, "button-primary agent-start")}
  </div>`;
}

function taskIntro(m) {
  const task = taskOptions[m.state.agent.preset];
  return `<section class="agent-launch" aria-labelledby="agent-launch-title">
    <span class="agent-kicker">${task.agent}</span><h2 id="agent-launch-title">${task.title}</h2>
    <p>${task.description}</p>
  </section>`;
}

function memoryExample(m, compact) {
  const { company, contact, message } = m.deal;
  return `<section class="agent-launch agent-memory-example">
    ${compact ? "" : `<div class="agent-example-intro">
      <span class="agent-kicker">内置案例 · ${company}</span>
      <h2>客户记忆示例</h2>
      <p>“准备回访${contact}时，夜间告警应该怎么联系？”</p>
    </div>`}
    <details>
      <summary class="button button-small">播放记忆示例</summary>
      <div class="agent-example-result">
        <div class="agent-action-header"><h3>示例回放</h3><span class="pill pill-green">只读 · 1 条确认事实</span></div>
        <ol>
          <li><strong>定位客户</strong><p>${company} · ${contact}。记忆读取限定在这位客户。</p></li>
          <li><strong>核对原话</strong><p>“${message.quote}” ${code(message.id)}</p></li>
          <li><strong>给出回访提示</strong><p>${message.fact}</p></li>
        </ol>
        <p class="agent-example-note">回放使用已确认的示例快照。当前标签页的记忆以客户记忆页的审核状态为准。</p>
        <a class="table-link" href="#memory" data-select="${m.deal.id}">查看当前客户记忆</a>
      </div>
    </details>
  </section>`;
}

function taskComposer(m) {
  const { agent } = m.state;
  return `<div class="agent-command-dock">
    <form class="agent-command" data-agent-command aria-labelledby="agent-command-label">
      <div class="agent-command-heading">
        <label id="agent-command-label" for="agent-command">用一句话发起任务</label>
        <p id="agent-command-hint">支持已完成约见和已确认客户偏好两类任务。</p>
      </div>
      <div class="agent-command-input"><input maxlength="120" id="agent-command" data-agent-input autocomplete="off" name="agent-command"
        placeholder="${agent.preset === "memory" ? "例如：查询已确认的沟通偏好" : "例如：只查已完成约见"}" value="${safeText(agent.draft)}"
        aria-describedby="agent-command-hint${agent.draftError ? " agent-command-error" : ""}" ${agent.draftError ? 'aria-invalid="true"' : ""}>
        <button type="submit" class="button button-primary">运行任务</button>
      </div>
      ${agent.draftError ? `<p id="agent-command-error" class="agent-error">${agent.draftScopeError
        ? "指令中的客户与上方选定范围不同，请先切换商机。"
        : "无法明确匹配一个任务。请写明要查「已完成约见」或「已确认客户偏好」，并核对上方商机范围。"}</p>` : ""}
    </form>
  </div>`;
}

function resultText(run) {
  const deal = subjects[run.caseId];
  if (run.kind === "memory") return run.memoryMatch
    ? `本次查到 1 条已确认的沟通偏好。${deal.message.fact}`
    : "本次读回 0 条确认事实。待审核、拒绝和撤回的内容不进入召回。";
  if (run.continued) return "接续已保存在标签页的提案，可查看当前决定和执行结果。";
  if (!deal.meeting) return "所选时间窗没有匹配的已完成约见记录。现有证据不足以推进阶段。";
  if (run.mode === "read") return "只读返回一条已完成技术访谈，商机阶段保持原状。";
  if (run.proposal === "none") return "已读取约见依据，此商机当前阶段无需按本案例推进。";
  return `已找到已完成约见。${proposalCopy[run.proposal] ?? ""}`;
}

function traceList(m, run, area, selected, steps) {
  return `<ol class="agent-trace-list" aria-label="运行事件顺序">
    ${steps.map((step, index) => `<li><button type="button" data-action="agent-step" data-case="${area}" data-select="${step.id}" data-run="${run.no}"
      aria-pressed="${step.id === selected.id}">
      <span class="agent-step-index" aria-hidden="true">${String(index + 1).padStart(2, "0")}</span>
      <strong class="agent-step-name">${step.title}</strong>
      ${m.label(step.badge, step.tone)}
    </button></li>`).join("")}
  </ol>`;
}

function inspector(m, run, area, selected, steps) {
  const index = steps.indexOf(selected);
  const moveButton = (step, text) => step
    ? `<button type="button" class="button button-small" data-action="agent-step" data-case="${area}" data-select="${step.id}" data-run="${run.no}" data-inspector="navigation" aria-label="${text}">${text}</button>`
    : `<button type="button" class="button button-small" disabled>${text}</button>`;
  return `<aside class="agent-inspector" aria-labelledby="agent-inspector-title" tabindex="-1">
    <div class="agent-inspector-top"><span class="agent-kicker">回执检查器</span><span class="agent-inspector-count">${index + 1} / ${steps.length}</span></div>
    <h3 id="agent-inspector-title">${selected.title}</h3>
    <p>${selected.copy}</p>
    ${fields(selected.rows)}
    ${run.kind === "memory" && run.memoryMatch ? '<p class="agent-muted-note">这是该次运行保留的读取结果，当前可用性以客户记忆页为准。</p>' : ""}
    <div class="agent-step-controls">${moveButton(steps[index - 1], "上一步")}${moveButton(steps[index + 1], "下一步")}</div>
  </aside>`;
}

function transitionPanel(m, run, area) {
  if (run.kind !== "ontology" || ["none", "blocked"].includes(run.proposal)) return "";
  const canAct = area === "workbench" && m.current.proposal === run.proposal;
  const hold = canAct && run.proposal === "approved" && m.state.agent.executionPaused;
  const buttons = canAct
    ? (proposalActions[run.proposal] ?? []).map(([action, text, classes]) => (hold && action === "execute")
      ? `<button type="button" class="button ${classes}" disabled>${text}</button>`
      : m.button(`agent-${action}`, text, classes)).join("")
    : "";
  const deal = subjects[run.caseId];
  const { label, tone } = proposalInfo[run.proposal];
  return `<section class="agent-action" aria-label="阶段提案与执行回执" tabindex="-1">
    <div class="agent-action-header"><h3>阶段提案</h3>${m.label(label, tone)}</div>
    <div class="agent-transition"><span>${run.before}</span><i aria-hidden="true">→</i><strong>${resultingStage}</strong></div>
    <p>${proposalCopy[run.proposal]}</p>
    ${fields([[
      area === "workbench" ? "当前商机阶段" : "本次运行结束时的阶段",
      area === "workbench" ? m.stageFor(deal) : hasReceipt(run) ? resultingStage : run.before,
    ], ["执行回执", hasReceipt(run) ? `1 条回执 · ${code(executionId(run))}` : "0 条回执"]])}
    ${hold ? '<p class="agent-hold-notice">工作区已暂停执行。可以恢复后继续同一条审批，等待期间阶段和回执均保持原样。</p>' : ""}
    ${buttons ? `<div class="agent-action-buttons">${buttons}</div>` : ""}
  </section>`;
}

function workbench(m) {
  const { agent } = m.state;
  const run = currentRun(m) ?? (agent.preset === "ontology" && liveMode(agent) === "controlled" ? legacyProposal(m) : null);
  const task = taskOptions[agent.preset];
  const steps = run ? traceFor(run) : [];
  const step = run ? selectedStep(m, run, "workbench", steps) : null;
  const stage = m.stageFor(m.deal);
  const starter = m.deal.id === "ridge"
    ? memoryExample(m, Boolean(run) || m.current.proposal !== "none")
    : run ? "" : taskIntro(m);
  return `<div class="agent-page agent-workbench">
    ${m.heading("Agent 工作台", "选择任务与商机，核对工具结果、人工决定和执行回执。", '<a class="button button-small agent-history-link" href="#runs">检查历史运行</a>')}
    ${workbenchControls(m)}
    <div class="agent-workspace">
      <div class="agent-viewport" data-workbench-scroll="viewport">
        <div class="agent-console" data-workbench-scroll="run" tabindex="0" role="region" aria-label="运行和案例">
          ${run ? `<section class="agent-run-card" aria-labelledby="agent-run-title" tabindex="-1">
            <div class="agent-run-head">
              <div><span class="agent-kicker">${runName(run)} · ${modes[run.mode]}</span><h2 id="agent-run-title">运行轨迹</h2></div>
              ${m.label(statusFor(run).label, statusFor(run).tone)}
            </div>
            <p class="agent-run-summary">${resultText(run)}</p>
            <div class="agent-run-grid">
              <div>${traceList(m, run, "workbench", step, steps)}</div>
              ${inspector(m, run, "workbench", step, steps)}
            </div>
          </section>` : ""}
          ${starter}
        </div>
        <div class="agent-side" data-workbench-scroll="context">
          ${run ? transitionPanel(m, run, "workbench") : ""}
          <section class="agent-object agent-guard" aria-labelledby="agent-guard-title">
            <div class="agent-action-header"><h3 id="agent-guard-title">工作区执行护栏</h3>
              ${m.label(agent.executionPaused ? "执行暂停" : "允许获批动作", agent.executionPaused ? "gold" : "green")}</div>
            <p>影响待执行的本地阶段变更。读取、审阅和历史回放仍可用。</p>
            ${m.button("agent-toggle-execution", agent.executionPaused ? "恢复执行" : "暂停执行", "button-small")}
          </section>
          <section class="agent-object" aria-label="业务范围">
            <div class="agent-object-head">${m.avatar(m.deal)}<div><p>${m.deal.company}</p><h2>${m.deal.title}</h2></div></div>
            ${fields([["商机金额", m.money.format(m.deal.amount)], ["当前商机阶段", stage], ["选定客户", m.deal.contact]])}
            <div class="agent-links"><a href="#inbox" data-select="${m.deal.id}">客户会话</a><a href="#memory" data-select="${m.deal.id}">客户记忆</a></div>
          </section>
          <p class="agent-demo-note">本地模拟调用 ${code(task.tool)}。<a href="${publicEvidence[agent.preset]}">查看对应的产品证据</a></p>
        </div>
      </div>
      ${taskComposer(m)}
    </div>
  </div>`;
}

function historyRun(m) {
  const { agent } = m.state;
  const filtered = agent.runs.filter((run) => {
    const needsReview = ["pending", "approved", "blocked"].includes(run.proposal);
    return agent.historyFilter === "all" || (agent.historyFilter === "review") === needsReview;
  });
  return { filtered: [...filtered].reverse(), selected: filtered.find((run) => run.no === agent.historyId) ?? filtered.at(-1) };
}

function historyFilters(m) {
  const options = { all: "全部", review: "待处理与缺证", done: "已结算" };
  return `<div class="agent-run-filters" role="group" aria-label="筛选运行状态">
    ${Object.entries(options).map(([id, name]) => `<button type="button" data-action="agent-history-filter" data-select="${id}"
      aria-pressed="${m.state.agent.historyFilter === id}">${name}</button>`).join("")}
  </div>`;
}

function relatedLog(m) {
  const included = new Set(["closed", "candidate", "remembered", "dismissed", "recalled", "withdrawn", "taskDone"]);
  const related = m.state.logs.filter(({ id, kind }) => own(subjects, id) && included.has(kind)).slice(-8).reverse();
  return related.length ? `<section class="agent-related"><h2>近期客户操作</h2><ul>
    ${related.map(({ id, kind }) => `<li><a href="${kind === "closed" ? "#inbox" : kind === "taskDone" ? "#tasks" : "#memory"}" data-select="${id}">${subjects[id].company}</a><span>${events[kind][1]}</span></li>`).join("")}
  </ul></section>` : "";
}

function runs(m) {
  const { filtered, selected } = historyRun(m);
  const steps = selected ? traceFor(selected) : [];
  const step = selected ? selectedStep(m, selected, "runs", steps) : null;
  return `<div class="agent-page">
    ${m.heading("运行记录", "回看当前标签页保留的工具过程、阶段决定与执行回执。", '<a class="button button-primary" href="#workbench">发起任务</a>')}
    <div class="agent-history">
      <section class="agent-history-list" aria-label="运行列表">
        <div class="agent-history-heading"><h2>运行列表</h2><span>${filtered.length} 条</span></div>
        ${historyFilters(m)}
        ${filtered.length ? `<ol>${filtered.map((run) => {
          const status = statusFor(run);
          return `<li><button type="button" data-action="agent-history-pick" data-select="${run.no}" aria-pressed="${run.no === selected.no}">
            <span class="agent-history-meta">${code(runName(run))}<span>${run.started ? runClock.format(run.started) : "既有提案"}</span></span>
            <strong>${subjects[run.caseId].company} · ${taskOptions[run.kind].label}</strong>${m.label(status.label, status.tone)}
          </button></li>`;
        }).join("")}</ol>` : '<div class="agent-history-empty">当前筛选没有运行。<a href="#workbench">前往工作台</a></div>'}
      </section>
      ${step ? `<div class="agent-history-detail">
        <div class="agent-replay">
          <div class="agent-run-card">
            <div class="agent-run-head"><div><span class="agent-kicker">${runName(selected)} · ${modes[selected.mode]}</span>
              <h2>运行回放</h2></div>${m.label(statusFor(selected).label, statusFor(selected).tone)}</div>
            <p class="agent-run-summary">${resultText(selected)}</p>
            ${traceList(m, selected, "runs", step, steps)}
          </div>
          ${inspector(m, selected, "runs", step, steps)}
        </div>
        ${transitionPanel(m, selected, "runs")}
        ${["pending", "approved", "executed"].includes(selected.proposal) ? `<div class="agent-return">${m.button("agent-continue", "回工作台继续处理")}</div>` : ""}
      </div>` : `<div class="agent-empty-trace"><span class="agent-empty-mark" aria-hidden="true">⌁</span>
        <div><strong>选择一条运行后检查回执</strong><p>回放只读取记录，审批及执行请回到工作台。</p></div></div>`}
    </div>
    ${relatedLog(m)}
  </div>`;
}

function addRun(m, kind, mode, initial = {}) {
  const { agent } = m.state;
  const no = Math.max(0, ...agent.runs.map((run) => run.no)) + 1;
  const record = {
    no,
    caseId: m.deal.id,
    kind,
    mode,
    started: Date.now(),
    before: m.stageFor(m.deal),
    proposal: "none",
    memoryMatch: kind === "memory" && m.current.memory === "confirmed",
    continued: false,
    ...initial,
  };
  record.source = sourceFor(record);
  agent.runs.push(record);
  agent.historyId = record.no;
  delete agent.inspection.workbench;
  delete agent.inspection.runs;
  return record;
}

function startTask(m, kind) {
  const { agent } = m.state;
  const mode = liveMode(agent, kind);
  if (mode === "controlled" && m.current.proposal !== "none") {
    focusPanel(m.current.proposal === "blocked" ? ".agent-run-card" : ".agent-action");
    return m.current.proposal === "blocked" ? "还没有可用于推进的约见。切换只读模式可以再次核对。"
      : "已有阶段决定可继续查看。切换只读模式可以再次核对约见。";
  }
  const run = addRun(m, kind, mode);
  focusPanel(".agent-run-card");
  if (kind === "memory") {
    m.log(m.deal, "recalled");
    return resultText(run);
  }
  if (mode === "read" || (run.before !== writableStage && m.deal.meeting)) return resultText(run);
  const message = m.changeProposal("propose", m.deal, m.current);
  run.proposal = m.current.proposal;
  return message || resultText(run);
}

function handleDecision(action, m) {
  const allowed = { approve: "pending", reject: "pending", execute: "approved", verify: "executed" };
  if (m.state.agent.preset !== "ontology" || liveMode(m.state.agent) !== "controlled" || m.current.proposal !== allowed[action])
    return "当前状态下无法处理该决定。";
  if (action === "execute" && m.state.agent.executionPaused) return "执行已暂停。请先恢复工作区执行。";
  const run = ownedProposal(m) ?? addRun(m, "ontology", "controlled", {
    continued: true, before: m.deal.stage, proposal: m.current.proposal,
  });
  const message = m.changeProposal(action, m.deal, m.current);
  run.proposal = m.current.proposal;
  delete m.state.agent.inspection.workbench;
  return message;
}

export const agentScreens = { workbench, runs };

export function handleAgentInput(event, m) {
  if (!event.target.matches("[data-agent-input]")) return false;
  m.state.agent.draft = event.target.value.slice(0, 120);
  return true;
}

export function handleAgentSubmit(event, m) {
  if (!event.target.matches("[data-agent-command]")) return undefined;
  event.preventDefault();
  const { agent } = m.state;
  const text = (event.target.elements.namedItem("agent-command")?.value ?? "").trim();
  const ontology = /约见|访谈|推进商机|阶段提案|appointment/i.test(text);
  const memory = /记忆|偏好|复用事实|memory/i.test(text);
  const outside = deals.some((deal) => deal.id !== m.deal.id && [deal.company, deal.contact, deal.title].some((name) => text.includes(name)));
  if (ontology === memory || outside) {
    agent.draft = text.slice(0, 120);
    agent.draftError = true;
    agent.draftScopeError = outside;
    return outside ? "请先切换到指令中的客户。" : "未匹配唯一的演示任务。";
  }
  agent.preset = ontology ? "ontology" : "memory";
  agent.draftError = false;
  agent.draft = "";
  if (ontology && /只读|只查|仅查询|不.{0,3}(更改|修改|推进)/.test(text)) agent.mode = "read";
  return startTask(m, agent.preset);
}

export function handleAgent(action, control, m) {
  if (!action.startsWith("agent-")) return undefined;
  const { agent } = m.state;
  const { select } = control.dataset;
  switch (action) {
    case "agent-preset":
      if (!own(taskOptions, select)) return undefined;
      agent.preset = select;
      agent.draftError = false;
      return `已选场景：${taskOptions[select].label}。`;
    case "agent-mode":
      if (!own(modes, select) || (agent.preset === "memory" && select === "controlled")) return undefined;
      agent.mode = select;
      return `当前模式：${modes[select]}。`;
    case "agent-start":
      return startTask(m, agent.preset);
    case "agent-toggle-execution":
      agent.executionPaused = !agent.executionPaused;
      return agent.executionPaused ? "已暂停执行，原提案与阶段保持。" : "已恢复执行，可继续已批准的提案。";
    case "agent-open-memory":
      agent.preset = "memory";
      agent.draftError = false;
      window.location.hash = "#workbench";
      return "已打开该客户的记忆取证任务。";
    case "agent-step": {
      const { case: area, run: raw } = control.dataset;
      if (!["workbench", "runs"].includes(area)) return undefined;
      const run = agent.runs.find((item) => item.no === Number(raw)) ?? legacyProposal(m);
      const step = run && traceFor(run).find((item) => item.id === select);
      if (!step) return undefined;
      agent.inspection[area] = { no: run.no, step: step.id };
      if (control.dataset.inspector || window.matchMedia("(max-width: 720px)").matches)
        focusPanel(".agent-inspector");
      return `查看回执：${step.title}。`;
    }
    case "agent-history-filter":
      if (!["all", "review", "done"].includes(select)) return undefined;
      agent.historyFilter = select;
      return "已更新运行筛选。";
    case "agent-history-pick":
      if (!agent.runs.some((run) => run.no === Number(select))) return undefined;
      agent.historyId = Number(select);
      delete agent.inspection.runs;
      return `打开 ${runName(agent.runs.find((run) => run.no === agent.historyId))} 回放。`;
    case "agent-continue": {
      const { selected } = historyRun(m);
      if (!selected) return undefined;
      m.state.selected = selected.caseId;
      agent.preset = selected.kind;
      agent.mode = selected.mode;
      window.location.hash = "#workbench";
      return "已返回该商机工作台。";
    }
    case "agent-approve":
    case "agent-reject":
    case "agent-execute":
    case "agent-verify":
      return handleDecision(action.slice(6), m);
    default:
      return undefined;
  }
}
