# CRM-010：Mem0 本机验收

日期：2026-10-28。使用本机合成组织、客户和事实；Mem0 的数据独立于 CRM 数据库，服务端口仅绑定本机。

- 固定上游 Mem0 服务及本地 FastEmbed 模型已启动；实际向量模型为 `BAAI/bge-small-zh-v1.5`。未带凭据访问被拒绝，协议检查通过，合成数据的写入、语义搜索和删除均成功。
- 通过 CRM 管理员接口启用 Mem0 并确认客户事实；记忆 `8d74749c-b452-4d1e-a9a8-63e672bf06a5` 通过项目现有同步函数投影后，状态为 `synced/confirmed`；真实 Mem0 搜索命中，CRM 的 `readConfirmedCustomerMemory` 返回 `providerStatus=connected` 并读到该本地事实。
- 新记忆 `1edee372-a4ae-4f8c-ad05-a1369b7d706b` 从 `pending` 经真实专用集成队列入口处理为事件 `done`、记忆 `synced/confirmed`。随后启动仅本机专用定时器，再创建记忆 `62adc157-7918-4e57-a891-c2976554b9e9`，未手动触发队列，该记忆自动从 pending 变为事件 `done`、记忆 `synced/confirmed`。生产 scheduler 配置为每分钟触发；普通 Worker 的 business 队列健康不代表 integration 队列也会被自动处理，本机定时器的启动方式见本地开发文档。
- 新 Agent Run `b4f5773e-6c44-4223-a2ae-7597bcf9a2b3` 返回 `partial/missing_material`，模型未调用 `crm_get_contact`，因此本次不能宣称 Mem0 经 Agent 工具的完整链路成功。
- CRM 是确认事实的权威来源，Mem0 仅辅助排序本组织拥有的事实。当前使用 `infer:false`，未验证自动事实抽取、记忆衰减或冲突自动处理；单次搜索命中不代表业务召回率。
- 本机隔离数据库实际基于已有 PostgreSQL 15.19 镜像，不是来源部署文档里的 15.8 固定镜像；启动时使用本机已有 `su-exec` 代替该镜像缺少的 `gosu`。上述是本机环境适配，不代表生产部署已完成。

- 随后指定现有合成客户发起 Run `22fe4d29-3077-4384-bde3-886ce6e6f21a`，状态 `completed`，调用 `crm_get_contact` 并回答客户沟通偏好。Mem0 日志的 `/search` 200 落在工具调用时间窗内，结合调用路径确认实际经过 Mem0 检索；事件已脱敏，不能证明答案具体引用了哪一条重复的 SQL 记忆。
