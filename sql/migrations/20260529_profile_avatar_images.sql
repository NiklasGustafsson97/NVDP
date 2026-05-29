-- ============================================================================
-- Migration: image avatars on profiles
--
-- Why: avatars were emoji/initials only (profiles.avatar text). Add two image
--   URL columns so a user's own choice and the Strava fallback never clobber
--   each other:
--     avatar_url        - the user's own uploaded photo (Supabase Storage URL)
--     strava_avatar_url - the photo Strava returns at connect (fallback only)
--
--   Render precedence (frontend resolveAvatar): avatar_url > avatar (emoji) >
--   strava_avatar_url > first letter of name.
--
-- Idempotent: safe to re-run.
-- ============================================================================

do $$ begin
  alter table public.profiles add column avatar_url text;
exception when duplicate_column then null;
end $$;

do $$ begin
  alter table public.profiles add column strava_avatar_url text;
exception when duplicate_column then null;
end $$;

comment on column public.profiles.avatar_url is
  'User-uploaded profile photo (public Supabase Storage URL). Highest render precedence.';
comment on column public.profiles.strava_avatar_url is
  'Profile photo fetched from Strava at connect. Fallback only - never overrides avatar_url or the emoji avatar.';

select 'profiles.avatar_url + strava_avatar_url installed' as status;
