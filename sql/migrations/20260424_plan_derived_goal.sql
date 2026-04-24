-- ============================================================================
-- Migration: extend user_goals so EVERY active plan surfaces as the user's
--   primary goal on Mina mal -- not just races.
--
-- Why: Today _ensurePlanDerivedRaceGoal in app.js only fires for
--   goal_type='race' AND a goal_date; fitness/weight_loss/sport_specific/
--   custom plans never create a user_goals row, so the Mina mal tab shows
--   "Inga mal an" even though the user did set a goal in the wizard.
--
-- Changes:
--   - Add 'plan_derived' to ug_type_check (alongside the existing
--     'plan_derived_race').
--   - Loosen ug_race_needs_date so the new plan_derived type does NOT
--     require target_date (we still try to set it from plan.goal_date or
--     plan.end_date, but fitness plans may have neither).
--   - Widen the unique-per-plan index to cover both derived types so a
--     race plan that gets re-categorized still has at most one auto-
--     derived primary goal.
--
-- Idempotent: each alter is wrapped in a do-block that no-ops if it has
--   already been applied.
-- ============================================================================

-- 1. Replace ug_type_check to add 'plan_derived'.
do $$
declare
  has_plan_derived boolean;
begin
  select exists (
    select 1
    from pg_constraint
    where conrelid = 'public.user_goals'::regclass
      and conname = 'ug_type_check'
      and pg_get_constraintdef(oid) ilike '%''plan_derived''%'
  ) into has_plan_derived;

  if not has_plan_derived then
    alter table public.user_goals drop constraint if exists ug_type_check;
    alter table public.user_goals add constraint ug_type_check check (
      goal_type in (
        'distance_per_period',
        'count_per_period',
        'race_time',
        'plan_derived_race',
        'plan_derived'
      )
    );
  end if;
end $$;

-- 2. Loosen ug_race_needs_date so plan_derived rows are accepted without
--    target_date. Keep the original requirement for race_time +
--    plan_derived_race.
do $$
declare
  needs_loosen boolean;
begin
  select not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.user_goals'::regclass
      and conname = 'ug_race_needs_date'
      and pg_get_constraintdef(oid) ilike '%''plan_derived''%'
  ) into needs_loosen;

  if needs_loosen then
    alter table public.user_goals drop constraint if exists ug_race_needs_date;
    alter table public.user_goals add constraint ug_race_needs_date check (
      (goal_type in ('race_time', 'plan_derived_race') and target_date is not null)
      or goal_type in ('distance_per_period', 'count_per_period', 'plan_derived')
    );
  end if;
end $$;

-- 2b. Loosen ug_period_required: today only race types are allowed to skip
--    the period column. plan_derived (fitness/weight_loss/sport_specific/
--    custom) needs the same exemption.
do $$
declare
  needs_loosen2 boolean;
begin
  select not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.user_goals'::regclass
      and conname = 'ug_period_required'
      and pg_get_constraintdef(oid) ilike '%''plan_derived''%'
  ) into needs_loosen2;

  if needs_loosen2 then
    alter table public.user_goals drop constraint if exists ug_period_required;
    alter table public.user_goals add constraint ug_period_required check (
      (goal_type in ('distance_per_period', 'count_per_period') and period is not null)
      or goal_type in ('race_time', 'plan_derived_race', 'plan_derived')
    );
  end if;
end $$;

-- 3. Widen the unique-per-plan index. Drop and recreate so the predicate
--    catches BOTH plan_derived_race and plan_derived rows.
drop index if exists public.user_goals_one_plan_derived_per_plan;

create unique index user_goals_one_plan_derived_per_plan
  on public.user_goals (plan_id)
  where (goal_type in ('plan_derived_race', 'plan_derived') and active = true);

select 'user_goals now accepts plan_derived goal type' as status;
