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

alter table public.challenges disable row level security;

-- Add avatar column to profiles
alter table public.profiles add column if not exists avatar text;
