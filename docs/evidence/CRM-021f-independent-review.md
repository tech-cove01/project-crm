# CRM-021f：独立核验与运行收口修复

2026-11-01。用户要求核验当前进展、修复发现的问题并推送。审查从干净 `9161852` 开始；本轮不增加模型、Judge、真实批准、检索请求或业务场景，不把既有成功结果换成新的分母。

## 原交付核验

独立回查 021a–e 的代码、私有来源报告与公开记录，未发现关键计数或证据哈希不符：

- 批准前阶段未变，批准后唯一提案 executed、阶段活动一次，续跑重读与结果一致。
- 最终协作父任务与三 child completed，7 项字段断言及 7 条来源均与实际工具事实一致；四次前序协作失败保留。
- 六 root 含专家的 145 个唯一 span 完整，缺失、多出、不符均为零；6 root、15 child、7 job 与 24 条聚合模型计量复算一致。
- 数据库五组验证分别来自三份报告；双连接竞争和夹具边界未被包装成任意路径的 exactly-once。
- 检索 17 题完整、五个无答案为空；D02/F06 各缺一页，169 GET 分项相符，仍非盲测或总体语义准确率。

具体原始结果继续见 [021a](CRM-021a-approved-chain.md)、[021b](CRM-021b-collaboration-verified.md)、[021c](CRM-021c-retrieval-regression.md)、[021d](CRM-021d-concurrency.md)、[021e](CRM-021e-closeout.md)。

## 发现与修复

start 曾使用模型运行前的复核快照及内存 pending 状态收口。同商机另一任务的人工复核可在期间取消旧提案，当前 Run 却仍显示等待批准；resume 也可能忽略期间新登记的复核。原动作执行门禁仍有效，未发现因此产生越权或重复效果的实际记录。

新增 [共享收口](../../lib/ai/agents/workbench-close.ts)，让 start/resume 在同商机 advisory 锁内重查租约、协作准入和真实 pending，随后条件更新 Run。取消或更新零行不发完成事件；晚到复核产生 partial；已完成人工复核但旧任务失效时保留 `collaboration_new_run_required`，提示新建任务重新取证，不再要求重复复核。正常待批仍隐藏模型完成评估，自动写入后的继续轮次在事务释放后进行。

独立审查同时修掉新路径的两个边界：blocked 但 pending 仍在时必须发送 `run_partial`；事务内租约查询复用已取得的 client，避免 `DB_POOL_MAX=1` 再借连接卡住。真实 PG 检查又发现空文档被序列化成 JSON `null` 会违反现有 shape 约束，改为绑定真正 SQL `NULL`，没有放宽约束或改迁移。

## 直接验证

| 验证 | 结果与范围 |
| --- | --- |
| 收口、start/resume、resume-job、租约五个测试文件 | 32/32 通过；覆盖晚到复核、cutoff、blocked + pending、正常完成/待批、取消/无更新、失租、未知 PG 故障、单连接复用和事务外继续。 |
| 既有协作与结构化提交四个文件 | 47/47 通过；不调用真实 provider。 |
| 既有 Wiki 查询边界 | 30/30 通过；不重复真实检索。 |
| 本次九个修改源码/测试的 ESLint | 无错误或告警。 |
| 全仓 typecheck、diff 检查、独立代码审查 | 通过；未运行无关全量测试。 |
| 真实 PostgreSQL 收口 SQL | 修复 SQL NULL 绑定后五个场景通过，07:41:26 UTC 完成；所有新 UUID 夹具外层回滚，剩余自有 Run 为 0。 |

真实 PG 五场景为正常完成、真实 pending、仍有 pending 的新复核、复核后旧提案取消、已取消 Run。检查使用一条真实连接，把 helper 的事务边界桥接为 savepoint，最外层始终 rollback；只插入隔离 Run/proposal 和复核元数据，不创建 job、不执行批准、不修改任何实际商机。它验证实际 SQL/约束与状态分支，**不等于新的并发或端到端 Agent 验收**。

首次 PG 检查遇到 23514 后即停止并回滚，保留失败摘要；修复后才执行同一有限检查。部分离线测试首次因 Windows 沙箱临时缓存 rename EPERM 未收集到用例，后续同范围在可写临时目录或获准本机权限下通过；不把仪器失败写成断言通过。

私有证据均位于 `.local/crm021f/`，不上传配置或夹具正文：

| 文件 | SHA-256 |
| --- | --- |
| `verify-close.ts` | `dfc9527fe731fc9f3a11f585e1c79f61b4587bf1d51e070a75f6f7931e2d03d9` |
| `pg-close-first-failure.json` | `e28964e17e54dcfbf71f704b75a1dd06a6c3d230f8dcc278ab9f2961db4fc9df` |
| `pg-close-report.json` | `026d1a1e84ad3fcbb19799c514505bb7d0c12dad2a086df0053834d6209d5b03` |

对应收口 helper 文件 SHA-256 为 `1d8a8945d0887058367126c8c5d44af8e880c5d602a2cd3212174714ce5c330f`。原产品真实模型验收仍是 `dbbc4ca`，本修复另以直接回归和上述真实 SQL 验证，不伪称新做了完整模型流程。

## 停止条件与交接

07:43:28 UTC（15:43:28 Asia/Shanghai）重载后只读快照：原自有受管会话在空队列下有序停止，Web/Worker/drain 均 graceful，未强停；新会话 `7341e3ab-8b9e-4b36-8897-69436747c9a5` running，Web/Worker HTTP 200、Worker DB ok/排水器已加载，三项集成健康端点 200。业务 pending/running/dead 与集成 pending/processing/dead 均 0、done=126；Web 保持既有 degraded。仅重载本仓服务，没有操作其他项目或 Docker；快照在 `.local/crm021f/local-status-after.json`。

本次不追加第五条亮点、Judge、云部署、资料集或新功能。两个检索漏页、总体语义质量未校准、排水器曾异常退出且根因未知仍保留；Web 的既有 degraded 不包装为生产稳定性。下一步仅整理现有四条主线的本地私有简历素材与源码讲解，具体执行入口见 [STATUS](../STATUS.md)。
