# 工作状态

更新：2026-10-28（Asia/Shanghai）。

- 方向：CRM AI-native 项目。
- 当前阶段：本机已验证百炼 Agent、客户记忆、知识索引检索及部分审批动作，后续按实际业务补齐。
- 当前票：CRM-010 外部服务接入中；Mem0 确认事实投影、自动队列投递和 Agent 经工具触发检索已实测，WeKnora 与 Langfuse 等待镜像及真实联调。工作流和验收见 [实施票据](implementation-plan.md)。
- 已有材料：从本仓根目录访问 ../../../develop/，5 个资料包已全部解压并校验；原 zip 移至 ../../../archive/zips/crm。
- 本轮：project-crm 已移到 project/code，与 project-full-stack 同级；共同工作区维护一份 Skill，各仓库按适用范围建立本地联接。
- 旧项目：../../../archive/project-agent 已冻结，GitHub 为私密；project-crm 为独立仓库。目录迁移不改变两个仓库的 Git 历史。
- README：面向面试官介绍客户经营场景、Agent 与后端亮点；本机验证范围和外部依赖已区分。旧 project-agent 本机百炼 Qwen 凭据已通过 CRM 加密入口配置；只读 Agent 流程已完成真实验收。
- 部署选型：先使用本机运行和屏幕共享；暂不购买服务器。需要远程演示时再处理入口、数据库访问和公网前置。
- 下一步按 [票据](implementation-plan.md) 选择工作台回复链路、外部服务或组织记忆等业务。公网发布前执行 CRM-004 安全升级与正式依赖配置。
- 运行状态：2026-10-27 22:06 本机检查 Web HTTP 200、Worker 状态和数据库正常，队列 pending/running 均为 0；Web http://localhost:3000，Worker http://127.0.0.1:8787/healthz，Supabase API 55421、PG 55422，183 张业务表。真实登录/引导、4 核心页、合成客户创建修改及刷新读取通过，未登录请求被拒绝。
- 健康边界：此前 Web 健康检查为 degraded，Supabase 正常、Redis/WAHA 未配置；该状态为本机快照，不代表所有服务可用。百炼真实模型、客户记忆和原生知识检索已验收；WeKnora/Langfuse、客户渠道尚未验收；Mem0 本轮结果见下。
- 登录：仅本机 .local/login-credentials.json；应用源码及全部环境/会话材料分别管理，不上传本机凭据。
- 记录规则：保留 spec、tickets、implement、code-review 和小功能 commit 的交付节奏；实际验收后才记录功能完成。
- 外部动作：用户本轮要求先看能否运行及部署缺项；Cloudflare 尚未部署，未修改 DNS 或调用客户渠道。
- 部署偏好：用户已有 Cloudflare/域名，没有服务器，要求先评估 2 GiB 是否足够再购买；当前优先本机运行/屏幕共享。实测内存快照和公网入口前置见 cloudflare-deployment.md；未完成 Linux 2 GiB 模拟或公网部署。

- CRM-008：本机演示模式下合成商机批准、落库和 Agent 续跑已 completed；单次金额预算关闭及其他范围见 docs/evidence/CRM-008.md。
- CRM-007：客户确认记忆、合成 FAQ 百炼向量检索、商机变更审批及语义 Judge 已验证；金额预算未知和外部服务边界见 docs/evidence/CRM-007-capabilities.md。
- CRM-006：百炼 `qwen3.8-flash` + 工作台 + Worker + `crm_get_contact` 真实完成，详细结果与成本未知边界见 docs/evidence/CRM-006.md。

- CRM-010 Mem0：本机服务写入、语义检索、删除和 CRM 确认事实自动同步已验证；新 Agent Run completed 并经客户工具触发 Mem0 检索，事件脱敏无法确认具体引用哪条重复记忆。专用队列定时器须单独运行。详见 [Mem0 验收](evidence/CRM-010-mem0.md)。
- CRM-010 WeKnora：本机适配百炼的初始化脚本已准备，镜像下载被网络阻塞，服务和知识检索未验收。详见 [WeKnora 记录](evidence/CRM-010-weknora.md)。
- CRM-010 Langfuse：依赖镜像准备中，真实服务及 Trace/评分回读未验收；现有适配代码的定向检查通过。详见 [Langfuse 记录](evidence/CRM-010-langfuse.md)。

- 2026-10-28 再次下载：WeKnora 大镜像层连接失败，官方源本地续传材料保留；Langfuse Web 官方 GHCR 下载 22/24 层后未完成，详见对应证据。两项真实联调仍待网络恢复。
- 2026-10-28 本机容量快照：Windows 可见内存约 31.6 GiB、可用约 5–6 GiB，系统正在使用内存压缩；CPU 与其他项目并行负载有波动。Docker 数据目录在 D 盘，当时余量约 213 GiB。当前主要使用 CPU/系统内存及远端百炼，GPU 不承担模型推理；三套集成同时运行的负载尚未实测。建议按服务分阶段启动并观察。

## 工作流接续入口

- [规格、票据、审查和提交记录](implementation-plan.md)
- [CRM-006 百炼 Agent 验收](evidence/CRM-006.md)
- [CRM-008 审批续跑验收](evidence/CRM-008.md)
- [CRM-007 核心能力验收](evidence/CRM-007-capabilities.md)
- [CRM-007 审批验收](evidence/CRM-007-approval.md)

## 其他资料

- [本地运行](local-development.md)
- [能力与二开边界](current-capabilities.md)
- [Cloudflare 部署前置](cloudflare-deployment.md)
- [本机服务验收](evidence/CRM-002b.md)
