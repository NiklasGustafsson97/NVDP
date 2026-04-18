import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  SUPABASE_URL,
  supabaseAdmin,
  refreshTokenIfNeeded,
  activityToWorkout,
  shouldImportActivity,
  fetchHRZoneSeconds,
  corsHeaders,
  type StravaActivity,
} from "../_shared/strava.ts";

const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders() });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "No auth header" }), {
        status: 401,
        headers: { ...corsHeaders(), "Content-Type": "application/json" },
      });
    }

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { ...corsHeaders(), "Content-Type": "application/json" },
      });
    }

    const { profile_id, since } = await req.json();
    if (!profile_id) {
      return new Response(JSON.stringify({ error: "Missing profile_id" }), {
        status: 400,
        headers: { ...corsHeaders(), "Content-Type": "application/json" },
      });
    }

    const db = supabaseAdmin();

    const { data: conn, error: connErr } = await db
      .from("strava_connections")
      .select("*")
      .eq("profile_id", profile_id)
      .single();

    if (connErr || !conn) {
      return new Response(
        JSON.stringify({ error: "No Strava connection found" }),
        { status: 404, headers: { ...corsHeaders(), "Content-Type": "application/json" } }
      );
    }

    const accessToken = await refreshTokenIfNeeded(conn);

    // Always look back at least 14 days for normal sync (catches edge cases
    // where Strava's start_date sits right at the previous boundary). Deep
    // sync (no since) goes back 60 days.
    const fourteenDaysAgo = Math.floor(Date.now() / 1000) - 14 * 24 * 3600;
    let after: number;
    if (since) {
      const sinceTs = Math.floor(new Date(since).getTime() / 1000);
      after = Math.min(sinceTs, fourteenDaysAgo);
    } else {
      const sixtyDaysAgo = Math.floor(Date.now() / 1000) - 60 * 24 * 3600;
      const lastSyncTs = conn.last_sync_at
        ? Math.floor(new Date(conn.last_sync_at).getTime() / 1000)
        : 0;
      after = Math.min(lastSyncTs || sixtyDaysAgo, fourteenDaysAgo);
    }

    let page = 1;
    let imported = 0;
    let skipped = 0;
    let skippedShort = 0;
    let skippedType = 0;
    let skippedError = 0;
    let totalFetched = 0;
    let firstError: string | null = null;
    const activityLog: Array<Record<string, unknown>> = [];
    const debug: Record<string, unknown> = {
      after,
      after_date: new Date(after * 1000).toISOString(),
      last_sync_at: conn.last_sync_at,
      activity_log: activityLog,
    };

    // First verify the token works by checking athlete profile
    const athleteRes = await fetch("https://www.strava.com/api/v3/athlete", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!athleteRes.ok) {
      const errBody = await athleteRes.text();
      return new Response(
        JSON.stringify({ error: "Strava API error", status: athleteRes.status, detail: errBody }),
        { status: 502, headers: { ...corsHeaders(), "Content-Type": "application/json" } }
      );
    }
    const athlete = await athleteRes.json();
    debug.athlete_id = athlete.id;
    debug.token_scope = conn.access_token ? "present" : "missing";

    const maxPages = since ? 10 : 5;
    while (page <= maxPages) {
      const url = `https://www.strava.com/api/v3/athlete/activities?after=${after}&per_page=50&page=${page}`;
      const activitiesRes = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!activitiesRes.ok) {
        const errBody = await activitiesRes.text();
        debug.activities_error = { status: activitiesRes.status, body: errBody };
        break;
      }

      const activities: StravaActivity[] = await activitiesRes.json();
      totalFetched += activities.length;
      if (activities.length === 0) break;

      for (const summaryActivity of activities) {
        const sportType = summaryActivity.sport_type || summaryActivity.type;
        const movingMin = Math.round((summaryActivity.moving_time || 0) / 60);
        const baseLog = {
          id: summaryActivity.id,
          name: summaryActivity.name,
          type: sportType,
          start: summaryActivity.start_date_local,
          moving_min: movingMin,
        };

        if (summaryActivity.moving_time < 300) {
          activityLog.push({ ...baseLog, action: "skipped_short" });
          skippedShort++;
          skipped++;
          continue;
        }
        if (!shouldImportActivity(summaryActivity)) {
          activityLog.push({ ...baseLog, action: "skipped_type" });
          skippedType++;
          skipped++;
          continue;
        }

        // Fetch detailed activity for splits, laps, perceived_exertion
        let activity: StravaActivity = summaryActivity;
        try {
          const detailRes = await fetch(
            `https://www.strava.com/api/v3/activities/${summaryActivity.id}`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );
          if (detailRes.ok) {
            activity = await detailRes.json();
          }
        } catch { /* fall back to summary data */ }

        const workout = activityToWorkout(activity, conn.profile_id);

        // Fetch HR zone distribution if HR data exists
        if (activity.has_heartrate || activity.average_heartrate) {
          const zoneSeconds = await fetchHRZoneSeconds(activity.id, accessToken);
          if (zoneSeconds) workout.hr_zone_seconds = JSON.stringify(zoneSeconds);
        }

        const { error: upsertErr } = await db.from("workouts").upsert(workout, {
          onConflict: "strava_activity_id",
          ignoreDuplicates: false,
        });

        if (upsertErr) {
          console.error("Workout upsert error:", upsertErr);
          if (!firstError) firstError = JSON.stringify(upsertErr);
          activityLog.push({ ...baseLog, action: "error", err: String(upsertErr.message || upsertErr) });
          skippedError++;
          skipped++;
        } else {
          activityLog.push({ ...baseLog, action: "imported" });
          imported++;
        }
      }

      if (activities.length < 50) break;
      page++;
    }

    // Only update last_sync_at if we actually fetched activities from Strava
    const newSyncAt = totalFetched > 0 ? new Date().toISOString() : null;
    if (newSyncAt) {
      await db
        .from("strava_connections")
        .update({ last_sync_at: newSyncAt })
        .eq("id", conn.id);
    }

    if (firstError) debug.firstError = firstError;
    return new Response(
      JSON.stringify({
        imported,
        skipped,
        skippedShort,
        skippedType,
        skippedError,
        totalFetched,
        last_sync_at: newSyncAt,
        debug,
      }),
      {
        status: 200,
        headers: { ...corsHeaders(), "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    console.error("strava-sync error:", err);
    return new Response(
      JSON.stringify({ error: "Internal error" }),
      { status: 500, headers: { ...corsHeaders(), "Content-Type": "application/json" } }
    );
  }
});
