-- Add workout_time column (text, optional) for storing time-of-day
alter table public.workouts add column if not exists workout_time text;
