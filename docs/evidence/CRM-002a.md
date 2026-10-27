# CRM-002a：依赖、类型与生产构建

日期：2026-10-27。验证对象为 CRM-001 导入基线，尚未替换应用依赖版本。

- 本机 Node 24.15.0，符合来源要求 Node >=22；项目通过 packageManager 固定 pnpm 9.15.9，Corepack 缓存在项目 .local/corepack，未改全局工具。
- `corepack pnpm install --frozen-lockfile --store-dir .local/pnpm-store`：成功，安装 1,016 个包，锁文件未变化；下载时两次网络重置由包管理器重试恢复。
- `corepack pnpm typecheck`：exit 0，覆盖上游定义的完整 tsconfig.typecheck.json；没有为此运行全部历史单测。
- `corepack pnpm build`：exit 0，Next.js 16.3.5 / Turbopack 编译、应用类型检查、静态页面及路由生成完成。编译阶段约 88 秒，不作为性能基准。
- 构建时关闭 Sentry 和 Next 遥测。未配置数据库时，上游 build-phase 允许其内部占位并产生品牌配置读取失败的降级提示；这只证明可构建，不代表认证/数据库实际可用。
- 继承 Sentry 导入接口弃用提示、缺模型/部分可选配置的提示，均保留在 .local/build-first.log；没有把这些提示写成真实 AI 已可用。

记录位于 .local/typecheck-first.log、.local/build-first.log。此票不包含 Supabase、用户登录、Worker、真实模型或外部渠道验收。生产公网版本另需处理已记录的安全升级事项。

独立只读审查核对安装版本、原 package/锁无变化、类型检查及构建完整日志，结论通过。未重复执行已通过检查。完成状态随本票提交成功生效。
