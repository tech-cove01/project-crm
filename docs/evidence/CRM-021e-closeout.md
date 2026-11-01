# CRM-021e：观测、计量与交接

2026-11-01。本批四个修复目标的业务证据分别见[批准](CRM-021a-approved-chain.md)、[协作](CRM-021b-collaboration-verified.md)、[检索](CRM-021c-retrieval-regression.md)、[并发](CRM-021d-concurrency.md)。修复后取得新的有限通过证据，旧 CRM-020 和本批四次协作失败均未覆盖。本页不替代后续语义评测。

## Langfuse 精确回读

使用现有 `scripts/readback-langfuse.ts`，读取 SQL 的预期 span 与同组织直属专家，按稳定 ID、类型/元数据及隐私字段核对远端投影；只读 SQL 和远端 GET，没有新模型、Judge、业务 Run、评分或手工遥测重投。六个 root 共 **145/145 span**，各最终报告均 complete=true、privacyVerified=true，missing/unexpected/mismatchedSpanIds 为空，导出事件均 done/consumed。span 齐全不表示答案正确。

报告均位于私有 `.local/langfuse-readbacks/`：

| Root | span | 最终报告文件 | SHA-256 |
| --- | --- | --- | --- |
| 批准22306fc2、首次协作995e7150 | 14+29 | readback-1793515679527-0b251583-d166-454f-a446-1eda10d6301a.json | `9e3e805a78d6db95a84de443bf9a6d6a4c927b6084b3df51d8865dbdb1506500` |
| 协作132fd6b2 | 24 | readback-1793516800727-a28a1c46-a26f-4637-be15-0049c9f1897d.json | `ede05ef0c1dd36dfe350d93f1b51894283ff00c7291db56d9c1ad43c49748d11` |
| 协作6cda51ec | 28 | readback-1793517252830-6c7cbd48-fa53-4684-b965-a4f160f18f95.json | `76c3a2f5ddc297774f48f3ba6f2a2347f0427ebf2e54f6bd5e7bac5bfe690ce2` |
| 协作1ddb20b6 | 25 | readback-1793517688545-9ddbbd9f-57d6-4eda-9b69-6983810b3844.json | `eb25a02aea0ee38dd0374bb25e758ee066c80b78cf6d1e9218171a3d6e36b424` |
| 正常协作ead5e7d1 | 25 | readback-1793518100850-572bc070-875c-44d7-bd47-a7ddb2d85bbb.json | `4fa3910fa78dd1f9ea5e015846d8ad9cfe807b835b5d3d3872cfcc76c0196adb` |

## 最后一条的中断与恢复

ead5 的前三次回读为5/25、5/25、16/25，未当作通过。前两次保留报告 `readback-1793517884067-a0705a4e-f00b-46b0-80dc-31c05f8c6e20.json`（SHA `1c9ff6fe26db850e70ece69e61f899047c5c032d4563089f4ae7fe05b3c8a66d`）、`readback-1793517920289-9af78890-3a14-4061-aa5f-11a9e31d73b5.json`（`0b11a7a79621a9e99b4c4573fa64ef5c3a42725de34a611027c9fcdd72344bba`）；恢复后16/25报告为 `readback-1793518060396-173f6567-54d8-4de7-8608-9dcf596a2716.json`（`70b22dd6504846bf9237e39bb85d167cfa9bd45dfcae80a9f14b0a0123f39fc7`）。随后才取得上表25/25。

07:26:31 UTC 公开状态显示，自有受管会话 `f3615dd8-af22-43ab-8b53-6489f424cc2e` 的 drain 在07:24:27异常退出，exitCode=3221226505、stderr长度0；supervisor随后按既有机制停止本仓Web/Worker。退出根因尚未确定，不能称已修复长期稳定性。该会话私有 `state.json` SHA为 `72079e1ec4f9f9278db9dac1e231c3973d9fae228bbcece644ab5e980d621897`，仅记录其哈希及公开状态，未导出内部凭据。

当时业务队列 pending/running/dead均0，集成6条pending、done120。只用现有 `local-crm.mjs start` 恢复本仓受管服务，没有操作其他项目进程或Docker；原outbox继续由排水器消费，没有重建业务任务、重发批准或调用模型。恢复后集成done126、pending/processing/dead均0，最后9个span也已远端可见。该现象证明此批已完成投影，不证明所有崩溃或长期运行均无问题。

## 本批实际计量

从批准最终source和五次协作source合并、按记录ID去重：**6 root、15 child、7 job**，job均done/attempts=1；**24条聚合llm_calls**，目的仅agent_turn/agent_specialist，全部dashscope/qwen3.8-flash/ok。input/output=`140907/19473`，cache read/write=`141312/0`；24条费用均null/未知，缓存单列不叠加成输入，不声称免费。这些数据库聚合行不等于供应商HTTP请求次数，失败尝试也包含在分母中。

只读检索回归可能使用原有embedding，本批不因此称“所有外部调用为0”。本次没有追加Judge或语义评分，规则/历史评分不改。来源索引及source哈希分别见批准与协作文档；仅投影role=tool、白名单公开调用元数据与可见最终结果，不读取私有续写。

## 交接快照与限制

2026-11-01 07:28:23 UTC（15:28:23 Asia/Shanghai）：Web HTTP200/既有degraded，Worker HTTP200/DB ok/排水器已加载；Mem0、WeKnora、Langfuse健康端点均200，探针不等于认证深验。业务pending/running/dead与集成pending/processing/dead均0、集成done126。恢复后的自有会话 `cf87042e-3050-48e8-b5b9-b019f287e032` 保持运行；实时状态以 `npm run local:status` 为准。

产品验收基线为 `dbbc4cab27b20e3973c6997454b0f9b2a558c1b8`，后续提交仅收口文档。各小功能均有对应直接测试、限定ESLint、全仓typecheck及独立审查；未为收口重复无关全矩阵。D02/F06各缺一页、费用未知、排水器异常退出根因及未完成的总体语义质量校准仍明确保留；不称全库召回、全路径原子控制或生产可用。所有代码与文档随本票推送，远端引用另行独立核对。
