# CRM-020c：同商机主链与真实协作首轮结果

2026-11-01。按 [有限规格](../CRM-020-spec.md) 各创建一次，不重跑取更好回答。**本批主链未全部通过**：准备和拒绝成立；批准没有产生提案，正常协作没有终答。原业务和模型输出均保留，没有第三轮产品修复。

## 资料与运行版本

新合成客户 `a9b4aa1f-f3fa-40c1-8a4a-94d1cff90578` 与商机 `02d9c210-49d2-4fdd-abce-ef935d759da0` 关联，位于既有演示漏斗。三条确认事实正文彼此不同，涉及 CSV 字段导入、预算/上线日期未确认和仅同意站内演示。虚构产品 A/B 为独立手工种子的试用说明和审批约定；C 原为封存资料，后续隔离与最终核验另记。所有真值为 agent 编写，未经真人校准，不代表真实产品条款。

完整资料冻结于第一次真实 Agent Run 前，授权回滚负例另使用独立 CRM 子清单。fixture SHA-256 `e7e14aab5b1c1ddf0068f0a1d63d6a355fc942584f4cac1b3b9528492dedaeba`；新 source `f684a62a-11bd-4e0c-ab65-ff3afdbb0bf4`，KB `842886d6-75c1-4089-8747-157644e6fafa`。A/B 当时均 published/version 1，原文、doc ID、file/content hash、来源资格与三条 SQL 事实逐项封存。旧 017 资料不改。

运行使用 `dashscope/qwen3.8-flash`、原 inspect/sales 内置版本。应用修复基线 `9fb0d5c`，冻结清单明确当时唯一 dirty tracked 文件是独立只读回查 CLI，不将它写成干净源码。初始/决定前均校验组织模型、Agent 版本、来源资格、事实与代码哈希；决定另核唯一提案的 lead/target/pipeline 和创建时 SQL 精确更新时间。服务受管会话为 `241e7c33-c7e6-47e4-8319-c51148b9980c`，只重载本仓服务。

## 首次业务结果

| 场景 / Run | 实际业务与输出 | 本批验收 |
| --- | --- | --- |
| B01 `919d3be3-f593-475b-8159-a95a6156d74e` | 读取关联客户/商机并检索 A/B。JSON 三事实逐条 id/body/revision 一致；产品引用校对 source/provider/KB/page/version/content hash、标题和原文片段，A/B 均覆盖。预算及上线日期保留未确认，无业务提案。 | pass，限固定只读准备投影；单次语义复核另见下文。 |
| B02 `4ed2e859-cd75-4917-8132-efe2fc616152` | 新唯一提案经本批授权负例后由 agent API 明确 reject。拒绝事件之后 resume，再成功读取所选商机；四键 JSON 的 lead/pipeline/stage/action_status 逐值匹配，提案 rejected、阶段及更新时间不变。 | pass，明确拒绝与结果重读。 |
| B03 `de5d9d08-2906-4fe6-9568-974a71583196` | 只调用 `crm_get_lead`，提案数 0。终答描述拟移动并“等待明确批准或拒绝”，却没有可决定的持久提案；Run 状态 completed 不能满足本票批准预期。没有批准请求或阶段变更。 | **fail**：批准链未建立，决定/落库/决定后重读均未取得。 |
| D01 `6ed982cd-3ca1-4d75-9781-4307953fa6bc` | 实际自动选中三专家，三个 inspect child 均持久为 completed，各 3 次工具观察，但三份 summary 都为空。父任务 partial、`empty_final_answer`、result_document=null；无提案。 | **fail**：正常协作汇总未完成。 |

B02 的拒绝事件为 sequence 16，resume 为 18，后续 `crm_get_lead` 为 21，并按 toolCallId 对应实际观察。操作者为用户授权下的 agent/API，不声称真人点击。B03 没有创建替代 Run 或手工补提案；D01 没有调整轮数再试。子任务状态、工具调用数或资料存在均不替代可用摘要与父终答。

本批最终业务商机仍为初始阶段 `83e3b1e9-aea2-4792-85c1-10717a0f93cf`，精确更新时间 `2026-11-01 05:10:51.756746+00`，stage_changed 活动为 0。授权/恢复注入中的真实阶段效果全部在外层回滚，与本表持久业务状态分开。

## 单次 Judge 与规则分

选择 B01 的短完整材料，调用前检查了三个事实的 ID/body/revision、A/B 页身份/hash 和终答可见；工具观察最大 1516 字符，没有触发 1600/24/14000 裁剪门禁。只执行一次独立 Judge 调用，仍使用业务模型 Qwen；不称不同模型盲审或独立真值。

Judge 为 `workbench_semantic_v3:dashscope:qwen3.8-flash`，completed/pass/92，保留关于字段利用、断言呈现和来源免责声明的三条辅助意见。合并结果仍为 **needs_review/92**，answer_quality 规则项仍为 needs_review/50。B02、B03、D01 规则分均 needs_review/89；B03 和 D01 的业务 fail 保留，没有被规则分或 B01 Judge 覆盖。没有调用其他 Judge 或做真人事实校准。

## 最终计量与私有证据

四个业务 root、三个 child，五条后台 job 最终全部 done/attempts=1；早期 B01 和 B02 快照的 job 尚 running，最终只读元数据另外确认结束状态。`llm_calls` 共 9 行（含一个 Judge 行），全部配置为 Qwen；一行可聚合多个 Pi 模型轮次，不等于 provider HTTP 请求数。

累计 input_tokens=42034、output_tokens=4166、cache_read_tokens=110080、cache_write_tokens=0，缓存字段独立记账，不叠加为输入总量；九条 cost_cents 均 null，费用未知。知识工具的原生嵌入和 Mem0 本地排序/向量处理没有逐请求账单证据，不能声称全批零 embedding 或完整计费已核实。

| 忽略目录中的文件 | SHA-256 |
| --- | --- |
| `main-plan.json` | `7f2594381cfecb3d24e93f114721b714d9b8b9cf43c25b227d830933f76b1e3c` |
| `D01-plan.json` | `88fab5c3c4ce3a86b9d38ac728dd317cae7f4eb50afec35d38277bf8d80970b4` |
| `B01-snapshot-1793511068982-7d16f42c-8f88-44f4-841f-651ec111af8d.json` | `f275d14116c16b9ff91a54957ecb7d5d18f5be3dce6ce0a556ce4b260370bea0` |
| `B02-snapshot-1793511359589-7ffaa755-d378-4af7-88ec-d55e676c235c.json` | `bebb755b1a553abc666ca07f58e79bd9239e8ac0856bf51d9188c9988697070b` |
| `B03-snapshot-1793511459267-b462b29c-5330-4f9f-990e-768b7cbc6895.json` | `b81702bd9c1cd3070beff71998e690beabfeb9c3c158f8d028d61b49b287bea8` |
| `D01-snapshot-1793511540216-39227cb8-39c3-4ac5-b8d5-1148120078cf.json` | `15831040a244584b5f0dafb1e6653ac2de2a023b89e792b17d4f2a78d21c3f05` |
| `judge-selection.json` / `B01-judge-receipt.json` | `f374448e6e748f79fa5e1f5988fc83f8cf42c5351784b1f5e4d775b3ae90eb57` / `001e504c7727b6e08788ff75f511d1b1a1a759542ac28714467cc1459b601f7b` |
| `final-metadata-1793511942578-3320d40b-6ffd-437c-ad5d-21e5600b4b06.json` | `d4abdcac249d819c0004137e4269e2faa5a71d90872c49967df477de214f6024` |

表中文件均位于 `.local/crm020/`。原始工具/终答只留本机，不选取 assistant 私有续写或 opaque continuation。后续独立核验仅核原例及未用于调参的资料，不再次执行这些业务。恢复 B03/D01 或扩展能力须另行选择，本批按有限规格以失败保留的结果收尾。
