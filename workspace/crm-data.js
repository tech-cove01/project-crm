export const crmProfiles = {
  ridge: {
    channel: "邮件", channelKind: "mail", owner: "林序", unread: 2, human: true, industry: "储能运营",
    stageDays: 3, priority: "高", risk: "", at: "16:22", day: "today",
    tag: { text: "需人工接管", tone: "warning" },
    phone: "+86 138-0000-1024", email: "zhou.jin@hengyuan.example",
    aiDraft: "周先生您好，站点告警接口清单已按告警等级整理完毕。夜间通知默认走邮件，只有紧急故障才触发电话，和您上次确认的口径一致。字段表我发到您邮箱，方便的话周三前给个反馈？",
    entries: [
      { kind: "customer", time: "8 月 20 日 14:08", text: "首期先挑两个站点。我们想弄清现有告警在哪一步进入工单，以及夜间误报怎么处理。" },
      { kind: "team", time: "8 月 20 日 14:36", text: "可以。技术访谈先梳理您当前的分级告警、工单入口和联系人，接口范围确认后再形成建议。", source: "引用知识库 · 接入规范 v3" },
      { kind: "activity", time: "8 月 21 日 11:00", text: "技术访谈已完成，关联活动 ACT-1121。" },
      { kind: "team", time: "8 月 21 日 11:32", text: "访谈纪要记下了两个试点站点。下一步我们先准备告警字段清单，请您确认哪些告警需要夜间通知。", source: "技术访谈纪要 · ACT-1121" },
    ],
  },
  bridge: {
    channel: "企业微信", channelKind: "wx", owner: "陈遥", unread: 1, human: false, industry: "冷链运输",
    stageDays: 8, priority: "高", at: "15:10", day: "today",
    tag: { text: "温度阈值待确认", tone: "info" },
    phone: "+86 139-0000-2087", email: "luo.manning@shunjie.example",
    aiDraft: "罗经理您好，异常明细的 CSV 已按车辆、线路、异常时间排好表头。首批试点车辆名单确认后就能开通试跑，您看这周能否定下来？",
    risk: "试点车辆范围仍待确认，当前没有已完成的技术约见记录。",
    entries: [
      { kind: "customer", time: "8 月 21 日 09:15", text: "现在夜班值班员要手动查运单。希望同一辆车连续超温时只提醒一次。" },
      { kind: "team", time: "8 月 21 日 13:22", text: "我们先核对温度源和车辆编号。请圈定试点线路，告警阈值需要在技术沟通时一起确认。" },
      { kind: "activity", time: "8 月 22 日 14:10", text: "已记录待办：确认首批试点车辆名单。完成约见暂未回执。" },
      { kind: "team", time: "8 月 23 日 10:11", text: "收到上周冷链异常汇总。导出字段我先与值班团队确认，等试点车辆名单一起核对。", source: "客户提交的异常汇总 · 站内会话" },
    ],
  },
  gallery: {
    channel: "邮件", channelKind: "mail", owner: "许岸", unread: 1, human: false, industry: "展馆运营",
    stageDays: 6, priority: "中", at: "14:05", day: "today",
    tag: { text: "维护窗口已定", tone: "success" },
    phone: "+86 137-0000-3312", email: "meng.qiao@jincheng.example",
    aiDraft: "孟老师您好，维护窗口按您说的周一上午排，会避开团队接待时段。团体预约的临时取消规则还需您确认一版，确认后我们出改造排期。",
    risk: "预约改造正在评估，维护窗口尚未进入已确认记忆。",
    entries: [
      { kind: "customer", time: "8 月 20 日 11:03", text: "团体预约希望提前锁定两个时段，个人参观可以沿用现场自助入场。" },
      { kind: "team", time: "8 月 20 日 12:26", text: "我先把团体名额、时段与临时取消的规则整理到同一份核对表。" },
      { kind: "activity", time: "8 月 22 日 10:40", text: "收到现行展馆预约规则，待核对节假日与闭馆日口径。" },
      { kind: "team", time: "8 月 23 日 16:55", text: "现行预约规则已收到。请选择不影响团队接待的维护窗口，变更范围仍需确认。", source: "展馆预约规则 · 资料收到记录" },
    ],
  },
  harbor: {
    channel: "站内会话", channelKind: "chat", owner: "林序", unread: 0, human: true, industry: "连锁零售",
    stageDays: 4, priority: "高", at: "11:42", day: "today",
    tag: { text: "条款待复核", tone: "error" },
    phone: "+86 136-0000-4471", email: "shen.zhao@jiahe.example",
    aiDraft: "沈总您好，补货建议会按门店拆分下发，店长只能看到本店数据。门店权限范围确认后，我们先挑三家门店试跑两周。",
    risk: "门店分权范围未确认，方案复核阶段的交付边界仍待补充。",
    entries: [
      { kind: "customer", time: "8 月 25 日 10:20", text: "补货建议按门店分开发，我们店长只看自己那一家。" },
      { kind: "team", time: "8 月 25 日 10:44", text: "明白，权限按门店隔离。需要先确认三家试跑门店和店长的可见字段。", source: "引用知识库 · 门店权限说明" },
      { kind: "customer", time: "8 月 25 日 11:30", text: "字段这块我让IT同事一起对，别把成本数据放进去。" },
    ],
  },
  nanshan: {
    channel: "企业微信", channelKind: "wx", owner: "许岸", unread: 0, human: false, industry: "文化消费",
    stageDays: 11, priority: "中", at: "08-16", day: "earlier",
    tag: { text: "技术对接", tone: "info" },
    phone: "+86 135-0000-5583", email: "ke.yi@yunchuang.example",
    aiDraft: null,
    risk: "会员分层口径未落定，商机在当前阶段停留偏久。",
    entries: [
      { kind: "customer", time: "8 月 16 日 15:02", text: "会员分层先按消费频次做，标签我们后面再补。" },
      { kind: "team", time: "8 月 16 日 16:20", text: "好，先按频次分三层。标签体系我们留到试跑后再定，避免一次改太多。" },
      { kind: "activity", time: "8 月 16 日 16:40", text: "已将会员字段清单发给客户，等待确认字段归属。" },
    ],
  },
};

export const crmTemplates = [
  { id: "recap", label: "纪要确认", text: "这是本次沟通的核对摘要。请确认记录是否准确，特别是业务约束、联系人和下一步的负责人。" },
  { id: "materials", label: "请补充材料", text: "为继续评估，请补充本次涉及的对象范围和现行处理规则。收到后我们会先核对，再反馈可确认的下一步。" },
  { id: "handoff", label: "人工接手", text: "您好，我是本次跟进负责人。我会先查看您已提供的资料与诉求，再和您核对后续安排。" },
  { id: "scope", label: "范围与周期", text: "按当前确认的范围，首期试点可在三周内上线：第一周对接字段与权限，第二周联调，第三周试跑并核对回执。" },
  { id: "guard", label: "外发护栏说明", text: "本次回复仍由人工确认后外发，系统不会自动触达客户。涉及金额与合同条款的内容会保留人工复核环节。" },
];
