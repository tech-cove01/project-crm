# CRM-021b6：非阻塞的未确认业务事实

2026-11-01。修复只读复盘将已知业务边界误作当前取证失败的结果合同；真实后继另验。

## 实际新发现

在干净源码 `a5def1d482e17af29412591081ae08aec00bc8ee` 上，root `1ddb20b6-718a-4f3d-b209-a68059870058` 已有 1243 字中文终答、7 条可对应实际观察 UUID 的证据、wakeCondition=none，三 child 均 completed 且工具范围正确。首个提交因一条 claim 超过 300 字被 schema 拒绝，同一预算窗口内缩短后 accepted=true；不是再次发生 human_approval 错误。

模型把两类已观察业务条件填入 missingInformation：预算/上线日期未确认，商机金额/关闭日期/负责人/活动字段为空。本次用户只要求读取并报告这些边界，并未要求补齐或推进业务；现有统一缺口列表易把“报告未知已完成”和“尚无完成报告所需的证据”混为一类。系统如实将非空 missingInformation 保持 partial/missing_material，没有伪报成功。

另一个原冻结检查失败是 quantity=3 而非 5。实际 CSV/审批关键词精确各一次，返回 A/B 身份、版本和正文依据正确；原题干并未要求数量 5。后继私有验收器会独立修正这一仪器过约束，保留整数 1–5 的原候选预算，其他原检查不变。原 strict fail 不回填为通过；这也不能消除上述结果分类问题。

私有目录 `.local/crm021/collaboration-mode-recheck/f32adff9-9e20-4174-8bd0-53f0454a81c7/`：plan SHA-256 `eacc68581c6d0b5d55ae48984cb281a779a5e1e2d14a2d67e61e256cb3eabe14`，frozen `1b3f7900222ebea41e6d4ea4244617e0891de504590469a3b10687d824d06011`；source `e9957bfe5866b311062b08f291c599ba3dc2297d7bea7a5def986fb3e8115209`，原 review `35f3a38dc6d392891c5b75f1beccb228e51cfafd79c44d0759b2b5084ded05f8`。source/review 文件名和精确计量在该目录 `summary-offline-1793517541612.json`，SHA-256 `d44b835bd8d6a9d0236a41e1396d9687797a68070680369475657d2aa7ad23ee`。无提案、无阶段效果，旧失败及资料未变。

## 合同与展示

结果增加可选 `unconfirmedFacts`（最多 8 条、每条 240 字），保存已观察空值或明示尚未确认、但不阻止回答当前任务的业务条件；summary 同样须保留边界。真正读取失败、当前任务必需的证据缺失或未解冲突仍填 missingInformation。模型自行提交分类，代码不会自动清空缺口、搬运字符串、改写旧结果或强制 completed。

原有字段界限、额外键拒绝和 missingInformation→partial 规则保留；新增可选字段对旧 JSONB/文档兼容。初始指令和恢复提醒使用相同分类；工作台增加中文“尚未确认的业务事实”，缺字段或空数组不渲染。未增加请求、权限、状态或外部副作用。

## 直接验证

三文件 **32 passed**：通道、Pi result adapter、result-recovery；恢复提醒变更后只重跑其 10 项通过，不与原 32 项重复相加。直接对照确认非阻塞未知可保存，实际当前任务缺证即使同时有 unconfirmedFacts 仍 partial，字段超限继续拒绝。源码/测试与 UI/恢复两组限定 ESLint、最终全仓 typecheck 与 diff 检查通过。

独立审查通过，复核了 JSONB/API、结果评测消费者的旧文档兼容及 UI 条件渲染；实际模型能否正确分类仍须新 Run 验收，不能据此宣布整体语义分类已校准。
