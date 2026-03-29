-- =============================================================================
-- AI Training Plans — new tables for generated training programs
-- Run AFTER schema.sql. Safe to re-run (IF NOT EXISTS / idempotent).
-- =============================================================================

-- ── training_plans ──────────────────────────────────────────────────────────
create table if not exists public.training_plans (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  goal_type text not null default 'fitness',
  goal_text text,
  goal_date date,
  constraints jsonb not null default '{}',
  baseline jsonb not null default '{}',
  preferences jsonb not null default '{}',
  start_date date not null,
  end_date date not null,
  status text not null default 'active',
  generation_model text,
  created_at timestamptz not null default now(),
  constraint tp_status_check check (status in ('active', 'archived', 'draft')),
  constraint tp_goal_type_check check (goal_type in ('race', 'fitness', 'weight_loss', 'sport_specific', 'custom')),
  constraint tp_date_range check (end_date >= start_date)
);

comment on table public.training_plans is 'AI-generated training plans per user.';

create index if not exists training_plans_profile_status_idx
  on public.training_plans (profile_id, status);

-- Ensure max one active plan per profile
create unique index if not exists training_plans_one_active_per_profile
  on public.training_plans (profile_id)
  where (status = 'active');

-- ── plan_weeks ──────────────────────────────────────────────────────────────
create table if not exists public.plan_weeks (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.training_plans (id) on delete cascade,
  week_number int not null,
  phase text not null default 'base',
  target_hours numeric,
  target_sessions int,
  notes text,
  constraint pw_phase_check check (phase in ('base', 'build', 'peak', 'taper', 'deload', 'recovery')),
  constraint pw_unique_week unique (plan_id, week_number)
);

comment on table public.plan_weeks is 'Weekly breakdown within a training plan.';

create index if not exists plan_weeks_plan_id_idx on public.plan_weeks (plan_id);

-- ── plan_workouts ───────────────────────────────────────────────────────────
create table if not exists public.plan_workouts (
  id uuid primary key default gen_random_uuid(),
  plan_week_id uuid not null references public.plan_weeks (id) on delete cascade,
  workout_date date not null,
  day_of_week int not null,
  activity_type text not null,
  label text,
  description text,
  target_duration_minutes int,
  target_distance_km numeric,
  intensity_zone text,
  is_rest boolean not null default false,
  sort_order int not null default 0,
  constraint pwo_day_check check (day_of_week >= 0 and day_of_week <= 6)
);

comment on table public.plan_workouts is 'Individual planned workouts within a plan week.';

create index if not exists plan_workouts_week_id_idx on public.plan_workouts (plan_week_id);
create index if not exists plan_workouts_date_idx on public.plan_workouts (workout_date);

-- ── Row Level Security ──────────────────────────────────────────────────────

alter table public.training_plans enable row level security;
alter table public.plan_weeks enable row level security;
alter table public.plan_workouts enable row level security;

-- training_plans: own rows only
do $$ begin
  create policy "tp_select_own" on public.training_plans
    for select to authenticated
    using (profile_id in (select id from public.profiles where user_id = auth.uid()));
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "tp_insert_own" on public.training_plans
    for insert to authenticated
    with check (profile_id in (select id from public.profiles where user_id = auth.uid()));
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "tp_update_own" on public.training_plans
    for update to authenticated
    using (profile_id in (select id from public.profiles where user_id = auth.uid()))
    with check (profile_id in (select id from public.profiles where user_id = auth.uid()));
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "tp_delete_own" on public.training_plans
    for delete to authenticated
    using (profile_id in (select id from public.profiles where user_id = auth.uid()));
exception when duplicate_object then null;
end $$;

-- plan_weeks: access via parent plan ownership
do $$ begin
  create policy "pw_select_own" on public.plan_weeks
    for select to authenticated
    using (plan_id in (
      select id from public.training_plans
      where profile_id in (select id from public.profiles where user_id = auth.uid())
    ));
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "pw_insert_own" on public.plan_weeks
    for insert to authenticated
    with check (plan_id in (
      select id from public.training_plans
      where profile_id in (select id from public.profiles where user_id = auth.uid())
    ));
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "pw_delete_own" on public.plan_weeks
    for delete to authenticated
    using (plan_id in (
      select id from public.training_plans
      where profile_id in (select id from public.profiles where user_id = auth.uid())
    ));
exception when duplicate_object then null;
end $$;

-- plan_workouts: access via parent week -> plan ownership
do $$ begin
  create policy "pwo_select_own" on public.plan_workouts
    for select to authenticated
    using (plan_week_id in (
      select pw.id from public.plan_weeks pw
      join public.training_plans tp on tp.id = pw.plan_id
      where tp.profile_id in (select id from public.profiles where user_id = auth.uid())
    ));
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "pwo_insert_own" on public.plan_workouts
    for insert to authenticated
    with check (plan_week_id in (
      select pw.id from public.plan_weeks pw
      join public.training_plans tp on tp.id = pw.plan_id
      where tp.profile_id in (select id from public.profiles where user_id = auth.uid())
    ));
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "pwo_delete_own" on public.plan_workouts
    for delete to authenticated
    using (plan_week_id in (
      select pw.id from public.plan_weeks pw
      join public.training_plans tp on tp.id = pw.plan_id
      where tp.profile_id in (select id from public.profiles where user_id = auth.uid())
    ));
exception when duplicate_object then null;
end $$;

-- Allow service role full access (edge function uses service role)
-- Service role bypasses RLS by default, so no additional policies needed.
