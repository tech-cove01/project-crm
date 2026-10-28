# CRM-010 Langfuse 本机联调记录

日期：2026-10-28。目标是把 CRM 的运行观测和评估结果投递到 Langfuse，并从服务端回读确认。

## 当前结果

- CRM 已有 Langfuse OTLP 和评分投递适配；本机真实 Langfuse 服务、绑定及 Trace/评分回读尚未完成，不能把代码测试或上游历史记录当作本次联调成功。
- 本机已准备独立 PostgreSQL，Redis 7.2.7、ClickHouse 25.12.5.44 和 SeaweedFS 3.95 官方镜像已下载。Langfuse Web/Worker 官方镜像下载曾遇到 TLS 握手超时与分层重试，后续分层下载有所进展；运行前应再次核对镜像是否完整。
- 本机有其他项目同时运行，Langfuse 与 Mem0、WeKnora 应分阶段运行；不会停用其他项目。上游 SeaweedFS scratch 镜像基于 arm64，当前 x86_64 官方镜像的入口与之不同，需显式匹配 compose 所需的启动命令。
- `scripts/verify-local-agent-services.ts` 已支持显式选择当前本机组织和 Langfuse 实例。针对当前组织运行删除探针时，按预期拒绝 `mem0_delete_original_demo_org_only`，未执行远端操作；Wiki 验证不再推断来源一定为合成资料。
- 现有 `lib/ai/integrations/integrations.test.ts` 定向检查 15 项通过；只说明现有适配代码的相关逻辑通过测试，不证明实际服务接入。

## 后续验收

准备完整镜像并启动服务后，绑定本机 CRM 的目标组织；创建真实 Agent 运行和评估，核验 Langfuse 侧相应模型与工具 observations、评分和脱敏约束，记录回读结果。上游自带的历史验收仅作为使用参考。

## 2026-10-28 再次下载

官方 Docker 仓库多层完成后停滞；官方 GHCR 同版本 Web 镜像有 22/24 层报告完成，剩余两层持续数分钟没有完成或明确错误，已停止拉取。镜像仍不完整，Worker 镜像及真实服务依旧未验收；无法仅凭现象确定网络故障根因。
