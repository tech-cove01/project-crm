# CRM-020f：观测、评分回读与有限回归

2026-11-01。范围为 CRM-020 的四个真实业务 root、D01 三个 child 与 B01 一次 Judge，不将观测齐全解释为业务或质量全部通过。

## 真实回读

同组织 root/直属 child 聚合见 [CLI 修复](CRM-020f2-collaboration-trace.md)。四 Trace 共 **67/67 span**：B01 15、B02 13、B03 6、D01 33；包含 25 model、26 tool，逐 span ID/名称/父链匹配，I/O 明确为空，相关 outbox 自然 done/正确 consumer。Judge 的追加调用观测也在 B01 15 个中；没有手工重放这些 span 来填补本批缺失。

独立读取 Scores API v3，按原 outbox 的稳定 score ID、名称、值和 observation/trace subject 核对：B01 15（规则 7、语义合并报告 8）、B02 6、B03 6、D01 7，共 **34/34**。不只检查 HTTP 200、本地计数或评分均分；分页、意外 ID 与 subject 错配均作为失败。

- span 报告 SHA-256：`e6e97a34243ba0bb7f73de997e06df48829eac25da2dcc60102d13c57abe8928`，路径见 CLI 修复证据。
- score 报告 `.local/crm020/score-readback-1793511702376-f9c8e53e-f619-4975-a8d3-82a7b74798ca.json`，SHA-256 `aa503cd0fba74247cecd477dda8b7714497147f45cdf63ae88bb872561895b95`。

本机部署的 Scores v3 端点与 subject 格式按实际响应和[官方 API 文档](https://langfuse.com/docs/api-and-data-platform/features/public-api)核对。回读结果不外推其他版本或生产稳定性。

## 一次稳定 ID 遥测重投

选取 B01 已自然 done 的原评分事件 `94fe61d8-a545-43bc-8272-a9e72691b796`，先冻结只读快照和计划，再显式调用原 exporter **一次**，不重新入队、不改原事件、不创建 Run 或调用模型/Judge。固定 10 秒后再次精确读取原 Trace/全部必要评分。

结果为 passed；选定 Run 的两个聚合 LLM 记录（业务与 Judge）及全组织模型行数、输入/输出计数、job/attempts、提案/参数、客户/商机行哈希、Run 事件与原 outbox payload/status 均未变，远端 span/score ID 集合不增加。费用 null 保持未知。

这是显式、稳定 ID 的单事件遥测重投验证；没有制造队列故障或证明所有消费者的自然故障恢复，也不推导客户渠道 exactly-once。

- 计划 `.local/crm020/telemetry-retry-plan-35ffd370-09e9-4d8b-a6f2-b4728cbc90fb.json`，SHA-256 `97628fe60acb6c37bd3d39722d6aeba19f59da427aa442d0750a2b2a0cc0340a`。
- 结果 `.local/crm020/telemetry-retry-35ffd370-09e9-4d8b-a6f2-b4728cbc90fb-result-1793511844180.json`，SHA-256 `7ca4b9c81d4f37dc91c8528dbb72d6616cea3ff67ad58be67914908ad556c732`。

## Judge 与历史原例

[主链证据](CRM-020c-main-chain.md)保留 B01 唯一 Judge 的 completed/pass/92，合并 needs_review/92，以及 B03/D01 的业务 fail；Judge 可见材料经过裁剪门禁和具体来源预检。规则、模型角色分离与单次评分不等于真人真值校准，未做人工抽查，不称完整语义质量已通过。

另外只对已有原文做离线已曝光回归，没有新模型或 SQL：当前来源审计仍识别原 `b73606ef…` 的两个错类型引用；原 `71544fe6…` 前三条 revision 相同的工具真值和历史误述报告保持一致；原 C07 `bc4cd530…` 的 `2026-08T` 日期片段不在成功工具观察中。revision 一项仅检查原真值/失败记录保留，不冒称已新增通用语义误述分类器。无答案原例保留 017/018 报告，新资料结果另见 020d，不将旧题换名为新验证。

离线报告 `.local/crm020/history-regression-1793510666623.json`，SHA-256 `b7c2995ee2c880c842d9e2e7a77cca7a431f8ce2eaf846999ac92faa6ec9f7d5`；最初私有脚本存在环境加载及 plain-text 工具解码的技术错误，修正后只离线核原文，没有重跑历史业务或覆盖旧文件。

本批观测和一次辅助 Judge 有各自范围内证据；完整主链、正常协作及最后锁竞争的失败/未知仍保留，四条亮点的整体使用门槛尚未全部满足。
