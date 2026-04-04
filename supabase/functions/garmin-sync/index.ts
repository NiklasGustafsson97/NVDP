import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  SUPABASE_URL,
  supabaseAdmin,
  refreshGarminToken,
  garminActivityToWorkout,
  corsHeaders,
  GARMIN_API_BASE,
  type GarminActivity,
} from "../_shared/garmin.ts";

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
      .from("garmin_connections")
      .select("*")
      .eq("profile_id", profile_id)
      .single();

    if (connErr || !conn) {
      return new Response(
        JSON.stringify({ error: "No Garmin connection found" }),
        { status: 404, headers: { ...corsHeaders(), "Content-Type": "application/json" } }
      );
    }

    const accessToken = await refreshGarminToken(conn);

    // Look back at least 7 days; max 30 days
    const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
    const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 24 * 3600;
    const lastSyncTs = conn.last_sync_at
      ? Math.floor(new Date(conn.last_sync_at).getTime() / 1000)
      : 0;
    const after = Math.min(lastSyncTs || thirtyDaysAgo, sevenDaysAgo);
    const now = Math.floor(Date.now() / 1000);

    let imported = 0;
    let skipped = 0;
    let totalFetched = 0;
    let firstError: string | null = null;
    const debug: Record<string, unknown> = {
      after,
      after_date: new Date(after * 1000).toISOString(),
      last_sync_at: conn.last_sync_at,
    };

    // Garmin activities endpoint uses epoch seconds for start/end range
    const activitiesUrl =
      `${GARMIN_API_BASE}/activities?uploadStartTimeInSeconds=${after}&uploadEndTimeInSeconds=${now}`;

    const activitiesRes = await fetch(activitiesUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!activitiesRes.ok) {
      const errBody = await activitiesRes.text();
      return new Response(
        JSON.stringify({ error: "Garmin API error", status: activitiesRes.status, detail: errBody }),
        { status: 502, headers: { ...corsHeaders(), "Content-Type": "application/json" } }
      );
    }

    const activities: GarminActivity[] = await activitiesRes.json();
    totalFetched = activities.length;

    for (const activity of activities) {
      if (!activity.durationInSeconds || activity.durationInSeconds < 60) {
        skipped++;
        continue;
      }

      const workout = garminActivityToWorkout(activity, conn.profile_id);

      const { data: existing } = await db.from("workouts")
        .select("id")
        .eq("garmin_activity_id", String(activity.activityId))
        .maybeSingle();

      let insertErr;
      if (existing) {
        const { error } = await db.from("workouts").update(workout).eq("id", existing.id);
        insertErr = error;
      } else {
        const { error } = await db.from("workouts").insert(workout);
        insertErr = error;
      }

      if (insertErr) {
        console.error("Workout insert error:", insertErr);
        if (!firstError) firstError = JSON.stringify(insertErr);
        skipped++;
      } else {
        imported++;
      }
    }

    // Update last_sync_at
    await db
      .from("garmin_connections")
      .update({ last_sync_at: new Date().toISOString() })
      .eq("id", conn.id);

    if (firstError) debug.firstError = firstError;
    return new Response(
      JSON.stringify({ imported, skipped, totalFetched, last_sync_at: new Date().toISOString(), debug }),
      {
        status: 200,
        headers: { ...corsHeaders(), "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    console.error("garmin-sync error:", err);
    return new Response(
      JSON.stringify({ error: "Internal error" }),
      { status: 500, headers: { ...corsHeaders(), "Content-Type": "application/json" } }
    );
  }
});
