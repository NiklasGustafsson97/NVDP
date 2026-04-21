-- ============================================================================
-- Migration: user_goals table for Raggelito-review Sprint 4
--
-- Why: Progress tab gained a "Dina mål" sub-tab in Sprint 2 but with only a
--   placeholder. Sprint 4 fills it with real goal tracking.
--
-- Scope: four goal types, all owned by a single profile:
--   - distance_per_period   e.g. "200 km / månad"
--   - count_per_period      e.g. "4 pass / vecka"
--   - race_time             user-entered, e.g. "Marathon på 3:30"
--   - plan_derived_race     auto-created when an AI plan with goal_type='race'
--                           is generated; linked via plan_id so we can kill it
--                           when the plan is archived
--
-- RLS mirrors weekly_checkins: own rows only, via profiles.user_id = auth.uid().
--
-- Idempotent: safe to re-run.
-- ============================================================================

create extension if not exists "pgcrypto";

create table if not exists public.user_goals (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  plan_id uuid references public.training_plans (id) on delete set null,
  goal_type text not null,
  title text not null,
  target_value numeric not null,
  target_unit text not null,
  -- Period-based goals (distance_per_period / count_per_period). Null for races.
  period text,
  period_anchor date,
  -- One-off goals (race_time / plan_derived_race).
  target_date date,
  target_distance_km numeric,
  -- Optional baseline so race-goal UI can draw start/today/target progress.
  baseline_value numeric,
  baseline_date date,
  notes text,
  active boolean not null default true,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  constraint ug_type_check check (
    goal_type in ('distance_per_period', 'count_per_period', 'race_time', 'plan_derived_race')
  ),
  constraint ug_period_check check (
    period is null or period in ('week', 'month', 'year')
  ),
  -- Period goals must have a period; race goals must have a target_date.
  constraint ug_period_required check (
    (goal_type in ('distance_per_period', 'count_per_period') and period is not null)
    or goal_type in ('race_time', 'plan_derived_race')
  ),
  constraint ug_race_needs_date check (
    (goal_type in ('race_time', 'plan_derived_race') and target_date is not null)
    or goal_type in ('distance_per_period', 'count_per_period')
  )
);

comment on table public.user_goals is
  'User-defined and plan-derived fitness goals. Raggelito-review Sprint 4.';

create index if not exists user_goals_profile_active_idx
  on public.user_goals (profile_id, active, created_at desc);

create index if not exists user_goals_plan_idx
  on public.user_goals (plan_id) where plan_id is not null;

-- Only one plan-derived race goal per plan. User-defined goals are unlimited.
create unique index if not exists user_goals_one_plan_derived_per_plan
  on public.user_goals (plan_id)
  where (goal_type = 'plan_derived_race' and active = true);

alter table public.user_goals enable row level security;

do $$ begin
  create policy "ug_select_own" on public.user_goals
    for select to authenticated
    using (profile_id in (select id from public.profiles where user_id = auth.uid()));
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "ug_insert_own" on public.user_goals
    for insert to authenticated
    with check (profile_id in (select id from public.profiles where user_id = auth.uid()));
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "ug_update_own" on public.user_goals
    for update to authenticated
    using (profile_id in (select id from public.profiles where user_id = auth.uid()))
    with check (profile_id in (select id from public.profiles where user_id = auth.uid()));
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "ug_delete_own" on public.user_goals
    for delete to authenticated
    using (profile_id in (select id from public.profiles where user_id = auth.uid()));
exception when duplicate_object then null;
end $$;

select 'user_goals table + RLS installed' as status;
