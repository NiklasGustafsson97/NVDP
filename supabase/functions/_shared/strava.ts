import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
export const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
export const STRAVA_CLIENT_ID = Deno.env.get("STRAVA_CLIENT_ID")!;
export const STRAVA_CLIENT_SECRET = Deno.env.get("STRAVA_CLIENT_SECRET")!;
export const STRAVA_VERIFY_TOKEN = Deno.env.get("STRAVA_VERIFY_TOKEN") || "nvdp_strava_verify";
export const APP_URL = Deno.env.get("APP_URL") || "https://niklasgustafsson97.github.io/NVDP/";

export function supabaseAdmin() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
}

export const STRAVA_TYPE_MAP: Record<string, string> = {
  Run: "Löpning",
  TrailRun: "Löpning",
  VirtualRun: "Löpning",
  Ride: "Cykel",
  VirtualRide: "Cykel",
  GravelRide: "Cykel",
  MountainBikeRide: "Cykel",
  EBikeRide: "Cykel",
  WeightTraining: "Gym",
  Crossfit: "Gym",
  Hyrox: "Hyrox",
  NordicSki: "Längdskidor",
  BackcountrySki: "Längdskidor",
  RollerSki: "Längdskidor",
  Elliptical: "Stakmaskin",
  StairStepper: "Stakmaskin",
  Swim: "Annat",
  Rowing: "Annat",
};

// Activities that should NOT be imported (not training)
const STRAVA_SKIP_TYPES = new Set([
  "Walk",
  "Hike",
  "Yoga",
  "Meditation",
  "Canoeing",
  "Kayaking",
  "Sail",
  "Surfing",
  "Windsurf",
  "Kitesurf",
  "Golf",
  "Skateboard",
  "Snowboard",
  "AlpineSki",
  "IceSkate",
  "InlineSkate",
  "Velomobile",
  "Handcycle",
  "Wheelchair",
  "Snowshoe",
  "Soccer",
  "Tennis",
  "Badminton",
  "Pickleball",
  "Racquetball",
  "Squash",
  "TableTennis",
  "VirtualRow",
]);

export function shouldImportActivity(activity: StravaActivity): boolean {
  const sportType = activity.sport_type || activity.type;
  if (STRAVA_SKIP_TYPES.has(sportType)) return false;
  // Skip very short activities (<5 min) as they're likely accidental
  if (activity.moving_time < 300) return false;
  return true;
}

export function mapStravaType(stravaType: string): string {
  return STRAVA_TYPE_MAP[stravaType] || "Annat";
}

export function guessIntensity(avgHr: number | null): string | null {
  if (!avgHr) return null;
  return avgHr < 145 ? "Z2" : "Kvalitet";
}

export async function refreshTokenIfNeeded(
  conn: { id: string; access_token: string; refresh_token: string; expires_at: number }
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (conn.expires_at > now + 60) return conn.access_token;

  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: STRAVA_CLIENT_ID,
      client_secret: STRAVA_CLIENT_SECRET,
      refresh_token: conn.refresh_token,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);
  const data = await res.json();

  const db = supabaseAdmin();
  await db.from("strava_connections").update({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at,
  }).eq("id", conn.id);

  return data.access_token;
}

export interface StravaActivity {
  id: number;
  type: string;
  sport_type?: string;
  name: string;
  start_date_local: string;
  moving_time: number;
  elapsed_time?: number;
  distance: number;
  total_elevation_gain?: number;
  average_speed?: number;
  max_speed?: number;
  average_heartrate?: number;
  max_heartrate?: number;
  suffer_score?: number;
  calories?: number;
  average_cadence?: number;
  gear?: { name?: string };
  map?: { summary_polyline?: string };
}

export function activityToWorkout(
  activity: StravaActivity,
  profileId: string
): Record<string, unknown> {
  const dateStr = activity.start_date_local.slice(0, 10);
  const timeStr = activity.start_date_local.slice(11, 16);
  const type = mapStravaType(activity.sport_type || activity.type);
  const durationMin = Math.round(activity.moving_time / 60);
  const distKm = activity.distance > 0 ? +(activity.distance / 1000).toFixed(2) : null;
  const intensity = guessIntensity(activity.average_heartrate || null);

  const result: Record<string, unknown> = {
    profile_id: profileId,
    workout_date: dateStr,
    workout_time: timeStr || null,
    activity_type: type,
    duration_minutes: durationMin,
    distance_km: distKm,
    intensity,
    notes: `[Strava] ${activity.name}`,
    source: "strava",
    strava_activity_id: activity.id,
  };

  if (activity.elapsed_time) result.elapsed_time_minutes = Math.round(activity.elapsed_time / 60);
  if (activity.total_elevation_gain) result.elevation_gain_m = +activity.total_elevation_gain.toFixed(1);
  if (activity.average_speed) result.avg_speed_kmh = +(activity.average_speed * 3.6).toFixed(2);
  if (activity.max_speed) result.max_speed_kmh = +(activity.max_speed * 3.6).toFixed(2);
  if (activity.average_heartrate) result.avg_hr = Math.round(activity.average_heartrate);
  if (activity.max_heartrate) result.max_hr = Math.round(activity.max_heartrate);
  if (activity.calories) result.calories = Math.round(activity.calories);
  if (activity.average_cadence) result.avg_cadence = +activity.average_cadence.toFixed(1);
  if (activity.map?.summary_polyline) result.map_polyline = activity.map.summary_polyline;

  return result;
}

export function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
}
