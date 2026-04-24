import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  STRAVA_CLIENT_ID,
  STRAVA_CLIENT_SECRET,
  APP_URL,
  supabaseAdmin,
  corsHeaders,
} from "../_shared/strava.ts";

// SECURITY (assessment H2): `state` was previously the user's profile_id,
// which is trivially guessable and lets an attacker silently link their own
// Strava account to someone else's profile. We now validate `state` against
// `public.oauth_states` (issued by the `oauth-state` Edge Function) and treat
// states as single-use. The DB-stored profile_id is authoritative — the
// request's state can never again directly address a profile.

const STATE_MAX_AGE_SECONDS = 15 * 60;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(req) });
  }

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error || !code || !state) {
    return Response.redirect(
      `${APP_URL}?strava_error=${encodeURIComponent(error || "missing_code")}`,
      302,
    );
  }

  const db = supabaseAdmin();

  // Validate + consume the state.
  const { data: stateRow, error: stateErr } = await db
    .from("oauth_states")
    .select("profile_id, provider, created_at, used_at")
    .eq("state", state)
    .maybeSingle();
  if (stateErr || !stateRow) {
    console.error("strava-auth: unknown state", stateErr);
    return Response.redirect(`${APP_URL}?strava_error=invalid_state`, 302);
  }
  if (stateRow.provider !== "strava") {
    return Response.redirect(`${APP_URL}?strava_error=invalid_state`, 302);
  }
  if (stateRow.used_at) {
    return Response.redirect(`${APP_URL}?strava_error=state_already_used`, 302);
  }
  const ageSeconds = (Date.now() - new Date(stateRow.created_at).getTime()) / 1000;
  if (ageSeconds > STATE_MAX_AGE_SECONDS) {
    return Response.redirect(`${APP_URL}?strava_error=state_expired`, 302);
  }
  const profileId = stateRow.profile_id as string;
  await db
    .from("oauth_states")
    .update({ used_at: new Date().toISOString() })
    .eq("state", state);

  try {
    const tokenRes = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: STRAVA_CLIENT_ID,
        client_secret: STRAVA_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenRes.ok) {
      // Do not leak upstream body to the client (assessment H4). Log only.
      const errText = await tokenRes.text();
      console.error("strava-auth: token exchange failed", errText);
      return Response.redirect(`${APP_URL}?strava_error=token_exchange_failed`, 302);
    }

    const tokenData = await tokenRes.json();
    const { access_token, refresh_token, expires_at, athlete } = tokenData;

    // Remove any previous connection for this Strava athlete from a different
    // profile so the unique constraint on strava_athlete_id won't block us.
    await db
      .from("strava_connections")
      .delete()
      .eq("strava_athlete_id", athlete.id)
      .neq("profile_id", profileId);

    // Detect whether this is the user's first-ever Strava connect. If so,
    // pre-seed the deep-sync cursor on the row so the client can begin
    // chunked backfill immediately (loop /strava-sync with `since`) without
    // a separate "click here to import history" affordance.
    //
    // Window: 90 days back covers the PMC fitness/fatigue model's useful
    // memory (CTL has a 42-day τ; 90 days fully primes it). Going further
    // back is purely cosmetic for the long-history charts and would burn
    // ~3-5x more Strava budget per new user.
    const { data: prior } = await db
      .from("strava_connections")
      .select("id, last_sync_at, deep_sync_floor")
      .eq("profile_id", profileId)
      .maybeSingle();

    const isFirstConnect = !prior || (!prior.last_sync_at && !prior.deep_sync_floor);
    const nowSec = Math.floor(Date.now() / 1000);
    const ninetyDaysAgo = nowSec - 90 * 24 * 3600;

    const upsertRow: Record<string, unknown> = {
      profile_id: profileId,
      strava_athlete_id: athlete.id,
      access_token,
      refresh_token,
      expires_at,
    };
    if (isFirstConnect) {
      upsertRow.deep_sync_floor = ninetyDaysAgo;
      upsertRow.deep_sync_anchor = null;
    }

    const { error: upsertErr } = await db.from("strava_connections").upsert(
      upsertRow,
      { onConflict: "profile_id" },
    );

    if (upsertErr) {
      console.error("strava-auth: DB upsert error", upsertErr);
      return Response.redirect(`${APP_URL}?strava_error=db_error`, 302);
    }

    const redirectUrl = isFirstConnect
      ? `${APP_URL}?strava_connected=true&first_connect=1`
      : `${APP_URL}?strava_connected=true`;
    return Response.redirect(redirectUrl, 302);
  } catch (err) {
    console.error("strava-auth error", err);
    return Response.redirect(`${APP_URL}?strava_error=unknown`, 302);
  }
});
