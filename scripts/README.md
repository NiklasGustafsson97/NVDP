# Admin Scripts

## Backfill Strava for one user

`backfill-strava-user.mjs` runs the deployed `strava-sync` Edge Function in deep-sync mode for a target profile. It uses the existing service-role path in `strava-sync`, so it does not require logging in as the user.

Never paste the service-role key into chat or commit it to a file. Set it only in your shell session.

PowerShell:

```powershell
$env:SUPABASE_URL = "https://<project-ref>.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY = "<service-role-key>"
node .\scripts\backfill-strava-user.mjs --name August --since 2025-01-01
```

Useful checks:

```powershell
node .\scripts\backfill-strava-user.mjs --name August --dry-run
node .\scripts\backfill-strava-user.mjs --profile-id "<profile-uuid>" --since 2025-01-01
```

If more than one profile matches `August`, the script prints matching profile ids and stops. Re-run with `--profile-id`.
