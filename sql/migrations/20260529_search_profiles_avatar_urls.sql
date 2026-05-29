-- ============================================================================
-- Migration: extend search_profiles_by_name to return image avatar URLs
--
-- Why: 20260421_search_profiles_by_name.sql returns (id, name, avatar, color)
--   for friend discovery under a SECURITY DEFINER RPC. Now that profiles carry
--   image avatars (avatar_url + strava_avatar_url), the discovery UI must see
--   them too so search results and friend lists render real photos.
--
-- Changing the RETURNS TABLE signature requires DROP first (create or replace
--   cannot change the return type). Idempotent: safe to re-run.
-- ============================================================================

drop function if exists public.search_profiles_by_name(text);

create or replace function public.search_profiles_by_name(p_query text)
returns table (
  id uuid,
  name text,
  avatar text,
  color text,
  avatar_url text,
  strava_avatar_url text
)
language sql
security definer
stable
set search_path = public
as $$
  select p.id, p.name, p.avatar, p.color, p.avatar_url, p.strava_avatar_url
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
  'Returns up to 25 profiles whose name matches the substring p_query (>= 2 chars). Used by the friend-discovery UI without exposing the full profiles table. Returns only id/name/avatar/color/avatar_url/strava_avatar_url - never email or workout data.';

revoke all on function public.search_profiles_by_name(text) from public;
grant execute on function public.search_profiles_by_name(text) to authenticated;

select 'search_profiles_by_name RPC updated with avatar URLs' as status;
