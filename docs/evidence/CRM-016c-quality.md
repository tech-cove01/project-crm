# CRM-016c：既有三 Run 的选中声明来源核对

日期：2026-10-28（Asia/Shanghai）。对 [CRM-014v](CRM-014v.md) 的三个既有合成 Run 做六项声明核对，结果为 **5 项 pass、1 项 fail、0 项 unknown**。这是 reviewer=`agent` 的逐条来源比较，不是新模型 Judge、真人审核或整份答案的独立语义认证；这六项也不是准确率样本。

本轮没有新建 Run、重新批准、修改业务、调用模型/语义 Judge、更新渠道同意或更改评分。原确定性结果仍为 needs_review **89/92/89**，answer_quality 均为 **50**；历史失败保留。

## 六项结果

| Run / 选中声明 | 结论 | 来源与核对范围 |
| --- | --- | --- |
| 客户 `71544fe6-de80-48b4-9d69-057246caa18d`：四条确认记忆的记录值与差异说明 | **fail** | 四条 ID、body、confirmed 及各行 revision 主体相符；但正文称前三条 revision 不同，成功工具观察中的这三条 revision 实际相同。首条创建时间前还多出无来源的“2026-06?”猜测，随后才给出正确值。 |
| 同客户 Run：偏好与权威边界 | pass | 已确认的工作日下午三点邮件偏好仅作为客户上下文；正文明确不构成公司政策，也未从空 consent 推导未来渠道同意或建议外联。 |
| 知识 `ccd2fb37-d3f3-4d9d-863e-2981b5379266`：四项证据 ID、标题与观察版本 | pass | 回答与当次工具返回的三条 Wiki、一个原生 FAQ 配对一致；三份 Wiki 的 manifest、正文哈希及 excerpt 均匹配当时 revision，原生 chunk 与观察到的 index version、内容哈希一致。 |
| 同知识 Run：查询状态与范围 | pass | complete、missing、一个原生片段和四项证据的说明符合当次观察；未补造第五条、声称全库完整或推演产品商业承诺。 |
| 商机 `b849f387-d56e-4bc2-a79c-7bebad0c1b58`：明确确认后执行唯一提案 | pass | 提案 `b22bf4f5-db78-4586-a56f-f3c3a829e46f` 的对象、目标阶段与 executed 状态一致；确认请求 sequence 17、明确确认 19、执行 22、业务变更 23，顺序成立。原回执归属自动化 UI 操作者，不能称真人现场批准。 |
| 同商机 Run：续跑后的完成声明 | pass | sequence 24 续跑后，27 的成功 `crm_get_lead` 观察返回目标阶段 `83e3b1e9-aea2-4792-85c1-10717a0f93cf` 和原 pipeline。该 Run 只有一次执行/业务变更及允许工具，没有重复写入或发送工具。 |

客户记录值一项的 fail 说明：确定性引用校验与 needs_review/50 并没有证明所有自然语言表述正确。此次如实保留错误，不修改旧回答、重跑业务以替换结果，或将该项改成 pass。其余五项通过也不豁免这一问题。

## 只读取证与观察点

固定 session 为 `86195fb1-5329-4d32-9818-7c004f834fb3`。本机快照使用 repeatable read / read only 事务，组织条件固定并先核验合成联系人及无客户关联合成商机。数据范围为：

- 三个 Run 的最终产品文本、结构化结果及必要身份字段，不读取整份 runtime_state。
- 在 SQL 内先限定 `role=tool` 和每 Run 的工具白名单：客户仅 `crm_get_contact`，知识仅 `crm_search_knowledge`，商机仅 `crm_get_lead` / `crm_move_lead_stage`。实际取得六条工具消息，不提取 assistant 消息、隐藏续文或模型思考。
- 三份 `ai_wiki_evidence` 历史 manifest/content、一个与观察版本精确匹配的原生 chunk，以及限定组织/Run 的事件元数据和提案目标字段。

Wiki manifest 按原 [schema 字段顺序](../../lib/ai/integrations/weknora.ts#L49)重建后核对 SHA-256；不以 JSONB 返回键顺序直接重算。正文、excerpt 与工具 revision 另行核对。这里证明的是持久化的历史观察版本，不包含新的远端页面/授权实时回读，也不宣称当前远端内容仍未改变。

观察点为 `2026-10-28T14:32:02.330Z`（本机 22:32:02）。私有快照与摘要以递归排序对象键后的 canonical JSON、UTF-8、SHA-256 计算：

| 标识 | 值 |
| --- | --- |
| sourceHash（选定原始快照） | `d6060f432c1f1b3d00617a92dbb5a8fc15f6af2bb62baa2f4112c015c016e00f` |
| summaryHash（六项结论及来源引用摘要） | `3a3b1e4b11bcc5d445a60bccb41de4d82a6b0a02477b02bf2464dab0ce137ac1` |

这两个值不是外层 JSON 文件本身的文件哈希。summaryHash 不包含它自身和封存时间，包含 sourceHash、比较结果哈希、原评分证明/操作者回执的文件哈希及六项声明。具体原文、记忆 ID、时间与对照值仅保存在忽略目录。

私有脚本 `.local/crm016c-quality.mjs` 默认只显示帮助；`--capture` 只读采集并以排他创建保存 `source.json`，`--analyze` 离线生成字段/版本比较，`--seal` 校验 source/比较/原证明哈希后封存 agent 编写的六项结论。证据位于 `.local/crm016c-quality/` 的 `source.json`、`comparisons.json`、`review.json`、`report.json` 和时间戳报告，均不随公开提交上传。语法、帮助、忽略路径及哈希封存检查通过。

本页仅完成六项选中声明的来源核对，不改变现有评分门槛，不将单一 provider 自评当独立真值。长句/短句/无答案检索样本和后续检索实现的验收另行记录；不能仅凭本页勾选 CRM-016 全部完成。

独立只读审查已重算来源、比较和摘要哈希，并对照六项结论及原评分回执，结果一致；最终状态/能力文档与本页范围一并审查通过。此审查没有重新生成答案、重跑业务或将该 fail 改为 pass。
