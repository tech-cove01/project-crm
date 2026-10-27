# 工作状态

更新：2026-10-27（Asia/Shanghai）。

- 方向：CRM AI-native 项目。
- 当前阶段：本机已验证百炼 Agent、客户记忆、知识索引检索及部分审批动作，后续按实际业务补齐。
- 当前票：CRM-007 本机核心能力验收完成，发现的限制和配置见对应证据；状态随相关提交成功生效。任务与验收见 docs/implementation-plan.md。
- 已有材料：从本仓根目录访问 ../../../develop/，5 个资料包已全部解压并校验；原 zip 移至 ../../../archive/zips/crm。
- 本轮：project-crm 已移到 project/code，与 project-full-stack 同级；共同工作区维护一份 Skill，各仓库按适用范围建立本地联接。
- 旧项目：../../../archive/project-agent 已冻结，GitHub 为私密；project-crm 为独立仓库。目录迁移不改变两个仓库的 Git 历史。
- README：面向面试官介绍客户经营场景、Agent 与后端亮点；本机验证范围和外部依赖已区分。旧 project-agent 本机百炼 Qwen 凭据已通过 CRM 加密入口配置；只读 Agent 流程已完成真实验收。
- 部署选型：阿里云个人服务器运行应用与 Worker，结合托管 Supabase 和 Cloudflare Tunnel；学生券适用范围及费用以实际订单为准。
- 下一步：处理百炼成本未知导致的审批续跑中止，按业务需要选择普通工作台发送提案、中文路由或记忆等二开切片。公网发布前执行 CRM-004 安全升级与正式依赖配置。
- 运行状态：本机 Web http://localhost:3000，Worker http://127.0.0.1:8787/healthz；Supabase API 55421、PG 55422，183 张业务表。真实登录/引导、4 核心页、合成客户创建修改及刷新读取通过，未登录请求被拒绝。
- 健康边界：Worker 200/db=ok/队列空；Web 200/status=degraded，Supabase 正常，Redis/WAHA 未配置。百炼真实模型、客户记忆和原生知识检索已验收；Mem0/WeKnora/Langfuse、客户渠道尚未验收。
- 登录：仅本机 .local/login-credentials.json；应用源码及全部环境/会话材料分别管理，不上传本机凭据。
- 记录规则：保留 spec、tickets、implement、code-review 和小功能 commit 的交付节奏；实际验收后才记录功能完成。
- 外部动作：用户本轮要求先看能否运行及部署缺项；Cloudflare 尚未部署，未修改 DNS 或调用客户渠道。
- 部署偏好：用户已有 Cloudflare/域名，没有服务器，要求先评估 2 GiB 是否足够再购买；当前优先本机运行/屏幕共享。实测内存快照和公网入口前置见 cloudflare-deployment.md；未完成 Linux 2 GiB 模拟或公网部署。

- CRM-007：客户确认记忆、合成 FAQ 百炼向量检索、商机变更审批已验证；金额预算未知和外部服务边界见 docs/evidence/CRM-007-capabilities.md。
- CRM-006：百炼 `qwen3.8-flash` + 工作台 + Worker + `crm_get_contact` 真实完成，详细结果与成本未知边界见 docs/evidence/CRM-006.md。

## 接续入口

- [实施票据](implementation-plan.md)
- [本地运行](local-development.md)
- [能力与二开边界](current-capabilities.md)
- [Cloudflare 部署前置](cloudflare-deployment.md)
- [本机服务验收](evidence/CRM-002b.md)
