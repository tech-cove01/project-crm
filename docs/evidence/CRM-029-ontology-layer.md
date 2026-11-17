# CRM-029 Workbench 业务语义层

## 口径与实现

目录 `1.0.0` 摘要为 `5102aecfbd6ac810320cf12bd648db9e78b82d37238df0247851acd199fdbb9f`。目录描述商机、商机活动与同组织 `lead_id` 关联，保存已审核词条、物理字段、版本和独立摘要。`crm_query_ontology` 的 `resolve` 只解析目录，`plan` 判断可回答性，`query` 只执行已审核模板。新查询需要用户业务问题，规划器拒绝未支持的条件、缺定义、禁用词条及相互矛盾的时间范围。CRM-027 原有约见模板加 UTC 参数的结构化路径保留。

| 模板 | 可回答范围 |
| --- | --- |
| `open_leads` | 持久 Run 当前授权范围内、活跃管道且当前状态 `open` 的商机 |
| `completed_appointments` | 所选商机上 `type='appointment_completed'` 的活动，UTC 起点含、终点不含，最长 31 天并保留微秒 |
| `open_leads_without_completed_appointments` | 开放商机中在给定 UTC 窗内无已完成约见记录的商机，回执覆盖标记为 `partial` |

组合口径只覆盖已记录的 CRM 活动。高潜和有效跟进没有已审核定义时，返回需要补齐的信号、阈值、范围、渠道、方向及判断时间窗；模型透传的业务原句须保留用户条件。本轮使用有限的已审核同义问法。权限按运行时有效经理或管理员、父 Run 状态、所选对象和实时归属重新验证。查询使用参数化 SQL，授权与读取使用同一个数据库快照，最多返回 25 条，并分别报告空结果、截断、拒绝和失败。取证事件保留模板、口径与摘要、范围、过滤窗、最少的商机或活动字段，原问题和商机标题不进入事件。新版约见回执兼容 CRM-027 的活动 ID 和调用 ID 关联，组合结果无阶段动作资格。

## 隔离前置与定向回归

本次使用专用 PostgreSQL `7709011364967645216`。固定窗口 `2026-11-10T09:00:00.000Z` 至 `2026-11-10T12:00:00.000Z`。SQL 预期在选定管道返回开放商机 3 条，组合返回 1 条。所选商机只匹配起点的完成活动 1 条。合成负例包括终点、窗外和其他商机的真实活动、归档管道、已赢单、已输单及异租户。首次建夹具遗漏输单原因，事务回滚后确认零业务行、零模型请求，复用同一隔离库和账号补齐。

31/31 个实际 SQL 对照符合预期，分为 7 个 `matched`、4 个 `empty`、19 个 `forbidden`、1 个 `truncated`（返回 25 条）。覆盖有效角色、授权撤销、排队状态拒绝、范围交集、同租户可绑定单聊、错配或异租户对象及非法范围，回滚临时对照后为零 Run、Job 和 Gateway 请求。首次临时测试脚本将通道参数推断成文本，保存点回滚后显式转换并重跑同一对照。精确产品查询在小夹具上 `EXPLAIN ANALYZE` 的执行时间约 0.503 毫秒和 0.320 毫秒，适用范围为本次夹具。

原生 HTTP 预检中，经理和管理员能读取所属范围，普通角色和撤销角色返回 403，异租户账号能读本组织列表且读本批目标联系人返回 404。类型检查、改动文件 ESLint、`git diff --check` 及 44/44 个直接相关单测通过。独立审查核对了最新角色与范围、事件白名单和旧审批谓词，发现新查询可能省略原句已收紧并回归。CRM-027 的审批仍使用该 Run 已存储的历史活动回执，实际查询在续跑回查。

| 本机原件 `.local/crm029/` | SHA-256 |
| --- | --- |
| `sql-preflight.json` | `814a88076c0459291e0911d4cfedfc2ada5dadf742a418311a269475200be046` |
| `sql-direct-product.json` | `797c25d226f213f7a220b1b7a0fdee584edcd71d98cd31e85d7da2cda287db62` |
| `http-preflight.json` | `7162c8ba13fa44ffd18c07d6b6d96998e54e4d7174131278a40a5b3f45a3c8c2` |

新版 ZIP 的文件级来源、版权和本仓适配差异见 [来源记录](../SOURCES.md#crm-029-的-ontology-lite-来源)。

## 真实 Pi 验收

固定产品 `d78526a81c9792b97eb2271a54ee5401dac69bdf`，12 个运行及 UI 源码路径带哈希，3 个预定父 Run 的输入与范围在首发前固定。每个 Run 使用真实百炼 `qwen3.8-flash`、单 Agent、10 步与 24,000 token 预算。`.local/crm029/freeze.json` 的 SHA-256 为 `768ae01ff1f482c9399d2f505ff52d587c8bd010c395ffdf257874d26ddd61b8`。

开放与组合共用原 Run `050b5fb0-b529-470c-a99b-e7881c4bd5b7`，终态 `completed`。事件 6 的真实调用 `call_d3f0dd815be142f48f9ad906` 返回选定管道的 3 条开放商机，事件 7 的 `call_48bf610b700b46be93740ee8` 在固定窗口只返回其中 1 条，两次 ID 集均与冻结 SQL 一致。组合取证保留两个基础定义及其组合，覆盖标记为 `partial`。模型提交的中文答案复述了两组 ID，明确无 CRM 记录无法证明未跟进。原生详情 GET 200 并重读同一口径和结果。耗时 55.611 秒，输入 9,689、输出 3,359、缓存读 8,960 token。

该 Run 首次结构化提交被拒，第二次在原 Run 内被接受并持久化为 `model_submitted`。后续建议提到扩大或分段检查约见窗口，这只能检查更多约见记录。有效跟进仍需独立的业务定义和来源。

| 本机原件 `.local/crm029/` | SHA-256 |
| --- | --- |
| `open-final-observed-1794894732856.json` | `393a0f49b2591ad12da0ffa351d35c94a0f4cbaf118aa9cf9e199d4f01b0695a` |
| `open-final-refresh-1794894740589.json` | `d5a74deabc8bcc94b48892594b7953d753a20782e4ea91ca53a784f279452d20` |
| `open-final-pass.json` | `4b28aeaa1019b97cd7debf5e10f613667f738efa6905ea43b08c784c3b5e9545` |

缺定义原 Run `0ac0d6e4-2d11-4e4e-9027-9acf75f89585` 保留 `partial/missing_material`。事件 5 `call_e8a43516b93149ccaa9ec547` 将带条件的原句传给 `plan`，返回 `clarification_required/missing_definition`，同一目录保留“开放商机”的审核口径并列出高潜、有效跟进两类缺项。事件 9 `call_ab636382c6ac446199ccdb58` 是同版本的目录 `resolve`，本 Run 的实际业务查询、提案与写入均为 0。模型首个结构化提交被拒，后在原 Run 内补读术语并提交成功。最终答文列明两类缺项并保留所选管道范围，但结构化引用把管道 ID 标作 `knowledge`，因此以持久范围和术语回执核对。耗时 29.833 秒，输入 4,474、输出 1,772、缓存读 16,128 token。

首次只读观察脚本把术语解析与计划都计入要求唯一的计划调用，保存原结果后按实际操作类型重新读取同一 Run。原件 `missing-final-observed-1794894793293.json` 的 SHA-256 为 `26671c3dd849937c5faed6675701c4d873ca2792d106d8929306e5bce33d4f1d`。

`missing-final-pass.json` 的 SHA-256 为 `ca2feab7805c6aa5ad639c42e1612c16c4d908fa24dae86d402deeb0110bfc44`。原生详情 GET 200，目录的计划和术语回执均在刷新后读到。

### 首次审批阻断与定向修复

第三个原 Run `06bfd848-ed93-441f-abf2-7122738a64ff` 终态为 `partial/missing_material`。原调用 `call_11b517598e6c4b109b2c6968` 提供正确的已完成约见模板与 UTC 参数，并在问句用括号复述已选商机 ID。旧规划器拒绝这段合法原文，给出 `unsupported_question`。模型如实报告无提案，SQL 阶段和冻结业务快照完全一致。原生详情 GET 200，提案、执行回执、业务写入均为 0。耗时 20.612 秒，输入 3,415、输出 1,054、缓存读 9,728 token。

修复仅在括号内的商机 UUID 和当前已选范围相同时接受冗余标注。缺少所选商机、UUID 不一致、额外业务筛选、未定义口径或不一致的时间参数仍会拒绝。首个原调用参数直接通过修后规划器重放，模板、UTC 起止及目录摘要均与冻结输入一致。45 项综合定向测试、全仓类型检查与修复文件 ESLint 核对通过。只复测受影响的审批路径。

| 首次失败的本机原件 `.local/crm029/` | SHA-256 |
| --- | --- |
| `approval-pending-observed-1794894878526.json` | `e69d8f5b8dedbb4423fc9298a41ab4fb9b561399a72030226ab2baa9f94ba38c` |
| `approval-original-partial.json` | `96e8703abac168876c59ea7d8ef92b4191ba27f046a4d18832a214b0cb7755ba` |

### 同一业务任务的修后回归

固定修复 `0a520c24dce6687103516af64fc697102fa277cb` 后，使用相同角色、夹具、条件、目标阶段、模型与预算，只新建一根受影响回归 `1a063620-4737-4a55-9692-dd6e8c5faa17`。独立复核 12 个冻结路径，唯一变动的产品文件为 `lib/ontology/query-plan.ts`。真实模型在回归中使用不带括号 UUID 的同一业务问法。带 UUID 原句的修复由原参数重放和定向负例验证。

真实取证 `call_2fa6635ba2da4c12bc332272` 命中活动 `56510de9-1939-4c30-bd3d-5ebb41e6ed1c`，时间恰为左端点。唯一阶段提案 `d46a2968-bbb3-4e03-ba3a-e1d05fe711f9` 的理由保留该活动、调用和时间，并具有同一结构化提案依据。待批时商机阶段仍为 `2b057e10-545b-4de5-8373-816efc5ae941`，业务快照完全相同，详情回读 200。模型曾在待批前又读一次约见与商机，这两次只读与批准后的真实续跑分开计证。

实施方使用独立合成管理员身份调用一次原生决定接口，HTTP 200。原 Run 依次记录批准 22、Worker 成功回执 25、一次业务变更 26、续跑 27、`crm_get_lead` 回查 30。SQL 只有一条新增 `stage_changed` 记录 `e3ae07b3-dacb-4f5d-bf96-828b4aef9e1c`，实际阶段 `8021809a-7c5e-4510-aceb-f096acc9ec01` 与回执 `call_20e84467efc94be1bea5a23e` 一致，其他商机、旧活动与外发计数不变。3 个作业均首次领取完成，原 Run 为 `completed`。

模型把取证复读安排在事件 11，早于批准 22，偏离了要求批准后再次读本体的指令。最终答复引用的两个约见调用真实存在，先后次序以事件为准。续跑后实际只读回商机与阶段。原观察脚本因此报告 `crm029_same_run_appointment_reread`，保留失败回执，使用同一原 Run 按实际动作及回查重新对账。全程没有重新提交批准或追加模型任务。

| 受影响回归的本机原件 `.local/crm029/` | SHA-256 |
| --- | --- |
| `freeze-regression.json` | `842332edb0bc7e5faaef8c69f56615304d4eca0d3207003208b00ed7311d6b60` |
| `approval-regression-pending-observed-1794895188117.json` | `e6a31bf85d51b434584180f7bfa3ca06393ca580f8440dabd390fb828e72a25b` |
| `approval-regression-pending-pass.json` | `ad72d05c2d795bf0b175ef512182c3f4f07103306630185ec8753081fc38e11f` |
| `approval-regression-human-http.json` | `2696bb711fd554c9490aa8fce926ca818e809b7e4e5525beae848721097d6b40` |
| `approval-regression-final-observed-1794895249498.json` | `c7a08afefce873b581a22394cafc5c2b4e35620c9be9dac7877f9fe63ba199f5` |
| `approval-regression-final-pass.json` | `00162884fbbdaa862fe180e0cf32b715f51b1baff2e408c55bd4991364a28ddf` |
| `approval-regression-final-refresh-1794895336634.json` | `5eca627a6eabb440f2691642ed50f64ca60a9ff2df847c920943de02a6e30f6b` |

## 用量

| Run | 业务结果与原状态 | 耗时（秒） | 网关计量条数 | 输入 Token | 输出 Token | 缓存读 Token |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 开放商机与组合 | SQL 一致，`completed` | 55.611 | 1 | 9,689 | 3,359 | 8,960 |
| 缺定义 | 两类缺项，`partial` | 29.833 | 1 | 4,474 | 1,772 | 16,128 |
| 首次审批 | 合法原文误拒，`partial` | 20.612 | 1 | 3,415 | 1,054 | 9,728 |
| 修后审批回归 | 一次动作并回查阶段，`completed` | 89.931 | 2 | 9,320 | 2,361 | 30,976 |
| 全部 | 3 个原 Run ＋ 1 个定向回归 | 195.987 | 5 | 26,898 | 8,546 | 65,792 |

Run 耗时从 SQL 创建到结算，修后批准到完成约 13.9 秒。Gateway 聚合耗时共 144.375 秒，缓存写 0，金额未知。原结果、原失败和修后回归分开保留。本轮是功能验收，未测量准确率、时延或成本改善。

## Workbench 页面刷新

用合成经理身份打开 `/app/ai/workbench?run=<原 Run ID>`，选择“运行详情”并展开时间线。Chrome 原生页面首次打开和刷新各读取一次相同的 Run 详情，HTTP 200、请求 ID 不同、持久语义事件摘要一致。开放与组合分别渲染 3 条与 1 条商机，显示目录 `1.0.0` 及组合记录覆盖限制。缺定义原 Run 刷新可见两个缺项。浏览器只转发授权 GET，拦截自动后台写请求。刷新前后业务 SQL、模型请求、Run、提案和默认 Agent 配置对账一致。

修后审批 Run 的首次打开与刷新也均返回 200，同一 35 条事件中两条本体回执摘要一致。截图展示批准前的第二次约见取证。提案实际绑定首次取证的调用 ID，该关联可在原生详情 `preview.ontologyBasis` 读取。终态页面的提案卡展示状态，关联字段经原生详情与事件核对。

| 本机页面原件 `.local/crm029/` | SHA-256 |
| --- | --- |
| `browser-proof-1794895079805.json` | `1095ef6770218ffbd56532ae2b06fcbbdef2ca3423da1f4213273a874996e4fe` |
| `browser-open-050b5fb0-b529-470c-a99b-e7881c4bd5b7.png` | `8581d6ee456faa1e90721edb01d34af0319741c94a4d503c18c6901c5c5d833b` |
| `browser-composition-050b5fb0-b529-470c-a99b-e7881c4bd5b7.png` | `b3b913d7bf93981f5f9ab6e930b392b32d9295ddfb8354c959a94e1dbb6ec793` |
| `browser-clarification-0ac0d6e4-2d11-4e4e-9027-9acf75f89585.png` | `c69c1793d138148105ed837c7dd04abdcb2705950015a104b5bb796807399f30` |
| `browser-proof-1794895321139.json` | `74495f5b1ca87e57bedfb95fcb20badc7172d7aeb575cb2ed5639f2527a6f512` |
| `browser-appointment-1a063620-4737-4a55-9692-dd6e8c5faa17.png` | `c6de6cd43f303ea1f361850eb2604554680135f78fb6b253d3843af1c74d744b` |
| `browser-approval-native.json` | `f6757db9f9b5fae2c92fcfc0f092b454ae3e008ce4999a281d60184a0b63fcb7` |

## 隔离环境收口

退役前 SQL 核对 4 个父 Run、0 个子 Run、5 条网关计量、1 条提案及 1 条阶段变更、0 条外发及 0 项活动作业。仅停止本批 Web、Worker 和 `project-crm-eval-029`。6 个专用容器、专用卷、专用网络已移除，4 个端口不再监听。其他 20 个运行容器的名称和 ID 前后一致。合成结果与快照留在本机。

| 本机原件 `.local/crm029/` | SHA-256 |
| --- | --- |
| `ready-to-clean.json` | `f6559d87a11842aeaa2be6f8e47c7c55ec15274ffd17c6d7338deb20aa26d5d1` |
| `isolated-cleanup.json` | `3ae0a6eb3afbf9c02458227629add742f1f4c1568430d259fe95e29806da9d69` |
