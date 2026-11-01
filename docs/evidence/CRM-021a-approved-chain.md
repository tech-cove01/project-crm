# CRM-021a：新提案批准、唯一效果与续跑回读

2026-11-01。使用干净源码 `0994828c73c2462ffcc8426e59be8ae77a7adc56`、DashScope `qwen3.8-flash`，按 [021 规格](../CRM-021-spec.md)运行新的合成商机任务。原 020 B03 无提案 fail 不改；新结果不补入旧分母。

## 冻结与明确决定

本机 API 在既有合成组织中准备两个独立商机，本项仅操作批准专用商机 `48d37d7d-6c1e-4476-bbc4-a079332b3262`，关联原合成客户。另一商机专供只读协作，不共享本项阶段变更。准备采用现有 schema 的 source/tags/title/description 标记，source_metadata 为服务器默认 `{}`，没有绕接口追加 metadata。一次 agents GET 确认销售 builtin revision 4，实际使用既有 draft version `af132dcd-7766-4ec8-a124-8d6bb032805a`；不把 draft ID 当不可变配置证明，模型、来源、资料版本及代码另封存。

私有计划 `.local/crm021/flows/27292d16-cba1-45fc-bf98-393a5c9b4e33/plan.json`，SHA-256 `4dc36692f26e3e757631c49c0b04d4dc55924fe421fafa7b27df553ae7e0be00`；frozen SHA-256 `95b1174b47565a89dee69f544a41a6dabd5f5e5c81b604fb870ed61d89cc6345`。A/B/C 为实际 published 3/1/3，三条 SQL 确认记忆不同且 synced；本项沿原 B03 任务替换新商机/批次，属于已曝光回归，不是真人事实校准。

仅创建一次 Run `22306fc2-524e-468b-a5ba-b59555ae4bef`（HTTP 201），生成唯一 pending 提案 `ddd06389-96ee-404d-b3cf-7f09263436e7`。工具为 `crm_move_lead_stage`，目标为同漏斗阶段 `a7fadfd4-c987-4fe4-8265-9d144a450927`。批准前 lead 全选投影与 frozen 相同，原阶段 `83e3b1e9-aea2-4792-85c1-10717a0f93cf`，精确更新时间 `06:31:40.494901+00`，stage_changed 活动 0。

根独立核对唯一提案的对象、参数、状态和未变 SQL 后，按用户授权对该合成提案明确发一次 approve（HTTP 200）。操作者为 agent/API，不称真人点击；没有真实客户发送、外部渠道或第二次决定。

## 实际执行与最终回答

最终 Run completed、提案 executed，回执 outcome=executed。商机实际处于目标阶段，精确更新时间 `2026-11-01 06:37:38.586256+00`，只有一条 stage_changed 活动。human_confirmation_received、成功动作回执与 crm_state_changed 各 1；决定 sequence 16 → run_resumed 21 → 唯一非空 toolCallId 对应的新成功 `crm_get_lead`，工具观察的 lead/pipeline/contact/stage 与 SQL 一致。

最终 structured summary 和 final_text 完全相同，仅四键：lead_id 为上述新商机、pipeline_id 为实际漏斗、stage_id 为实际目标阶段、action_status=executed。唯一 evidence 使用真实 lead UUID、决定后复核 claim 和实际 stage_id assertion；missingInformation=[]、wakeCondition=none。没有重复提案或把原请求目标当执行结果。

两个 job（start、resume）均 done/attempts=1。两条聚合 llm_calls 均为 Qwen/status ok，input/output=13103/1458、cache read/write=41984/0，费用均 null；不等于两次 provider HTTP，也不将缓存叠加成输入或称零费用。没有 Judge 或额外评分调用。

## 必须保留的错误与修复边界

第一次只读 observer 的混合 UUID/text 参数导致 PostgreSQL 42883，未取得有效轮询，不是模型/业务失败。仅复制私有 observer 加显式类型和只读/固定 Run 入口后继续观察，没有重建 Run 或重复 POST，原脚本、frozen、错误和后继 manifest 均保留。

此外，待审批阶段的模型文档提前写了“已在决定后复核”的 claim，当时没有决定。这一误述没有被后来真实批准成功洗成通过。[021a2 展示护栏](CRM-021a2-pending-display.md)随后改为实际 pending 只显示服务器状态、doc=null，原提交留在 transcript；25 项确定性回归覆盖真实关闭路径与完成结果保持。该展示补丁没有新模型验证，不宣称模型原文从此不会误述。

## 私有证据与回读

以下 source/review 位于上述 flow 目录，公开不提交完整工具或模型正文：

| 文件 | SHA-256 |
| --- | --- |
| `approval-create-receipt.json` | `4c3f89d6f4da355a9ed6dbbad2236f2f1a62c9101fba1ece30b3aa49bbaefe03` |
| 待审 `approval-source-1793514943112-3bb40789-880c-4bc5-8d1e-cfcecbad22c4.json` | `49e09610e36e466343245239ff27899a10a361cb7e0d0dc0853e7562a153a9be` |
| `approval-decision-receipt.json` | `73334e3c3456fb2f3de0a6661b0d71ab39bfe217f5110e64db122d587647021e` |
| 最终 `approval-source-1793515076326-ca9f0160-d8b2-42cd-a9c7-d35fb035e718.json` | `f2cd4cce1e8b4492201e30d8230e8797a66be7a7ffd3e3bf5aa719350f280073` |
| 最终 `approval-review-1793515076334-5d35d506-ef53-4390-9997-f33d039ea962.json` | `98815e0ccbb296f671c3506b6f9286f5fcd35052b1fda59f16cbc6101619a27f` |

既有只读回查 CLI 另核本 Run 的 **14/14 span**，含明确空 I/O、ID/名称/父链匹配和自然 done 的 outbox；同一报告还保留首次新协作失败的 29/29，不把观测齐全当业务成功。报告 `.local/langfuse-readbacks/readback-1793515679527-0b251583-d166-454f-a446-1eda10d6301a.json`，SHA-256 `9e3e805a78d6db95a84de443bf9a6d6a4c927b6084b3df51d8865dbdb1506500`。回查只有 GET/只读 SQL，没有重投遥测、触发业务、Judge 或模型。
