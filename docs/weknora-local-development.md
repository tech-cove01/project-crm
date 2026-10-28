# WeKnora 本机接入

2026-10-28 本机接入的是固定版本 WeKnora v0.8.2、独立 Agent 服务数据库和已有百炼凭据。合成资料的真实验收见 [CRM-010 WeKnora](evidence/CRM-010-weknora.md)。

当前机器的代理 DNS 将 `dashscope.aliyuncs.com` 解析到 `198.18.0.0/15`，被 WeKnora 的 SSRF 校验拒绝。仅当遇到同样问题时，启动时显式叠加本仓提供的本地覆盖文件：

```powershell
docker compose --env-file infra/local-agent-services/.env.generated -f infra/local-agent-services/compose.yml -f infra/local-agent-services/weknora-dashscope.override.yml --profile wiki up -d weknora
```

覆盖文件仅将 `dashscope.aliyuncs.com` 加入 WeKnora 服务的 SSRF 域名白名单。它不会关闭一般 SSRF 防护或 TLS 校验；WeKnora v0.8.2 的模型 HTTP 客户端对重定向目标继续校验，并拒绝跨源重放 POST。这个放行仅用于本机的既有代理 DNS；不需要时移除 `-f ...weknora-dashscope.override.yml` 并重建本服务。不要照搬至公网部署，需先核查真实出站网络和访问策略。

首次创建本地账号需要临时将 `WEKNORA_DISABLE_REGISTRATION=false` 加入启动命令的环境；账号创建后应移除该设置并重建服务，恢复关闭注册。私有配置 `.env.generated`、CRM 绑定、数据库和数据卷分别保留，不能上传仓库。初始化和绑定方式见 [本地服务说明](../infra/local-agent-services/README.md)。在当前 CRM 本机环境应使用该说明中现有百炼配置与组织/凭据 ID，并由 Web 和 Worker 加载相同的集成绑定。公网发布不属于本次验收。

Wiki 查询对具体关键词敏感：本次短查询命中并由 Agent 引用，长句查询返回空结果；后续需要用真实资料评估召回及查询改写。
