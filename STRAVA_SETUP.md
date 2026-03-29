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

After Edge Functions are deployed, register the webhook subscription (one-time):

```bash
curl -X POST https://www.strava.com/api/v3/push_subscriptions \
  -d client_id=YOUR_CLIENT_ID \
  -d client_secret=YOUR_CLIENT_SECRET \
  -d callback_url=https://enqfhumeachdgupthnci.supabase.co/functions/v1/strava-webhook \
  -d verify_token=nvdp_strava_2026
```

Replace `YOUR_CLIENT_ID`, `YOUR_CLIENT_SECRET`, and `verify_token` with your actual values.
The `verify_token` must match the `STRAVA_VERIFY_TOKEN` secret set in step 5.

## Done

After setup, the "Koppla Strava" button appears in the side menu. Workouts sync automatically via webhook and can be manually triggered via "Synka nu".
