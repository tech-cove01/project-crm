-- Candidate material stays separate from confirmed CRM memory and its outbox.
create table if not exists public.ai_customer_memory_candidates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid not null,
  conversation_id uuid not null,
  message_id uuid not null,
  source_revision text not null check (source_revision ~ '^[a-f0-9]{64}$'),
  quote_start integer not null check (quote_start >= 0),
  quote_end integer not null check (quote_end > quote_start and quote_end <= 2000 and quote_end - quote_start <= 240),
  category text not null check (category in ('preference','confirmed_fact','communication_context')),
  body text not null check (char_length(body) between 1 and 2000),
  extraction_key text not null check (extraction_key ~ '^[a-f0-9]{64}$'),
  status text not null default 'pending' check (status in ('pending','confirmed','rejected')),
  fact_id uuid unique references public.ai_customer_memories(id) on delete cascade,
  decision_hash text check (decision_hash ~ '^[a-f0-9]{64}$'),
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (contact_id, organization_id)
    references public.contacts(id, organization_id) on delete cascade,
  unique (organization_id, contact_id, extraction_key),
  check ((status = 'confirmed') = (fact_id is not null)),
  check ((status = 'pending' and decided_at is null and decided_by is null and decision_hash is null) or
         (status <> 'pending' and decided_at is not null and decision_hash is not null))
);
alter table public.ai_customer_memory_candidates enable row level security;
revoke all on public.ai_customer_memory_candidates from public, anon, authenticated;
grant select, insert, update, delete on public.ai_customer_memory_candidates to service_role;
create index if not exists ai_customer_memory_candidates_contact_idx
  on public.ai_customer_memory_candidates (organization_id, contact_id, created_at desc, id desc);

-- Keep source IDs as provenance even if a message is removed. The application
-- revalidates the current conversation and evidence for every first confirmation.
create or replace function public.fn_ai_customer_memory_candidate_privacy() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if new.is_anonymized or new.is_merged_into is not null then
    delete from public.ai_customer_memory_candidates
      where organization_id=old.organization_id and contact_id=old.id;
  end if;
  return new;
end $$;
revoke all on function public.fn_ai_customer_memory_candidate_privacy() from public, anon, authenticated;
drop trigger if exists trg_ai_customer_memory_candidate_privacy on public.contacts;
create trigger trg_ai_customer_memory_candidate_privacy
  before update of is_anonymized, is_merged_into on public.contacts
  for each row execute function public.fn_ai_customer_memory_candidate_privacy();
notify pgrst,'reload schema';
