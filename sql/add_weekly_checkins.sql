-- =============================================================================
-- Weekly Coach Check-In — table + RLS
-- Run AFTER schema.sql and add_training_plans.sql. Safe to re-run (idempotent).
-- =============================================================================

create extension if not exists "pgcrypto";

-- ── weekly_checkins ─────────────────────────────────────────────────────────
-- One row per (profile, ISO-week) representing the Sunday coach check-in
-- for the week that just finished. Stores the raw answers, the server-
-- computed objective snapshot, the AI/rule-engine's proposed changes,
-- and (after accept) the subset the user actually applied.
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

comment on table public.weekly_checkins is 'Weekly Sunday coach check-ins per profile (one per ISO week reviewed).';
comment on column public.weekly_checkins.responses is 'User form answers: {overall_feel: 1-5, injury_level, injury_note, injury_side, hardest_session_feel, long_run_feel, unavailable_days: int[], next_week_context, free_text}';
comment on column public.weekly_checkins.objective_summary is 'Server-computed snapshot: {week_start, planned_sessions, logged_sessions, completion_rate, weekly_load, prior_4wk_avg_load, acwr, acwr_band, easy_avg_hr, easy_avg_hr_prior_4wk, missed_sessions, next_week_phase, next_week_plan}';
comment on column public.weekly_checkins.proposed_changes is 'Array of atomic moves: [{id, day_of_week, action, params, reason_sv}]';
comment on column public.weekly_checkins.applied_changes is 'Subset of proposed_changes the user accepted (ids only).';

create index if not exists weekly_checkins_profile_idx
  on public.weekly_checkins (profile_id, week_start_date desc);

create index if not exists weekly_checkins_status_idx
  on public.weekly_checkins (profile_id, status);

-- ── Row Level Security ──────────────────────────────────────────────────────

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

-- Service role bypasses RLS by default — no additional policies needed for edge functions.
