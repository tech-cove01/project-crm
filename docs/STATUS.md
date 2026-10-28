# 工作状态

更新：2026-10-28（Asia/Shanghai）。

- 方向：CRM AI-native 项目。
- 当前阶段：本机已验证百炼 Agent、客户记忆、原生与 WeKnora 知识检索、部分审批动作及 Langfuse 观测投递，后续按实际业务补齐。
- 当前票：CRM-016 收尾复核重新打开：补齐最早客户只读 Run 的 79 分失败诊断，并修复、验证客户回答的 revision/日期误述。既有检索改进和六项来源核对保留；两项完成前不称全部收尾。CRM-013/014/015 已交付本机范围，见 [实施票据](implementation-plan.md)。
- CRM-016d：原始客户 `b73606ef…` 的唯一硬失败是两条真实客户记忆 ID 误标 knowledge，类型化引用匹配 1/3；记忆实际已读取。原 79 分公式、保存报告与 Langfuse 六评分逐项一致，来源与摘要哈希独立复核通过，原评分未改。[诊断](evidence/CRM-016d-original-customer-failure.md)。CRM-016e 的新答案验收仍在进行。
- CRM-016a：实际历史查询与固定三题基线已核实；raw 命中 0/5/0，旧适配器可信证据 0/3/0，源版本/哈希一致。官方接口为正则匹配而非语义检索；未触发模型/embedding，未改资料或业务。独立审查通过，[证据](evidence/CRM-016a-baseline.md)。
- 最近交付：CRM-016b（e48b1bd）先做字面转义，仅上游零候选时增加一次有界关键词分路，原授权/发布页/来源/版本复核不变。同资料实测长句 0→2、短词 3→3、无答案 0→0；18 项定向检查、ESLint、typecheck 与独立审查通过。[前后对照](evidence/CRM-016b-retrieval.md)。
- CRM-016c：六项既有声明的 agent 来源核对为 5 pass、1 fail；客户回答错误声称 revision 差异并夹有无来源日期猜测，原回答和 89/92/89、answer_quality=50 不改。不是模型 Judge、真人审核或全答案语义认证。[质量证据](evidence/CRM-016c-quality.md)。
- CRM-014 本机演示记录：三个小任务业务窗口 3 分 31 秒，含观测回查 4 分 29 秒；全部 completed，明确批准后重读阶段正确，三 Trace 实际回读。评分 needs_review/89、92、89，未调用语义 Judge。[手册](sales-demo.md)、[证据](evidence/CRM-014v.md)、[前序失败](evidence/CRM-014b.md)。
- CRM-014 小提交：1737e16 目标预览、dba4fb7 只读准备、de7d343/bb9d61c 输入约定、de2b9ad 失败及质量诊断、1d90b97 三任务入口、d5df322 本机可选集成间隔。直接检查、真实运行和独立审查分别记录，未降低 gate 或评分门槛。
- 最新运行快照：2026-10-28 22:56，CRM-016b 提交后在空队列下有序重启自己拥有的受管进程，已加载新实现；会话 36c10642-9f90-4e86-a0ae-bb02d5d0f6db。Web/Worker 可响应，Worker 数据库正常，job pending/running/dead 及 integration pending/processing/dead 均 0、integration done=34，Web 保持既有 degraded。完整脱敏状态在 `.local/crm016/local-status-after.json`；实时状态用 `npm run local:status`，不要用历史 PID 操作。
- CRM-013a（7211979）：只读状态、一致本机绑定、6 项定向检查及独立审查通过。[证据](evidence/CRM-013a.md)。
- CRM-013b（3f773cf）：受管启停、脱敏日志与退出诊断通过定向验证及独立审查。[证据](evidence/CRM-013b.md)。
- CRM-013c：已验证真实登录、正常有序退出、受控异常及恢复；百炼只读 Run `4e30f57b-9738-4c6c-9fdc-d93ca18a341b` completed，专用消费者自然处理两条观测事件为 done，最新队列空闲。Web/Worker/集成服务留在线；这是一时快照，实时请运行 `node scripts/local-crm.mjs status`。[证据](evidence/CRM-013c.md)。
- 已有材料：从本仓根目录访问 ../../../develop/，5 个资料包已全部解压并校验；原 zip 移至 ../../../archive/zips/crm。
- 本轮：project-crm 已移到 project/code，与 project-full-stack 同级；共同工作区维护一份 Skill，各仓库按适用范围建立本地联接。
- 旧项目：../../../archive/project-agent 已冻结，GitHub 为私密；project-crm 为独立仓库。目录迁移不改变两个仓库的 Git 历史。
- README：面向面试官介绍客户经营场景、Agent 与后端亮点；本机验证范围和外部依赖已区分。旧 project-agent 本机百炼 Qwen 凭据已通过 CRM 加密入口配置；只读 Agent 流程已完成真实验收。
- 部署选型：先使用本机运行和屏幕共享；暂不购买服务器。需要远程演示时再处理入口、数据库访问和公网前置。
- 本次补做客户回答误述修复与新 Run 验证；扩大资料/无答案样本、完整语义质量及生产稳定性仍未验证。CRM-016a/b/c 的固定三题与六项历史来源核对范围不变，不将新增验收覆盖到旧记录。详细规格只在 [实施票据](implementation-plan.md) 维护，公网部署不作为简历前置。
- 历史验收快照：2026-10-27 22:06 本机检查 Web HTTP 200、Worker 状态和数据库正常，队列 pending/running 均为 0；Web http://localhost:3000，Worker http://127.0.0.1:8787/healthz，Supabase API 55421、PG 55422，183 张业务表。真实登录/引导、4 核心页、合成客户创建修改及刷新读取通过，未登录请求被拒绝。
- 健康边界：此前 Web 健康检查为 degraded，Supabase 正常、Redis/WAHA 未配置；该状态为本机快照，不代表所有服务可用。百炼真实模型、客户记忆和原生知识检索已验收；客户渠道尚未验收；Mem0、WeKnora 和 Langfuse 本轮结果见下。
- 登录：仅本机 .local/login-credentials.json；应用源码及全部环境/会话材料分别管理，不上传本机凭据。
- 记录规则：保留 spec、tickets、implement、code-review 和小功能 commit 的交付节奏；实际验收后才记录功能完成。
- 外部动作：用户本轮要求先看能否运行及部署缺项；Cloudflare 尚未部署，未修改 DNS 或调用客户渠道。
- 部署偏好：用户已有 Cloudflare/域名，没有服务器，要求先评估 2 GiB 是否足够再购买；当前优先本机运行/屏幕共享。实测内存快照和公网入口前置见 cloudflare-deployment.md；未完成 Linux 2 GiB 模拟或公网部署。

- CRM-008：本机演示模式下合成商机批准、落库和 Agent 续跑已 completed；单次金额预算关闭及其他范围见 docs/evidence/CRM-008.md。
- CRM-007：客户确认记忆、合成 FAQ 百炼向量检索、商机变更审批及语义 Judge 已验证；金额预算未知和外部服务边界见 docs/evidence/CRM-007-capabilities.md。
- CRM-006：百炼 `qwen3.8-flash` + 工作台 + Worker + `crm_get_contact` 真实完成，详细结果与成本未知边界见 docs/evidence/CRM-006.md。

- CRM-010 Mem0：本机服务写入、语义检索、删除和 CRM 确认事实自动同步已验证；新 Agent Run completed 并经客户工具触发 Mem0 检索，事件脱敏无法确认具体引用哪条重复记忆。专用队列定时器须单独运行。详见 [Mem0 验收](evidence/CRM-010-mem0.md)。
- CRM-010 WeKnora：百炼合成 Wiki、CRM 来源检索与 Agent 引用已验证，首次较长查询未命中的历史保留。CRM-016 对同资料固定长句做有限改进（0→2）；不代表整体召回率。见 [原记录](evidence/CRM-010-weknora.md)、[前后对照](evidence/CRM-016b-retrieval.md)。
- CRM-010 Langfuse：模型、工具 observations 和确定性评分已真实回读；对象存储卷槽不足已修复，重启后历史记录保留。详见 [Langfuse 记录](evidence/CRM-010-langfuse.md)。

- 2026-10-28 换网前镜像下载受阻；换网后两项镜像均已下载并完成实际联调，详见对应证据。
- 2026-10-28 本机容量快照：Windows 可见内存约 31.6 GiB、可用约 5–6 GiB，系统正在使用内存压缩；CPU 与其他项目并行负载有波动。Docker 数据目录在 D 盘，当时余量约 213 GiB。当前主要使用 CPU/系统内存及远端百炼，GPU 不承担模型推理；三套集成同时启用后一次采样可用内存约 2–3 GiB，运行时应持续观察。

- 本轮三项服务联调期间 CRM Worker 曾无日志退出一次，原因尚未确定；确认任务队列为空后已重启，随后合成只读 Run `92da806d-532b-4d4a-925f-557a308074b1` completed，仍需观察长期稳定性。

## 交给动手 Agent 的收尾入口

CRM-013/014/015 的本机范围及 CRM-016 的诊断/固定样本改进已完成，接续时先读取本页，再进入 [CRM-013～016 规格与验收](implementation-plan.md#求职展示收尾交接2026-10-28)。

| 顺序 | 票据 | 要完成的事情 |
| --- | --- | --- |
| 已完成本机范围 | CRM-013 | 统一状态/启停、退出日志及真实恢复验收；历史 Worker 退出根因未定位，长期稳定性未测。 |
| 已完成本机范围 | CRM-014 | 三任务固定演示，含回读 4 分 29 秒；历史失败保留、评分仍需语义复核，不代表长期稳定性。 |
| 已完成 | CRM-015 | README 和能力盘点已按实际证据同步，全栈 + Pi 与实测边界已区分。 |
| 收尾补验中 | CRM-016 | 检索改进和历史来源核对保留；原客户 79 分已单独诊断，新答案的 revision/日期误述修复仍待完成独立验收。 |

本轮已从“基础数据库在线、应用及集成离线”恢复并完成 CRM-013 验收；最初共同退出的容器状态不作为新崩溃根因。接续时仍须重新检查实际状态，不把任何历史健康快照当成实时监控。现场资料与生成配置只留本机，不复制到公开提交。客户发送、云部署和新模型/记忆特性仍按原票据另行选择。

## 工作流接续入口

- [规格、票据、审查和提交记录](implementation-plan.md)
- [CRM-006 百炼 Agent 验收](evidence/CRM-006.md)
- [CRM-008 审批续跑验收](evidence/CRM-008.md)
- [CRM-007 核心能力验收](evidence/CRM-007-capabilities.md)
- [CRM-007 审批验收](evidence/CRM-007-approval.md)

## 其他资料

- [本地运行](local-development.md)
- [能力与二开边界](current-capabilities.md)
- [Cloudflare 部署前置](cloudflare-deployment.md)
- [本机服务验收](evidence/CRM-002b.md)
