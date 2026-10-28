# 当前能力与二开边界

更新：2026-10-28。本页区分上游源码能力、本仓后续改动和本机真实验收；当前工作票与服务状态以 [STATUS](STATUS.md) 为准。

源码盘点以 CRM-001 导入基线 `06fac28` 为起点，后续验收依据 CRM-006/007/008/010/013/014。来源、许可与文件映射见[第三方声明](../THIRD_PARTY_NOTICES.md)、[导入清单](upstream/import-manifest.json)。本文源码路径均相对仓库根目录。

“已接线”表示存在源码入口和消费者；“本机已验收”表示对应证据记录了实际服务和结果，两者分别列出。验收均使用本机独立环境与合成资料，不等于生产效果或此刻在线，也不把继承功能算作本仓新增。

## 业务背景

这是一套面向销售团队的 CRM：管理客户与商机，结合客户上下文和公司知识生成建议，再经权限、审批及执行回执推动跟进。Agent 并非单独聊天页，而是读取和操作 CRM 的执行入口；但不能把现有代码描述成已验证的全自动销售闭环。

全栈部分由 Next.js / React / TypeScript 工作台与 API、Supabase/PostgreSQL 的业务和权限数据组成；Pi Agent Core 在独立 Node Worker 内驱动模型和工具执行。[中文演示入口](sales-demo.md)现以三个独立任务展示客户事实、知识证据、商机提案与批准续跑，最新本机复现均 completed、含观测回查约 4 分 29 秒。批准由自动化操作者通过现有 UI 明确执行；这是固定合成样本，不能称为单 Run 自动销售闭环或生产稳定性验证。[最新结果](evidence/CRM-014v.md)与[前序失败](evidence/CRM-014b.md)分别保留。

## 本机真实验收

| 能力 | 最新已记录的结果 | 证据与限制 |
| --- | --- | --- |
| CRM、认证与数据 | 真实登录、四个核心页面、合成客户创建/修改/刷新读取、未登录拒绝访问。 | [CRM-002b](evidence/CRM-002b.md)。只验证了这些页面和数据操作，未覆盖全部渠道与销售业务。 |
| 百炼 + Pi + Worker | 工作台真实 Run 经 SQL 队列和 Worker 调用 `qwen3.8-flash` 与 `crm_get_contact`，最终 `completed`，页面显示结果。 | [CRM-006](evidence/CRM-006.md)。只读客户查询已通过，不等于全部内置 Agent 或多 Agent 场景已验证。 |
| 客户确认记忆 | 合成偏好写入 SQL，同一 request_key 重放得到同一 ID，新 Run 经客户工具读到并引用。 | [CRM-007](evidence/CRM-007-capabilities.md)。组织记忆的发布和 Agent 引用仍未验证。 |
| 原生知识检索 | 合成 FAQ 使用百炼 `text-embedding-v4`、1536 维索引，Agent 经 `crm_search_knowledge` 引用；模型和组织隔离检查通过。 | [CRM-007](evidence/CRM-007-capabilities.md)。旧五参数检索接口已拒绝，应用与迁移需同步部署；一次命中不证明业务召回率。 |
| 审批、执行回执与续跑 | 合成商机批准前未变化，批准后阶段落库、出现 `run_resumed`，随后真实模型续跑至 `completed`。缺渠道的跟进能明确失败。 | [CRM-008](evidence/CRM-008.md)、[CRM-007 审批](evidence/CRM-007-approval.md)。成功续跑使用显式本机演示预算策略；保留此前失败与成本未知的历史。 |
| Mem0 | 服务写入/搜索/删除、CRM 确认事实自动同步和客户工具触发真实检索通过。 | [CRM-010 Mem0](evidence/CRM-010-mem0.md)。SQL 仍为权威，`infer:false`；脱敏事件不能确认答案具体引用了哪条重复 SQL 记忆。 |
| WeKnora | 合成 Wiki 短查询和 Agent 引用已验证；CRM-016 在相同版本资料上实测长句可信证据 0→2、短词 3→3、无答案 0→0。 | [原接入](evidence/CRM-010-weknora.md)、[固定样本前后对照](evidence/CRM-016b-retrieval.md)。有界关键词分路不替代语义判断；未验证总体召回率、完整发布治理或真实业务效果。 |
| Langfuse、规则评估与 Judge | 模型/工具 observations、6 个确定性评分真实回读，重启后记录保留；另一次语义 Judge 完成并持久化。 | [CRM-010 Langfuse](evidence/CRM-010-langfuse.md)、[CRM-007](evidence/CRM-007-capabilities.md)。观测 input/output 为空；确定性 verdict=`fail`（overall=79、answer_quality=0），语义 Judge verdict=`needs_review`，不是效果提升证明。 |

三项外部服务在 2026-10-28 的一次同时运行复查中健康接口通过；Worker 曾无日志退出一次，原因未确定，确认队列为空并重启后新只读 Run 完成。这是短时复查，尚无长期稳定性或 Linux 2 GiB 环境验收。CRM-016 已完成固定检索样本前后对照及六项既有声明来源核对，后者 5 项通过、1 项失败，发现客户回答含记录值误述和日期猜测。[历史质量证据](evidence/CRM-016c-quality.md)保留该 fail；后续[原客户 79 分诊断](evidence/CRM-016d-original-customer-failure.md)和[新答案修复验收](evidence/CRM-016e-customer-answer-fix.md)已补齐。新客户 Run 的完整清单与同四条工具事实逐值一致，仍为 needs_review/89、answer_quality=50；不是全局事实强校验或全部语义质量通过。

## 继承范围与本仓后续交付

核心 CRM、Pi 运行框架、四个内置 Agent、工具与审批机制、记忆/知识/观测适配器等主要架构来自上游快照。导入及历史报告不作为本人独立设计实现的证据。以下仅列本仓导入后的实际新增、修复和联调；完整记录见[实施票据](implementation-plan.md)。

| 票据 | 本仓后续交付 | 对应提交与依据 |
| --- | --- | --- |
| CRM-006 | 在既有模型网关和 Pi adapter 中接入百炼 provider、凭据校验与模型目录，并完成真实只读 Run。 | `41917c8`；[验收](evidence/CRM-006.md)。Pi 框架与原 CRM 工具仍是继承能力。 |
| CRM-007 | 增加百炼 embedding、按模型身份检索与迁移保护；修复批准动作的明确失败与副作用未知状态，避免缺渠道时虚报执行成功。 | `2728456`、`7e02c28`；[能力记录](evidence/CRM-007-capabilities.md)、[审批记录](evidence/CRM-007-approval.md)。不代表重写原生 RAG 或审批框架。 |
| CRM-008 | 增加默认关闭的本机演示预算开关，并在批准/恢复时复核条件，使百炼费用未知时的合成审批续跑可演示。 | `804b401`；[验收](evidence/CRM-008.md)。正式费用计算未完成，不能称已解决生产成本控制。 |
| CRM-010 | 配置并验证三项真实服务：补本机集成队列定时入口、WeKnora 百炼网络适配、Langfuse 对象存储可写卷槽与 x86_64 镜像适配。 | `53f1824`、`4e733d6`、`f6351c1`；[Mem0](evidence/CRM-010-mem0.md)、[WeKnora](evidence/CRM-010-weknora.md)、[Langfuse](evidence/CRM-010-langfuse.md)。适配器主体来自上游，接入和联调不算从零实现三项服务。 |

## 源码能力矩阵

此矩阵保留实现入口，供阅读代码和评估后续范围；其中的恢复、协作、Mission 等源码路径不自动升级为已实测结论。

| 能力 | 已有实现与主要路径 | 当前边界 / 可二开的内容 |
| --- | --- | --- |
| 核心 CRM | 客户、沟通 Inbox、商机看板、任务及组织权限；`app/api/v1/contacts/_handler.ts`、`hooks/kanban/useMoveCard.ts`、`app/api/v1/leads/[id]/move/route.ts`。 | 已验收登录、核心页面、合成客户创建/修改/刷新读取及特定商机阶段变更；客户渠道与完整销售跟进链仍待验证。 |
| Agent 工作台与 Worker | `app/app/ai/workbench/_components/AgentCrmWorkbench.tsx` → `app/api/v1/ai/workbench/runs/route.ts` → SQL Run / `workbench_start` 队列 → `workers/agent-worker/main.ts` → `lib/ai/agents/workbench-start-job.ts`。模型经 `lib/agent-engine/edge/llm/run-model-call.ts` 接入 `lib/agent-runtime/pi/runtime.ts`。 | 有持久化事件、SSE 回放、取消及恢复路径；每次工作台发送创建独立 Run，不能默认等于自动携带全部历史的连续会话。 |
| 四个内置 Agent | `lib/ai/agents/builtins.ts` 定义 `crm_intelligence`、`sales_operations`、`customer_communications`、`crm_supervisor`；Run API 调用 `ensureBuiltinAgents`。 | 本机已完成客户只读查询、知识引用及特定审批动作；四种角色并未分别完成业务深验，名称不是效果证明。 |
| 工具约束、审批与执行 | `lib/ai/agents/tool-effects.ts` 区分工具效果；`app/api/v1/ai/workbench/runs/[id]/proposals/[proposalId]/decision/route.ts` 接收决定；`lib/ai/agents/approved-workbench-tool.ts`、`lib/ai/agents/workbench-approved-action.ts` 负责批准动作、回执及后续处理。 | 合成商机阶段变更及本机演示模式续跑已验收；仍须逐动作验证，不能泛称所有外部副作用都恰好执行一次。 |
| 审批后发送的具体缺口 | `lib/ai/agents/workbench-start-job.ts` 与 `lib/ai/agents/run-resumed-workbench-turn.ts` 均传入 `candidates: []`。 | 虽有发送消费者，普通工作台当前没有自动生成回复候选的完整接线；不能宣称“工作台生成回复 → 人批 → 发给客户”已闭环。这是可独立二开的业务缺口。 |
| 多 Agent 协作 | `lib/ai/agents/workbench-collaboration.ts` → `lib/ai/agents/collaboration-runtime.ts`，计划选择在 `lib/ai/agents/collaboration.ts`；专业子 Agent 主要只读调查，结果与证据持久化，由父 Agent 统一处理写入。 | 是有限的专业分工，不是任意动态 Agent 图；Mission 场景将 `maxParallel` 限制为 1，不能宣传所有场景并行。 |
| 持续业务 Mission | Run API 可创建 `ai_missions`；`lib/ai/agents/mission-wake.ts`、`lib/ai/agents/mission-deadlines.ts` 以及命令/内部响应接口处理唤醒、期限、方向修订和继续执行。定义见 `docs/architecture/mission-state.md`。 | Run 完成不等于业务 Mission 达成；模型自述不能替代业务事实。客户消息唤醒有文本和唯一适用 Mission 等条件，不是无限自主执行。 |
| 客户与组织记忆 | `components/ai/CustomerMemoryPanel.tsx` 被客户详情页消费；`app/api/v1/ai/customer-memory` 接收人工确认事实并写 SQL/事件；`lib/agent-engine/agent/org-memory.ts` 读取已发布的组织记忆版本。 | 客户偏好、确认事实属于客户上下文，组织规则属于另一权威域；会话 checkpoint 是恢复状态，不能混称长期事实。未见“所有会话自动抽事实并直接采信”的闭环。 |
| Mem0 可选适配 | `lib/ai/integrations/mem0.ts` + `lib/event-log/register-handlers.ts`：人工确认事实先落 SQL，再以 `infer:false` 投影到 Mem0；读取时仅用外部结果排序本组织拥有的本地 ID，并重读当前 SQL 正文。 | SQL 是事实权威，Mem0 不是必需主存储；有写入结果不确定、人工对账及删除清理路径。当前未见业务层时间衰减策略，不能因使用 Mem0 就宣称已有 decay/自动纠错能力。 |
| WeKnora 可选适配 | `lib/mcp/tools/evolucao.ts` 调用 `lib/ai/integrations/weknora.ts`；字面查询零候选时允许有界关键词分路，结果仍核当前发布页、来源、版本和内容哈希；`lib/ai/agents/workbench-observed-evidence.ts` 复核证据。 | 本机合成资料的三题前后对照已验收，见 CRM-016b；CRM 以只读密钥检索，不自动生成或发布知识，完整发布治理或混合 ACL 知识库仍未验收。 |
| 原生 RAG | `lib/ai/knowledge/busca.ts`、`lib/agent-engine/agent/search-knowledge.ts`、`lib/ai/rag/`；embedding + PostgreSQL/pgvector，按组织及 Agent 获授权资料检索，保留来源/片段/索引版本。MCP 查询可合并 WeKnora 与尚未由其处理的本地资料。 | 不依赖 WeKnora 才能检索；仍需有效资料、索引、数据库及 embedding 配置。检索阈值、空结果与知识可用性不等于已验证回答正确率。 |
| Trace、Langfuse 与 Eval | `lib/agent-engine/edge/llm/run-model-call.ts` 和运行时记录观察；`lib/ai/integrations/langfuse.ts` 经 SQL outbox 导出脱敏观测。`app/api/v1/ai/workbench/runs/[id]/evaluation/route.ts` 的 GET 为确定性评估/已有评审，POST 显式触发有成本的语义评审或确定性结果导出。 | SQL 保存权威运行记录，Langfuse 是可选投影；不导出完整 prompt、工具参数/结果或私有内容。没有“每个 Run 自动调用 Judge”的保证。 |
| MCP 工具入口 | `app/api/mcp/route.ts` 提供 Streamable HTTP + Bearer 认证；`lib/mcp/server.ts` 统一注册工具并检查角色、scope、组织上下文和审计；内部 Agent 也消费既有工具处理器。 | 有真实工具入口及权限代码，不等于任意第三方 MCP 工具都可直接安全执行；新工具仍须声明效果并接入约束。 |
| 意图识别与路由 | `lib/agent-engine/agent/intent-classifier.ts` → `lib/agent-engine/agent/resolve-turn-agent.ts` → `lib/agent-engine/agent/inbound-turn.ts`；组织可配置分类模型/提供商、意图示例、阈值、粘性路由与兜底；解析单标签 JSON，名单外或失败返回空判定。 | 当前是通用 LLM 分类，不是专用的“最新中文意图模型”；置信度尚不能视为校准概率，多标签、歧义澄清和中文效果需另行评测。路由结果也不能代替动作授权。 |

## 服务与验收边界

- Supabase/PostgreSQL、认证及独立 Worker 是实际应用依赖；模型与 embedding 按功能配置。不能用页面能打开替代业务数据库、队列及模型链路验收。
- Mem0、WeKnora、Langfuse 是可选适配器；关闭它们不等于删除本地 SQL 事实、原生 RAG 或 SQL 运行记录，但相应外部能力不可用。客户发送渠道也需单独配置和验收。
- 普通 Worker 处理业务任务不等于外部集成队列会被消费；本机专用定时器需另行运行，Web 与 Worker 需加载一致组织绑定。启动方式见[本地运行](local-development.md)、[可选服务说明](../infra/local-agent-services/README.md)及 [WeKnora 本机接入](weknora-local-development.md)。
- 百炼费用在 CRM 中仍为 NULL/未知，不是免费。本机 `CRM_LOCAL_WORKBENCH_UNPRICED_MODE=true` 仅对符合条件的新百炼非 Mission Workbench Run 关闭单次金额预算；默认关闭，组织预算不变，token/步骤控制并非硬上限。正式费用计算与续跑 token 统计边界见 [CRM-008](evidence/CRM-008.md)。
- CRM-015 的文档更新仅复核已有材料；CRM-013/014 随后完成各票记录的本机范围。首轮评分 fail/83、79 及后续 partial 未删除；最新三任务为 needs_review/89、92、89，answer_quality 均为 50，仍未做语义 Judge，不因业务完成而视为全评测通过。公网部署、全渠道发送、组织记忆发布与引用、多 Agent/Mission/意图路由深验均未由这些样本证明。Cloudflare 与正式依赖、安全升级等前置见[部署评估](cloudflare-deployment.md)；私人求职及实习材料保留在公开仓库之外。

## 架构材料需纠正的说法

以下针对提供的 Architecture Wiki 根 README / 面试 QA 中的概括；以本次导入源码为准，不全盘否定其较详细章节。

1. **Mem0 `in_flight` 不是“模型提取后等待人工确认”。** `mem0.ts` 的输入已要求 `confirmed: true`；该状态表示对外投影写入已经开始、结果尚未确认，`unknown` 表示结果不确定，需要对账。
2. **Mem0 不是客户事实的权威库。** CRM SQL 保存人工确认正文及当前状态；外部搜索只辅助排序已拥有的本地事实，不直接采信远端正文。
3. **ID 哈希不构成绝对数据隔离，也不等于正文无隐私。** 投影会发送 `row.body`，其中可能包含姓名或其他敏感事实；仍需组织授权、外发边界和数据治理。
4. **Langfuse 不是完整工具参数日志，也不能称“0ms 开销”。** 适配层明确排除 prompt、工具参数/结果和私有内容；调用链仍有配置读取、数据库/outbox 操作。Langfuse 脱敏投影与 SQL 业务审计需分别理解。
5. **不应写成“LangChain 自动 Judge 闭环”。** 当前包/锁及主要调用链未发现直接 LangChain 依赖；语义 Judge 是显式、可能计费的入口，不是每次运行默认执行。

上游 `docs/current-state.md` 自称为 2026-07-29 / `789dfa6` 的历史快照，并明确不持续维护；求职 Skill 的实施账本和历史测试数字也不是本机验收或个人贡献证据。

## 适合继续二开的业务切口

- **可重复的销售演示：** 将已验证的客户记忆、知识检索、合成商机批准与续跑、Langfuse 回读组织成固定演示，保留各 Run 的输入、结果和失败处理；按 CRM-013/014 验证恢复与复现，不能把多个独立样本写成已完成单次全自动销售闭环。
- **可控的客户回复：** 在已有渠道和审批机制上补齐普通工作台回复候选生成及发送闭环，分别验证批准、取消、失败与恢复，避免仅展示模型文本。
- **面向失败样本的检索与评估：** CRM-016 已完成固定长句的有限改进、原客户失败诊断及客户清单输入修复。新独立客户 Run 使用逐值 JSON 文本，完整记录值与工具观察一致，旧质量误述和评分保留；输入约束不代替服务端事实校验。后续按需扩大资料/无答案样本，不能把固定样本通过当整体质量提升。记忆自动抽取、衰减与中文意图路由等新能力另按业务需要选择。
