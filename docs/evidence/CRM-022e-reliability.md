# CRM-022e 批准竞争与续跑恢复

2026-11-16 在本机独立 CRM-022 环境执行两条真实合成商机 Run。两个有故障注入的续跑作业都由产品队列重新认领并完成，**恢复 2/2、重复业务写入 0、拒绝后误执行 0**。两条 Run 的模型最终也均为 `completed`，模型终态和持久效果分别核验。样本仅覆盖一个阶段动作，恢复率与延迟适用于这两条固定执行。相关范围见 [CRM-022 规格](../CRM-022-spec.md)。

## 执行设计与结果

两个场景各使用独立合成客户和商机，共用本批专用的一条测试漏斗及一个自定义 Agent。Agent 仅配置 `crm_get_lead`、`crm_move_lead_stage`，模型 `dashscope/qwen3.8-flash`，版本预算 8 步和 16,000 tokens。测试库无渠道会话，Worker 从独立运行配置启动，Sentry 关闭，未涉及外部客户渠道。初始 Run 均走真实 Web、Worker 和百炼，创建唯一有效待审阶段提案后停下。决定经现有鉴权 HTTP 路由，由已验证的专用测试操作者脚本明确发出。两次批准请求来自同一测试操作者。

| 场景 | Run / 提案 | 决定与效果 | 恢复证据 |
| --- | --- | --- | --- |
| 竞争批准、瞬时错误重试 | `581f2e34-b233-4419-84a9-4aa361200cc4` / `e4aec7d2-4ddb-41ff-9f93-11c210d07ba5` | 同一提案两次批准并发发出，起始相差 1 ms，HTTP 200 / 409。阶段从初始改为目标，恰有 1 条 `stage_changed`、1 个 `crm_state_changed` 和 1 个续跑作业。 | `9f37d7df-8f15-4db5-8440-eb6afbe838f8` 第一次认领后的准确 Run 读取返回一次受控 HTTP 500。真实队列回到 `pending`，PostgreSQL 实测距重试到期 9,887 ms。原 Worker 第二次认领同一作业并完成。故障观察至终态 28,067 ms。唯一阶段效果、提案回执状态和商机精确更新时间均保持。 |
| 拒绝保护、Worker 中断 | `bd6d4035-1fc5-4561-9473-5beb9f1fdaef` / `6cec29f7-d702-404d-8366-2aaf658c6e74` | 拒绝 HTTP 200，随后同一提案迟到批准 HTTP 409。原阶段及精确更新时间保持，阶段和执行事件均为 0，仅有 1 个续跑作业。 | `01d67fb3-e9e9-43d6-b3d9-037c71bf03f1` 第一次认领时暂停准确 Run 读取。核实持久租约属于本次创建的 Worker 后，仅终止该子进程。替代 Worker 在原租约自然到期后第二次认领同一作业并完成。故障观察至终态 137,732 ms，含本次 120 秒租约。拒绝和零效果持续成立。 |

两条初始作业各认领一次，两条续跑作业均 `done`、attempts=2，结束时无锁，未生成额外提案或重发批准。观察器确认两次介入时相应 Run 的模型计量仍保持初始 1 行，恢复后各为 2 行。计量合计 4 条聚合记录，均为 `dashscope/qwen3.8-flash/ok`，输入 14,438、输出 3,290、缓存读取 33,280、缓存写入 0，费用 4 条均未知。聚合记录不等于供应商 HTTP 次数。

Worker A 被终止前已实际取得租约，作业在退出后仍为 `running`。PostgreSQL 原认领为 `07:50:28.218554Z`，替代 Worker 为 `07:52:30.725002Z`。第一个进程记录 `SIGKILL`，替代进程 `exit 0`；瞬时重试组的 Worker 也以 `exit 0` 收尾。注入通过独占子进程入口，仅挂起或返回一次匹配组织、Run UUID、HTTP GET 和实际续跑查询字段的读取。在仓库锁定 Supabase SDK 2.116.0 的离线检查中，500 会传出客户端并进入队列失败处理。客户端本身会重试 503，因此该状态码未用于实测故障。

真实队列认领、退避、租约回收、批准路由、阶段处理器和恢复后的模型执行均使用现有实现。两种受控故障发生在恢复读取 Run 时，故障时未开始该续跑轮的模型或产生新写入。未覆盖阶段动作执行中途被杀、供应商已接收但客户端未知的重试、所有渠道或分布式压力。结果归因于 CRM 队列、租约、决定门禁和业务回执。

## 复现入口与证据

脚本为 `scripts/eval/crm022-reliability-fixtures.mjs`、`scripts/eval/crm022-reliability.mjs` 和 `scripts/eval/crm022-reliability-worker.mjs`。`--help` 给出入口。每条路径依次为 `create`、`stage`、`decide`、从实际决定结果 `prepare`，最后执行冻结的 `retry` 或 `interrupt`。这组行为要求独立 Web/PG 和专用 Worker 窗口。执行器精确核对 org、数据库实例身份、合成标记、Run/提案/作业/阶段和可执行队列范围，且按独占文件记录请求意图。原快照和请求结果存入忽略目录 `.local/crm022/reliability/29041bec-f0db-49b6-b362-44e140a6755f/`。

| 证据 | SHA-256 |
| --- | --- |
| 原 `fixture.json` | `eeeda875622a3554d576384d1eecc12ffc6cfb4f0b1647b6e8f43ea10751fc51` |
| `seed-result.json` | `2828d337aa2a3312d86db754029f840bf9a45cf18674afca26360dab2e72aee9` |
| 最终 `fixture-execution-93a3ff3dca88907c66cb6bc03ea7faee5e549d14cf6577f6c1b4064112d16510.json` | `93a3ff3dca88907c66cb6bc03ea7faee5e549d14cf6577f6c1b4064112d16510` |
| `pg-retry-preflight.json` | `a116d71b890dce1d766d25c88b53084594f145c3f0b3e6e4b2ffb15d3a7f3c70` |
| `retry-create-receipt.json` | `3e132ae552cec63e097228ba96485293a7f8703268a13984280e042d4029cf33` |
| `retry-stage-result.json` | `73615ad901127e9c45d3365c8cfa2df5c9f370352b371827d9c7fe3db9ddc798` |
| `retry-decision-result.json` | `e3aa95b4062635e505efced57d19107439e25fb668c5d13161e50f09481c563f` |
| `plan-retry.json` | `2e15e247c3a6e374ea04f2f5a0171327a29f3542c43ade8e34f8b16d30ba6498` |
| `retry-report-1794815306505-b5f5370b-6ea4-4237-b437-c54b344723ce.json` | `cd84ca2092bbb1963237c30ccfe58d875928bea4a0e16bbbc4b644f1d51f5074` |
| `interrupt-create-receipt.json` | `9cf00d507f18eb3a40fc004e951ca61db65776f5dbd59ea3e5e8e479e412e7df` |
| `interrupt-stage-result.json` | `4ea2fa83e772b9e96efd449f8cf3da8aa7384b9de25219853e6eb983fb4fcc6d` |
| `interrupt-decision-result.json` | `7c5da513c5a33bd5beaa43550ef45e98656fd1e0d4a239e9ef64c28f7f731957` |
| `plan-interrupt.json` | `ff20909d8970e9cc69f2a02afd214c948c8d4235a748f7b331eeaff62d6319d6` |
| `interrupt-report-1794815574961-8191f1c4-8c92-46df-899d-96d4e4ec6da8.json` | `8e205237378f0cc6da229990dd4c4fbf180c0598cec1cd8f7a89e21eccf2e58d` |

产品源码为 `60f2ba577f9f113eadba6fa89d0c6d308dd04613`，执行 HEAD `d41cf2dc25830e5716fce4a5bc7174138a80f896` 只增加本批规格、状态和票据。冻结文件另锁实际 Worker、队列、续跑路径和仪器 SHA。初次执行前共享销售认证辅助脚本更新，原 `fixture-execution.json`（SHA `751128bcbaa73edf723961c6916ade9bcbd4cbdcd0aa68f7f5632126e181e285`）被源码核对拒绝，未创建 intent 或发出 HTTP。确认复用认证边界后新建带哈希命名的执行快照，原夹具和记录均保留。并行的 PostgreSQL 预检仅使用一个事务内可见的临时作业，验证错误 lease owner 不生效、正确 owner 下真实 `failJob` 的 9,979 ms 剩余退避并回滚，其结果与上表真实 Worker 恢复分列。
