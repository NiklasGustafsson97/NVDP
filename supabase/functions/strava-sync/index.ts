import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  SUPABASE_URL,
  supabaseAdmin,
  refreshTokenIfNeeded,
  activityToWorkout,
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

    // Always look back at least 7 days to catch missed activities
    const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
    const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 24 * 3600;
    const lastSyncTs = conn.last_sync_at
      ? Math.floor(new Date(conn.last_sync_at).getTime() / 1000)
      : 0;
    const after = Math.min(lastSyncTs || thirtyDaysAgo, sevenDaysAgo);

    let page = 1;
    let imported = 0;
    let skipped = 0;
    let totalFetched = 0;
    const debug: Record<string, unknown> = { after, after_date: new Date(after * 1000).toISOString(), last_sync_at: conn.last_sync_at };

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

    while (page <= 5) {
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
      JSON.stringify({ imported, skipped, totalFetched, last_sync_at: new Date().toISOString(), debug }),
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
