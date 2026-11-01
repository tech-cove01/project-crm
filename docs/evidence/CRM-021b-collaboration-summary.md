# CRM-021b：协作摘要的有界收束

2026-11-01。本页记录初次实现与离线回归。随后真实 `995e7150…` 已有三份非空 child 摘要，但父提交仍因 schema 断言超限被拒，角色也存在多读；[021b2](CRM-021b2-submission-repair.md)继续修复，不能用本页离线通过宣布协作主链成功。沿用 [CRM-021 规格](../CRM-021-spec.md)，[CRM-020 D01 原失败](CRM-020c-main-chain.md)及其原始摘要、终态和分母保持不变。

## 根因与修复

旧 D01 的三个 child 各消耗 3 个模型 turn、产生 3 个工具观察，summary 都是空字符串、missingMaterial 都为空，却被保存成 completed。执行器只检查工具错误和部分缺口，未将空摘要列为缺口。`maxTurnsPerSpecialist=3` 没有为摘要保留一轮；相同范围不得重复读取仅由提示约束，旧商机专家实际重复读取过跟进列表。

父任务原销售预算为 12 轮，扣除 child 的 9 轮后仅剩 3 轮。父任务又在这 3 轮中进行了 4 次读取，既没有终答，也没有调用结果提交；原有恢复函数因没有剩余轮数不能再补调用。这解释了父任务 partial/empty_final_answer，不将工具成功当作摘要已生成。旧客户专家的一次结构化拒绝还包含 `permitido=false`，虽然消息没有设置 isError，也不能当成成功取证。

新增可选 `finalTurn` 契约，在既定最大轮数内把末轮切换为收束阶段：child 不暴露工具，输出基于已有观察的正文；父任务初始执行和续跑只保留 `submit_workbench_result`。使用当前已安装、锁定的 Pi Agent Core 0.86.1 的 `prepareNextTurnWithContext`，同时更新 provider 可见工具声明和实际执行工具集合。白名单只与当前可用工具取交集，不能引入未暴露工具；已有权限、评测只读、取消和预算提前停止回调继续生效。不增加轮数、模型预算或额外兜底请求。

空白摘要保存为 partial，并记录 `specialist_summary`；重用历史空摘要时只降低本次内存中的结果状态，不重写旧 child 或重新调用模型。`permitido=false`、`ok=false`、显式 error/isError 的观察不能形成成功证据或 claim，缺口保留。没有从工具正文拼出替代摘要。

父任务收束保留 [CRM-021a 的实际提案约束](../CRM-021-spec.md)：末轮提交如果被拒绝，不能自动创建提案、放宽审批或补写成功，仍按缺失结构化结果/空终答等既有原因 partial。模型若提前结束、输出无效或触发预算停止，也不保证收束成功。

## 离线检查

使用当前安装的 Pi Core 与本地脚本化 provider，直接验证了末轮可见工具与实际执行集合、已有观察保留、单轮余额、提前停止，以及移除工具的幻觉调用不能执行。另核对空摘要的持久状态、旧空摘要不被重写、结构化拒绝不伪装成功、父任务初始/续跑接线、结果提交成功和审批提交被拒后的 partial。

以下三组共 **71 passed、1 skipped**，涉及 9 个测试文件；唯一排除项为原有真实 OpenCode Zen 测试。本轮没有 provider HTTP、数据库、业务动作或服务操作。

```powershell
node node_modules/vitest/vitest.mjs run lib/agent-runtime/pi/runtime-final-turn.test.ts lib/agent-runtime/pi/ai-sdk-compat.test.ts lib/ai/agents/collaboration-runtime.test.ts lib/ai/agents/workbench-collaboration.test.ts --maxWorkers=1
node node_modules/vitest/vitest.mjs run lib/agent-runtime/pi/runtime.test.ts -t '^(?!.*OpenCode Zen)' --maxWorkers=1
node node_modules/vitest/vitest.mjs run lib/agent-runtime/pi/workbench-result-submission.test.ts lib/agent-runtime/pi/resumed-workbench-turn.test.ts lib/ai/agents/workbench-start-job-memory.test.ts lib/ai/agents/workbench-result-recovery.test.ts --maxWorkers=1
```

上述测试进程将 TEMP/TMP 指向本仓 `.local/tmp`。15 个变更源码/测试文件的限定 ESLint 与 `git diff --check` 通过。最初新增夹具误把 context 而非 context.messages 传给 Pi 的 getCurrentTools，导致 2 项失败；修正夹具后重跑原组通过，不涉及真实模型或业务重试。根统一全仓 typecheck 首次发现 `Agent.prompt` 的联合类型无法匹配重载，拆成行为一致的 if/else 调用后重查通过。独立代码审查核对当前安装 SDK 与实际 provider/执行工具交集、空结果及预算路径，无阻断；真实业务另验。

## 文件与后续实测边界

- 契约与 Pi 适配：`lib/agent-runtime/types.ts`、`lib/agent-runtime/pi/runtime.ts`、`lib/agent-runtime/pi/ai-sdk-compat.ts`、`lib/agent-engine/edge/llm/run-model-call.ts`。
- 协作结果：`lib/ai/agents/collaboration-runtime.ts`、`lib/ai/agents/workbench-collaboration.ts`。
- 父任务接线：`lib/ai/agents/workbench-start-job.ts`、`lib/ai/agents/run-resumed-workbench-turn.ts`。
- 7 个变更测试文件：Pi runtime-final-turn、ai-sdk-compat、resumed-workbench-turn、workbench-result-submission，以及 collaboration-runtime、workbench-collaboration、workbench-start-job-memory。

旧私有快照 `.local/crm020/D01-snapshot-1793511540216-39227cb8-39c3-4ac5-b8d5-1148120078cf.json` 的 SHA-256 再核为 `15831040a244584b5f0dafb1e6653ac2de2a023b89e792b17d4f2a78d21c3f05`。只读取已封存工具观察、公开最终文本及允许的计量元数据，没有读取 opaque continuation。

下一步需独立冻结新的真实运行及来源版本，沿用原角色任务约束：客户只读确认事实、商机读取所选对象、政策查询 CSV/审批；核对非空 child 正文、证据与缺口、父提交、实际调用和预算，并明确失败。child 仍继承现有 Agent 的组织与系统策略，本次没有改写成另一套角色框架；真实验证是否仍暴露指令张力需按实际结果记录。离线测试不证明 Qwen 必定完成汇总，也不覆盖 CRM-021d 的数据库并发验证。
