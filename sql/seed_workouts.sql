-- ============================================================================
-- Seed workout data from Excel (4 weeks: 2026-03-03 to 2026-03-28)
-- Run AFTER both Niklas and Love have registered (profiles must exist).
-- Safe to re-run: uses NOT EXISTS to skip duplicates.
-- ============================================================================

-- Add distance_km column if it doesn't exist
alter table public.workouts add column if not exists distance_km numeric;

-- ── NIKLAS ──────────────────────────────────────────────────────────────────

-- Week 1: 2026-03-03
insert into public.workouts (profile_id, workout_date, activity_type, duration_minutes, notes)
select p.id, v.d::date, v.t, v.m, 'Importerad'
from public.profiles p
cross join (values
  ('2026-03-04', 'Cykel', 105),
  ('2026-03-05', 'Cykel', 50),
  ('2026-03-07', 'Löpning', 26),
  ('2026-03-08', 'Cykel', 90),
  ('2026-03-08', 'Gym', 90),
  ('2026-03-09', 'Löpning', 15)
) as v(d, t, m)
where lower(p.name) like '%niklas%'
  and not exists (
    select 1 from public.workouts w
    where w.profile_id = p.id and w.workout_date = v.d::date
      and w.activity_type = v.t and w.duration_minutes = v.m
  );

-- Week 2: 2026-03-10
insert into public.workouts (profile_id, workout_date, activity_type, duration_minutes, notes)
select p.id, v.d::date, v.t, v.m, 'Importerad'
from public.profiles p
cross join (values
  ('2026-03-11', 'Löpning', 57),
  ('2026-03-12', 'Löpning', 54),
  ('2026-03-13', 'Längdskidor', 48),
  ('2026-03-14', 'Hyrox', 50),
  ('2026-03-14', 'Gym', 105),
  ('2026-03-16', 'Stakmaskin', 83)
) as v(d, t, m)
where lower(p.name) like '%niklas%'
  and not exists (
    select 1 from public.workouts w
    where w.profile_id = p.id and w.workout_date = v.d::date
      and w.activity_type = v.t and w.duration_minutes = v.m
  );

-- Week 3: 2026-03-17
insert into public.workouts (profile_id, workout_date, activity_type, duration_minutes, notes)
select p.id, v.d::date, v.t, v.m, 'Importerad'
from public.profiles p
cross join (values
  ('2026-03-18', 'Cykel', 88),
  ('2026-03-19', 'Cykel', 20),
  ('2026-03-20', 'Cykel', 120),
  ('2026-03-20', 'Gym', 78),
  ('2026-03-21', 'Längdskidor', 60),
  ('2026-03-23', 'Cykel', 60)
) as v(d, t, m)
where lower(p.name) like '%niklas%'
  and not exists (
    select 1 from public.workouts w
    where w.profile_id = p.id and w.workout_date = v.d::date
      and w.activity_type = v.t and w.duration_minutes = v.m
  );

-- Week 4 (deload): 2026-03-24
insert into public.workouts (profile_id, workout_date, activity_type, duration_minutes, notes)
select p.id, v.d::date, v.t, v.m, 'Importerad'
from public.profiles p
cross join (values
  ('2026-03-26', 'Cykel', 50),
  ('2026-03-27', 'Cykel', 25),
  ('2026-03-28', 'Löpning', 30),
  ('2026-03-28', 'Löpning', 10)
) as v(d, t, m)
where lower(p.name) like '%niklas%'
  and not exists (
    select 1 from public.workouts w
    where w.profile_id = p.id and w.workout_date = v.d::date
      and w.activity_type = v.t and w.duration_minutes = v.m
  );

-- ── LOVE ────────────────────────────────────────────────────────────────────

-- Week 1: 2026-03-03
insert into public.workouts (profile_id, workout_date, activity_type, duration_minutes, notes)
select p.id, v.d::date, v.t, v.m, 'Importerad'
from public.profiles p
cross join (values
  ('2026-03-05', 'Löpning', 42),
  ('2026-03-07', 'Löpning', 35),
  ('2026-03-09', 'Löpning', 50)
) as v(d, t, m)
where lower(p.name) like '%love%'
  and not exists (
    select 1 from public.workouts w
    where w.profile_id = p.id and w.workout_date = v.d::date
      and w.activity_type = v.t and w.duration_minutes = v.m
  );

-- Week 2: 2026-03-10
insert into public.workouts (profile_id, workout_date, activity_type, duration_minutes, notes)
select p.id, v.d::date, v.t, v.m, 'Importerad'
from public.profiles p
cross join (values
  ('2026-03-10', 'Löpning', 38),
  ('2026-03-11', 'Cykel', 35),
  ('2026-03-13', 'Löpning', 25),
  ('2026-03-14', 'Löpning', 20),
  ('2026-03-15', 'Löpning', 60),
  ('2026-03-16', 'Annat', 60)
) as v(d, t, m)
where lower(p.name) like '%love%'
  and not exists (
    select 1 from public.workouts w
    where w.profile_id = p.id and w.workout_date = v.d::date
      and w.activity_type = v.t and w.duration_minutes = v.m
  );

-- Week 3: 2026-03-17
insert into public.workouts (profile_id, workout_date, activity_type, duration_minutes, notes)
select p.id, v.d::date, v.t, v.m, 'Importerad'
from public.profiles p
cross join (values
  ('2026-03-18', 'Löpning', 33),
  ('2026-03-20', 'Löpning', 45),
  ('2026-03-22', 'Annat', 60),
  ('2026-03-23', 'Löpning', 73)
) as v(d, t, m)
where lower(p.name) like '%love%'
  and not exists (
    select 1 from public.workouts w
    where w.profile_id = p.id and w.workout_date = v.d::date
      and w.activity_type = v.t and w.duration_minutes = v.m
  );

-- Week 4 (deload): 2026-03-24
insert into public.workouts (profile_id, workout_date, activity_type, duration_minutes, notes)
select p.id, v.d::date, v.t, v.m, 'Importerad'
from public.profiles p
cross join (values
  ('2026-03-24', 'Löpning', 28),
  ('2026-03-25', 'Cykel', 120),
  ('2026-03-26', 'Annat', 90)
) as v(d, t, m)
where lower(p.name) like '%love%'
  and not exists (
    select 1 from public.workouts w
    where w.profile_id = p.id and w.workout_date = v.d::date
      and w.activity_type = v.t and w.duration_minutes = v.m
  );
