import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  STRAVA_VERIFY_TOKEN,
  supabaseAdmin,
  refreshTokenIfNeeded,
  activityToWorkout,
  shouldImportActivity,
  needsStravaDetail,
  fetchHRZoneSeconds,
  corsHeaders,
  type StravaActivity,
} from "../_shared/strava.ts";

serve(async (req) => {
  // Strava subscription validation (GET)
  if (req.method === "GET") {
    const url = new URL(req.url);
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    // SECURITY (assessment M2): fail closed if the verify token isn't
    // configured — we must never approve a subscription with an empty token.
    if (
      STRAVA_VERIFY_TOKEN &&
      mode === "subscribe" &&
      token === STRAVA_VERIFY_TOKEN &&
      challenge
    ) {
      return new Response(JSON.stringify({ "hub.challenge": challenge }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("Forbidden", { status: 403 });
  }

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(req) });
  }

  // Strava event webhook (POST)
  if (req.method === "POST") {
    try {
      const event = await req.json();

      // Only handle activity create/update events
      if (event.object_type !== "activity") {
        return new Response("ok", { status: 200 });
      }

      // Deauthorize events
      if (event.aspect_type === "delete") {
        return new Response("ok", { status: 200 });
      }

      const athleteId = event.owner_id;
      const activityId = event.object_id;

      const db = supabaseAdmin();

      // Find the user by Strava athlete ID
      const { data: conn, error: connErr } = await db
        .from("strava_connections")
        .select("*")
        .eq("strava_athlete_id", athleteId)
        .single();

      if (connErr || !conn) {
        console.error("No connection found for athlete:", athleteId);
        return new Response("ok", { status: 200 });
      }

      // Refresh token if expired
      const accessToken = await refreshTokenIfNeeded(conn);

      // Fetch activity details from Strava
      const actRes = await fetch(
        `https://www.strava.com/api/v3/activities/${activityId}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );

      if (!actRes.ok) {
        console.error("Failed to fetch activity:", actRes.status);
        return new Response("ok", { status: 200 });
      }

      const activity: StravaActivity = await actRes.json();

      if (!shouldImportActivity(activity)) {
        return new Response("ok", { status: 200 });
      }

      const workout = activityToWorkout(activity, conn.profile_id);

      // Skip the HR-zones call for activities that don't render zone
      // breakdowns (Gym/Hyrox/Stakmaskin/Annat). Saves 1 of 2 Strava
      // calls per webhook for these types -- meaningful when a single
      // gym session can otherwise spend 2 calls of the 100/15-min
      // application budget.
      if (activity.has_heartrate && needsStravaDetail(activity)) {
        const zoneSeconds = await fetchHRZoneSeconds(activityId, accessToken);
        if (zoneSeconds) workout.hr_zone_seconds = JSON.stringify(zoneSeconds);
      }

      // Upsert: if strava_activity_id already exists, update it
      const { error: insertErr } = await db.from("workouts").upsert(workout, {
        onConflict: "strava_activity_id",
        ignoreDuplicates: false,
      });

      if (insertErr) {
        console.error("Workout insert error:", insertErr);
      } else {
        // Update last_sync_at
        await db
          .from("strava_connections")
          .update({ last_sync_at: new Date().toISOString() })
          .eq("id", conn.id);
      }

      return new Response("ok", { status: 200 });
    } catch (err) {
      console.error("strava-webhook error:", err);
      return new Response("error", { status: 200 }); // Return 200 to prevent Strava retries
    }
  }

  return new Response("Method not allowed", { status: 405 });
});
