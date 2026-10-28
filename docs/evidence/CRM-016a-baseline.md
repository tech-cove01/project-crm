# CRM-016a：固定知识检索基线

日期：2026-10-28（Asia/Shanghai）。复用同一合成资料、当前组织已授权的 WeKnora v0.8.2 知识源；没有重新生成资料、触发模型/embedding 或改业务记录。

## 原失败与固定问题

原 Run `87f837ed-6119-472f-ae5a-c546f681f477` 的实际工具参数为下表长句、quantidade=5，并非仅从任务文本猜测。工具未报 HTTP 错误，但 Wiki 与原生片段均为空，Run 为 partial/missing_material。本地 pgvector 的 bestSimilarity=0.317708，低于原阈值 0.4；这个分数不属于 WeKnora，不能据此调 Wiki 阈值。

| 样本 | 固定输入 | 原始候选 | 完整旧适配器可信证据 |
| --- | --- | --- | --- |
| 长句 | Pi Native CRM 的客户记忆由什么服务提供向量检索，数据库是否是事实来源？ | 0 | 0 |
| 短词 | 产品 | 5 | 3 |
| 无答案 | 火星基地量子电池的政府采购合同编号是什么？ | 0 | 0 |

三题均 limit=5。先直接读取绑定内的 Wiki search GET 并核实实际发布页及来源，再实际执行旧版完整 searchCompanyWiki；两者的有效页面数一致。未调用融合 MCP handler（可能执行原生 embedding），也不把 raw 命中或探针筛选计数当成完整 Agent 结果。

## 原因与版本

固定版本的官方实现将 q 当 PostgreSQL `~*` 正则匹配 title、content、summary、slug，再按命中位置排序，并不为中文长句分词或做语义检索。CRM 原实现将完整问题直接作为 q 传入，因此长问题与连续正文不匹配可导致零候选；正则特殊字符也会改变用户自然语言的匹配含义。见 [WeKnora v0.8.2 官方实现](https://github.com/Tencent/WeKnora/blob/v0.8.2/internal/application/repository/wiki_page.go#L1242-L1285)。这解释了本次接口行为，不是对全业务召回率的判定。

组织 `16155fc5-1304-4fe0-8a86-d5d5cfeac693`，知识源 `54aabec4-e07d-4548-af41-684136aca033`，KB `60d57fbc-c565-4035-9c17-86da63c3afe9`，合成文档 `73e7f44e-17c0-4b7c-91f3-fb24ea54311b`。源 active/ready、组织可见，当前 Agent 授权包含该源；文档 completed/enabled，源 updated_at 为 `2026-10-28T07:38:45.553Z`。

短词候选中，summary 页虽为 published v1，但来源文档 updated_at 比该页晚约 23ms，按现有规则排除；index 页缺少可验证 source_refs，也排除。其余 3 个 published v1 页的内容哈希、来源、文档元数据与授权在读取前后稳定。未放松这两种排除条件，也未靠重建资料改变基线。

## 本机证据

私有只读探针 `.local/crm016-probe.mjs` 的最终快照是 `.local/crm016/baseline-1793197729499.json`，snapshotIntegrityPassed/ok=true。源快照 SHA-256 为 `35a524add7c24386420cba21bd11d6394d512a0f2192126b7351f5a5850c014d`，文档快照为 `17be52f187798efcb747af40ed81e2e3a9ba1265e909aec734703a6dc6fd5183`，各页版本/内容哈希另在该文件。

首次探针遇过期页停止的 `baseline-1793197484695.json` 和中间补齐记录 `baseline-1793197607304.json` 均保留。之后仅以 resume 补读页和文档，不重复三题搜索、不覆盖原记录。基线仅查询一次三题，未调用模型、插入证据回执、修改来源或启停服务。所有本机快照和合成正文留在忽略目录，不提交凭据或原始响应。

该切片完成诊断基线；是否改进及实际前后结果在 CRM-016b 另行验证，尚不称为优化完成。

旧版完整适配器的实际结果保存在 `.local/crm016/compare-before.json`：从提交 `dd3023d336bd03b107871e9fad5ab29962191318` 提取原始源码，仅调整三个相对 import 以在私有目录执行；原文及导入快照哈希均有记录。三题为 empty/0、complete/3、empty/0，来源/资料/Agent 版本与基线匹配。受限 SQL 包装器只允许该组织/来源的读取与 ai_wiki_evidence 机械回执写入，3 次插入尝试均冲突复用原记录、新增 0 行，未写业务。它不能被称为纯只读路径，纯读边界仅适用于前述 raw 探针。
