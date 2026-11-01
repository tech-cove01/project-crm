# CRM-020g：唯一最终独立核验与受限结论

2026-11-01。按 [有限规格](../CRM-020-spec.md) 执行一次最终核验，未开启第三轮产品修复。**既有结果离线对账成立，C 的两个固定 adapter 样本通过；整批仍保留 B03/D01 fail 和 0412 竞争验证 unknown/blocked，不是“四条主线全部通过”。**

## 冻结与执行边界

执行前锁定干净源码 `50230e3b6753ebd7fc986750d504ad50b1582487`，结束时 HEAD 和 tracked 工作树仍与该基线一致。应用实现基线为 `9fb0d5c`，只读 Trace 聚合修复为 `01b1254`；本次没有修改产品代码。最终证据文档是在执行完成后新增。

私有计划先冻结原始报告、fixture、实际 adapter 及核验脚本的文件哈希，主代理独立审查后才授权执行。全局一次性 intent 使用排他创建；本次仅调用一次执行命令，没有失败后重跑、替换业务 Run 或增加审批/Judge。执行与来源复核由 `baseline_review` agent 完成，执行前脚本由主代理审查；这是 agent 间复核，不是真人事实校准、盲测或不同模型提供的独立真值。

执行前审查发现私有仪器初稿误用 `sha256(body)` 校验记忆 revision，已改为产品 [Mem0 保存算法](../../lib/ai/integrations/mem0.ts)：`sha256(JSON.stringify({contact, category, body}))`，并核对工具观察与 fixture 的类别一致。三个实际 revision 均匹配。旧 draft/计划原文件保留，修正版使用新文件封存；修订时尚未执行 SQL/HTTP，不是产品修复或业务重跑。建议文本中“站内”“人工”“未安排、未执行”等断言也先核对了既有完整快照。

最终计划为 `.local/crm020/final-independent/plan-6a4eef90-8bab-4eca-94a6-2bbe51461e4c.json`，SHA-256 `1c405e192fd7691ed016646e0f6e09c629d6c55bc0c1cd40a91054ce839d8132`。执行入口为同目录 `runner.mjs`；`offline.mjs` 只读取已封存报告，`g.ts` 只进行下述本机限定操作。

## 原结果离线复核

23 项对账断言全部成立，含允许的 `role=tool` 成功观察、最终可见 summary、结构化引用/标量断言、拒绝事件顺序、最终业务元数据与保存的观测报告。没有读取 assistant 私有思考或 opaque continuation；没有重建或重跑业务。这 23 项是对账断言数，不是 23 个成功业务场景或准确率分母。

| 原场景 | 最终核验确认的结果 | 保留边界 |
| --- | --- | --- |
| B01 准备 | completed、无提案；三条事实的 ID/body/revision 与实际工具观察逐值一致，category 匹配；A/B 知识的 page/version/hash、标题、来源及原文片段一致。 | 仅固定只读准备投影通过。[主链](CRM-020c-main-chain.md)。 |
| B02 拒绝 | 唯一提案 rejected；reject sequence 16 → resume 18 → 成功 `crm_get_lead` 21，按唯一 toolCallId 对应观察；四键 JSON 与初始阶段一致，无 `crm_state_changed`。 | agent/API 代发用户授权的明确拒绝，不称真人点击。 |
| B03 批准 | 原 Run completed，但只有一次 `crm_get_lead`、提案数 0；终答说等待决定，实际没有可批准提案，也没有决定/执行/续跑。 | **fail**，没有用新 Run 补成通过。 |
| D01 协作 | 三个持久 child 均 completed，但 specialist summary 全为空；父 partial/`empty_final_answer`，没有终答和提案。 | **fail**，工具观察存在和 child completed 不替代可用汇总。 |
| 0412 最后竞争验证 | 两份失败仪器报告仍保留、均已回滚；same-lead 大写 UUID 对照已取得。 | 不同商机、人工复核 cutoff 和双连接竞争仍 **unknown/blocked**；不重跑，不用其他回滚用例替代。[实现边界](CRM-020e-collaboration-review.md)。 |
| 数据边界 | 原 10 项分母保持 **7 pass / 2 fail / 1 unknown**；K01 捕获未知、K03/K04 漏检不改。 | 本次 G 两题另列，不并入或替换原分母。[边界](CRM-020d-data-boundaries.md)。 |

最终既有元数据为 4 root、3 child、5 job 均 done/attempts=1，9 条 `llm_calls` 聚合计量记录中含唯一 Judge 1 条。累计 input/output 为 42034/4166，cache read/write 为 110080/0，9 条费用均 null/未知；不将计量行数当 provider HTTP 请求数，也不把缓存叠加为输入。

B01 唯一 Judge 仍为 semantic pass/92，合并仍 needs_review/92、answer_quality=50；该 Judge 与业务同用 Qwen，不是独立真值，不能覆盖 B03/D01 失败。授权负例原错误对象违例、HTTP 仪器原整体 false 及其后独立对账、恢复三代表组的回滚报告均保持原哈希；恢复证据不能关闭 0412 未验证的竞争。[授权](CRM-020b-http-authorization.md)、[对象范围](CRM-020b1-target-scope.md)、[恢复](CRM-020b-recovery.md)。

对既有 [观测报告](CRM-020f-observation-evaluation.md) 仅离线重算：67/67 span、34/34 score 的精确 ID/计数及保存的匹配结果成立，稳定 ID 遥测单事件重投前后不变量保持。没有再请求 Langfuse 或重投事件；远端原文与 I/O 隐私判定依赖先前已审查的明确 I/O 检查器和封存报告，本次不是新一次远端或隐私实测。

## C 的独立资格变更

C 原文是 agent 手工编写的独立合成资料，固定事实仅为“验收清单由客户确认，培训为两场线上演示”，没有上线日期。**不称盲测**：先前 K01 原始搜索可能曝光标题，C 已明确从 draft/version 1 隔离为 archived/version 2、文档 disabled；本次也会读取原文核对。未据 C 调整检索产品实现。

固定 KB 为 `842886d6-75c1-4089-8747-157644e6fafa`，source 为 `f684a62a-11bd-4e0c-ab65-ff3afdbb0bf4`，C page 为 `4632ab0e-3f0a-424b-9425-d648f8703a27`、doc 为 `d4ccdf4e-1f91-4859-9df3-53e747fb487f`。页面正文、文档 file_hash/正文的共同 SHA-256 始终为 `5d37e3db60524b48c226a6ee91d27f35ad119336e3ccafaff3df70d71e199694`。

按预审计划仅执行一次本机 WeKnora PostgreSQL SERIALIZABLE 事务：复核固定 tenant/KB/合成标记，锁定 C 的 doc/page，核对 A/B/C 全部资格、版本、标题、来源和正文哈希；C doc 从 disabled 改 enabled，再将 C page 从 archived/version 2 改 published/version 3。正文未改，A/B 仍分别为 published/version 3 和 published/version 1，身份、内容、资格及时间均未变。

数据库记录 C doc 的新更新时间为 `2026-11-01 06:00:49.543456+00`，page 为 `2026-11-01 06:00:49.545891+00`，同一数据库时钟下先启用文档再发布页面；与脚本所在主机的时间不混作跨机耗时证据。资格事务成功后单独留存 receipt。C 保留 published/version 3 供本机展示，明确为手工种子而非自动生成。原 `fixture-frozen.json`、原 K01 报告及历史失败均未改；新资格由本次独立 receipt 描述，不覆写旧 fixture。

## 两次实际 adapter 查询

使用当前真实 `searchCompanyWiki`，仅固定组织/source/新 KB；不是原生融合检索、完整 Agent 回答、UI 或语义 Judge 验收。问题、预期和 planner 在资格变更前已冻结，没有再抽题或改写问题。

| 新样本 | 固定预期 | 唯一实际调用结果 |
| --- | --- | --- |
| G01 `培训` | complete，仅 C 一条证据，包含客户确认验收清单和两场线上演示两个事实。 | **pass**；literal、fallbackUsed=false，返回 C page/version 3，证据 `5dd6b36f-b2dd-4283-84f8-ffec5a23ee47`；标题、正文哈希、doc ID/hash/启用状态及来源均对应。 |
| G02 `上线日期` | empty、证据 0；原文没有该事实，不应返回无关证据。 | **pass**；literal 无候选后按已冻结产品 planner 查询 `(上线|日期)`，仍无候选，status=empty、证据 0。这是同一次 adapter 调用的既有 fallback，不是重试或第二次抽样。 |

共 2 次 adapter 调用、6 次本机 HTTP GET（3 search、1 page、2 doc），全部 200，SQL/响应版本校验/HTTP 错误记录均为空；不存在把异常当空命中。本机来源限定与重定向拒绝守卫均启用。正例产生一次 `ai_wiki_evidence` 回执插入尝试，新增 1 行，因此本次**不是全程纯只读**；持久写入仅含 C 两项资格变更与这条证据回执。

G 没有新模型、Judge、embedding 调用、业务 Run、审批或 Langfuse 请求。新 KB 的 embedding/summary model 配置为空且向量、关键词索引、图索引关闭；本次只走固定 HTTP GET 检索。该限制不能反推整个 CRM-020 准备、记忆同步或此前融合知识检索零 embedding。

真实 SQL 前后对账中，固定 7 个 Run、9 条模型计量、5 job、组织 Run/计量/提案计数、来源授权版本均未变；本组织业务 job 无 pending/running。主商机仍处初始阶段 `83e3b1e9-aea2-4792-85c1-10717a0f93cf`，精确更新时间仍为 `2026-11-01 05:10:51.756746+00`，该商机活动数 0。C 发布后的资格和正文在查询后仍一致。这是所列 SQL 投影的对账，不是整库 hash 或永久不变保证。

## 私有证据索引与停止结论

以下文件均保留于忽略目录 `.local/crm020/final-independent/`，公开不提交凭证、登录会话、完整工具正文或数据库快照。

| 文件 | SHA-256 |
| --- | --- |
| `runner.mjs` | `7cf67ab94fc4104fb1171c90d6ad4bc320b2621d1ed1b6bf4322d4f9722db68d` |
| `offline.mjs` | `415eecc08f10333a32c052841df580d366019bec1c2155a03d7d1f371f44bba7` |
| `g.ts` | `f65122ea58bdae80f4ebe9aee4bda2239709ad2696b28c9aeba96c01b1933ae1` |
| `execute-once-intent.json` | `4591274af2e9466380a19e58211fc8ea08f36301643f8c1ceb78671a830ac6b4` |
| `offline-result.json` | `379255f23ea260667498dde97eaa0206dd9459339e00ec165f0a13754d3ca725` |
| `C-qualification-intent.json` | `1f18a16b9b417482899def3a5b71d15d908006069ead6a4e0013158b98129413` |
| `C-qualification-receipt.json` | `1b3a32447ebcf6255722160eaea5bbf2e3ed2e6c4c5881093a24f8caf4d98fd1` |
| `G-result.json` | `b3bbf698c5a3316926eea5b4bf7581db58d74af761a934fb4d83b39e70f068de` |
| `final-result.json` | `398acb56280854636dbcaa46dc275eb6fdac2e4473b5c750cc6b7d852c5bff15` |

最终报告 `recomputationPassed=true`、`GPassed=true`、`sourceStillFrozen=true`，但明确写入 `originalBatchAllPassed=false`。本批按额度受限结束；B03 提案生成、D01 空摘要/父终答、0412 未完成竞争以及 K03/K04 改写漏检均保留为后续另行选择的问题。C 两个检索样本不能证明完整销售闭环、全答案语义正确、生产稳定性或并发执行安全。
