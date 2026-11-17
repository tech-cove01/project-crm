import type { Queryable } from "@/lib/agent-engine/queue/queue";
import {
  COMPLETED_APPOINTMENT_TYPE,
  ONTOLOGY_MAX_ROWS,
  OPEN_LEAD_STATUS,
  type OntologyWindow,
} from "@/lib/ontology/contract";

type RunIdentity = { organizationId: string; runId: string };
type OpenLeadQuery =
  | { template: "open_leads" }
  | { template: "open_leads_without_completed_appointments"; window: OntologyWindow };

export type AuthorizedOntologyScope = {
  leadId?: string;
  contactId?: string;
  pipelineId?: string;
  conversationId?: string;
};

type OpenLeadEvidence = { id: string; status: typeof OPEN_LEAD_STATUS; pipelineId: string; stageId: string };
type OpenLeadResult =
  | { status: "matched" | "empty" | "truncated"; scope: AuthorizedOntologyScope; leads: OpenLeadEvidence[] }
  | { status: "forbidden" | "error" };

// The worker's connection can bypass RLS. Enforce the direct manager/admin
// branch of fn_can_view_lead against live membership and the durable parent Run.
// A malformed scope must never degrade to organization-wide access.
export const AUTHORIZED_ONTOLOGY_RUN_SQL = `
  with durable_run as materialized (
    select run.id, run.organization_id, run.scope
      from public.ai_workbench_runs run
      join public.user_organizations member
        on member.organization_id = run.organization_id and member.user_id = run.actor_user_id
       and member.accepted_at is not null and member.revoked_at is null
       and member.role in ('manager', 'admin')
     where run.organization_id = $1 and run.id = $2
       and run.run_kind = 'root' and run.parent_run_id is null and run.status = 'running'
       and jsonb_typeof(run.scope) = 'object'
       and not exists (
         select 1
           from jsonb_each_text(case when jsonb_typeof(run.scope) = 'object' then run.scope else '{}'::jsonb end)
             as field(name, value)
          where field.name not in ('leadId', 'contactId', 'pipelineId', 'conversationId')
             or field.value is null
             or field.value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       )
  ), selected as (
    select id, organization_id,
           (scope->>'leadId')::uuid as lead_id,
           (scope->>'contactId')::uuid as contact_id,
           (scope->>'pipelineId')::uuid as pipeline_id,
           (scope->>'conversationId')::uuid as conversation_id
      from durable_run
  )
  select selected.organization_id, selected.id as run_id,
         selected.lead_id,
         contact.id as contact_id,
         pipeline.id as pipeline_id,
         selected.conversation_id
    from selected
    left join public.conversations conversation
      on conversation.organization_id = selected.organization_id
     and conversation.id = selected.conversation_id and conversation.is_group is false
     and conversation.contact_id is not null
     and (selected.contact_id is null or conversation.contact_id = selected.contact_id)
    left join public.crm_leads lead
      on lead.organization_id = selected.organization_id and lead.id = selected.lead_id
     and (selected.contact_id is null or lead.contact_id = selected.contact_id)
     and (selected.pipeline_id is null or lead.pipeline_id = selected.pipeline_id)
     and (selected.conversation_id is null or lead.contact_id = conversation.contact_id)
    left join public.contacts contact
      on contact.organization_id = selected.organization_id
     and contact.id = coalesce(selected.contact_id, conversation.contact_id, lead.contact_id)
    left join public.crm_pipelines pipeline
      on pipeline.organization_id = selected.organization_id
     and pipeline.id = coalesce(selected.pipeline_id, lead.pipeline_id) and pipeline.is_archived is false
   where (selected.conversation_id is null or conversation.id is not null)
     and (selected.lead_id is null or lead.id is not null)
     and (coalesce(selected.contact_id, conversation.contact_id, lead.contact_id) is null or contact.id is not null)
     and (coalesce(selected.pipeline_id, lead.pipeline_id) is null or pipeline.id is not null)
`;

const OPEN_LEADS_WITHOUT_APPOINTMENT_FILTER = `
       and not exists (
         select 1 from public.crm_lead_activities appointment
          where appointment.organization_id = lead.organization_id and appointment.lead_id = lead.id
            and appointment.type = $5 and appointment.performed_at >= $6::timestamptz
            and appointment.performed_at < $7::timestamptz
       )
`;

// Retain the authorized row even when the result set is empty. The execution
// then distinguishes authorized emptiness from denial without a second query.
const openLeadsSql = (appointmentFilter: string) => `
  with authorized_scope as (${AUTHORIZED_ONTOLOGY_RUN_SQL})
  select scope.lead_id as "scopeLeadId", scope.contact_id as "scopeContactId",
         scope.pipeline_id as "scopePipelineId", scope.conversation_id as "scopeConversationId",
         result.id, result.pipeline_id as "pipelineId", result.stage_id as "stageId"
    from authorized_scope scope
    left join lateral (
      select lead.id, lead.pipeline_id, lead.stage_id
        from public.crm_leads lead
        join public.crm_pipelines pipeline
          on pipeline.organization_id = lead.organization_id and pipeline.id = lead.pipeline_id
         and pipeline.is_archived is false
       where lead.organization_id = scope.organization_id and lead.status = $3
         and (scope.lead_id is null or lead.id = scope.lead_id)
         and (scope.contact_id is null or lead.contact_id = scope.contact_id)
         and (scope.pipeline_id is null or lead.pipeline_id = scope.pipeline_id)
         ${appointmentFilter}
       order by lead.id
       limit $4
    ) result on true
   order by result.id
`;

const OPEN_LEADS_SQL = openLeadsSql("");
const OPEN_LEADS_WITHOUT_APPOINTMENT_SQL = openLeadsSql(OPEN_LEADS_WITHOUT_APPOINTMENT_FILTER);

type OpenLeadRow = {
  scopeLeadId: string | null;
  scopeContactId: string | null;
  scopePipelineId: string | null;
  scopeConversationId: string | null;
} & (
  | { id: string; pipelineId: string; stageId: string }
  | { id: null; pipelineId: null; stageId: null }
);

export async function hasWorkbenchLeadOntologyAccess(db: Queryable, run: RunIdentity): Promise<boolean> {
  try {
    const { rows } = await db.query(AUTHORIZED_ONTOLOGY_RUN_SQL, [run.organizationId, run.runId]);
    return rows.length > 0;
  } catch {
    return false;
  }
}

export async function queryWorkbenchOpenLeads(
  db: Queryable,
  run: RunIdentity,
  plan: OpenLeadQuery,
): Promise<OpenLeadResult> {
  const params = [run.organizationId, run.runId, OPEN_LEAD_STATUS, ONTOLOGY_MAX_ROWS + 1];
  const withAppointmentWindow = plan.template === "open_leads_without_completed_appointments";
  if (withAppointmentWindow)
    params.push(COMPLETED_APPOINTMENT_TYPE, plan.window.startUtc, plan.window.endUtc);

  try {
    const { rows } = await db.query<OpenLeadRow>(
      withAppointmentWindow ? OPEN_LEADS_WITHOUT_APPOINTMENT_SQL : OPEN_LEADS_SQL,
      params,
    );
    const [authorized] = rows;
    if (!authorized) return { status: "forbidden" };
    const { scopeLeadId, scopeContactId, scopePipelineId, scopeConversationId } = authorized;
    const scope = {
      ...(scopeLeadId ? { leadId: scopeLeadId } : {}),
      ...(scopeContactId ? { contactId: scopeContactId } : {}),
      ...(scopePipelineId ? { pipelineId: scopePipelineId } : {}),
      ...(scopeConversationId ? { conversationId: scopeConversationId } : {}),
    };
    const leads = rows.slice(0, ONTOLOGY_MAX_ROWS).flatMap<OpenLeadEvidence>(({ id, pipelineId, stageId }) =>
      id === null ? [] : [{ id, status: OPEN_LEAD_STATUS, pipelineId, stageId }],
    );
    const status = rows.length > ONTOLOGY_MAX_ROWS ? "truncated" : leads.length ? "matched" : "empty";
    return { status, scope, leads };
  } catch {
    return { status: "error" };
  }
}
