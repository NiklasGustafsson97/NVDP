-- ============================================================================
-- Migration: enable RLS on public.periods and public.period_plans
--
-- Why: Supabase Security Advisor (email 19 Apr 2026) flagged both tables with
--   `rls_disabled_in_public` and `policy_exists_rls_disabled`. The SELECT
--   policies from `sql/schema.sql` (L116-126) were created in production, but
--   the `alter table ... enable row level security` lines (L97-98) never ran
--   -- so the policies sit there inert and anyone with the anon key can read,
--   insert, update or delete every row in `periods` and `period_plans`.
--
-- Intent (matches schema.sql comment "periods & period_plans: read-only for
--   app users (mutations via SQL/migrations or service role)"):
--     * RLS enabled
--     * authenticated users may SELECT every row
--     * NO insert/update/delete policy -> writes are rejected for anon and
--       authenticated callers; only the service-role key can mutate (which is
--       what migrations and the Edge Functions already use).
--
-- Idempotent: safe to re-run. `enable row level security` is a no-op when
--   already on; the policy creates are guarded with do/exception blocks.
-- ============================================================================

alter table public.periods       enable row level security;
alter table public.period_plans  enable row level security;

do $$ begin
  create policy "periods_select_authenticated"
    on public.periods
    for select
    to authenticated
    using (true);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "period_plans_select_authenticated"
    on public.period_plans
    for select
    to authenticated
    using (true);
exception when duplicate_object then null;
end $$;

select 'periods + period_plans RLS hardened' as status;
