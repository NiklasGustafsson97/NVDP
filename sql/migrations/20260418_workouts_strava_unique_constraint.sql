-- Replace the partial unique index on workouts.strava_activity_id with a real
-- UNIQUE constraint so PostgREST upserts (ON CONFLICT) work correctly.
-- A standard UNIQUE constraint still allows multiple NULLs (each NULL is
-- treated as distinct in Postgres), so manual workouts continue to work.

drop index if exists public.workouts_strava_id_unique;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'workouts_strava_activity_id_key'
      and conrelid = 'public.workouts'::regclass
  ) then
    alter table public.workouts
      add constraint workouts_strava_activity_id_key unique (strava_activity_id);
  end if;
end $$;

notify pgrst, 'reload schema';
