-- Allow users to update their own plan_workouts (via plan_weeks -> training_plans ownership)
CREATE POLICY pwo_update_own ON public.plan_workouts
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.plan_weeks pw
      JOIN public.training_plans tp ON tp.id = pw.plan_id
      WHERE pw.id = plan_workouts.plan_week_id
        AND tp.profile_id = (
          SELECT p.id FROM public.profiles p WHERE p.user_id = auth.uid() LIMIT 1
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.plan_weeks pw
      JOIN public.training_plans tp ON tp.id = pw.plan_id
      WHERE pw.id = plan_workouts.plan_week_id
        AND tp.profile_id = (
          SELECT p.id FROM public.profiles p WHERE p.user_id = auth.uid() LIMIT 1
        )
    )
  );
