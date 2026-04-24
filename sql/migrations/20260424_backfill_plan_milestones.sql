-- ============================================================================
-- Migration: backfill plan_milestones for legacy active plans
--
-- Why: plan_milestones is brand new. Plans created before adaptive-plans
--   shipped have zero rows in this table, so the new "Mina mål" primary
--   card has nothing to render under "Milstolpar". This migration seeds a
--   minimal, deterministic milestone set per legacy plan so the UI lights
--   up immediately. Real per-plan milestones get re-generated next time
--   the user runs /generate-plan or accepts a horizon-regen.
--
-- Heuristic: for each active plan that has zero milestones, insert
--   (a) a mid-plan check-in milestone at the median week,
--   (b) a final check-in milestone at the last week, and
--   (c) one assessment_baseline placeholder per plan_week with
--       phase='assessment' (covers both pre-plan week-1 and mid-plan
--       inserts the new computePhasePlan can produce).
--
-- Idempotent: skipped for any plan that already has milestones.
-- ============================================================================

do $$
declare
  r record;
  total_weeks int;
  mid_week int;
  start_d date;
begin
  for r in
    select tp.id, tp.profile_id, tp.start_date, tp.end_date,
           coalesce(tp.goal_text, tp.name) as goal_text,
           tp.goal_type
    from public.training_plans tp
    where tp.status = 'active'
      and not exists (
        select 1 from public.plan_milestones pm where pm.plan_id = tp.id
      )
  loop
    -- Compute total_weeks from plan_weeks first; fall back to date math
    -- when the plan_weeks rows are missing for any reason.
    select count(*) into total_weeks from public.plan_weeks where plan_id = r.id;
    if total_weeks is null or total_weeks = 0 then
      total_weeks := greatest(1, ceil(extract(epoch from (r.end_date - r.start_date)) / (7 * 86400))::int);
    end if;

    mid_week := greatest(2, (total_weeks / 2)::int);
    start_d := r.start_date;

    -- Mid-plan checkpoint
    insert into public.plan_milestones (
      plan_id, profile_id, sort_order, target_week_number, target_date,
      title, description, metric_type, status, source
    ) values (
      r.id, r.profile_id, 10, mid_week,
      start_d + ((mid_week - 1) * 7),
      'Halvtidskoll',
      'Coach kollar att volym och konsekvens följer planen vid halva planlängden.',
      'qualitative',
      'pending',
      'ai'
    );

    -- End-of-plan checkpoint
    insert into public.plan_milestones (
      plan_id, profile_id, sort_order, target_week_number, target_date,
      title, description, metric_type, status, source
    ) values (
      r.id, r.profile_id, 20, total_weeks,
      r.end_date,
      case when r.goal_type = 'race' then 'Racemål' else 'Slutmål' end,
      coalesce(r.goal_text, 'Slutmål för planen.'),
      'qualitative',
      'pending',
      'ai'
    );

    -- One assessment_baseline row per existing assessment week (matches
    -- buildAssessmentMilestoneRows() in generate-plan/index.ts).
    insert into public.plan_milestones (
      plan_id, profile_id, sort_order, target_week_number, target_date,
      title, description, metric_type, status, source
    )
    select
      r.id, r.profile_id, 5,
      pw.week_number,
      r.start_date + ((pw.week_number - 1) * 7),
      'Bedömningsvecka v' || pw.week_number,
      'Tre testpass kalibrerar puls, tröskel och 5 km.',
      'assessment_baseline',
      'pending',
      'assessment'
    from public.plan_weeks pw
    where pw.plan_id = r.id and pw.phase = 'assessment'
    on conflict do nothing;
  end loop;
end $$;

select 'plan_milestones backfill complete' as status;
