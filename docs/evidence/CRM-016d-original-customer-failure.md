# CRM-016d：最早客户只读 Run 的 79 分失败诊断

日期：2026-10-28（Asia/Shanghai）。本页补齐 [CRM-010 Langfuse 原记录](CRM-010-langfuse.md) 中客户 Run `b73606ef-7604-4001-b3ad-fe4b42642cc8` 的失败解释。它不是 [后续商机诊断](CRM-014-quality-diagnosis.md) 中同为 79 分的 `98637ea8-3f6a-4dbb-8a9d-624affd82495`，后者不能替代本次核对。

原客户 Run 为 inspect / completed，仅成功调用 `crm_get_contact`，没有 CRM 状态变更。原保存评估 `9509e4a2-34aa-47e0-8ce0-56c843d30b4e` 于 `2026-10-28T07:21:30.010Z` 创建，profile 为 `crm_intelligence_v1` / revision 8，verdict=fail、overall=79、answer_quality=0，semantic Judge 未配置。

## 三条 answer_quality finding 的实际原因

| 原 finding | 性质 | 逐项核对 |
| --- | --- | --- |
| `structured_result_unobserved_evidence`，unobserved=2 / total=3 | 唯一硬失败 | contact 引用使用实际联系人 ID，符合契约；另两条将真实客户记忆 ID `8d74749c-b452-4d1e-a9a8-63e672bf06a5`、`9ece30bd-7ad6-4c50-9e2f-698c425c97d3` 标成了 `knowledge`。两 ID 确实出现在成功工具结果的 `confirmed_customer_memory.memories[].id`，但 `crm_get_contact` 只注册 contact 来源，未将嵌套记忆注册为 knowledge 证据，因此类型与来源命名空间不匹配。 |
| `memory_claims_require_semantic_review` | 待复核 | 确认记忆存在性已核对；自然语言结论仍需语义复核，不是硬失败或记忆缺失。 |
| `structured_claims_not_independently_verified`，observed=1 / total=3、verifiedAssertions=2 | 待复核 | 两项 contact 标量断言与观察一致；该 finding 仍提醒自然语言声明未独立认证，不会使错误类型的另两条引用有效。 |

成功观察实际返回四条 CRM 确认记忆，source=`crm_confirmed_facts`、coverage=`complete`、providerStatus=`connected`；原结果 missingInformation 为空。选中的沟通偏好说明能在观察中找到依据，但本次没有据此认证整份答案。`unobserved` 在这里指类型化引用匹配失败，不能解释成没有读取记忆、Mem0 检索失败或 Wiki 长句召回失败。

规则见 [工具观察注册](../../lib/ai/evals/evidence-provenance.ts#L92)、[类型与 ID 的匹配](../../lib/ai/evals/evidence-provenance.ts#L120)、[答案质量检查](../../lib/ai/evals/evaluate-run.ts#L123)。硬失败将该维度映射为 0，并使整体 verdict=fail；原记录和门槛均未更改。

## 原 79 分如何得到

| 计分维度 | 原分数 | 权重 |
| --- | --- | --- |
| task_completion | 100 | 25 |
| answer_quality | 0 | 20 |
| tool_reliability | 100 | 20 |
| policy_compliance | 100 | 20 |
| efficiency | 100 | 10 |

`round((25×100 + 20×0 + 20×100 + 20×100 + 10×100) / 95) = 79`。knowledge_grounding 和 collaboration_quality 均为 not_run，不计入分母；它们不是额外失败。该数值是确定性规则的加权结果，不是模型给出的语义质量分。

原 scores 投递事件 `58ed977d-689e-4d01-8070-c0894a180747` 仍为 done。此次从本机 Langfuse 只读回查 Trace `f94cb02a8f0735f9d8ed0c1d9e65e429` 的六个原评分，名称、值、稳定 score ID、observation ID 和 fingerprint 均与原保存报告及 outbox 对应，包含 `crm.overall=79`、`crm.answer_quality=0`。本次没有重新评估 POST、重投、手动 drain 或新建评分；CRM-010 当时手动重试一次的历史仍保留。

## 取证与范围

SQL 观察点为 `2026-10-28T15:22:50.469Z`，评分回读为 `15:22:50.822Z`。固定组织及合成联系人，只读取最终产品文本、结构化结果、原评估、允许的 role=tool 消息与必要事件字段；未提取 assistant 消息、隐藏续文或整份 runtime_state，未调用模型、Judge 或业务写工具。

私有脚本 `.local/crm016-b736-readonly.mjs`、快照 `.local/crm016/b736/source-1793200970824.json` 和 `.local/crm016/b736/diagnosis.json` 保存在忽略目录。递归排序对象键后 canonical JSON 的 SHA-256 为：

- sourceHash：`f50a5e0132c7b2b3d90339c541ed50778ca3b9b958a57908904e36cf7a5b00f3`。
- summaryHash：`b51d3b585d5c81631429448cffa69bd5ed4de267cf1d2ca084807b3245dd3988`，计算时排除报告自身的 summaryHash 字段。

本页完成原始失败的契约和计分诊断。客户新答案的修复及逐值验收另见 CRM-016e；不能仅凭这里的诊断称全部自然语言质量通过。

独立只读审查已重算两个 canonical 哈希及远端评分快照哈希，对照实际引用、工具观察、原 findings、五维计分和六条评分 subject，结果一致；没有用后来的商机 Run 替代本 Run。
