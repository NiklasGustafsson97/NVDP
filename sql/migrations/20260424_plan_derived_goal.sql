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
--   - Loosen ug_race_needs_date so plan_derived rows are accepted without
--     target_date.
--   - Loosen ug_period_required so plan_derived is exempt from the period
--     requirement (same as the race goal types).
--   - Widen the unique-per-plan index to cover both derived types.
--
-- Idempotency: every constraint is dropped (with IF EXISTS) and recreated
--   unconditionally. Earlier versions of this migration tried to skip
--   re-creation when the constraint definition already mentioned
--   'plan_derived', but that guard turned out to be brittle when the
--   migration was re-pasted in pieces -- some sections silently no-oped on
--   half-applied schemas. Unconditional drop+recreate is safe (a check
--   constraint has no data) and makes the migration trivially re-runnable.
--
-- After running, the migration prints the resulting constraint definitions
--   so you can visually confirm 'plan_derived' is present in all three.
-- ============================================================================

-- 1. ug_type_check: enumerates allowed goal_type values.
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

-- 2. ug_race_needs_date: only race-style goals require a target_date.
alter table public.user_goals drop constraint if exists ug_race_needs_date;
alter table public.user_goals add constraint ug_race_needs_date check (
  (goal_type in ('race_time', 'plan_derived_race') and target_date is not null)
  or goal_type in ('distance_per_period', 'count_per_period', 'plan_derived')
);

-- 3. ug_period_required: only periodic goals require the period column.
alter table public.user_goals drop constraint if exists ug_period_required;
alter table public.user_goals add constraint ug_period_required check (
  (goal_type in ('distance_per_period', 'count_per_period') and period is not null)
  or goal_type in ('race_time', 'plan_derived_race', 'plan_derived')
);

-- 4. Widen the unique-per-plan index. Drop and recreate so the predicate
--    catches BOTH plan_derived_race and plan_derived rows.
drop index if exists public.user_goals_one_plan_derived_per_plan;
create unique index user_goals_one_plan_derived_per_plan
  on public.user_goals (plan_id)
  where (goal_type in ('plan_derived_race', 'plan_derived') and active = true);

-- ── Verification ────────────────────────────────────────────────────────────
-- The output of this final select must contain 'plan_derived' on every row.
-- If any row's def is missing it, re-run this migration.
select
  conname as constraint_name,
  pg_get_constraintdef(oid) as definition,
  case
    when pg_get_constraintdef(oid) ilike '%''plan_derived''%' then 'OK'
    else 'MISSING plan_derived -- re-run this migration'
  end as status
from pg_constraint
where conrelid = 'public.user_goals'::regclass
  and conname in ('ug_type_check', 'ug_race_needs_date', 'ug_period_required')
order by conname;
