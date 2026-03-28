-- ============================================================================
-- Migration: Add nudges system + push subscriptions
-- Run this ONCE in Supabase SQL Editor
-- ============================================================================

-- Nudges table: tracks who nudged whom and when
create table if not exists public.nudges (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles(id) on delete cascade,
  receiver_id uuid not null references public.profiles(id) on delete cascade,
  message text not null default 'Du har fått en puff! Dags att träna! 💪',
  seen boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists nudges_receiver_idx on public.nudges (receiver_id, seen, created_at desc);

-- Push subscriptions table: stores Web Push subscription objects per profile
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  endpoint text not null,
  keys_p256dh text not null,
  keys_auth text not null,
  created_at timestamptz not null default now(),
  constraint push_sub_unique_endpoint unique (profile_id, endpoint)
);

-- RLS for nudges
alter table public.nudges enable row level security;

-- Authenticated users can read nudges sent to them
create policy "nudges_select_receiver"
  on public.nudges for select to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = receiver_id and p.user_id = auth.uid())
    or exists (select 1 from public.profiles p where p.id = sender_id and p.user_id = auth.uid())
  );

-- Authenticated users can insert nudges (sender must be own profile)
create policy "nudges_insert_sender"
  on public.nudges for insert to authenticated
  with check (
    exists (select 1 from public.profiles p where p.id = sender_id and p.user_id = auth.uid())
  );

-- Receiver can mark nudges as seen
create policy "nudges_update_receiver"
  on public.nudges for update to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = receiver_id and p.user_id = auth.uid())
  )
  with check (
    exists (select 1 from public.profiles p where p.id = receiver_id and p.user_id = auth.uid())
  );

-- RLS for push_subscriptions
alter table public.push_subscriptions enable row level security;

create policy "push_sub_select_own"
  on public.push_subscriptions for select to authenticated
  using (exists (select 1 from public.profiles p where p.id = profile_id and p.user_id = auth.uid()));

create policy "push_sub_insert_own"
  on public.push_subscriptions for insert to authenticated
  with check (exists (select 1 from public.profiles p where p.id = profile_id and p.user_id = auth.uid()));

create policy "push_sub_delete_own"
  on public.push_subscriptions for delete to authenticated
  using (exists (select 1 from public.profiles p where p.id = profile_id and p.user_id = auth.uid()));

select 'Nudges + push_subscriptions tables created with RLS' as status;
