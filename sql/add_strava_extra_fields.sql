-- Add expanded Strava data columns + map polyline to workouts table
alter table public.workouts add column if not exists map_polyline text;
alter table public.workouts add column if not exists elapsed_time_minutes integer;
alter table public.workouts add column if not exists elevation_gain_m numeric(8,1);
alter table public.workouts add column if not exists avg_speed_kmh numeric(5,2);
alter table public.workouts add column if not exists max_speed_kmh numeric(5,2);
alter table public.workouts add column if not exists avg_hr integer;
alter table public.workouts add column if not exists max_hr integer;
alter table public.workouts add column if not exists calories integer;
alter table public.workouts add column if not exists avg_cadence numeric(5,1);
