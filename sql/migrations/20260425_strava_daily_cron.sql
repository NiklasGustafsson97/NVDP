-- Daily safety-net Strava sync cron.
--
-- Purpose:
--   The strava-webhook function imports activities in real time, but
--   webhook deliveries can be missed (Strava drops subscriptions if our
--   callback returns non-2xx for ~24h, server outages, etc.). This cron
--   runs strava-sync-daily once a day to catch anything the webhook
--   missed for any user that hasn't been synced in the last 18h.
--
-- Why 04:00 UTC:
--   Low-traffic window for both us and Strava (06:00 CET / 23:00 PT),
--   so we don't compete with morning workouts being uploaded or any
--   user-facing interactive sync.
--
-- One-time prerequisite (NOT in this migration -- requires Vault):
--   The cron must call our function with the CRON_SECRET in an
--   x-cron-secret header. Store it in Supabase Vault first:
--
--     -- Run once in the SQL editor, replacing <CRON_SECRET> with the
--     -- value you set as the strava-sync-daily Edge Function secret:
--     select vault.create_secret('<CRON_SECRET>', 'strava_cron_secret');
--
--   If you'd rather not use Vault, replace the headers expression below
--   with a literal jsonb object containing the secret. We recommend
--   Vault because the migration files are checked into git.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net  with schema extensions;

-- Idempotent: drop+recreate so a future schedule change (e.g. moving
-- the run time) just requires re-applying this migration.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'strava-sync-daily') then
    perform cron.unschedule('strava-sync-daily');
  end if;
end $$;

select
  cron.schedule(
    'strava-sync-daily',
    '0 4 * * *',  -- 04:00 UTC every day
    $cron$
      select net.http_post(
        url := (select decrypted_secret from vault.decrypted_secrets where name = 'supabase_functions_url') || '/strava-sync-daily',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'strava_cron_secret')
        ),
        body := '{}'::jsonb
      );
    $cron$
  );

-- Helpful sanity-check query for the operator after migration:
--   select jobid, jobname, schedule, active from cron.job where jobname = 'strava-sync-daily';
--   select * from cron.job_run_details where jobid = <jobid> order by start_time desc limit 5;

comment on extension pg_cron is
  'Scheduled jobs for nvdp -- currently: strava-sync-daily (04:00 UTC)';
