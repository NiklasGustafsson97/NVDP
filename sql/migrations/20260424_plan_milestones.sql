-- ============================================================================
-- Migration: plan_milestones table for adaptive-plans-with-assessment
--
-- Why: Each AI plan now ships with 3-5 explicit, measurable checkpoints so
--   the user can see "am I on track?" on Mina mal. Milestones live in their
--   own table (rather than as children of user_goals) because they are
--   plan-scoped and re-evaluated on every weekly check-in.
--
-- The 'assessment_baseline' metric_type is reserved for the implicit
--   "complete week N's assessment block" milestone the server post-injects
--   for every assessment week.
--
-- RLS mirrors user_goals: own rows only, via profiles.user_id = auth.uid().
-- Idempotent: safe to re-run.
-- ============================================================================

create extension if not exists "pgcrypto";

create table if not exists public.plan_milestones (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.training_plans (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  sort_order int not null default 0,
  target_week_number int,
  target_date date,
  title text not null,
  description text,
  metric_type text not null,
  target_value numeric,
  target_unit text,
  target_distance_km numeric,
  status text not null default 'pending',
  evaluated_at timestamptz,
  evaluation_notes text,
  source text not null default 'ai',
  created_at timestamptz not null default now(),
  constraint pm_metric_type_check check (
    metric_type in (
      'pace_for_distance',
      'distance_in_session',
      'duration_in_zone',
      'weekly_volume_km',
      'weekly_volume_hours',
      'weekly_sessions',
      'qualitative',
      'assessment_baseline'
    )
  ),
  constraint pm_status_check check (
    status in ('pending', 'hit', 'on_track', 'lagging', 'missed', 'cancelled')
  ),
  constraint pm_source_check check (
    source in ('ai', 'user', 'assessment')
  )
);

comment on table public.plan_milestones is
  'Editable, measurable checkpoints attached to a training_plan. Evaluated weekly by the check-in engine.';

create index if not exists plan_milestones_plan_sort_idx
  on public.plan_milestones (plan_id, sort_order);

create index if not exists plan_milestones_profile_status_idx
  on public.plan_milestones (profile_id, status);

alter table public.plan_milestones enable row level security;

do $$ begin
  create policy "pm_select_own" on public.plan_milestones
    for select to authenticated
    using (profile_id in (select id from public.profiles where user_id = auth.uid()));
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "pm_insert_own" on public.plan_milestones
    for insert to authenticated
    with check (profile_id in (select id from public.profiles where user_id = auth.uid()));
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "pm_update_own" on public.plan_milestones
    for update to authenticated
    using (profile_id in (select id from public.profiles where user_id = auth.uid()))
    with check (profile_id in (select id from public.profiles where user_id = auth.uid()));
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "pm_delete_own" on public.plan_milestones
    for delete to authenticated
    using (profile_id in (select id from public.profiles where user_id = auth.uid()));
exception when duplicate_object then null;
end $$;

select 'plan_milestones table + RLS installed' as status;
