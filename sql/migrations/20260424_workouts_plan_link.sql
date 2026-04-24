-- ============================================================================
-- Migration: link logged workouts to the planned session they belong to.
--
-- Why: Milestone evaluation, check-in completion attribution, assessment-week
--   TT detection and the new horizon-regen pipeline all need an explicit
--   workout -> plan_workout link instead of fragile date-based heuristics.
--
-- Best-effort backfill: same workout_date, same activity_type, closest
--   duration_minutes (only when there is exactly one candidate per workout).
--
-- Idempotent: column add is conditional, backfill is safe to re-run because
--   it never overwrites an existing plan_workout_id.
-- ============================================================================

do $$ begin
  alter table public.workouts
    add column plan_workout_id uuid references public.plan_workouts (id) on delete set null;
exception when duplicate_column then null;
end $$;

create index if not exists workouts_plan_workout_id_idx
  on public.workouts (plan_workout_id) where plan_workout_id is not null;

-- Best-effort backfill: link rows that have an obvious unique candidate.
with candidates as (
  select
    w.id as workout_id,
    pw.id as plan_workout_id,
    abs(coalesce(w.duration_minutes, 0) - coalesce(pw.target_duration_minutes, 0)) as dur_diff,
    row_number() over (
      partition by w.id
      order by abs(coalesce(w.duration_minutes, 0) - coalesce(pw.target_duration_minutes, 0))
    ) as rk,
    count(*) over (partition by w.id) as n
  from public.workouts w
  join public.plan_workouts pw
    on pw.workout_date = w.workout_date
   and lower(coalesce(pw.activity_type, '')) = lower(coalesce(w.activity_type, ''))
  join public.plan_weeks plw on plw.id = pw.plan_week_id
  join public.training_plans tp on tp.id = plw.plan_id
  where w.plan_workout_id is null
    and tp.profile_id = w.profile_id
)
update public.workouts w
set plan_workout_id = c.plan_workout_id
from candidates c
where c.workout_id = w.id
  and c.rk = 1
  and c.n = 1;

select 'workouts.plan_workout_id added + best-effort backfill complete' as status;
