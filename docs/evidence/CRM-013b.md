# CRM-013b：受管启动、停止与退出诊断

日期：2026-10-28（Asia/Shanghai）。依赖 CRM-013a（7211979）；父票的业务恢复验收仍由 CRM-013c 收口。

新增 `node scripts/local-crm.mjs start|status|stop`（或 `npm run local:start|local:status|local:stop`）。只管理本仓本次创建的 Web、Worker 和专用集成定时器；先查端口和队列，再取得/使用专属会话锁。未知占用、陈旧锁和业务 pending/running 都会拒绝接管；集成 pending 可消费，processing 非零先拒绝启动。没有 Docker、初始化或渠道发送命令。

三进程共用本机配置与生成绑定。Web 使用已核对的锁定 Next 开发服务器入口，避免 Windows CLI 额外常驻子树；Worker 复用原启动逻辑，只有可选 HEALTH_HOST，容器默认行为不变，本机受管模式绑定 127.0.0.1。自动付费 flywheel 关闭，未另启全历史 cron。

监督器只持有本次 fork 的 ChildProcess 句柄，通过私有 session/token 请求和 IPC 控制，不依据磁盘旧 PID 杀进程。停止顺序为 drain → Worker → Web，共用一个总截止；drain 已开始的 HTTP 等待实际回执，不能把客户端取消误判为服务端完成。配置损坏时 stop 仍可仅凭本次归属停止。IPC 断连会触发子服务自身关闭；超时强制结束、异常退出与正常退出分别记录，不自动重启。

每次会话保留独立日志、时间、PID、退出码/signal 与事件；日志按完整行对配置凭据脱敏，token 不进入公开状态或事件。stdout/管道未确认关闭、日志写入失败等均有明确记录。

## 直接验证与独立审查

真实派生子进程和本机 HTTP 夹具检查覆盖队列/端口/锁拒绝、令牌归属、无关进程保留、IPC 自然退出、实际停止顺序、异常 exit 7 后清理、共享截止强停、监督器断连、Worker 消费循环未就绪、损坏配置仍能停止，以及 drain 的等待/处理中停止与数值回执。初轮及修复后的受影响回归通过；这些是进程/协议验证，不替代真实模型业务验收。

完整类型检查、限定 ESLint、语法和 diff 检查通过。独立审查发现并关闭消费循环就绪不足、并行停止依赖、in-flight drain 过早退出及坏配置阻止 stop；最终无剩余重要代码发现。

主 agent 已实际由离线状态成功启动 Next、Worker 和定时器；session 为 `868d7bcd-b983-4eb5-9c83-1813f28afb72`，Worker 健康及消费循环就绪。认证、只读 Run、真实正常停止和异常退出继续在 CRM-013c 验收，不能提前勾选父票。旧的无日志 Worker 退出原因仍未知。提交可通过 `git log --grep='feat(CRM-013b)'` 查询。
