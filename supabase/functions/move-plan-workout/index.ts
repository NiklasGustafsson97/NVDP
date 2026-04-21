// Move (or reorder) a single plan_workouts row.
//
// POST { plan_workout_id, to_day_of_week, to_sort_order? }
// Auth: user bearer token. Verifies the row belongs to the caller via
//   plan_workouts -> plan_weeks -> training_plans.profile_id
//
// Behavior:
//   - Updates the row's day_of_week, sort_order and recomputes workout_date
//     from training_plans.start_date + (week_number - 1) * 7 + day_of_week.
//   - Renumbers sort_order on both the source day (after removal) and the
//     destination day (after insertion) so values stay contiguous (0..N).
//   - If to_sort_order is omitted the row is appended to the end of the
//     destination day.
//   - If from and to are the same day, this becomes a pure reorder.
//
// Verify JWT must be OFF on this function (we do auth inline). We do this so
// the gateway does not reject ES256 user tokens on legacy runtimes.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

interface PlanWorkout {
  id: string;
  plan_week_id: string;
  day_of_week: number;
  sort_order: number;
  workout_date: string;
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const APP_ORIGINS = (Deno.env.get("APP_ORIGINS") ||
  "https://niklasgustafsson97.github.io").split(",").map((o) => o.trim()).filter(Boolean);

function corsHeaders(req?: Request) {
  const origin = req?.headers.get("origin") || "";
  const allow = APP_ORIGINS.includes(origin) ? origin : APP_ORIGINS[0] || "null";
  return {
    "Access-Control-Allow-Origin": allow,
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function json(status: number, body: unknown, req?: Request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" }, req);

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) return json(401, { error: "No auth header" }, req);

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return json(401, { error: "Invalid token" }, req);

    const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const { data: profile } = await db.from("profiles")
      .select("id")
      .eq("user_id", user.id)
      .single();
    if (!profile) return json(404, { error: "Profile not found" }, req);
    const profileId: string = profile.id;

    const body = await req.json().catch(() => ({}));
    const planWorkoutId = body?.plan_workout_id;
    const toDow = Number(body?.to_day_of_week);
    const toSortOrderRaw = body?.to_sort_order;
    const toSortOrder = toSortOrderRaw === undefined || toSortOrderRaw === null
      ? null
      : Number(toSortOrderRaw);

    if (!planWorkoutId || !Number.isInteger(toDow)) {
      return json(400, { error: "Missing plan_workout_id or to_day_of_week" }, req);
    }
    if (toDow < 0 || toDow > 6) {
      return json(400, { error: "to_day_of_week must be 0-6" }, req);
    }

    // 1. Load the row being moved + verify ownership via plan_week → training_plan.
    const { data: row, error: rowErr } = await db.from("plan_workouts")
      .select("id, plan_week_id, day_of_week, sort_order, workout_date")
      .eq("id", planWorkoutId)
      .single();
    if (rowErr || !row) return json(404, { error: "plan_workout not found" }, req);

    const { data: planWeek, error: pwErr } = await db.from("plan_weeks")
      .select("id, plan_id, week_number, training_plans!inner(profile_id, start_date)")
      .eq("id", (row as PlanWorkout).plan_week_id)
      .single();
    if (pwErr || !planWeek) return json(404, { error: "plan_week not found" }, req);
    // deno-lint-ignore no-explicit-any
    const tp = (planWeek as any).training_plans;
    if (!tp || tp.profile_id !== profileId) {
      return json(403, { error: "Not your plan_workout" }, req);
    }
    const planStartDate: string = tp.start_date;
    // deno-lint-ignore no-explicit-any
    const weekNumber: number = (planWeek as any).week_number;

    const fromDow: number = (row as PlanWorkout).day_of_week;
    const fromSort: number = (row as PlanWorkout).sort_order ?? 0;

    // 2. Load all rows in this plan_week so we can renumber siblings.
    const { data: siblings, error: sibErr } = await db.from("plan_workouts")
      .select("id, day_of_week, sort_order")
      .eq("plan_week_id", (row as PlanWorkout).plan_week_id);
    if (sibErr || !siblings) return json(500, { error: "Could not load siblings" }, req);

    const allRows = (siblings as PlanWorkout[]).map((r) => ({
      id: r.id,
      day_of_week: r.day_of_week,
      sort_order: r.sort_order ?? 0,
    }));

    // 3. Compute new sort_order layout.
    //    - Remove the moving row from its current day.
    //    - Insert into destination day at to_sort_order (or append).
    const sourceDay = allRows
      .filter((r) => r.day_of_week === fromDow && r.id !== planWorkoutId)
      .sort((a, b) => a.sort_order - b.sort_order);

    const destDay = allRows
      .filter((r) => r.day_of_week === toDow && r.id !== planWorkoutId)
      .sort((a, b) => a.sort_order - b.sort_order);

    const insertIndex = toSortOrder === null
      ? destDay.length
      : Math.max(0, Math.min(destDay.length, toSortOrder));

    // Renumber source day: 0..N-1.
    const sourceUpdates: { id: string; sort_order: number }[] = [];
    sourceDay.forEach((r, idx) => {
      if (r.sort_order !== idx) sourceUpdates.push({ id: r.id, sort_order: idx });
    });

    // Build destination ordered list with the moving row inserted at insertIndex.
    const destOrdered = [...destDay];
    destOrdered.splice(insertIndex, 0, {
      id: planWorkoutId,
      day_of_week: toDow,
      sort_order: insertIndex,
    });

    const destUpdates: { id: string; sort_order: number; day_of_week?: number; workout_date?: string }[] = [];
    destOrdered.forEach((r, idx) => {
      if (r.id === planWorkoutId) {
        // The moving row also needs day_of_week + workout_date updated.
        const newDate = addDays(planStartDate, (weekNumber - 1) * 7 + toDow);
        destUpdates.push({
          id: r.id,
          sort_order: idx,
          day_of_week: toDow,
          workout_date: newDate,
        });
      } else if (r.sort_order !== idx) {
        destUpdates.push({ id: r.id, sort_order: idx });
      }
    });

    // 4. Apply updates. Important order to avoid hitting the unique
    //    (plan_week_id, day_of_week, sort_order) constraint mid-transaction:
    //    a) First park the moving row at a safe negative sort_order so it
    //       does not collide with anyone else as we renumber.
    //    b) Renumber siblings on source day.
    //    c) Renumber siblings on destination day.
    //    d) Finally update the moving row to its target slot.

    const { error: parkErr } = await db.from("plan_workouts")
      .update({ sort_order: -1 })
      .eq("id", planWorkoutId);
    if (parkErr) return json(500, { error: `park failed: ${parkErr.message}` }, req);

    for (const u of sourceUpdates) {
      // Park first to avoid collision on (plan_week_id, day_of_week, sort_order).
      const { error } = await db.from("plan_workouts")
        .update({ sort_order: -2 - u.sort_order })
        .eq("id", u.id);
      if (error) return json(500, { error: `source park failed: ${error.message}` }, req);
    }
    for (const u of sourceUpdates) {
      const { error } = await db.from("plan_workouts")
        .update({ sort_order: u.sort_order })
        .eq("id", u.id);
      if (error) return json(500, { error: `source renumber failed: ${error.message}` }, req);
    }

    const destOnlySiblingUpdates = destUpdates.filter((u) => u.id !== planWorkoutId);
    for (const u of destOnlySiblingUpdates) {
      const { error } = await db.from("plan_workouts")
        .update({ sort_order: -100 - u.sort_order })
        .eq("id", u.id);
      if (error) return json(500, { error: `dest park failed: ${error.message}` }, req);
    }
    for (const u of destOnlySiblingUpdates) {
      const { error } = await db.from("plan_workouts")
        .update({ sort_order: u.sort_order })
        .eq("id", u.id);
      if (error) return json(500, { error: `dest renumber failed: ${error.message}` }, req);
    }

    // Finally place the moving row at its target slot (with new day + date).
    const movingTarget = destUpdates.find((u) => u.id === planWorkoutId)!;
    const { error: finalErr } = await db.from("plan_workouts")
      .update({
        sort_order: movingTarget.sort_order,
        day_of_week: movingTarget.day_of_week,
        workout_date: movingTarget.workout_date,
      })
      .eq("id", planWorkoutId);
    if (finalErr) return json(500, { error: `final move failed: ${finalErr.message}` }, req);

    return json(200, {
      ok: true,
      moved: {
        plan_workout_id: planWorkoutId,
        from: { day_of_week: fromDow, sort_order: fromSort },
        to: { day_of_week: toDow, sort_order: movingTarget.sort_order },
      },
    }, req);
  } catch (e) {
    return json(500, { error: (e as Error).message || "Internal error" }, req);
  }
});
