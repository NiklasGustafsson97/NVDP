-- Migration: create weekly_checkins table + RLS for the Sunday coach check-in feature.
-- Mirrors site/sql/add_weekly_checkins.sql. Safe to re-run.

create extension if not exists "pgcrypto";

create table if not exists public.weekly_checkins (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  plan_id uuid references public.training_plans (id) on delete set null,
  week_start_date date not null,
  responses jsonb not null default '{}',
  objective_summary jsonb not null default '{}',
  proposed_changes jsonb not null default '[]',
  applied_changes jsonb,
  coach_note text,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  constraint wc_status_check check (status in ('pending', 'applied', 'declined', 'skipped')),
  constraint wc_unique_week unique (profile_id, week_start_date)
);

create index if not exists weekly_checkins_profile_idx
  on public.weekly_checkins (profile_id, week_start_date desc);

create index if not exists weekly_checkins_status_idx
  on public.weekly_checkins (profile_id, status);

alter table public.weekly_checkins enable row level security;

do $$ begin
  create policy "wc_select_own" on public.weekly_checkins
    for select to authenticated
    using (profile_id in (select id from public.profiles where user_id = auth.uid()));
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "wc_insert_own" on public.weekly_checkins
    for insert to authenticated
    with check (profile_id in (select id from public.profiles where user_id = auth.uid()));
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "wc_update_own" on public.weekly_checkins
    for update to authenticated
    using (profile_id in (select id from public.profiles where user_id = auth.uid()))
    with check (profile_id in (select id from public.profiles where user_id = auth.uid()));
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "wc_delete_own" on public.weekly_checkins
    for delete to authenticated
    using (profile_id in (select id from public.profiles where user_id = auth.uid()));
exception when duplicate_object then null;
end $$;
