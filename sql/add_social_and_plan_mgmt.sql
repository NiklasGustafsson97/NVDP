-- =============================================================================
-- Social features + plan management enhancements
-- Run AFTER schema.sql and add_training_plans.sql. Safe to re-run.
-- =============================================================================

-- ── Add name column to training_plans ──────────────────────────────
alter table public.training_plans add column if not exists name text;

-- ── friendships ────────────────────────────────────────────────────
create table if not exists public.friendships (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles (id) on delete cascade,
  receiver_id uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fs_status_check check (status in ('pending', 'accepted', 'declined', 'blocked')),
  constraint fs_no_self check (requester_id <> receiver_id),
  constraint fs_unique_pair unique (requester_id, receiver_id)
);

comment on table public.friendships is 'Directional friend requests. Accepted = mutual visibility.';

create index if not exists friendships_requester_idx on public.friendships (requester_id);
create index if not exists friendships_receiver_idx on public.friendships (receiver_id);

-- ── workout_likes ──────────────────────────────────────────────────
create table if not exists public.workout_likes (
  id uuid primary key default gen_random_uuid(),
  workout_id uuid not null references public.workouts (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint wl_unique unique (workout_id, profile_id)
);

comment on table public.workout_likes is 'Simple like per workout per user (social feed).';

create index if not exists workout_likes_workout_idx on public.workout_likes (workout_id);

-- ── RLS ────────────────────────────────────────────────────────────

alter table public.friendships enable row level security;
alter table public.workout_likes enable row level security;

-- friendships: see your own requests (sent or received)
do $$ begin
  create policy "fs_select_own" on public.friendships
    for select to authenticated
    using (
      requester_id in (select id from public.profiles where user_id = auth.uid())
      or receiver_id in (select id from public.profiles where user_id = auth.uid())
    );
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "fs_insert_own" on public.friendships
    for insert to authenticated
    with check (
      requester_id in (select id from public.profiles where user_id = auth.uid())
    );
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "fs_update_own" on public.friendships
    for update to authenticated
    using (
      receiver_id in (select id from public.profiles where user_id = auth.uid())
    )
    with check (
      receiver_id in (select id from public.profiles where user_id = auth.uid())
    );
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "fs_delete_own" on public.friendships
    for delete to authenticated
    using (
      requester_id in (select id from public.profiles where user_id = auth.uid())
      or receiver_id in (select id from public.profiles where user_id = auth.uid())
    );
exception when duplicate_object then null;
end $$;

-- workout_likes: read by anyone authenticated, write own
do $$ begin
  create policy "wl_select_auth" on public.workout_likes
    for select to authenticated using (true);
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "wl_insert_own" on public.workout_likes
    for insert to authenticated
    with check (
      profile_id in (select id from public.profiles where user_id = auth.uid())
    );
exception when duplicate_object then null;
end $$;

do $$ begin
  create policy "wl_delete_own" on public.workout_likes
    for delete to authenticated
    using (
      profile_id in (select id from public.profiles where user_id = auth.uid())
    );
exception when duplicate_object then null;
end $$;
