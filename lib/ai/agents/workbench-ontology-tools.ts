import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { tool } from "@/lib/agent-engine/edge/llm/run-model-call";
import {
  COMPLETED_APPOINTMENTS,
  parseWorkbenchOntologyWindow,
  WORKBENCH_ONTOLOGY_TOOL,
  workbenchOntologyInputSchema,
  type WorkbenchOntologyObservation,
} from "./workbench-ontology-contract";

type RunScope = { organizationId: string; runId: string; leadId: string };

// The worker connection can bypass RLS. Match the current org-wide read branch
// of fn_can_view_lead for manager/admin, with live membership and object binding.
const AUTHORIZED_LEAD_SQL = `
  select lead.id, lead.organization_id
    from public.ai_workbench_runs run
    join public.user_organizations member
      on member.organization_id = run.organization_id and member.user_id = run.actor_user_id
     and member.accepted_at is not null and member.revoked_at is null
     and member.role in ('manager', 'admin')
    join public.crm_leads lead
      on lead.organization_id = run.organization_id and lead.id = $3
     and lead.id::text = lower(run.scope->>'leadId')
     and (run.scope->>'contactId' is null or lead.contact_id::text = lower(run.scope->>'contactId'))
     and (run.scope->>'pipelineId' is null or lead.pipeline_id::text = lower(run.scope->>'pipelineId'))
    join public.crm_pipelines pipeline
      on pipeline.organization_id = lead.organization_id and pipeline.id = lead.pipeline_id
     and pipeline.is_archived is false
   where run.organization_id = $1 and run.id = $2
     and run.run_kind = 'root' and run.parent_run_id is null and run.status = 'running'
`;

// Authorization and evidence share one SQL snapshot; even a later tool call
// must satisfy the durable Run's current membership and selected lead again.
const COMPLETED_APPOINTMENTS_SQL = `
  with authorized_lead as (${AUTHORIZED_LEAD_SQL})
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
): Promise<WorkbenchOntologyObservation> {
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

const meaning: Record<WorkbenchOntologyObservation["status"], string> = {
  matched: "这些记录是该 UTC 时间窗口内所选商机的已完成约见活动。",
  empty: "该时间窗内 CRM 无匹配记录。",
  truncated: "已找到记录，但活动列表达到上限，不能把它当作完整列表或总数。可缩小时间窗。",
  clarification_required: "请确认所问是否为已完成约见，并给出含 Z 的明确起止 UTC 时间，窗口最多 31 天。",
  forbidden: "当前运行没有所选商机的读取权限。",
  error: "活动查询失败，无法判断是否有记录。",
};

export async function mountWorkbenchOntologyTool(
  db: Queryable,
  scope: Omit<RunScope, "leadId"> & { leadId: string | null },
  tools: Record<string, unknown>,
) {
  const observations = new Map<string, WorkbenchOntologyObservation>();
  const { leadId, organizationId, runId } = scope;
  if (!leadId) return observations;
  const authorized = await db.query(AUTHORIZED_LEAD_SQL, [organizationId, runId, leadId])
    .then(({ rows }) => rows.length > 0).catch(() => false);
  if (!authorized) return observations;
  if (WORKBENCH_ONTOLOGY_TOOL in tools) throw new Error("workbench_ontology_tool_name_collision");

  tools[WORKBENCH_ONTOLOGY_TOOL] = {
    ...tool({
      description: "只读查询当前所选商机的已完成约见。唯一模板为 completed_appointments（v1）。" +
        "按活动 performed_at 查询含起点、不含终点的 UTC 时间窗，最多 31 天，最多返回 25 条。" +
        "排期、取消和未到场不算已完成。用户未给出明确时间窗、或所问指标超出模板时，先澄清。" +
        "matched 的真实活动可作为阶段提案依据。truncated 时请缩小时间窗后重查。empty 表示 CRM 在此窗内没有匹配记录，" +
        "error 和 forbidden 则无法判断。需要以约见为提案依据时，先读取本工具结果，再决定是否提案。" +
        "用本工具作为阶段提案依据时，在阶段提案的 reason 中写入原始 toolCallId 与实际活动 ID。",
      inputSchema: workbenchOntologyInputSchema,
      execute: async (args, { toolCallId }) => {
        const result = await queryWorkbenchOntology(db, { organizationId, runId, leadId }, args);
        observations.set(toolCallId, result);
        return {
          content: JSON.stringify({ ...result, toolCallId, message: meaning[result.status] }),
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
