# project-crm

AI-native CRM 二开项目，业务围绕客户、商机、会话、任务与 Agent 执行。它与 Go 后端项目、实习经历分别记录。

已导入用户提供的 AiNativeCrm 源码快照，并在本机跑通独立 Supabase、真实登录、核心页面、客户保存与后台 Worker。锁定安装、完整类型检查和生产构建通过。真实模型及外部渠道尚未配置验收；仓库为私密。来源与继承边界见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 本地使用

本机应用：`http://localhost:3000`；登录资料保存在被 Git 忽略的 `.local/login-credentials.json`。首次本地准备已完成，日常启动与真实验收边界见 [Windows 运行指南](docs/local-development.md)。

Supabase 在这里同时提供数据库、认证、存储和实时能力；当前是独立 Docker 开发环境，不需要先注册云项目。Agent 真正调用模型还需在组织 AI 凭据/模型页面完成配置；默认模型显示不代表 Key 已可用。

已继承的能力、尚未闭合的业务和材料中需要纠正的说法见 [能力清单](docs/current-capabilities.md)。Cloudflare 暂未部署，当前用户已有域名、暂无服务器；后续路线见 [部署评估](docs/cloudflare-deployment.md)。

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
