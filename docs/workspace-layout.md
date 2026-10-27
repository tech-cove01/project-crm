# 本地共享工作区

2026-10-27：project-crm 从 agent 根目录移至 `D:\桌面\The ALL\agent\project\code\project-crm`，与 project-full-stack 同级。二者独立维护 Git、依赖、业务状态及提交。

共同工作区的 AGENTS.md / WORKSPACE.md 维护跨项目路由。共享 Skill 文件只保留一份，通过各仓库 `.agents/skills/<名称>` 的 Windows 目录联接发现；这些入口记录在本仓 `.git/info/exclude`，不作为应用或远程仓库依赖。

两边共用 workspace-delivery、typescript-pro、sql-pro、playwright-expert。本仓另可使用 vercel-react-best-practices、crm-agent-runtime 与 ai-native-crm-resume-skill；Go/Vue 项目不加载 React/Pi/CRM 简历规则。

原始解压目录位于 agent/develop；5 个 CRM zip 移到 agent/archive/zips/crm，移动前后 SHA-256 相同。旧面试项目仍在 agent/archive/project-agent。原工作区实习 zip 移到 archive/zips/internship，解压资料保留原位。

本轮只调整目录、技能入口和说明，没有导入 CRM 应用或开始业务开发。链接结构和资源可达性需核验；实际可用技能列表由 Codex 重新发现后确认。

收口核验：7 个共享入口格式检查通过；两仓的 4 个通用入口经文件标识核对为相同物理文件，所有联接均被本地 Git 排除。来源/归档路径与 Pi/简历/TS/React 支撑资源可达；变更说明链接与两仓 diff 检查通过，独立只读复核无重要问题。没有为本次目录调整运行应用业务测试。
