const proof = "https://github.com/tech-cove01/project-crm/blob/main/docs/evidence/";

const architecture = {
  scope: {
    title: "工作台与授权", brief: "Next.js · 固定组织、角色和商机",
    detail: "用户在工作台选定客户或商机，Web 层校验组织成员身份和角色。运行继续时也沿用受限对象范围。工具结果仍须经过该次查询的授权过滤。",
    fact: "同一客户的另一笔商机也可能超出所选范围。",
    links: [["打开商机工作台", "../workspace/#workbench"], ["授权隔离实测", proof + "CRM-027-ontology.md"]],
  },
  queue: {
    title: "持久队列与租约", brief: "Node.js Worker · 领取可执行作业",
    detail: "Run 与作业先落库。Worker 领取任务后核对租约，事件及提案保存后可在之后继续。审批后的执行和普通续跑可以从同一 Run 独立回查。",
    fact: "真实审批路径留下了开始、执行获批动作和续跑作业。",
    links: [["打开运行记录", "../workspace/#runs"], ["执行和续跑实测", proof + "CRM-027-ontology.md"]],
  },
  pi: {
    title: "Pi 与许可工具", brief: "取证 · 提案 · 再读取",
    detail: "Pi 根据任务选择许可工具。工具返回可核对的结果、范围和来源。遇到当前口径回答不了的问题，保留缺项或要求补充定义。",
    fact: "工具事实、提案依据和执行回执可经各自的事件关联。",
    links: [["打开 Agent 工作台", "../workspace/#workbench"], ["本体工具实测", proof + "CRM-029-ontology-layer.md"]],
  },
  action: {
    title: "阶段提案与人审", brief: "批准后执行 · 读取实际结果",
    detail: "Agent 依据所选商机的记录提出阶段建议，等待人审期间阶段保持原状。批准后 Worker 重新校验提案、权限和租约，执行后回读实际状态。",
    fact: "实测得到一条阶段变更回执，续跑结果与 SQL 相符。",
    links: [["体验批准和拒绝", "../workspace/#workbench"], ["审批与回查实测", proof + "CRM-027-ontology.md"]],
  },
  ontology: {
    title: "版本化业务口径", brief: "术语 → 可答性 → 参数化查询",
    detail: "审核通过的术语、关系和模板共同确定可答范围。已完成约见按活动和 UTC 窗口查询。高潜等缺少定义的口径应先澄清。",
    fact: "无活动结果表达的是 CRM 记录范围内没有匹配项。",
    links: [["打开业务口径", "../workspace/#ontology"], ["口径与工具实测", proof + "CRM-029-ontology-layer.md"]],
  },
  sql: {
    title: "PostgreSQL 事实", brief: "商机、审批、确认记忆与事件",
    detail: "数据库保存业务事实、确认记忆及执行凭据。受权读写需要按组织和当前对象过滤。执行完成后再读取商机，以实际结果对照回执。",
    fact: "视图里的结果可以沿事件编号追到该次运行的业务证据。",
    links: [["在工作台回查", "../workspace/#workbench"], ["SQL 与审批回执", proof + "CRM-027-ontology.md"]],
  },
  memory: {
    title: "确认记忆与 Mem0", brief: "SQL 核验 · 可选语义排序",
    detail: "授权单聊的原文产生候选，审核通过后才会从 SQL 读到。启用 Mem0 时可用它给候选事实排序，但正文、版本和撤回状态仍从 SQL 核对。",
    fact: "待审内容和撤回后的事实都不进入本仓的召回结果。",
    links: [["体验记忆审核", "../workspace/#memory"], ["原文与新会话实测", proof + "CRM-028-memory-candidates.md"]],
  },
  knowledge: {
    title: "企业知识原文", brief: "WeKnora · 授权和版本复核",
    detail: "检索可提供企业资料的候选。引用前仍要核对权限、发布状态和生效版本，读回相应原文后再判断是否支持当前结论。",
    fact: "资料改版或撤回，引用必须重新核对。",
    links: [["体验资料版本变动", "../demo/index.html?scenario=knowledge&guide=1#/app/ai/workbench"], ["查看检索实现解释", "../details.html#knowledge-retrieval"]],
  },
  trace: {
    title: "轨迹与 Langfuse", brief: "工具事件、耗时、Token",
    detail: "工具调用、审批和业务回执可以沿运行事件回查。Langfuse 将已导出的脱敏轨迹与模型计量、耗时和评分关联起来。",
    fact: "运行状态和业务结果分别检查。",
    links: [["打开运行回放", "../workspace/#runs"], ["查看可观测验证", "../details.html#validation"]],
  },
  rules: {
    title: "确定性检查", brief: "字段、引用和实际动作",
    detail: "可客观判定的字段、引用或任务结果先由规则或 SQL 校验。一次运行的终态与业务是否成功分开判定。",
    fact: "规则硬失败保留在评估，便于定位实际偏差。",
    links: [["体验规则与失败回放", "../demo/index.html?scenario=evaluation&guide=1#/app/ai/workbench"], ["查看对照方法", "../details.html#validation"]],
  },
  semantics: {
    title: "可选语义复核", brief: "回答质量与回归对照",
    detail: "需要判断回答是否准确表达来源时可以用语义 Judge 辅助。对比样本时固定题目和判分，并分别记录质量、耗时及用量。",
    fact: "可验证的业务结果和安全约束仍按规则结算。",
    links: [["体验分层评分", "../demo/index.html?scenario=evaluation&guide=1#/app/ai/workbench"], ["查看真实对照", "../details.html#validation"]],
  },
};

const runStates = {
  queued: {
    title: "排队", brief: "Run 持久化后等候领取",
    detail: "服务端保存任务与所选客户、商机范围，排队作业供 Worker 按租约领取。访客演示中的状态保存在浏览器。",
    fact: "后续工序沿用原 Run，审批不会产生一个无关的新任务。",
    links: [["打开工作台", "../workspace/#workbench"], ["真实 Run 的作业记录", proof + "CRM-027-ontology.md"]],
  },
  working: {
    title: "取证中", brief: "解析口径 · 回读工具结果",
    detail: "在当前授权范围内，读取有效约见、当前资料或已确认记忆。结果带来源和范围，可在回放中核对。",
    fact: "缺定义先澄清，缺证据不生成本场景的阶段提案。",
    links: [["体验取证与审批", "../workspace/#workbench"], ["只读模板与空结果", proof + "CRM-029-ontology-layer.md"]],
  },
  waiting: {
    title: "等待审批", brief: "提案有依据 · 阶段未改",
    detail: "运行保留建议、原阶段、目标阶段和依据，等人决定。批准与执行业务动作是两个不同的事件。",
    fact: "待批快照中的原阶段和业务活动保持不变。",
    links: [["打开阶段提案", "../workspace/#workbench"], ["待批快照", proof + "CRM-027-ontology.md"]],
  },
  executing: {
    title: "执行与回查", brief: "重核权限 · 执行并续跑",
    detail: "获批动作进入队列，Worker 复核提案、权限和租约后尝试执行，再续跑读取实际业务阶段和回执。",
    fact: "正常路径只产生一条实际变更回执。",
    links: [["体验执行与回查", "../workspace/#workbench"], ["真实执行回执", proof + "CRM-027-ontology.md"]],
  },
  done: {
    title: "已完成", brief: "保存报告与可追溯结果",
    detail: "只读取证结束后可直接完成。涉及阶段变更时，续跑保存当前业务状态和对应回执后完成。",
    fact: "是否达到业务目标还需要核对事实、引用和动作结果。",
    links: [["打开运行回放", "../workspace/#runs"], ["真实结果与限制", "../details.html#validation"]],
  },
  evidence: {
    title: "缺证或待复核", brief: "保留已有依据与缺项",
    detail: "当口径不完整、缺少完成记录或证据不足时，保留能确定的事实，给出待补材料，阻止生成本场景的阶段变更。",
    fact: "不同工具结果可分别表示正常空结果、需澄清和权限拒绝。",
    links: [["体验缺证分支", "../workspace/#workbench"], ["空窗口及负例", proof + "CRM-027-ontology.md"]],
  },
  rejected: {
    title: "已拒绝", brief: "保留决定 · 业务原状",
    detail: "人工拒绝后保存决定。可以继续读取相关记录，当前动作不进入执行，商机阶段与执行回执均保持原状。",
    fact: "拒绝对照读回原阶段，且只排一次普通续跑。",
    links: [["体验拒绝提案", "../workspace/#workbench"], ["拒绝分支实测", proof + "CRM-027-ontology.md"]],
  },
  uncertain: {
    title: "效果待对账", brief: "实际写入不明 · 暂停重复尝试",
    detail: "若调用动作后无法确认是否生效，当前动作停在待对账状态，等待人工核对。进入工具前已知未执行的情况与此分开处理。",
    fact: "定向回归区分调用前锁超时、调用后结果未知和再次领取。",
    links: [["查看受控恢复的设计", "../details.html#controlled-execution"], ["结果未知回归记录", proof + "CRM-027-ontology.md"]],
  },
};

const architectureLanes = [
  { label: "请求与执行", nodes: ["scope", "queue", "pi", "action"], summary: "工作台 → 队列 → Pi → 提案与执行" },
  { label: "口径与数据", nodes: ["ontology", "memory", "sql", "knowledge"], summary: "Pi 在许可范围内读口径、SQL 事实及知识原文。Mem0 命中回 SQL 核验。" },
  { label: "从运行记录到评测", nodes: ["trace", "rules", "semantics"], summary: "SQL 记录 → 运行轨迹 → 规则 → 可选语义复核" },
];

const stateLanes = [
  { label: "取证、审批和完成", nodes: ["queued", "working", "waiting", "executing", "done"], summary: "排队 → 取证 → 等待审批 → 执行并回查 → 完成" },
  { label: "停下来核对", nodes: ["evidence", "rejected", "uncertain"], summary: "取证不足、提案被拒或执行效果不明，各自进入下面对应分支。" },
];

const statePaths = {
  all: {
    label: "全部路径", node: "waiting",
    hint: "排队后取证。只读任务可直接完成，阶段动作经过审批。对应下方三条分支分别保留异常与拒绝。",
    nodes: Object.keys(runStates),
  },
  inspect: {
    label: "只读取证", node: "working",
    hint: "读取已有业务事实并保存来源。证据充分时，可从取证直接完成。",
    nodes: ["queued", "working", "done"],
  },
  approve: {
    label: "人审与执行", node: "waiting",
    hint: "先生成提案并记录审批，实际执行以后再回来回读商机状态。",
    nodes: ["queued", "working", "waiting", "executing", "done"],
  },
  stop: {
    label: "停止与复核", node: "evidence",
    hint: "缺证时保留可确定部分。提案被拒时不写入，写入效果不明时等候对账。",
    nodes: ["queued", "working", "waiting", "executing", "evidence", "rejected", "uncertain"],
  },
};

const architectureEdges = [
  { from: "scope", to: "queue", kind: "normal" },
  { from: "queue", to: "pi", kind: "normal" },
  { from: "pi", to: "action", kind: "approval" },
  { from: "pi", to: "ontology", kind: "read", direction: "down", depth: .36 },
  { from: "pi", to: "sql", kind: "read", direction: "down" },
  { from: "pi", to: "knowledge", kind: "read", direction: "down", depth: .36 },
  { from: "action", to: "sql", kind: "approval", direction: "down", depth: .76, toOffset: 16 },
  { from: "memory", to: "sql", kind: "read" },
  { from: "sql", to: "trace", kind: "normal", direction: "down", depth: .42 },
  { from: "trace", to: "rules", kind: "normal" },
  { from: "rules", to: "semantics", kind: "read" },
];

const stateEdges = [
  { from: "queued", to: "working", kind: "normal", routes: ["inspect", "approve", "stop"] },
  { from: "working", to: "done", kind: "read", direction: "bypass", routes: ["inspect"] },
  { from: "working", to: "waiting", kind: "approval", routes: ["approve", "stop"] },
  { from: "waiting", to: "executing", kind: "approval", routes: ["approve", "stop"] },
  { from: "executing", to: "done", kind: "normal", routes: ["approve"] },
  { from: "working", to: "evidence", kind: "stop", direction: "down", routes: ["stop"] },
  { from: "waiting", to: "rejected", kind: "stop", direction: "down", routes: ["stop"] },
  { from: "executing", to: "uncertain", kind: "stop", direction: "down", routes: ["stop"] },
];

const svgNS = "http://www.w3.org/2000/svg";
const wireKinds = ["normal", "read", "approval", "stop"];

function edgePath(mapBounds, nodes, edge) {
  const start = nodes.get(edge.from).getBoundingClientRect();
  const end = nodes.get(edge.to).getBoundingClientRect();
  const midX = bounds => bounds.left - mapBounds.left + bounds.width / 2;
  const midY = bounds => bounds.top - mapBounds.top + bounds.height / 2;
  if (edge.direction === "bypass") {
    const source = midX(start);
    const target = midX(end);
    const base = start.top - mapBounds.top - 1;
    const bridge = base - 22;
    return `M ${source} ${base} V ${bridge} H ${target} V ${base - 3}`;
  }
  if (edge.direction === "down") {
    const sourceX = midX(start);
    const targetX = midX(end) + (edge.toOffset ?? 0);
    const sourceY = start.bottom - mapBounds.top + 1;
    const targetY = end.top - mapBounds.top - 4;
    const turnY = sourceY + (targetY - sourceY) * (edge.depth ?? .54);
    return `M ${sourceX} ${sourceY} V ${turnY} H ${targetX} V ${targetY}`;
  }
  return `M ${start.right - mapBounds.left + 2} ${midY(start)} H ${end.left - mapBounds.left - 5}`;
}

function drawEdges(wires, map, nodes, edges, path) {
  const bounds = map.getBoundingClientRect();
  wires.setAttribute("viewBox", `0 0 ${bounds.width} ${bounds.height}`);
  for (const previous of wires.querySelectorAll(":scope > path")) previous.remove();
  for (const edge of edges) {
    const line = document.createElementNS(svgNS, "path");
    line.setAttribute("d", edgePath(bounds, nodes, edge));
    line.setAttribute("class", `wire wire-${edge.kind}`);
    line.setAttribute("marker-end", `url(#${wires.id}-${edge.kind})`);
    if (path !== "all" && !edge.routes?.includes(path)) line.classList.add("dimmed");
    wires.append(line);
  }
}

function boardMarkup(board, lanes, paths) {
  const key = board.id + "-wires";
  return `
    ${paths ? `
      <div class="diagram-filters" role="group" aria-label="选择运行路径">
        ${Object.entries(paths).map(([slug, { label }]) =>
          `<button type="button" data-path="${slug}" aria-pressed="false">${label}</button>`
        ).join("")}
      </div>
      <p class="path-hint" role="status"></p>` : ""}
    <div class="diagram-map">
      <svg aria-hidden="true" class="diagram-wires" id="${key}">
        <defs>${wireKinds.map(kind => `<marker id="${key}-${kind}" class="arrow-${kind}" viewBox="0 0 10 10"
          refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0L10 5L0 10z"/>
        </marker>`).join("")}</defs>
      </svg>
      ${paths ? '<p class="diagram-shortcut">只读取证可直接完成</p>' : ""}
      ${lanes.map(({ label, nodes, summary }) => `
        <section class="diagram-lane" aria-label="${label}">
          <h3 class="lane-title">${label}</h3>
          <p class="lane-summary">${summary}</p>
          <div class="lane-nodes">${nodes.map(id => `<button type="button" class="diagram-node"
            data-node="${id}" aria-pressed="false" aria-controls="${board.id}-detail"></button>`).join("")}</div>
        </section>`
      ).join("")}
    </div>
    <div class="diagram-key" aria-label="图例">
      <span class="key-normal">执行</span>
      <span class="key-read">读取与核验</span>
      <span class="key-approval">人工审批</span>
      ${paths ? '<span class="key-stop">停止与复核</span>' : ""}
    </div>
    <figcaption class="diagram-detail" id="${board.id}-detail">
      <div class="diagram-description" role="status">
        <h3></h3><p></p>
      </div>
      <div class="diagram-evidence">
        <p></p>${board.hasAttribute("data-inline") ? "" : '<div class="case-links"></div>'}
      </div>
    </figcaption>`;
}

function mountDiagram(selector, definitions, lanes, edges, defaultNode, paths) {
  const board = document.querySelector(selector);
  if (!board) return;
  board.innerHTML = boardMarkup(board, lanes, paths);
  const map = board.querySelector(".diagram-map");
  const wires = board.querySelector(".diagram-wires");
  const nodes = new Map([...board.querySelectorAll("button[data-node]")].map(node => [node.dataset.node, node]));
  const filters = [...board.querySelectorAll("button[data-path]")];
  const hint = board.querySelector(".path-hint");
  const detailTitle = board.querySelector(".diagram-description h3");
  const detailText = board.querySelector(".diagram-description p");
  const fact = board.querySelector(".diagram-evidence p");
  const links = board.querySelector(".diagram-evidence .case-links");
  let path = "all";

  function selectNode(id) {
    const definition = definitions[id];
    for (const [key, node] of nodes) node.setAttribute("aria-pressed", String(key === id));
    detailTitle.textContent = definition.title;
    detailText.textContent = definition.detail;
    fact.textContent = definition.fact;
    if (links) {
      links.replaceChildren(...definition.links.map(([text, href]) => {
        const link = document.createElement("a");
        link.href = href;
        link.textContent = text;
        return link;
      }));
    }
  }

  function renderPath(id) {
    path = id;
    const selection = paths[id];
    for (const filter of filters) filter.setAttribute("aria-pressed", String(filter.dataset.path === id));
    for (const [key, node] of nodes) node.classList.toggle("dimmed", !selection.nodes.includes(key));
    hint.textContent = selection.hint;
    selectNode(selection.node);
    drawEdges(wires, map, nodes, edges, path);
  }

  for (const [id, node] of nodes) {
    const title = document.createElement("strong");
    const brief = document.createElement("span");
    title.textContent = definitions[id].title;
    brief.textContent = definitions[id].brief;
    node.append(title, brief);
    node.addEventListener("click", () => selectNode(id));
  }
  for (const filter of filters) filter.addEventListener("click", () => renderPath(filter.dataset.path));
  if (paths) renderPath("all");
  else selectNode(defaultNode);
  const redraw = () => drawEdges(wires, map, nodes, edges, path);
  new ResizeObserver(redraw).observe(map);
  redraw();
}

mountDiagram("#architecture-board", architecture, architectureLanes, architectureEdges, "pi");
mountDiagram("#run-board", runStates, stateLanes, stateEdges, "waiting", statePaths);
