# CRM-025b 安全基线接续

原始四根与 69 条 Wiki 探针继续绑定产品 `2d5d411` 和原 `baseline/freeze.json`。共同范围保护固定为 `59da3c47b8272fb89795445abdb115011cf91f6a`。剩余基线从 D03 起，原四根及用量仍计入总账本。保留集质量在候选固定前继续封存。[规划决定与共同保护](CRM-025-scope-review.md) · [首次基线](CRM-025b-baseline.md)

## 环境恢复与授权预检

用原数据库复用 96 个对象范围、160 条确认事实及 28 篇共享现行 Wiki 页面，恢复同一合成普通销售的原 `agent` 角色，启动本轮隔离 Web `3415` 与 Worker `8795`。CRM 现行资料源重启后产生新来源 revision，现行权限回执按新 revision 追加；原页 UUID、页版本、正文、授权语义和原回执保持。新 Wiki Key 只授权共同现行库读操作，新 Key 读取已知页 200，旧 Key 401。历史 fixture、runtime、preflight 和基线归档保持原字节。

完整恢复预检按 ID 读回 28/28 现行证据；旧版、撤回和异租户三条 CRM 证据均实际返回 404，异租户 CRM 来源 404。经理 Workbench GET 200，普通销售 GET 403，真实 POST 槽留给正式运行。原四个草稿保留，恢复附加版本在原生 reseed 前后均稳定。无新增模型请求。

| 本地冻结凭据（`.local/crm025/`） | SHA-256 |
| --- | --- |
| `environment-recovery-plan.json` | `35e2d270afd32c25670e3af1cbf255fdacc1bc0975d6d1e54947c1570db24107` |
| `fixtures-recovered.json` | `fcab72343d388045422d5a8af5a7a5372dda3506f9a270a196460e363e4d468f` |
| `runtime-recovered.env`（私有） | `3c55df27c6087c63ddc44fab4cf229a8c8899db75e219cfd2fa9899f5a563e00` |
| `preflight-recovered.json` | `32e07b7b882d6b8a83136955b16c4780aff9a79a940aa1225d952c4c7c82610e` |
