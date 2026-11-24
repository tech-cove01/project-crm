const nodes = {
  web: {
    title: "Next.js 工作台",
    summary: "选定组织、角色与商机",
    detail: "服务端按登录账号校验组织、角色和业务对象。启动时保存授权范围，后续作业和工具读取沿用同一范围。",
    boundary: "同一客户名下的其他商机也不属于当前 Run 的业务范围。",
  },
  queue: {
    title: "持久队列与 Worker",
    summary: "Run 落库后按租约领取",
    detail: "请求先保存 Run 和待执行作业，Node.js Worker 按租约领取。审批结果和等待信息会留在原 Run，供后续执行与恢复使用。",
    boundary: "领取、执行获批动作、续跑可以在原 Run 找到各自记录。",
  },
  pi: {
    title: "Pi Agent",
    summary: "调用许可工具，保存取证回执",
    detail: "Pi 在授权范围内选择工具，记录调用、命中与缺项。有依据时可以生成回答或阶段提案。",
    boundary: "读取权限、资料版本和业务写入由工具与服务端分别核验。",
  },
  result: {
    title: "回答或待审提案",
    summary: "结论、来源与待补材料",
    detail: "只读任务可以返回带来源的报告。需要变更阶段时，Run 保存目标阶段和支持它的材料，交给有权限的人员决定。",
    boundary: "资料没有覆盖的事实会保留为缺项，阶段变更须走审批路径。",
  },
  terms: {
    title: "业务口径",
    summary: "审核术语与版本化模板",
    detail: "术语、关系和允许查询的模板来自已审核的业务目录。约见查询使用当前商机和 UTC 时间窗作为参数。",
    boundary: "已完成约见区别于预约、取消和未到场。",
  },
  facts: {
    title: "PostgreSQL",
    summary: "授权业务事实与活动回执",
    detail: "CRM 的操作和查询沿组织与选定对象回读业务记录。已执行的动作可用活动和回执反向核对。",
    boundary: "查询为空仅表示当前授权范围和时间窗内没有匹配记录。",
  },
  confirmed: {
    title: "授权单聊",
    summary: "原文 → 候选 → 人工确认",
    detail: "从选定客户的授权历史单聊中生成候选。人工确认时核对消息归属、原文位置和版本，将审核结果与事实一同保存。",
    boundary: "待审候选不会被新会话召回。",
  },
  memory: {
    title: "SQL 确认事实",
    summary: "Mem0 可辅助候选排序",
    detail: "新会话按组织、客户和事实 ID 从 SQL 回读。启用 Mem0 时可辅助候选排序，最终内容、版本和有效性仍由 SQL 核对。",
    boundary: "撤回事实和其他客户的记忆均不进入当前客户的召回。",
  },
  search: {
    title: "知识检索工具",
    summary: "搜索候选企业资料",
    detail: "检索用来找候选资料。进入引用之前，CRM 会复核资料授权、发布状态和有效版本。",
    boundary: "候选命中后还需要原文支持具体结论。",
  },
  original: {
    title: "企业资料原文",
    summary: "WeKnora 检索与原文复核",
    detail: "WeKnora 可以返回企业资料候选。CRM 使用当前有效的资料版本回读原文，核对规则、报价或服务限制的真实表述。",
    boundary: "资料改版或撤回会触发新的引用校验。",
  },
  proposal: {
    title: "阶段提案",
    summary: "保留原阶段、目标与依据",
    detail: "提案指向所选商机和真实取证记录。待批时保留原阶段，用户可以打开证据和拟议变更。",
    boundary: "提案写入审阅记录，待批期间业务阶段维持原值。",
  },
  approval: {
    title: "负责人审批",
    summary: "查看证据后批准或拒绝",
    detail: "具有审批权限的负责人核对对象、证据和拟议动作，再批准或拒绝。批准后将动作交给执行队列。",
    boundary: "拒绝留下决定，商机阶段和执行回执维持原状。",
  },
  write: {
    title: "Worker 执行",
    summary: "重查授权、提案与租约",
    detail: "Worker 复核发起和批准权限、提案和租约，再调用真实 CRM 动作并保存回执。",
    boundary: "实效无法确认时进入对账，暂停自动重复尝试。",
  },
  readback: {
    title: "PostgreSQL 回查",
    summary: "回读阶段和执行回执",
    detail: "动作完成后续跑同一 Run，从 SQL 回读商机实际阶段和对应回执。",
    boundary: "完成报告对应真实业务状态和实际回执。",
  },
  events: {
    title: "Run 事件",
    summary: "调用、审批和业务回执",
    detail: "运行事件保留工具过程、审批以及执行结果，允许按运行编号回看原轨迹。",
    boundary: "审计使用事件和回执，报告文字只是其中一个结果。",
  },
  trace: {
    title: "Langfuse 观测",
    summary: "关联耗时、Token 与评分",
    detail: "经异步导出的脱敏轨迹可用于查看模型调用、工具调用、延迟、用量和已记录评分。",
    boundary: "同一 Run 的运行事实和业务效果分别核查。",
  },
  outcome: {
    title: "来源与业务结果",
    summary: "工具回执、SQL 状态和答案",
    detail: "逐项拿运行中实际返回的来源、引用与写入结果核对输出，以原回执为准。",
    boundary: "带引用的文字仍需要正文和执行结果支持。",
  },
  review: {
    title: "规则与语义复核",
    summary: "确定性规则优先，语义按需",
    detail: "先核对字段、引用、对象范围和真实动作。需要判断表达是否准确时再使用语义评审辅助。",
    boundary: "固定样本对比会分别保留质量、耗时和用量。",
  },
};

const proofTracks = [
  { title: "业务事实", from: "terms", to: "facts", label: "参数查询", kind: "read" },
  { title: "客户记忆", from: "confirmed", to: "memory", label: "确认后读", kind: "read" },
  { title: "企业知识", from: "search", to: "original", label: "查原文", kind: "read" },
];

const checkTracks = [
  { title: "追踪", from: "events", to: "trace", label: "脱敏导出", kind: "run" },
  { title: "评测", from: "outcome", to: "review", label: "核对", kind: "read" },
];

function node(id) {
  const { title, summary } = nodes[id];
  return `<button type="button" class="home-map-node" data-home-map-node="${id}"
    aria-controls="home-map-inspector" aria-pressed="false">
    <strong>${title}</strong><span>${summary}</span>
  </button>`;
}

function arrow(kind, label) {
  return `<span class="home-map-arrow" data-kind="${kind}">
    <span class="home-map-edge-title">${label}</span><span class="home-map-wire" aria-hidden="true"></span>
  </span>`;
}

function chain(ids, labels, kind) {
  return `<div class="home-map-flow">${ids.map((id, index) =>
    (index > 0 ? arrow(kind, labels[index - 1]) : "") + node(id)
  ).join("")}</div>`;
}

function track({ title, from, to, label, kind }) {
  return `<div class="home-map-track">
    <h4>${title}</h4>
    <div class="home-map-pair">${node(from)}${arrow(kind, label)}${node(to)}</div>
  </div>`;
}

function group(title, note, content, kind) {
  return `<section class="home-map-group" data-kind="${kind}">
    <div class="home-map-group-head"><h3>${title}</h3><p>${note}</p></div>
    ${content}
    <div data-home-map-slot></div>
  </section>`;
}

function mount(board) {
  board.innerHTML = `
    <div class="home-map-key" role="group" aria-label="连线图例">
      ${arrow("run", "运行或记录")}${arrow("read", "许可读取与核验")}${arrow("approve", "人工决定与受控写入")}
    </div>
    <div class="home-map-layout">
      <div class="home-map-routes">
        ${group("任务怎么运行", "请求、运行与输出", chain(
          ["web", "queue", "pi", "result"], ["提交任务", "领取作业", "返回依据"], "run",
        ), "run")}
        ${group("Pi 从哪里取证", "许可工具分别校验三类来源", `
          <div class="home-map-tracks home-map-evidence">${proofTracks.map(track).join("")}</div>
        `, "read")}
        ${group("谁能让商机阶段改变", "只读任务走第一条路径直接交付", chain(
          ["proposal", "approval", "write", "readback"], ["提交审阅", "人工批准", "续跑查结果"], "approve",
        ), "approve")}
        ${group("结果怎么复核", "同一 Run 的观测与验收", `
          <div class="home-map-tracks home-map-checks">${checkTracks.map(track).join("")}</div>
        `, "review")}
      </div>
      <div class="home-map-desktop-slot"></div>
    </div>
  `;

  const desktop = matchMedia("(min-width: 1150px)");
  const desktopSlot = board.querySelector(".home-map-desktop-slot");
  const detail = document.createElement("div");
  detail.id = "home-map-inspector";
  detail.className = "home-map-inspector";
  detail.setAttribute("role", "status");
  detail.setAttribute("aria-atomic", "true");
  let selected = board.querySelector('[data-home-map-node="pi"]');

  function placeDetail() {
    const slot = desktop.matches ? desktopSlot : selected.closest(".home-map-group").querySelector("[data-home-map-slot]");
    if (detail.parentElement !== slot) slot.append(detail);
  }

  function show(button) {
    selected.setAttribute("aria-pressed", "false");
    selected = button;
    selected.setAttribute("aria-pressed", "true");
    placeDetail();
    const { title, detail: description, boundary } = nodes[selected.dataset.homeMapNode];
    detail.innerHTML = `<h4>${title}</h4><p>${description}</p><p class="home-map-boundary">${boundary}</p>`;
  }

  board.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-home-map-node]");
    if (button) show(button);
  });
  desktop.addEventListener("change", placeDetail);
  show(selected);
}

const board = document.querySelector("#architecture-board[data-home-map]");
if (board) mount(board);
