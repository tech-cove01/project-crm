# Project CRM · 项目展示

AI-native CRM：面向客户经营与销售协作，将客户事实、企业知识、商机分析和人工审批组织成可追踪的销售工作流。

- [在线展示](https://tech-cove01.github.io/project-crm/)
- [业务与实现详解](https://tech-cove01.github.io/project-crm/details.html)
- [CRM 交互演示](https://tech-cove01.github.io/project-crm/demo/index.html?scenario=execution&guide=1#/app/ai/workbench)
- [正式项目与技术说明](https://github.com/tech-cove01/project-crm/tree/main)

本分支使用 HTML、CSS、JavaScript，在 GitHub Pages 展示项目介绍与现有 CRM 界面的浏览器交互。工作台、看板、客户、知识、记忆、审批等使用固定示例；模型、Supabase/PostgreSQL、Worker、Mem0、WeKnora 和 Langfuse 由正式应用承载。当前站点无需登录，不实时调用这些服务。

首页先介绍完整产品的背景、场景和业务难点，再沿用四条项目主线：销售 Agent 受控执行、客户记忆与可信知识、专家协作与商机分析、Agent 观测与评测回归。页面标题直接点出 Pi 执行内核和多 Agent，正文说明工具/事件适配、执行分层、事实权威、独立专家子任务与分层评测。简介后的主操作区分两层：首行业务流程与案例描边按钮、唯一深色的静态演示按钮；次行项目亮点、架构与设计取舍、完整技术栈使用醒目的文字链接。桌面与手机均直接展示五入口、不带箭头。业务与两个技术入口指向同一详解页的不同章节；展示页不再突出源码与验收报告链接。具体客户案例、六步业务流程和完整架构收在独立详解页；工作台也可以直接打开业务讲解，旧首页章节链接保持兼容。

首页与详情的四条亮点分别直达下面四条“跟我操作”引导。每步只定位一个真实按钮；亲自操作后再高亮结果并解释。操作步不能靠“继续”跳过，批准、拒绝和分支切换均由访客点击。可随时暂停自由体验，有已有状态时明确选择继续或清空重走；刷新回到场景起点。

| 场景 | 可操作的固定示例 |
| --- | --- |
| [Pi 内核与受控执行](https://tech-cove01.github.io/project-crm/demo/index.html?scenario=execution&guide=1#/app/ai/workbench) | 阶段提案、批准/拒绝、唯一回执与重读 |
| [客户记忆与可信知识](https://tech-cove01.github.io/project-crm/demo/index.html?scenario=knowledge&guide=1#/app/ai/workbench) | 看来源与引用→资料改版→旧引用拒绝→当前版本重检 |
| [多 Agent 协作与商机分析](https://tech-cove01.github.io/project-crm/demo/index.html?scenario=collaboration&guide=1#/app/ai/workbench) | 三专家取证→父汇总与核验→字段冲突→人工选择与再次核验 |
| [Agent 观测与评测回归](https://tech-cove01.github.io/project-crm/demo/index.html?scenario=evaluation&guide=1#/app/ai/workbench) | 正常对照→错引高分仍失败→重放保留原失败 |

场景状态与原自由探索隔离。通用工作台首次推荐受控执行，也可跳过；“跟我操作”可重开。四场景内不会打开旧教程而丢失所选场景；返回自由探索后仍可显式打开旧七步教程。窄屏提示卡让开目标，滚离后可用“定位当前按钮”返回。所有状态变化和Judge分数均为明示模拟；公开真实验证记录放在详情和场景的次要说明内，保留原限制。

本地预览（在本目录执行）：

```sh
python -m http.server 4178 --bind 127.0.0.1
```

打开 `http://127.0.0.1:4178/`。演示资源均为相对路径，页面通过 hash 路由导航。许可见 [LICENSE](LICENSE) 与 [第三方声明](THIRD_PARTY_NOTICES.md)。
