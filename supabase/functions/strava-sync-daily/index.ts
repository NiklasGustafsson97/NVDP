// strava-sync-daily — server-side safety-net poll for Strava activities.
//
// Why this exists:
//   The webhook (strava-webhook) catches new activities in real time, so
//   in steady state we need ZERO client polling. But webhooks can be
//   missed: Strava drops a subscription if our callback returns non-2xx
//   for ~24h, and the user app might not open for days at a time. To
//   make sure we never silently lose activities, this function runs
//   ONCE per day at ~04:00 UTC (low traffic for Strava and us) and runs
//   the same incremental /strava-sync logic for every connected user
//   that hasn't been synced in the last 18h.
//
//   Cost: 30 users × ~1.2 Strava list calls + ~0 detail/zone calls (most
//   activities will already be webhook-imported and dedupe via the
//   strava_activity_id unique constraint) = ~36 calls per day. That's
//   <10% of the daily 1000-call budget at 30 users, leaves the
//   100/15-min interactive headroom untouched.
//
// Trigger:
//   pg_cron via the migration sql/migrations/20260425_strava_daily_cron.sql
//   (and Supabase Vault for the CRON_SECRET).
//
// Auth:
//   Same defence-in-depth pattern as weekly-checkin-reminder /
//   strava-webhook-register: requires `x-cron-secret: <CRON_SECRET>` OR
//   a service-role bearer token. Deployed with --no-verify-jwt because
//   the cron caller has neither a user JWT nor a Supabase JWT.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") || "";

// Skip users we've heard from in the last 18h. We round DOWN from 24h
// so the same row is never skipped two days in a row purely because
// the cron drifted slightly later than the prior run.
const STALE_THRESHOLD_MS = 18 * 60 * 60 * 1000;

// Hard cap on per-user wall time inside the cron. The strava-sync edge
// function has its own ~90s budget; if a user's connection is hung we
// don't want to block the rest of the queue.
const PER_USER_TIMEOUT_MS = 30_000;

// Process users sequentially with a small inter-user pause. With the
// per-user incremental sync now down to 1 page × 30 acts × ~3 detail
// fetches each, this finishes 30 users in ~3 minutes well below
// Supabase's edge-fn ~150s wall-clock per request. (We invoke
// strava-sync per user rather than batch-importing in this function
// to keep all the activity-mapping logic in one place.)
const INTER_USER_PAUSE_MS = 500;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface StravaConnRow {
  id: string;
  profile_id: string;
  last_sync_at: string | null;
}

async function syncOneUser(profileId: string): Promise<{ ok: boolean; status: number; body: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PER_USER_TIMEOUT_MS);
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/strava-sync`, {
      method: "POST",
      headers: {
        // Service role can call any user's sync; strava-sync trusts it
        // when no user JWT is present and uses the body's profile_id.
        "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
        "apikey": SUPABASE_SERVICE_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ profile_id: profileId, since: null }),
      signal: ctrl.signal,
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body: body.slice(0, 500) };
  } catch (err) {
    return { ok: false, status: 0, body: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

serve(async (req) => {
  // Defence in depth: same auth gate as weekly-checkin-reminder.
  const auth = req.headers.get("authorization") || "";
  const cronToken = req.headers.get("x-cron-secret") || "";
  const serviceOk = !!SUPABASE_SERVICE_KEY && auth.includes(SUPABASE_SERVICE_KEY);
  const cronOk = !!CRON_SECRET && cronToken === CRON_SECRET;
  if (!serviceOk && !cronOk) {
    return json({ error: "unauthorized" }, 401);
  }

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { data: conns, error: connErr } = await db
    .from("strava_connections")
    .select("id, profile_id, last_sync_at");

  if (connErr) {
    console.error("strava-sync-daily: failed to list connections", connErr);
    return json({ error: "db_error", detail: connErr.message }, 500);
  }

  const cutoff = Date.now() - STALE_THRESHOLD_MS;
  const todo = (conns ?? []).filter((c: StravaConnRow) => {
    if (!c.last_sync_at) return true;
    return new Date(c.last_sync_at).getTime() < cutoff;
  });

  const results: Array<{ profile_id: string; status: number; ok: boolean; note?: string }> = [];
  for (const c of todo) {
    const out = await syncOneUser(c.profile_id);
    results.push({
      profile_id: c.profile_id,
      status: out.status,
      ok: out.ok,
      note: out.ok ? undefined : out.body,
    });
    await new Promise((r) => setTimeout(r, INTER_USER_PAUSE_MS));
  }

  return json({
    scanned: conns?.length ?? 0,
    synced: todo.length,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  });
});
