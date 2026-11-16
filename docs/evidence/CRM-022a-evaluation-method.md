# CRM-022a 评测环境和冻结方法

2026-11-16。评测产品源码以 `60f2ba577f9f113eadba6fa89d0c6d308dd04613` 的运行文件为基线，文档和评测脚本后续按切片提交。使用与本机 CRM 不同的 Supabase 项目 `project-crm-eval-1115`，Web 仅监听 3415、Worker 仅监听 8795。独立 PostgreSQL 本轮实例标识 `7708392892596248609`，组织 slug 为 `crm022-synthetic-eval`。初始化前验证是空库，应用 `supabase/baseline.sql`，完成后单独验证两个随机合成账号的真实 Auth、组织角色与工作台读取权限。旧环境只选定已有合成 Wiki 的授权元数据及既有已校验模型凭据，模型密钥以加密列写入测试库，请求时由产品在进程内解密。CRM 业务数据使用本轮明确创建的合成数据。

评测 Web 与 Worker 使用相同测试配置，队列并发 1。模型选 `dashscope/qwen3.8-flash`，开发环境的非 Mission 额度使用现有有限步骤和 tokens 规则，组织和厂商计费状态与本批账单不同，费用未知。两个测试账号分别发起和明确作出决策。测试进程关闭错误外部遥测。模型请求使用已配置的 DashScope，Wiki、记忆和轨迹走本机相应服务。凭证文件、原始结果和模型内容留在 Git 忽略目录。

## 重建和复查

1. 复制项目 Supabase 配置与 Auth 模板至 `.local/crm022/stack/supabase`。使用专用项目名 `project-crm-eval-1115`，将 API/数据库/影子端口改为 `55521/55522/55520`，应用回调改为 `http://localhost:3415`。本机 Docker 默认地址池已满，本次创建独立的 `supabase_network_project-crm-eval-1115` 及未占用的 `10.235.116.0/24` 子网。保留其他 Docker 网络和卷。
2. 使用本机锁定的 Supabase CLI 启动该工作目录，按 [本机数据库初始化约定](../local-development.md#首次数据库初始化的边界)在确认空的 55522 库应用扩展及 baseline。将 `supabase status -o env` 的输出写入 `.local/crm022/stack/status.private.env`，然后在仓库根执行 `node scripts/eval/crm022-env.mjs initialize`。初始化器限制评测库端口、组织数量和旧环境读取范围。
3. 评测程序读取 `.local/crm022/runtime.env`。Web launcher 先在父进程读取文件，再用进程环境启动 Next；初次直接 `node --env-file … next dev` 被 Next 子进程转入 `NODE_OPTIONS` 拒绝。Worker 从同一环境启动 `workers/agent-worker/main.ts`，记录独占 PID、端口和健康证据。Langfuse 投递器由恢复试验单独启停，使用同一个测试库。
4. 按各切片私有计划先做校准，核对提交、脚本、夹具和预算，再用已冻结任务执行正式对照。模型启动、提交与决策的意图单独落盘，遇到超时先只读以原任务和已有关联对账，不重复创建。具体范围见 [CRM-022 规格](../CRM-022-spec.md)。

初次 Supabase 缺 Auth 模板，补齐模板后发现默认网络地址池用尽。显式分配子网后栈健康，产品基线应用成功。第一次合成组织插入缺 `legal_name`，事务回滚后补齐字段再初始化。环境错误未调用模型，单独与产品效果区分。
