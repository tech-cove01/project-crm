# 来源材料

2026-10-27 已解压材料保留在 `D:\桌面\The ALL\agent\develop`，从本仓根目录访问 `../../../develop/`。原 zip 已移至 `../../../archive/zips/crm/`。本仓已导入应用快照，完整路径/哈希映射见 docs/upstream/import-manifest.json；共享 Skill 继续采用本地目录联接。

| 材料目录 | 用途 |
| --- | --- |
| AiNativeCrm-main | 实际 CRM 应用源码；根 README 指向 helsome/AiNativeCrm |
| AI-Native-CRM-Architecture-Wiki | 架构说明与面试 QA |
| ai-native-crm-resume-skill | 简历要点、证据与贡献边界材料 |
| fullstack-desktop-skills | 全栈开发辅助 Skill 集合 |
| pi-coding-agent | Pi Agent 方法与 SDK 参考 |

CRM 源码根 LICENSE 为 MIT，Copyright (c) 2026 Rafael Melgaço。后续导入时应保留原版权和许可及其他第三方声明。当前来源是 zip 快照，未把文档提到的提交自动当作已核实的应用 HEAD。

## CRM-029 的 Ontology Lite 来源

新版 `AiNativeCrm-main.zip` 的 SHA-256 为 `caa9c24421965587810d7130dff117780f8431faeb5644da47fda130a6da15dd`。随包读取 `docs/handoffs/HANDOFF-ontology-lite.md` 及 `lib/ontology/{contract,catalog-v1,versions,resolve-terms,query-plan}.ts`。本仓 `lib/ontology/` 适配了目录结构、固定口径、版本校验、稳定摘要、术语匹配和许可规划，相关文件保留 MIT 版权说明。

目录改为本仓的商机状态、活跃管道与约见活动口径。上游包的其他模板、数据库角色与迁移、Mission 契约、NVIDIA 选项及 44 题评测没有导入。查询范围、Pi Workbench 回执、人工审批和 Worker 延用本仓契约。评测与产品提交的来源分别按本仓证据记录。

package.json 的 private:true 表示禁止 npm 发布，不用于判定 GitHub 可见性。project-crm 当前为公开 GitHub 仓库。资料中的历史指标和验收不能作为本机实测，继承功能不能包装成个人新增。
