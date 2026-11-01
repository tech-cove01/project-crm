# CRM-021d：同商机准入、复核时钟与真实双连接验证

2026-11-01。按 [CRM-021 新授权](../CRM-021-spec.md)补齐 [CRM-020e](CRM-020e-collaboration-review.md)留下的不同商机、人工 cutoff 和数据库竞争证据。当前五个固定组分别有范围内通过证据，来自三次执行：前两次按首个失败停止，最后一次仅完成剩余 P04/P05；不是一次运行全部通过，也不覆盖所有分布式执行路径。**原 020 未完成结论、首轮时钟产品失败与后继私有仪器失败均保留，没有合并进旧分母或改写旧结果。**

## 旧验证器与本批实际发现

020 的两次最后试验未完成：第一次把 `crm_leads.tags` 的 `text[]` 当 jsonb 查询；第二次在预期 P0001 后没有恢复外层事务，后续查询失败。两份原报告均已回滚，不能从中推导异商机或双连接通过。

本批预先固定五组及自有合成 UUID。预期门禁探针每次单独 `SAVEPOINT`，无论产品函数是否在内部捕获 P0001，探针都执行 `ROLLBACK TO` / `RELEASE`，避免返回 true 的同时遗留 aborted transaction。没有通过回拨数据时间掩盖时钟边界。

第一批实际执行于 HEAD `52908d28cfe05028083592f2f5101a9dfc50e79b`。计划头保留了更早 prepare 时的 `6740fe2`，另有执行 context 明确区别实际 HEAD；产品相关文件哈希预检通过，不声称当时为准备头对应的干净基线。P01 通过，P02 暴露真正的产品缺陷，随后按计划停止，未进入 P03–P05。

P02 的旧 Run 实际创建于 PG 时间 `06:25:06.022437+00`；Node 写入复核 cutoff 为 `06:25:06.121Z`。旧 pending 已取消、旧 Run 及 cutoff 等值被阻断、不同商机未误取消，但复核返回后按 PG 当前时钟创建的新 Run 为 `06:25:06.087779+00`，比 cutoff 早 33.221 毫秒，被 `collaboration_new_run_required` 错拒。这里证实的是 **Node 时钟领先 PG 时，复核后新任务被误判为旧任务**，不是这次旧 pending 未取消。人工设置的 `cutoff+1µs` 语义探针通过，不能替代这个自然新任务失败。

## CRM-021d1：同事务数据库时钟修复

产品修复提交 `0994828c73c2462ffcc8426e59be8ae77a7adc56`。`persistCollaborationReview` 在同一个 PG client/事务中完成商机锁、Run 锁、权限状态和 revision CAS 后，读取：

```sql
select to_char(clock_timestamp() at time zone 'UTC',
  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as checked_at;
```

六位微秒原文同时用于 review.checkedAt、旧 pending proposal 取消和 reply draft 失效边界；不经过 JS Date，不截成毫秒。读不到时钟即在任何 review/proposal 更新前抛错回滚。无需修改 0412、DDL 或 baseline。

开发者记录的 11 项直接回归与限定 ESLint 通过，独立审查确认 fake host Date=2036 时仍保持 DB=2026 的六位微秒，并核对两个取消语句使用相同原值、时钟缺失不更新。以下真实 P02 对受影响行为另外复查；单元替身与真实 PG 分列。

## 五组证据与实际次数

每次执行均先冻结源码、预期、全新自有 contact/两个 lead、Run/proposal UUID 和原报告哈希。没有重批历史提案。单连接准入/cutoff 的临时行外层回滚；真正双连接所需的自有种子显式提交以保证另一 backend 可见，取证后按固定组织、UUID、marker、scope 和合成标记核对清理。

| 组 | 实际观察 | 通过来源与范围 |
| --- | --- | --- |
| P01 同/异商机准入 | 同商机含大写 UUID 的独立 Run 被挡；不同自有 lead 放行；受挡 effect 回调 0 次，SQL 批准返回 P0001。 | 第一份 `d2f4fb…` 报告通过。后两次只按原哈希继承，未重跑。 |
| P02 人工复核 cutoff | 同商机旧 pending 取消，异商机 pending 保留；旧 Run 与精确 cutoff 等值拒绝，自然新 PG 时点及单独 `cutoff+1µs` 探针放行。 | 时钟修复后 `557881…` 通过。原 `d2f4fb…` 的 naturalNewAllowed=false 保留，不被覆盖。 |
| P03 review 先行 | backend 80654 实际在 advisory lock 等待 80655；review pending 提交后，effect 重新准入被拒、回调 0 次，阶段和活动数不变。 | `557881…` 通过；保存了 `pg_stat_activity` 和 `pg_blocking_pids`，不是仅用等待时长推断竞争。后续未重跑。 |
| P04 effect 先行 | backend 80867 实际 advisory 等待 80866；先行效果完成已知回执，释放事务后 review 继续为 pending。handler 调用 1 次，stage_changed 活动增量 1，proposal executed。 | `d28332…` 通过，限有序暂停下的两 backend 锁顺序与已知回执。此前 `557881…` 已取得等待证据，但因私有格式守卫拒绝 SQL 未完成，单独保留。 |
| P05 同提案双 claim | backend 80867 实际 transactionid 等待 80866；claim 结果 true/false。仅 winner 进入 handler 一次，活动增量 1，executed 回执和 `crm_state_changed` 事件各 1；重复 finish 返回 null。 | `d28332…` 通过，限受控重叠窗口中同一个新 proposal 的认领、效果与结果记账；不等于任意外发 exactly-once。 |

修后 P02 的 PG cutoff 为 `2026-11-01T06:29:03.306157Z`，自然新 Run 为 `06:29:03.333552+00`，六项预期全部成立；Node 同时为 `06:29:04…Z`，已不参与边界判断。自然新行使用当时 PG `clock_timestamp`，因为外层实验事务的 `now()` 固定在事务起点；精确等值/+1µs 比较另列，未用 `greatest(clock,cutoff+1µs)` 人为制造自然样本通过。

P04/P05 使用同一个本批自有 lead `84676e28-6333-42ae-a67f-92b6c5b36043`：P04 初始阶段→目标阶段，P05 目标阶段→初始阶段，各自一个独立 proposal/一次效果，共两个受控阶段效果。两组之间只删除本组专用 review 控制行以隔离下一组，不处理业务复核或 020 原行；最终这两个效果、活动、控制 Run/proposal 及种子均随精确清理移除。

## P04 仪器失败与有限技术复查

第二次执行的 P02/P03 已通过，P04 真实等待已出现，随后 `executeApprovedWorkbenchTool` 报固定脱敏错误。离线核对确认私有守卫只识别未带 schema 的 SQL，而真实 `pgComoSupabase` 生成 `update public."crm_leads" …` / `insert into public."crm_lead_activities" …`。正常第一条 UPDATE 被私有 allowlist 拒绝，不能称产品死锁或已知回执失败；当次即停止并清理，P05 未进入。

获准后仅修私有守卫，严格识别完整固定 `public."crm_leads" set` 和 `public."crm_lead_activities" (` 标识符，保留自有 lead 参数约束及活动组织约束。lead 的组织归属先由合成种子核对和真实 handler 读取校验，UPDATE 仍按产品实际的全局唯一 ID/更新时间过滤，不捏造其 SQL 中不存在的组织参数。

离线验证用真实 PG bridge 搭配纯内存 query recorder 生成两条实际格式 SQL：2 个正例及 13 个反例通过，拒绝其他 schema、近似前缀表名、错误大小写标识符、额外语句/注释、错误 lead、活动错误组织。该检查执行 SQL=0、网络=0，不是增加一次业务尝试。

第三次新计划仅有 P04/P05，新 UUID；P01/P02/P03 的实际代码块均不再执行，只继承先前 pass 的原报告哈希。未改产品、旧报告或失败分母。

## 实测能力与不能外推的边界

- 两个连接确为不同 `pg_backend_pid`，保存了阻塞方/等待方和 advisory/transactionid 类型；顺序由受控 barrier 固定，所有路径有连接、statement、lock 和 barrier 超时。不是随机压力测试或所有锁排列的穷举。
- 准入、复核、认领及 finish 使用产品 helper/真实数据库函数。阶段效果走真实 `crm_move_lead_stage` handler 和 PG-to-Supabase 测试传输，受控效果事务内使用绑定 client/SAVEPOINT；不是 HTTP/PostgREST、RLS 或所有跨连接工具传输路径的证明。
- specialist claims/outcome 是预先声明的受控输入；本组没有模型、真实 child 结果或父模型汇总。`childRunIds` 为控制输入，不冒称真实三专家运行证据；实际协作模型验收另属 021b。
- P04 的 approved 状态为控制种子；P05 的 claim 为 agent 在授权测试中调用 helper，不是真人点击或鉴权 HTTP 批准。当前验证不替代用户角色、渠道权限的 HTTP 验收。
- `auditMcpToolCall`、审计 sink 和 admin `emit_event` RPC 显式替身化；最终两组记录 audit=4/RPC=2 为模拟接口次数，不是真实外部调用或完整审计/观测链。stage/activity、proposal/Run 和 `crm_state_changed` 等所列产品事务 SQL 为真实。
- 控制夹具故意不建立 continuation，known result 保存后返回 partial/`resume_state_missing`，不插入 job、不续跑模型。这里的 partial 是事先声明的夹具边界，不能称正常审批续跑已通过。真实批准/续跑另属 021a。
- service 级 PostgreSQL 传输绕过 RLS，未做外部渠道、真实崩溃、分布式一致性、所有在途 RPC 原子 fence 或生产稳定性验证。0412 已声明的在途 SQL/RPC 与复核登记窗口不因这些样本消失。

三次执行均报告 cleanupVerified=true、originalUnchanged=true；最后实际 HEAD 为 `0994828c73c2462ffcc8426e59be8ae77a7adc56`，执行后公开工作树仍干净。这里只核所列 SQL 投影：原 020 商机仍为初始阶段 `83e3b1e9-aea2-4792-85c1-10717a0f93cf`、更新时间 `2026-11-01 05:10:51.756746+00`、描述 hash 不变；组织 `llm_calls=52`、job 总数 49、pending/running=0 前后相同。不是整库 hash 或永久状态承诺。

所有执行 HTTP attempts=0、无断连异步错误、无模型/Judge 请求；未操作知识资料、其他项目、服务或镜像。本批阶段效果仅发生在明确自有的新 lead，所有私有结果和旧失败原文保留。

## 私有计划、原失败与报告哈希

以下位于忽略目录 `.local/crm021/concurrency/`，不提交凭证或本地数据。

| 文件 | SHA-256 |
| --- | --- |
| `plan-4d1b2c19-8727-4e77-adc3-81aab5d4fae9.json` | `511b6f2eb9b7500e03d5dab0682d6c2424c0a458826f070d1baf642f4da2705f` |
| `result-4d1b2c19-8727-4e77-adc3-81aab5d4fae9.json` | `d2f4fb9068e2b179e32ffc60b6c535184c53c77aab6b74facbbbd0ff7adb5f89` |
| `execution-context-4d1b2c19-8727-4e77-adc3-81aab5d4fae9.json` | `06424f7dbd8d77a6f81b71b53537f453dc064ea5b288c84e0fd5a6ddd39954f1` |
| `plan-c0d9d5ab-b350-44cd-83e3-e5f3cfd95db9.json` | `ce7fbd5cf0f44aec3f08927625fc815f8b5143789daf0f5f0a2e9c1134790206` |
| `result-c0d9d5ab-b350-44cd-83e3-e5f3cfd95db9.json` | `55788112dabe69989dbb766b5d5d961b088b4db8e2d96f0a5e6b5a332a3cd985` |
| `plan-250ca997-28d8-432b-9c1a-3359e63e5185.json` | `e2cba142da13d79f4d81efa30fed81cd558309eb3caca2e1e39e52b1cdc5703c` |
| `result-250ca997-28d8-432b-9c1a-3359e63e5185.json` | `d28332205ccfb07ad54b97bc87993de07defbb78390555344bf4aba0ed8f5893` |

020 原两份失败报告的 SHA-256 为 `17db2c2e0652ac7e909724889798ee4df67343d8329873db514c2d9d1c970f1a` 与 `5c53a87b0848b6b3bcf9be302a02bee752af684b709f0ea392c29edc8a28e78f`，均由新计划逐次锁定校验，原文件未改。私有 `attempt1-source/`、`attempt2-source/` 保留已执行仪器字节，修正只发生在新计划前；各次排他 intent 不覆盖或重放。

本项补得的是当前基线下这五组有限证据，DB 时钟缺陷已独立修复并实际回查；原 020 unknown/blocked 作为当时结果保留。是否满足整批 CRM-021 批准、协作和检索目标，需分别看各票实际结果，不由本项代替。
