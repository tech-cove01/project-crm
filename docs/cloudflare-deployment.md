# Cloudflare 部署评估

核对日期：2026-10-27。本文是源码与官方文档评估，不代表已通过构建或部署验收；本轮不发布，也不创建云资源。

## 当前先本地运行

用户已确认尚无 Supabase 云项目，先通过本地 Docker 准备服务并验证 CRM。Supabase 在这里不只是数据库：应用还依赖它提供登录认证、文件存储和实时更新。只启动普通 PostgreSQL 不能完成相同的登录与存储链路。本地服务的启动、数据库初始化和真实业务结果分别记录实际证据。

用户已有 Cloudflare 账号/域名，暂时没有服务器。当前先本机运行；后续可让本机承载 Web/Worker 并配命名 Tunnel 演示，宿主机需保持运行。数据库入口须先按下文改为正式受控配置，不能直接发布当前 CLI 开发栈。稳定在线的服务器选择另行确认，本轮不要求先购买，也没有创建 Tunnel 或修改域名。

## 推荐的后续部署方式

优先保留现有架构：

```text
浏览器 → Cloudflare 命名 Tunnel → Next.js Node 应用 → 数据服务
   └──────────────────────────→ Supabase HTTPS API / Realtime
                                 独立 Agent Worker + scheduler → 数据服务
```

- Linux/Docker 运行 Next.js 应用、独立 Agent Worker 和 scheduler；按业务需要再启用 WAHA 等渠道服务。
- `cloudflared` 从服务器向 Cloudflare 建立出站连接，将固定子域名映射到应用 HTTP 服务，不把数据库和内部 Worker 健康端口直接公开。[Tunnel 原理](https://developers.cloudflare.com/tunnel/)
- 本机 Docker 可用于开发和演示；稳定上线需选择能持续运行的宿主机。服务器容量根据实际启用服务核定，不把来源资料中的历史资源数当作本次实测。

源码依据：`next.config.ts` 使用 standalone；`Dockerfile.worker` 与 `workers/agent-worker/main.ts` 实现 Node 常驻任务、数据库队列和多个循环；`docker-compose.prod.yml` 已拆分 app、worker 与 scheduler。保留这条路径需要的运行时改造最少，但仍须实际验收。

### 本机演示还要规划浏览器的数据入口

不能只将 Web 端口映射后就宣称远程可用：`lib/supabase/browser.ts` 在浏览器使用 `NEXT_PUBLIC_SUPABASE_URL`，当前开发值是 `http://127.0.0.1:55421`。远程访问者的 127.0.0.1 是他自己的电脑，登录、Realtime 或文件请求会失败。

真正配置命名 Tunnel 时需二选一：使用独立云 Supabase 的 HTTPS API，或为按正式 self-host 配置部署的 Supabase API 网关设置单独 HTTPS 主机名（例如 `data.<域名>`），保留 Auth/REST/Storage/Realtime 的必要路径和 WebSocket；PostgreSQL 与内部 Worker 不直接公开。Supabase 官方区分开发 CLI 栈与正式自托管，当前 CLI 环境只用于本地核验，不直接暴露公网。[Supabase 自托管说明](https://supabase.com/docs/guides/self-hosting)

同时配置应用站点 URL、API 外部 URL、Auth 回调允许列表及 CORS/HTTPS Cookie。此源码的 `app/public-env-script.tsx` 注入运行时公共配置，浏览器优先读取 `window.__PUBLIC_ENV__`；改 URL 并非一律需要重新构建，应按实际配置加载路径重启并验证。本轮构建早于本机配置生成，不能作为上线验收；安全升级和正式上线仍要重新构建并实际验证远程登录、WebSocket 与文件访问。当前尚未执行这些部署改动。

### SSE 与任务恢复

必须使用固定主机名的命名 Tunnel，**Quick Tunnel / trycloudflare 不支持 SSE**，不能用它验证 Agent 流式界面。[Quick Tunnel 限制](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)

源站需返回 `Content-Type: text/event-stream`，否则 Tunnel 可能缓冲响应；现有工作台事件路由已有该响应头、禁缓冲设置与事件游标恢复。上线时验证逐步显示、断线重连和任务继续执行，不能只验证 HTTP 200。[Tunnel 流式说明](https://developers.cloudflare.com/tunnel/troubleshooting/)

## Cloudflare Workers 作为后续选项

Cloudflare Workers 是请求驱动的运行平台，**不等于源码中的常驻 Agent Worker**。可后续把兼容的 Next.js 前端/API 放到 Workers，数据库、登录与存储服务继续独立，常驻 Agent、scheduler、PDF 原生依赖及渠道服务留在容器。

- 当前 Cloudflare 默认推荐 vinext，但它仍为 beta；OpenNext 也提供 Next.js 16 部署路径。此时不为部署先迁移框架。选择适配器后应单独验证 `proxy.ts` 登录鉴权、Server Actions、API 和 SSE。[Cloudflare Next.js 指南](https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/)、[OpenNext 支持范围](https://opennext.js.org/cloudflare)
- Node 兼容层不是完整 Linux Node。源码 PDF 提取使用子进程及原生依赖，不能原样搬入 Workers。兼容行为由固定的适配器版本与 compatibility date 决定；当前 Cloudflare 文档已说明较新日期默认启用 Node 兼容，不机械照抄旧配置。[Node 兼容说明](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
- SSE 保持连接不等于可靠后台执行。HTTP 请求断开后的 `waitUntil()` 延长最多 30 秒，另有 CPU、内存限制；不能据此替代现有持久任务与恢复机制。[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)

## 公网前的独立升级票

来源锁文件固定 Next.js 16.3.5。公网发布前单独处理安全升级与锁文件，选择届时已修复的稳定版本，并验证构建、登录鉴权和关键 API。不要机械固定旧的 16.3.8：它只是此前适配器的最低版本要求，10 月 14 日官方已另发布包含 16.4.1 的安全更新。本文不宣称项目一定触发每个漏洞，也不宣称升级已完成。[Next.js 官方安全公告](https://nextjs.org/blog/nextjs-security-update-october-14-2026)、[OpenNext 发布记录](https://github.com/opennextjs/opennextjs-cloudflare/releases)

## 真正部署前由用户确认

1. 是否继续本机演示，或准备稳定服务器；后者再确认系统、架构、CPU/RAM、Docker 和持续运行条件。
2. Cloudflare 账号/域名已有：还需拟使用的子域名，以及仅本人访问还是公开注册。
3. 数据库、登录与文件存储继续自托管，还是届时创建独立 Supabase 云项目。
4. 后续使用的模型供应商、预算和首批渠道，避免一次启动全部可选服务。

账号登录、密钥和连接凭证在用户本机或部署控制台填写，不在聊天里索取密钥值。信息齐备后再准备具体配置与发布步骤，由用户按约定操作；本轮仅导入和本地运行，不实际部署。

## 2026-10-27 低配与免购机评估

用户要求先评估再购买；目前不推荐直接为完整自托管栈购买 2 核 2 GiB 服务器。一次本机快照：Windows 开发 Web 进程树约 1245 MiB、Worker 约 208 MiB；Docker 中本地 Supabase 六容器约 805 MiB。各数字来自不同系统的单时点统计，工作集可能共享，不能直接当作 Linux 生产环境的精确总量或峰值；未调用真实模型、未验证 2 GiB Linux 容器。数据说明余量不足以承诺完整栈稳定运行。

推荐先保留本机使用：Web、Worker 和独立本地 Supabase 已运行并有验收记录。仅本机操作或屏幕共享不需要云主机。需要远程浏览器时，必须单独完成公网前安全升级、命名 Tunnel 和浏览器可访问的 Supabase API/Realtime 配置；浏览器访问者的 localhost 不是本机，不能只映射 Web 就宣称可用。托管 Supabase Free 可替代本地数据库服务，但未创建、迁移或验证；本地 Supabase 开发栈不能直接发布公网。

若未来仍考虑 2 GiB 云机，应先在隔离 Linux 环境中使用生产镜像、单一 2 GiB 限额和独立测试数据库，验证 Web、Worker 与真实任务峰值；已有 Windows 构建不能直接视作 Linux 镜像，不能用第二个 Worker 竞争现有队列模拟。此项未完成，不保证上述规格足够。
