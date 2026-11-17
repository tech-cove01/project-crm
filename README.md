# Project CRM · 项目展示

面向销售团队的 AI-native 客户经营与协作系统。选定客户和商机后，Agent 给出带来源的跟进建议；阶段变更由负责人审批，获批后执行并回查，拒绝则保留原阶段。

- [在线展示](https://tech-cove01.github.io/project-crm/)
- [业务与实现详解](https://tech-cove01.github.io/project-crm/details.html)
- [验证方法与结果](https://tech-cove01.github.io/project-crm/details.html#validation)
- [CRM 交互演示](https://tech-cove01.github.io/project-crm/demo/index.html?scenario=execution&guide=1#/app/ai/workbench)
- [正式项目与技术说明](https://github.com/tech-cove01/project-crm/tree/main)

本分支使用 HTML、CSS、JavaScript，在 GitHub Pages 展示项目介绍与现有 CRM 界面的浏览器交互。工作台、看板、客户、知识、记忆、审批等使用固定示例；模型、Supabase/PostgreSQL、Worker、Mem0、WeKnora 和 Langfuse 由正式应用承载。当前站点无需登录，不实时调用这些服务。

首页和详情沿四项设计介绍客户跟进。首页保留业务案例、审批演示、项目亮点、架构和完整技术栈入口。详情保留完整业务和技术说明，在「验证方法与结果」补充合成样本的检索、记忆、泛化、审批和观测范围。

四项介绍使用既有导览。每步定位一个实际控件，操作成功后高亮并解释结果。批准、拒绝和分支切换由访客点击；可暂停，或在明确选择后继续已有状态、清空重走。刷新回到场景起点。

| 主题 | 场景与证据入口 |
| --- | --- |
| Pi 执行与销售审批 | [模拟批准、拒绝与回查](https://tech-cove01.github.io/project-crm/demo/index.html?scenario=execution&guide=1#/app/ai/workbench) |
| 跨会话记忆与事实更新 | [模拟读取 SQL 事实来源](https://tech-cove01.github.io/project-crm/demo/index.html?scenario=knowledge&guide=1#/app/ai/workbench) · [真实跨会话对照](https://tech-cove01.github.io/project-crm/details.html#memory-comparison) |
| 企业知识检索与引用依据 | [模拟资料改版与旧引用拒绝](https://tech-cove01.github.io/project-crm/demo/index.html?scenario=knowledge&guide=1#/app/ai/workbench) · [检索前后对照](https://tech-cove01.github.io/project-crm/details.html#retrieval-comparison) |
| 效果对照与运行观测 | [体验错引判定与失败回放](https://tech-cove01.github.io/project-crm/demo/index.html?scenario=evaluation&guide=1#/app/ai/workbench) · [模拟专家取证与冲突复核](https://tech-cove01.github.io/project-crm/demo/index.html?scenario=collaboration&guide=1#/app/ai/workbench) |

场景状态与原自由探索隔离。通用工作台首次推荐受控执行，也可跳过；“跟我操作”可重开。四场景内不会打开旧教程而丢失所选场景；返回自由探索后仍可显式打开旧七步教程。窄屏提示卡让开目标，滚离后可用“定位当前按钮”返回。所有状态变化和Judge分数均为明示模拟；公开真实验证记录放在详情和场景的次要说明内，保留原限制。

本地预览（在本目录执行）：

```sh
python -m http.server 4178 --bind 127.0.0.1
```

打开 `http://127.0.0.1:4178/`。演示资源均为相对路径，页面通过 hash 路由导航。许可见 [LICENSE](LICENSE) 与 [第三方声明](THIRD_PARTY_NOTICES.md)。
