# CRM-014v：三任务中文演示实际验收

日期：2026-10-28（Asia/Shanghai）。本次复用既有合成资料和百炼 `qwen3.8-flash`，采用显式 `prepare --split --new` 生成的 v2；前三轮结果与失败完整保留在 [CRM-014b](CRM-014b.md)，没有改写旧 Run、降低评分门槛或补造客户同意。

## 结果与时间

session `86195fb1-5329-4d32-9818-7c004f834fb3`，组织 `16155fc5-1304-4fe0-8a86-d5d5cfeac693`。

| 阶段 | 本次 Run | 实际结果 |
| --- | --- | --- |
| 客户确认事实 | `71544fe6-de80-48b4-9d69-057246caa18d` | completed，23.03 秒；仅 `crm_get_contact`，实际返回 4 条确认记忆、provider connected、coverage complete，无提案/业务变更。 |
| 当前知识证据 | `ccd2fb37-d3f3-4d9d-863e-2981b5379266` | completed，15.46 秒；仅 `crm_search_knowledge`，固定“产品”查询，实际来源为 3 条 WeKnora Wiki 加 1 条原生 FAQ；证据 ID、当前版本及 URI 核对通过。 |
| 阶段提案与续跑 | `b849f387-d56e-4bc2-a79c-7bebad0c1b58` | completed，63.91 秒（含审批等待）；唯一提案 `b22bf4f5-db78-4586-a56f-f3c3a829e46f` executed，批准后重读成功。 |

业务窗口从首 Run 创建 `11:46:13.847920 UTC` 到最后 completed `11:49:45.184 UTC` 为 **211.34 秒（3 分 31.34 秒）**，包含操作者阶段间核对。三个 Trace 最终回查在 `11:50:42.882 UTC` 完成，从首 Run 创建计算为 **269.03 秒（4 分 29.03 秒）**。这是一次本机合成演示实测，不是长期稳定性或延迟承诺。

root 已查看客户清单、知识清单、待批准目标卡片及续跑后的回答截图，三段结果均使用简体中文描述，记录 ID/工具名/原始观察值保持机器值；未把自动化中文字符计数当作答案语义验证。

## 批准前后业务对账

合成商机 `6acd6c2b-f6a3-43a9-ad61-0a4da8e82bd6` 保持 contact_id=null。批准前 SQL 核实唯一 pending 提案的工具及参数，实际阶段仍为 `a7fadfd4-c987-4fe4-8265-9d144a450927`，updated_at 与准备快照一致；UI 展示的商机 ID 和目标阶段 ID 与 SQL 一致。

单独以本次明确 Run/提案参数调用批准阶段，**由 Playwright 自动化操作者点击既有“批准执行”按钮**，不声称真人现场点击。提案 executed，阶段更新到 `83e3b1e9-aea2-4792-85c1-10717a0f93cf`，updated_at=`2026-10-28T11:49:36.238Z`。事件中 `run_resumed` 为 sequence 24，随后 `crm_get_lead` 的成功结果为 sequence 27，证明模型在续跑后重新读取，而不只由验收脚本查 SQL。

四个业务任务（3 start、1 resume）均 done、attempts=1；四条聚合 llm_calls 均 dashscope / qwen3.8-flash / ok。商机运行只观察到 `crm_get_lead`、`crm_move_lead_stage`，没有重复批准，未调用发送、修改金额或新增跟进工具；只读两段均无提案/业务变化。没有调用语义 Judge。

## 观测实际回读

本机受管会话 `ae132554-873d-4592-9bb0-c7985bc97bfb` 的 drain 日志确认显式间隔 10000 ms；每次仍只执行一个远端操作，串行自然消费，无手动 drain。三任务业务校验与观测投递分别记录，最终统一回读为 operationalChecksPassed=true、langfuseVerified=true、exportsPending=false。

| Trace | observations | model / tool | spans 事件 |
| --- | --- | --- | --- |
| `00919b6bb68bd6576b15f407d2716a34`（客户） | 6 | 2 / 2 | 2 条 done |
| `94437fdc52a42424708e404017f2ff77`（知识） | 6 | 2 / 2 | 2 条 done |
| `e46eedf65001dc9ce96e6959f3dd55f0`（商机） | 15 | 6 / 6 | 3 条 done |

七条事件均记录专用消费者；真实 Langfuse observations 的 traceId 均匹配，input/output 为空。观察条数不等于模型账单请求数。费用仍为 NULL/未知，本机演示开关与组织/Mission 预算边界不变。

## 评分与保留边界

实际 GET 评估为 contact **needs_review/89**、knowledge **needs_review/92**、approval **needs_review/89**；三者 answer_quality=50，没有本次未观察引用、字段冲突或缺材料等硬失败，但自然语言声明与客户事实含义仍需独立语义复核，Judge 状态 not_configured。`deterministicEvaluationPassed=false` 保留原值，不能写成全评测通过或已证明回答正确率提高。

本次完成的是固定合成资料下三任务、明确批准、真实落库续跑和观测回读的演示范围。客户发送、连续多轮稳定性、长句检索召回、生产成本与公网部署仍未由该样本证明；CRM-016 的剩余范围另行处理。

## 本机证据位置

以下均位于忽略目录 `.local/sales-demo/86195fb1-5329-4d32-9818-7c004f834fb3/`，不上传凭据、原始会话、图片或客户正文到公开提交。

| 文件 | 内容 |
| --- | --- |
| `session.json` / `crm014-demo-receipts.json` | 固定三个输入、范围、前置快照与分阶段单次创建/批准回执。 |
| `result-proof.json` / `result-proof-1793188330301.json` | 只读业务、任务/模型、事件、耗时与实际评估 findings 对账。 |
| `execution-split-1793188231635-observe.json` | 三 Trace 的实际回读及所有投递状态。 |
| `contact-completed-1793188000946.png` | 客户确认事实中文清单。 |
| `knowledge-completed-1793188094952.png` | 当次知识证据中文清单。 |
| `proposal-before-details-1793188145306.png` | 唯一提案、两项目标 ID 和批准按钮。 |
| `approval-completed-1793188189341.png` | 批准后重读并完成的中文结果。 |

准备入口的 22 项安全检查、消费者的 7 项相关进程检查、ESLint、typecheck、语法/diff 及独立审查见 [CRM-014t](CRM-014t.md)、[CRM-014u](CRM-014u.md)；它们没有替代本页的真实执行。

最终独立事实与文档审查通过：Run、业务、观测、截图和计时一致，107 个本地链接存在，私有证据保持忽略；未把 needs_review、历史失败或单次实测改写为全评测/生产稳定性通过。
