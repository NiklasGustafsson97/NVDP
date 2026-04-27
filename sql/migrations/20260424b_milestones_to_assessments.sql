-- ============================================================================
-- Migration: convert legacy passive milestones into assessment-week milestones
--
-- Why: milestones were originally passive coach checkpoints ("Halvtidskoll",
--   "Slutmal", "Racemal"). The new model treats every milestone as an active
--   assessment week with 3 testpass (Z2 HR-drift + tempo/threshold + near-max).
--   Cadence: every 6 weeks, anchored on week 6, capped at total_weeks - 1 so
--   we never collide with the taper. A 12-week plan gets ~1 assessment, a
--   24-week plan gets ~3.
--
-- For every active training_plans row this migration:
--   1. Deletes legacy AI-generated 'qualitative' milestones (Halvtidskoll /
--      Slutmal / Racemal) -- they no longer match the model.
--   2. Computes target_weeks = [6, 12, 18, ...] capped at total_weeks - 1.
--   3. For each target_week:
--      a) Updates plan_weeks.phase = 'assessment' unless the slot is
--         taper/peak/recovery (those carry race-prep meaning). The schedule
--         view picks this up and renders the orange "Bedomning" banner +
--         TEST badges automatically.
--      b) Inserts one plan_milestones row with metric_type =
--         'assessment_baseline', target_value = 3 (three testpass),
--         description chip-friendly so the new Mina mal UI can split on '·'.
--   4. For race plans, inserts a final pace_for_distance milestone at
--      total_weeks (the race itself).
--   5. Skips rows that already exist (idempotent -- safe to re-run).
--
-- Verification select at the end shows per-plan counts so we can confirm
-- the swap actually happened in production.
-- ============================================================================

do $$
declare
  r record;
  total_weeks int;
  start_d date;
  target_weeks int[];
  wk int;
  current_phase text;
  description_text text;
begin
  for r in
    select tp.id, tp.profile_id, tp.start_date, tp.end_date,
           coalesce(tp.goal_text, tp.name) as goal_text,
           tp.goal_type,
           tp.constraints
    from public.training_plans tp
    where tp.status = 'active'
  loop
    -- 1. Drop legacy passive milestones for this plan.
    delete from public.plan_milestones pm
    where pm.plan_id = r.id
      and pm.source = 'ai'
      and pm.metric_type = 'qualitative';

    -- 2. Compute total_weeks (prefer plan_weeks count; fall back to date math).
    select count(*) into total_weeks from public.plan_weeks where plan_id = r.id;
    if total_weeks is null or total_weeks = 0 then
      total_weeks := greatest(1, ceil(extract(epoch from (r.end_date - r.start_date)) / (7 * 86400))::int);
    end if;

    -- 3. Build target_weeks array (every 6 weeks, capped at total_weeks - 1).
    target_weeks := array[]::int[];
    wk := 6;
    while wk <= total_weeks - 1 loop
      target_weeks := target_weeks || wk;
      wk := wk + 6;
    end loop;

    start_d := r.start_date;

    -- 4. For each scheduled assessment week:
    foreach wk in array target_weeks
    loop
      -- 4a. Flip plan_weeks.phase unless the slot is race-prep critical.
      select pw.phase into current_phase
      from public.plan_weeks pw
      where pw.plan_id = r.id and pw.week_number = wk;

      if current_phase is not null
         and current_phase not in ('taper', 'peak', 'recovery', 'assessment') then
        update public.plan_weeks
           set phase = 'assessment'
         where plan_id = r.id and week_number = wk;
      end if;

      -- 4b. Insert assessment_baseline milestone (kind = midplan for wk > 1,
      --     preplan for wk = 1). Description matches buildAssessmentMilestoneRows
      --     in generate-plan/index.ts so the chip rendering stays truthful.
      if wk = 1 then
        description_text := 'Z2 HR-drift · 20 min troskel · 5 km TT';
      else
        description_text := 'Z2 HR-drift · 5 km tempo · 4x5 min Z4';
      end if;

      insert into public.plan_milestones (
        plan_id, profile_id, sort_order, target_week_number, target_date,
        title, description, metric_type, target_value, target_unit,
        target_distance_km, status, source
      )
      select
        r.id, r.profile_id, 10 + wk,
        wk,
        start_d + ((wk - 1) * 7),
        'Bedomningsvecka v' || wk,
        description_text,
        'assessment_baseline',
        3,
        'pass',
        null,
        'pending',
        'assessment'
      where not exists (
        select 1 from public.plan_milestones pm
        where pm.plan_id = r.id
          and pm.target_week_number = wk
          and pm.metric_type = 'assessment_baseline'
      );
    end loop;

    -- 5. Race-final milestone for race plans (idempotent on plan_id +
    --    target_week_number + metric_type).
    if r.goal_type = 'race' then
      insert into public.plan_milestones (
        plan_id, profile_id, sort_order, target_week_number, target_date,
        title, description, metric_type, target_value, target_unit,
        target_distance_km, status, source
      )
      select
        r.id, r.profile_id, 100,
        total_weeks,
        coalesce(r.end_date, start_d + ((total_weeks - 1) * 7)),
        coalesce(r.goal_text, 'Racemal'),
        'Racedag - exekvera planen och avsluta starkt.',
        'pace_for_distance',
        null,
        case when nullif(r.constraints->>'race_distance_km', '') is not null then 'km' else null end,
        nullif(r.constraints->>'race_distance_km', '')::numeric,
        'pending',
        'ai'
      where not exists (
        select 1 from public.plan_milestones pm
        where pm.plan_id = r.id
          and pm.target_week_number = total_weeks
          and pm.metric_type = 'pace_for_distance'
      );
    end if;
  end loop;
end $$;

-- Verification: per-plan counts of assessment_baseline rows + any leftover
-- qualitative rows (should be 0 for active plans after this migration).
select
  tp.id as plan_id,
  tp.name,
  tp.status,
  count(pm.*) filter (where pm.metric_type = 'assessment_baseline') as assessment_count,
  count(pm.*) filter (where pm.metric_type = 'pace_for_distance') as race_final_count,
  count(pm.*) filter (where pm.metric_type = 'qualitative') as leftover_qualitative
from public.training_plans tp
left join public.plan_milestones pm on pm.plan_id = tp.id
where tp.status = 'active'
group by tp.id, tp.name, tp.status
order by tp.name;
