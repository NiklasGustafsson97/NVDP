-- ============================================================================
-- Migration: Add groups system
-- Run this ONCE in Supabase SQL Editor
-- ============================================================================

-- Create groups table
create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text unique not null,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

-- Add group_id to profiles
alter table public.profiles add column if not exists group_id uuid references public.groups(id);

-- Disable RLS (consistent with other tables in this app)
alter table public.groups disable row level security;

-- Verify
select 'Groups table created' as status;
select column_name, data_type from information_schema.columns where table_name = 'groups' order by ordinal_position;
