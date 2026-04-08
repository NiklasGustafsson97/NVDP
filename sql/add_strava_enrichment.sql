-- Strava enrichment: perceived exertion, HR zone distribution, laps
alter table public.workouts add column if not exists perceived_exertion integer;
alter table public.workouts add column if not exists hr_zone_seconds jsonb;
alter table public.workouts add column if not exists laps_data jsonb;

-- User max HR for accurate intensity calculation
alter table public.profiles add column if not exists user_max_hr integer;
