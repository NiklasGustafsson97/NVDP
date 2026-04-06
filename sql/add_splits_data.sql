-- Add splits_data column to store Strava split/km data (from detailed activity)
alter table public.workouts add column if not exists splits_data jsonb;
