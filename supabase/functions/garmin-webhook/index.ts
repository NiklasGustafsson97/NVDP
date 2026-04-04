import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  GARMIN_CLIENT_ID,
  supabaseAdmin,
  refreshGarminToken,
  garminActivityToWorkout,
  corsHeaders,
  GARMIN_API_BASE,
  type GarminActivity,
} from "../_shared/garmin.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders() });
  }

  // Garmin sends POST with activity data
  if (req.method === "POST") {
    try {
      const body = await req.json();

      // Garmin PUSH payload contains arrays of different data types.
      // We only care about activities.
      const activities: GarminActivity[] = body.activities || [];

      if (activities.length === 0) {
        return new Response("ok", { status: 200 });
      }

      const db = supabaseAdmin();

      for (const activity of activities) {
        // Garmin includes userId in webhook payloads
        const garminUserId = String(activity.userId || (body as Record<string, unknown>).userId || "");
        if (!garminUserId) {
          console.error("No Garmin userId in activity payload");
          continue;
        }

        // Find connection by Garmin user ID
        const { data: conn, error: connErr } = await db
          .from("garmin_connections")
          .select("*")
          .eq("garmin_user_id", garminUserId)
          .single();

        if (connErr || !conn) {
          console.error("No connection found for Garmin user:", garminUserId);
          continue;
        }

        // If the webhook payload contains full activity data (PUSH mode), use it directly.
        // Otherwise we need to fetch it (PING mode with callbackURL).
        let activityData: GarminActivity = activity;

        if (!activity.durationInSeconds && activity.callbackURL) {
          // PING mode: fetch activity data from callback URL
          const accessToken = await refreshGarminToken(conn);
          const actRes = await fetch(activity.callbackURL, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (!actRes.ok) {
            console.error("Failed to fetch Garmin activity from callback:", actRes.status);
            continue;
          }
          activityData = await actRes.json();
        }

        if (!activityData.durationInSeconds || activityData.durationInSeconds < 60) {
          continue; // Skip very short activities
        }

        const workout = garminActivityToWorkout(activityData, conn.profile_id);

        // Upsert: if garmin_activity_id already exists, update
        const { data: existing } = await db.from("workouts")
          .select("id")
          .eq("garmin_activity_id", String(activityData.activityId))
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
        } else {
          await db
            .from("garmin_connections")
            .update({ last_sync_at: new Date().toISOString() })
            .eq("id", conn.id);
        }
      }

      return new Response("ok", { status: 200 });
    } catch (err) {
      console.error("garmin-webhook error:", err);
      return new Response("error", { status: 200 }); // Return 200 to prevent retries
    }
  }

  return new Response("Method not allowed", { status: 405 });
});
