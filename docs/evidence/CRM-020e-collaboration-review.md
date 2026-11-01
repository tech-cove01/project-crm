# CRM-020e：协作复核与动作阻断的受限交付

2026-11-01。规格见 [CRM-020](../CRM-020-spec.md)。本项已用完两轮产品修复额度，**未取得完整通过结论**：实现、离线检查和第一轮受控 PostgreSQL 三切片有证据；0412 最终数据库竞争试验因私有验证器问题未完成，相关项保留 unknown/blocked。没有为补齐结果追加模型运行或第三轮修复。

## 首轮复现与第一轮实现

在修改应用前，调用原有 `BoundedAgentCollaborationRuntime` 执行一次 normal/conflict/failure 的纯离线受控输入，另检查同一知识库中两页 WeKnora 资料的身份。执行器输出及内存 Store 明确属于验证替身，不证明真实模型、HTTP 或数据库持久化。

- 正常互补信息、单个 specialist 失败的既有聚合成立。
- 两个结构化字段值及 revision 不一致时，原 runtime 仍返回 `complete`，冲突只进入事件和父模型上下文。
- WeKnora 的 `locator.sourceId` 是整个 CRM 知识来源，revision 是一页观察 manifest 的哈希；按 source 比较会将不同页面误判为同页版本变化。

冻结入口 `.local/crm020/collaboration-baseline-session.json`；计划 SHA-256 `4916aed7a3cf791eb6ac8992bbc2800177f5e2071d7c22704b7c9574b091e836`，首次来源 SHA-256 `18bffaee32d66f99f3c0e32ef72fcc6af90033e58e31c681cfa37c2dccbed399`。原始结果保留。

第一轮增加独立的 `ai_workbench_runs.collaboration_review`，不放入会被模型续跑整体写回的 `runtime_state`。发现冲突或子任务缺口后，先持久化 pending，再按受影响 CRM 对象或 Wiki receipt 各重读一次；无法证明当前事实时维持 pending，父汇总最多 partial。child 原始结果不覆盖，当前观察的身份、版本和字段哈希单独记录。

0411 已由主执行者局部应用，无 reset；迁移 SHA-256 `31757475ff0847238dfc396738f341617f1d133202690a17da1450c2497126f6`。实际权限为 authenticated 不可执行守卫、service_role 可执行。初始 baseline 追加块曾在当前 PG 内连续应用两次后回滚，函数内容与迁移等效；未执行整个 baseline。该历史验证仅对应 0411，不代表后来 0412 的完整重装验证。

第一轮真实 PG 验证使用单连接、生产 helper 与数据库函数，内部事务由 SAVEPOINT 包装，最后外层 ROLLBACK；specialist 输出及来源不可用故障为受控注入，无模型、HTTP、Judge 或 job：

| 切片 | 实际观察 | 范围 |
| --- | --- | --- |
| normal | 三个 inspect child 行完成，父聚合 complete | 注入输出加真实 PG 持久行，非三角色模型验收 |
| conflict | partial/pending；业务写回调未进入；SQL 批准被 P0001 拒绝 | 0411 的本 Run 门禁 |
| 重新取证 | 当前 PG 字段复核后 resolved，原 pending proposal 取消，动作执行数 0 | 负责人身份由 agent 代提交，不是真人点击；原 child 哈希不变 |
| failure | 两个 child 完成、一个失败；父 partial，缺口和 pending 保留 | 注入子任务故障 |

报告 `.local/crm020/collaboration-pg-64a1da63-be80-4829-a005-a9448a675150-result.json`，SHA-256 `2f7b75e94dc40c7b02524975f02ff1223aed94bac11fdcc8a2972cf3f4f972cd`。临时行全部回滚，合成商机的阶段、更新时间和描述哈希前后相等。

## 独立审查阻断与第二次、最后一次修复

审查发现 0411 的两个重要缺口，不能由上述三切片 pass 掩盖：同商机新建独立 Run 可绕过旧 pending；复核先 advisory 后 Run 行锁，而已批准动作落回执先 Run 行锁再由 proposal trigger 等 advisory，存在锁顺序反转风险。

0412 前向迁移保留 0411 原文件，完成以下窄修正，并同步 fresh-install baseline 等效块：

- 准入按同组织同商机比较，Mission 使用真实 `lead_id`，standalone scope UUID 规范为 `uuid::text`，避免大小写旁路。
- 实际写入 wrapper 与复核先取相同商机 advisory lock；数据库准入函数和 proposal trigger 只做状态查询，不再在持 proposal 行锁后等待该 advisory。
- 已 `approved` 动作的 `executed` 回执属于事实记账，不作为新的执行准入；自动可逆写的执行回执移到写入 fence 内保存。
- 人工重新取证取消该商机旧 pending proposal/draft；带 reviewedBy 的复核时间形成新任务边界，早于该边界的旧 Run 不能重造提案或执行，必须另建任务重新取证。自动重读消解没有 reviewedBy，不错误阻断当前正常汇总。

0412 已局部应用，SHA-256 `7f5908b1e02bfc121a76df072722c801ed11fc50cd659b6eefa9bff5029bd076`；实际函数纯查询及权限检查有主执行者回执，未改 0411。PostgreSQL 文档支持一致锁序与事务 advisory lock 的设计依据，但不能代替本机并发验收。[官方锁文档](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-DEADLOCKS)。

## 最终 PG 试验未完成

冻结的最后试验包含同商机大写 UUID 阻断、异商机正对照、取消旧 pending、旧 Run 新造提案拒绝、新任务允许，以及两个真实 PG 后端有序暂停的回执/复核竞争。

1. 第一次执行在选取异商机对照时发生验证器 SQL 类型错误：`crm_leads.tags` 是 `text[]`，脚本误用 jsonb 操作符，SQLSTATE 42883。checks 为空，全部 ROLLBACK，未进入门禁或竞争断言。报告 `collaboration-final-0eac178b-8789-47a3-992f-53b189b587b1-result.json`，SHA-256 `17db2c2e0652ac7e909724889798ee4df67343d8329873db514c2d9d1c970f1a`。
2. 经授权只修私有选样类型，保留首次脚本快照并按原预期新冻结计划，作一次技术重试。`sameLeadUppercase=true` 成立；下一项异商机查询得到固定 `collaboration_review_read_failed`，全部 ROLLBACK。验证器把 production 独立查询放在同一个外层事务中，预期 P0001 被捕获后没有恢复该事务，后续读失败符合事务已失败的解释；原异常被脱敏，不能声称已捕获具体后续 SQLSTATE，也不能将它解释为产品错误阻断了异商机。报告 `collaboration-final-2180c3c9-73b2-4ad3-b20f-e1ee8eef7f28-result.json`，SHA-256 `5c53a87b0848b6b3bcf9be302a02bee752af684b709f0ea392c29edc8a28e78f`。

没有再次技术重试、改变预期、追加产品修复或改旧报告。两连接竞争分支尚未进入，没有可报告的真实后端 PID/无死锁通过证据；0412 的异商机正对照、旧任务边界及竞争项保留 unknown/blocked。

## 实现入口与已完成检查

| 调用点 | 当前实现 |
| --- | --- |
| `collaboration.ts`、`collaboration-runtime.ts` | 原有三角色与预算、Mission 最大并发 1 保留；未解冲突聚合为 partial，WeKnora 按 provider/KB/page 身份比较 manifest |
| `workbench-collaboration.ts`、`workbench-collaboration-review.ts` | 持久 child 后登记复核、有界重读、CAS 和来源重授权；child 历史与当前事实分开 |
| `workbench-start-job.ts`、`run-resumed-workbench-turn.ts` | 父模型只读汇总，未解复核不随 completed 放行；直接可逆写使用业务守卫 |
| `workbench-approved-action.ts`、decision/undo routes | 审批准入及真正进入工具前检查；拒绝、取消和已知/未知效果回执不伪装成新执行 |
| `POST /api/v1/ai/workbench/runs/{id}/collaboration-review` | manager 与组织授权、复核版本 CAS、理由；只允许 `decision=reread`，不执行旧动作或调用模型 |
| Run 详情与 `CollaborationReviewPanel` | 实际计划/child、待复核状态、当前观察身份/哈希及仍授权的知识链接；按钮明确不执行动作 |
| `weknora.ts` | 仅补 KB/page/slug 元数据用于身份比较，未改变检索策略 |
| 0411/0412、`supabase/baseline.sql` | 独立 review 列、同商机准入及 fresh-install 接线；service-role-only 写入不扩大 authenticated 权限 |

最终直接相关离线测试 **9 文件、63/63** 通过，包含原有 Pi 续跑、初始上下文、工作台会话/委托，以及新增冲突、UUID 等价、DB 失败阻断、API 权限/CAS 和只读复核 UI。ESLint 限定 22 个相关文件：0 error、1 个测试未使用参数 warning；diff 检查通过。最终全仓 typecheck 由主执行者统一记录，本报告不提前称通过。

## 可用范围与仍未知的边界

已有实现和离线检查支持：三个只读角色的既有接线、partial/缺口保留、独立持久复核字段、重新取证而不直接执行的 API/UI，以及各动作入口的 fail-closed 接线。0411 单连接受控 PG 三切片与 0412 同商机 UUID 等价拒绝均有各自范围内证据。

**不能宣称 CRM-020e 整项通过、0412 竞争验证通过或三角色真实模型全链路通过。**真实只读 normal Run 如由总批次后续执行，须独立记录，不能补写本次未执行的冲突/竞争分支。数据库/RPC 已在途动作与 pending 登记之间仍有窗口；复核 CAS 只保护 review revision，重新读取后 CRM 事实仍可变化；不承诺全路径原子 fence、外发 exactly-once、所有历史结论实时撤销或生产稳定性。

本项以受限结果停写；两轮额度已经用尽，进一步恢复这些 unknown/blocked 需要用户另行选择。
