# CRM-022c 同一商机的建议、批准与拒绝

2026-11-16，在 CRM-022 独立本机 Supabase、Web 和单 Worker 上实际执行。业务源码基线 `60f2ba577f9f113eadba6fa89d0c6d308dd04613`，执行时 HEAD `d41cf2d` 仅有规格文档变化，冻结前检查应用和 Worker 文件一致。该批次只有一笔合成商机，未接入客户消息渠道。

测试组织 `crm022-synthetic-eval` 中单独建立一个联系人、一条商机、一个双阶段漏斗和一个受限销售 Agent。三个 Run 均使用同一商机 `d3acbbde-8bfb-4430-8e0e-ac1d72bd40a4`、同一联系人和版本 `1f1b2011-c49d-47d8-ad99-74c935e2ff95`。该工作台版本为 draft，授权 CRM 工具仅 `crm_get_lead`、`crm_list_followups`、`crm_move_lead_stage`，另有工作台结构化提交。模型是 DashScope `qwen3.8-flash`，每 Run 8 步、16,000 token；本机未定价模式只关闭单次金额拦截，费用留为未知。

任务发起身份 `692afbae-4df5-4e79-982d-d28e9a2f5d71`、决定身份 `00d93672-984d-485e-8fe2-3177c4dbecb3` 都是隔离环境固定测试账户。执行 Agent 按冻结计划代理测试操作者，使用真实用户会话请求已有决策端点，数据库 `decision_by` 与决定事件 `actorUserId` 均匹配第二个身份。没有真人点击或真实客户授权。两身份预检各通过真实认证 `getUser`、合成联系人 GET 和工作台 GET。

## 实际结果

| 阶段 | Run | 应用与 SQL 对账 |
| --- | --- | --- |
| 只读取证和建议 | `47a124c6-9d83-4a22-bb45-df406e60bd9c` | `completed`。在同一商机成功调用 `crm_get_lead` 与 `crm_list_followups`，跟进查询返回空数组且无拒绝。结果引用实际商机 UUID，阶段、`open` 状态、金额 `null`、预计关单时间 `null` 四项断言均与原观察相符。建议先内部指定负责人和核对材料，再由人判断是否推进。无提案、阶段活动、跟进写入或外联。 |
| 提案并批准 | `c5bdcdcb-f4a7-4e67-a035-917423e176fc` | 唯一 `ecdaf646-6028-402f-a48f-29c0dc797e73` 暂存到目标阶段。实际读取、暂存与等待事件序号为 5、8、17，期间另有一次同对象只读。待批时原阶段、微秒更新时间与活动未变。一次批准 HTTP 200 后提案 `executed`，新增一条匹配执行回执、一条 `crm_state_changed` 和一条阶段活动，阶段从 `f8e7a007…` 到 `d14bc845…`。决定 19 → 执行回执 22 → 恢复 24 → 新成功 `crm_get_lead` 27，工具与 SQL 一致。 |
| 同一夹具重置 | 独立 CRM move 请求 | 已封存批准终态后，以决定身份通过 `/api/v1/leads/{id}/move` 及 `expected_updated_at` 单次 HTTP 200，将同一商机恢复 `f8e7a007…`。重置活动 `76f3c168-09fe-498f-a2fb-8b9974f2a98a` 归属于测试操作员，批准历史保留。拒绝前基线已有批准与重置两条阶段活动，精确更新时间 `2026-11-16 07:40:00.103376+00`。 |
| 新提案并拒绝 | `f1a22459-7fee-42c1-a890-0520064539c3` | 唯一新 `a41fd943-479f-4364-b709-7343f892a2bc`，同对象与目标。一次拒绝 HTTP 200 后提案 `rejected`。以重置后基线作比较，阶段与微秒更新时间保持不变，新增阶段活动、执行回执、`crm_state_changed` 均为 0。决定 19 → 恢复 21 → 新成功 `crm_get_lead` 24，返回原阶段，与 SQL 一致。 |

批准和拒绝的逐次核验分别要求已完成的 start/resume jobs、唯一非空 toolCallId 和同次成功工具结果匹配、实际 Harness 状态，以及终答严格 `lead_id/pipeline_id/stage_id/action_status` 四键。两次终答与实际文档一致，各有一条指向目标商机的实际阶段断言，无材料缺口。建议的内容审核单独记录在 `advice-accepted.json`，未调用 Judge。

## 耗时与用量

下表时间来自 SQL 中的创建、请求确认、决定和完成时间。整条链从首 Run 持久化到拒绝 Run 完成共 **442.1 秒**，包括操作步骤之间的间隔、仪器诊断和夹具重置。审批续跑区间从记录决定到终态。此处只测一笔合成商机，没有重复试验或生产稳定性结论。

| 分支 | 创建至只读完成或请求确认 | 决定至完成 | 创建至完成 | 聚合模型行 | 输入 / 输出 tokens | Cache read / write tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 建议 | 26.7 秒 | — | 26.7 秒 | 1 | 4,485 / 790 | 3,584 / 0 |
| 批准 | 14.6 秒 | 7.8 秒 | 137.9 秒 | 2 | 7,308 / 1,214 | 24,064 / 0 |
| 拒绝 | 8.4 秒 | 4.7 秒 | 39.6 秒 | 2 | 5,845 / 942 | 24,064 / 0 |

共三条 root、五个 jobs 全部 `done` 且 `attempts=1`，五条真实模型聚合行，输入 17,638、输出 2,946、cache read 51,712、cache write 0。聚合行可包含多个 Pi 步骤，实际 Provider HTTP 数未测。费用字段均为 `null`。Trace 回查属于本批独立观测任务。

## 保留的失败与证据

- 第一次 `create advice` 在纯读前置验证结束后误序列化 `undefined`，退出 1。当时没有写入 create intent，随后同一数据、任务、权限和预算重新冻结，确认该商机的 Run 数为零。修复后才发送第一次实际 create POST。
- 建议的首份机械复核判 `advice_result_not_grounded`。只读复核发现仪器误套决定后仅允许一个 `stage_id` 断言的规则，实际建议请求允许有来源的附加事实。保留原判，逐值审核同次工具支持的四项断言后追加复查；按类型拒绝虚构、重复、缺阶段或值不符。没有重跑建议。
- 批准前的首份机械复核判 `pre_proposal_read_not_proved`。旧仪器在确认请求之前要求只有一次成功读，误将暂存之后的额外同商机只读当成缺证。后继复查要求先成功读取所选对象，再把唯一暂存事件与移动工具调用 ID 配对，最后核对同一提案上的确认请求。原判保留，未重建提案或 Run。

以下文件保存在 `.local/crm022/sales/c0674bf2-9c93-4286-ad21-439fdec8bf45/`。冻结保留初版与后继哈希；后继检查确认资料、任务与预算一致。使用窄 SQL 投影记录已完成结果、工具消息、公开工具参数、事件、计量，并从固定前缀的 Harness 消息仅取 tool/status。证据没有采集助手正文、私有续文、会话或凭据。

| 本机记录 | SHA-256 |
| --- | --- |
| 夹具 `fixture.json` | `11cd3558f471667e0b9e190b43443b3538a6d1ce74271ab8b6aea472e4a017ac` |
| 最终冻结 `frozen-519905b9…json` | `519905b9b60eeff4904b6ad31a4b11fee718350408845be6265aef9588c2e3b3` |
| 双身份认证 | `adbcc654edc71313cc7fa780f5bdfd41d35e864c768fa358edc76c4496877e92` |
| 首次前置失败 `preflight-instrument-failure.json` | `f6acd58120c12c6c88bd7f9f431954e45f5004f478f37b07c27cc2892369f2e3` |
| 建议首判 / 同 Run 复查 | `71fa6f2bc73bbcd79b026a1b19b192d2b508d832cd12a48af4429fa3deee2b8c` / `cc40221c2a2b012599f02455519fbbcf49baa154556f2387ce6457e8dfa28c1b` |
| 批准待审首判 / 同 Run 复查 | `a8699ad7679e1bcb224d27c6522405e2dbeb3b08402cc312b6b2c5daf2e6db5e` / `77faaf2485dab026ffd9778b34e73455664caef0301b48696994d7ec8b2a3a9b` |
| 批准决定 / 终态 | `fffd903db1fb57e1c3707c39fe3a26cd32db37c5cb04518654797082e8d24b8b` / `e194d30024536798a9ebf580eac37b997aa46648f6dc7e5cac9a986146d8e63e` |
| 重置后的拒绝基线 `reject-baseline.json` | `bfdca1b37181358f946d24bcb55f406bc9941b282f549b1d270449e88f963698` |
| 拒绝待审 / 决定 / 终态 | `427f0f5a3a4739242702685974ad76bc489a07f6ffc14299c8aa78157c64f58b` / `7310e4e1ce9a994f0ed4219a98b6c47975162b5a5fa32b50a984469da4abadd9` / `deef0bb93b4929818c66f35c4317f698fca58965b97386b04bce37239026f96d` |

## 复现入口

在独立 CRM-022 实例、有效模型配置、串行 Worker 和同一测试组织下运行 `node scripts/eval/crm022-sales.mjs help`。脚本只接受本批约定的本机端口、私有 `runtime.env` 和 `actors.private.json`。以新的合成夹具 UUID 单次 `seed`，用输出的 SHA 运行 `freeze`，再用冻结 SHA 执行 `auth`。

依次执行 `create/observe advice`，人工核对建议的事实依据后以 PASS 报告 SHA 明确 `accept-advice`。再执行 `create approve`、`observe approve pending`，核对唯一提案 UUID 后明确 `decide approve` 和 `observe approve final`。封存批准分支后执行一次 `reset`，再以 `create reject`、`observe reject pending`、`decide reject`、`observe reject final` 完成独立拒绝。具体参数由脚本帮助给出。每个 POST 前以独占文件记录意图。结果未知时按本次身份、组织、任务与对象只读对账，保留已有记录；不要重发决定，也不要清掉原失败或换商机后拼合结果。
