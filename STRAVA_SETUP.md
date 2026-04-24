# Strava Integration Setup

Follow these steps in order.

## 1. Run SQL Migration

Open Supabase SQL Editor and run the contents of `sql/add_strava.sql`.
This creates the `strava_connections` table with RLS and adds `source`/`strava_activity_id` columns to `workouts`.

## 2. Register a Strava API App

1. Go to [developers.strava.com](https://developers.strava.com/) and log in
2. Under "My API Application", create a new app:
   - **Application Name**: NVDP
   - **Category**: Social
   - **Website**: `https://niklasgustafsson97.github.io/NVDP/`
   - **Authorization Callback Domain**: `enqfhumeachdgupthnci.supabase.co`
3. Note the **Client ID** and **Client Secret**

The app starts in "testing" mode (only your own Strava account works). Submit for review later to allow friends.

## 3. Get Supabase Access Token

1. Go to [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens)
2. Click "Generate new token"
3. Name it "GitHub Actions" and copy the token

## 4. Set GitHub Repository Secrets

Go to your repo at `github.com/NiklasGustafsson97/NVDP` > Settings > Secrets and variables > Actions > New repository secret.

Add these three secrets:

| Secret Name | Value |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | The token from step 3 |
| `SUPABASE_PROJECT_REF` | `enqfhumeachdgupthnci` |

## 5. Set Supabase Edge Function Secrets

In Supabase Dashboard > Edge Functions > Secrets, add:

| Secret Name | Value |
|---|---|
| `STRAVA_CLIENT_ID` | From step 2 |
| `STRAVA_CLIENT_SECRET` | From step 2 |
| `STRAVA_VERIFY_TOKEN` | Any random string (e.g. `nvdp_strava_2026`) |
| `APP_URL` | `https://niklasgustafsson97.github.io/NVDP/` |

Note: `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are auto-available in Edge Functions.

## 6. Set Client ID in config.js

Open `js/config.js` and set `STRAVA_CLIENT_ID` to your actual Client ID from step 2:

```js
const STRAVA_CLIENT_ID = '12345'; // your actual ID
```

## 7. Push Code to Deploy Edge Functions

```bash
git add -A && git commit -m "Add Strava integration" && git push
```

The GitHub Action at `.github/workflows/deploy-functions.yml` will automatically deploy the three Edge Functions. You can also trigger it manually from the Actions tab.

## 8. Register Strava Webhook

After Edge Functions are deployed, register the push-subscription via the
`strava-webhook-register` admin endpoint. This endpoint is idempotent —
re-running it returns the existing subscription instead of failing.

Set `CRON_SECRET` in Edge Function secrets first (any random string;
also used by the daily cron and weekly reminder).

```bash
# Register (idempotent)
curl -X POST "https://enqfhumeachdgupthnci.supabase.co/functions/v1/strava-webhook-register" \
  -H "x-cron-secret: $CRON_SECRET"

# Confirm it's live
curl "https://enqfhumeachdgupthnci.supabase.co/functions/v1/strava-webhook-register" \
  -H "x-cron-secret: $CRON_SECRET"

# Recover from a stuck verify_token (deletes ALL subs, then re-register)
curl -X DELETE "https://enqfhumeachdgupthnci.supabase.co/functions/v1/strava-webhook-register" \
  -H "x-cron-secret: $CRON_SECRET"
```

Strava drops a subscription if our `/strava-webhook` callback returns
non-2xx for ~24h, so re-run the register POST any time the live-import
loop goes quiet.

## Done

After setup, the "Koppla Strava" button appears in the side menu. Workouts sync automatically via webhook and can be manually triggered via "Synka nu".

## Admin: triggering "Synka allt" (deep sync) for a user

The deep-sync button is intentionally NOT exposed in the UI (it can burn ~800-2400 Strava API calls and saturate the per-app 100/15-min budget for everyone). New users get an automatic backfill once at first connect via `strava-auth`. Beyond that, only an admin should trigger a deep sync from outside the UI.

To trigger a deep sync for a user from Cursor chat / devtools:

1. Sign in as that user (or use the service-role key with the user's `profile_id` -- preferred for support cases).
2. From devtools console while signed in as the user, run:

```js
syncStravaAll()
```

The `syncStravaAll` function is still defined on `window` (just not bound to a button). It loops the chunked `/strava-sync` cursor until `done`, pausing for `Retry-After` between chunks if Strava rate-limits.

To trigger it server-side without a browser session (e.g. for a user who can't sign in), POST to the function with that user's JWT:

```bash
curl -X POST "$SUPABASE_FUNCTIONS_URL/strava-sync" \
  -H "Authorization: Bearer <user_jwt>" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"profile_id":"<profile_uuid>","since":"2025-01-01"}'
```

Repeat the call until the response includes `"done": true`. The cursor (`deep_sync_anchor` / `deep_sync_floor` on `strava_connections`) is persisted between calls, so it's safe to interrupt and resume.
