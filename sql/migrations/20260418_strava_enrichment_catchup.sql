-- Catch-up: ensure all Strava enrichment columns exist on workouts and profiles.
-- Mirrors add_strava_enrichment.sql + add_strava_extra_fields.sql + add_splits_data.sql
-- so a fresh deploy of the DB has everything strava-sync writes.

alter table public.workouts add column if not exists perceived_exertion integer;
alter table public.workouts add column if not exists hr_zone_seconds jsonb;
alter table public.workouts add column if not exists laps_data jsonb;
alter table public.workouts add column if not exists splits_data jsonb;
alter table public.workouts add column if not exists map_polyline text;
alter table public.workouts add column if not exists elapsed_time_minutes integer;
alter table public.workouts add column if not exists elevation_gain_m numeric(8,1);
alter table public.workouts add column if not exists avg_speed_kmh numeric(5,2);
alter table public.workouts add column if not exists max_speed_kmh numeric(5,2);
alter table public.workouts add column if not exists avg_hr integer;
alter table public.workouts add column if not exists max_hr integer;
alter table public.workouts add column if not exists calories integer;
alter table public.workouts add column if not exists avg_cadence numeric(5,1);

alter table public.profiles add column if not exists user_max_hr integer;

notify pgrst, 'reload schema';
