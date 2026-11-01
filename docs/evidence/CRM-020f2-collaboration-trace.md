# CRM-020f2：同一 Trace 的专家观测对账

2026-11-01。原只读 CLI 按 root 的 `event_log.entity_id` 收集预期，而持久专家各自拥有导出事件、共享 root Trace。仅收 root 会把合法 child span 误判成 unexpected。

脚本先验证输入是当前组织的 root，再收集该 root 与同组织直属 specialist 的导出事件；逐 ID、名称、父链、分页和明确空 I/O 的既有校验不变。所有事件仍须 done 且被正确 consumer 消费。没有将数量相等或 HTTP 200 当作完整证明，也不新增投递、业务或模型调用。

直接真实回读：

| Run | 业务验收 | 远端 span 精确匹配 |
| --- | --- | --- |
| 原 C01 | 保留历史结果；只检查普通 Run 兼容 | 6/6 |
| B01 本批准备，含单次 Judge 的新增观测 | 另按业务/语义报告 | 15/15 |
| B02 本批拒绝 | 另按业务报告 | 13/13 |
| B03 本批批准 | fail：没有产生提案，未批准 | 6/6 |
| D01 本批专家复盘 | fail：父任务空终答；真实三 child 已取证 | 33/33，包含三个 child |

旧查询成员集合与同一次 D01 真实远端结果作只读对照：root-only 为 9 个预期 ID，远端 33 个，其中另外 24 个属于合法 child；新聚合精确匹配 33/33。这个旧逻辑对照在本机离线完成，没有再请求旧版远端 API，也不将业务失败改成通过。

普通 C01 兼容报告：`.local/langfuse-readbacks/readback-1793510992538-149d316e-2610-4f67-bd92-e13d52e24faa.json`，SHA-256 `d4cbed56054761a49ae2671e1b0f80c710cb0225353a29c851c7a1aaa7e605cd`。

本批四 root（含 D01 三 child）报告：`.local/langfuse-readbacks/readback-1793511702398-579db922-4686-4b67-bbbb-9d1f2f68c232.json`，SHA-256 `e6e97a34243ba0bb7f73de997e06df48829eac25da2dcc60102d13c57abe8928`；共 67/67 span、25 model、26 tool，I/O 明确为空，无缺失、额外或身份不符。预期来自实际 outbox，model span 与聚合的 `llm_calls` 行数不是同一分母。

独立静态审查、限定 ESLint、全仓 typecheck 及上述直接回查通过。私有只读成员集合复核在 `.local/crm020/readback-aggregation-recheck-1793511732795-06c22050-ab10-4ecb-8ff9-b0a6284d2281.json`。CLI 的 scoreExportCount 仍只表示本地预期评分数；本批远端评分核验及投递重试另行记录，不以此脚本代替。
