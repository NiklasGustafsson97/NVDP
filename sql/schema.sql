-- =============================================================================
-- Training tracker — Supabase Postgres schema
-- Run in Supabase SQL Editor or as a migration (service role bypasses RLS for DDL/seed).
-- =============================================================================

-- gen_random_uuid() is provided by pgcrypto (enabled by default on Supabase).
create extension if not exists "pgcrypto";

-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------

-- App user profile, 1:1 with auth.users (row created by trigger on signup).
create table public.profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users (id) on delete cascade,
  name text not null,
  color text not null default '#2E86C1',
  created_at timestamptz not null default now()
);

comment on table public.profiles is 'Training app profile linked to Supabase Auth.';

create table public.periods (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  start_date date not null,
  end_date date not null,
  description text,
  created_at timestamptz not null default now(),
  constraint periods_date_range check (end_date >= start_date)
);

comment on table public.periods is 'Training macrocycles / phases.';

-- Recommended workout template per weekday (0 = Monday … 6 = Sunday) within a period.
create table public.period_plans (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null references public.periods (id) on delete cascade,
  day_of_week int not null,
  label text not null,
  description text,
  is_rest boolean not null default false,
  constraint period_plans_day_of_week check (day_of_week >= 0 and day_of_week <= 6),
  constraint period_plans_one_row_per_day unique (period_id, day_of_week)
);

comment on table public.period_plans is 'Planned workout label per day-of-week for a period (0=Mon … 6=Sun).';

create table public.workouts (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  workout_date date not null,
  activity_type text not null,
  duration_minutes int not null,
  intensity text,
  distance_km numeric,
  notes text,
  created_at timestamptz not null default now(),
  constraint workouts_duration_non_negative check (duration_minutes >= 0)
);

comment on table public.workouts is 'Logged training sessions per profile.';

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

create index workouts_profile_id_workout_date_idx
  on public.workouts (profile_id, workout_date);

create index workouts_workout_date_idx
  on public.workouts (workout_date);

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.periods enable row level security;
alter table public.period_plans enable row level security;
alter table public.workouts enable row level security;

-- profiles: readable by any signed-in user; updates only for own row (insert via trigger only).
create policy "profiles_select_authenticated"
  on public.profiles
  for select
  to authenticated
  using (true);

create policy "profiles_update_own"
  on public.profiles
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- periods & period_plans: read-only for app users (mutations via SQL/migrations or service role).
create policy "periods_select_authenticated"
  on public.periods
  for select
  to authenticated
  using (true);

create policy "period_plans_select_authenticated"
  on public.period_plans
  for select
  to authenticated
  using (true);

-- workouts: full read for comparison; write only when the row belongs to the caller’s profile.
create policy "workouts_select_authenticated"
  on public.workouts
  for select
  to authenticated
  using (true);

create policy "workouts_insert_own_profile"
  on public.workouts
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.profiles p
      where p.id = profile_id
        and p.user_id = auth.uid()
    )
  );

create policy "workouts_update_own_profile"
  on public.workouts
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.profiles p
      where p.id = profile_id
        and p.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.profiles p
      where p.id = profile_id
        and p.user_id = auth.uid()
    )
  );

create policy "workouts_delete_own_profile"
  on public.workouts
  for delete
  to authenticated
  using (
    exists (
      select 1
      from public.profiles p
      where p.id = profile_id
        and p.user_id = auth.uid()
    )
  );

-- -----------------------------------------------------------------------------
-- Auth: auto-create profile on new user
-- -----------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  display_name text;
begin
  display_name := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'name'), ''),
    nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'User'
  );

  insert into public.profiles (user_id, name)
  values (new.id, display_name);

  return new;
end;
$$;

comment on function public.handle_new_user() is 'Creates public.profiles row when auth.users row is inserted.';

-- One trigger per new auth user; DROP IF EXISTS keeps re-runs of this block from failing.
drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

-- -----------------------------------------------------------------------------
-- Seed: periods and weekly plans
-- -----------------------------------------------------------------------------

-- Idempotent: safe if names already exist (e.g. partial re-run).
insert into public.periods (name, start_date, end_date, description)
select v.name, v.start_date, v.end_date, v.description
from (
  values
    (
      'Period 1 — Bygga bas och uthållighet'::text,
      date '2026-03-03',
      date '2026-05-31',
      null::text
    ),
    (
      'Period 2 — Bygga bas och intensitet',
      date '2026-06-02',
      date '2026-08-31',
      null::text
    )
) as v(name, start_date, end_date, description)
where not exists (select 1 from public.periods p where p.name = v.name);

-- Period 1 — weekly template (0 = Monday … 6 = Sunday)
insert into public.period_plans (period_id, day_of_week, label, description, is_rest)
select p.id, v.day_of_week, v.label, v.description, v.is_rest
from public.periods p
cross join (
  values
    (0, 'Mån, Vila'::text, null::text, true),
    (1, 'Tis - Z2', '35–45 min lugn löpning Z2', false),
    (2, 'Ons - Z2', 'Cykel 45–60 min Z2', false),
    (3, 'Tors - kvalitet', '50–70 min löpning inkl intervaller', false),
    (4, 'Fre - Z2', '30–45 min mycket lugn löpning (Z1–Z2)', false),
    (5, 'Lör - långpass', 'Långpass Z2: 60 min, bygg mot 80–90', false),
    (6, 'Sön, Vila', null, true)
) as v(day_of_week, label, description, is_rest)
where p.name = 'Period 1 — Bygga bas och uthållighet'
  and not exists (
    select 1 from public.period_plans pp where pp.period_id = p.id and pp.day_of_week = v.day_of_week
  );

-- Period 2 — weekly template
insert into public.period_plans (period_id, day_of_week, label, description, is_rest)
select p.id, v.day_of_week, v.label, v.description, v.is_rest
from public.periods p
cross join (
  values
    (0, 'Mån, Vila'::text, null::text, true),
    (1, 'Tis - kvalitet', '45–55 min löpning inkl intervaller', false),
    (2, 'Ons - Z2', 'Cykel 90–120 min Z2', false),
    (3, 'Tors - kvalitet', '60–75 min löpning inkl intervaller', false),
    (4, 'Fre - Z2', '35–45 min lugn löpning + 6–10 s strides', false),
    (5, 'Lör - långpass', 'Långpass Z2: 90–120 min', false),
    (6, 'Sön, Vila', null, true)
) as v(day_of_week, label, description, is_rest)
where p.name = 'Period 2 — Bygga bas och intensitet'
  and not exists (
    select 1 from public.period_plans pp where pp.period_id = p.id and pp.day_of_week = v.day_of_week
  );
