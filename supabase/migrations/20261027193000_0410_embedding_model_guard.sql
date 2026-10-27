begin;
-- Keep vector spaces isolated: unknown provenance or model never matches.
create or replace function public.fn_buscar_trechos_das_fontes(
  p_organization_id uuid,
  p_source_ids uuid[],
  p_embedding public.vector,
  p_k integer default 5,
  p_threshold real default 0.40,
  p_embedding_model text default null
) returns table(
  chunk_id uuid,
  knowledge_source_id uuid,
  source_name text,
  content text,
  similarity real,
  metadata jsonb
)
  language plpgsql stable security definer
  set search_path to 'public'
as $$
begin
  if auth.uid() is not null
     and not public.fn_role_at_least(p_organization_id, 'viewer') then
    raise exception 'caller_not_authorized_for_org'
      using hint = 'fn_buscar_trechos_das_fontes: caller must be an active member of the organization';
  end if;

  if p_embedding_model is null or btrim(p_embedding_model) = '' then
    raise exception 'embedding_model_required';
  end if;

  return query
  select
    c.id as chunk_id,
    c.knowledge_source_id,
    s.name as source_name,
    c.content,
    (1 - (c.embedding <=> p_embedding))::real as similarity,
    c.metadata
  from public.ai_chunks c
  join public.ai_knowledge_sources s
    on s.id = c.knowledge_source_id
   and s.organization_id = c.organization_id
  join public.ai_knowledge_versions v
    on v.id = c.kb_version_id
   and v.organization_id = c.organization_id
  where c.organization_id = p_organization_id
    and s.id = any(p_source_ids)
    and s.is_active
    and s.status = 'ready'
    and c.kb_version_id = s.active_kb_version_id
    and (
      p_embedding_model is not null
      and v.embedding_model = p_embedding_model
    )
    and (1 - (c.embedding <=> p_embedding)) >= p_threshold
  order by c.embedding <=> p_embedding asc
  limit greatest(p_k, 0);
end $$;


-- Embedding vectors from different models are not comparable even at equal dimensions.
-- The legacy signature cannot carry provenance, so fail closed instead of returning misleading hits.
create or replace function public.retrieve_top_k_chunks(
  p_organization_id uuid, p_kb_version_id uuid, p_embedding public.vector,
  p_k integer default 5, p_threshold real default 0.40
) returns table (chunk_id uuid, knowledge_source_id uuid, content text, similarity real, metadata jsonb)
  language plpgsql stable security definer set search_path to 'public'
as $$
begin
  if auth.uid() is not null and not public.fn_role_at_least(p_organization_id, 'viewer') then
    raise exception 'caller_not_authorized_for_org';
  end if;
  raise exception 'embedding_model_required' using hint = 'Use retrieve_top_k_chunks_model with exact embedding provenance';
end $$;

create or replace function public.retrieve_top_k_chunks_model(
  p_organization_id uuid, p_kb_version_id uuid, p_embedding public.vector,
  p_k integer, p_threshold real, p_embedding_model text
) returns table (chunk_id uuid, knowledge_source_id uuid, content text, similarity real, metadata jsonb)
  language plpgsql stable security definer set search_path to 'public'
as $$
begin
  if auth.uid() is not null and not public.fn_role_at_least(p_organization_id, 'viewer') then
    raise exception 'caller_not_authorized_for_org';
  end if;
  if p_embedding_model is null or btrim(p_embedding_model) = '' then
    raise exception 'embedding_model_required';
  end if;
  if not exists (select 1 from public.ai_knowledge_versions v
      where v.id = p_kb_version_id and v.organization_id = p_organization_id
        and v.embedding_model = p_embedding_model) then
    raise exception 'embedding_model_mismatch';
  end if;
  return query
  select c.id, c.knowledge_source_id, c.content,
    (1 - (c.embedding <=> p_embedding))::real, c.metadata
  from public.ai_chunks c
  join public.ai_knowledge_versions v on v.id = c.kb_version_id
    and v.organization_id = c.organization_id and v.embedding_model = p_embedding_model
  where c.organization_id = p_organization_id and c.kb_version_id = p_kb_version_id
    and (1 - (c.embedding <=> p_embedding)) >= p_threshold
  order by c.embedding <=> p_embedding asc limit greatest(p_k, 0);
end $$;
revoke execute on function public.retrieve_top_k_chunks_model(uuid, uuid, public.vector, integer, real, text) from public, anon;
grant execute on function public.retrieve_top_k_chunks_model(uuid, uuid, public.vector, integer, real, text) to authenticated, service_role;

notify pgrst, 'reload schema';
commit;
