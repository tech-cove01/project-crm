# Windows 本地运行

更新：2026-10-27。本机已完成首次准备，不需要先注册 Supabase 云账号。Supabase 是本项目的数据库、登录、文件存储与实时服务；当前使用独立 Docker 开发实例。

## 当前入口

- Web：`http://localhost:3000`。开发服务绑定 `127.0.0.1`。
- Worker 健康检查：`http://127.0.0.1:8787/healthz`。
- 本地 Supabase API：`http://127.0.0.1:55421`，PostgreSQL 端口 `55422`。
- 登录资料：仓库内 `.local/login-credentials.json`，仅本机使用，不进入 Git。
- 配置：`.env.local` 保存实际本机配置；`.env` 保留为存在的文件，因为上游 Worker/cron 命令同时读取两者。

没有启动自动演示 seed，`CRM_DEMO_MODE=false`；登录使用真实 Supabase Auth。验收客户为明确标注的合成资料，真实保存到数据库；该初始验收没有调用模型或发送客户消息；后续百炼 Agent 验收见 CRM-006。

## 日常启动

启动前可先执行只读状态检查：

```powershell
node scripts/local-crm-status.mjs
```

该入口读取 `.env`、`.env.local` 和既有生成绑定；明确进程环境优先，生成的组织绑定统一覆盖旧 ambient 绑定。仅接受本项目的本机 development 地址，显示健康与两类队列计数，不打印凭据或客户正文。公开集成端点可达不等于已鉴权；Worker 的 HTTP、数据库和消费循环就绪分别显示。无需为状态检查重启、迁移或初始化。

先开启 Docker Desktop。下列 PowerShell 命令在仓库根目录执行。

已有本机数据库与集成依赖在线时，使用受管入口：

```powershell
node scripts/local-crm.mjs start
node scripts/local-crm.mjs status
node scripts/local-crm.mjs stop
# 等价 npm 命令：npm run local:start / local:status / local:stop
```

入口只管理当前仓库此次启动的 Web、Agent Worker 和专用 integration drain，不操作 Docker。3000/8787 已占用或业务队列 pending/running 非零时拒绝接管；集成 pending 可由 drain 处理，processing 非零先拒绝启动。当前 `.env.local` 和 `infra/local-agent-services/.env.crm.generated` 为三进程的共同配置，不重新生成凭据或组织。Worker 健康端口仅监听本机，自动付费 flywheel 在受管模式关闭；没有启动 `dev:crons`。

每次会话在 `.local/local-crm/<session>/` 保存独立脱敏日志和退出事件，`status` 展示受管角色及心跳、健康和队列。日志、锁和状态文件均为本机材料，不上传。`stop` 无需配置继续有效，按 drain → Worker → Web 顺序停止；所有阶段共享关闭截止，超时强停与正常退出分开记录。不循环自动重启，历史无日志退出的根因仍需实际证据。

未知进程或手工启动的旧服务不会被接管/停止。陈旧锁或停止未确认时，先看会话日志并核对当前进程、端口及队列，不能按旧 PID 终止进程或盲目删锁重开。受管 Web 使用当前锁定 Next.js 的本机开发服务器入口，Worker 沿用原应用逻辑；升级 Next 时须复核该启动入口。

下面保留原手工启动方式，勿与受管入口同时启动同一端口。

### 恢复本机既有集成容器

受管入口不创建或重置依赖。此机器已有 CRM 专用容器和持久卷时，先检查归属与名称：

```powershell
docker ps -a --filter label=com.docker.compose.project=crm-agent-services --format 'table {{.Names}}\t{{.Status}}'
# 确认属于当前仓库、沿用已有配置后，按需选择服务启动。
docker start crm-agent-services-postgres-1
docker start crm-agent-services-redis-1 crm-agent-services-clickhouse-1 crm-agent-services-seaweedfs-1
docker start crm-agent-services-mem0-1 crm-agent-services-weknora-1
# 等 Postgres / ClickHouse healthy、对象存储就绪后再启动：
docker start crm-agent-services-langfuse-worker-1 crm-agent-services-langfuse-web-1
node scripts/local-crm.mjs status
```

这组命令只恢复本机现有实例，保留容器配置和卷；新电脑没有这些容器时应按 `infra/local-agent-services/README.md` 准备，不能把首次配置与已有实例恢复混用。按需服务的公开端点分别为 Mem0 8888 的 `/docs`、WeKnora 8088 的 `/health`、Langfuse 3006 的 `/api/public/health`；可达不证明组织鉴权或业务成功。不要对旁边 Go 项目的 MySQL/Redis/Kafka 执行启动、停止或重置。

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
- 已在本机 CRM 加密凭据中配置百炼 `qwen3.8-flash`，并通过真实只读 Agent 验收；详情见 [CRM-006](evidence/CRM-006.md)。凭据仅保存在本机数据库，不提交到 Git；模型成本记录目前为未知。
- Mem0、WeKnora、Langfuse、WhatsApp、邮件和飞书不要求同时配置。其具体能力、边界和缺口见 [能力清单](current-capabilities.md)。
- 保留上游葡语/西语基础界面及已有中文工作台，不在本轮无关地全站翻译。

本轮构建发生在本机运行配置生成前，构建期允许上游内部占位；验证的是能编译，不能把本次构建直接用于公网。源码通过 PublicEnvScript 提供运行时公共 URL，因此并非每次改 URL 都强制重新构建；正式上线前仍需安全升级、真实部署配置、重新构建与完整验证。当前 Supabase CLI 栈只作本地开发环境。部署路线见 [Cloudflare 评估](cloudflare-deployment.md)。

## 百炼知识库

本机 `.env.local` 已设置 `CRM_EMBEDDING_PROVIDER=dashscope`，Web 和 Worker 同时使用组织中已验证的百炼加密凭据及 `text-embedding-v4`（1536 维）。省略该配置默认使用原 OpenAI 模型。修改环境配置后应同时重启本项目的 Web 和 Worker。

本机 0410 数据库迁移已应用；新应用与迁移需要同步部署。切换 embedding 模型时旧索引必须重新生成；旧五参数 `retrieve_top_k_chunks` 会明确拒绝调用，需迁移至带模型身份的新接口。合成 FAQ、隔离检查和运行结果见 [CRM-007 验收](evidence/CRM-007-capabilities.md)。不要求启动 Mem0、WeKnora 或 Langfuse 才能使用原生知识库。

当前机器的 Mem0 容器需在 Docker 重启后手动启动（保留已有配置、镜像和卷）：

```powershell
docker compose --env-file infra/local-agent-services/.env.generated -f infra/local-agent-services/compose.yml --profile mem0 up -d mem0
```

目前独立 PostgreSQL 的本地镜像标签沿用了 `15.8.1.085`，实际基于 15.19；本机适配 Dockerfile 位于 `.local/Postgres.Dockerfile`，与仓库中的来源 Dockerfile 不同。镜像或私有配置丢失后不能直接按来源文档声称已恢复；须重新核对并构建，不能清空现有卷。

启用本机集成后，启动 Web 和 Worker 的 PowerShell 终端都要先加载由 `scripts/provision-local-agent-services.ts bindings` 生成的本机绑定（文件含凭据，勿上传或粘贴到聊天）：

```powershell
$bindingLine = Get-Content 'infra/local-agent-services/.env.crm.generated' | Where-Object { $_.StartsWith('AI_INTEGRATION_BINDINGS=') } | Select-Object -First 1
if (-not $bindingLine) { throw 'Local integration bindings missing' }
$env:AI_INTEGRATION_BINDINGS = $bindingLine.Substring('AI_INTEGRATION_BINDINGS='.Length).Trim("'")
```

然后在各自终端按上文启动 Web 和 Worker。每次重新生成绑定后需重新加载并重启两者；未配置的服务不应标为已验收。

启用外部服务时，普通 Worker 的业务事件循环不会处理集成队列。本机启动 Web 后，可用 `node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/dev-integration-drain.ts` 启动仅处理集成队列的本机定时器；须设置 `NODE_ENV=development`，且 Web、数据库和 Supabase 地址均为本机。专用入口处理该 Web 所连数据库的全局集成队列，不按组织筛选：必须确认 Web 实际使用同一个本机数据库。每次调用结束后等待 60 秒，不处理客户消息队列。正式部署使用独立 scheduler。
## 本机工作台演示模式

本机 `.env.local` 显式设置 `NODE_ENV=development` 与 `CRM_LOCAL_WORKBENCH_UNPRICED_MODE=true`，用于普通百炼 Workbench 任务的审批续跑演示；单次金额预算关闭，原有 token/步骤控制仍在，但不是硬上限。该开关默认关闭，组织预算和 Mission 不变；工作台会显示提示，详细范围和验收见 [CRM-008](evidence/CRM-008.md)。

销售演示使用 `npm run demo:sales -- prepare` 生成本次中文任务与范围，只读检查，不创建模型任务或自动批准。实际操作、预期结果和失败处理见 [3–5 分钟销售演示](sales-demo.md)。

三任务演示使用 `npm run demo:sales -- prepare --split`。本机专用 integration drain 默认每 60 秒执行一条远端操作；可在 `.env.local` 显式设置 `CRM_LOCAL_INTEGRATION_INTERVAL_MS=10000`（合法范围 10000–60000）缩短观测等待。先检查队列和受管会话，再正常 stop/start 加载配置；只重启自己的会话，不接管其它进程。该配置不改变服务端单次消费上限或生产 scheduler，Langfuse 仍需按实际 Trace 回读。
