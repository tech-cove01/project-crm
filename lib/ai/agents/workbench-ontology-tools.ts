import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { tool } from "@/lib/agent-engine/edge/llm/run-model-call";
import { planOntologyQuery, resolveOntologyTerms } from "@/lib/ontology/query-plan";
import {
  COMPLETED_APPOINTMENTS,
  parseWorkbenchOntologyWindow,
  WORKBENCH_ONTOLOGY_TOOL,
  workbenchOntologyInputSchema,
  type WorkbenchAppointmentObservation,
  type WorkbenchOntologyInput,
  type WorkbenchOntologyObservation,
} from "./workbench-ontology-contract";
import {
  AUTHORIZED_ONTOLOGY_RUN_SQL,
  hasWorkbenchLeadOntologyAccess,
  queryWorkbenchOpenLeads,
} from "./workbench-ontology-query";

type RunScope = { organizationId: string; runId: string; leadId: string };
type OntologyScope = Omit<RunScope, "leadId"> & {
  leadId: string | null;
  contactId?: string | null;
  pipelineId?: string | null;
};

// Authorization and evidence share one SQL snapshot; even a later tool call
// must satisfy the durable Run's current membership and selected lead again.
const COMPLETED_APPOINTMENTS_SQL = `
  with authorized_scope as (${AUTHORIZED_ONTOLOGY_RUN_SQL}),
  authorized_lead as (
    select lead_id as id, organization_id from authorized_scope where lead_id=$3
  )
  select lead.id as "leadId", activity.id,
         activity.type,
         to_char(activity.performed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "performedAt"
    from authorized_lead lead
    left join lateral (
      select id, type, performed_at
        from public.crm_lead_activities
       where organization_id = lead.organization_id and lead_id = lead.id
         and type = $4 and performed_at >= $5::timestamptz and performed_at < $6::timestamptz
       order by performed_at desc, id
       limit $7
    ) activity on true
   order by activity.performed_at desc, activity.id
`;

const definition = { template: COMPLETED_APPOINTMENTS.template, version: COMPLETED_APPOINTMENTS.version };

export async function queryWorkbenchOntology(
  db: Queryable,
  scope: RunScope,
  input: unknown,
): Promise<WorkbenchAppointmentObservation> {
  const window = parseWorkbenchOntologyWindow(input);
  if (!window) return { ...definition, status: "clarification_required" };

  try {
    const { rows } = await db.query<{
      leadId: string;
      id: string | null;
      type: typeof COMPLETED_APPOINTMENTS.activityType;
      performedAt: string;
    }>(COMPLETED_APPOINTMENTS_SQL, [
      scope.organizationId, scope.runId, scope.leadId, COMPLETED_APPOINTMENTS.activityType,
      window.startUtc, window.endUtc, COMPLETED_APPOINTMENTS.maxRows + 1,
    ]);
    const [authorizedLead] = rows;
    if (!authorizedLead) return { ...definition, status: "forbidden" };
    const activities = rows.slice(0, COMPLETED_APPOINTMENTS.maxRows)
      .flatMap(({ id, type, performedAt }) => id ? [{ id, type, performedAt }] : []);
    const status = rows.length > COMPLETED_APPOINTMENTS.maxRows ? "truncated"
      : activities.length > 0 ? "matched" : "empty";
    return { ...definition, status, scope: { leadId: authorizedLead.leadId }, window, activities };
  } catch {
    return { ...definition, status: "error" };
  }
}

const appointmentMeaning: Record<WorkbenchAppointmentObservation["status"], string> = {
  matched: "这些记录是该 UTC 时间窗口内所选商机的已完成约见活动。",
  empty: "该时间窗内 CRM 无匹配记录。",
  truncated: "已找到记录，但活动列表达到上限，不能把它当作完整列表或总数。可缩小时间窗。",
  clarification_required: "请确认所问是否为已完成约见，并给出含 Z 的明确起止 UTC 时间，窗口最多 31 天。",
  forbidden: "当前运行没有所选商机的读取权限。",
  error: "活动查询失败，无法判断是否有记录。",
};

export async function executeWorkbenchOntology(
  db: Queryable,
  scope: OntologyScope,
  input: WorkbenchOntologyInput,
): Promise<WorkbenchOntologyObservation> {
  const { operation = "query", ...request } = input;
  if (operation === "resolve") {
    const semantics = resolveOntologyTerms(request.question ?? request.template ?? "");
    return { kind: "planning", operation, status: "resolved", semantics };
  }
  const legacyAppointmentQuery = operation === "query" && request.template === COMPLETED_APPOINTMENTS.template;
  if (!request.question && !legacyAppointmentQuery) {
    return {
      kind: "planning", operation, status: "clarification_required", reason: "invalid_input",
      missing: ["请提供包含全部限定条件的用户查询原文。"],
      semantics: resolveOntologyTerms(request.template ?? ""),
    };
  }

  const planned = planOntologyQuery(request, {
    leadId: scope.leadId,
    contactId: scope.contactId ?? null,
    pipelineId: scope.pipelineId ?? null,
  });
  const { catalog, definitions, concepts } = planned;
  const semantics = { catalog, definitions, concepts };
  if (planned.status === "clarification_required") {
    return { kind: "planning", operation, status: planned.status, reason: planned.reason, missing: planned.missing, semantics };
  }
  const { template, window } = planned;
  if (operation === "plan") {
    return { kind: "planning", operation, status: "ready", template, semantics, ...(window ? { window } : {}) };
  }
  if (template === COMPLETED_APPOINTMENTS.template) {
    if (!scope.leadId || !window) return { ...definition, status: "clarification_required", semantics };
    const receipt = await queryWorkbenchOntology(db, { ...scope, leadId: scope.leadId }, { template, ...window });
    return { ...receipt, semantics };
  }

  const receipt = template === "open_leads"
    ? await queryWorkbenchOpenLeads(db, scope, { template })
    : await queryWorkbenchOpenLeads(db, scope, { template, window });
  const context = { kind: "lead_query" as const, template, semantics, ...(window ? { window } : {}) };
  if (!("leads" in receipt)) return { ...context, status: receipt.status };
  return { ...context, ...receipt, coverage: window ? "partial" : "complete" };
}

function meaningFor(result: WorkbenchOntologyObservation): string {
  if (!("kind" in result)) return appointmentMeaning[result.status];
  if (result.kind === "planning") {
    if (result.status === "resolved") return "这些术语来自当前已发布业务目录。只有通过可回答性检查的模板可以执行。";
    if (result.status === "ready") return "参数满足已审核查询口径。当前只检查了可回答性，尚未读取 CRM 记录。";
    return "无法按现有审核口径回答全部问题。请告诉用户下列缺项并保留已知口径和其原有限定条件。";
  }
  const messages = {
    matched: "找到授权范围内符合口径的开放商机。",
    empty: "当前授权范围内 CRM 无符合口径的开放商机。",
    truncated: "符合口径的开放商机超过返回上限。列表不是完整结果或总数，请缩小授权查询范围。",
    forbidden: "当前运行没有该范围内的查询权限。",
    error: "CRM 查询失败，无法判断是否有匹配记录。",
  };
  const caveat = "此口径只检查返回商机在窗口内是否缺少已完成约见记录，无法据此判断从未跟进。";
  return "coverage" in result && result.coverage === "partial" ? `${messages[result.status]}${caveat}` : messages[result.status];
}

export async function mountWorkbenchOntologyTool(
  db: Queryable,
  scope: OntologyScope,
  tools: Record<string, unknown>,
) {
  const observations = new Map<string, WorkbenchOntologyObservation>();
  if (!await hasWorkbenchLeadOntologyAccess(db, scope)) return observations;
  if (WORKBENCH_ONTOLOGY_TOOL in tools) throw new Error("workbench_ontology_tool_name_collision");

  tools[WORKBENCH_ONTOLOGY_TOOL] = {
    ...tool({
      description: "查询审核过的 CRM 业务口径。resolve 查术语，plan 判断可回答性，query 只读执行。" +
        "开放商机使用 open_leads，所选商机的已完成约见使用 completed_appointments，" +
        "开放商机中未找到已完成约见记录使用 open_leads_without_completed_appointments。" +
        "plan、开放商机和组合查询必须提供 question，使用带全部限定条件的原始业务查询。" +
        "高潜、跟进不足等条件没有已审核定义时用 plan 澄清，勿省略条件或猜测。" +
        "约见与组合需要明确含 Z 的起止 UTC 时间，含起点、不含终点，最多 31 天。排期、取消和未到场不算已完成。" +
        "查询读取运行当前授权范围，最多 25 条。用返回值区分空结果、截断、部分覆盖、禁止和失败。" +
        "只有 matched 的已完成约见实际活动可作为所选商机的阶段提案依据。" +
        "用本工具作为阶段提案依据时，在阶段提案的 reason 中写入原始 toolCallId 与实际活动 ID。",
      inputSchema: workbenchOntologyInputSchema,
      execute: async (args, { toolCallId }) => {
        const result = await executeWorkbenchOntology(db, scope, args);
        observations.set(toolCallId, result);
        return {
          content: JSON.stringify({ ...result, toolCallId, message: meaningFor(result) }),
          details: result,
          isError: result.status === "error" || result.status === "forbidden",
        };
      },
    }),
    capability: "read",
    effect: "read",
    resource: "crm_lead_activities",
  };
  return observations;
}
