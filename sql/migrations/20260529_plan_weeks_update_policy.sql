-- Allow users to update their own plan_weeks (via training_plans ownership).
-- The per-week deload toggle writes plan_weeks.phase, but plan_weeks only had
-- SELECT/INSERT/DELETE policies — UPDATE was silently denied by RLS, so the
-- toggle showed a success toast while nothing was persisted. Mirrors the
-- plan_workouts UPDATE policy added in 20260416.
-- Idempotent: drop-if-exists ensures the migration workflow can retry safely.
drop policy if exists pw_update_own on public.plan_weeks;

create policy pw_update_own on public.plan_weeks
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.training_plans tp
      WHERE tp.id = plan_weeks.plan_id
        AND tp.profile_id = (
          SELECT p.id FROM public.profiles p WHERE p.user_id = auth.uid() LIMIT 1
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.training_plans tp
      WHERE tp.id = plan_weeks.plan_id
        AND tp.profile_id = (
          SELECT p.id FROM public.profiles p WHERE p.user_id = auth.uid() LIMIT 1
        )
    )
  );
