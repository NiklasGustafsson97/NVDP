-- ============================================================================
-- Migration: extend plan_weeks.pw_phase_check with 'assessment'
--
-- Why: Assessment weeks (opt-in week 1 + auto-inserted mid-plan for plans
--   >= 20 weeks) need a distinct phase value so the renderers, the validator
--   and the deterministic post-LLM overwrite can target them unambiguously.
--
-- Idempotent: drop-then-recreate the constraint inside a do block so re-runs
--   are no-ops once 'assessment' is already accepted.
-- ============================================================================

do $$
declare
  has_assessment boolean;
begin
  -- Skip work if the constraint already includes 'assessment'.
  select exists (
    select 1
    from pg_constraint
    where conrelid = 'public.plan_weeks'::regclass
      and conname = 'pw_phase_check'
      and pg_get_constraintdef(oid) ilike '%''assessment''%'
  ) into has_assessment;

  if not has_assessment then
    alter table public.plan_weeks drop constraint if exists pw_phase_check;
    alter table public.plan_weeks add constraint pw_phase_check
      check (phase in ('base', 'build', 'peak', 'taper', 'deload', 'recovery', 'assessment'));
  end if;
end $$;

select 'pw_phase_check now accepts assessment phase' as status;
