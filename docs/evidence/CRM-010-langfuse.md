# CRM-010 Langfuse 本机联调记录

日期：2026-10-28。目标是把 CRM 的运行观测和评估结果投递到 Langfuse，并从服务端回读确认。

## 镜像下载前的初始检查

- CRM 已有 Langfuse OTLP 和评分投递适配；本机真实 Langfuse 服务、绑定及 Trace/评分回读尚未完成，不能把代码测试或上游历史记录当作本次联调成功。
- 本机已准备独立 PostgreSQL，Redis 7.2.7、ClickHouse 25.12.5.44 和 SeaweedFS 3.95 官方镜像已下载。Langfuse Web/Worker 官方镜像下载曾遇到 TLS 握手超时与分层重试，后续分层下载有所进展；运行前应再次核对镜像是否完整。
- 本机有其他项目同时运行，Langfuse 与 Mem0、WeKnora 应分阶段运行；不会停用其他项目。上游 SeaweedFS scratch 镜像基于 arm64，当前 x86_64 官方镜像的入口与之不同，需显式匹配 compose 所需的启动命令。
- `scripts/verify-local-agent-services.ts` 已支持显式选择当前本机组织和 Langfuse 实例。针对当前组织运行删除探针时，按预期拒绝 `mem0_delete_original_demo_org_only`，未执行远端操作；Wiki 验证不再推断来源一定为合成资料。
- 现有 `lib/ai/integrations/integrations.test.ts` 定向检查 15 项通过；只说明现有适配代码的相关逻辑通过测试，不证明实际服务接入。

## 当时的后续验收计划

准备完整镜像并启动服务后，绑定本机 CRM 的目标组织；创建真实 Agent 运行和评估，核验 Langfuse 侧相应模型与工具 observations、评分和脱敏约束，记录回读结果。上游自带的历史验收仅作为使用参考。

## 2026-10-28 换网前的再次下载

官方 Docker 仓库多层完成后停滞；官方 GHCR 同版本 Web 镜像有 22/24 层报告完成，剩余两层持续数分钟没有完成或明确错误，已停止拉取。镜像仍不完整，Worker 镜像及真实服务依旧未验收；无法仅凭现象确定网络故障根因。

## 2026-10-28 本机真实联调

- 切换网络后，官方 Langfuse 4.49.0 Web、Worker 镜像下载完整；独立 PostgreSQL、Redis、ClickHouse 和 SeaweedFS 随后分阶段启动。管理员通过 CRM 接口启用 Langfuse，本机项目鉴权与健康检查成功。
- 本机合成客户只读 Run `b73606ef-7604-4001-b3ad-fe4b42642cc8` 为 `completed`，调用 `crm_get_contact`。从 Langfuse Observations API v2 实际回读 6 条 observation（含 2 条模型、2 条工具），各条 input/output 均为空。
- 对该 Run 显式执行确定性评估并投递，Scores API v3 回读 6 个分数，`crm.overall=79`、`crm.answer_quality=0`，评估 verdict 为 `fail`。这是现有评测给出的诊断结果，不代表模型质量结论或集成失败。
- 首次投递因 SeaweedFS 的 `volume.max=2` 导致两个默认卷占满槽位，Langfuse 集合无可写卷、S3 返回 500，CRM 投递超时并按队列退避。保留数据卷将上限调整到 5 后，原队列中的 2 条 spans 与 1 条 scores 事件均最终为 `done`，实际回读已确认；期间用稳定事件 ID 手动重试一次 scores，未新增业务记录。
- `infra/local-agent-services/compose.yml` 已同步上限 5，重启不要恢复旧的 2；5 只适用于本机示例，并非长期容量保证。上游 SeaweedFS Dockerfile 为 arm64，本机 x86_64 使用 `chrislusf/seaweedfs:3.95` 官方镜像和 `/usr/bin/weed -logtostderr=true` 入口构建 `crm-agent-services-seaweedfs:3.95`，可复建配置已保存为 `infra/local-agent-services/SeaweedFS.amd64.Dockerfile`；凭据从生成文件复制到专用 S3 配置卷，未写入镜像。
- 一次运行快照：Langfuse Web 约 873 MiB、Worker 467 MiB、ClickHouse 728 MiB、SeaweedFS 164 MiB、Redis 11 MiB；Windows 剩余约 2.20 GiB。以上是当前负载下的瞬时使用量，非固定要求；用户其他项目继续运行。

- 已用仓库版 x86 Dockerfile 重新构建，镜像内容与本次使用镜像一致；使用仓库 Compose 恢复已有容器和持久卷后，`/usr/bin/weed` 的 `s3.bucket.list` 查到既有 `langfuse` 桶（8 chunks），此前 Run 的 6 条 observation 与 6 个评分仍可回读。启动后 Web 健康检查 200；本次采样 Windows 可用内存约 3.04 GiB。首次启动后 filer 尚未就绪时执行 bucket 命令会连接失败，等待就绪后重试即可。

## 三项服务同时运行复查

Mem0、WeKnora、Langfuse 与 CRM Web/Worker 的健康接口均为 HTTP 200。此前 CRM Worker 曾无日志退出一次，原因未确定；检查任务队列为空后重启，新合成只读 Run `92da806d-532b-4d4a-925f-557a308074b1` 经 Worker 完成并调用 `crm_get_contact`。三套服务同时在线时一次快照 Windows 可用内存约 2.3 GiB，总 CPU 约 31%；这是短时状态而非长期稳定性测试，重编译或多项目并行可能卡顿。
