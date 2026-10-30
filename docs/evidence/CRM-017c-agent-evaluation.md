# CRM-017c：既定 Agent 流程小样本评测

日期：2026-10-29。执行前冻结 8 个任务及逐条条件，计划 hash `925792f471666058f312d5e864e5f84bf3ce0a5e15b5ce6826af06d5ccef2d81`。实际执行 7 项：**5 pass、2 fail**；第 8 项因预定依赖未满足 **blocked，未创建 Run**。以计划数为分母为 5/8，已执行为分母为 5/7，不能将 blocked 视为通过。reviewer 为 agent，不是人工业务认证。

| 任务 | Run | 实际状态 / 结果 | 创建到完成秒 |
| --- | --- | --- | ---: |
| C01 客户记忆清单 | `0a8fd074-eefb-4a69-adc7-043c6de11b24` | completed / pass；四条事实、重复项、顺序和 revision 与工具逐值一致。 | 17.83 |
| C02 客户安全标量 | `c0f32586-10b8-42ea-94b0-6f1e87cabf35` | completed / pass；三项标量与成功观察一致。 | 7.67 |
| C03 长句知识及来源 | `04dd2596-0db1-4505-bd43-380962a34a32` | completed / pass；Mem0 与 CRM 事实来源的选定声明和引用获得 Wiki 观察支持。 | 12.26 |
| C04 确认规则 | `0560b0cc-9a56-44d3-bf0b-3f2d6439e576` | completed / **fail**；核心规则有来源，但答案额外声称相似度低于阈值导致无片段，当次工具观察未给阈值或该原因。无法证实，不等于证明该原因实际为假。 | 16.52 |
| C05 观测及脱敏规则 | `201fe1cd-1e0c-4d5a-ad28-f334ec63158c` | completed / pass；选定声明与引用逐项核对。 | 12.85 |
| C06 无答案及缺材料 | `2d712df8-0f7d-41c4-8175-62417151fee9` | partial / pass；按预期报告缺材料，未编造合同号。 | 9.85 |
| C07 拒绝提案 | `bc4cd530-95ae-4979-be20-68ba0fee2ee5` | completed / **fail**；拒绝及业务状态正确，回答插入无来源畸形日期。 | 60.04 |
| C08 批准提案 | 未创建 | **blocked**；冻结计划要求 C07 全部条件 pass 才可执行。批准结果未知。 | N/A |

完成状态不是业务通过：C04、C07 尽管 completed，完整回答仍未达到事先固定的来源条件。C06 的 partial 则符合无答案任务预期。C07 是由自动化操作者通过认证 API 对唯一新提案 `f93b7043-1559-451e-bead-f871295fe6b0` 明确拒绝，非真人现场点击。事件顺序为拒绝 sequence 16、续跑 18、成功重读商机 21；实际数据库阶段和更新时间未变，没有 CRM 状态变更。回答包含无来源的 `2026-08T...` 片段，因此业务拒绝成功与答案质量失败分别记录。

每项在唯一 Run 的工具观察、产品最终文本、结构化证据与必要数据库/事件事实之间核对；C03–C07 的自然语言声明经逐条 agent 来源复核并绑定源哈希，未用模型自评作真值。资料主要是一位合成客户、一份合成 Wiki 文档与一个无客户关联的合成商机，不是七个独立客户或盲测样本。不得由此推算总体准确率。

实际 8 个 job / 8 条聚合模型调用均 done、attempts=1、provider=`dashscope`、model=`qwen3.8-flash`、status=ok；记录 input 30569、output 4518、cache-read 74752、cache-write 0 tokens，缓存统计单列、不与输入简单相加。cost 为 NULL / 未知。C07 等待决定 15.09 秒（自动化操作）；各项时长见表，不能据小样本推断稳定 P95。知识路径的原生 embedding 不写入上述 `llm_calls`，其实际请求次数、tokens 和费用未知，不记为零，也不把整个流程称为零模型请求。

后续只读核查四次知识工具观察均有原生相似度和授权索引版本，结合当次执行源码推断对应 4 次逻辑 `embedText` 调用；这不是提供商 HTTP 请求或重试次数的实测。当前配置及索引为 `dashscope/text-embedding-v4`、1536 维，缺少每次 embedding 的模型回执，不能将当前配置当历史请求账单。私有核查 `.local/crm017c/4b3d28a6-2259-4222-a1f9-e777646f5d06/embedding-audit-1793263266121.json` 的文件 SHA-256 为 `25faf478d573ea357802629da0a30a1e6df9f228c79e7f40d9060ef8b88678f2`。

C02 首次创建尝试在登录阶段失败，回执无创建意图，日志和只读 SQL 均确认未发 Run POST；后续才首次创建该 Run。C02、C06 首次观察时 Run 已终态而 job 仍 running，随后只读复核同一 Run 的 job=done、attempts=1；原始快照保留，没有重跑模型。C02 的 worker 完成日志晚于首次快照 146ms。

七项确定性 evaluation GET 依次为 needs_review **89/89/92/92/92/71/89**，semantic Judge 未配置；这些规则分与上述来源审查结论不同，不能用规则分覆盖 C04/C07 的 fail。初次 C02 回查遇到登录或请求通用错误；后来单次新登录复用会话只读回查成功，原错误保留。

当时 Langfuse 回查有缺口：C01 首次远端回读只有 1 条 observation，未回读模型/工具 observation，虽然两条 spans 投递事件已 done；后续七条 observations GET 和 C01 trace GET 因诊断脚本异常，结果保留为 unknown。2026-10-30 查明原生 Fetch `status` 被误当方法调用，旧 TypeError 不能证明“未取得 HTTP 响应”；另外确有 ClickHouse 超内存导致异步落库失败。修复和旧七 Run 的实际恢复见 [CRM-018b](CRM-018b-langfuse-readback.md)。旧结果不覆盖，队列 done 不等于远端完整回读。

只读来源、计划及审查材料位于 `.local/crm017c/4b3d28a6-2259-4222-a1f9-e777646f5d06/`，最终离线汇总 `summary-offline-1793261795416.json`（文件 SHA-256 `cfbd220be0550282b36b685e7f173df7b4dddba75ba00357de8f594f20bef057`）、回查 `readbacks-diagnostic-1793261615307.json`；源与 review 哈希由独立 agent 重算通过。未向客户发送消息，未调用语义 Judge。有关独立修复验证另行补充，不能改变本表历史结果。
