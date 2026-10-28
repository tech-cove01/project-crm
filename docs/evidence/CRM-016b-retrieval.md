# CRM-016b：有界关键词检索与真实前后对照

日期：2026-10-28（Asia/Shanghai）。针对已验收 WeKnora v0.8.2 的 Wiki 正则查询接口，修正 CRM 自然语言输入的处理；不改变原生向量检索阈值、评分门槛或历史 Run。

## 实现范围

- 原问题仍限制在 2000 字符，先转义正则元字符，作为字面查询，避免 `.*`、`|`、未闭合括号等改变匹配语义。
- 包含汉字的输入可用 Intl.Segmenter 派生至多 6 个去重关键词，过滤问词/泛词；连续拉丁短语按一个词计，不硬编码本合成品牌。不含汉字的输入保持字面查询。
- 仅上游字面查询返回零候选时，每个已授权 KB 至多再请求一次关键词 OR 查询。相同 KB 的多个 CRM 来源复用搜索结果；HTTP 失败、过期/外组织/不合法页面不会触发扩大检索。
- 关键词候选须在实际 published 页的 title、slug、前 12000 字符正文中命中至少 min(2,关键词数) 个不同词；不采用 snippet 作证据。之后完整复用原 KB/组织授权、全部来源文档、更新时间、版本/内容哈希及二次核对。
- 保留整体 15 秒期限和原结果数量上限，新增 queryMode/fallbackUsed 诊断值；没有引入模型改写、新 SDK、数据库迁移或固定“产品”回退。

源码见 [查询规划](../../lib/ai/integrations/wiki-query.ts)、[来源适配器](../../lib/ai/integrations/weknora.ts)。词法筛选是有限候选检索，不证明候选能回答全部问题。

## 同资料实测

固定题目与来源见 [CRM-016a](CRM-016a-baseline.md)，每题 limit=5。前后测均实际执行适配器：前测使用提交 dd3023d 的完整实现，后测使用本次工作树实现；查询、源/文档/Agent 版本、五页版本/哈希及共享 config/http/db 文件哈希均相同。

| 样本 | 前测 | 后测 | 后测查询方式 |
| --- | --- | --- | --- |
| 原失败长句 | empty，0 条可信证据 | complete，2 条可信证据 | keyword_fallback，2 次搜索 |
| 已成功短词“产品” | complete，3 条 | complete，3 条 | literal，1 次搜索 |
| 无答案问题 | empty，0 条 | empty，0 条 | 尝试 keyword_fallback，2 次搜索，仍为空 |

长句返回的 `fc1d7cb1-8a06-40a3-b992-8f96757251e9`（Pi Native CRM）正文实际包含 Mem0 提供向量检索、CRM 数据库仍是事实来源的表述；另一条人工确认页面补充权限/确认偏好背景，不能称两页都独立回答这两项事实。正文内容与原基线页哈希一致，未补写答案或生成新资料。该样本的长句有效召回有实际改善；没有据三题编造整体准确率、召回率或生产性能提升。

两次完整适配器仅允许该组织/来源的 SELECT 和 ai_wiki_evidence 机械回执 upsert：前测 3 次、后测 5 次均冲突复用既有证据，新增 0 行，未出现 SQL/HTTP 范围违规。适配器路径不是纯只读，未写业务事实；没有调用模型、embedding、融合 MCP handler、新建 Run、批准动作或手动 drain。

## 验证与证据

18 项相关检查通过，另 10 项无关检查跳过；覆盖原三题、正则字面转义、重复/拉丁部分重叠、无关候选、excerpt 外命中、stale/foreign 不回退及共享 KB 请求上限。相关 ESLint、全仓 typecheck、diff 检查与独立代码审查通过。

私有证据均保存在忽略目录 `.local/crm016/`：

| 文件 | 内容 |
| --- | --- |
| `baseline-1793197729499.json` | 三题 raw 搜索、源授权、发布页/文档版本与内容哈希。 |
| `adapter-before.ts` | 旧版源码仅三个 import 改为私有目录可执行路径；原始代码与快照 SHA 单独保存。 |
| `compare-before.json` | 实际旧版结果及受限 SQL/HTTP 轨迹，原始源码 SHA `ebe9d08fa837a21db6fddb96d1491938abab2fee5d824772dd2f5f7eaa1851ce`。 |
| `compare-after.json` | 实际新版结果、两条长句证据及所有版本复核；weknora.ts SHA `175e7e6d27c6d787acb0d6aa0702c21bdbfe10cc145fcb1da9ca749f05ca62ce`，查询 helper SHA `bdff1bc134bce783d8bec8629b1f7bb251bb9bff2dbceffa24b6730009d1876c`。 |

root 与独立 reviewer 均核对 before/after 的计数、源码哈希、资料版本和长句证据支持范围。原基线、失败记录及历史回答未覆盖；选中回答的质量发现另见 [CRM-016c](CRM-016c-quality.md)。本次验证的是适配器固定样本，不宣称完整 Agent 终答或融合检索全部通过。
