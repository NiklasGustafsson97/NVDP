-- Workout reactions (like / dislike)
create table if not exists public.workout_reactions (
  id uuid primary key default gen_random_uuid(),
  workout_id uuid not null references public.workouts(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  reaction text not null check (reaction in ('like', 'dislike')),
  created_at timestamptz not null default now(),
  unique(workout_id, profile_id)
);

-- Workout comments
create table if not exists public.workout_comments (
  id uuid primary key default gen_random_uuid(),
  workout_id uuid not null references public.workouts(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  text text not null,
  created_at timestamptz not null default now()
);

-- SECURITY NOTE (assessment C6): previously this migration disabled RLS
-- which would silently reopen these tables on every re-run. RLS is now
-- enabled here; policies live in migrations/20260330_fix_rls_security.sql
-- and migrations/20260418_rls_lockdown.sql.
alter table public.workout_reactions enable row level security;
alter table public.workout_comments enable row level security;
