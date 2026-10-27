# 工作状态

更新：2026-10-27（Asia/Shanghai）。

- 方向：CRM AI-native 项目。
- 当前阶段：doing，导入源码并核验首次本地运行。
- 当前票：CRM-002b。CRM-001 已提交 06fac28；CRM-002a 的安装、完整类型检查和生产构建通过，完成随对应提交成功生效。任务与验收见 docs/implementation-plan.md。
- 已有材料：从本仓根目录访问 ../../../develop/，5 个资料包已全部解压并校验；原 zip 移至 ../../../archive/zips/crm。
- 本轮：project-crm 已移到 project/code，与 project-full-stack 同级；共同工作区维护一份 Skill，各仓库按适用范围建立本地联接。
- 旧项目：../../../archive/project-agent 已冻结，GitHub 为私密；project-crm 也为独立私密仓库。目录迁移不改变两个仓库的 Git 历史。
- 下一步：完成独立 Supabase 的 CRM 基线初始化、本机配置、登录与 Web/Worker 连通验收；并行记录能力及 Cloudflare 部署边界。
- 运行状态：源码已导入并核对文件哈希；pnpm 9.15.9 冻结锁安装 1,016 个依赖、完整类型检查和生产构建均通过。正在准备专属本地 Supabase；尚未完成登录、Worker 或真实模型验收。
- 记录规则：保留 spec、tickets、implement、code-review 和小功能 commit 的交付节奏；实际验收后才记录功能完成。
- 外部动作：用户本轮要求先看能否运行及部署缺项；Cloudflare 尚未部署，未修改 DNS 或调用客户渠道。
