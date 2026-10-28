# CRM-016e：客户记录误述修复与新答案验收

日期：2026-10-28（Asia/Shanghai）。[CRM-016c](CRM-016c-quality.md) 发现旧客户 Run `71544fe6-de80-48b4-9d69-057246caa18d` 错称前三条 revision 不同，并夹入无来源的“2026-06?”日期猜测。本次修复生成输入，并新建一个独立合成客户只读 Run 验证；旧回答、旧 fail 及原评分保持不变。

## 修复行为

- `scripts/sales-demo.mjs` 的 split contact 任务要求 summary 只输出一个 JSON 对象文本，外层为 `status/coverage/providerStatus/memories`，每条记忆为 `id/body/confirmed/revision`。按工具原顺序保留全部记录及重复正文，逐值复制，不附加日期、版本异同分析或其他说明。结构化引用使用实际 contact ID，客户记忆 ID 不再被误标为 knowledge；真实错误或不完整读取优先如实报告。
- `WORKBENCH_RESULT_INSTRUCTION` 补充：revision 只复制观察值，不能从 ID 或时间差推断版本差异；不猜测或补全日期。没有改 schema、权限、审批、partial gate、评分或最终文本渲染。
- [演示手册](../sales-demo.md) 同步输出约定。这里只收紧固定任务输入，未增加服务端 JSON/事实强校验；更长记录可能超过现有 summary 2200 字符上限，仍需按真实缺口处理，不能截断或合并后声称完成。

## 真实新 Run

独立 session 为 `53537668-b91d-418d-bf51-0e649a3e911a`，新 Run 为 **`d82fb7b7-de0a-417c-8ef4-76331a10dcc0`**，inspect / completed。创建于 `2026-10-28T15:27:16.904Z`，完成于 `15:27:32.674Z`，窗口 **15.77 秒**。本 session 仅创建这一条 Run；没有重跑知识或审批任务。

先确认队列空闲，有序停止并启动自己拥有的 Web/Worker/drain，加载新指令；未操作其他项目或 Docker。受管新会话 `126df6ca-377b-46bf-9c8b-4b6eccb4ec29`。只读 `prepare --split --new` 保留旧 session，再由既有登录工作台创建一次 contact Run，没有自动重试。

实际模型记录为 `dashscope/qwen3.8-flash`、status=ok；一条聚合 `llm_calls` 记录对应 job `c091e94e-f415-4a4f-a5ac-b87202bec6f2`，workbench_start / done / attempts=1。成本仍为 NULL/未知，不是零。成功业务工具只有 `crm_get_contact`，提案数和 CRM 状态变更数均为 0，没有客户发送。

## 完整答案与观察逐值核对

私有校验器只读取得产品最终文本、result_document 和限定 role=tool / `crm_get_contact` 的观察，不读取 assistant 消息或整份 runtime_state。它对 summary 做完整 JSON 解析与严格字段比较，而不只搜索关键词：

| 核对项 | 实际结果 |
| --- | --- |
| 容器 status / coverage / providerStatus | 与工具完全相同：mem0 / complete / connected。complete 只描述本次有界读取。 |
| 四条记忆的 id / body / confirmed / revision | 全部逐值相同，顺序一致，没有合并正文重复的前三条。前三条实际相同的 revision 原样保留。 |
| 日期及版本差异表述 | summary 没有额外键、日期或前后说明，没有再声称 revision 不同。正文中的原始事实未经改写。 |
| 全部结构化证据 | 只有实际 contact 来源；唯一 claim 为“已读取本次返回的已确认客户记忆；仅作为客户上下文。”。三个可选安全字段断言均与观察一致。 |
| 后续与缺口 | missingInformation=[]、nextStep 为空、wakeCondition=none，与本次只读任务一致。没有推演未来同意或外联。 |
| 旧回答回查 | 四行记录主体仍匹配，但两处原误述分别检出 `historical_false_revision_difference_claim`、`historical_unsupported_date_guess`。没有用“不符合新 JSON 格式”替代旧错误原因。 |

新旧 Run 的所选工具事实投影哈希相同，说明新成功不是更换事实或删除重复记录得到的。新 final_text 为 809 字符，其 UTF-8 SHA-256 与工具事实按上述字段顺序 `JSON.stringify` 的哈希均为 `bf2a40a8bd341827bc12795d4faa23190c1fc812362224fafe7cb070086b4889`。这与 CRM-016c 的 canonical JSON sourceHash 是不同计算对象。

新 Run 的确定性 evaluation GET 为 **needs_review / 89，answer_quality=50**，仍保留 `memory_claims_require_semantic_review` 与 `structured_claims_not_independently_verified`；实际 observed=1 / total=1、verifiedAssertions=3，没有硬失败。semantic Judge 为 not_configured，没有调用 Judge 或评分 POST。此次逐值核对通过不等于整体语义评估 pass，更不证明提示词能全局消除误述。

本机 Langfuse 自然处理两条 spans 事件为 done，Trace `9ce9fd2d2d7f342dc85bb9129824bf46` 实际回读六条 observations，其中模型 2、工具 2，input/output 均为空；未手动 drain 或重投。私有三任务观察器的 session 总结为 false，因为本次刻意只执行 contact，knowledge/approval 未执行；其中 contact 的 operationalValidated 和 langfuseVerified 均为 true，不把它当三任务重演通过。

## 文件与验证

私有材料均在忽略目录，不上传客户正文或登录凭据：

- `.local/crm016e-answer-check.mjs`；新答案及报告 `answer-d82fb7b7-de0a-417c-8ef4-76331a10dcc0-1793201346705-final.txt` / `.json`，旧回答报告 `answer-71544fe6-de80-48b4-9d69-057246caa18d-1793201341726.json`，均位于 `.local/crm016e/`。
- `.local/crm016e-metadata.mjs` 和 `.local/crm016e/metadata-d82fb7b7-de0a-417c-8ef4-76331a10dcc0-1793201558665.json`。新答案报告文件 SHA-256 为 `339a0651db2c957aa70a247c2ca15dfe95dce7c3a7f2c3c93a687b2e11a00c37`；元数据报告文件 SHA-256 为 `bb820e27503a6820c3d7e5bccadbc67ca2770d7581661a37346c654cf7020a64`。
- `.local/sales-demo/53537668-b91d-418d-bf51-0e649a3e911a/` 保存准备输入、单次创建回执、不可变执行/观察报告及中文工作台截图。截图已查看，完整新答案在工作台可见。

27 项现有定向检查通过（sales-demo 与 result-submission），两处输入文件 ESLint 和脚本语法通过；首次沙箱执行因 Vitest 临时缓存 rename 被拒而未运行测试，解除该限制后同一命令全部通过。没有新增与实现镜像的提示词测试，也没有运行无关全量测试。

结束快照 `2026-10-28T15:34:16.711Z`：Web/Worker 可响应、Worker DB 正常，job pending/running/dead 及 integration pending/processing/dead 均为 0，integration done=36。Web 仍为既有 degraded。完整脱敏状态保存在 `.local/crm016e/local-status-after.json`，此为一时快照。

独立只读代码和来源审查已逐项核对完整新答案、四条观察记录、全部 claim/断言/后续字段、新旧哈希及实际模型/队列元数据，未发现重要问题。结论限本固定样本的后验逐值验证，不将它改称 API 强制事实校验或全答案语义认证。
