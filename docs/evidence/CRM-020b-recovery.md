# CRM-020b：有限执行恢复分支

日期：2026-11-01。对应 [CRM-020](../CRM-020-spec.md) 的 P1-3 恢复场景。本次只执行一次冻结计划，以真实 PostgreSQL、产品 helper 和受控故障核验三个代表分支；没有调用模型、Judge、HTTP 接口或全局 reconciliation，没有启停 Worker。

## 结果

| 分支 | 实际观察 | 判定 |
| --- | --- | --- |
| R01 重复决定与回执 | 第一次批准认领成功，第二次认领为 false，之后拒绝返回 null；一次已知的执行前安全失败完成回执，重复完成返回 null。该提案 SQL 中续跑 job 和 `run_resumed` 各 1 条。 | pass，仅顺序重复，不代表批准/拒绝并发竞争。 |
| R02 业务效果后回执未保存 | 真实阶段变更 handler 调用 1 次，数据库实际阶段变更，`crm_lead_activities` 的 `stage_changed` 记录增量为 1。随后在产品 finish helper 的续跑入队前注入一次异常，内层事务回滚，提案仍为 `approved/executing`，未保存执行结果或续跑 job。 | pass，命中固定故障点。 |
| R02 未知结果不重放 | 调用既有 `markWorkbenchApprovedActionUncertain`，Run 为 `partial/approved_action_outcome_unknown`，提案为 `failed`，结果注明 `reconciliation_required/effect_may_have_completed`；续跑 job 与事件均为 0。再次认领为 false，阶段快照不再变化，SQL 活动增量仍为 1。 | pass，不把 failed 解读为“业务肯定未发生”。 |
| R03 迟到执行的前置检查 | 精确旧 `locked_at` 相差 1 微秒后，既有租约检查拒绝；恢复当前测试锁后检查可通过。再将该测试 Run 取消，租约检查与批准动作的 current 检查均拒绝，计划中的后续业务回调计数为 0。 | pass，限这些检查时点。 |

实验结束后外层总事务回滚；验证用 Run 均不存在，主商机所记录字段快照及阶段活动计数恢复。结果为 `rolledBack=true`、HTTP 尝试 0、异步数据库错误 0、验证器错误 null。一个直接测试承载上述三个固定分支，实际执行通过；不是新增三个模型任务。

## 方法与安全范围

运行前固定本机数据库端口 `55422`，核对本批客户的 synthetic/batchId 元数据、商机描述中的精确 marker、合成标签、组织/客户/漏斗关联和当前模型配置，并确认该组织业务队列空闲。阶段变更只在本批两个固定阶段之间进行，选取执行前快照的另一阶段，所有改动均回滚。

验证用 Run、提案、状态和 job 在同一连接的外层事务内建立，其他 Worker 看不到这些未提交记录。产品 helper 的内层事务映射为 SAVEPOINT；预期拒绝检查也各用 SAVEPOINT 回滚，避免 PostgreSQL 错误将外层事务留在 aborted 状态。回执故障仅注入一次，不重放业务工具。

真实 MCP 工具桥、`crm_move_lead_stage` handler、阶段更新、阶段活动插入、批准/拒绝/完成/unknown helper 及租约查询执行；查询传输适配为同一 pg 连接。辅助 audit 和 admin `emit_event` RPC 传输被抑制，所有 HTTP 调用被禁用。因此不能把这份报告称为真实 HTTP 崩溃、完整审计投递或真实 Worker 进程恢复验收。

## 证据与版本

- 私有冻结计划：`.local/crm020/recovery-plan-d6be4ce1-bd30-4146-bcac-e70d5b97e250.json`，SHA-256 `331608a95c2642b4fd038a5cdb2dea3248cd283b53e2b1eff3c12a0831cee1f0`。
- 一次执行结果：`.local/crm020/recovery-d6be4ce1-bd30-4146-bcac-e70d5b97e250-result.json`，SHA-256 `d58d9e35e02c0a2aa8aa32ef8d50412e42077d6865ad26a40379124a11f0a090`。
- 使用 [对象范围负例](CRM-020b1-target-scope.md) 的独立 CRM 授权子清单，SHA-256 `5a5b0a0d2cdfed0c84779dadaa373d696bcf446b93251e892686f467654a8d45`；本次计划另锁定产品源码、验证器及 0412 迁移文件哈希。执行时源码 HEAD 为 `9fb0d5cfc8395544523b99fda932db7be0f3934d`，具体运行版本以计划中的逐文件哈希为准。
- 验证器已在执行前由另一 agent 独立静态审查，语法/help 检查通过；根 agent 统一执行的全仓 typecheck 已通过，没有为本实验重跑整套历史测试。连接配置、验证状态和原始细节只留本机。

本次三个恢复分支没有发现需要新增应用代码修复的缺陷。批准/拒绝并发竞争、真实进程中断及旧结果人工对账后的进一步业务处理没有由此证明；租约检查与业务写入之间的剩余窗口仍存在，不称原子 fence 或远端发送 exactly-once。

本实验独立于 CRM-020e 的协作复核竞争试验。020e 最后数据库验证的失败和 unknown/blocked 保留，不能用本次单连接恢复分支通过替代其不同商机、cutoff 或双连接锁竞争证据，也不据此将整个 CRM-020 标为完成。
