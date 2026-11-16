# CRM-022f 三条 Run 的投递中断与追踪回读

2026-11-16 在 CRM-022 隔离环境选定校准自动协作、批准重试、拒绝后 Worker 恢复三条既有 Run。先用隔离 PostgreSQL 确定应有追踪和业务指纹，再分别记录正常消费者投递、首次不完整回读、ClickHouse 存储修复和受限补投。校准父任务为 `partial`，其三个已持久化子任务均计入追踪范围。回读验证执行链可见性，业务终态及恢复验收另行记录。相关范围见 [CRM-022 规格](../CRM-022-spec.md) 和 [批准与续跑证据](CRM-022e-reliability.md)。

| 固定样本 | Root Run | 原 spans 事件 | 预期稳定 span ID | `crm.call` / `crm.model` / `crm.tool` | `crm.specialist` |
| --- | --- | ---: | ---: | --- | ---: |
| P01 auto 校准 | `226e385c-aff1-4f89-b72e-79a21e878452` | 9 | 31 | 5 / 11 / 11 | 3 |
| R1 批准后瞬时错误 | `581f2e34-b233-4419-84a9-4aa361200cc4` | 3 | 13 | 2 / 5 / 5 | 0 |
| R2 拒绝后 Worker 恢复 | `bd6d4035-1fc5-4561-9473-5beb9f1fdaef` | 3 | 15 | 2 / 6 / 6 | 0 |
| 合计 | 3 root | 15 | 59 | 9 / 22 / 22 | 3 |

每条追踪另有一个 `crm.run`。追踪生命周期覆盖 3 root 和 3 child，三个子 Run 的 `parent_run_id` 均指向对应根。原 spans 的父链为 `run → specialist → call → model/tool`，无专家的调用直接挂在根。每个 Run 的 `crm.call` 去重数量与对应 `llm_calls` 计量行数相同，后者采用产品聚合口径。

## 暂停、首次投递与存储故障

- UTC `07:53:39.171` 的首次快照有 15 条指定原事件待消费。R1/R2 各返回 HTTP 200 且未见 span，校准 trace 返回 HTTP 422，故此时全部远端可见数未知。
- 隔离业务 Worker 暂停后，仅通过 `3415` 实际 cron 路由顺序驱动集成消费者。UTC `07:54:14.434` 至 `07:54:49.669` 共 28 次 HTTP 200，整条集成 lane 完成 25 条、死信 0，最后三次扫描为空。这 25 条包含其他事件，本表只核固定 15 条 spans 事件。
- UTC `07:56:13.243` 首次投递后快照的 15 条事件全部 `done` 且有产品 Langfuse 消费标记，payload SHA-256 及固定样本业务指纹与前值相同。此处业务指纹覆盖已有 Run、作业、模型计量、提案、商机及阶段活动。P01、R2 的回读结果为 0/31、0/15，R1 返回 HTTP 422。回读失败报告与 `pending=0` 均予保留。
- 三个旧 trace 的限定诊断分别测试 v2 仅 traceId、v2 整秒范围、v1 仅 traceId，观测到 422/422/404。与此同时，本机 Langfuse Worker 在 UTC `07:54:31` 的消费日志显示 ClickHouse 异步插入超过原 1 GiB 总内存限制，估算需 1.57 GiB。这提供了独立于 HTTP 确认的存储层失败证据。消费完成与 ClickHouse 持久化必须分别核验。
- 只调整复用原卷的本机 CRM ClickHouse，cgroup 从 1,536 MiB 提至 3,072 MiB，服务器实际 `system.server_settings` 上限为 2,415,919,104 字节。扩容后的只读预检三条 v2 均 HTTP 200，依次 0/31、0/13、0/15。观察窗口内未见这批旧 span 自动恢复，原 CRM outbox 指纹保持。

## 补投和最终回读

从只读事务读取与冻结快照完全一致的 15 条原 SQL 事件，校验组织、隔离库身份、事件 UUID、所属 Run、payload SHA-256、原状态、消费标记和 attempts。只补投含缺失 span 的原事件，保留原 trace ID 和 span ID，逐条先持久记录 intent，再调用产品 `exportLangfuseEvent`，每条至多一次、间隔 3 秒。UTC `08:02:06.893` 起记录意图，`08:02:49.578` 收到最后一条接受回执，15/15 被本机 OTLP 接受。补投前后原 outbox 的状态、消费标记、次数和 payload 指纹等值，此操作未重新排队、未新建 Run、未调用模型及未执行 CRM 写动作。

UTC `08:03:28.778` 启动最终只读回查。三条原 trace 的 v2 查询均 HTTP 200，实际 31/31、13/13、15/15，总计 **59/59**。逐个稳定 span ID、名称、父 ID 检查，缺失、额外、父链或名称不匹配均为 0。各 span 的 `input` 和 `output` 字段均显式存在且为 `null`。离线验证器再次确认校准根有 3 个真实 SQL specialist child，并在同 trace 找到 3 个挂在对应根 span 的 specialist span。最终同批业务指纹及 15 条原 payload 哈希保持，待消费 0。固定样本仍为 3 root、3 child、5 个作业和 9 条 `llm_calls`。

校准 trace `f1bc55e11cc496165cfaa17a0f6c0f20` 的三个专家 span 均以根 span `0086cba9759cabc9` 为 `parentObservationId`。

| SQL specialist Run | 实际终态 | `crm.specialist` span ID |
| --- | --- | --- |
| `3dba4abc-11e8-4f1c-8b3a-48fd467b095a` | `completed` | `c41598ae0e0cedfc` |
| `68d66e02-bb98-4918-86fa-d06e2f82e0cc` | `completed` | `a49cce3649aeb5c6` |
| `e5f30283-6e1a-4232-89e8-57464777a8f3` | `partial` | `0fc6770b69740415` |

从暂停快照到最终成功回读启动为 589.607 秒，包含诊断、运维和等待间隔。此次观测覆盖本机固定样本的恢复、清单及父链，未测长期容量、吞吐或故障自动恢复成功率，也未执行 Judge 或评分覆盖测试。

证据封存后，于 UTC `08:06:01.345` 删除本轮临时覆盖，恢复容器 1,536 MiB 与服务器 1 GiB 上限，再确认原 CRM ClickHouse 健康。原配置相同负载仍可能触发内存不足，本次证明了扩容并补投原事件的恢复路径。复核截图或私有报告时可直接使用下面的成功快照。

## 封存文件

主要私有产物在 `.local/crm022/reliability/29041bec-f0db-49b6-b362-44e140a6755f/`。冻结计划由 `scripts/eval/crm022-reliability-telemetry-plan.mjs` 从校准 HTTP 收据和两条 Worker 故障报告组成，`scripts/eval/crm022-reliability.mjs` 的 `delivery-before` / `delivery-after` 读取 SQL 和实际本地 Langfuse v2。冻结计划和各次失败收据保留原字节。

| 证据 | SHA-256 |
| --- | --- |
| `trace-cohort-index.json` | `1cd9571cf613475c3279d202386c3c2ecd1c72d922f975b0b3972b262de834fb` |
| `plan-delivery-cohort.json` | `1dfa176f66f34f81284780b0ee9ee068805fcc0a8bb72fffa762babc2826721f` |
| `delivery-before.json` | `a34357e436ac5ea22596ed4543d0ab211e7f510bb30c193e534400172cec63a7` |
| `.local/crm022/delivery-ticks-1794815654434.jsonl` | `2adc2e3c72b46e83ffa15d60aa0ac83fd17ec1f8388cfd26cb9885c24db70aba` |
| `delivery-after-report-1794815773834-7142992a-ae8d-4101-a224-cb56ba5cb7aa.json` | `75ef06043a947d9f8b340156c93171a1e38e1b0e3bb32102bcb1dbccb791f902` |
| `delivery-diagnostic-1794815993743-ede38d41-f601-49dc-988b-aa28e487cdfd.json` | `0e7174a3731aca88ee7a2441c77736d029e284a60eb75d27869cd63bd1601359` |
| `delivery-preflight-1794816102080-d1a70966-aeea-4fb0-93f7-9ca17a5fd6cb.json` | `ad0311b11fd4243955ec5fe0569f6141b0544f64618a36ec5e526045fd892675` |
| `delivery-replay-intents.ndjson` | `2598460bd9e9954833598de075bbc865055bb7a7807e208f5658fb9976953518` |
| `delivery-recover-1794816172603-d1e0695a-5638-4594-98fa-39873ebbfba8.json` | `6bbacea7d7a488978be014030bf1f6f1e21af76a8468e4959c049af5b82a3a37` |
| `delivery-after-report-1794816209396-8c20f122-f2e7-404d-baf0-82add25b7191.json` | `d0c72a52a88c0f6b679490ea3fb5336cc2e8a929d60263bfbc5825b2d80d20d8` |

补投仪器 `.local/crm022/reliability/replay-original-telemetry.mjs` 的 SHA-256 为 `c07679f7991e45a29f57b381ca5a752af8739fccc503f77df73c87771929170c`。对照仪器 `.local/crm022/reliability/trace-readback-diagnostic.mjs` 的 SHA-256 为 `c596992733fa83ae01cad7bec3edfea798f2269093690bbbbb9affa34ce41399`。最终报告可由 `scripts/eval/crm022-reliability-telemetry-plan.mjs verify` 按冻结 cohort 和报告哈希离线复核，复核不读数据库和网络。
