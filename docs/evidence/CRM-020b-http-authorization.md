# CRM-020b：真实 HTTP 授权负例

日期：2026-11-01。补充 [CRM-020](../CRM-020-spec.md) 的低权限批准和 inspect 模式门禁；[精确对象负例](CRM-020b1-target-scope.md) 与 [恢复分支](CRM-020b-recovery.md) 分别保留，不把不同验证方式混为同一种保证。

## 实际请求与结果

| 用例 | 会话与固定目标 | 实际响应及状态 |
| --- | --- | --- |
| 无批准权限 | 新建本机合成用户，仅在演示组织取得人类 `agent` 角色。对本批 B02 Run `4ed2e859-cd75-4917-8132-efe2fc616152`、待确认提案 `f6e89ba7-22d5-4106-ba2c-8555a51fbf36` 唯一一次 POST approve。 | HTTP 403 / `forbidden_role`。该请求后及后续对账时，原 Run 仍 `awaiting_confirmation`、提案仍 `pending`，二者更新时间和结果摘要未变。 |
| inspect 不可批准写入 | owner 会话只对新控制 Run `136645c5-9293-40b3-8d42-3a62cf41f304`、提案 `b501c7a6-6645-46f9-9d4f-e2936545ac4a` 唯一一次 POST approve。 | HTTP 409 / `inspect_read_only`。控制行保持原等待/待确认状态，job 和 Run 事件均为 0，没有进入执行或续跑。 |

inspect 控制行由 SQL 明确建立为 `inspect/awaiting_confirmation`，并附带一个合法阶段变更的 pending 提案；没有创建 job 或运行模型。这是专门验证服务端在异常控制状态下仍拒绝批准的负例，不代表模型或正常 inspect 工作流会生成写入提案。

两个请求使用隔离的真实 Supabase 密码会话，并采用产品相同的 SSR cookie 格式。`active_org` 只选择本演示组织，仍由产品与 JWT 用户的真实 memberships 核对；两个会话均通过真实 `/api/v1/auth/interface` HTTP 200 返回确认组织。本次是认证 API 验证，不是浏览器 UI 点击或真人现场审核。

## 原仪器失败与后续对账

两个预期响应已保存后，原脚本在额外只读控制行校验处异常中断，**原脚本整体 `passed=false` 保留**。静态定位发现，该校验 SQL 将同一参数用于 text 与 UUID 比较；没有重跑任何批准请求，也没有覆盖原失败报告。

另外执行一次独立的现有状态投影和精确收尾，使用明确 UUID 类型的控制行查询。其对账确认：

- 原报告的请求前后快照已保存且逐值相同，后续新投影仍与请求前快照一致。主商机阶段、更新时间及描述哈希未变，阶段活动计数为 0；该组织 `llm_calls` 为 45→45。
- B02 的等待状态、pending 提案、更新时间及结果摘要均未改变。对账完成后，根 agent 才可以继续其原定拒绝场景；本证据不声称 B02 此后一直停留在 pending。
- 控制 inspect 行在 409 后没有 job 或 Run 事件。确认精确 ID、actor、marker、scope 和状态后，仅将这个新 Run 与新提案标为 `cancelled`，原行保留。
- 仅撤销本次新用户 `20131180-2fcc-43d5-b8dc-d91fd8e1641c` 在演示组织的 membership；其角色仍为 `agent`，`revoked_at` 已设置。没有改变既有 owner 的角色或 membership。

独立对账报告为 `reconciliationPassed=true`、新 HTTP 0，明确记录 `originalOverallPassed=false`。它补齐状态核对与测试数据收尾，不把原脚本改写成整体成功。

## 请求、版本和证据边界

一次执行共创建新本机 auth 用户 1 次、密码登录 2 次、组织上下文 GET 2 次、低权限批准 POST 1 次、owner inspect 批准 POST 1 次。禁止重定向和网络重试，每个决定请求之前保存独占 intent 和安全回执。新用户经 admin createUser 且 `email_confirm=true` 创建，不调用邀请或发信入口；没有客户渠道请求、模型或 Judge。owner 从未对历史提案或 B02 发送批准请求。

| 本机私有文件 | SHA-256 |
| --- | --- |
| `.local/crm020/authorization-http-plan-dabf9556-69a3-4d82-a354-fee82f85d212-v2.json` | `aee986e2730ebd6094feb07b8df5703be0efdd0a0e2b9b4eb8c8f2c156835aa2` |
| `.local/crm020/authorization-http.mjs`，执行版本 | `8a92204113e520ec1522ab49bdfa477de90a73ae62ca72eecb3ea14f6be000ad` |
| `.local/crm020/authorization-http-dabf9556-69a3-4d82-a354-fee82f85d212-result.json`，原整体失败 | `a95c4f6bb647a8fcdabf4d30b6a88a603ea669d22a040d4cd079f35099f76b7c` |
| `.local/crm020/authorization-http-dabf9556-69a3-4d82-a354-fee82f85d212-reconciliation.json` | `24966cee182521ab535616a858813c2565c111ce498101af9b5b79b3f4d8a3b8` |

冻结计划同时记录相关产品源码与授权子清单哈希；安全回执只保留状态、错误码、路径及对象身份，密码、cookie、token 和连接配置不公开。HTTP 验证器在执行前经过独立静态审查；后续对账与收尾由根 agent 明确授权，具体源码和原始投影只留本机。

这两个代表负例分别证明真实角色门禁与 inspect 批准门禁，以及其观察窗口内无业务副作用。它们不证明所有角色、MCP 工具、inspect 执行路径、并发决定或全项目权限隔离；也不补齐 CRM-020e 保留的未知竞态，不将整个 CRM-020 标为完成。
