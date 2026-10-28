# CRM-013c：真实恢复、退出与只读 Agent 验收

日期：2026-10-28（Asia/Shanghai）。代码入口分别为 CRM-013a（7211979）和 CRM-013b（3f773cf）；文档 CRM-015 为 44a64b6。

## 现场与恢复

最初重新检查时，CRM Supabase 核心容器及独立集成 PostgreSQL 在线，Web/Worker/专用定时器及三项集成未响应。已逐项核对 Docker project、当前仓库 Compose 和已知本机覆盖文件后，启动既有 Mem0、WeKnora、Langfuse 及依赖容器，保留全部配置、数据和卷；没有 pull/build、初始化、重置或操作 Go 项目的服务。可复现命令补入本机运行指南。

通过新受管入口从离线应用恢复，Web HTTP 200，报告 degraded（继承的 Redis/WAHA 未配置边界）；Worker HTTP 200、db=ok、event-log drain 已加载。三项集成公开端点均 200；此处只证明公开可达，不冒充鉴权与业务结果。

## 真实认证及退出行为

- 全新 Edge 会话检查登录页、匿名客户 API 401 和工作台回到登录页；实际登录后工作台 200、组织一致、认证 cookie 存在，pageerror/console error 均为 0。首次脚本漏掉实际“邮件”标签而失败，原失败报告保留，修正验收定位器后通过；没有修改产品登录逻辑。
- 会话 `868d7bcd-b983-4eb5-9c83-1813f28afb72` 正常关闭：drain 0 → Worker 0 → Web 143，均 graceful，无强制结束。3000/8787 释放，原三个应用 PID 的直接子进程未发现残留。
- 会话 `23289a61-c554-4981-b5dc-db6846f9c6c2` 进行受控异常演练：先查业务及集成队列为空，再校验新鲜心跳、会话、父进程、本仓 host 命令、创建时间并持有稳定 OS 句柄，仅主动终止该空闲 Worker。队列为空只是采样，不是阻止并发新任务的原子保证。
- 监督器记录 Worker exitCode=4294967295、graceful=false、`unexpected_service_exit`，会话 failed；随后关闭 drain 和 Web，释放端口/会话锁，没有自动重启或停止未知进程。本次是主动注入的异常，不是复现此前无日志退出的原因。
- 手动恢复到会话 `5079dbd3-a478-4cb6-b1a4-656948c72865` 后完成下方真实任务，最终保留应用与所选集成服务在线。

## 恢复后的唯一真实只读任务

用户确认当前资料为非真实演示数据，并允许本次向已配置百炼调用。通过全新认证上下文创建一条 inspect、collaboration disabled 运行：

- Run：`4e30f57b-9738-4c6c-9fdc-d93ca18a341b`；provider=dashscope、model=qwen3.8-flash。
- `running → completed`，无 error_code；结构化事件同时证明 `crm_get_contact` 开始及成功，实际工具列表只有这一项，存在最终回答。
- 未出现业务变更事件或动作提案，没有发送客户消息；这里只核对运行事件及只读模式，不是所有业务表的全量哈希对账。没有运行 Judge、批准动作或重复创建模型任务。
- 对应 workbench_start job 为 done，attempts=1。组织业务 done 从 19 变为 20，pending/running/dead 均为 0。
- 该 Run 的两条 Langfuse spans 事件 `9e45deab-9274-4290-8535-9fcd8029acd4`、`348aaef0-5754-4060-8038-8ed131c44632` 经专用消费者自然成为 done，均记录 `ai_integration.langfuse_v1`；该演示组织的集成 done 从 13 变为 15，pending/processing/dead 为 0。定时器日志的两轮 HTTP 200、scanned=1/done=1 与事件时间对应，没有手工触发 drain 或修改事件状态。

本票证明恢复后只读任务和集成队列消费；没有重做 CRM-010 的 Langfuse 服务端 observation/评分回读，也没有据此宣称新质量评估通过。模型金额仍未计算，本机演示预算边界沿用 CRM-008。

## 审查与限制

代码定向验证、完整类型检查和独立代码审查见 CRM-013a/b。现场报告、正常/异常退出记录、脱敏运行与定时器日志分别留在受忽略的 `.local`；凭据、cookie、任务/客户/回答正文未进入公开证据。独立复核检查会话、退出码、工具事件和队列时间关系后收口；完成以对应本地提交成功为准。

原 Worker 无日志退出根因仍未确定。本轮增加可观察的退出行为及有界关闭，未做长期稳定性、生产部署或付费容量结论；客户渠道、正式成本和多组织完整验收不在此票范围。
