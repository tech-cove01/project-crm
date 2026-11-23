export const crmProfiles = {
  ridge: {
    channel: "邮件", owner: "林序", unread: 2, human: true, industry: "储能运营",
    stageDays: 3, priority: "高", risk: "",
    entries: [
      { kind: "customer", time: "11 月 20 日 14:08", text: "首期先挑两个站点。我们想弄清现有告警在哪一步进入工单，以及夜间误报怎么处理。" },
      { kind: "team", time: "11 月 20 日 14:36", text: "可以。技术访谈先梳理您当前的分级告警、工单入口和联系人，接口范围确认后再形成建议。" },
      { kind: "activity", time: "11 月 21 日 11:00", text: "技术访谈已完成，关联活动 ACT-1121。" },
      { kind: "team", time: "11 月 21 日 11:32", text: "访谈纪要记下了两个试点站点。下一步我们先准备告警字段清单，请您确认哪些告警需要夜间通知。", source: "技术访谈纪要 · ACT-1121" },
    ],
  },
  bridge: {
    channel: "站内会话", owner: "陈遥", unread: 1, human: false, industry: "冷链运输",
    stageDays: 8, priority: "高",
    risk: "试点车辆范围仍待确认，当前没有已完成的技术约见记录。",
    entries: [
      { kind: "customer", time: "11 月 21 日 09:15", text: "现在夜班值班员要手动查运单。希望同一辆车连续超温时只提醒一次。" },
      { kind: "team", time: "11 月 21 日 13:22", text: "我们先核对温度源和车辆编号。请圈定试点线路，告警阈值需要在技术沟通时一起确认。" },
      { kind: "activity", time: "11 月 22 日 14:10", text: "已记录待办：确认首批试点车辆名单。完成约见暂未回执。" },
      { kind: "team", time: "11 月 23 日 10:11", text: "收到上周冷链异常汇总。导出字段我先与值班团队确认，等试点车辆名单一起核对。", source: "客户提交的异常汇总 · 站内会话" },
    ],
  },
  gallery: {
    channel: "邮件", owner: "许岸", unread: 0, human: false, industry: "展馆运营",
    stageDays: 6, priority: "中",
    risk: "预约改造正在评估，维护窗口尚未进入已确认记忆。",
    entries: [
      { kind: "customer", time: "11 月 20 日 11:03", text: "团体预约希望提前锁定两个时段，个人参观可以沿用现场自助入场。" },
      { kind: "team", time: "11 月 20 日 12:26", text: "我先把团体名额、时段与临时取消的规则整理到同一份核对表。" },
      { kind: "activity", time: "11 月 22 日 10:40", text: "收到现行展馆预约规则，待核对节假日与闭馆日口径。" },
      { kind: "team", time: "11 月 23 日 16:55", text: "现行预约规则已收到。请选择不影响团队接待的维护窗口，变更范围仍需确认。", source: "展馆预约规则 · 资料收到记录" },
    ],
  },
};

export const crmTemplates = [
  { id: "recap", label: "纪要确认", text: "这是本次沟通的核对摘要。请确认记录是否准确，特别是业务约束、联系人和下一步的负责人。" },
  { id: "materials", label: "请补充材料", text: "为继续评估，请补充本次涉及的对象范围和现行处理规则。收到后我们会先核对，再反馈可确认的下一步。" },
  { id: "handoff", label: "人工接手", text: "您好，我是本次跟进负责人。我会先查看您已提供的资料与诉求，再和您核对后续安排。" },
];
