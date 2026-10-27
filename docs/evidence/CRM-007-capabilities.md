# CRM-007：记忆、知识库、审批与评估验收

日期：2026-10-27。以下均使用本机独立 CRM、合成客户和合成业务资料；真实模型请求由百炼计费，没有连接或发送客户渠道消息。

| 能力 | 本次结果 | 范围与边界 |
| --- | --- | --- |
| 客户记忆 | 人工确认的合成偏好写入 SQL，可读取；同一 request_key 重放返回同一 ID。新 Run `50c0a193-b536-4886-b64f-d4f1588e21cf` completed，Qwen 经 `crm_get_contact` 引用该事实。 | 验证的是本地已确认事实，不是自动抽取、冲突解决或衰减。另一次含未知项的 Run `7eebfb3f-8c30-4e76-8803-e0d0555da78a` 为 partial/missing_material。 |
| 组织记忆 | 管理接口可读取，当前无已发布条目。 | 未验证组织文档发布与 Agent 引用。 |
| 原生知识库 | 真实合成 FAQ `c4f5f4d0-cae0-4cec-8433-5eaf044d21de` 使用百炼 `text-embedding-v4` 1536 维完成索引；Run `f4842ff3-2179-471f-a448-6a3955bf44eb` completed，Agent 调用 `crm_search_knowledge` 并引用 FAQ 正确回答。 | 百炼使用安装级开关；不同模型或组织不可混查。单个样本不证明真实业务召回率。 |
| 审批和执行 | 合成商机阶段变更经人工批准后真实落库；缺渠道的跟进不再误报成功。 | 两次批准后 Run 均因百炼费用未知而 partial，详见 [审批验收](CRM-007-approval.md)。真实渠道外发和普通 Workbench 回复候选发送未验收。 |
| Trace / 规则 Eval | 先前真实 Run 的规则评估 GET 为 200，返回 score=89 和 verdict=needs_review。 | 这是单次诊断结果，不是质量提升指标；语义 Judge 显示 not_configured，未调用。 |
| Mem0 / WeKnora / Langfuse | 本机集成接口返回三项 configured=false、enabled=false。 | 三者有可选适配代码，本次没有部署、连接或验收。 |

## 向量安全与迁移

- `.env.local` 的 `CRM_EMBEDDING_PROVIDER=dashscope` 使 Web 和 Worker 共同使用本组织已验证的百炼加密凭据；未设置时仍默认 OpenAI。百炼向量请求固定官方端点，发送 1536 维参数并拒绝跨供应商凭据。
- PostgreSQL 0410 迁移已在本机独立 CRM 数据库应用。真实合成索引的模型为 `dashscope/text-embedding-v4`、状态 ready、1 个切片；同模型检索 1 条，指定 OpenAI 模型或不同组织均为 0 条；认证用户跨组织访问被拒绝。
- 自动回滚的数据库事务中将同一合成版本暂标为 OpenAI：OpenAI 模型过滤得到 1 条，百炼模型过滤 0 条；这是模型过滤验证，不是实际 OpenAI embedding 质量验证。
- 旧 5 参数 `retrieve_top_k_chunks` 无法携带模型身份，迁移后明确拒绝调用；旧应用和新迁移不能混用，升级时需同步部署新应用。模型不同或旧版本 provenance 未知的索引需要重新索引，不能把相同维度当作相同向量空间。
- 百炼 OpenAI 兼容接口当前无法指定 query/document 类型；一次合成 FAQ 命中不等于已完成真实业务召回评测。
- 向量接入的 5 个直接相关测试文件共 29 项通过，完整 TypeScript 类型检查通过；原生 OpenAI 默认路径有直接检查，但本机未配置 OpenAI Key，未做 OpenAI 真实调用。

## Skill 用途

- `crm-agent-runtime` 提供 Pi Agent 运行、状态与工具相关的参考资料；以本仓 0.86.1 和实际源码为准，不自动实现功能。
- `workspace-delivery` 维护规格、任务、状态、证据与小功能提交。
- `ai-native-crm-resume-skill` 帮助理解数据、Agent Harness 与评测层的架构并组织可核实的求职素材，不是 CRM 运行时的记忆 Skill，也不会自动部署 Mem0/WeKnora。
