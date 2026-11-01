# CRM-021b4：无提案的待复核结果保持诚实展示

2026-11-01。新实测 `132fd6b2-4373-4f82-8b00-abce13f7e6e7` 已有父结构化提交，但客户 child 额外请求不可用工具并收到 `Tool crm_get_lead not found`，child 与父仍 partial，协作 review=pending。模型 summary 却声称“三位专家分工均已覆盖”“工具缺口已由父 Agent 补齐”，不能据此当作正式完成评估。父直接补读不改变原 child 的真实失败。

原 source `.local/crm021/collaboration-recheck/47a0bc5b-4a22-4ab4-a096-0432013dd984/source-1793516234863-90a4573a-aaf7-4708-a0be-1beec56aa4df.json`，SHA-256 `75fd5dd74b27958377345812d143b9d63d3fe3677b3e636a3ef421ef3da6b302`；review SHA-256 `ea8fdd08b5bdc8f369fe99240c80cea2289dc96ecf245df259e6c9b5cbe2e02a`。旧 Run、失败、原模型提交和报告不改。

在 [021a2](CRM-021a2-pending-display.md) 的共享展示函数上补充 `collaborationBlocked && !pending` 分支：服务器仅显示“协作证据尚待复核，相关动作仍被业务层阻断。请先完成复核。”，`result_document=null`，不暗示已经创建提案。原 status 仍 partial，动作门禁不放行；原提交保留于 transcript，不重写模型内容或把本次失败改为成功。

既有 pending/send-message/无阻断完成结果不变。新受控服务器占位也加入精确 prior 排除，决定或复核后如果没有新提交，不复用旧等待文字。三份直接测试文件共 26 项通过、限定 ESLint 和独立代码审查通过；覆盖真实关闭接线以及本次无提案但待复核的误述投影。这是确定性展示回归，没有新模型、DB、HTTP 或 Judge。全仓类型检查随合并修复统一核对。
