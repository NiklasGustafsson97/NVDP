-- ============================================================================
-- Migration: Enable RLS on unprotected tables (challenges, workout_reactions,
--            workout_comments) and add per-operation policies.
-- ============================================================================

-- ── workout_reactions ──

alter table public.workout_reactions enable row level security;

create policy "wr_select_authenticated"
  on public.workout_reactions for select to authenticated
  using (true);

create policy "wr_insert_own"
  on public.workout_reactions for insert to authenticated
  with check (
    exists (select 1 from public.profiles p where p.id = profile_id and p.user_id = auth.uid())
  );

create policy "wr_update_own"
  on public.workout_reactions for update to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = profile_id and p.user_id = auth.uid())
  )
  with check (
    exists (select 1 from public.profiles p where p.id = profile_id and p.user_id = auth.uid())
  );

create policy "wr_delete_own"
  on public.workout_reactions for delete to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = profile_id and p.user_id = auth.uid())
  );

-- ── workout_comments ──

alter table public.workout_comments enable row level security;

create policy "wc_select_authenticated"
  on public.workout_comments for select to authenticated
  using (true);

create policy "wc_insert_own"
  on public.workout_comments for insert to authenticated
  with check (
    exists (select 1 from public.profiles p where p.id = profile_id and p.user_id = auth.uid())
  );

create policy "wc_update_own"
  on public.workout_comments for update to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = profile_id and p.user_id = auth.uid())
  )
  with check (
    exists (select 1 from public.profiles p where p.id = profile_id and p.user_id = auth.uid())
  );

create policy "wc_delete_own"
  on public.workout_comments for delete to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = profile_id and p.user_id = auth.uid())
  );

-- ── challenges ──

alter table public.challenges enable row level security;

create policy "ch_select_authenticated"
  on public.challenges for select to authenticated
  using (true);

create policy "ch_insert_own"
  on public.challenges for insert to authenticated
  with check (
    exists (select 1 from public.profiles p where p.id = created_by and p.user_id = auth.uid())
  );

create policy "ch_update_creator"
  on public.challenges for update to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = created_by and p.user_id = auth.uid())
  )
  with check (
    exists (select 1 from public.profiles p where p.id = created_by and p.user_id = auth.uid())
  );

create policy "ch_delete_creator"
  on public.challenges for delete to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = created_by and p.user_id = auth.uid())
  );

select 'RLS enabled on challenges, workout_reactions, workout_comments' as status;
