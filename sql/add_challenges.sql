create table if not exists public.challenges (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  created_by uuid not null references public.profiles(id),
  title text not null,
  metric text not null check (metric in ('hours', 'sessions', 'km')),
  activity_filter text,
  start_date date not null,
  end_date date not null,
  created_at timestamptz not null default now()
);

-- SECURITY NOTE (assessment C6): previously this migration disabled RLS
-- which would silently reopen the table on every re-run. RLS is now enabled
-- here; policies live in migrations/20260330_fix_rls_security.sql and
-- migrations/20260418_rls_lockdown.sql.
alter table public.challenges enable row level security;

-- Add avatar column to profiles
alter table public.profiles add column if not exists avatar text;
