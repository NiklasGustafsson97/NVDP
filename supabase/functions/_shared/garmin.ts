import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
export const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
export const GARMIN_CLIENT_ID = Deno.env.get("GARMIN_CLIENT_ID")!;
export const GARMIN_CLIENT_SECRET = Deno.env.get("GARMIN_CLIENT_SECRET")!;
export const APP_URL = Deno.env.get("APP_URL") || "https://niklasgustafsson97.github.io/NVDP/";

const GARMIN_TOKEN_URL = "https://connectapi.garmin.com/oauth-service/oauth/token";
const GARMIN_API_BASE = "https://apis.garmin.com/wellness-api/rest";

export function supabaseAdmin() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
}

export const GARMIN_TYPE_MAP: Record<string, string> = {
  RUNNING: "Löpning",
  TRAIL_RUNNING: "Löpning",
  TREADMILL_RUNNING: "Löpning",
  CYCLING: "Cykel",
  INDOOR_CYCLING: "Cykel",
  MOUNTAIN_BIKING: "Cykel",
  GRAVEL_CYCLING: "Cykel",
  STRENGTH_TRAINING: "Gym",
  CARDIO_TRAINING: "Gym",
  FITNESS_EQUIPMENT: "Gym",
  CROSS_COUNTRY_SKIING: "Längdskidor",
  SKATE_SKIING: "Längdskidor",
  ELLIPTICAL: "Stakmaskin",
  STAIR_CLIMBING: "Stakmaskin",
};

export function mapGarminType(garminType: string): string {
  return GARMIN_TYPE_MAP[garminType] || "Annat";
}

export function guessIntensity(avgHr: number | null): string | null {
  if (!avgHr) return null;
  return avgHr < 145 ? "Z2" : "Kvalitet";
}

export async function refreshGarminToken(
  conn: { id: string; access_token: string; refresh_token: string; expires_at: number }
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (conn.expires_at > now + 60) return conn.access_token;

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: conn.refresh_token,
    client_id: GARMIN_CLIENT_ID,
    client_secret: GARMIN_CLIENT_SECRET,
  });

  const res = await fetch(GARMIN_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) throw new Error(`Garmin token refresh failed: ${res.status}`);
  const data = await res.json();

  const db = supabaseAdmin();
  await db.from("garmin_connections").update({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
  }).eq("id", conn.id);

  return data.access_token;
}

export interface GarminActivity {
  activityId: number;
  activityType: string;
  activityName: string;
  startTimeInSeconds: number;
  startTimeOffsetInSeconds: number;
  durationInSeconds: number;
  distanceInMeters: number;
  averageHeartRateInBeatsPerMinute?: number;
}

export function garminActivityToWorkout(
  activity: GarminActivity,
  profileId: string
): Record<string, unknown> {
  const startMs = (activity.startTimeInSeconds + (activity.startTimeOffsetInSeconds || 0)) * 1000;
  const d = new Date(startMs);
  const dateStr = d.toISOString().slice(0, 10);
  const timeStr = d.toISOString().slice(11, 16);
  const type = mapGarminType(activity.activityType);
  const durationMin = Math.round(activity.durationInSeconds / 60);
  const distKm = activity.distanceInMeters > 0
    ? +(activity.distanceInMeters / 1000).toFixed(2)
    : null;
  const intensity = guessIntensity(activity.averageHeartRateInBeatsPerMinute || null);

  return {
    profile_id: profileId,
    workout_date: dateStr,
    workout_time: timeStr || null,
    activity_type: type,
    duration_minutes: durationMin,
    distance_km: distKm,
    intensity,
    notes: `[Garmin] ${activity.activityName || activity.activityType}`,
    source: "garmin",
    garmin_activity_id: String(activity.activityId),
  };
}

// SECURITY (assessment M3): see strava.ts — origin is restricted to
// `APP_ORIGINS`. `*` would allow credentialed cross-origin access.
const APP_ORIGINS = (Deno.env.get("APP_ORIGINS") ||
  "https://niklasgustafsson97.github.io").split(",").map((o) => o.trim()).filter(Boolean);

export function corsHeaders(req?: Request): Record<string, string> {
  const origin = req?.headers.get("origin") || "";
  const allow = APP_ORIGINS.includes(origin) ? origin : APP_ORIGINS[0] || "null";
  return {
    "Access-Control-Allow-Origin": allow,
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
  };
}

export { GARMIN_TOKEN_URL, GARMIN_API_BASE };
