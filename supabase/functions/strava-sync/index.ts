import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  SUPABASE_URL,
  supabaseAdmin,
  refreshTokenIfNeeded,
  forceRefreshStravaToken,
  activityToWorkout,
  shouldImportActivity,
  needsStravaDetail,
  fetchHRZoneSeconds,
  fetchStravaWithRetry,
  corsHeaders,
  type StravaActivity,
} from "../_shared/strava.ts";

const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

// --- Sync tuning ---------------------------------------------------------
// Supabase Edge Functions are killed at ~150s wall-clock; we leave a fat
// margin so even a slow Strava day finishes a chunk before the kill.
const DEEP_SYNC_BUDGET_MS = 90_000;
// One page per chunk gives the client a fast, predictable progress
// signal. Strava caps per_page at 200; with 8-way parallelism the page
// processes in ~10-15s.
const DEEP_SYNC_PAGES_PER_CHUNK = 1;
const DEEP_SYNC_PER_PAGE = 200;
// Incremental syncs (no `since`) stay tight. With webhook-driven imports
// catching real-time activity creates, the incremental sync is only a
// catch-up safety net (e.g. webhook delivery dropped, app reconnected
// after offline). 1 page × 30 acts covers ~2-3 weeks for a typical
// power user and uses 1 list call instead of 5 — enough headroom to
// scale from 3 to 30 users without touching the 100/15-min budget.
const INCREMENTAL_PAGES = 1;
const INCREMENTAL_PER_PAGE = 30;
// Concurrency for the detail + zones fetches inside a page. Strava's
// rate limit is 100 req/15min, so 8-in-flight averages well below that
// while still cutting per-page wall-clock ~8x.
const PARALLEL_DETAIL_FETCHES = 8;

function runChunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

interface DetailFetchOutcome {
  workout?: Record<string, unknown>;
  rateLimited?: boolean;
  retryAfterS?: number;
  error?: string;
}

async function buildWorkoutForActivity(
  summary: StravaActivity,
  accessToken: string,
  profileId: string,
  budgetMsLeft: () => number,
): Promise<DetailFetchOutcome> {
  // For Gym/Hyrox/Stakmaskin/Annat the summary already has every field
  // we render (duration, calories, avg HR). Splits, laps, and HR-zone
  // breakdowns are only consumed by the endurance charts (pace zones,
  // EF, polarization). Skipping detail+zones for these saves 2 of the
  // 3 Strava calls per imported activity -- a 67% cut on every gym
  // session, every hyrox workout, every elliptical, every swim.
  const wantsDetail = needsStravaDetail(summary);

  let activity: StravaActivity = summary;
  if (wantsDetail) {
    const detail = await fetchStravaWithRetry(
      `https://www.strava.com/api/v3/activities/${summary.id}`,
      accessToken,
      budgetMsLeft(),
    );
    if (detail.rateLimited) {
      return { rateLimited: true, retryAfterS: detail.retryAfterS };
    }
    if (detail.res?.ok) {
      try {
        activity = await detail.res.json();
      } catch {
        // fall back to summary
      }
    }
  }

  const workout = activityToWorkout(activity, profileId);

  // Zones fetch (only if HR data exists AND the type uses HR zones).
  if (wantsDetail && (activity.has_heartrate || activity.average_heartrate)) {
    const zones = await fetchHRZoneSeconds(activity.id, accessToken, budgetMsLeft());
    if (zones) workout.hr_zone_seconds = JSON.stringify(zones);
  }

  return { workout };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(req) });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const startedAt = Date.now();
  const budgetMsLeft = () => Math.max(0, DEEP_SYNC_BUDGET_MS - (Date.now() - startedAt));

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "No auth header" }), {
        status: 401,
        headers: { ...corsHeaders(req), "Content-Type": "application/json" },
      });
    }

    // Service-role bypass: strava-sync-daily (and any other server-side
    // caller) authenticates with the service-role key and passes the
    // target user's profile_id in the body. We MUST gate this on an
    // exact-match of the service-role key -- never trust a body-provided
    // profile_id from a regular user JWT (that would be a tenancy break,
    // see the user-JWT branch below for the assertion).
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const isServiceRole =
      !!SERVICE_KEY && authHeader === `Bearer ${SERVICE_KEY}`;

    let profile_id: string;
    let since: string | null = null;
    const body = await req.json().catch(() => ({}));
    since = body?.since ?? null;

    if (isServiceRole) {
      const bodyProfileId = body?.profile_id;
      if (!bodyProfileId || typeof bodyProfileId !== "string") {
        return new Response(
          JSON.stringify({ error: "service_role_call_requires_profile_id" }),
          { status: 400, headers: { ...corsHeaders(req), "Content-Type": "application/json" } }
        );
      }
      profile_id = bodyProfileId;
    } else {
      const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user }, error: userErr } = await userClient.auth.getUser();
      if (userErr || !user) {
        return new Response(JSON.stringify({ error: "Invalid token" }), {
          status: 401,
          headers: { ...corsHeaders(req), "Content-Type": "application/json" },
        });
      }

      const dbForProfile = supabaseAdmin();

      // Derive profile_id from the authenticated user (never from the body).
      // This prevents a legit user from passing someone else's profile_id and
      // reading/writing into another account via the service-role client below.
      const { data: callerProfile, error: profErr } = await dbForProfile
        .from("profiles")
        .select("id")
        .eq("user_id", user.id)
        .maybeSingle();
      if (profErr || !callerProfile) {
        console.error("strava-sync: profile lookup failed", profErr);
        return new Response(JSON.stringify({ error: "profile_not_found" }), {
          status: 404,
          headers: { ...corsHeaders(req), "Content-Type": "application/json" },
        });
      }
      profile_id = callerProfile.id;
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
        { status: 404, headers: { ...corsHeaders(req), "Content-Type": "application/json" } }
      );
    }

    let accessToken: string;
    try {
      accessToken = await refreshTokenIfNeeded(conn);
    } catch (e) {
      const errCode = (e as Error & { code?: string }).code;
      if (errCode === "strava_auth_revoked") {
        // The stored refresh_token no longer works — user revoked the app
        // or Strava rotated the token without us catching it. Fail fast
        // with 401 so the UI can prompt re-auth.
        return new Response(
          JSON.stringify({ error: "strava_auth_revoked" }),
          { status: 401, headers: { ...corsHeaders(req), "Content-Type": "application/json" } }
        );
      }
      throw e;
    }

    // --- Mode + cursor ------------------------------------------------
    // Deep sync: client passes a `since` calendar date (e.g. 2025-01-01).
    //   - We store an "active deep sync" cursor on the connection row so
    //     the work can be split across many short edge-fn invocations.
    //   - `deep_sync_floor` is the original since timestamp.
    //   - `deep_sync_anchor` is the oldest activity start_ts already
    //     processed; it walks BACKWARDS in time as we paginate.
    // Incremental sync (no `since`): legacy fast path, 5×50 forward
    // pagination, no cursor.
    const isDeep = !!since;
    const nowSec = Math.floor(Date.now() / 1000);
    const fourteenDaysAgo = nowSec - 14 * 24 * 3600;

    let deepFloor: number | null = conn.deep_sync_floor ?? null;
    let deepAnchor: number | null = conn.deep_sync_anchor ?? null;

    if (isDeep) {
      const sinceTs = Math.floor(new Date(since).getTime() / 1000);
      // Reset cursor when the client asks for a different floor than the
      // one we're currently draining. This lets the user "restart" a deep
      // sync just by pressing Synka allt with a different date.
      if (deepFloor === null || deepFloor !== sinceTs) {
        deepFloor = sinceTs;
        deepAnchor = null;
        await db
          .from("strava_connections")
          .update({ deep_sync_floor: deepFloor, deep_sync_anchor: null })
          .eq("id", conn.id);
      }
    }

    // For the incremental path we keep the original behaviour: last_sync_at
    // capped at 14 days ago, falling back to 60 days for a brand-new
    // connection.
    let incrementalAfter = 0;
    if (!isDeep) {
      const sixtyDaysAgo = nowSec - 60 * 24 * 3600;
      const lastSyncTs = conn.last_sync_at
        ? Math.floor(new Date(conn.last_sync_at).getTime() / 1000)
        : 0;
      incrementalAfter = Math.min(lastSyncTs || sixtyDaysAgo, fourteenDaysAgo);
    }

    // We used to do a defensive `GET /athlete` here to verify the token.
    // It was pure overhead: the very next request (the activities list)
    // would catch the same 401 / rate-limit anyway, and the extra call
    // chewed through ~1/100 of Strava's 15-minute application budget on
    // every chunk of a deep sync. The activities loop below now handles
    // 401 (force-refresh + retry, then strava_auth_revoked if it still
    // fails) and 429 (propagated as rate_limited with retry_after_s) on
    // its own, so the health check is gone.

    // --- Page loop ----------------------------------------------------
    let page = 1;
    let imported = 0;
    let skipped = 0;
    let skippedShort = 0;
    let skippedType = 0;
    let skippedError = 0;
    let totalFetched = 0;
    let firstError: string | null = null;
    let rateLimited = false;
    let retryAfterS: number | undefined;
    let pagesProcessed = 0;
    let oldestProcessedTs: number | null = null; // smallest start_ts upserted in this invocation
    let chunkExhausted = false; // Strava returned a short page → done
    const activityLog: Array<Record<string, unknown>> = [];
    const debug: Record<string, unknown> = {
      mode: isDeep ? "deep" : "incremental",
      deep_floor: deepFloor,
      deep_anchor_in: deepAnchor,
      incremental_after: incrementalAfter,
      activity_log: activityLog,
    };

    const maxPages = isDeep ? DEEP_SYNC_PAGES_PER_CHUNK : INCREMENTAL_PAGES;
    const perPage = isDeep ? DEEP_SYNC_PER_PAGE : INCREMENTAL_PER_PAGE;

    while (page <= maxPages) {
      // Bail out before fetching another page if we're tight on budget.
      if (budgetMsLeft() < 15_000) {
        debug.budget_exhausted_before_page = page;
        break;
      }

      let listUrl: string;
      if (isDeep) {
        // Walk backwards in time using `before` cursor.
        const before = deepAnchor ?? nowSec;
        listUrl =
          `https://www.strava.com/api/v3/athlete/activities` +
          `?before=${before}&after=${deepFloor}&per_page=${perPage}&page=${page}`;
      } else {
        listUrl =
          `https://www.strava.com/api/v3/athlete/activities` +
          `?after=${incrementalAfter}&per_page=${perPage}&page=${page}`;
      }

      let listResult = await fetchStravaWithRetry(listUrl, accessToken, budgetMsLeft());

      // 401 → token went stale server-side (force-rotated by Strava, app
      // revoked, password change). Try a force-refresh once and retry the
      // same page. If the refresh itself fails or the retry still 401s,
      // surface strava_auth_revoked so the UI can prompt re-auth.
      if (listResult.res?.status === 401) {
        console.warn("strava-sync: /activities returned 401 on page", page, "— force-refreshing token");
        const fresh = await forceRefreshStravaToken(conn);
        if (!fresh) {
          return new Response(
            JSON.stringify({ error: "strava_auth_revoked" }),
            { status: 401, headers: { ...corsHeaders(req), "Content-Type": "application/json" } }
          );
        }
        accessToken = fresh;
        listResult = await fetchStravaWithRetry(listUrl, accessToken, budgetMsLeft());
        if (listResult.res?.status === 401) {
          return new Response(
            JSON.stringify({ error: "strava_auth_revoked" }),
            { status: 401, headers: { ...corsHeaders(req), "Content-Type": "application/json" } }
          );
        }
      }

      if (listResult.rateLimited) {
        rateLimited = true;
        retryAfterS = listResult.retryAfterS;
        debug.activities_rate_limited = { page, retry_after_s: retryAfterS };
        break;
      }
      if (!listResult.res || !listResult.res.ok) {
        const status = listResult.res?.status ?? 0;
        const errBody = listResult.res ? await listResult.res.text() : (listResult.error?.message ?? "");
        console.error("strava-sync: activities endpoint error", status, errBody.slice(0, 500));
        debug.activities_error = { page, status };
        // For 4xx other than 401 (we handled that above), don't break
        // silently — surface the upstream status to the client so it can
        // show a useful message instead of "0 importerade".
        if (status >= 400 && status < 500) {
          return new Response(
            JSON.stringify({
              error: "strava_api_error",
              strava_status: status,
              strava_message: errBody.slice(0, 200),
            }),
            { status: 502, headers: { ...corsHeaders(req), "Content-Type": "application/json" } }
          );
        }
        break;
      }

      const activities: StravaActivity[] = await listResult.res.json();
      totalFetched += activities.length;
      if (activities.length === 0) {
        chunkExhausted = true;
        break;
      }

      // --- Filter -----------------------------------------------------
      const toProcess: StravaActivity[] = [];
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
        toProcess.push(summaryActivity);
      }

      // --- Parallel detail + zones, in batches of N -------------------
      const workouts: Record<string, unknown>[] = [];
      const processedSummaries: StravaActivity[] = [];
      let pageRateLimited = false;

      outer:
      for (const batch of runChunks(toProcess, PARALLEL_DETAIL_FETCHES)) {
        if (budgetMsLeft() < 10_000) {
          debug.budget_exhausted_in_batch = { page, remaining: toProcess.length - processedSummaries.length };
          break;
        }
        const outcomes = await Promise.all(
          batch.map((summary) =>
            buildWorkoutForActivity(summary, accessToken, profile_id, budgetMsLeft),
          ),
        );
        for (let i = 0; i < outcomes.length; i++) {
          const outcome = outcomes[i];
          const summary = batch[i];
          if (outcome.rateLimited) {
            rateLimited = true;
            retryAfterS = outcome.retryAfterS;
            pageRateLimited = true;
            debug.detail_rate_limited = { page, retry_after_s: retryAfterS };
            break outer;
          }
          if (outcome.workout) {
            workouts.push(outcome.workout);
            processedSummaries.push(summary);
          } else if (outcome.error) {
            if (!firstError) firstError = outcome.error;
            const sportType = summary.sport_type || summary.type;
            activityLog.push({
              id: summary.id, name: summary.name, type: sportType,
              start: summary.start_date_local,
              moving_min: Math.round((summary.moving_time || 0) / 60),
              action: "error",
            });
            skippedError++;
            skipped++;
          }
        }
      }

      // --- Bulk upsert (single round-trip per page) -------------------
      if (workouts.length > 0) {
        const { error: upsertErr } = await db.from("workouts").upsert(workouts, {
          onConflict: "strava_activity_id",
          ignoreDuplicates: false,
        });
        if (upsertErr) {
          console.error("strava-sync: bulk upsert error", upsertErr);
          if (!firstError) firstError = "workout_upsert_failed";
          for (const summary of processedSummaries) {
            const sportType = summary.sport_type || summary.type;
            activityLog.push({
              id: summary.id, name: summary.name, type: sportType,
              start: summary.start_date_local,
              moving_min: Math.round((summary.moving_time || 0) / 60),
              action: "error",
            });
            skippedError++;
            skipped++;
          }
        } else {
          for (const summary of processedSummaries) {
            const sportType = summary.sport_type || summary.type;
            const tsSec = Math.floor(new Date(summary.start_date_local).getTime() / 1000);
            if (oldestProcessedTs === null || tsSec < oldestProcessedTs) {
              oldestProcessedTs = tsSec;
            }
            activityLog.push({
              id: summary.id, name: summary.name, type: sportType,
              start: summary.start_date_local,
              moving_min: Math.round((summary.moving_time || 0) / 60),
              action: "imported",
            });
            imported++;
          }
        }
      }

      // Even skipped activities (short / wrong type) should advance the
      // cursor, so the deep sync doesn't loop on the same page forever.
      // Use the oldest start_ts in the *whole page* for the cursor.
      if (isDeep && activities.length > 0) {
        for (const summaryActivity of activities) {
          const tsSec = Math.floor(new Date(summaryActivity.start_date_local).getTime() / 1000);
          if (oldestProcessedTs === null || tsSec < oldestProcessedTs) {
            oldestProcessedTs = tsSec;
          }
        }
      }

      pagesProcessed++;

      if (pageRateLimited) break;

      // Strava returns < perPage when we've exhausted the window.
      if (activities.length < perPage) {
        chunkExhausted = true;
        break;
      }
      page++;
    }

    // --- Persist cursor + decide done ---------------------------------
    let done = false;
    let progressPct = 0;
    let newSyncAt: string | null = null;

    if (isDeep) {
      // Advance the persistent anchor backwards in time.
      const newAnchor = oldestProcessedTs ?? deepAnchor;
      const reachedFloor = newAnchor !== null && deepFloor !== null && newAnchor <= deepFloor;
      const isDone = reachedFloor || chunkExhausted;

      if (isDone) {
        // Wipe the cursor and bump last_sync_at — deep sync complete.
        newSyncAt = new Date().toISOString();
        await db
          .from("strava_connections")
          .update({
            deep_sync_floor: null,
            deep_sync_anchor: null,
            last_sync_at: newSyncAt,
          })
          .eq("id", conn.id);
        done = true;
        progressPct = 100;
      } else {
        await db
          .from("strava_connections")
          .update({ deep_sync_anchor: newAnchor })
          .eq("id", conn.id);
        // Progress = how far the anchor has walked from now() back toward floor.
        if (deepFloor !== null && newAnchor !== null) {
          const span = Math.max(1, nowSec - deepFloor);
          const walked = Math.max(0, nowSec - newAnchor);
          progressPct = Math.min(99, Math.round((walked / span) * 100));
        }
      }

      debug.deep_anchor_out = newAnchor;
      debug.deep_done = done;
      debug.pages_processed = pagesProcessed;
      debug.chunk_exhausted = chunkExhausted;
    } else {
      // Incremental path: bump last_sync_at iff Strava actually answered
      // us with at least one successful list page (even an empty one),
      // OR Strava confirmed there were no more activities (chunkExhausted).
      //
      // The OLD rule was `if (totalFetched > 0)` -- which silently broke
      // every user who happened to have no new Strava activities since
      // the last sync. Their `last_sync_at` never advanced, so the
      // browser's autoSyncStravaIfStale (1h threshold) re-polled Strava
      // on EVERY app load forever. With 30 users and ~3 app loads each
      // per day, that's ~90 wasted polls/day burning through the
      // 100-per-15-min Strava budget for nothing.
      //
      // New rule: if we got an authoritative answer from Strava (data
      // OR a clean empty page), the connection is up to date. Only when
      // we never made it past a rate-limit or hard error do we leave
      // last_sync_at alone so the next attempt retries.
      const heardFromStrava = pagesProcessed > 0 || chunkExhausted;
      if (heardFromStrava) {
        newSyncAt = new Date().toISOString();
        await db
          .from("strava_connections")
          .update({ last_sync_at: newSyncAt })
          .eq("id", conn.id);
      }
      if (rateLimited && !heardFromStrava) {
        done = false;
        progressPct = 0;
      } else {
        done = true;
        progressPct = 100;
      }
    }

    // --- Derive user_max_hr (unchanged) -------------------------------
    try {
      const sinceIso = new Date(Date.now() - 180 * 24 * 3600 * 1000).toISOString();
      const { data: hrRows } = await db
        .from("workouts")
        .select("max_hr")
        .eq("profile_id", profile_id)
        .gte("start_time", sinceIso)
        .not("max_hr", "is", null)
        .order("max_hr", { ascending: false })
        .limit(1);

      const observedMax = hrRows && hrRows[0]?.max_hr ? Number(hrRows[0].max_hr) : null;
      if (observedMax && observedMax >= 120 && observedMax <= 230) {
        const { data: prof } = await db
          .from("profiles")
          .select("user_max_hr")
          .eq("id", profile_id)
          .maybeSingle();
        const currentMax = prof?.user_max_hr ? Number(prof.user_max_hr) : 0;
        if (observedMax > currentMax) {
          await db
            .from("profiles")
            .update({ user_max_hr: observedMax })
            .eq("id", profile_id);
          debug.user_max_hr_updated = { from: currentMax || null, to: observedMax };
        }
      }
    } catch (e) {
      console.error("strava-sync: max HR derivation failed", e);
    }

    if (firstError) debug.firstError = firstError;
    debug.elapsed_ms = Date.now() - startedAt;

    return new Response(
      JSON.stringify({
        done,
        progress_pct: progressPct,
        rate_limited: rateLimited || undefined,
        retry_after_s: retryAfterS,
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
        headers: { ...corsHeaders(req), "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    console.error("strava-sync error:", err);
    return new Response(
      JSON.stringify({ error: "Internal error" }),
      { status: 500, headers: { ...corsHeaders(req), "Content-Type": "application/json" } }
    );
  }
});
