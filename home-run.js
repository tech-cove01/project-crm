const states = {
  queued: {
    label: "排队",
    brief: "Run 与范围先落库",
    detail: "保存任务、组织和所选业务对象，Worker 拿到租约后才开始处理。同一个 Run 可以在审批后接续。",
    result: "已保存 Run 和待处理作业。",
  },
  working: {
    label: "取证中",
    brief: "查业务口径与来源",
    detail: "检查当前角色和所选对象，读取匹配活动、有效知识或已确认记忆。资料版本和来源随结果记录。",
    result: "来源、查询范围和查到的事实。",
  },
  waiting: {
    label: "等待审批",
    brief: "有依据提案 · 阶段未改",
    detail: "提案保存原阶段、拟改阶段和取证依据。审核人决定批准或拒绝，等待审批时商机保持原状。",
    result: "已建立提案，实际变更回执为零。",
  },
  executing: {
    label: "执行并回查",
    brief: "重新校验 · 接续原 Run",
    detail: "批准后 Worker 复核权限、提案和租约，执行获批动作。随后在原 Run 内读取真实业务状态和对应回执。",
    result: "正常审批路径记录一条变更回执。",
  },
  done: {
    label: "已完成",
    brief: "归档结果与来源",
    detail: "只读任务保存查询结果，受控动作保存回读状态和回执。运行终态与任务结果分别核验。",
    result: "带来源的报告，或写入回执和回查结果。",
  },
  evidence: {
    label: "缺证待复核",
    brief: "保留事实和缺项",
    detail: "证据不足以支持拟议动作时停下，列出能确定的部分和待补项。只读任务遇到正常空结果仍可如实完成。",
    result: "保留查询结果，当前动作没有提案。",
  },
  rejected: {
    label: "提案已拒绝",
    brief: "记录决定 · 阶段原状",
    detail: "保存拒绝决定，当前提案不进入执行。续跑可继续读取此商机的状态与决定。",
    result: "拒绝记录及原阶段，实际变更回执为零。",
  },
  uncertain: {
    label: "效果待对账",
    brief: "保留回执或失败线索",
    detail: "动作调用后无法确定是否已生效时，暂停自动重复尝试。保留证据，等待人工核对业务事实。",
    result: "待对账的动作以及已知的执行线索。",
  },
};

const mainStates = ["queued", "working", "waiting", "executing", "done"];
const mainEdges = [
  { label: "Worker 领作业", kind: "normal" },
  { label: "有依据，拟推进", kind: "review" },
  { label: "人工批准", kind: "review" },
  { label: "读取状态与回执", kind: "normal" },
];
const stopped = [
  { from: "working", condition: "缺少推进依据", to: "evidence" },
  { from: "waiting", condition: "人工拒绝提案", to: "rejected" },
  { from: "executing", condition: "写入结果无法确认", to: "uncertain" },
];
const routes = {
  all: { label: "全部路径", state: "waiting", hint: "先取证。有阶段动作才进入人审，三个停止分支各自保留原因。" },
  read: { label: "只读取证", state: "working", hint: "领取并取证后保存所见结果，可直接完成，只写入运行记录。", nodes: ["queued", "working", "done"] },
  review: { label: "人审与执行", state: "waiting", hint: "批准后才执行业务动作，回查完成后归档。", nodes: mainStates },
  stop: { label: "停止与复核", state: "evidence", hint: "核对缺证、拒绝或效果未知的起点及结果。", nodes: stopped.flatMap(({ from, to }) => [from, to]) },
};

function node(id) {
  const { label, brief } = states[id];
  return `<button type="button" class="run-atlas-node" data-run-node="${id}" aria-pressed="false" aria-controls="run-atlas-detail">
    <strong>${label}</strong><span>${brief}</span>
  </button>`;
}

function arrow(label, kind) {
  return `<div class="run-atlas-edge run-atlas-edge-${kind}"><span>${label}</span><i aria-hidden="true"></i></div>`;
}

function mount(board) {
  board.classList.add("run-atlas");
  board.innerHTML = `
    <div class="run-atlas-controls" role="group" aria-label="选择运行路径">
      ${Object.entries(routes).map(([id, { label }]) =>
        `<button type="button" data-run-route="${id}" aria-pressed="false">${label}</button>`
      ).join("")}
    </div>
    <p class="run-atlas-hint" role="status"></p>
    <section class="run-atlas-route run-atlas-main" aria-labelledby="run-atlas-main-title">
      <h3 id="run-atlas-main-title">主链 · 有依据的阶段变更</h3>
      <div class="run-atlas-track">
        ${mainStates.map((id, index) => node(id) + (mainEdges[index] ? arrow(mainEdges[index].label, mainEdges[index].kind) : "")).join("")}
      </div>
    </section>
    <section class="run-atlas-route run-atlas-read" aria-labelledby="run-atlas-read-title">
      <h3 id="run-atlas-read-title">只读捷径</h3>
      <div class="run-atlas-shortcut">
        <span class="run-atlas-endpoint">${states.working.label}</span>
        ${arrow("仅查询，保存取证结果", "read")}
        <span class="run-atlas-endpoint">${states.done.label}</span>
      </div>
    </section>
    <section class="run-atlas-route run-atlas-stop" aria-labelledby="run-atlas-stop-title">
      <h3 id="run-atlas-stop-title">需要停下的三个分支</h3>
      <div class="run-atlas-branches">
        ${stopped.map(({ from, condition, to }) => `<div class="run-atlas-branch">
          <span class="run-atlas-origin">从 <strong>${states[from].label}</strong> 分出</span>
          ${arrow(condition, "stop")}
          ${node(to)}
        </div>`).join("")}
      </div>
    </section>
    <figcaption class="run-atlas-details" id="run-atlas-detail" aria-live="polite" aria-atomic="true">
      <div><h3></h3><p></p></div>
      <p><strong>可回查记录</strong><span></span></p>
    </figcaption>`;

  const nodes = [...board.querySelectorAll("[data-run-node]")];
  const filters = [...board.querySelectorAll("[data-run-route]")];
  const hint = board.querySelector(".run-atlas-hint");
  const title = board.querySelector(".run-atlas-details h3");
  const detail = board.querySelector(".run-atlas-details div p");
  const result = board.querySelector(".run-atlas-details > p span");

  function selectState(id) {
    const state = states[id];
    for (const button of nodes) button.setAttribute("aria-pressed", String(button.dataset.runNode === id));
    title.textContent = state.label;
    detail.textContent = state.detail;
    result.textContent = state.result;
  }

  function selectRoute(id) {
    board.dataset.activeRoute = id;
    for (const button of filters) button.setAttribute("aria-pressed", String(button.dataset.runRoute === id));
    const route = routes[id];
    for (const button of nodes) button.classList.toggle("is-on-route", route.nodes?.includes(button.dataset.runNode) ?? false);
    hint.textContent = route.hint;
    selectState(route.state);
  }

  for (const button of nodes) button.addEventListener("click", () => selectState(button.dataset.runNode));
  for (const button of filters) button.addEventListener("click", () => selectRoute(button.dataset.runRoute));
  selectRoute("all");
}

const board = document.querySelector("#run-board");
if (board) mount(board);
