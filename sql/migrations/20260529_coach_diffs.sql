-- ============================================================================
-- Migration: coach_diffs — durable storage for proposed coach plan changes.
--
-- Why: propose_plan_changes / propose_workout_edit previously stashed the diff
--   in an in-memory Map inside the coach-chat edge function. Supabase Edge
--   Functions are serverless: the "Spara ändringar" (apply) request routinely
--   lands on a different (or recycled) instance than the one that created the
--   diff, so the lookup missed and the user got
--   "Diff expired or unknown — be om en ny propose_plan_changes". The schedule
--   never updated.
--
--   Persisting each diff here lets any instance resolve a diff_id, so apply
--   works regardless of which worker handles it. Rows are deleted on apply and
--   pruned after 7 days.
--
-- Access: only the edge functions (service role) touch this table. RLS is on
--   with NO policies, so authenticated/anon clients can't read or write it.
-- Idempotent: safe to re-run.
-- ============================================================================

create extension if not exists "pgcrypto";

create table if not exists public.coach_diffs (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  changes jsonb not null,
  next_week_plan jsonb not null,
  created_at timestamptz not null default now()
);

comment on table public.coach_diffs is
  'Server-side stash for proposed coach plan changes, keyed by diff_id. Written by propose_*, read+deleted by apply_plan_changes. Service-role only.';

create index if not exists coach_diffs_profile_created_idx
  on public.coach_diffs (profile_id, created_at);

alter table public.coach_diffs enable row level security;

-- No policies on purpose: service-role (edge functions) bypasses RLS, and no
-- client should ever query this table directly.

select 'coach_diffs table + RLS installed' as status;
