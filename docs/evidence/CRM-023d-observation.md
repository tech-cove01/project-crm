# CRM-023d 本机容量与观测验收

本票按受限结果收口。本机 ClickHouse 可选配置已应用并核验。两个独立首次投递窗口均完成，合计回读 39/39 个 spans、15/15 条规则分，15/15 个模型节点的起止、耗时和用量与原 payload 一致。单次重复投递后，Langfuse 在严格窗口内返回重复 ID，幂等回读未通过。规则分与任务评分分列。范围见 [CRM-023 规格](../CRM-023-spec.md) 和 [首轮存储故障证据](CRM-022f-observation.md)。

## 本机容量

首轮原配置为容器 1.5 GiB、ClickHouse 服务端 1 GiB。CRM-022f 当时的 Langfuse Worker 日志记录异步写入估算需要 1.57 GiB、超过服务器上限。CRM-023d 复用该轮恢复时验证过的 3 GiB 容器上限和 2.25 GiB 服务端上限，并提供可持续启用的本机叠加文件。原低内存后台合并、日志、查询块大小配置和数据卷继续使用。选项由实际负载验证后记录适用界限。配置见 [Compose 叠加文件](../../infra/local-agent-services/compose.langfuse-eval.yml) 和 [服务端配置](../../infra/local-agent-services/clickhouse-eval-capacity.xml)。

2026-11-16 UTC `09:06:13.721` 的预检显示宿主可用内存 7,745,020 KiB，Docker VM 总内存 16,572,067,840 字节。旧 ClickHouse `docker stats` 采样 1.385 GiB / 1.5 GiB，Langfuse Web 975.5 MiB / 1.5 GiB，Langfuse Worker 583 MiB / 768 MiB。本机采样无独立集成投递进程。已核实 `crm-agent-services` / `clickhouse` Compose 标签、原镜像和专属命名卷 `crm-agent-services_clickhouse-data`。

在仓根目录使用既有本机环境文件重建该项服务。命令未重建依赖、构建、拉取镜像或更换卷。

```powershell
docker compose --project-name crm-agent-services --env-file infra/local-agent-services/.env.generated -f infra/local-agent-services/compose.yml -f infra/local-agent-services/compose.langfuse-eval.yml --profile langfuse up -d --no-deps --no-build --pull never --wait --wait-timeout 100 clickhouse
```

24,646 ms 后 Compose 于 UTC `09:07:30.349` 返回健康。UTC `09:10:23.022` 核实镜像和命名卷保持相同，实际 `system.server_settings.max_server_memory_usage` 为 2,415,919,104 字节，Docker `HostConfig.Memory` 和 cgroup v1 的 `memory.limit_in_bytes` 均为 3,221,225,472 字节。ClickHouse 健康，Langfuse Web 公共健康接口返回 HTTP 200，Langfuse Web 和 Worker 保持此前启动的容器。再次扫描无独立集成投递进程。

同一采样的 ClickHouse `docker stats` 为 2.189 GiB / 3 GiB，Langfuse Web 为 977.2 MiB / 1.5 GiB，Worker 为 582.5 MiB / 768 MiB。ClickHouse cgroup 当前值 2,830,438,400 字节，重建以来峰值 2,975,539,200 字节，`memory.failcnt=0`。cgroup 值包含缓存，与 `docker stats` 读数采用不同口径，且这个峰值早于正式窗口。宿主空闲 5,843,180 KiB。当前只使用了一次配置尝试。

脱敏实测文件 `.local/crm023/observation/capacity-apply-1794820223089.json`，SHA-256 `bf576fb21612272c2c844c5ab33290caafd1d1dc4691109ac3b39b78ea5c2b8a`。重启时继续显式指定上述两个 Compose 文件可保留此本机配置。

## 两个首次投递窗口

普通 Worker 可以继续生产事件，保持本机专用集成调度器暂停。已冻结 root 的执行器仅消费匹配组织、关联 Run 和 payload 哈希的事件。若进程退出时事件仍为 `processing`，仅对原事件做只读对账并保留未知状态，不重跑窗口或打开全局集成投递器。入口见 [有限窗口执行器](../../scripts/eval/crm023-observation.mjs)。

### 窗口 1 · 新校准完成 Run

固定已完成的 CRM-023 X02-auto `c2f2389b-3498-4dea-a817-8d6ac531440b` 和三个终态专家子 Run。UTC `09:21:28.255` 至 `09:22:09.860`，经过约 41.599 秒，期间后一校准任务尚未生成。原 9 条 spans 事件均处于首次可消费状态，实际发请求前的 v2/v3 回读为空。一次明确 `deterministic_export` 返回 HTTP 200，关联第 10 条评分事件。10/10 被产品导出器接受，首轮持久化查询得到 **29/29 spans、8/8 CRM 规则分**。

- 29 节点包含 1 root、3 specialist、5 call、11 model、9 tool。全部核对稳定 ID、名称、父 ID 和输出隐私，缺失、额外、不匹配均为 0。11 个模型节点起止、计算时长、远端 latency 和实际 payload 的四项 usage 均 11/11 匹配。SQL 合计 5 个聚合计量行，输入 21,255、输出 2,340、缓存读 27,648、缓存写 0，5 条费用未知。SQL 计量行与远端模型节点记不同粒度。
- CRM 规则评分为 `needs_review`，总分 92，规则 profile revision 8，Judge `not_configured`。8 条远端分检查了原 score ID、名称、值、关联 trace/根 observation、输入指纹和规则版本。`needs_review` 原样保留。
- 已冻结业务指纹和所有目标 payload 都保持一致，scope 外 189 条原集成事件前后哈希完全相同，无新增。前后过程扫描均无专用集成调度器。两处 Langfuse 日志在固定窗口内内存不足错误行均为 0。UTC `09:23:11.463` 的后置资源快照记录该容器启动以来 cgroup 原始峰值触达 3 GiB，`memory.failcnt` 累计 1,596。该计数来自内核内存计费，成功回读和日志证据各自核对。这个负载下余量有限。

| 封存文件 | SHA-256 |
| --- | --- |
| `.local/crm023/paired/calibration-1/X02-auto-result.json` | `e6d3504e962270e22156f3d9e736d447c7c41d62ad59448ecabe7757561e4951` |
| `window-1-plan.json` | `61239bf56c866504510200cec64a37508a009c0383317638dfe8c55ec5e83086` |
| `window-1-report.json` | `45fc9616e93cfe1902e0bf2a4c48f351c410d14ef341ff8d494d5fdee3922e30` |
| `window-1-resource-1794820991489.json` | `dd884a78dbdbb59f4eed535966210cac777e69f46145979fa2874a0fea534b41` |

### 窗口 2 · 新校准受限 Run

第二窗口使用 CRM-023 M03-disabled `4ce0d746-19f6-4ee1-9fc4-b3afdf646589`。该 Run 在第一窗口关闭后于 UTC `09:29:24.244` 提交，终态 `partial/missing_material`，按冻结任务规则属于正确报告无匹配。第二窗口使用独立事件和 trace，UTC `09:31:26.017` 至 `09:31:39.876`，经过约 13.855 秒。发请求前 v2/v3 回读为空。原 2 条 spans 事件和 1 条 `deterministic_export` 产生的评分事件均被产品导出器接受，首轮查询得到 **10/10 spans、7/7 CRM 规则分**。

- 10 节点包含 1 root、1 call、4 model、4 tool。稳定 ID、名称、父 ID 和输出隐私通过，缺失、额外、不匹配均为 0。4 个模型节点的起止、计算时长、远端 latency 和四项 usage 与实际 payload 4/4 一致。SQL 1 个聚合计量行，输入 5,077、输出 1,367、缓存读 30,720、缓存写 0，费用未知。
- CRM 规则评分为 `needs_review`，总分 71，profile revision 8，Judge `not_configured`。远端 7 条按 score ID、名称、值、根 observation、关联 trace、指纹和版本匹配。两次评测的规则分均保留原 verdict，未调用语义 Judge。
- 业务指纹、原 payload 和范围外 228 条已有集成事件均保持，无范围外新增。两批原 spans 事件负载分别为 9 和 2 条，低于首轮 15 条故障负载。每批均明示执行间隔及有限队列范围。

| 封存文件 | SHA-256 |
| --- | --- |
| `.local/crm023/paired/calibration-2/M03-disabled-result.json` | `8c68332ee249426e9d4ee438c06643c50249e394117df278aa5116817e93694d` |
| `window-2-plan.json` | `ca6aeef9c36fb98991a5a60e872223b79fbaf41b9541a298c1cf081992d96ef0` |
| `window-2-report.json` | `0b8b39bf456b9902f1a627d072e7b69506c826385aa8f8b9ee8fe81373ba2baf` |

## 一次稳定 ID 复投 · 严格失败

两窗均通过后，从第二窗口选择一条原 spans 事件 `0ff79326-9a5d-4ee7-83f4-761eb30eb8cc`。原 payload SHA-256 为 `e7f367bc7b77f3bc6bc866fcda790692d6fcdf4ef2e5ea735cf3f0f0bf26b4f3`。UTC `09:32:08.493` 记录意图后，通过现有导出器进行一次原样 OTLP 复投，接口接受。CRM outbox 不重新排队。15 秒后开始只读回查，固定 60 秒内 9 次均报告 `langfuse_readback_duplicate_observation`。原始报告保留失败；其最终 SQL 对账因重复异常而未执行。

另做一次同 trace 的原生只读 GET，于 UTC `09:34:35.289`，距复投开始 146.796 秒，HTTP 200 返回 **19 行、10 个不同 ID**。被复投事件的 9 个原 ID 各出现两次，其余根 span 一条，无新增或缺失 ID。重复行的验证投影一致，名称、类型、父节点、起止、耗时及模型四项用量仍与原值一致，19 行 input/output 均显式为 `null`。以下 9 个 ID 与 SQL 中被复投事件的稳定 span ID 集合完全相同。

| 类型 | 重复出现的原 span ID（各 2 行） |
| --- | --- |
| `crm.call` | `ff99086712ef098a` |
| `crm.model` | `c6607701cbf72d14`, `d07d5701963eedc2`, `da41beab6ed72d35`, `ec8b0caa5142874b` |
| `crm.tool` | `0719c86982a97a79`, `23dc106825cdc491`, `b776575bf309af95`, `f62db0ea00376ff7` |

UTC `09:36:48.814` 单独用只读事务复核第二窗口。原业务指纹、唯一一行聚合模型计量和三条原 outbox 的状态、尝试次数、消费标记与 payload 哈希均保持。没有再复投或创建模型请求。最后一次限定回读仍重复，此后是否收敛未知。保留正常首次投递时的实际配置和读回结果，尚不能把稳定 ID 复投用于无需审核的自动去重恢复。首测负载较小且资源峰值已触及上限，未验证长期稳定性或吞吐。

第二窗口及从复投到单次诊断的两个固定区间内，Langfuse Web 和 Worker 的内存不足日志匹配均为 0。UTC `09:37:31.243` 的只读资源快照记录 ClickHouse 仍健康并挂原卷，cgroup 当前值 3,196,153,856 字节，容器启动以来累计峰值 3,221,225,472 字节和 `memory.failcnt` 29,673，独立集成调度器进程 0。累计值无法拆分归因于第二窗口或复投，重复观测根因未定。仅使用一次配置尝试。

| 封存文件 | SHA-256 |
| --- | --- |
| `idempotence-intent.json` | `939e6be65627d850fad1df6c8868f1049ebd1fddb13de87f2b8003a6d6ec69c3` |
| `idempotence-report.json` | `e8e3dde73f8a3a06bb98b1bb23f95b871a67829a0e6c92a1b807a00960cfd282` |
| `idempotence-raw-v2-1794821675290-7b17da31-5cd6-4326-824d-190309659ee8.json` | `ff050838a5ec8b4311bb3504b41c90483c84f97d101cb636169cc48532703a57` |
| `idempotence-sql-reconciliation-1794821808815-38b5df0b-1b60-426b-8b83-939e4a3663e0.json` | `9dc2121e0c2d70cd9d72c94e45f13300e821a0c26909693a634e68dcaefdb66b` |
| `window-2-resource-1794821851305.json` | `73e3b7a629b67eee5b67bd6071f7155367fb3da08e1bce4b04c73d6c17a76f5c` |

未指定完整相对目录的封存文件均在 `.local/crm023/observation/`。
