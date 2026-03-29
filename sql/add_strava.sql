-- ============================================================================
-- Migration: Add Strava integration tables
-- Run this ONCE in Supabase SQL Editor
-- ============================================================================

-- Strava OAuth connections: stores tokens per user
create table if not exists public.strava_connections (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null unique references public.profiles(id) on delete cascade,
  strava_athlete_id bigint not null unique,
  access_token text not null,
  refresh_token text not null,
  expires_at bigint not null,
  last_sync_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists strava_conn_athlete_idx
  on public.strava_connections (strava_athlete_id);

-- RLS
alter table public.strava_connections enable row level security;

create policy "strava_conn_select_own"
  on public.strava_connections for select to authenticated
  using (exists (select 1 from public.profiles p where p.id = profile_id and p.user_id = auth.uid()));

create policy "strava_conn_insert_own"
  on public.strava_connections for insert to authenticated
  with check (exists (select 1 from public.profiles p where p.id = profile_id and p.user_id = auth.uid()));

create policy "strava_conn_update_own"
  on public.strava_connections for update to authenticated
  using (exists (select 1 from public.profiles p where p.id = profile_id and p.user_id = auth.uid()))
  with check (exists (select 1 from public.profiles p where p.id = profile_id and p.user_id = auth.uid()));

create policy "strava_conn_delete_own"
  on public.strava_connections for delete to authenticated
  using (exists (select 1 from public.profiles p where p.id = profile_id and p.user_id = auth.uid()));

-- Add source column to workouts to distinguish manual vs auto-imported
alter table public.workouts add column if not exists source text default 'manual';
alter table public.workouts add column if not exists strava_activity_id bigint;

-- Prevent duplicate imports
create unique index if not exists workouts_strava_id_unique
  on public.workouts (strava_activity_id) where strava_activity_id is not null;

select 'Strava tables and columns created' as status;
