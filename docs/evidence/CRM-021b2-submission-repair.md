# CRM-021b2：有界提交纠错与专家引用边界

2026-11-01。当前记录实现和离线回归，**本修复尚未执行新的真实模型 Run**。[规格](../CRM-021-spec.md)与原 CRM-020 失败保留，不把新修复改写为旧样本通过。

## 新一次真实失败揭示的问题

在清洁源码 `0994828c73c2462ffcc8426e59be8ae77a7adc56` 上，新协作 root `995e7150-6f62-434e-b94a-cca327987787` 的三个 child 已产生非空摘要：政策 634、商机 975、客户 878 字符，各有证据和 claims；但父任务仍 partial/empty_final_answer，result_document=null。

成功工具观察后的唯一结果提交被 Pi 工具 schema 拒绝：`evidence.1.assertions` 实际有 5 项，而合同上限是 4。被拒提交的参数回显还把公司资料源 UUID 当作 knowledge 证据引用；该参数不是已接受的结果文档。客户、商机专家分别多调用了会话列表、跟进列表，超出本次明确的最小角色任务。没有业务提案或阶段变化。

父任务有两条聚合 LLM 记录，已有结果恢复代码会额外调用一次仅提交工具的模型，并固定 `maxSteps=1`。旧封存投影没有保存 `resultRecovery` 字段，不能仅凭两行断言唯一 schema 错误发生于哪一阶段。因此本次同时覆盖主循环末尾窗口和提前普通文本退出后的恢复路径，不读取 assistant 私有续写来补证。

私有 source：`.local/crm021/flows/27292d16-cba1-45fc-bf98-393a5c9b4e33/collaboration-source-1793515161115-0de8160b-b5f4-4452-85d1-2f8005fba64c.json`，SHA-256 `0aee34ec8992343f4de37a70456fdfefaad8ea76cb48786738d7d79e793b5d85`。原 review SHA-256 `46f9782d40ad136e05b5f451cce430a4ee07d35d6fd00ff3cc2e0ebbc37800a8`。原脚本、计划、frozen、Run 和失败报告均未覆盖。

## 行为变化

父任务初始执行与续跑使用可选 `finalTurn.reserveTurns=2`，在原总轮数内提前进入仅结果提交的窗口。剩一轮时收敛为这一轮，不追加轮数。仅实际工具 schema 拒绝或明确 `invalid_schema` 能使用第二次机会；接受即停，缺提案等业务拒绝、普通文本或其他错误不能触发第二次尝试。工具仍与当前可用集合求交集，权限、取消和预算停止继续生效。

原 `recoverWorkbenchResult` 同样只进行一个 gateway 调用，允许的模型 turn 至多为 `min(2, maxRemainingSteps)`。在原剩余 tokens 内先预留重复上下文、失败参数回显和有用输出；余额不足时降为一轮或 skip。第一轮之后再按实际 usage 和下一轮上下文估算决定是否继续；未知且受限的费用仍保守 skip。provider 分词可能不同，这不是精确计费预测或全路径原子预算保证。没有提高 assertions 上限、自动删掉模型提交的第五项、无限重试或增加 CRM 工具。

协作上下文改为明确的类型引用映射：真实 child UUID 对应 `specialist.sourceId`；实际返回的知识证据 UUID 对应 `knowledge.sourceId`，WeKnora 另显示同值 `receiptId`。`providerSourceId` 仅作资料源定位，不能冒充回执；CRM 工具调用键不再列作可引用对象 UUID。递归 claim 中可能出现记忆或 owner ID，不将它们错误标成 contact/lead。每条 evidence.assertions 仍最多 4 项，无成功观察原值时省略。

机会复盘计划 revision 从 2 升为 3。客户专家只读已选联系人，只有已选会话时才暴露该会话历史；商机专家只读已选商机，不再自动扩展会话枚举或跟进列表。父 Agent 仍保留原会话、跟进调查能力。专家接收的原组织 systemPrompt 全文保留，另明确通用销售清单不能扩大本次专职目标；职责主题不等于必须逐项读取的清单。缺 scope/无取证仍 partial，真实失败与冲突不能被简短输出抹去。这是通用职责分配变化，没有按题号、Run ID 或本机产品品牌分支。

## 离线验证与文件

两组共 **118 passed、1 skipped**，涉及 13 个测试文件。排除项为原有真实 OpenCode Zen 测试；其余使用当前 Pi 0.86.1、本地脚本化 provider 或隔离存储替身，没有新模型、SQL、HTTP 或服务操作。

第一组 70 passed：runtime-final-turn、workbench-result-recovery、workbench-collaboration、collaboration-context、collaboration、collaboration-runtime、workbench-start-job-memory、resumed-workbench-turn、workbench-result-submission。第二组 48 passed/1 skipped：原 runtime、ai-sdk-compat、Pi workbench-result-submission、workbench-collaboration-review。两组命令均为 `node node_modules/vitest/vitest.mjs run <上述对应测试路径> --maxWorkers=1`，第二组加 `-t '^(?!.*OpenCode Zen)'`；TEMP/TMP 指向 `.local/tmp`。

直接检查包括：真实 Pi 的 5 项断言拒绝后改为合法 4 项；两次 schema 失败即停；业务拒绝与普通文本不重试；重复上下文余额不足时降一轮/skip；提前预算停止；剩一轮时 clamp；组织策略保留；无 scope 的 partial；typed 引用不混淆 provider ID、回执和嵌套记忆 ID。17 个变更源码/测试文件限定 ESLint、`git diff --check` 及合并全仓 typecheck 通过。根独立审查确认只用公开工具结果判断 schema 拒绝、原工具白名单/预算/审批保护保留，无阻断；新真实 Run 仍另行验收。

实现文件为 `lib/agent-runtime/types.ts`、`schema-rejection.ts`、`pi/runtime.ts`；`lib/ai/agents/collaboration.ts`、`collaboration-runtime.ts`、`workbench-collaboration.ts`、`workbench-result-recovery.ts`，以及父 start/resume 的末尾窗口接线和 result-submission 的一条说明。其余改动为对应直接测试；没有更改 CRM-021a2 的待审展示逻辑。

后续须冻结新基线和新只读 Run。可复用未变化的合成商机 `88f0e2e0-1091-432f-a188-0dcc92e47382`，明确该商机已有上述失败 root，不重新执行旧 Run，不新建或批准业务提案。新的角色结果、父提交、typed 证据、真实缺口和计量需逐项验收；离线回归不能证明模型必定成功或全答案语义真值已校准。
