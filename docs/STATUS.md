# 工作状态

更新：2026-10-27（Asia/Shanghai）。

- 方向：CRM AI-native 项目。
- 当前阶段：本轮导入和基础运行核验完成，待配置真实模型及后续二开。
- 当前票：无执行中票；CRM-001、CRM-002a、CRM-003 已提交，CRM-002b 完成状态随本票提交成功生效。任务与验收见 docs/implementation-plan.md。
- 已有材料：从本仓根目录访问 ../../../develop/，5 个资料包已全部解压并校验；原 zip 移至 ../../../archive/zips/crm。
- 本轮：project-crm 已移到 project/code，与 project-full-stack 同级；共同工作区维护一份 Skill，各仓库按适用范围建立本地联接。
- 旧项目：../../../archive/project-agent 已冻结，GitHub 为私密；project-crm 也为独立私密仓库。目录迁移不改变两个仓库的 Git 历史。
- 下一步：配置所选模型提供商并单独验证真实 Agent；按业务需要选择普通工作台发送提案、中文路由或记忆等二开切片。公网发布前执行 CRM-004 安全升级与正式依赖配置。
- 运行状态：本机 Web http://localhost:3000，Worker http://127.0.0.1:8787/healthz；Supabase API 55421、PG 55422，183 张业务表。真实登录/引导、4 核心页、合成客户创建修改及刷新读取通过，未登录请求被拒绝。
- 健康边界：Worker 200/db=ok/队列空；Web 200/status=degraded，Supabase 正常，Redis/WAHA 未配置。真实模型、Mem0/WeKnora/Langfuse、客户渠道均未在本轮调用或验收。
- 登录：仅本机 .local/login-credentials.json；应用源码及全部环境/会话材料分别管理，不上传本机凭据。
- 记录规则：保留 spec、tickets、implement、code-review 和小功能 commit 的交付节奏；实际验收后才记录功能完成。
- 外部动作：用户本轮要求先看能否运行及部署缺项；Cloudflare 尚未部署，未修改 DNS 或调用客户渠道。
- 部署偏好：用户已有 Cloudflare/域名，没有服务器；当前先本地运行，后续命名 Tunnel 可用于本机演示，稳定在线方案另行确认。

## 接续入口

- [实施票据](implementation-plan.md)
- [本地运行](local-development.md)
- [能力与二开边界](current-capabilities.md)
- [Cloudflare 部署前置](cloudflare-deployment.md)
- [本机服务验收](evidence/CRM-002b.md)
