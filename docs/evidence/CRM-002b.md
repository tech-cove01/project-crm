# CRM-002b：本地数据库、认证与实际页面

日期：2026-10-27。继承业务代码未重写；源码改动为隔离的 supabase/config.toml 及 Next dev 自动维护的 AGENTS 说明块。

## 独立环境与初始化

- Supabase CLI 2.122.0，官方 ZIP SHA-256：`60031FD5BF050FC12A0C6AEF68997600D143870F944BF13109C7765DCA329AF8`，与官方 checksums 比较一致；未全局安装。
- 专用 project_id=project-crm-local，API 55421、PG 55422，其余为 5542x；禁用 CLI 自动 migration 和 seed，关闭当前不需要的辅助服务。
- 新建 Postgres/Auth/REST/Realtime/Storage/Kong 六个核心容器。Auth/REST 请求均为 200；没有停止、重置或复用 Go 项目的 MySQL/Redis。
- 新库初始化前确认没有组织/队列表与 Auth 用户。首次遗漏 citext，SQL 在 organizations 创建前停止；保留日志，补齐 `scripts/db-migrate.sh` 要求的扩展后完整应用幂等 baseline，最终为 183 张业务表。
- 本机生成 `.env`、`.env.local` 和开发登录资料；关闭自动演示 seed 与上游遥测，没有填模型 Key。上游 bootstrap-owner 实际创建开发 Auth 用户、组织和权限。

## 真实浏览器和 API

- Edge/Playwright 真实登录成功、认证 Cookie 存在。通过现有界面完成初始化引导，可选的渠道、模型、试运行和邀请步骤跳过。
- `/app`、`/app/contacts`、`/app/kanban`、`/app/ai/workbench` 均为 200、停留正确路由，无引导重定向；本轮最终复核 pageerror、console error 和失败请求均为 0。
- 真实鉴权 API 创建明确标为合成资料的客户返回 201；修改显示名后重新读取一致，客户详情刷新仍可见。没有填写电话，不连接对客渠道。
- 新未登录浏览器访问同一客户接口返回 401。
- Worker `/healthz` 为 200、db=ok、队列 pending/running/dead=0、event_log_drain 已加载。Web health 为 200 / degraded，Supabase=ok，Redis/WAHA 为未配置；不把 degraded 写成全服务通过。

## 失败与边界

- 主 agent 首轮页面脚本误用不存在的 `/app/pipeline`，也未完成引导，不能算核心页面通过。独立 agent 按真实 `/app/kanban` 与 UI 引导完成后才记录上述成功。
- 独立 agent 首轮额外假设“无 Key 必有工作台模型提醒”不成立，相关失败报告保留。源码 UI 判断默认 provider/model，并不证明凭据可用；最终报告只记录页面实际结果，不以默认模型字段宣称 AI 已可运行。
- 本轮没有提交 Agent 任务、调用模型、连接客户渠道或验证 Mem0/WeKnora/Langfuse。没有把上游历史报告或本地合成资料当作生产效果。
- CLI 默认端口映射到所有接口，不能写为全部 loopback；原有 Sentry 弃用/Worker `off` DSN 提示等日志保留，未据此声称所有继承告警已清零。

本地记录：`.local/supabase/`、`baseline-apply.*.log`、`baseline-first-attempt.stderr.log`、`bootstrap-owner.log`、`crm-browser-report.json`、`crm-browser-initial-report.json`、`crm-contact-report.json`、`crm-health-report.json`、运行日志及截图。凭据和认证 state 仍受 Git 忽略。

独立复核对照浏览器/客户/健康报告与源码配置通过，并修正了部署材料的浏览器 Supabase 直连、CLI 开发栈与运行时 URL 边界。本轮没有重复执行无关的历史套件；完成状态随对应提交成功生效。
