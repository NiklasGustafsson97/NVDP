-- Migration: enable multi-session per day on plan_workouts.
--
-- Background: the original schema effectively assumed one row per
-- (plan_week_id, day_of_week). The plan_workouts table already has a
-- sort_order column but it was never used to disambiguate two rows on the
-- same day. This migration:
--   1. Drops the legacy UNIQUE constraint on (plan_week_id, day_of_week) if
--      it exists (its name in supabase auto-generation is typically
--      plan_workouts_plan_week_id_day_of_week_key).
--   2. Backfills sort_order=0 for any rows where it is null.
--   3. Sets sort_order NOT NULL with default 0.
--   4. Adds a new UNIQUE index on (plan_week_id, day_of_week, sort_order)
--      so two sessions on the same day must use distinct sort_order slots.
--
-- Safe to re-run.

-- 1. Drop legacy unique constraint (if it exists).
do $$ begin
  if exists (
    select 1 from pg_constraint
    where conname = 'plan_workouts_plan_week_id_day_of_week_key'
      and conrelid = 'public.plan_workouts'::regclass
  ) then
    alter table public.plan_workouts
      drop constraint plan_workouts_plan_week_id_day_of_week_key;
  end if;
end $$;

-- Also drop a unique index with the same column set, if any.
drop index if exists public.plan_workouts_plan_week_id_day_of_week_key;

-- 2. Backfill any null sort_order to 0.
update public.plan_workouts
set sort_order = 0
where sort_order is null;

-- 3. Enforce NOT NULL + default 0.
alter table public.plan_workouts
  alter column sort_order set default 0;

alter table public.plan_workouts
  alter column sort_order set not null;

-- 4. New unique index guaranteeing distinct slots within a day.
create unique index if not exists plan_workouts_pwk_dow_so_uq
  on public.plan_workouts (plan_week_id, day_of_week, sort_order);
