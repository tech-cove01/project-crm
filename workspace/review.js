let pickedRun = "example";
let omitSource = false;
let checked = false;

function exampleRun() {
  return { caseId: "ridge", kind: "ontology", mode: "read", proposal: "none", source: { caseId: "ridge", id: "ACT-1121" } };
}

function matchedRun(m) {
  return m.state.agent.runs.find(({ no }) => String(no) === pickedRun) ?? exampleRun();
}

function deterministicChecks(run, deal, logs) {
  const hasEffect = ["executed", "verified"].includes(run.proposal);
  const expectedSource = run.kind === "memory" ? (run.memoryMatch ? deal.message.id : null) : deal.meeting?.id ?? null;
  const cited = omitSource ? null : run.source;
  const executions = logs.filter((item) => item.id === deal.id && item.kind === "executed").length;
  return [
    ["保留所选客户范围", !cited || cited.caseId === deal.id, `当前记录绑定 ${deal.company} · ${deal.title}`],
    ["返回对应来源", (cited?.id ?? null) === expectedSource, expectedSource
      ? (cited ? `记录来源 ${cited.id} · 对照来源 ${expectedSource}` : `检查输入缺少来源标识 ${expectedSource}`)
      : "当前记录没有命中事实或约见，不要求编造一个来源。"],
    ["只读或缺证不写入", (run.mode !== "read" && run.proposal !== "blocked") || !hasEffect,
      hasEffect ? "该记录通过受控阶段执行路径。" : "当前记录没有写入回执。"],
    ["已执行提案只有一次执行", !hasEffect || (run.mode === "controlled" && executions === 1),
      hasEffect ? `同客户的本地执行事件数为 ${executions}` : "当前记录没有执行，等候、拒绝和只读均不生成执行回执。"],
  ];
}

function reviewSelect(m) {
  const runSelected = matchedRun(m);
  return `<label class="selector"><span>选择要检查的记录</span><select data-control="review-run">
    <option value="example">恒远能源 · 只读取证示例</option>
    ${[...m.state.agent.runs].reverse().map((run) => {
      const deal = m.deals.find(({ id }) => id === run.caseId);
      return `<option value="${run.no}" ${runSelected.no === run.no ? "selected" : ""}>RUN-${String(run.no).padStart(4, "0")} · ${deal.company} · ${run.kind === "memory" ? "记忆读取" : "商机取证"}</option>`;
    }).join("")}
  </select></label>`;
}

export function reviewScreen(m) {
  const run = matchedRun(m);
  const deal = m.deals.find(({ id }) => id === run.caseId);
  const rows = deterministicChecks(run, deal, m.state.logs);
  const total = rows.filter(([, passed]) => passed).length;
  return `${m.heading("演示检查", "对照工具来源、客户范围及实际动作，定位哪一步缺少凭据。", '<a href="#runs" class="button">查看本次运行</a>')}
    <section class="panel review-panel">
      <div class="panel-heading"><h2>检查一条运行记录</h2>${m.label("本地规则")}</div>
      <p>选择现有运行或只读示例。省略来源用于对照，原始运行与业务数据仍保留。</p>
      <div class="review-controls">${reviewSelect(m)}
        <label class="review-omit"><input type="checkbox" data-control="review-omit" ${omitSource ? "checked" : ""}> 对照缺失来源的情况</label>
        ${m.button("review-run", "运行检查", "button-primary")}
      </div>
      ${checked ? `<section class="review-result" aria-label="本次检查结果"><div class="panel-heading"><h3>本次检查结果</h3>
        ${m.label(`${total}/${rows.length} 项符合`, total === rows.length ? "green" : "gold")}</div>
        <ul>${rows.map(([title, passed, reason]) => `<li><div><strong>${title}</strong><p>${reason}</p></div>${m.label(passed ? "符合" : "需复核", passed ? "green" : "red")}</li>`).join("")}</ul>
      </section>` : ""}
    </section>
    <section class="panel review-history">
      <div class="panel-heading"><h2>正式应用的公开验证</h2><a href="../details.html#validation">查看完整结果和边界</a></div>
      <div class="review-evidence">
        <article><h3>检索覆盖</h3><p>合成保留题找全全部必需材料为 4/48 → 44/48。该结果与答案质量分开记录。</p><a href="../details.html#retrieval-comparison">查看同题对照</a></article>
        <article><h3>确认与跨会话记忆</h3><p>核对同客户的确认、更新、撤回和同名客户隔离。记录保留原模型和版本。</p><a href="../details.html#memory-comparison">查看真实跨会话记录</a></article>
        <article><h3>引用与失败回放</h3><p>用四条原浏览器导览中的评测案例，查看错误引用如何触发规则失败。</p><a href="../demo/index.html?scenario=evaluation&amp;guide=1#/app/ai/workbench">打开完整回放导览</a></article>
      </div>
    </section>`;
}

export function handleReview(action) {
  if (action !== "review-run") return undefined;
  checked = true;
  return "已核对该次运行的范围、证据和动作。";
}

export function handleReviewChange(event, m) {
  const ctrl = event.target.dataset.control;
  if (ctrl === "review-run") {
    const { value } = event.target;
    pickedRun = m.state.agent.runs.some(({ no }) => String(no) === value) ? value : "example";
  } else if (ctrl === "review-omit") omitSource = event.target.checked;
  else return false;
  checked = false;
  return "检查条件已变更。";
}

export function resetReview() {
  pickedRun = "example";
  omitSource = false;
  checked = false;
}
