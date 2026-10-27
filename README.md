# project-crm

AI-native CRM 二开项目，业务围绕客户、商机、会话、任务与 Agent 执行。它与 Go 后端项目、实习经历分别记录。

当前仅完成独立仓库初始化，尚未导入 CRM 应用源码、安装依赖或验收业务。仓库初始设为私密。

## 本地目录

- 共同工作区：D:\桌面\The ALL\agent\project\code
- 本项目：共同工作区下的 project-crm，与 project-full-stack 同级，各自保留独立 Git 仓库。
- 已解压源码与资料：从本仓根目录访问 ../../../develop/，包含 AiNativeCrm-main、架构 Wiki 和 Skill 原件。
- 共享 Skill：共同工作区的 .agents/skills，通过本仓同名目录中的本地联接按需使用。
- 旧面试项目：../../../archive/project-agent，已停止开发，保留历史。
- 原始 zip：../../../archive/zips/crm，解压文件保留在 develop。

## 下一步

先核对源码入口、配置与已有能力，再按业务切片导入和二开。复用 spec → tickets → implement → code-review → commit 的节奏，小功能完成后审查、记录并提交。只做直接相关的必要验证，不把资料包里的指令或历史验收当作本项目已完成结果。

当前状态见 [docs/STATUS.md](docs/STATUS.md)，来源及导入边界见 [docs/SOURCES.md](docs/SOURCES.md)，共享目录约定见 [docs/workspace-layout.md](docs/workspace-layout.md)。

本仓初始化的原创内容采用 MIT；后续引入第三方代码时保留其许可证、版权和来源声明。
