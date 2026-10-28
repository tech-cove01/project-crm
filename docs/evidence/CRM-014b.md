# CRM-014b：真实销售演示与审批续跑

日期：2026-10-28（Asia/Shanghai）。使用本机既有合成资料、百炼 `qwen3.8-flash` 和当前组织的三个集成；用户已明确这些资料均为合成并允许使用。首轮新建两个 Run，审批另行显式执行，没有重新 seed、调用客户发送工具或触发语义 Judge。

本页保留旧两任务模式的首轮成功及随后两次未通过复现；这三轮结束时 CRM-014 尚未完成。该阶段共创建 5 个 Run、明确执行 2 个独立提案，第三次只读未通过后没有推进商机或反复批准。随后改为三任务的真实结果另见 [CRM-014v](CRM-014v.md)，不覆盖本页失败。答案质量原因另见 [只读诊断](CRM-014-quality-diagnosis.md)。

## 首轮结果

演示 session：`03a66981-776e-4024-974d-fcf8641abd93`，组织：`16155fc5-1304-4fe0-8a86-d5d5cfeac693`。客户资料和独立无客户关联的商机是两个场景，未把它们描述为同一客户的销售结果。

| 步骤 | 本次真实结果 |
| --- | --- |
| 客户与知识 | Run `ec2b2c4f-221c-42de-8a9b-6987009541e7`，CRM 情报员、inspect、completed；仅观察到 `crm_get_contact` 和 `crm_search_knowledge`，没有提案或 `crm_state_changed`。 |
| 确认客户记忆 | 持久化工具结果中 `source=crm_confirmed_facts`、`providerStatus=connected`；返回 4 条带 revision/confirmed/authority 的记录，包含准备时指定的记忆。页面回答工作日下午三点通过邮件沟通，明确仅作客户上下文。 |
| 产品知识来源 | 固定 `pergunta=产品`、`quantidade=5`，WeKnora 状态 complete；本 Run 记录来源 `54aabec4-e07d-4548-af41-684136aca033` 的 3 条 current / immutable_observation_manifest 证据及版本哈希、URI，同时返回 1 条原生片段。页面区分依据与未知，展开证据区域可查看来源。 |
| 商机提案 | Run `98637ea8-3f6a-4dbb-8a9d-624affd82495`，销售运营 Agent、act；唯一提案 `829763f3-60de-4ad6-9086-588baf237774`，工具 `crm_move_lead_stage`，进入 awaiting_confirmation。 |
| 批准前 | SQL 核对提案 `lead_id=6acd6c2b-f6a3-43a9-ad61-0a4da8e82bd6`、`to_stage_id=83e3b1e9-aea2-4792-85c1-10717a0f93cf`；商机仍在 `a7fadfd4-c987-4fe4-8265-9d144a450927`，updated_at 与准备快照一致。中文卡片展示的两项 ID 与 SQL 一致。 |
| 明确批准与落库 | 单独调用本次 Run/提案的验收阶段，由 **Playwright 自动化操作者点击既有“批准执行”按钮**，不是声称真人现场操作。提案 executed，商机目标阶段实际落库；事件出现 human_confirmation_received、crm_state_changed、run_resumed，最终同 Run completed。 |
| 续跑与工具范围 | 本次商机运行只观察到 `crm_get_lead`、`crm_move_lead_stage`；批准前和续跑后均按精确工具集合核对，未使用发送、修改金额或新增跟进工具。完成结果由业务状态与执行记录共同核实，未仅采用模型自述。 |
| 任务与模型对账 | 两条 workbench_start 和一条 workbench_resume 均 done、attempts=1；三条聚合 llm_calls 均 dashscope / qwen3.8-flash / ok。只读 Run 用时约 18.18 秒；商机 Run 约 80.62 秒，含约 49.03 秒审批等待。 |
| Langfuse 实际回读 | inspect Trace `524fc388f20e34fdf3dd552d34629763`：8 observations，3 model / 3 tool；商机 Trace `4af9755bae88fa2412d99931920f3757`：14 observations，6 model / 5 tool。两者 input/output 均为空；共 5 条 spans 事件由专用消费者自然变为 done，未手动 drain。observations 数不等于独立 Run 或账单请求数。 |

本次 Workbench 保留 `localUnpricedDemo=true / costBudgetCents=null` 的适用边界，费用仍未知；未修改组织或 Mission 预算。初次 inspect 发送后补充回查组织配置与实际 `llm_calls`，确认均为已授权的 dashscope / qwen3.8-flash；后续阶段已在付费操作前再次核对当前模型、登录组织和合成资料。服务恢复使用 CRM-013 的受管入口，只重启本会话 Web/Worker/drain，没有操作其他项目容器。

## 本机证据与截图

所有文件位于仓库忽略目录 `.local/sales-demo/03a66981-776e-4024-974d-fcf8641abd93/`，不随公开提交上传。`session.json` 为固定输入和批准前快照，`crm014-demo-receipts.json` 为两阶段回执与工具/证据断言，`model-boundary-proof.json` 为 inspect 的实际模型回查；`result-proof.json` 为最终业务状态、任务/模型、事件、耗时与确定性评分的只读对账。

| 本机文件 | 用途 |
| --- | --- |
| `inspect-completed-1793185355305.png` | 已完成客户偏好与知识回答。 |
| `inspect-completed-details-1793185355722.png` | 本 Run 的实际知识证据区域与结构化结果。 |
| `proposal-before-details-1793185419607.png` | 批准前唯一待确认动作、两项目标 ID 和确认按钮。 |
| `approval-after-1793185552281.png` | 续跑完成后的中文结果。 |
| `approval-after-details-1793185552646.png` | executed、completed 及仍未通过的确定性评估。 |
| `execution-1793185347624-observe.json` | 客户/知识 Run 回查及实际 Langfuse observations。 |
| `execution-1793185397377-propose.json` | 本次提案与批准前检查。 |
| `execution-1793185545516-observe.json` | 已执行商机 Run 的最终回查，未重复批准。 |

root 已逐张查看客户回答、知识证据区域、批准前目标和完成后的页面，核对与回执一致。输入、操作顺序、重跑方式和预计 3–5 分钟讲解见 [演示手册](../sales-demo.md)。两 Run 首次 created 至最后 completed 的实际墙钟为 **339.26 秒（5 分 39 秒）**，含阶段间脚本诊断间隔；首次完整验收未验证连续 3–5 分钟达标，也未录制视频或作性能承诺。

## 保留的失败和边界

- 第一次 inspect 已 completed，但私有观测回查将原生 fetch 的 `ok` 属性误当方法，报告失败。修复后仅 `--observe` 原 Run，回读成功，未新增模型 Run；原 `execution-1793185137490-inspect.json` 保留。
- 商机批准和续跑已 completed，随后截图重开页面时发生导航/响应读取错误。先结束旧页面再监听新请求后，仅观察原 Run 恢复截图和 Langfuse 回读，未重试批准；原 `execution-1793185456275-approve.json` 保留。这是验收辅助脚本故障，不据此推断业务动作失败或成功。
- 两条既有评估 GET 只读回查均为 **fail**：inspect 的 overall 为 **83**，商机为 **79**，两者 **answer_quality=0**，语义 Judge 状态 not_configured。业务状态与续跑可核实，不表示答案评分已通过；CRM-016 保留诊断项，不调低门槛或删除历史失败。本轮没有追加语义 Judge。
- 4 条重复偏好在工具结果中可核对，但不能判断模型最终采纳了哪一条；Mem0 仍只辅助排序，CRM SQL 是确认事实权威。短查询“产品”的成功不证明长句召回已改善。
- 两个真实 Run 不等于全自动成交、客户发送、完整表级变更对账或生产稳定性验收。真实渠道、正式成本与公网部署仍在原票据范围之外。

## 第二次复现：阶段已变更，续跑未完成

session `111342f9-bd2e-4d59-aba9-2a32df892a61` 保留在同级本机目录。inspect Run `774204eb-0c47-413a-8d1c-7eea26cf0969` completed（约 16.82 秒）；商机 Run `c137fda4-60d8-46af-9c18-96b03133e80e` 的新提案 `ee163528-fb16-44eb-be62-958a742d0a7f` 批准后 executed，阶段由 `83e3b1e9-aea2-4792-85c1-10717a0f93cf` 切回 `a7fadfd4-c987-4fe4-8265-9d144a450927`。这是新任务的反向阶段移动，不是重新批准首轮动作。

本次三个任务均 done、attempts=1，start/resume 模型记录均 ok，实际业务变更与 run_resumed 存在；但商机 Run 最终为 **partial / missing_material**，复现整体验收未通过。总墙钟 239.91 秒，不能用耗时进入目标区间掩盖未完成。确定性评估为 inspect needs_review/92（answer_quality=50），商机 fail/66（answer_quality=0）；没有调用语义 Judge。

只读对照表明，阶段移动结果含 stage_id 但不含阶段可读名，模型未再次读取商机便将“缺少目标阶段可读名称”列入 missingInformation，原 gate 正常标为 partial。首轮在批准后又调用了 crm_get_lead。第二轮还出现葡语及不准确的时间文本，不能只因数据库更新就称中文演示或回答质量通过。

本机 `result-proof.json` 保留 operationalChecksPassed=false、deterministicEvaluationPassed=false；原阶段报告和两张批准前截图均保留，没有再次批准或删除失败。任务输入随后按 [CRM-014r](CRM-014r.md) 和 [CRM-014s](CRM-014s.md) 明确语言、批准后只读复核及真实证据 ID，不修改审批、运行完成 gate 或评估规则。

## 第三次复现：只读阶段未通过

使用新输入的 session `9db11bda-2118-430b-8e6e-78af432c1470`，仅创建 inspect Run `ac5feae4-0888-4ff9-b002-abffd5a7e64b`。两个读取工具均有事件，但最终仍为 **partial / missing_material**，报告保存在该本机目录的 `execution-1793186692402-inspect.json`。没有创建后续商机 Run 或执行批准；不能宣称新输入已解决稳定性问题。

只读诊断确认记忆 connected/complete、知识 complete、4 个知识引用均为真实返回 ID，模型调用正常、未遇预算/安全阻挡。唯一 missingInformation 是联系人电话为 null、consent 为空，不能证明未来邮件渠道显式同意；这是模型将未来触达前提扩大成本次只读任务缺口。没有补造电话/同意记录或绕过 gate，元数据保存在 `.local/crm014-inspect-ac5feae4-diagnosis.json`。

此后以 CRM-014t 拆小任务并继续使用原模型，真实结果见 [CRM-014v](CRM-014v.md)。本页失败证据和评估结果保持原样，没有跳过 gate、降低评分门槛或删除失败 Run。
