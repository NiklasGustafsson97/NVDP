-- ============================================================================
-- FIX: RLS policies, profiles, intensity column, and seed data
-- Run this ONCE in Supabase SQL Editor → click "Run"
-- ============================================================================

-- ── Step 1: Fix RLS on profiles ─────────────────────────────────────────────
-- Drop all existing policies on profiles (ignore errors if they don't exist)
drop policy if exists "Users can read own profile" on public.profiles;
drop policy if exists "Users can read all profiles" on public.profiles;
drop policy if exists "Users can insert own profile" on public.profiles;
drop policy if exists "Users can update own profile" on public.profiles;
drop policy if exists "profiles_select" on public.profiles;
drop policy if exists "profiles_insert" on public.profiles;
drop policy if exists "profiles_update" on public.profiles;
drop policy if exists "Enable read access for all users" on public.profiles;
drop policy if exists "Enable insert for authenticated users only" on public.profiles;

-- Make sure RLS is enabled
alter table public.profiles enable row level security;

-- Any logged-in user can read ALL profiles (needed for Compare view)
create policy "authenticated_read_profiles"
  on public.profiles for select
  to authenticated
  using (true);

-- Users can insert their own profile
create policy "authenticated_insert_own_profile"
  on public.profiles for insert
  to authenticated
  with check (auth.uid() = user_id);

-- Users can update their own profile
create policy "authenticated_update_own_profile"
  on public.profiles for update
  to authenticated
  using (auth.uid() = user_id);


-- ── Step 2: Fix RLS on workouts ─────────────────────────────────────────────
drop policy if exists "Users can read own workouts" on public.workouts;
drop policy if exists "Users can read all workouts" on public.workouts;
drop policy if exists "Users can insert own workouts" on public.workouts;
drop policy if exists "Users can update own workouts" on public.workouts;
drop policy if exists "Users can delete own workouts" on public.workouts;
drop policy if exists "workouts_select" on public.workouts;
drop policy if exists "workouts_insert" on public.workouts;
drop policy if exists "workouts_update" on public.workouts;
drop policy if exists "workouts_delete" on public.workouts;
drop policy if exists "Enable read access for all users" on public.workouts;
drop policy if exists "Enable insert for authenticated users only" on public.workouts;

alter table public.workouts enable row level security;

-- Any logged-in user can read ALL workouts
create policy "authenticated_read_workouts"
  on public.workouts for select
  to authenticated
  using (true);

-- Users can insert workouts linked to their own profile
create policy "authenticated_insert_workouts"
  on public.workouts for insert
  to authenticated
  with check (
    profile_id in (select id from public.profiles where user_id = auth.uid())
  );

-- Users can update their own workouts
create policy "authenticated_update_workouts"
  on public.workouts for update
  to authenticated
  using (
    profile_id in (select id from public.profiles where user_id = auth.uid())
  );

-- Users can delete their own workouts
create policy "authenticated_delete_workouts"
  on public.workouts for delete
  to authenticated
  using (
    profile_id in (select id from public.profiles where user_id = auth.uid())
  );


-- ── Step 3: Fix RLS on periods and period_plans ─────────────────────────────
drop policy if exists "Anyone can read periods" on public.periods;
drop policy if exists "authenticated_read_periods" on public.periods;
drop policy if exists "Enable read access for all users" on public.periods;

alter table public.periods enable row level security;

create policy "authenticated_read_periods"
  on public.periods for select
  to authenticated
  using (true);

drop policy if exists "Anyone can read period_plans" on public.period_plans;
drop policy if exists "authenticated_read_period_plans" on public.period_plans;
drop policy if exists "Enable read access for all users" on public.period_plans;

alter table public.period_plans enable row level security;

create policy "authenticated_read_period_plans"
  on public.period_plans for select
  to authenticated
  using (true);


-- ── Step 4: Ensure columns exist ────────────────────────────────────────────
alter table public.workouts add column if not exists distance_km numeric;
alter table public.workouts add column if not exists intensity text;


-- ── Step 5: Create profiles for all auth users who don't have one ───────────
insert into public.profiles (user_id, name)
select
  au.id,
  coalesce(au.raw_user_meta_data->>'name', split_part(au.email, '@', 1))
from auth.users au
where not exists (
  select 1 from public.profiles p where p.user_id = au.id
);


-- ── Step 6: Verify ──────────────────────────────────────────────────────────
select 'PROFILES:' as info;
select id, user_id, name from public.profiles;

select 'WORKOUTS COUNT:' as info;
select count(*) as total_workouts from public.workouts;
