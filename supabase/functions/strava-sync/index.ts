import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  supabaseAdmin,
  refreshTokenIfNeeded,
  activityToWorkout,
  corsHeaders,
  type StravaActivity,
} from "../_shared/strava.ts";

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

    const { profile_id } = await req.json();
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

    // Fetch activities since last sync (or last 30 days)
    const after = conn.last_sync_at
      ? Math.floor(new Date(conn.last_sync_at).getTime() / 1000)
      : Math.floor(Date.now() / 1000) - 30 * 24 * 3600;

    let page = 1;
    let imported = 0;
    let skipped = 0;

    while (page <= 5) {
      const activitiesRes = await fetch(
        `https://www.strava.com/api/v3/athlete/activities?after=${after}&per_page=50&page=${page}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );

      if (!activitiesRes.ok) {
        console.error("Failed to fetch activities:", activitiesRes.status);
        break;
      }

      const activities: StravaActivity[] = await activitiesRes.json();
      if (activities.length === 0) break;

      for (const activity of activities) {
        const workout = activityToWorkout(activity, conn.profile_id);
        const { error: insertErr } = await db.from("workouts").upsert(workout, {
          onConflict: "strava_activity_id",
          ignoreDuplicates: false,
        });

        if (insertErr) {
          console.error("Workout upsert error:", insertErr);
          skipped++;
        } else {
          imported++;
        }
      }

      if (activities.length < 50) break;
      page++;
    }

    // Update last_sync_at
    await db
      .from("strava_connections")
      .update({ last_sync_at: new Date().toISOString() })
      .eq("id", conn.id);

    return new Response(
      JSON.stringify({ imported, skipped, last_sync_at: new Date().toISOString() }),
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
