-- ============================================================================
-- Ensure workout_invitations table exists (may already exist if run manually)
-- ============================================================================

create table if not exists public.workout_invitations (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles(id) on delete cascade,
  receiver_id uuid not null references public.profiles(id) on delete cascade,
  workout_date date not null,
  activity_type text not null,
  duration_minutes int,
  intensity text,
  description text,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  constraint wi_unique_per_day unique (sender_id, receiver_id, workout_date),
  constraint wi_valid_status check (status in ('pending', 'accepted', 'declined'))
);

create index if not exists wi_receiver_idx on public.workout_invitations (receiver_id, status);
create index if not exists wi_sender_idx on public.workout_invitations (sender_id, status);
create index if not exists wi_date_idx on public.workout_invitations (workout_date);

alter table public.workout_invitations enable row level security;

drop policy if exists "wi_select_own" on public.workout_invitations;
create policy "wi_select_own"
  on public.workout_invitations for select to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = sender_id and p.user_id = auth.uid())
    or exists (select 1 from public.profiles p where p.id = receiver_id and p.user_id = auth.uid())
  );

drop policy if exists "wi_insert_sender" on public.workout_invitations;
create policy "wi_insert_sender"
  on public.workout_invitations for insert to authenticated
  with check (
    exists (select 1 from public.profiles p where p.id = sender_id and p.user_id = auth.uid())
  );

drop policy if exists "wi_update_participant" on public.workout_invitations;
create policy "wi_update_participant"
  on public.workout_invitations for update to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = receiver_id and p.user_id = auth.uid())
    or exists (select 1 from public.profiles p where p.id = sender_id and p.user_id = auth.uid())
  )
  with check (
    exists (select 1 from public.profiles p where p.id = receiver_id and p.user_id = auth.uid())
    or exists (select 1 from public.profiles p where p.id = sender_id and p.user_id = auth.uid())
  );

drop policy if exists "wi_delete_own" on public.workout_invitations;
create policy "wi_delete_own"
  on public.workout_invitations for delete to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = sender_id and p.user_id = auth.uid())
  );

-- Ensure nudge columns exist
alter table public.nudges add column if not exists type text not null default 'nudge';
alter table public.nudges add column if not exists reference_id uuid;

select 'workout_invitations table ensured with RLS' as status;
