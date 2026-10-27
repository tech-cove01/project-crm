# 当前能力与二开边界

审查日期：2026-10-27。依据 CRM-001 导入基线 `06fac28`；来源、许可与文件映射见 `THIRD_PARTY_NOTICES.md`、`docs/upstream/import-manifest.json`。

以下实现均为**上游继承能力**，不是本次个人新增。“已接线”仅表示找到源码入口和消费者，不代表本机已通过数据库、登录、Worker、模型或客户渠道验收；实际运行进度以 `docs/STATUS.md` 为准。本文路径均相对仓库根目录。

## 业务背景

这是一套面向销售团队的 CRM：管理客户与商机，结合客户上下文和公司知识生成建议，再经权限、审批及执行回执推动跟进。Agent 并非单独聊天页，而是读取和操作 CRM 的执行入口；但不能把现有代码描述成已验证的全自动销售闭环。

## 源码能力矩阵

| 能力 | 已有实现与主要路径 | 当前边界 / 可二开的内容 |
| --- | --- | --- |
| 核心 CRM | 客户、沟通 Inbox、商机看板、任务及组织权限；`app/api/v1/contacts/_handler.ts`、`hooks/kanban/useMoveCard.ts`、`app/api/v1/leads/[id]/move/route.ts`。 | 本机已验收登录、核心页面及合成客户创建/纠正/刷新读取；商机推进、销售跟进等完整业务链仍待分别验证。 |
| Agent 工作台与 Worker | `app/app/ai/workbench/_components/AgentCrmWorkbench.tsx` → `app/api/v1/ai/workbench/runs/route.ts` → SQL Run / `workbench_start` 队列 → `workers/agent-worker/main.ts` → `lib/ai/agents/workbench-start-job.ts`。模型经 `lib/agent-engine/edge/llm/run-model-call.ts` 接入 `lib/agent-runtime/pi/runtime.ts`。 | 有持久化事件、SSE 回放、取消及恢复路径；每次工作台发送创建独立 Run，不能默认等于自动携带全部历史的连续会话。 |
| 四个内置 Agent | `lib/ai/agents/builtins.ts` 定义 `crm_intelligence`、`sales_operations`、`customer_communications`、`crm_supervisor`；Run API 调用 `ensureBuiltinAgents`。 | 分别覆盖客户分析、销售操作、沟通与监督，配置和运行效果仍需本机验收；名称不是效果证明。 |
| 工具约束、审批与执行 | `lib/ai/agents/tool-effects.ts` 区分工具效果；`app/api/v1/ai/workbench/runs/[id]/proposals/[proposalId]/decision/route.ts` 接收决定；`lib/ai/agents/approved-workbench-tool.ts`、`lib/ai/agents/workbench-approved-action.ts` 负责批准动作、回执及后续处理。 | 已有权限、预算、审批、持久化、恢复等执行约束；仍须逐业务动作验证，不能泛称所有外部副作用都恰好执行一次。 |
| 审批后发送的具体缺口 | `lib/ai/agents/workbench-start-job.ts` 与 `lib/ai/agents/run-resumed-workbench-turn.ts` 均传入 `candidates: []`。 | 虽有发送消费者，普通工作台当前没有自动生成回复候选的完整接线；不能宣称“工作台生成回复 → 人批 → 发给客户”已闭环。这是可独立二开的业务缺口。 |
| 多 Agent 协作 | `lib/ai/agents/workbench-collaboration.ts` → `lib/ai/agents/collaboration-runtime.ts`，计划选择在 `lib/ai/agents/collaboration.ts`；专业子 Agent 主要只读调查，结果与证据持久化，由父 Agent 统一处理写入。 | 是有限的专业分工，不是任意动态 Agent 图；Mission 场景将 `maxParallel` 限制为 1，不能宣传所有场景并行。 |
| 持续业务 Mission | Run API 可创建 `ai_missions`；`lib/ai/agents/mission-wake.ts`、`lib/ai/agents/mission-deadlines.ts` 以及命令/内部响应接口处理唤醒、期限、方向修订和继续执行。定义见 `docs/architecture/mission-state.md`。 | Run 完成不等于业务 Mission 达成；模型自述不能替代业务事实。客户消息唤醒有文本和唯一适用 Mission 等条件，不是无限自主执行。 |
| 客户与组织记忆 | `components/ai/CustomerMemoryPanel.tsx` 被客户详情页消费；`app/api/v1/ai/customer-memory` 接收人工确认事实并写 SQL/事件；`lib/agent-engine/agent/org-memory.ts` 读取已发布的组织记忆版本。 | 客户偏好、确认事实属于客户上下文，组织规则属于另一权威域；会话 checkpoint 是恢复状态，不能混称长期事实。未见“所有会话自动抽事实并直接采信”的闭环。 |
| Mem0 可选适配 | `lib/ai/integrations/mem0.ts` + `lib/event-log/register-handlers.ts`：人工确认事实先落 SQL，再以 `infer:false` 投影到 Mem0；读取时仅用外部结果排序本组织拥有的本地 ID，并重读当前 SQL 正文。 | SQL 是事实权威，Mem0 不是必需主存储；有写入结果不确定、人工对账及删除清理路径。当前未见业务层时间衰减策略，不能因使用 Mem0 就宣称已有 decay/自动纠错能力。 |
| WeKnora 可选适配 | `lib/mcp/tools/evolucao.ts` 调用 `lib/ai/integrations/weknora.ts`；按获授权知识源查询，再读当前已发布页面及来源，记录版本、内容哈希和观察清单；`lib/ai/agents/workbench-observed-evidence.ts` 复核证据。 | 已接入查询和证据校验；不能由此推导完整的自动 Wiki 生成、发布治理或混合 ACL 知识库已验收。 |
| 原生 RAG | `lib/ai/knowledge/busca.ts`、`lib/agent-engine/agent/search-knowledge.ts`、`lib/ai/rag/`；embedding + PostgreSQL/pgvector，按组织及 Agent 获授权资料检索，保留来源/片段/索引版本。MCP 查询可合并 WeKnora 与尚未由其处理的本地资料。 | 不依赖 WeKnora 才能检索；仍需有效资料、索引、数据库及 embedding 配置。检索阈值、空结果与知识可用性不等于已验证回答正确率。 |
| Trace、Langfuse 与 Eval | `lib/agent-engine/edge/llm/run-model-call.ts` 和运行时记录观察；`lib/ai/integrations/langfuse.ts` 经 SQL outbox 导出脱敏观测。`app/api/v1/ai/workbench/runs/[id]/evaluation/route.ts` 的 GET 为确定性评估/已有评审，POST 显式触发有成本的语义评审或确定性结果导出。 | SQL 保存权威运行记录，Langfuse 是可选投影；不导出完整 prompt、工具参数/结果或私有内容。没有“每个 Run 自动调用 Judge”的保证。 |
| MCP 工具入口 | `app/api/mcp/route.ts` 提供 Streamable HTTP + Bearer 认证；`lib/mcp/server.ts` 统一注册工具并检查角色、scope、组织上下文和审计；内部 Agent 也消费既有工具处理器。 | 有真实工具入口及权限代码，不等于任意第三方 MCP 工具都可直接安全执行；新工具仍须声明效果并接入约束。 |
| 意图识别与路由 | `lib/agent-engine/agent/intent-classifier.ts` → `lib/agent-engine/agent/resolve-turn-agent.ts` → `lib/agent-engine/agent/inbound-turn.ts`；组织可配置分类模型/提供商、意图示例、阈值、粘性路由与兜底；解析单标签 JSON，名单外或失败返回空判定。 | 当前是通用 LLM 分类，不是专用的“最新中文意图模型”；置信度尚不能视为校准概率，多标签、歧义澄清和中文效果需另行评测。路由结果也不能代替动作授权。 |

## 服务与验收边界

- Supabase/PostgreSQL、认证及独立 Worker 是实际应用依赖；模型与 embedding 按功能配置。不能用页面能打开替代业务数据库、队列及模型链路验收。
- Mem0、WeKnora、Langfuse 是可选适配器；关闭它们不等于删除本地 SQL 事实、原生 RAG 或 SQL 运行记录，但相应外部能力不可用。客户发送渠道也需单独配置和验收。
- 本页未调用真实模型、未发送客户消息、未以 mock 或历史报告证明业务可用。需要真实服务时再核对环境与授权，不把未配置服务当作用户必须自行补代码。

## 架构材料需纠正的说法

以下针对提供的 Architecture Wiki 根 README / 面试 QA 中的概括；以本次导入源码为准，不全盘否定其较详细章节。

1. **Mem0 `in_flight` 不是“模型提取后等待人工确认”。** `mem0.ts` 的输入已要求 `confirmed: true`；该状态表示对外投影写入已经开始、结果尚未确认，`unknown` 表示结果不确定，需要对账。
2. **Mem0 不是客户事实的权威库。** CRM SQL 保存人工确认正文及当前状态；外部搜索只辅助排序已拥有的本地事实，不直接采信远端正文。
3. **ID 哈希不构成绝对数据隔离，也不等于正文无隐私。** 投影会发送 `row.body`，其中可能包含姓名或其他敏感事实；仍需组织授权、外发边界和数据治理。
4. **Langfuse 不是完整工具参数日志，也不能称“0ms 开销”。** 适配层明确排除 prompt、工具参数/结果和私有内容；调用链仍有配置读取、数据库/outbox 操作。Langfuse 脱敏投影与 SQL 业务审计需分别理解。
5. **不应写成“LangChain 自动 Judge 闭环”。** 当前包/锁及主要调用链未发现直接 LangChain 依赖；语义 Judge 是显式、可能计费的入口，不是每次运行默认执行。

上游 `docs/current-state.md` 自称为 2026-07-29 / `789dfa6` 的历史快照，并明确不持续维护；求职 Skill 的实施账本和历史测试数字也不是本机验收或个人贡献证据。

## 适合继续二开的业务切口

- **有证据的销售跟进：** 客户上下文 + 公司资料 → 商机判断/跟进建议 → 人工批准 CRM 动作 → 执行回执，可沿现有工作台、工具和审批链推进。
- **可控的客户回复：** 在已有渠道和审批机制上补齐普通工作台回复候选生成及发送闭环，分别验证批准、取消、失败与恢复，避免仅展示模型文本。
- **面向实际咨询的记忆和路由：** 用确认事实改善重复沟通，用中文业务样本评价意图路由；是否增加时间衰减、专用分类模型或多标签，应由错误样本和业务规则决定。
