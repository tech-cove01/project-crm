# CRM-026c 真实跨会话记忆运行

## 首个对照根的采集核对

2026-11-17（Asia/Shanghai）。首个正式 A1 无持久事实槽已完成原作业第 1 次领取，终态为 `partial / missing_material`。联系人和当前会话工具各读回 0 条确认事实，当前会话仅包含本轮请求，无旧 checkpoint，Wiki 未配置并返回不可用。无跨范围、提案、业务事件或外发。实报输入 9,101、输出 580、缓存读 19,456 token，费用未知。

最初的采集规则误判 Pi 保存的一条前置 `system` 消息，将原 `fresh=false` 和 `safe=false` 留在原件。独立逐字节核对该消息由冻结的 Agent 提示词和产品静态工作台说明组成，整个初始序列只有这条系统消息和精确匹配的本轮 scoped 用户任务。系统消息 SHA-256 `9d25de1bfb6b9d890533c803a75e410f38fcd22e067827f15653228f9cb16346`，冻结提示词前缀 `e4f727703cac6a678651f3b38c66ccfb38500746c4080f3e95d90fefc6dbd6ac`，静态说明后缀 `67cd978e24b8ab8a5d8596307efe6c69ab516845dc7bb57426a8a5f055339c1a`。

追加技术复核要求前置提示词两个哈希精确匹配且无其他历史输入，工具回执、范围、用量和终态按原件。应用版本、场景、权限和评审语义保持冻结。本次未重发请求或增加模型 Run。

| 本地回执（`.local/crm026/memory/`） | SHA-256 |
| --- | --- |
| `runs/A1.none-result.json` | `fbda4bd1ac34ac6b47677a5093d3f223f6ef540c4b05f76f04fd80a08a6600c3` |
| `runs/A1.none-intent.json` | `fb337ae79d97c5f10fa2b67b743a20a276a24e2bf04dd7c039e58ebb0c2510b2` |
| `runs/A1.none-http.json` | `d01648a46328fdbffdd1f444594f81976a676d26b27d3a09759fd5e3f15dae05` |
| `system-message-recovery.json` | `3c170190e3567fe2042621dad6e6d4703bb970b34d89d53a3ff8c2beec00504d` |

读取该槽始终先校验原字节哈希，再从原意图和冻结配置重新派生验证结论。早期技术复核稿保存在 `system-message-recovery-pre-integrity.json`。结算的 1/18 原记忆槽计入 1/30 正式总额度。该槽缺证对照的答文仍按冻结业务标准独立评分。下一原计划槽为 A1 SQL。
