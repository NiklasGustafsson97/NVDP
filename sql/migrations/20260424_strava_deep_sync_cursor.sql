-- Robust Strava deep-sync cursor: lets the strava-sync edge function
-- chunk a multi-month backfill across many short invocations instead
-- of trying to do it all in one call (which 503'd on Supabase's ~150s
-- wall-clock budget). Each chunk reads the cursor, fetches one page of
-- summaries with ?before=anchor&after=floor, processes them, then
-- advances `deep_sync_anchor` to the oldest activity start_ts in that
-- batch. When the cursor walks past the floor (or Strava returns < 200
-- activities), the deep sync is done and both columns are reset to NULL.

alter table public.strava_connections
  add column if not exists deep_sync_floor bigint,
  add column if not exists deep_sync_anchor bigint;

comment on column public.strava_connections.deep_sync_floor is
  'Epoch sec -- original "since" floor of an in-progress deep sync. Null when no deep sync is active.';
comment on column public.strava_connections.deep_sync_anchor is
  'Epoch sec -- oldest activity start_ts already processed in this deep sync (cursor walks back-in-time). Null = start from now.';

notify pgrst, 'reload schema';
