# Windows 本地运行

更新：2026-10-27。本机已完成首次准备，不需要先注册 Supabase 云账号。Supabase 是本项目的数据库、登录、文件存储与实时服务；当前使用独立 Docker 开发实例。

## 当前入口

- Web：`http://localhost:3000`。开发服务绑定 `127.0.0.1`。
- Worker 健康检查：`http://127.0.0.1:8787/healthz`。
- 本地 Supabase API：`http://127.0.0.1:55421`，PostgreSQL 端口 `55422`。
- 登录资料：仓库内 `.local/login-credentials.json`，仅本机使用，不进入 Git。
- 配置：`.env.local` 保存实际本机配置；`.env` 保留为存在的文件，因为上游 Worker/cron 命令同时读取两者。

没有启动自动演示 seed，`CRM_DEMO_MODE=false`；登录使用真实 Supabase Auth。验收客户为明确标注的合成资料，真实保存到数据库；没有调用模型或发送客户消息。

## 日常启动

先开启 Docker Desktop。下列 PowerShell 命令在仓库根目录执行。

```powershell
# 已缓存的 Supabase CLI，首次准备时已核对官方发布校验和。
& .\.local\tools\supabase-v2.122.0\bin\supabase.exe `
  --workdir (Get-Location).Path --agent no start `
  --exclude 'postgres-meta,imgproxy,studio,mailpit,edge-runtime,logflare,vector,supavisor' `
  *> .local\supabase\start.log

# Web 终端
$env:COREPACK_HOME = Join-Path $PWD '.local/corepack'
corepack pnpm dev --hostname 127.0.0.1 --port 3000
```

另一个终端启动 Worker：

```powershell
$env:COREPACK_HOME = Join-Path $PWD '.local/corepack'
corepack pnpm worker
```

后台启动记录在 `.local/running-processes.json`，日志在 `.local/web-dev.*.log`、`.local/worker.*.log`。手工终端运行时用 Ctrl+C 停止对应进程；不要停止或重置旁边 Go 项目的服务。

当前 CLI 与缓存位于 .local，不随 Git 克隆。新电脑先按 [Supabase 官方本地说明](https://supabase.com/docs/guides/local-development/cli/getting-started) 准备 CLI 和 Docker；本次固定 CLI 2.122.0，下载来源及校验和为 [官方发布页](https://github.com/supabase/cli/releases/tag/v2.122.0)。依赖安装使用 Node >=22 和 pnpm 9.15.9：`corepack pnpm install --frozen-lockfile`。

## 首次数据库初始化的边界

`supabase/config.toml` 使用专用 `project-crm-local` 和 5542x 端口，禁用 CLI 自动 migration/seed。原因是上游早期 migration 含占位历史，新库必须按 `scripts/db-migrate.sh` 以 `supabase/baseline.sql` 初始化，不能把 `db push` 当作完整新库初始化。

本机已完成：先确认新专属库没有组织/用户，再启用 vector、citext、pg_trgm 及所需扩展，应用 baseline，最后运行上游 `scripts/bootstrap-owner.ts` 创建开发账号/组织。当前已有数据，不需要重做。不要对已有库执行 reset、清卷或重复首次初始化脚本。

首次准备遇到缺少 citext 扩展而停止，补齐上游脚本列出的扩展后按幂等 baseline 完成，失败日志保留；没有把它误判为应用源码缺陷。

## 当前可用与未配置

- 已实测：锁定安装、完整类型检查、生产构建、Supabase 核心服务、183 张业务表初始化、真实登录与引导、4 个核心页面、客户创建/纠正/刷新读取，以及未登录拒绝读取。
- Worker `/healthz` 为 200、数据库正常，队列无待执行/执行中/死信。Web `/api/v1/health` 为 200 且总体 `degraded`：Supabase 正常，Redis 和 WAHA 未配置。这不是所有外部服务都健康的声明。
- 本地单实例暂用上游的内存 Redis 降级，不作为多实例部署方案。CLI 默认 Docker 端口发布到所有接口，并非所有依赖都仅绑定 loopback；公网方案需单独收紧服务暴露范围。
- 未配置模型凭据；工作台显示默认模型不等于 Key 已可用。后续在组织的 AI 凭据/模型页面配置真实 provider，再单独验收 Agent；Key 不发到聊天里。
- Mem0、WeKnora、Langfuse、WhatsApp、邮件和飞书不要求同时配置。其具体能力、边界和缺口见 [能力清单](current-capabilities.md)。
- 保留上游葡语/西语基础界面及已有中文工作台，不在本轮无关地全站翻译。

本轮构建发生在本机运行配置生成前，构建期允许上游内部占位；验证的是能编译，不能把本次构建直接用于公网。源码通过 PublicEnvScript 提供运行时公共 URL，因此并非每次改 URL 都强制重新构建；正式上线前仍需安全升级、真实部署配置、重新构建与完整验证。当前 Supabase CLI 栈只作本地开发环境。部署路线见 [Cloudflare 评估](cloudflare-deployment.md)。
