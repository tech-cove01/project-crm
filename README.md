# project-crm

AI-native CRM 二开项目，业务围绕客户、商机、会话、任务与 Agent 执行。它与 Go 后端项目、实习经历分别记录。

已导入用户提供的 AiNativeCrm 源码快照，正在安装依赖并核验本地运行。尚未完成数据库、登录或真实模型验收；仓库为私密。来源与继承边界见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 本地目录

- 共同工作区：D:\桌面\The ALL\agent\project\code
- 本项目：共同工作区下的 project-crm，与 project-full-stack 同级，各自保留独立 Git 仓库。
- 已解压源码与资料：从本仓根目录访问 ../../../develop/，包含 AiNativeCrm-main、架构 Wiki 和 Skill 原件。
- 共享 Skill：共同工作区的 .agents/skills，通过本仓同名目录中的本地联接按需使用。
- 旧面试项目：../../../archive/project-agent，已停止开发，保留历史。
- 原始 zip：../../../archive/zips/crm，解压文件保留在 develop。

## 下一步

源码基线作为一个导入提交，后续修复或新增功能分别提交。按 [实施票据](docs/implementation-plan.md) 推进 spec → tickets → implement → code-review → commit，只做直接相关的必要验证，不把资料包历史验收当作本机结果。

源应用说明保留于 [上游 README](docs/upstream/README.md)，技术文档入口为 [docs/index.md](docs/index.md)。本机实际进度以本仓 STATUS 为准；原始文档可能描述历史环境或不同版本。

当前状态见 [docs/STATUS.md](docs/STATUS.md)，来源及导入边界见 [docs/SOURCES.md](docs/SOURCES.md)，共享目录约定见 [docs/workspace-layout.md](docs/workspace-layout.md)。

本仓初始化的原创内容采用 MIT；后续引入第三方代码时保留其许可证、版权和来源声明。
