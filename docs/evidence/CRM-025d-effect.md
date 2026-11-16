# CRM-025d 同题复测与效果对照

本批冻结 24 个合成业务场景，由真实 Qwen、CRM 数据和 Wiki 执行。B0 指 `2d5d411` 首次测量，S 指 `59da3c4` 共同范围补丁，C 指唯一候选 `1561dac`。检索对照使用 B0 与 C。工作台同条件对照使用 S 与 C，D01/D02 的 B0 四根单列诊断。[修前完整封存](CRM-025b-resumption.md) · [唯一候选和开发对照](CRM-025c-candidate.md)

## 保留集一次 Worker 中断与原 Run 对账

候选保留集第 13 槽 H07 三专家的原 POST 为 201。已落库三份专家结果，父运行在只读 `crm_search_knowledge` 开始后失去本批 Worker。原进程退出且端口没有监听，退出原因尚未确认。首次观察到达 300 秒上限并保存原意图与未决回执。原选定业务对象、提案、外发及其他已观察业务效果均无变化。

同一个候选、同一隔离配置启动新 Worker。队列原生回收租约，处理同一个 Job 的第 2 次尝试，同一原 Run 最终 `completed`，原作业 `done`。未创建替代 Run 或专家。原结果归档保持 `safe=false`，因为首次尝试的三条只读调用没有足以复核的持久化回执，其中两条有结束事件，一条只有开始事件。首次返回内容不可复原；原业务快照与同一 Run／Job 已完成独立技术核对。该槽占用原计划槽及实报用量，按环境事故不纳入同条件答案分母。首次父调用未持久化用量仍为未知，续评入场按冻结预算额外预留 36,000 token，预留单独记录。

| 本地技术回执（`.local/crm025/candidate/`） | SHA-256 |
| --- | --- |
| `worker-loss.json` | `ef0dc926889660d960918f8888286a0d889d38b0bcea9689dd68b5856259063f` |
| `worker-loss-assessment.json` | `765ec92d479da21a1bda6361065c7f6df9f0216e861a01149b8b99397db9fb48` |
| 原 `holdout/H07-auto-result.json` | `4b47b40829849b7431d65566e44a5d07c8f69a57e8c8caabea88ff7a95757eab` |
| 原 `holdout/H07-auto-meter.json` | `af0b69b3cea89e760ad370df3cd06443b09a660b3b908ea3019dcdef629be9ba` |
| 追加 `recovery.json` | `f6898eaeae558329cd914fa026cbce6cf9f68b906ec247ac4474086ddafc379d` |

追加清单绑定唯一候选和槽、原意图与所有回执哈希、独立只读复核，以及获准更改的三份运行与封存脚本。实报 5 行模型、22,970 输入和 2,688 输出保持原语义。其余槽继续校验原要求；模型、产品代码和评分规则仍为同一冻结版本。已通过对真实事故归档的离线回读，剩余槽从原顺序继续。

## 跟进写入已阻断与回执复核

候选保留集第 21 槽 H11 的模型请求尝试了 `crm_schedule_followup`。Workbench 的 `inspect` 分支在调度写入处理器或创建提案前返回内置拒绝。原工具结果保留完整控制文本，同一个 call ID 有唯一请求和响应，但持久化的 `isError=false` 且事件标签为 `success`，早期采集据此归为未知写入并暂停。

两次只读复核直接核对了原 CRM 业务快照、跟进排程存储、MCP 写入处理器审计、审批、业务事件和外发，结果均无效果。本槽照计一次被拦截写请求、原 `partial` 与全部用量。原 `safety_stop` 的结果和计量保持留档；单独的技术投影仅纠正这条已证实的拒绝。该 `auto` 未建立专家子任务，因实际臂不符仍不属于主效果分母。

`candidate/inspect-denial-assessment.json` SHA-256 `a36c45ac18fb0a2636ccdbefaa7eb701c1dadca97a4c3a48df0eaea9d85c3215`。原 `candidate/holdout/H11-auto-result.json` SHA-256 `8b6bc1a3a271efb80cfc8a553c573410f03b6c9183c3d2fa53552b307674eb57`。未重新提交、未改应用或评分规则。

追加 `candidate/recovery-h11.json` SHA-256 `a3853e4ad2ae3a79ec9ea4bf616373a250976ff7ed3bc3a81053163562f001eb`。追加清单校验 H07 原恢复记录及 H11 的唯一守卫回执，原冻结 C 未改变。离线验证使用实际 H11 原字节确认写请求计数仍为 1、已阻断 1、未知效果 0、实际执行臂不符，并通过定向测试与独立审查。其他槽仍沿用原来的审计和安全停止。

随后 H11 单 Agent 的原运行遇到同一标志错配，原 `partial`、原作业第 1 次执行和原 `safety_stop` 原字节均保存。独立核验再次得到业务快照不变、守卫原文一致、跟进排程及写入处理器投递均为 0。该臂的 `validArm=true`，随其余结果按同一评分规则盲评。原 `holdout/H11-disabled-result.json` SHA-256 `8a37e02f822b22c13b5eb49d2e8365bc6cbc8b187d91059bd3e9e81b188545ed`，同范围只读证明 `inspect-denial-disabled-assessment.json` SHA-256 `00fb3c7cf8f878212939a432afceb59938310c9aadb5718a6d3cca80eddccd32`。

第三份追加回执 `candidate/recovery-h11-disabled.json` SHA-256 `921d1509619e53ae3a9778b9279be7f2ec56a4e3a545e89cae1e39f4fa8eb587`，前两份回执及候选冻结同时回读通过。两份技术投影各保留一次写请求、一次明确阻断及 `partial`，保留各自真实执行臂。后续遇到同样的 `crm_schedule_followup` 形式时，仅在真实 `inspect` 根、选定对象匹配、精确同 call ID 回执及同一 SQL 快照证实零排程和零处理器投递后纠正观察分类。原工具消息和事件仍留档。17 项 runner、12 项评分与封存定向测试及独立审查通过。
