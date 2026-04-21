-- ============================================================================
-- Migration: SECURITY DEFINER RPC for friend discovery
--
-- Why: 20260418_rls_lockdown.sql restricted SELECT on `profiles` to
--   self + friends + same group. That broke the "Sök användare" /
--   "Lägg till vän" flows in the topbar and on the Social tab — a brand-new
--   user has no friends yet and therefore literally cannot see anyone else's
--   profile to send a friend request to. Same chicken-and-egg as group code.
--
-- Fix: expose a tightly-scoped RPC that returns only (id, name, avatar, color)
--   for any profile whose name matches an exact-or-substring search.
--   Authenticated users only. Result is hard-capped to 25 rows and queries
--   shorter than 2 chars are rejected to limit enumeration.
--   The RPC excludes the caller themselves.
--
-- Idempotent: safe to re-run.
-- ============================================================================

create or replace function public.search_profiles_by_name(p_query text)
returns table (id uuid, name text, avatar text, color text)
language sql
security definer
stable
set search_path = public
as $$
  select p.id, p.name, p.avatar, p.color
  from public.profiles p
  where p.user_id is not null
    and length(trim(coalesce(p_query, ''))) >= 2
    and p.name ilike '%' || trim(p_query) || '%'
    and p.id <> coalesce(
      (select id from public.profiles where user_id = auth.uid() limit 1),
      '00000000-0000-0000-0000-000000000000'::uuid
    )
  order by p.name
  limit 25;
$$;

comment on function public.search_profiles_by_name(text) is
  'Returns up to 25 profiles whose name matches the substring p_query (≥ 2 chars). Used by the friend-discovery UI without exposing the full profiles table. Returns only id/name/avatar/color — never email or workout data.';

revoke all on function public.search_profiles_by_name(text) from public;
grant execute on function public.search_profiles_by_name(text) to authenticated;

select 'search_profiles_by_name RPC installed' as status;
