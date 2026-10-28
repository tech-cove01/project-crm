# CRM-014：两轮演示的答案质量诊断

日期：2026-10-28（Asia/Shanghai）。本页对照两轮真实合成演示的持久化结果、实际只读 GET 评估 findings 与当前评估源码，解释 `answer_quality=0/50`。诊断只读已有记录，没有新建 Run、调用模型、批准动作、修改业务或触发语义 Judge；不修改评分门槛。

## 实际结果

| 会话 / 阶段 | 原 Run | 已记录的结果 |
| --- | --- | --- |
| `03a66981-776e-4024-974d-fcf8641abd93` / inspect | `ec2b2c4f-221c-42de-8a9b-6987009541e7` | completed；overall fail / 83，answer_quality fail / 0。 |
| 同会话 / 商机 | `98637ea8-3f6a-4dbb-8a9d-624affd82495` | 提案 executed、阶段落库并续跑 completed；overall fail / 79，answer_quality fail / 0。 |
| `111342f9-bd2e-4d59-aba9-2a32df892a61` / inspect | `774204eb-0c47-413a-8d1c-7eea26cf0969` | completed；overall needs_review / 92，answer_quality needs_review / 50。 |
| 同会话 / 商机 | `c137fda4-60d8-46af-9c18-96b03133e80e` | 提案 executed、目标阶段已落库，但续跑 partial / missing_material；overall fail / 66，answer_quality fail / 0。 |

两轮商机使用同一无客户关联合成商机 `6acd6c2b-f6a3-43a9-ad61-0a4da8e82bd6`。首轮从 `a7fadfd4-c987-4fe4-8265-9d144a450927` 移至 `83e3b1e9-aea2-4792-85c1-10717a0f93cf`；第二轮使用新 Run、新提案，反向移回前者。批准均由自动化操作者通过既有 UI 明确执行，不能称为真人现场点击。业务落库不等于续跑或质量评估通过。

## 分数的含义

`answer_quality` 是确定性门禁，pass、needs_review、fail 分别映射为 100、50、0，并非模型给出的连续语义质量分数。见 [分数映射](../../lib/ai/evals/evaluate-run.ts#L47)。

有效的结构化引用仍会产生 `structured_claims_not_independently_verified`；确认客户记忆的存在性核对也会产生 `memory_claims_require_semantic_review`。没有硬失败时，这些待复核项使该维度为 50 / needs_review，不能为了得到 100 分而移除。见 [确认记忆边界](../../lib/ai/evals/evaluate-run.ts#L119)、[结构化声明边界](../../lib/ai/evals/evaluate-run.ts#L153)。

未观察到的引用 ID、字段断言与观察值冲突、确认记忆遗漏、内部稿或疑似截断会触发 0 分；无效结构化结果也直接失败。葡语本身没有直接扣分规则。见 [引用与断言检查](../../lib/ai/evals/evaluate-run.ts#L123)、[硬失败集合](../../lib/ai/evals/evaluate-run.ts#L190)、[最终答案文本检查](../../lib/ai/agents/final-answer.ts#L28)。因此中文展示要求、引用正确性和语义质量需分别判断。

## 结果与规则的对应

### 首轮 inspect：把父知识源当作具体证据

结果中的 `sourceType=knowledge` 分别使用了 Wiki 知识源 ID `54aabec4-e07d-4548-af41-684136aca033` 和 FAQ 知识源 ID `c4f5f4d0-cae0-4cec-8433-5eaf044d21de`。评估核对的是本次成功工具结果里的 `evidence[].id` 或 `trechos[].chunk_id`，并非任意父知识源 ID。该 Run 实际返回的三条 Wiki 证据 ID 与这些父 ID 不同；FAQ 的实际 chunk ID 是 `1c8e0828-15ee-4fef-a045-43c62be0c586`。

实际 GET findings 记录 `structured_result_unobserved_evidence`，3 条引用中 2 条未观察、1 条已观察，3 项联系人字段断言核对通过。检索确实成功、正文可以有合理内容，但这些结构化引用没有指向校验器实际观察到的片段。见 [知识证据取值](../../lib/ai/evals/evidence-provenance.ts#L110)。不能据此直接认定检索内容错误，也不能只因正文看起来合理就豁免来源校验。

### 首轮商机：商机 ID 冒充事件 ID

该结果同时给出正确的 lead 引用和一条 `sourceType=run_event` 引用；后者的 `sourceId` 却仍是商机 ID `6acd6c2b-f6a3-43a9-ad61-0a4da8e82bd6`。事件引用应使用本 Run 的实际事件 ID，不能用被操作对象的 ID 替代。实际 GET findings 为 `structured_result_unobserved_evidence`，2 条引用中 1 条未观察，4 项商机字段断言核对通过；商机阶段实际落库和后续只读复核不会使错误类型的引用自动有效。见 [事件 ID 集合与匹配](../../lib/ai/evals/evidence-provenance.ts#L119)。

### 第二轮 inspect：使用实际证据 ID，仍需语义复核

第二轮结果改用三条 Wiki 证据 ID 和上述 FAQ chunk ID，客户引用仍使用实际联系人 ID。实际 GET findings 确认 5 条引用均已观察、3 项字段断言核对通过，没有硬失败；仅保留 `memory_claims_require_semantic_review` 和 `structured_claims_not_independently_verified`，质量维度为 50 / needs_review。这个变化不是已完成语义 Judge，也不是证明内容质量提升了固定比例。

### 第二轮商机：执行后新值与旧读取观察不一致

该 Run 的提案 `ee163528-fb16-44eb-be62-958a742d0a7f` 已执行，业务状态实际从 `83e3b1e9-aea2-4792-85c1-10717a0f93cf` 变为 `a7fadfd4-c987-4fe4-8265-9d144a450927`。但批准后没有再次调用 `crm_get_lead`，结果文档却断言新 `stage_id`。

当前 provenance 检查从 `crm_get_lead` 等读取工具建立可断言字段；没有将 `crm_move_lead_stage` 执行结果合入该字段表。因此该 Run 可核对的读取观察仍是旧阶段，新阶段断言与旧观察冲突。实际 GET findings 确认为 `structured_fact_assertion_mismatch`（1 项不符、3 项核对通过），另有 `structured_result_missing_material`（1 项缺失）及任务完成维度的 `partial_result`。这是业务执行事实与评分观察路径之间的差异，不能把已经成功的变更重新执行。批准后只读重读同一商机可提供新观察，不需要放松字段校验。见 [商机读取工具](../../lib/ai/evals/evidence-provenance.ts#L98)、[字段比较](../../lib/ai/evals/evidence-provenance.ts#L129)。

该结果另有两项实际质量问题：

- 唯一 `missingInformation` 是“执行结果未返回目标阶段的可读名称”，导致续跑 partial / missing_material；本任务指定的目标是精确 `stage_id`，可读名称不是变更验收的必要材料。应明确任务范围，同时保留真正阻止核对目标阶段的错误。
- 正文改为葡语，并把更新时间写成 `2026-08T11:15:41Z`；只读业务对账实际为 `2026-10-28T11:15:41.648Z`。前者是不准确且不完整的时间表达，不能归结为引用格式问题。语言要求和不得拼造观察值也需明确保留。

## 证明路径与限制

本机忽略目录中的两份 `result-proof.json` 位于 `.local/sales-demo/<上述会话 ID>/`，记录 Run 状态、事件、工具范围、实际阶段前后值以及评估维度摘要。两会话的 `crm014-demo-receipts.json` 保留创建、批准与观察回执；首轮辅助脚本失败报告没有被覆盖。

本次专用只读脚本 `.local/crm014-quality-readonly.mjs` 在固定组织、repeatable read / read only 事务内，仅提取上述四个 Run 的 `final_text` 和 `result_document`，结果保存于 `.local/crm014-quality-readonly.json`。没有提取凭据、模型原始续文或隐藏推理；这些本机文件不进入公开提交。

随后以同组织的新登录会话只读 GET 四个既有 Run 的评估，将各维度完整 finding code、静态消息和标量 evidence 保存于 `.local/crm014-eval-findings.json`。该快照核实了上述硬失败及待复核项，不包含客户原文或隐藏续文，也未触发语义 Judge。原 `result-proof.json` 仍保留原来的维度摘要，没有被覆盖。

本页将实际 findings、结果结构与现行规则逐项对应，仍不是对全部自然语言声明的语义判定。后续固定输入只补充中文、真实证据 ID、批准后读取和任务必需材料的约定，不修改权限、审批、missingInformation gate 或计分门槛。新输入的实际复现另行登记，不覆盖四个原 Run 或据此预先判定成功。

这只完成了本次失败样本的局部诊断。CRM-016 还包含长句/短句/无答案知识查询等固定样本，本页不将该票标为全部完成，也不宣称召回优化或生产质量达标。
