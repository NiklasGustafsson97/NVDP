import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Trigger deploy workflow after ES256 workaround (2026-04-18).
export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
export const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
export const STRAVA_CLIENT_ID = Deno.env.get("STRAVA_CLIENT_ID")!;
export const STRAVA_CLIENT_SECRET = Deno.env.get("STRAVA_CLIENT_SECRET")!;
// SECURITY (assessment M2): the webhook verify token was shipped with a
// hard-coded default ("nvdp_strava_verify"). Any attacker who read the
// source could pass it and successfully "subscribe" at our webhook, which
// would then attempt to trust spoofed activity events. We now REQUIRE
// STRAVA_VERIFY_TOKEN to be set; the handler must fail closed otherwise.
const _STRAVA_VERIFY_TOKEN_ENV = Deno.env.get("STRAVA_VERIFY_TOKEN") || "";
if (!_STRAVA_VERIFY_TOKEN_ENV) {
  console.error("_shared/strava.ts: STRAVA_VERIFY_TOKEN env var is not set");
}
export const STRAVA_VERIFY_TOKEN = _STRAVA_VERIFY_TOKEN_ENV;
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

// Activity types whose summary fields are sufficient -- we don't show
// splits, laps, perceived_exertion or HR-zone time-in-zone for these,
// so paying for the GET /activities/{id} detail call and the
// GET /activities/{id}/zones call is pure waste of Strava budget.
//
// We KEEP detail+zones for endurance activities (Löpning, Cykel,
// Längdskidor) where pace zones, splits, and HR-zone breakdowns
// drive the polarization / EF / VO2max charts.
const STRAVA_NO_DETAIL_TARGET_TYPES = new Set([
  "Gym",
  "Hyrox",
  "Stakmaskin",
  "Annat",
]);

export function needsStravaDetail(activity: StravaActivity): boolean {
  const targetType = mapStravaType(activity.sport_type || activity.type);
  return !STRAVA_NO_DETAIL_TARGET_TYPES.has(targetType);
}

export function guessIntensity(avgHr: number | null): string | null {
  if (!avgHr) return null;
  return avgHr < 145 ? "Z2" : "Kvalitet";
}

export interface StravaConnRow {
  id: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

// Internal: always hit Strava's /oauth/token endpoint regardless of how
// fresh expires_at looks. Used by both the lazy refresh path and the
// "force-refresh after 401" path.
async function _doRefresh(conn: StravaConnRow): Promise<{ access_token: string; status: number; ok: boolean; bodyText: string }> {
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
  const bodyText = await res.text();
  if (!res.ok) {
    return { access_token: "", status: res.status, ok: false, bodyText };
  }
  const data = JSON.parse(bodyText);
  const db = supabaseAdmin();
  await db.from("strava_connections").update({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at,
  }).eq("id", conn.id);
  // Mutate caller's view of the row so subsequent /athlete or activity
  // calls in the same invocation use the fresh token without another DB
  // round-trip.
  conn.access_token = data.access_token;
  conn.refresh_token = data.refresh_token;
  conn.expires_at = data.expires_at;
  return { access_token: data.access_token, status: res.status, ok: true, bodyText };
}

export async function refreshTokenIfNeeded(conn: StravaConnRow): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (conn.expires_at > now + 60) return conn.access_token;
  const out = await _doRefresh(conn);
  if (!out.ok) {
    // Strava returns 400 with {"errors":[{"resource":"RefreshToken","field":"refresh_token","code":"invalid"}]}
    // when the user has revoked the app from their Strava settings, OR
    // when an older refresh_token gets used after a successful rotation.
    // Either way the connection is dead — surface a structured error so
    // the caller can map it to a clear "reconnect Strava" UX instead of
    // a generic 500.
    const err = new Error(`Token refresh failed: ${out.status} ${out.bodyText.slice(0, 200)}`);
    (err as Error & { code?: string; stravaStatus?: number }).code =
      out.status === 400 || out.status === 401 ? "strava_auth_revoked" : "strava_token_refresh_failed";
    (err as Error & { code?: string; stravaStatus?: number }).stravaStatus = out.status;
    throw err;
  }
  return out.access_token;
}

// Force a token refresh even if expires_at still looks fresh. Use this
// when Strava starts returning 401 on requests despite our stored token
// claiming it's not yet expired — usually because Strava force-rotated
// the token (e.g. user changed password) or our `expires_at` was wrong.
// Returns the new token on success, or null if Strava refuses the
// refresh (i.e. the user has actually revoked the app).
export async function forceRefreshStravaToken(conn: StravaConnRow): Promise<string | null> {
  const out = await _doRefresh(conn);
  return out.ok ? out.access_token : null;
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
  has_heartrate?: boolean;
  perceived_exertion?: number;
  gear?: { name?: string };
  map?: { summary_polyline?: string };
  splits_metric?: Array<{
    distance: number;
    elapsed_time: number;
    moving_time: number;
    elevation_difference: number;
    average_speed: number;
    average_heartrate?: number;
    pace_zone: number;
    split: number;
  }>;
  laps?: Array<{
    id: number;
    name: string;
    elapsed_time: number;
    moving_time: number;
    distance: number;
    start_index: number;
    end_index: number;
    total_elevation_gain?: number;
    average_speed: number;
    max_speed?: number;
    average_heartrate?: number;
    max_heartrate?: number;
    average_cadence?: number;
    lap_index: number;
    split: number;
  }>;
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
  if (activity.splits_metric?.length) result.splits_data = JSON.stringify(activity.splits_metric);
  if (activity.perceived_exertion) result.perceived_exertion = activity.perceived_exertion;
  if (activity.laps?.length) result.laps_data = JSON.stringify(activity.laps);

  return result;
}

// Strava-aware fetch wrapper used by the deep sync. Surfaces 429s with the
// Retry-After hint instead of silently returning null, and never sleeps
// past the caller-supplied wall-clock budget so the edge function can
// always return *something* before Supabase's ~150s kill switch fires.
//
// Returns one of:
//   { res: Response }                 - request succeeded (res.ok may still be false for 4xx/5xx)
//   { rateLimited: true, retryAfterS } - Strava 429; caller should bail and let the chunk return early
//   { error: Error }                  - network error / fetch threw
export interface StravaFetchResult {
  res?: Response;
  rateLimited?: boolean;
  retryAfterS?: number;
  error?: Error;
}

// Pre-emptive rate-limit headroom: stop fetching at 80% of either the
// 15-min OR the daily Strava budget so we always leave 20% for
// interactive user actions and never hit the actual 429 wall.
//
// The 80% threshold is a published Strava-API best practice (see
// https://developers.strava.com/docs/rate-limits/) and matches what
// most clients do.
const STRAVA_PREEMPT_FRACTION = 0.8;

// Module-level cache of the most recent X-RateLimit-Usage / -Limit
// header pair. Lives for the duration of one Deno isolate (i.e. one
// Edge Function invocation, possibly reused for warm follow-ups). It's
// fine for this to reset on cold start -- the next response will
// repopulate it before we make a second call.
interface RateLimitWindow {
  usage: number;
  limit: number;
}
interface RateLimitState {
  fifteenMin: RateLimitWindow | null;
  daily: RateLimitWindow | null;
}
let _stravaRateLimitState: RateLimitState = { fifteenMin: null, daily: null };

function parseRateLimitHeader(value: string | null): [number, number] | null {
  // Strava header format: "<short_window>,<long_window>" e.g. "100,1000"
  // for limits and "7,150" for usage.
  if (!value) return null;
  const parts = value.split(",").map((s) => parseInt(s.trim(), 10));
  if (parts.length < 2 || parts.some((n) => Number.isNaN(n))) return null;
  return [parts[0], parts[1]];
}

function recordRateLimitFromResponse(res: Response): void {
  const limit = parseRateLimitHeader(res.headers.get("x-ratelimit-limit"));
  const usage = parseRateLimitHeader(res.headers.get("x-ratelimit-usage"));
  if (!limit || !usage) return;
  _stravaRateLimitState = {
    fifteenMin: { usage: usage[0], limit: limit[0] },
    daily: { usage: usage[1], limit: limit[1] },
  };
}

function secondsUntilNextQuarterHour(now = new Date()): number {
  const minutes = now.getUTCMinutes();
  const seconds = now.getUTCSeconds();
  const elapsedInWindow = (minutes % 15) * 60 + seconds;
  const remaining = 15 * 60 - elapsedInWindow;
  // Add a 5s safety margin so we don't hammer Strava the millisecond
  // the window flips.
  return Math.max(5, remaining + 5);
}

function preemptIfQuotaExhausted(): { retryAfterS: number; reason: string } | null {
  const s = _stravaRateLimitState;
  if (s.fifteenMin) {
    const ratio = s.fifteenMin.usage / s.fifteenMin.limit;
    if (ratio >= STRAVA_PREEMPT_FRACTION) {
      return {
        retryAfterS: secondsUntilNextQuarterHour(),
        reason: `15min usage ${s.fifteenMin.usage}/${s.fifteenMin.limit} (${Math.round(ratio * 100)}%)`,
      };
    }
  }
  if (s.daily) {
    const ratio = s.daily.usage / s.daily.limit;
    if (ratio >= STRAVA_PREEMPT_FRACTION) {
      // Daily window: don't try to be clever, just defer for 30 min and
      // let the next chunk re-evaluate. The daily window resets at
      // midnight UTC; if we're past 80% we should mostly stop until then.
      return {
        retryAfterS: 30 * 60,
        reason: `daily usage ${s.daily.usage}/${s.daily.limit} (${Math.round(ratio * 100)}%)`,
      };
    }
  }
  return null;
}

export async function fetchStravaWithRetry(
  url: string,
  accessToken: string,
  budgetMsLeft: number,
): Promise<StravaFetchResult> {
  // Pre-empt: if the LAST response told us we're past 80% of either
  // window, return a synthesized rate-limit instead of burning another
  // call. The caller (strava-sync) already handles `rateLimited` by
  // breaking the loop and surfacing retry_after_s to the client.
  const preempt = preemptIfQuotaExhausted();
  if (preempt) {
    console.warn(`fetchStravaWithRetry: pre-empting (${preempt.reason}), wait ${preempt.retryAfterS}s`);
    return { rateLimited: true, retryAfterS: preempt.retryAfterS };
  }

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    recordRateLimitFromResponse(res);
    if (res.status !== 429) return { res };

    // Honour Retry-After (seconds). Strava also sets X-RateLimit-Limit /
    // X-RateLimit-Usage headers, but Retry-After is the simplest signal.
    const retryAfterRaw = res.headers.get("retry-after");
    const retryAfterS = retryAfterRaw ? Math.max(1, parseInt(retryAfterRaw, 10) || 60) : 60;

    // If the rate-limit window is shorter than what's left of our budget
    // (and short enough to make a retry worthwhile) we can sleep+retry
    // once. Otherwise let the caller surface the rate-limit to the client
    // so the next chunk picks up after the cool-down.
    if (
      retryAfterS <= STRAVA_RATE_LIMIT_RETRY_MAX_S &&
      retryAfterS * 1000 + 5_000 < budgetMsLeft
    ) {
      await new Promise((r) => setTimeout(r, retryAfterS * 1000));
      const retry = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      recordRateLimitFromResponse(retry);
      if (retry.status !== 429) return { res: retry };
      const retryAfter2 = retry.headers.get("retry-after");
      return {
        rateLimited: true,
        retryAfterS: retryAfter2 ? Math.max(1, parseInt(retryAfter2, 10) || 60) : retryAfterS,
      };
    }

    return { rateLimited: true, retryAfterS };
  } catch (err) {
    return { error: err instanceof Error ? err : new Error(String(err)) };
  }
}

export const STRAVA_RATE_LIMIT_RETRY_MAX_S = 30;

export async function fetchHRZoneSeconds(
  activityId: number,
  accessToken: string,
  budgetMsLeft = 30_000,
): Promise<number[] | null> {
  const result = await fetchStravaWithRetry(
    `https://www.strava.com/api/v3/activities/${activityId}/zones`,
    accessToken,
    budgetMsLeft,
  );
  if (!result.res || !result.res.ok) return null;
  try {
    const zones = await result.res.json();
    const hrZone = zones.find((z: { type: string }) => z.type === "heartrate");
    if (!hrZone?.distribution_buckets) return null;
    const buckets: Array<{ min: number; max: number; time: number }> = hrZone.distribution_buckets;
    if (buckets.length < 5) return null;
    return buckets.slice(0, 5).map((b) => b.time);
  } catch {
    return null;
  }
}

// SECURITY (assessment M3): browser origins are restricted to an allowlist
// configured via the `APP_ORIGINS` env var (comma-separated), rather than
// `*` which would permit credentialed requests from any site. When the
// caller's origin is not in the allowlist we fall back to the first
// configured origin so CORS is denied.
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
