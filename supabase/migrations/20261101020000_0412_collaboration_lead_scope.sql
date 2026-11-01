-- Final bounded correction: admission is pure; effects/reviews take the same lead lock in application code.
create or replace function public.fn_ai_collaboration_scope_key(p_org uuid,p_run uuid)
returns text language sql stable security definer set search_path=public as $$
  select 'crm_collaboration:'||p_org::text||':'||
    coalesce('lead:'||m.lead_id::text,'lead:'||nullif(r.scope->>'leadId','')::uuid::text,'run:'||r.id::text)
  from public.ai_workbench_runs r left join public.ai_missions m
    on m.organization_id=r.organization_id and m.id=r.mission_id
  where r.organization_id=p_org and r.id=p_run and r.run_kind='root'
$$;
revoke all on function public.fn_ai_collaboration_scope_key(uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_ai_collaboration_scope_key(uuid,uuid) to service_role;

create or replace function public.fn_assert_ai_collaboration_write_allowed(p_org uuid,p_run uuid)
returns void language plpgsql security definer set search_path=public as $$
declare v_scope text; v_created timestamptz;
begin
  select public.fn_ai_collaboration_scope_key(p_org,id),created_at into v_scope,v_created
    from public.ai_workbench_runs where organization_id=p_org and id=p_run and run_kind='root';
  if v_scope is null then raise exception 'collaboration_run_unavailable' using errcode='P0001'; end if;
  if exists (select 1 from public.ai_workbench_runs r
    where r.organization_id=p_org and r.run_kind='root' and r.collaboration_review is not null
      and public.fn_ai_collaboration_scope_key(p_org,r.id)=v_scope
      and coalesce(r.collaboration_review->>'status','pending')<>'resolved') then
    raise exception 'collaboration_review_required' using errcode='P0001';
  end if;
  if exists (select 1 from public.ai_workbench_runs r
    where r.organization_id=p_org and r.run_kind='root' and r.collaboration_review->>'status'='resolved'
      and r.collaboration_review->>'reviewedBy' is not null
      and public.fn_ai_collaboration_scope_key(p_org,r.id)=v_scope
      and v_created<=(r.collaboration_review->>'checkedAt')::timestamptz) then
    raise exception 'collaboration_new_run_required' using errcode='P0001';
  end if;
end $$;
revoke all on function public.fn_assert_ai_collaboration_write_allowed(uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_assert_ai_collaboration_write_allowed(uuid,uuid) to service_role;

create or replace function public.fn_gate_ai_collaboration_proposal()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  -- Never block saving a known receipt for an already approved/in-flight effect.
  -- No advisory lock here: this trigger already holds a proposal row lock.
  if (new.status='approved' and (tg_op='INSERT' or old.status is distinct from new.status))
     or (new.status='executed' and (tg_op='INSERT' or old.status='pending')) then
    perform public.fn_assert_ai_collaboration_write_allowed(new.organization_id,new.run_id);
  end if;
  if new.status='pending' and tg_op='INSERT' then
    perform public.fn_assert_ai_collaboration_write_allowed(new.organization_id,new.run_id);
  end if;
  return new;
end $$;
revoke all on function public.fn_gate_ai_collaboration_proposal() from public,anon,authenticated;
comment on function public.fn_assert_ai_collaboration_write_allowed(uuid,uuid) is
  'Pure same-org lead admission. Effects/reviews use scope_key advisory before row locks; SQL/RPC already-in-flight registration window remains.';
notify pgrst,'reload schema';
