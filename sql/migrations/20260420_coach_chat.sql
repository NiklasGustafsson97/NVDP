-- Migration: create coach chat tables (threads, messages, memory) + RLS for the
-- conversational AI coach feature. Mirrors the RLS pattern from
-- 20260419_weekly_checkins.sql. Safe to re-run.

create extension if not exists "pgcrypto";

-- ────────────────────────────────────────────────────────────────────────────
-- coach_threads — one row per chat thread. Typically one 'active' per profile.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.coach_threads (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  title text,
  last_message_at timestamptz,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint ct_status_check check (status in ('active', 'archived'))
);

create index if not exists coach_threads_profile_idx
  on public.coach_threads (profile_id, last_message_at desc nulls last);

-- Only one active thread per profile.
create unique index if not exists coach_threads_one_active_per_profile
  on public.coach_threads (profile_id) where status = 'active';

alter table public.coach_threads enable row level security;

do $$ begin
  create policy "ct_select_own" on public.coach_threads
    for select to authenticated
    using (profile_id in (select id from public.profiles where user_id = auth.uid()));
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "ct_insert_own" on public.coach_threads
    for insert to authenticated
    with check (profile_id in (select id from public.profiles where user_id = auth.uid()));
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "ct_update_own" on public.coach_threads
    for update to authenticated
    using (profile_id in (select id from public.profiles where user_id = auth.uid()))
    with check (profile_id in (select id from public.profiles where user_id = auth.uid()));
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "ct_delete_own" on public.coach_threads
    for delete to authenticated
    using (profile_id in (select id from public.profiles where user_id = auth.uid()));
exception when duplicate_object then null;
end $$;

-- ────────────────────────────────────────────────────────────────────────────
-- coach_messages — one row per turn (user/assistant/tool/system).
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.coach_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.coach_threads (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  role text not null,
  content text,
  chips jsonb,
  tool_calls jsonb,
  tool_result jsonb,
  created_at timestamptz not null default now(),
  constraint cm_role_check check (role in ('user', 'assistant', 'tool', 'system'))
);

create index if not exists coach_messages_thread_idx
  on public.coach_messages (thread_id, created_at);

create index if not exists coach_messages_profile_unread_idx
  on public.coach_messages (profile_id, created_at desc)
  where role = 'assistant';

alter table public.coach_messages enable row level security;

do $$ begin
  create policy "cm_select_own" on public.coach_messages
    for select to authenticated
    using (profile_id in (select id from public.profiles where user_id = auth.uid()));
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "cm_insert_own" on public.coach_messages
    for insert to authenticated
    with check (profile_id in (select id from public.profiles where user_id = auth.uid()));
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "cm_update_own" on public.coach_messages
    for update to authenticated
    using (profile_id in (select id from public.profiles where user_id = auth.uid()))
    with check (profile_id in (select id from public.profiles where user_id = auth.uid()));
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "cm_delete_own" on public.coach_messages
    for delete to authenticated
    using (profile_id in (select id from public.profiles where user_id = auth.uid()));
exception when duplicate_object then null;
end $$;

-- ────────────────────────────────────────────────────────────────────────────
-- coach_memory — single row per profile with rolling summary + structured facts.
-- facts shape (example):
--   {
--     "preferred_rest_days": ["monday"],
--     "current_niggles": { "right_achilles": { "status": "active", "first_mentioned": "2026-04-14" } },
--     "motivators": ["sub-1:45 halvmara"],
--     "race_targets": [ { "name": "Stockholm Halvmara", "date": "2026-09-13", "distance_km": 21.1 } ]
--   }
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.coach_memory (
  profile_id uuid primary key references public.profiles (id) on delete cascade,
  summary text,
  facts jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.coach_memory enable row level security;

do $$ begin
  create policy "cmem_select_own" on public.coach_memory
    for select to authenticated
    using (profile_id in (select id from public.profiles where user_id = auth.uid()));
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "cmem_insert_own" on public.coach_memory
    for insert to authenticated
    with check (profile_id in (select id from public.profiles where user_id = auth.uid()));
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "cmem_update_own" on public.coach_memory
    for update to authenticated
    using (profile_id in (select id from public.profiles where user_id = auth.uid()))
    with check (profile_id in (select id from public.profiles where user_id = auth.uid()));
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "cmem_delete_own" on public.coach_memory
    for delete to authenticated
    using (profile_id in (select id from public.profiles where user_id = auth.uid()));
exception when duplicate_object then null;
end $$;

-- ────────────────────────────────────────────────────────────────────────────
-- profiles.last_coach_view_at — set when user opens the Coach view.
-- Used to compute the unread badge in Sprint 3.
--
-- profiles.coach_checkin_chat_enabled — feature flag that migrates the
-- Sunday weekly check-in wizard into the conversational coach. When true, the
-- modal is suppressed and a chat nudge is seeded instead.
-- ────────────────────────────────────────────────────────────────────────────
alter table public.profiles
  add column if not exists last_coach_view_at timestamptz;

alter table public.profiles
  add column if not exists coach_checkin_chat_enabled boolean not null default false;
