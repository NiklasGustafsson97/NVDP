-- SECURITY (assessment H2 + H3): OAuth `state` was previously the user's
-- `profile_id`, which is guessable. Combined with passing the Garmin PKCE
-- `code_verifier` in the URL (H3), this enabled account-linking CSRF and
-- leaked the verifier to browser history, referer headers, and Garmin.
--
-- This migration introduces a server-side store for OAuth state:
--
-- * `state` is a random token, generated per authorize call
-- * `profile_id` records who initiated the flow
-- * `code_verifier` (optional, used for PKCE providers like Garmin) never
--    leaves the server
-- * `used_at` / short expiry makes states single-use and short-lived
--
-- RLS is enabled; no policies are granted. The table is only accessed by
-- trusted Edge Functions using the service-role key
-- (`oauth-state`, `strava-auth`, `garmin-auth`).

create table if not exists public.oauth_states (
  state text primary key,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null check (provider in ('strava', 'garmin')),
  code_verifier text,
  created_at timestamptz not null default now(),
  used_at timestamptz
);

create index if not exists oauth_states_profile_id_idx
  on public.oauth_states (profile_id);
create index if not exists oauth_states_created_at_idx
  on public.oauth_states (created_at);

alter table public.oauth_states enable row level security;

-- No policies; access restricted to service-role (bypasses RLS).
