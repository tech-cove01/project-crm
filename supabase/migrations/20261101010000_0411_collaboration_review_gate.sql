-- A bounded review on existing root Runs, separate from overwriteable model runtime state.
alter table public.ai_workbench_runs add column if not exists collaboration_review jsonb;
alter table public.ai_workbench_runs add constraint ai_workbench_collaboration_review_shape
  check (collaboration_review is null or
    (run_kind='root' and jsonb_typeof(collaboration_review)='object'
     and collaboration_review->>'version'='1'
     and collaboration_review->>'status' in ('pending','resolved')));

-- All review changes and guarded mutations share this existing-run/mission-scoped lock.
create or replace function public.fn_assert_ai_collaboration_write_allowed(p_org uuid,p_run uuid)
returns void language plpgsql security definer set search_path=public as $$
declare v_mission uuid; v_root uuid;
begin
  select id,mission_id into v_root,v_mission from public.ai_workbench_runs
    where organization_id=p_org and id=p_run and run_kind='root';
  if not found then raise exception 'collaboration_run_unavailable' using errcode='P0001'; end if;
  perform pg_advisory_xact_lock(hashtextextended('crm_collaboration:'||p_org::text||':'||coalesce(v_mission,v_root)::text,0));
  if exists (select 1 from public.ai_workbench_runs r
     where r.organization_id=p_org and (r.id=p_run or (v_mission is not null and r.mission_id=v_mission))
       and r.collaboration_review is not null
       and coalesce(r.collaboration_review->>'status','pending')<>'resolved') then
    raise exception 'collaboration_review_required' using errcode='P0001';
  end if;
end $$;
revoke all on function public.fn_assert_ai_collaboration_write_allowed(uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_assert_ai_collaboration_write_allowed(uuid,uuid) to service_role;

-- Covers approval SQL/RPC routes as well as the HTTP decision adapter. An error
-- rolls back the approval transaction, including any queued delivery.
create or replace function public.fn_gate_ai_collaboration_proposal()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.status in ('approved','executed') and (tg_op='INSERT' or old.status is distinct from new.status) then
    perform public.fn_assert_ai_collaboration_write_allowed(new.organization_id,new.run_id);
  end if;
  return new;
end $$;
revoke all on function public.fn_gate_ai_collaboration_proposal() from public,anon,authenticated;
create trigger trg_gate_ai_collaboration_proposal before insert or update of status
  on public.ai_agent_action_proposals for each row execute function public.fn_gate_ai_collaboration_proposal();
comment on column public.ai_workbench_runs.collaboration_review is
  'CRM-owned bounded specialist review; pending blocks root/mission actions. Model completion cannot clear it.';
notify pgrst,'reload schema';
