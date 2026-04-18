-- ============================================================================
-- Migration: RLS lockdown
-- Fixes security assessment finding C1 + H6.
-- Replaces the "using (true)" SELECT policies on profiles, workouts, groups,
-- workout_likes, workout_reactions, workout_comments, challenges with policies
-- scoped to owner + friends + same-group members.
--
-- Also introduces:
--   - public.profile_is_visible_to(target_profile uuid) helper
--   - public.join_group_by_code(code text) SECURITY DEFINER RPC
--
-- Idempotent: safe to re-run.
-- ============================================================================

-- ── Helper: can the current JWT user see this target profile? ────────────────
-- Returns true if target_profile is:
--   (a) owned by auth.uid(), or
--   (b) a friend of auth.uid() via an accepted friendship, or
--   (c) in the same group as auth.uid()'s profile.
-- SECURITY DEFINER so table RLS does not short-circuit the visibility check
-- when called from another RLS policy.
create or replace function public.profile_is_visible_to(target_profile uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select
    -- (a) own profile
    exists (
      select 1 from public.profiles p
      where p.id = target_profile and p.user_id = auth.uid()
    )
    -- (b) accepted friendship (either direction)
    or exists (
      select 1
      from public.friendships f
      join public.profiles me on me.user_id = auth.uid()
      where f.status = 'accepted'
        and (
          (f.requester_id = me.id and f.receiver_id = target_profile)
          or (f.receiver_id = me.id and f.requester_id = target_profile)
        )
    )
    -- (c) same group (non-null group required on both sides)
    or exists (
      select 1
      from public.profiles me, public.profiles them
      where me.user_id = auth.uid()
        and them.id = target_profile
        and me.group_id is not null
        and me.group_id = them.group_id
    );
$$;

comment on function public.profile_is_visible_to(uuid) is
  'Returns true if the JWT-authenticated caller may see the given profile (self / friend / group member). Used by RLS policies.';

revoke all on function public.profile_is_visible_to(uuid) from public;
grant execute on function public.profile_is_visible_to(uuid) to authenticated;


-- ── profiles: restrict SELECT to self + friends + same group ─────────────────
alter table public.profiles enable row level security;

drop policy if exists "profiles_select_authenticated" on public.profiles;
drop policy if exists "authenticated_read_profiles"   on public.profiles;
drop policy if exists "profiles_select_visible"        on public.profiles;

create policy "profiles_select_visible"
  on public.profiles for select
  to authenticated
  using ( public.profile_is_visible_to(id) );


-- ── workouts: restrict SELECT to owner + friends + same group ────────────────
alter table public.workouts enable row level security;

drop policy if exists "workouts_select_authenticated" on public.workouts;
drop policy if exists "authenticated_read_workouts"   on public.workouts;
drop policy if exists "workouts_select_visible"        on public.workouts;

create policy "workouts_select_visible"
  on public.workouts for select
  to authenticated
  using ( public.profile_is_visible_to(profile_id) );


-- ── groups: restrict SELECT to creator + current members ─────────────────────
-- Joining a group by code now goes through the SECURITY DEFINER RPC below.
alter table public.groups enable row level security;

drop policy if exists "groups_select_authenticated" on public.groups;
drop policy if exists "groups_select_member_or_creator" on public.groups;

create policy "groups_select_member_or_creator"
  on public.groups for select
  to authenticated
  using (
    -- creator
    exists (
      select 1 from public.profiles p
      where p.id = groups.created_by and p.user_id = auth.uid()
    )
    -- or current member
    or exists (
      select 1 from public.profiles p
      where p.user_id = auth.uid() and p.group_id = groups.id
    )
  );


-- ── join_group_by_code: lookup group by secret code without leaking the table
-- Returns (id, name) for the caller to use; the frontend then patches its
-- profile.group_id to join. SECURITY DEFINER so it can SELECT past RLS.
-- The function leaks only (id, name) and only for a caller-supplied exact code.
create or replace function public.join_group_by_code(p_code text)
returns table (id uuid, name text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'not authenticated';
  end if;
  if p_code is null or length(trim(p_code)) <> 6 then
    raise exception 'invalid code';
  end if;

  return query
    select g.id, g.name
    from public.groups g
    where g.code = upper(trim(p_code))
    limit 1;
end;
$$;

comment on function public.join_group_by_code(text) is
  'Looks up a group by its 6-char join code. Returns (id, name) only. Used by the join-by-code UI without exposing the full groups table.';

revoke all on function public.join_group_by_code(text) from public;
grant execute on function public.join_group_by_code(text) to authenticated;


-- ── workout_likes: restrict SELECT to liker + workout-owner + visible workout
alter table public.workout_likes enable row level security;

drop policy if exists "wl_select_auth"     on public.workout_likes;
drop policy if exists "wl_select_visible"  on public.workout_likes;

create policy "wl_select_visible"
  on public.workout_likes for select
  to authenticated
  using (
    -- own like
    profile_id in (select id from public.profiles where user_id = auth.uid())
    -- or like on a workout belonging to a visible profile
    or exists (
      select 1 from public.workouts w
      where w.id = workout_likes.workout_id
        and public.profile_is_visible_to(w.profile_id)
    )
  );


-- ── workout_reactions: same policy as workout_likes ──────────────────────────
alter table public.workout_reactions enable row level security;

drop policy if exists "wr_select_authenticated" on public.workout_reactions;
drop policy if exists "wr_select_visible"       on public.workout_reactions;

create policy "wr_select_visible"
  on public.workout_reactions for select
  to authenticated
  using (
    profile_id in (select id from public.profiles where user_id = auth.uid())
    or exists (
      select 1 from public.workouts w
      where w.id = workout_reactions.workout_id
        and public.profile_is_visible_to(w.profile_id)
    )
  );


-- ── workout_comments: same policy ────────────────────────────────────────────
alter table public.workout_comments enable row level security;

drop policy if exists "wc_select_authenticated" on public.workout_comments;
drop policy if exists "wc_select_visible"       on public.workout_comments;

create policy "wc_select_visible"
  on public.workout_comments for select
  to authenticated
  using (
    profile_id in (select id from public.profiles where user_id = auth.uid())
    or exists (
      select 1 from public.workouts w
      where w.id = workout_comments.workout_id
        and public.profile_is_visible_to(w.profile_id)
    )
  );


-- ── challenges: restrict SELECT to members of challenge's group ─────────────
alter table public.challenges enable row level security;

drop policy if exists "ch_select_authenticated" on public.challenges;
drop policy if exists "ch_select_member"        on public.challenges;

create policy "ch_select_member"
  on public.challenges for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.user_id = auth.uid() and p.group_id = challenges.group_id
    )
  );


-- ── Verification ────────────────────────────────────────────────────────────
select 'RLS lockdown applied' as status;
