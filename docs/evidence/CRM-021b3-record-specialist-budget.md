# CRM-021b3：单记录专家提前收束

2026-11-01。本实现与离线回归记录完成时，尚无修复后的新真实模型 Run；随后逐次失败与最终有限复查见[真实协作证据](CRM-021b-collaboration-verified.md)。旧 CRM-020、021 的失败与原分母保留。

## 已确认的不同失败

在清洁源码 `1f99c476570f240f0090b64e16708d321f9794be` 的后继 root `132fd6b2-4373-4f82-8b00-abce13f7e6e7` 中，父提交已经被接受，final_text 为 333 字符，result_document 非空。客户 child 首轮成功读取联系人后，在第二轮继续请求没有暴露的 `crm_get_lead`，Pi 返回 `Tool crm_get_lead not found`。该 child 真实保持 partial/failed_tool_observations，协作复核为 pending，父任务正确保持 partial/collaboration_review_required；政策与商机 child 正常。

这次不是空摘要或结果 schema 未接受。三轮 ceiling 使单记录角色在成功读取后仍有一个可调用工具的中间阶段；只缩工具清单与补提示不足以消除这段多余阶段。原始错误没有被忽略。

私有 source 为 `.local/crm021/collaboration-recheck/47a0bc5b-4a22-4ab4-a096-0432013dd984/source-1793516234863-90a4573a-aaf7-4708-a0be-1beec56aa4df.json`，SHA-256 `75fd5dd74b27958377345812d143b9d63d3fe3677b3e636a3ef421ef3da6b302`。原 review SHA-256 `ea8fdd08b5bdc8f369fe99240c80cea2289dc96ecf245df259e6c9b5cbe2e02a`。本修复没有覆盖这些文件或重新执行该 Run。

## 最小变更与直接检查

仅在 collaboration executor 已建立实际工具集合后，为客户与商机记录角色计算：

```text
effective maxSteps = min(plan.maxTurnsPerSpecialist, 实际暴露记录工具数 + 1)
```

单联系人/商机最多两轮：一次读取、一次已有的无工具正文。显式选择联系人与会话且两工具实际可用时，仍最多三轮。没有可用工具则只留一轮报告缺口，仍 partial。政策角色保持原三轮，以容纳同一搜索工具的两次不同查询。既有计划 revision 3、已声明的三轮 ceiling 与工具面不变，本次只是按实际工具数使用更低的执行上限。

继续使用 `finalTurn.allowedToolNames=[]`；组织策略、scope/org 校验、预算停止、错误与缺口的 partial、待复核动作阻断均未改变。没有新增 callback、增加总预算、把错误改成成功，或按题号/Run ID 分支；parent 的提交纠错与更广调查能力也不改。

`workbench-collaboration.test.ts` 最终 **12 passed**，其中直接使用当前 Pi 0.86.1 与本地 faux provider 验证：单记录第二请求已看不到工具；显式双记录仍可两次读取后输出；即便在无工具最终阶段仍幻觉请求其他工具，也继续 partial。另用隔离模型调用替身断言政策仍为三轮、无工具 scope 仍 partial。`collaboration-runtime.test.ts` 的 **13 项**在本改动下通过，合计 25 项直接相关检查。首组两文件为 24 passed，追加“末阶段仍幻觉必须 partial”反例后只重跑受影响文件，12 项通过，没有重复运行无关测试。

两变更源码/测试文件的限定 ESLint、全仓 `tsc --noEmit -p tsconfig.typecheck.json` 与 `git diff --check` 通过。独立审查通过，已修正测试说明中 Pi 实跑与调用替身的范围区分。本实现切片只读旧证据、修改 `lib/ai/agents/workbench-collaboration.ts` 与对应测试，并写本记录；当时没有 SQL、HTTP、模型或服务操作。后继真实验证已另行封存于[真实协作证据](CRM-021b-collaboration-verified.md)，原132失败/pending不改。
