# CRM-021a2：待审展示使用真实 Harness 状态

2026-11-01。本项在 CRM-021 的冻结实测结束后实施。发现样本、原模型提交和最终批准结果均保留；没有修改旧数据库行、原报告、评测阈值或模型输入，也没有追加模型/Judge。

## 真实发现

冻结源码 `0994828c73c2462ffcc8426e59be8ae77a7adc56` 下，新批准 Run `22306fc2-524e-468b-a5ba-b59555ae4bef` 已实际产生唯一 pending 的 `crm_move_lead_stage` 提案，商机尚未变化，且 human_confirmation_received 数为 0。但当时 result_document 的 evidence.claim 已写成“已在决定后只读复核所选商机阶段；动作状态以 Harness 观察为准。”，将尚未发生的决定后观察提前展示成正式模型结果。

这与此前 B03 完全没有提案不同：021a 已修提案形成，本项处理的是 **已有真实待审提案时的展示误述**。该 Run 后续明确批准、执行和续跑已由独立 flow 检查通过；这个后续通过不撤销先前待审 claim 的错误，也不证明本补丁已做新的真实模型验证。

本机来源位于 `.local/crm021/flows/27292d16-cba1-45fc-bf98-393a5c9b4e33/`：

| 原文件 | SHA-256 |
| --- | --- |
| `approval-source-1793514943112-3bb40789-880c-4bc5-8d1e-cfcecbad22c4.json` | `49e09610e36e466343245239ff27899a10a361cb7e0d0dc0853e7562a153a9be` |
| `approval-predecision-source-1793515048316-006b4ab2-3392-4c95-aac4-5828a9dd01a8.json` | `61a4662d210f242a88d412a0c8b62a8b7123dd38bbcf78e7fe765ba01fec9992` |
| 原最终 `approval-review-1793515076334-5d35d506-ef53-4390-9997-f33d039ea962.json` | `98815e0ccbb296f671c3506b6f9286f5fcd35052b1fda59f16cbc6101619a27f` |

以上只离线读取已封存可见结果/允许工具材料，没有新 SQL/API 请求或 privateContinuation 读取。

## 最小修复

共享纯展示函数 `workbenchVisibleResult` 用于 start、resume 两个最终关闭 update：

- 实际 pending 时，final_text 使用服务器说明“当前待审操作提案尚未执行。请核对提案中的目标和参数后明确批准或拒绝。”，result_document=null。只描述当前待审动作，不声称之前的其他动作都未发生。
- pending send_message 沿用更具体的原回复草稿尚未发送提示。start 原 send_message 预处理也保留，避免顺带改变其内部 empty-final/impediments 计算。
- pending 且 collaborationBlocked 时优先显示协作待复核/当前待审动作阻断说明；原 status 判定仍 collaborationBlocked 优先，保持 partial，不变为 awaiting_confirmation。
- 没有 pending 时，真实新 final_text/result_document 原样保留。仅当 priorFinalText 逐字等于三个受控服务器待审占位之一时，不把它当新一轮的 fallback；新模型 fallback、candidateBodies、带其他前缀/正文的 prior 和真实新 submission 都不进行自然语言改写。

start 仍以实际保存的 proposalRows.status/tool 判断。resume 末尾原同 organization/run/status=pending 查询改为读取 id/tool_name 与 exact count，用 DB 真实类型识别既有 send_message，不用本轮 proposalInputs 猜测；查询次数、范围过滤和 error fail-closed 不变。

本项只改变 Run 元数据上的显示结果，原 `ai_agent_run_states.messages` 不改，模型实际提交继续留在原 transcript。UI 的 result_document 本就可空，提案卡、批准按钮、preview、observed_evidence 以及按会话权限读取的 reply draft_body 均为独立来源，无需伪造一个 trust=model_submitted 的服务器 document。评测输入支持 null，本项不靠结构化假结果规避待审阶段的不完整状态。

预算、审批、动作执行、回执、继续轮次、来源与对象校验、错误码优先级均沿用既有流程；没有自动批准、额外动作或旧 Run 回填。

## 直接回归与边界

三个目标测试文件共 **25 项通过**，分别为 helper 15 项、start 4 项、resume 6 项；不叠加此前重复运行次数。测试使用确定性 mock/faux，未调用真实 provider、DB、HTTP 或 Judge。

七项新增 helper 回归覆盖提前完成 claim 的隐藏与输入不变、send_message 原文、协作阻断优先、真实完成结果、原 partial/null，以及精确服务器 prior 占位排除与任意新正文保持。四项新增关闭路径接线回归实际调用被测函数并捕获最终 update，而不是只扫描源码：

1. start 工具 execute 真实进入暂存 wrapper，保存一条 pending proposal，但原外发 execute 不调用；正式展示为服务器待审文案/doc=null，原 transcript 不改。
2. resume 本轮无新提案但 DB 有普通 pending，仍正确关闭为 awaiting_confirmation。
3. resume DB 既有 send_message 保留更具体的发送草稿提示。
4. resume blocked+send pending 仍 partial/协作阻断，doc=null。

另强化现有真实 Pi faux 完成对照，核对 completed 的原 summary、完整 model_submitted document 与 error_code 保留；resume 检查器断言末尾查询的字段及 organization/run/status 三个过滤。

六个相关文件限定 ESLint 均退出 0，限定 `git diff --check` 通过。首次 helper 文件过滤误匹配忽略目录的旧草稿副本，产生两条过期文案断言失败，正式目标文件本身通过；私有测试副本已仅改 `.draft` 后缀防自动发现，随后显式排除 `.local/**` 的正式 helper 15/15 通过。接线测试第一次沙箱 cache rename EPERM 未完成收集，随后同一两文件命令在授权环境下 10/10 通过。上述仪器问题不计作产品失败或新增成功样本。

修改文件限于 `workbench-result-submission.ts`、`workbench-start-job.ts`、`run-resumed-workbench-turn.ts` 及各自上述直接回归所在三测试文件。全仓 typecheck 由根代理统一执行，本文不提前声称已通过。

本项证明服务器待审显示与所列关闭路径正确，不证明模型不会在原 transcript 中说错话或所有答案语义正确。此次真实发现原文保留；无新增真实模型、业务请求或评分来替换旧结果。
