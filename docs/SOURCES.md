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

package.json 的 private:true 表示禁止 npm 发布，不用于判定 GitHub 可见性。当前 project-crm 私密是新仓库初始化选择。资料中的历史指标和验收不能作为本机实测，继承功能不能包装成个人新增。
