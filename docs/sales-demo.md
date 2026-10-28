# 3–5 分钟中文销售演示

最新三任务本机复现已完成：业务窗口 3 分 31 秒，含 Langfuse 回查 4 分 29 秒。输入和步骤如下；这个合成样本不代表生产稳定性。[最新结果](evidence/CRM-014v.md)与[前三轮失败](evidence/CRM-014b.md)均保留，评估仍需语义复核。

演示先展示销售准备，再展示审批执行：CRM 情报员分别读取合成客户确认事实、列出产品知识证据；销售运营 Agent 对另一条合成商机提出阶段变更，由操作者核对后批准，Worker 续跑。推荐的 v2 是三个独立任务，客户和商机使用不同合成记录，不宣称同一客户成交或一个 Run 自动完成全部流程。

## 开场前准备

在仓库根目录运行 `node scripts/local-crm.mjs status`，确认 Web、Worker、当前需要的 Mem0/WeKnora/Langfuse 可访问，任务队列没有 pending/running。健康端点只能证明服务响应，不能代替登录、检索或观测回查。Web 的 Redis/WAHA 未配置可保持 degraded；本演示不走客户渠道。

使用已有本机合成 fixture，不重新 seed、迁移或清库。准备入口和生成文件格式见下文；记录仅留在忽略的 `.local/`，不要上传登录凭据、环境文件、浏览器会话或续跑原文。API Key 由现有组织加密配置加载，演示输入不包含 Key。

```powershell
npm run demo:sales
npm run demo:sales -- prepare --split
```

第一条仅显示帮助；第二条只读检查 SQL 并生成 `.local/sales-demo/<sessionId>/session.json`，`current.json` 保存本次文件位置。它不会调用模型、写 CRM 或批准提案。当前本机需要已有的 `.local/approval-synthetic-case.json`、`mem0-crm-case.json`、`weknora-crm-case.json` 三份 fixture；缺失或授权/合成标记不符时拒绝，不会自动建资料。不传 `--split` 仍生成旧 v1 两任务格式，仅用于兼容原流程。

v2 依次使用 `runs.contact.task`、`runs.knowledge.task`、`runs.approval.task`，按对应 `mode`、`scope` 和 `agentId` 操作。联系人在“任务设置”中选择对应合成客户；知识任务新对话时清除目标对象，使 scope 为空；商机可打开 `workbenchUrl?leadId=<leadId>` 预选。每段只提交一次，并把返回 Run ID 记在本次目录；再次打开用 `/app/ai/workbench?run=<Run ID>`。`runs` 中每个对象也可作为现有创建 Run API 的请求体，字段为 `agentId/task/mode/collaboration/scope`。业务断言与 Langfuse 异步投递分别核对，不把尚在排队的观测称为已回读。

完成或明确处理上次运行后，下一次演示执行 `npm run demo:sales -- prepare --split --new`，保留旧 session 并按当前阶段选择另一目标。存在未完成 Run/未决提案时准备会拒绝；不自动取消、批准或回滚。准备快照不等于执行锁，提交前和批准前仍须复核对象、当前阶段和本次提案。

## 讲解顺序

| 时间 | 操作与讲解 | 应看到的结果 |
| --- | --- | --- |
| 0:00–0:30 | 打开中文工作台，说明当前模型及本机演示预算提示。 | 百炼 `qwen3.8-flash`；普通工作台任务关闭单次金额预算，仍沿用步骤/token 控制。费用未知，以服务账单为准。 |
| 0:30–1:10 | 选择“CRM 情报员”、只读模式，提交 contact 任务，绑定合成联系人。 | 仅调用 `crm_get_contact`，列出确认记忆、状态与事实 ID，不评判未来触达前提。 |
| 1:10–2:00 | 新对话清除目标对象，提交 knowledge 任务，展开知识证据。 | 仅调用 `crm_search_knowledge`，用短词“产品”列实际片段/证据 ID、来源与检索标记；当前授权版本/URI 可核对。 |
| 2:00–3:00 | 新对话，选择“销售运营 Agent”、分级自治模式，打开合成商机入口，提交 approval 任务。 | 仅出现一条 `crm_move_lead_stage` 待确认提案；目标商机和阶段 ID 可核对，批准前数据库阶段不变。 |
| 3:00–4:00 | 操作者核对后点“批准执行”，查看续跑与商机记录。 | 提案 `executed`，商机阶段落库，出现 `run_resumed`，同一 Run 最终 `completed`；仅排队/批准不代表任务完成。 |
| 4:00–5:00 | 打开对应 Langfuse Trace 或回查报告，解释模型与工具调用。 | 本次 Run 的模型/工具 observations 可回读；不展示客户正文，不把队列 done 当作远端记录已经存在。 |

远端模型和集成有等待时间。时间表是讲解顺序；最新三任务实际完成约 3 分 31 秒，含观测回查约 4 分 29 秒，使用本机显式 10 秒集成间隔。前序两任务的 5 分 39 秒及复现失败另保留。若超时，保留当前 Run 后继续观察，不重复点“发送”或重新批准。

## 固定输入与验收边界

三个任务的自然语言字段均要求简体中文，JSON 键、枚举和观察标量保持原值。客户任务 `runs.contact` 仅调用 `crm_get_contact`；成功时 summary 为 JSON 文本，外层只列 `status/coverage/providerStatus/memories`，按返回顺序保留每条记忆的 `id/body/confirmed/revision`，包括正文重复的记录。逐值复制，不附加时间字段或版本差异分析；引用使用 contact 的实际 ID，记忆 ID 不冒充 knowledge 证据。不判定未来触达同意，不把联系人偏好升级为公司政策；真实错误或不完整读取优先如实说明。

知识任务 `runs.knowledge` 仅调用 `crm_search_knowledge`，`pergunta` 精确为“产品”、`quantidade` 为 5；只列本次实际返回的证据/片段 ID、来源标题和检索状态，不推演完整产品目录，不因不足 5 条自动判定缺料。知识引用不用父知识源 ID 替代实际证据，工具真实失败或明确阻止查询的缺口仍须报告。

商机任务 `runs.approval` 仅允许读取选中商机并提议移动到准备时选定的非终态阶段。明确批准后再调用 `crm_get_lead`，以实际 stage_id 核对目标；可读名称和客户关联不属于本次内部移动的必要材料，真正核对失败仍应报告。商机 UUID 不能冒充事件 UUID，不拼造时间；不创建跟进、修改金额或发送消息。商机在两个阶段间交替，重新准备时应取当前状态。

Mem0 是 CRM 确认事实的辅助排序，SQL 仍为权威。工具成功和答案包含偏好不能单独证明引用了哪条重复记忆；只按本次持久化工具结果中的状态、确认标志和记录 ID 验证。WeKnora 曾出现长句未命中，使用“产品”只证明这个固定合成样本可演示，召回改进另见 CRM-016。

## 失败时的处理

| 现象 | 处理 |
| --- | --- |
| 登录失效、组织不匹配或前置校验失败 | 停止创建任务，重新登录并核对当前组织/本机 fixture；不要改全局组织或关闭权限。 |
| 创建请求超时，不确定是否创建成功 | 在最近运行中按本次任务标识查找并记录 Run ID，只观察已有 Run；不要盲目重发。 |
| 客户事实缺失、知识 empty/partial 或错误来源 | 如实展示缺口并停止该步成功陈述；不要改写答案或用旧 Run 冒充本次。 |
| 提案不是唯一阶段变更，或目标/当前阶段已变化 | 不批准；核对 Run、提案参数和业务记录，必要时拒绝/取消后重新准备。 |
| 批准返回冲突或结果不确定 | 先读取原 Run、提案状态和商机；禁止重复提交来“修复”。 |
| 已执行但续跑 partial/failed | 业务阶段可能已改变。保留执行事实与错误，先检查模型预算/配置，不把已落库动作重复执行。 |
| Langfuse 尚无 observations | 检查专用 integration drain 与事件状态，等待本次 Trace；没有回读前只称“待投递/待确认”。 |

不触发自动 Judge、不发送客户消息、不创建 Mission，不以公网部署为前置。默认金额预算保护及本机开关范围见 [CRM-008](evidence/CRM-008.md)，服务启停与显式集成间隔见 [本地运行](local-development.md)。最新三个 Run 的确定性评估为 needs_review/89、92、89，答案质量项均为 50，仍需语义复核；[前序失败](evidence/CRM-014b.md)未删除。业务落库和 Run completed 不能代替全评测通过，讲解中应如实展示。
