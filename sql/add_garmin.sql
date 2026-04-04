-- ============================================================================
-- Migration: Add Garmin Connect integration tables
-- Run this ONCE in Supabase SQL Editor
-- ============================================================================

-- Garmin OAuth connections: stores tokens per user
create table if not exists public.garmin_connections (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null unique references public.profiles(id) on delete cascade,
  garmin_user_id text not null unique,
  access_token text not null,
  refresh_token text not null,
  expires_at bigint not null,
  last_sync_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists garmin_conn_user_idx
  on public.garmin_connections (garmin_user_id);

-- RLS
alter table public.garmin_connections enable row level security;

create policy "garmin_conn_select_own"
  on public.garmin_connections for select to authenticated
  using (exists (select 1 from public.profiles p where p.id = profile_id and p.user_id = auth.uid()));

create policy "garmin_conn_insert_own"
  on public.garmin_connections for insert to authenticated
  with check (exists (select 1 from public.profiles p where p.id = profile_id and p.user_id = auth.uid()));

create policy "garmin_conn_update_own"
  on public.garmin_connections for update to authenticated
  using (exists (select 1 from public.profiles p where p.id = profile_id and p.user_id = auth.uid()))
  with check (exists (select 1 from public.profiles p where p.id = profile_id and p.user_id = auth.uid()));

create policy "garmin_conn_delete_own"
  on public.garmin_connections for delete to authenticated
  using (exists (select 1 from public.profiles p where p.id = profile_id and p.user_id = auth.uid()));

-- Add garmin_activity_id column to workouts
alter table public.workouts add column if not exists garmin_activity_id text;

-- Prevent duplicate Garmin imports
create unique index if not exists workouts_garmin_id_unique
  on public.workouts (garmin_activity_id) where garmin_activity_id is not null;

select 'Garmin tables and columns created' as status;
