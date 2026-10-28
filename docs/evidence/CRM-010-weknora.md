# CRM-010：WeKnora 本机接入记录

2026-10-28（Asia/Shanghai）。

- 目标：使用独立本机 WeKnora v0.8.2 和既有百炼模型，导入合成产品资料，连接 CRM 的组织知识来源，并验证带来源的检索及 Agent 使用。
- 前置：独立 Agent 服务 PostgreSQL 已初始化；WeKnora 管理账号可在本机首次启动时创建，不需要注册外部账号。脚本现支持显式指定现有 CRM 组织和百炼凭据，保留原有模型默认值。
- 安全预检：缺少现有 Wiki 合成资料且未传显式生成参数时，初始化脚本按预期在调用远端 API 之前拒绝。
- 本次未完成：Docker Hub 固定版本镜像 `wechatopenai/weknora-app:v0.8.2` 部分层下载后长时间停滞；直接访问官方 `registry-1.docker.io` 返回 EOF。本机 Docker 配置了多个镜像源和代理，尚不能据此确定具体故障原因。没有关闭 TLS 校验或改写用户网络配置。
- 当前没有启动 WeKnora、创建其本机账号、上传合成文档或产生 Wiki；脚本百炼分支尚未在真实 WeKnora 中验证。历史联调记录不是本次结果。
- 恢复：检查 Docker Desktop 的网络、代理或镜像源，能正常访问 Docker Hub 后拉取 `wechatopenai/weknora-app:v0.8.2`；确认镜像可用后依照 `infra/local-agent-services/README.md` 完成首次本地初始化、连接及真实检索验收。上游 Wiki 生成调用次数没有可靠硬上限。

## 2026-10-28 再次下载

官方 Docker Hub 下载完成多数镜像层，约 406 MB 的层持续重试；按官方镜像摘要核对的加速源也未完成。宿主机从官方源分块下载时完成一个 16 MiB 分块，其余连接反复失败，已停止重试，镜像未导入。仅本机的 `.local/pull-weknora-official.py` 和 `.local/weknora-image/` 保留续传材料，网络恢复后可在仓库根目录运行 `python -u .local/pull-weknora-official.py`；完成下载、校验与导入后仍需启动并验收服务。未修改 Docker 全局配置或关闭证书校验。
