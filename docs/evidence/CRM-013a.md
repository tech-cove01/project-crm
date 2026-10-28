# CRM-013a：本机只读状态与一致配置

日期：2026-10-28（Asia/Shanghai）。本票是 CRM-013 的状态切片，父票尚未完成。

新增 `node scripts/local-crm-status.mjs`，只读取本机配置、健康接口及数据库计数。共同配置限定 development、CRM 专属 3000/55421/55422 入口，拒绝远端/其他数据库；既有生成文件中的组织绑定为同一份权威输入，不输出凭据或原始驱动异常，也不修改配置文件。后续受管进程使用本机 Worker 监听地址，并关闭自动付费 flywheel 定时器。

状态区分 Web 健康的 degraded、Worker 的数据库及 event-log 消费循环就绪、业务与集成队列；查询失败为 unknown，不显示为零。集成只检查公开端点可达，明确 `authenticatedAccessVerified=false`；Mem0 的 `/docs` 可达不代表鉴权或模型能力已验收。

实际初次只读检查：Web/Worker/三项集成未启动，CRM 数据库在线；job_queue pending/running/dead 为 0，集成 pending/processing/dead 为 0、done 为 13。私有快照在 `.local/crm013-initial-status.json`。随后恢复集成依赖的操作归 CRM-013c，不能把此初始快照当实时监控。

直接相关的 6 项 Node 检查通过，覆盖外部地址拒绝、一致绑定及环境不变、严格绑定字段、公开输出白名单，以及数据库 pool/client/query/close 故障脱敏；后者使用隔离事件夹具，不声称真实数据库故障演练。Node 语法、定向格式及 diff 检查通过。

独立审查发现并关闭绑定类型与应用严格 schema 不一致、pg 异步 error 可绕过脱敏两项问题；最终复核无剩余重要发现。没有模型调用、业务写入、数据库初始化或卷操作。通过 `git log --grep='feat(CRM-013a)'` 查询提交。
