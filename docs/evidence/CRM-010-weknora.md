# CRM-010：WeKnora 本机接入记录

2026-10-28（Asia/Shanghai）。

## 初次下载期间的记录

- 目标：使用独立本机 WeKnora v0.8.2 和既有百炼模型，导入合成产品资料，连接 CRM 的组织知识来源，并验证带来源的检索及 Agent 使用。
- 前置：独立 Agent 服务 PostgreSQL 已初始化；WeKnora 管理账号可在本机首次启动时创建，不需要注册外部账号。脚本现支持显式指定现有 CRM 组织和百炼凭据，保留原有模型默认值。
- 安全预检：缺少现有 Wiki 合成资料且未传显式生成参数时，初始化脚本按预期在调用远端 API 之前拒绝。
- 本次未完成：Docker Hub 固定版本镜像 `wechatopenai/weknora-app:v0.8.2` 部分层下载后长时间停滞；直接访问官方 `registry-1.docker.io` 返回 EOF。本机 Docker 配置了多个镜像源和代理，尚不能据此确定具体故障原因。没有关闭 TLS 校验或改写用户网络配置。
- 当时尚未启动 WeKnora、创建其本机账号、上传合成文档或产生 Wiki；脚本百炼分支尚未在真实 WeKnora 中验证。历史联调记录不是本次结果。
- 当时的恢复计划：检查 Docker Desktop 的网络、代理或镜像源，能正常访问 Docker Hub 后拉取 `wechatopenai/weknora-app:v0.8.2`；确认镜像可用后依照 `infra/local-agent-services/README.md` 完成首次本地初始化、连接及真实检索验收。上游 Wiki 生成调用次数没有可靠硬上限。

## 2026-10-28 再次下载

官方 Docker Hub 下载完成多数镜像层，约 406 MB 的层持续重试；按官方镜像摘要核对的加速源也未完成。宿主机从官方源分块下载时完成一个 16 MiB 分块，其余连接反复失败，已停止重试，镜像未导入。仅本机的 `.local/pull-weknora-official.py` 和 `.local/weknora-image/` 保留续传材料，网络恢复后可在仓库根目录运行 `python -u .local/pull-weknora-official.py`；完成下载、校验与导入后仍需启动并验收服务。未修改 Docker 全局配置或关闭证书校验。

## 2026-10-28：换网络后的真实接入

- 从 Docker Hub 官方认证 API 获取 v0.8.2 amd64 manifest，逐层下载并验证压缩内容 SHA-256 和解压 diff ID，导入 `wechatopenai/weknora-app:v0.8.2`；本次本地 WeKnora 健康检查 HTTP 200。镜像下载和生成的本地账号、凭据仅保存在本机。
- 本机代理 DNS 返回 198.18.x.x，WeKnora 最初按 SSRF 规则拒绝百炼。服务启动配置仅对官方 `dashscope.aliyuncs.com` 增加精确域名白名单，保留 TLS 与其他 SSRF 规则；管理员账号创建后已关闭临时注册。本地复现与限制见 [WeKnora 本机接入](../weknora-local-development.md)。
- 使用当前 CRM 组织的百炼 `qwen3.8-flash` 建立只读知识库，导入合成产品文档 `73e7f44e-17c0-4b7c-91f3-fb24ea54311b`，真实处理状态 completed，生成 5 个页面；CRM 经管理员 API 连接知识源 `54aabec4-e07d-4548-af41-684136aca033`。
- 真实 CRM 适配器用“产品”查询返回 `complete`、3 条 WeKnora Wiki 证据及其来源与内容哈希；只读 Agent Run `ab0accf1-f4c1-44b2-ac41-6d46cc466917` completed，经 `crm_search_knowledge` 引用 3 个 WeKnora 页面（同时返回 1 个已有原生 RAG 片段），未修改业务数据或发送客户消息。
- 首次更长的自然语言问题 Run `87f837ed-6119-472f-ae5a-c546f681f477` 为 `partial/missing_material`、`wiki_status=empty`，缩短为“产品”后才命中。当前只证明一个合成样本的短查询可用，不代表长句和真实业务召回效果。
