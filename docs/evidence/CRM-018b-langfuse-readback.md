# CRM-018b：Langfuse 观测恢复与完整回读

日期：2026-10-30。针对 [CRM-017c](CRM-017c-agent-evaluation.md) 原有七个 Run 的观测缺口取证、修复及恢复；没有新建 Run、调用模型/embedding/Judge、重新审批或修改 CRM 业务。

## 诊断与修复

1. 旧私有回查脚本把原生 Fetch `Response.status` 数字属性当作 Playwright 的 `status()` 方法调用。后续七条 observations 和一条 trace 的 TypeError 不能证明“未收到 HTTP 响应”。旧报告保留，原诊断结论在这里更正。
2. Langfuse Worker 在原 Run 窗口连续出现 ClickHouse `MEMORY_LIMIT_EXCEEDED`，内部总上限仅 512MiB。HTTP 已接受、CRM 事件 done 后，下游异步写入仍失败；实际缺失不只是回查脚本问题。
3. 把内部限额升为 1GiB、容器改为 1536MiB 后，宽 I/O 列的聚合查询仍可超过 1GiB。默认 profile 的查询块从 65409 改为 1024 后，完整 `core,basic,io` 查询才可成功；没有通过删掉 I/O 字段来绕过脱敏核验。
4. 即使旧记录已恢复，重放期间仍有三组异步写入触限。继续核查发现高频系统日志表积累千万级行数，八路后台合并占用约 483MB，业务观测表仅 161 行；因此将后台池和并发比率均设为 1，并停用四类高频诊断表的新写入。历史表/卷不删除，错误和查询日志保留；不能把前一轮读全当作该残余问题已解决。

最后配置生效后一次实测：后台 Merge 并发为 1，跟踪内存约 332MB、合并内存约 7.8MB（此前约 994MB/483MB）。这是本机瞬时采样，不是固定内存保证；合并吞吐及系统 profiling 历史会减少，不能外推生产稳定性。

随后对一个全新、明确标记为 synthetic 的隔离遥测 Trace 只投递一次六 span 样本，未调用任何真实模型或创建 CRM Run；6/6 完整回读通过。固定 `2026-10-30T04:24:48.311Z` 至 `04:25:48.311Z` 的 60 秒窗口，Langfuse Web/Worker 的 `MEMORY_LIMIT_EXCEEDED` 日志均为 0。之后只读 CLI 再次检查七个旧 Run，exit=0、49/49 完整，15 个原事件的状态和 payload 哈希仍相同。此前重放期间的残余错误未删除，此次才验证最终配置的新写入及回读。

仅重建经 Compose 标签/卷确认属于本仓的 ClickHouse，原命名卷 `crm-agent-services_clickhouse-data` 保留。配置只读挂载，Dockerfile 同步 COPY；没有拉新镜像、清卷或操作其他项目服务。这是本机修复配置，不是生产容量建议。查询块与内存关系参考 [ClickHouse 官方块处理说明](https://presentations.clickhouse.com/2022-cpp-russia/clickhouse_performance_optimization_practices/)。

## 同一批旧记录的恢复

| Run | 恢复前已回读 / 应有 | 恢复后 | 模型 / 工具 observations |
| --- | --- | --- | --- |
| C01 `0a8fd074-eefb-4a69-adc7-043c6de11b24` | 1/6 | 6/6 | 2 / 2 |
| C02 `c0f32586-10b8-42ea-94b0-6f1e87cabf35` | 0/6 | 6/6 | 2 / 2 |
| C03 `04dd2596-0db1-4505-bd43-380962a34a32` | 5/6 | 6/6 | 2 / 2 |
| C04 `0560b0cc-9a56-44d3-bf0b-3f2d6439e576` | 5/6 | 6/6 | 2 / 2 |
| C05 `201fe1cd-1e0c-4d5a-ad28-f334ec63158c` | 0/6 | 6/6 | 2 / 2 |
| C06 `2d712df8-0f7d-41c4-8175-62417151fee9` | 1/6 | 6/6 | 2 / 2 |
| C07 `bc4cd530-95ae-4979-be20-68ba0fee2ee5` | 7/13 | 13/13 | 5 / 5 |

七个 Trace 合计 **49/49 spans**，包含 17 条模型与 17 条工具 observation，其余为 call/run。恢复仅对含缺失 span 的 **10 个原有脱敏事件**显式重放：先保存 intent，再投递相同 payload、稳定 span ID；不修改原事件的 done 状态，不重跑模型。异步落库有界等待后，按每个 ID、名称、父子关系精确对账，无缺失/额外/冲突，I/O 字段均明确返回为空。不是仅比较数量，也不是把 HTTP 200 当作落库证明。

这些 Run 原本没有 scores 导出事件，故本页不宣称远端评分也已回读，不新增评分或改变 CRM-017 的答案质量判定。

## 持续可用的检查入口

新增 `scripts/readback-langfuse.ts` 和复用 helper：原生状态属性、从原 span 时间确定查询窗口、完整 cursor 分页、重复/冲突和 ID/父子关系检查；必须实际取得 I/O 字段且为空，遗漏字段不能判隐私通过。仅按已配置组织和拥有的 Run 查询 SQL 及远端 GET，报告输出 ID、数量和固定错误码，不输出原始 I/O 或密钥。

OTLP 导出另检查 JSON receipt：完整接受及零拒绝 warning 可接受，明确 `rejectedSpans>0` 不标成功、不自动重试，消费者保留非重试原因；HTTP 接受仍不证明持久化。依据 [OTLP partial success 规范](https://opentelemetry.io/docs/specs/otlp/#partial-success) 和 [Langfuse Observations API v2](https://langfuse.com/docs/api-and-data-platform/features/observations-api)。

16 项相关检查、ESLint、全仓 typecheck 及独立代码审查通过；Compose 语法、实际内存/查询块与原卷核验另行完成。测试包括分页、缺 I/O、span 冲突/合法更新、原生 Response 属性、partial rejection 不重试等，不调用模型。

## 证据位置

私有 `.local/langfuse-fix/` 保留旧内存错误的脱敏摘要、单次重放 intent/receipt 及逐 Run 对账：

- `historical-memory-errors-1793333558959.json`，文件 SHA-256 `6d310dbebccfa97e1239b0fb34a840718dd3417980487a88cb8ff7b3ca3eefc1`。其中 180 条 Worker 错误为重复栈/层级日志计数，不代表 180 个独立请求。
- `recovery-1793333939082-704f9b80-34e9-4e96-8211-61b4c1080cb8.json`，文件 SHA-256 `195f014c01eea0a5fbd1fa23e4bf5a4ac96705a105218e17857187df13ac6f2d`。
- `storage-probe-1793334350804-479e0e57-df08-4561-b224-e1ba3c432698.json`，文件 SHA-256 `ae419f4942e0dbf063993185c2c377dbeea114ec43a22bc5fe8dd8212ab8910d`，记录最终配置、生效后隔离样本和固定错误窗口。
- 最终只读 `.local/langfuse-readbacks/readback-1793334350760-c4db0fb2-a54f-4bf7-ba78-92bdf30a32f7.json`，文件 SHA-256 `32395a2ae5d46f39538ac1dd51fe4dce331668ab475168113de9c7a49451c6fc`。

旧回查失败、启动期失败、升内存但未降块仍失败的记录均保留；不覆盖历史来制造首次通过。完整性结论限这批旧 Run 的 span 链与脱敏字段，不推广为长期稳定性或全部模型答案质量通过。
