# Project CRM · 项目展示

AI-native CRM：面向客户经营与销售协作，将客户事实、企业知识、商机分析和人工审批组织成可追踪的销售工作流。

- [在线展示](https://tech-cove01.github.io/project-crm/)
- [业务与实现详解](https://tech-cove01.github.io/project-crm/details.html)
- [CRM 交互演示](https://tech-cove01.github.io/project-crm/demo/index.html?tutorial=1#/app/ai/workbench)
- [正式项目与技术说明](https://github.com/tech-cove01/project-crm/tree/main)

本分支使用 HTML、CSS、JavaScript，在 GitHub Pages 展示项目介绍与现有 CRM 界面的浏览器交互。工作台、看板、客户、知识、记忆、审批等使用固定示例；模型、Supabase/PostgreSQL、Worker、Mem0、WeKnora 和 Langfuse 由正式应用承载。当前站点无需登录，不实时调用这些服务。

首页先介绍完整产品的背景、场景和业务难点，再沿用四条项目主线：销售 Agent 受控执行、客户记忆与可信知识、专家协作与商机分析、Agent 观测与评测回归。页面标题直接点出 Pi 执行内核和多 Agent，正文说明工具/事件适配、执行分层、事实权威、独立专家子任务与分层评测。简介后的主操作区分两层：首行业务流程与案例描边按钮、唯一深色的静态演示按钮；次行项目亮点、架构与设计取舍、完整技术栈使用醒目的文字链接。桌面与手机均直接展示五入口、不带箭头。业务与两个技术入口指向同一详解页的不同章节；展示页不再突出源码与验收报告链接。具体客户案例、六步业务流程和完整架构收在独立详解页；工作台也可以直接打开业务讲解，旧首页章节链接保持兼容。

首次进入工作台会提示“演示教程”，可选择开始或暂不体验；之后可从工作台或侧栏重开，普通刷新不会重复邀请。教程用一笔商机串起客户信息、记忆、知识、分析、人工决定和执行记录；可随时退出。退出后恢复进入前的探索页面与数据。

本地预览（在本目录执行）：

```sh
python -m http.server 4178 --bind 127.0.0.1
```

打开 `http://127.0.0.1:4178/`。演示资源均为相对路径，页面通过 hash 路由导航。许可见 [LICENSE](LICENSE) 与 [第三方声明](THIRD_PARTY_NOTICES.md)。
