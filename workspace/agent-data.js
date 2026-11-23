export const taskOptions = {
  ontology: {
    label: "商机取证",
    title: "核对已完成约见，判断是否推进商机",
    description: "校验业务口径后查询约见，结果可用于当前商机的阶段提案。",
    agent: "销售分析 Agent",
    tool: "crm_query_ontology",
  },
  memory: {
    label: "客户记忆",
    title: "读取当前客户已确认的沟通偏好",
    description: "只读复用当前客户的已确认事实，同时核对客户和来源。",
    agent: "客户经营 Agent",
    tool: "crm_get_contact",
  },
};

export const taskWindow = {
  version: "1.0.0",
  template: "completed_appointments",
  from: "2026-10-26 00:00 UTC",
  to: "2026-11-25 00:00 UTC",
  relation: "crm_lead_activities.lead_id → crm_leads.id",
};

export const proposalInfo = {
  none: { label: "阶段未变更", tone: "neutral" },
  blocked: { label: "证据不足", tone: "gold" },
  pending: { label: "待人工审批", tone: "gold" },
  approved: { label: "已批准 · 待执行", tone: "green" },
  rejected: { label: "已拒绝", tone: "red" },
  executed: { label: "已执行 · 待回查", tone: "green" },
  verified: { label: "已回查", tone: "green" },
};

export const proposalActions = {
  pending: [["approve", "批准提案", "button-primary"], ["reject", "拒绝提案", ""]],
  approved: [["execute", "执行已批准动作", "button-primary"]],
  executed: [["verify", "回查商机与回执", "button-primary"]],
};

export const proposalCopy = {
  pending: "请先核对约见原文。审核人在此处决定是否推进，业务阶段目前保持原状。",
  approved: "批准已记入轨迹。执行会更新本地商机，并产生唯一的执行回执。",
  rejected: "已归档拒绝决定。业务阶段保持原状，执行回执为零。",
  executed: "本地商机已更新，请将当前阶段与回执中的结果对照。",
  verified: "已再次读取当前商机。实际阶段与回执记录一致。",
};

export const publicEvidence = {
  ontology: "../details.html#ontology-walkthrough",
  memory: "../details.html#memory-lifecycle",
};
