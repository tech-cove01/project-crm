# CRM-021b：协作只读复盘的有限真实复查

2026-11-01。本次在干净源码 `dbbc4cab27b20e3973c6997454b0f9b2a558c1b8` 上，唯一新 root `ead5e7d1-af73-486b-ae5f-eb33af445329` 及三个专家 child 均 completed，父结构化提交被接受。固定角色、查询、来源身份、非空结果及无阶段副作用检查通过，failures/unknown 均为空。**这是一个已暴露合成任务的受影响复查，不是全部答案语义正确、生产稳定或新盲测通过。**

相关实现与边界：[提交纠错与引用](CRM-021b2-submission-repair.md)、[单记录专家预算](CRM-021b3-record-specialist-budget.md)、[只读唤醒合同](CRM-021b5-inspect-result-contract.md)、[未确认事实分流](CRM-021b6-unconfirmed-facts.md)、[原协作失败](CRM-021b-collaboration-summary.md)、[CRM-021 规格](../CRM-021-spec.md)。

## 历史没有被覆盖

每次新调用均在对应代码修复、独立审查和单独冻结授权后执行，未重新执行旧 Run、解除旧 pending review 或挑选同一冻结计划的重试结果。四份历史 source/review 与旧商机精确投影在新 Run 前后都重新核对。

| Root | 当时源码 | 原实际结果 | 后续处理 |
| --- | --- | --- | --- |
| `995e7150-6f62-434e-b94a-cca327987787` | `0994828` | 三 child 非空；父 assertions=5 超过 schema 上限4，父 partial/empty_final_answer；客户/商机多读 | 原 fail 保留，修正提交窗口与角色工具面 |
| `132fd6b2-4373-4f82-8b00-abce13f7e6e7` | `1f99c47` | 客户 child 成功读取后请求未暴露的 crm_get_lead，真实工具错误；父 partial、复核 pending | 原 fail/pending 保留；这不是成功越权读取 |
| `6cda51ec-f059-4cdf-b2a6-8eed92f71c97` | `0578385` | 三 child 完成；inspect 父提交等待批准却无实际提案，被守卫拒绝，最终文档为空 | 原 fail 保留；引用检查失败在此由文档缺失触发，未据此认定伪造引用 |
| `1ddb20b6-718a-4f3d-b209-a68059870058` | `a5def1d` | 三 child 完成、父非空中文终答与7条实际来源；将已知未知列为 missingInformation 导致 partial；另触发旧 quantity=5 条件 | 原 strict fail 保留；首次 claim 超长在同预算内改正，不是再次出现 human_approval 错误 |
| `ead5e7d1-af73-486b-ae5f-eb33af445329` | `dbbc4ca` | 四 Run completed，父 missingInformation=[]、unconfirmedFacts=3；严格有限复查 pass | 本次新结果，不能回填上面四行 |

995/132 使用旧 lead `88f0e2e0-1091-432f-a188-0dcc92e47382`。132 的待复核阻断保持，另获授权单独创建一条同联系人/管道/初始阶段的合成 lead `385b7cb4-7772-4fac-b616-2562380d8913`；6cda、1ddb 和本次均使用它。最终旧 lead 的 root 集合仍只有995/132；复用 lead 的 root 集合恰为6cda/1ddb/ead5。没有为本次再 seed、批准旧提案、取消旧任务或修改业务字段。

## 任务、验收器与冻结

新任务保持原 D01 的三个角色、精确 CSV/审批各一次、授权 A/B 原文、简短中文销售准备及不写业务/不提案/不外联要求。只替换授权的商机 UUID，并追加独立标识；没有改资料内容、标签或问题来凑通过。

独立重读固定原任务确认其未要求 quantity=5。旧检查器额外要求恰好5，新克隆只把这一谓词改为 `(quantidade ?? 5)` 归一后的整数1–5，保留原默认5和最大候选预算，其他字节完全相同。精确查询/次数、成功工具观察、实际 A/B 页/版本/hash、角色限制、终态、typed引用与无副作用条件不变。旧1ddb更正数量条件后仍因 partial 失败。9项离线检查覆盖3/5可、省略默认5、错词/无A-B/多查/超5拒绝。**本次实际两次 quantity 均为5，离线用原检查器重算本次也为 pass。**

曾生成仅显式整数的017d计划，根审发现其会误拒省略参数。该计划只做过只读冻结，未产生 create intent/POST/模型；原 plan/frozen 与旧 checker 快照保留，另写仪器后继记录，再封本次88683计划，没有业务重试。

私有目录 `.local/crm021/collaboration-facts-recheck/88683a38-bf47-4e55-b70a-58b6278c5ee3/`：

| 文件/输入 | SHA-256 |
| --- | --- |
| plan.json | `83545989cc2743846afd1e5e3c40b2d33abec611489e0976bb4c769a9aa5d8b8` |
| frozen.json | `876b0ae15931a42ed6ff307de75f39d74c1197c4078655351dbceaf405c9d0ce` |
| create-receipt.json | `3e36c3c570c84a735d1614d25a8805b7c1d7b5db303225a4036d4cf066988cc2` |
| source-1793517872950-7113d098-7f4a-470b-8e01-11b8cecfcbc3.json | `d0fcf5641b9970de6315079dcbdab532112b00379776397328189cf35efdd52e` |
| review-1793517873275-66fe01e1-6cea-41a3-9990-ecda69367545.json | `96621ba526c57496854d7e9403c93898228096b6fb692ac7c63a5fecb7e848b7` |
| summary-offline-1793517912354.json | `477668f1240d23fbe7c99c493737754660bdf5e30b49ab92230de16c45158b1e` |
| 当前独立检查器 | `aca8bf578c1ac6043c849301af25c25a7794519d933317fd9857bc43a40f3814` |
| 原检查器（原样保留） | `10a94d3fe162ca633de6fd71a66d06b49875bf140bc4370a1df08e8510d20174` |

四份旧 source/review hash 分别为：995 `0aee34ec8992343f4de37a70456fdfefaad8ea76cb48786738d7d79e793b5d85` / `46f9782d40ad136e05b5f451cce430a4ee07d35d6fd00ff3cc2e0ebbc37800a8`；132 `75fd5dd74b27958377345812d143b9d63d3fe3677b3e636a3ef421ef3da6b302` / `ea8fdd08b5bdc8f369fe99240c80cea2289dc96ecf245df259e6c9b5cbe2e02a`；6cda `48db0c6d86894a7560d1a5341110a4ef03fbdd196662bf7ba5fe781766b0e393` / `431e1d94e45738272647df36957e6c502e4f6ce3361ff8e070fb3fbe9fbd56d5`；1ddb `e9957bfe5866b311062b08f291c599ba3dc2297d7bea7a5def986fb3e8115209` / `35f3a38dc6d392891c5b75f1beccb228e51cfafd79c44d0759b2b5084ded05f8`。原路径详见上述各实现记录及新 plan 的输入清单。

## 本次实际结果

唯一 create HTTP201。root 的数据库创建时间为 `2026-11-01 07:23:51.601752+00`，run_completed 事件 created_at 为 `07:24:32.476115+00`，相隔约40.87秒；这是本次运行的创建到完成事件窗口，不是长期性能指标。

| 专家 | Child | 实际工具 | 最终摘要字符/证据/claims |
| --- | --- | --- | --- |
| 客户事实 | `74c4112c-a5a9-4b98-9560-0f806d8a0874` | crm_get_contact 一次，精确关联客户 | 787 / 1 / 30 |
| 商机诊断 | `8217fc03-0ea7-4ad8-b2ee-d504b05aff38` | crm_get_lead 一次，精确 lead385 | 822 / 1 / 27 |
| 政策 | `2ff9c141-28f3-4041-ad9b-cc4edec4a400` | crm_search_knowledge：CSV/审批各一次，quantity各5 | 594 / 2 / 44 |

三个 child 均 inspect/completed，missingMaterial=[]；客户/商机各两模型轮，政策三轮，未再发生多余工具读取。政策结果对应授权 A v3/B v1 的实际不可变证据与正文 hash，不是把资料源 UUID 当知识证据。claims 数量是结构化观察项数，不代表相同数量的独立语义认证。

父另成功重读同一 contact/lead，随后一次 submit_workbench_result 被接受。最终848字符中文 summary 与 result_document.summary 相同，含7条 typed evidence：3条真实 specialist UUID、contact/lead UUID 各1、实际返回 knowledge evidence UUID各1。missingInformation=[]、wakeCondition=none，另3项 unconfirmedFacts 保留预算、上线日期未确认及商机空值；summary 同样保留这些边界，仅建议站内演示和人工 CSV 字段核对，不承诺价格、日期、SLA或外联同意。没有 pending collaboration review。

根 agent 独立逐读父/三个 child 可见最终文本和7条 typed reference，并将 contact/lead 的7项 scalar assertions 对照本次成功工具 details，7/7一致。这是选定字段与来源的 agent 复核，未冒称真人审核、全篇独立语义真值或 Judge 校准。

proposal=0、stage_changed活动=0，复用商机完整冻结投影（含stage/updated_at）保持。两商机的受控 root 集合、四旧历史、联系人/三条确认记忆、来源/binding及固定Wiki版本前后相符。这不是整个数据库无写入的证明：Run、job、日志、证据回执及异步 telemetry 属于运行基础设施；无业务副作用结论限定上述对象、活动和工具范围。

## 计量、请求和未覆盖范围

一个 workbench_start job `816e3f56-533d-403b-9208-3e58eecac4d6` done、attempts=1。4条聚合 llm_calls（父1、专家3）均 dashscope/qwen3.8-flash/ok，input=21538、output=2949、cacheRead=23552、cacheWrite=0，cost均null；这些行不是供应商HTTP调用次数。没有 Judge、模型评分或手工drain。

最终计划的只读freeze实耗48 CRM +2 Wiki SELECT；create前48+2，再唯一一次Run POST；observe实耗73+2、0HTTP。SQL均为受限本机、限定组织/ID的只读事务。create额外使用一次既有RAM浏览器登录和一次精确contact GET证明当前组织，这些鉴权请求不包含在业务POST次数中。观察最多120次两秒轮询，没有自动重复POST；12步/36000 token配置上限未提高，不构成所有费用或分词的精确上限证明。

投影只选 role=tool、白名单公开toolCall参数和可见最终结果，未读取assistant消息正文、私有续写或整份runtime_state。资料与题目已暴露，没有新增seed、业务审批、外部渠道调用。模型对本样本正确使用 unconfirmedFacts 不能保证其他任务都会正确分类；真实缺证/冲突仍必须partial，旧失败/unknown和原CRM-020分母不改。

Langfuse 首次仅5/25可见，后查自有排水器异常退出。恢复本仓受管服务后，原队列继续消费，已取得25/25完整回读；不完整报告、异常退出与完整后继均保留在[收口证据](CRM-021e-closeout.md)。没有重跑业务或模型，退出根因未确定，不借观测齐全宣称评分或长期稳定性通过。
