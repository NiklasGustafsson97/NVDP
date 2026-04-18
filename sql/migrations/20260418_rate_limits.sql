-- ============================================================================
-- Migration: rate-limit counter table used by Edge Functions
-- Used by send-nudge-email and weekly-template-ai to enforce per-user quotas.
-- Supports sliding window + fixed-window style buckets (time_bucket is opaque).
-- Write access is server-side only (service role bypasses RLS).
-- ============================================================================

create table if not exists public.rate_limits (
  user_id uuid not null,
  bucket text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (user_id, bucket, window_start)
);

create index if not exists rate_limits_user_bucket_idx
  on public.rate_limits (user_id, bucket, window_start desc);

alter table public.rate_limits enable row level security;
-- No policies: only the service role (which bypasses RLS) reads/writes this
-- table. Authenticated clients must never query it directly.

select 'rate_limits table ready' as status;
