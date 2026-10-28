# 3–5 分钟中文销售演示

演示先展示销售准备，再展示审批执行：CRM 情报员读取合成客户的确认沟通偏好与产品知识；销售运营 Agent 对另一条合成商机提出阶段变更，由操作者核对后批准，Worker 续跑。两个任务使用不同的合成记录，不宣称同一客户成交或一个 Run 自动完成全部流程。

## 开场前准备

在仓库根目录运行 `node scripts/local-crm.mjs status`，确认 Web、Worker、当前需要的 Mem0/WeKnora/Langfuse 可访问，任务队列没有 pending/running。健康端点只能证明服务响应，不能代替登录、检索或观测回查。Web 的 Redis/WAHA 未配置可保持 degraded；本演示不走客户渠道。

使用已有本机合成 fixture，不重新 seed、迁移或清库。准备入口和生成文件格式见下文；记录仅留在忽略的 `.local/`，不要上传登录凭据、环境文件、浏览器会话或续跑原文。API Key 由现有组织加密配置加载，演示输入不包含 Key。

```powershell
npm run demo:sales
npm run demo:sales -- prepare
```

第一条仅显示帮助；第二条只读检查 SQL 并生成 `.local/sales-demo/<sessionId>/session.json`，`current.json` 保存本次文件位置。它不会调用模型、写 CRM 或批准提案。当前本机需要已有的 `.local/approval-synthetic-case.json`、`mem0-crm-case.json`、`weknora-crm-case.json` 三份 fixture；缺失或授权/合成标记不符时拒绝，不会自动建资料。

在生成的文件中复制 `runs.inspect.task`、`runs.approval.task` 两段中文输入，按对应 `mode`、`scope` 和 `agentId` 操作。联系人在“任务设置”中选择对应合成客户；商机可打开 `workbenchUrl?leadId=<leadId>` 预选。每段只提交一次，并把返回 Run ID 记在本次目录；再次打开用 `/app/ai/workbench?run=<Run ID>`。`runs` 中每个对象也可作为现有创建 Run API 的请求体，字段为 `agentId/task/mode/collaboration/scope`。

完成或明确处理上次运行后，下一次演示执行 `npm run demo:sales -- prepare --new`，保留旧 session 并按当前阶段选择另一目标。存在未完成 Run/未决提案时准备会拒绝；不自动取消、批准或回滚。准备快照不等于执行锁，提交前和批准前仍须复核对象、当前阶段和本次提案。

## 讲解顺序

| 时间 | 操作与讲解 | 应看到的结果 |
| --- | --- | --- |
| 0:00–0:30 | 打开中文工作台，说明当前模型及本机演示预算提示。 | 百炼 `qwen3.8-flash`；普通工作台任务关闭单次金额预算，仍沿用步骤/token 控制。费用未知，以服务账单为准。 |
| 0:30–1:30 | 选择“CRM 情报员”、只读模式，使用生成的第一段任务，绑定合成联系人。 | `crm_get_contact` 返回确认沟通偏好，`crm_search_knowledge` 以固定短词“产品”检索；回答区分客户事实、产品依据与未知。 |
| 1:30–2:00 | 展开运行详情，查看本次知识证据的来源、版本和 URI。 | 本次 Run 有当前授权 WeKnora 来源的不可变证据；不能仅凭回答提到“知识库”就称检索成功。 |
| 2:00–3:00 | 新对话，选择“销售运营 Agent”、分级自治模式，打开生成的合成商机入口，提交第二段任务。 | 仅出现一条 `crm_move_lead_stage` 待确认提案；目标商机和阶段 ID 可核对，批准前数据库阶段不变。 |
| 3:00–4:00 | 操作者核对后点“批准执行”，查看续跑与商机记录。 | 提案 `executed`，商机阶段落库，出现 `run_resumed`，同一 Run 最终 `completed`；仅排队/批准不代表任务完成。 |
| 4:00–5:00 | 打开对应 Langfuse Trace 或回查报告，解释模型与工具调用。 | 本次 Run 的模型/工具 observations 可回读；不展示客户正文，不把队列 done 当作远端记录已经存在。 |

远端模型和集成有等待时间。时间表是讲解目标；若超时，保留当前 Run 后继续观察，不重复点“发送”或重新批准。

## 固定输入与验收边界

第一段任务要求先调用 `crm_get_contact`，仅采用 `confirmed_customer_memory` 中的确认事实，再调用 `crm_search_knowledge`，`pergunta` 精确为“产品”、`quantidade` 为 5。知识依据由工具提供，不把联系人偏好升级为公司政策。第二段仅允许读取选中商机并提议移动到准备时选定的非终态阶段，不创建跟进、修改金额或发送消息；已有商机在两个阶段间交替，重新准备时应取当前状态。

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

不触发自动 Judge、不发送客户消息、不创建 Mission，不以公网部署为前置。默认金额预算保护及本机开关范围见 [CRM-008](evidence/CRM-008.md)，服务启动与停止见 [本地运行](local-development.md)。本次真实 Run 与本机截图将登记在 CRM-014 的验收记录中。
