# Project CRM · 项目展示

AI-native CRM：面向客户经营与销售协作，将客户事实、企业知识、商机分析和人工审批组织成可追踪的销售工作流。

- [在线展示](https://tech-cove01.github.io/project-crm/)
- [CRM 交互演示](https://tech-cove01.github.io/project-crm/demo/index.html#/app/ai/workbench)
- [正式项目与技术说明](https://github.com/tech-cove01/project-crm/tree/main)

本分支使用 HTML、CSS、JavaScript，在 GitHub Pages 展示项目介绍与现有 CRM 界面的浏览器交互。工作台、看板、客户、知识、记忆、审批等使用固定示例；模型、Supabase/PostgreSQL、Worker、Mem0、WeKnora 和 Langfuse 由正式应用承载。当前站点无需登录，不实时调用这些服务。

本地预览（在本目录执行）：

```sh
python -m http.server 4178 --bind 127.0.0.1
```

打开 `http://127.0.0.1:4178/`。演示资源均为相对路径，页面通过 hash 路由导航。许可见 [LICENSE](LICENSE) 与 [第三方声明](THIRD_PARTY_NOTICES.md)。
