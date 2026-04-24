-- ============================================================================
-- Migration: profiles.adaptive_replan_enabled feature flag
--
-- Why: Gates BOTH the weekly horizon-regen pipeline AND the auto-inserted
--   mid-plan assessment week (>= 20-week plans). Defaults to true so the
--   feature is on for everyone after smoke test, but we can disable per
--   user if the LLM misbehaves.
--
-- Idempotent.
-- ============================================================================

do $$ begin
  alter table public.profiles
    add column adaptive_replan_enabled boolean not null default true;
exception when duplicate_column then null;
end $$;

comment on column public.profiles.adaptive_replan_enabled is
  'Feature flag: weekly horizon regen + auto mid-plan assessment week (default on).';

select 'profiles.adaptive_replan_enabled installed' as status;
