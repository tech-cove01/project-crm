# CRM-026d 固定产品的独立泛化验证

## G2A 同一根的结果提交窗口

2026-11-17（Asia/Shanghai）。第三个正式泛化根 G2A 返回 201，原作业第 1 次领取结束，终态 `partial / missing_material`。真实前五个工具均为只读，之后产品在同一根内启动原生结果恢复。两条成功计量实报输入 9,946、输出 847、缓存读 32,000 token。范围、前后业务状态、提案及外发无变化。

当前捕获器原先只接受开头的 system 和一条用户消息，把产品原生窗口误判为旧上下文。独立复核将原消息逐字节与冻结配置、静态结果合同和 Pi 工具切换对照。窗口包含一个空系统占位和产品的两条固定提示，之后只有同一调用 ID 的实际结果提交与接受回执。新检查接受这一确定的序列，要求此前正常业务消息和已用证据完整，恢复分支最多两轮且不能重新读写 CRM，并对额外消息、非提交工具和改动后的策略拒绝。

| 原始或追加回执（`.local/crm026/`） | SHA-256 |
| --- | --- |
| `generalization/runs/G2A-result.json` | `d478d72372e0ed0a446272200dcaa753b4ab12567be30754977beacab15932c8` |
| `generalization/runs/G2A-intent.json` | `0a9b31e7759e0174bc0c0c873d81fed615ee98b5b07a7aadf14dc5c9f6ac2b75` |
| `generalization/runs/G2A-http.json` | `4c1bbe12b79f4ba9f5496a1d8cdeb7b69f8f140da74ad9cfecb06f2dedfb66f4` |
| `memory/result-window-recovery.json` | `e28aa3a0de593831b6dabae0377b3ea631905ca8aa5c62bdb33a03979d8ea016` |

原件继续保留 `safe=false` 和原终态。复算只追加与两个事故原件及脚本版本绑定的技术证明，记忆阶段汇总哈希保持一致。本批没有重发 G2A，没有更改产品、样例、权限或评分规则。后续从 G2B 继续。
