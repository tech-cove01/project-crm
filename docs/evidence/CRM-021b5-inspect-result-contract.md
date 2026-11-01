# CRM-021b5：只读任务的结果唤醒合同

2026-11-01。记录本次新发现、模式合同修复及直接验证；本切片完成时真实后继尚待冻结。后续1ddb失败及最终有限复查见[真实协作证据](CRM-021b-collaboration-verified.md)，不覆盖旧失败。

## 原因

干净源码 `05783852d50c7b548af275d51c765b5fdb0608f1` 的 root `6cda51ec-f059-4cdf-b2a6-8eed92f71c97` 中，三 child 均 completed、摘要非空且缺口为空；客户/商机各成功读取一次，政策精确搜索 CSV/审批各一次。021b3 的单记录两轮、政策三轮实际生效。

父任务却提交 `human_approval`。本次 inspect 无业务提案，实际守卫返回 `accepted=false/approval_proposal_missing`；随后没有被接受的结果，父任务 partial/empty_final_answer。原严格检查器的 `parent_unobserved_source` 是最终文档缺失所致，不能据此说模型已提交伪造引用。没有 pending review、提案或阶段效果，源材料和两次旧失败均未改变。

私有目录为 `.local/crm021/collaboration-isolated/330ebbef-bf46-4f0a-99c3-b58cae2054c6/`。plan SHA-256 `c283c88ff45d0acd72b23e2e175056e7d541f0d1ecff96c390ea0c4dea4300e4`，frozen `cff7972fa8fd8b1d0a4049090b4d03807daafe49ebbe8ccd36cf2510ef158b0f`；`source-1793517130906-35004ecb-a4ea-4dc3-ac88-7ce0a6187720.json` 为 `48db0c6d86894a7560d1a5341110a4ef03fbdd196662bf7ba5fe781766b0e393`；`review-1793517131129-89286681-b9d8-4508-8038-38640175873b.json` 为 `431e1d94e45738272647df36957e6c502e4f6ce3361ff8e070fb3fbe9fbd56d5`。这些材料保持原字节。

## 最小修改

`createWorkbenchResultChannel` 接收现有运行 mode。inspect 不能暂存业务提案，因此其输入 schema 从一开始就不提供 `human_approval`，并说明已完成只读复盘用 `none`，未来动作所需批准不是当前待审。provider 可见和 handler 复核使用同一模式 schema；初始与续跑均传入 mode。

act/未传 mode 的兼容合同、实际待审提案守卫、持久结果文档 schema 和全部权限/预算保持不变。inspect 的非法枚举是真实输入格式错误，可使用既有预算内 schema 纠错；没有把 `approval_proposal_missing` 业务拒绝加入重试名单，没有自动改写模型参数、清除失败或创建提案。

## 直接检查

四个直接相关测试文件共 **31 passed**：`workbench-result-submission.test.ts`（通道与 Pi adapter 两处）、`workbench-start-job-memory.test.ts`、`resumed-workbench-turn.test.ts`。命令为 `node node_modules/vitest/vitest.mjs run <上述四路径> --exclude '.local/**' --maxWorkers=1 --reporter=dot`，TEMP/TMP 指向本仓 `.local/crm021/vitest-temp`，未调用真实模型或 SQL。

覆盖 inspect provider 可见枚举、即便旧待审查询返回 true 也不能用 inspect 提交 human_approval，以及当前 Pi 0.86.1 真实 schema 拒绝后在原两轮窗口改为 none；兼容 act 的无提案业务拒绝继续 partial，实际暂存才允许等待。五个变更源码/测试文件的限定 ESLint 通过。初次 typecheck 发现条件 Zod schema 的联合类型过度缩窄，显式声明公共输出类型后全仓 typecheck 通过；实际 inspect 校验未放宽，不需重复模型或修改 schema 值。

独立代码审查通过：模式 schema、初始/续跑接线、act 兼容及原纠错预算无阻断。后继真实模型已另行冻结并逐次保留结果，见[真实协作证据](CRM-021b-collaboration-verified.md)；6cda原失败与1ddb的独立缺口不被改写为通过。
