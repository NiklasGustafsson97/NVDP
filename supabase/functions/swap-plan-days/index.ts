// Swap two plan_workouts rows by day_of_week within a plan_week.
//
// POST { plan_week_id, from_day_of_week, to_day_of_week }
// Auth: user bearer token. Verifies the plan_week belongs to the caller's
// profile before mutating anything.
//
// Semantics match coach-chat / weekly-checkin "move_session": only the
// workout content is swapped (activity_type, label, description, targets,
// intensity_zone, is_rest). day_of_week and workout_date stay anchored to
// each row so the calendar layout is preserved.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handlePreflight, jsonResponse } from "../_shared/cors.ts";
import { requireUserProfile } from "../_shared/auth.ts";

// Mirrors pickWorkoutBody in site/supabase/functions/_shared/checkin-engine.ts —
// keep in sync.
interface PlanWorkout {
  id: string;
  day_of_week: number;
  workout_date: string;
  activity_type: string | null;
  label: string | null;
  description: string | null;
  target_duration_minutes: number | null;
  target_distance_km: number | null;
  intensity_zone: string | null;
  is_rest: boolean | null;
}

function pickWorkoutBody(w: PlanWorkout) {
  return {
    activity_type: w.activity_type,
    label: w.label,
    description: w.description,
    target_duration_minutes: w.target_duration_minutes,
    target_distance_km: w.target_distance_km,
    intensity_zone: w.intensity_zone,
    is_rest: w.is_rest,
  };
}

serve(async (req) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return jsonResponse(405, { error: "Method not allowed" }, req);

  try {
    const auth = await requireUserProfile(req);
    if (auth.error) return auth.error;
    const { profileId, db } = auth;

    const body = await req.json().catch(() => ({}));
    const planWeekId = body?.plan_week_id;
    const fromDow = Number(body?.from_day_of_week);
    const toDow = Number(body?.to_day_of_week);

    if (!planWeekId || !Number.isInteger(fromDow) || !Number.isInteger(toDow)) {
      return jsonResponse(400, { error: "Missing plan_week_id, from_day_of_week, or to_day_of_week" }, req);
    }
    if (fromDow < 0 || fromDow > 6 || toDow < 0 || toDow > 6) {
      return jsonResponse(400, { error: "day_of_week must be 0–6" }, req);
    }
    if (fromDow === toDow) {
      return jsonResponse(200, { ok: true, noop: true }, req);
    }

    // Verify ownership: the plan_week must belong to a training_plan owned by
    // this profile. Service-role client bypasses RLS so we check explicitly.
    const { data: planWeek, error: pwErr } = await db.from("plan_weeks")
      .select("id, plan_id, training_plans!inner(profile_id)")
      .eq("id", planWeekId)
      .single();
    if (pwErr || !planWeek) return jsonResponse(404, { error: "plan_week not found" }, req);
    // deno-lint-ignore no-explicit-any
    const ownerId = (planWeek as any).training_plans?.profile_id;
    if (ownerId !== profileId) return jsonResponse(403, { error: "Not your plan_week" }, req);

    // Fetch the two rows we are about to swap.
    const { data: rows, error: rowsErr } = await db.from("plan_workouts")
      .select("*")
      .eq("plan_week_id", planWeekId)
      .in("day_of_week", [fromDow, toDow]);
    if (rowsErr || !rows || rows.length !== 2) {
      return jsonResponse(404, { error: "Could not fetch both plan_workouts rows" }, req);
    }

    const fromRow = (rows as PlanWorkout[]).find((r) => r.day_of_week === fromDow)!;
    const toRow = (rows as PlanWorkout[]).find((r) => r.day_of_week === toDow)!;

    const fromBody = pickWorkoutBody(fromRow);
    const toBody = pickWorkoutBody(toRow);

    // Two updates. If the second one fails we attempt to roll the first back.
    const { error: e1 } = await db.from("plan_workouts").update(toBody).eq("id", fromRow.id);
    if (e1) return jsonResponse(500, { error: `update from-row failed: ${e1.message}` }, req);

    const { error: e2 } = await db.from("plan_workouts").update(fromBody).eq("id", toRow.id);
    if (e2) {
      // Best-effort rollback of the first update.
      await db.from("plan_workouts").update(fromBody).eq("id", fromRow.id);
      return jsonResponse(500, { error: `update to-row failed: ${e2.message}` }, req);
    }

    return jsonResponse(200, {
      ok: true,
      swapped: { from: fromDow, to: toDow },
    }, req);
  } catch (e) {
    return jsonResponse(500, { error: (e as Error).message || "Internal error" }, req);
  }
});
