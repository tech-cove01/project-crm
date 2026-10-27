# 第三方来源与继承范围

## AiNativeCrm 源码快照

- 来源：用户提供并解压的 AiNativeCrm-main.zip；原 README 指向 https://github.com/helsome/AiNativeCrm。
- zip SHA-256：`29eeb8c9a2fe5c4d064ab17fbee902cd9ab4583e54e0e4576a69a08b555a81f3`。
- 该 zip 没有 Git 元数据，尚未验证其精确 Git HEAD。架构 Wiki 和简历 Skill 提到的 `679e09e8` 仅是文档基线，不自动归为源码精确版本。
- 许可证：MIT，Copyright (c) 2026 Rafael Melgaço。根 LICENSE 保留此版权及本仓初始化内容版权，原许可在 docs/upstream/LICENSE。
- 逐文件源路径、导入路径、大小与 SHA-256：docs/upstream/import-manifest.json；共 6,039 个文件，导入后逐文件哈希核对。

## 保留与重映射

应用、数据库基线/迁移、依赖锁、部署文件、示例、测试及历史证据保留。根 README、AGENTS、CLAUDE、LICENSE 和忽略规则的原件保存于 docs/upstream；根忽略规则合并，本仓入口和 Git 历史保留。

来源包的 .agents/.claude/.codex/.cursor 配置存为 docs/upstream/assistant-config 下的参考快照，不覆盖本仓共享 Skill。来源 .github 配置存为 docs/upstream/github-config，不激活其发布、第三方账号或 CI 操作。

所有上述业务实现和历史报告都是继承内容。本次 baseline 导入不能作为本人独立实现每项功能的证据；后续新增或修复按本仓票据和提交记录。

## 资料与依赖

架构 Wiki、简历 Skill 和开发 Skill 原件仍位于本机 develop；它们没有作为个人成果或全局配置上传。依赖按其各自许可证使用；导入时没有批量升级依赖或移除其声明。
