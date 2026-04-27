// Accept or decline a workout invitation.
//
// POST {
//   invitation_id: string,
//   accept: boolean,
//   replace_plan_workout_id?: string,
//   add_as_extra?: boolean
// }
//
// Accept requires an explicit plan action: replace one of the receiver's
// planned sessions on the same date, or add the invited session as an extra
// session on that date.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handlePreflight, jsonResponse } from "../_shared/cors.ts";
import { requireUserProfile } from "../_shared/auth.ts";

interface Invitation {
  id: string;
  sender_id: string;
  receiver_id: string;
  workout_date: string;
  activity_type: string | null;
  label: string | null;
  description: string | null;
  duration_minutes: number | null;
  target_duration_minutes: number | null;
  target_distance_km: number | null;
  intensity: string | null;
  intensity_zone: string | null;
  status: string;
}

interface PlanWorkout {
  id: string;
  plan_week_id: string;
  workout_date: string;
  day_of_week: number;
  sort_order: number | null;
}

function parseUtcDate(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00Z`);
}

function diffDays(from: string, to: string): number {
  const ms = parseUtcDate(to).getTime() - parseUtcDate(from).getTime();
  return Math.floor(ms / 86_400_000);
}

function invitationWorkoutBody(inv: Invitation) {
  const activityType = inv.activity_type || "Pass";
  const label = inv.label || activityType;
  const duration = inv.target_duration_minutes ?? inv.duration_minutes ?? null;
  const intensityZone = inv.intensity_zone || inv.intensity || null;

  return {
    activity_type: activityType,
    label,
    description: inv.description,
    target_duration_minutes: duration,
    target_distance_km: inv.target_distance_km,
    intensity_zone: intensityZone,
    is_rest: false,
  };
}

async function insertResponseNudge(
  // deno-lint-ignore no-explicit-any
  db: any,
  inv: Invitation,
  receiverId: string,
  accepted: boolean,
) {
  const { data: receiver } = await db.from("profiles")
    .select("name")
    .eq("id", receiverId)
    .maybeSingle();

  const receiverName = receiver?.name || "Någon";
  const date = parseUtcDate(inv.workout_date);
  const dateLabel = `${date.getUTCDate()}/${date.getUTCMonth() + 1}`;
  const verb = accepted ? "accepterade" : "avböjde";
  const type = accepted ? "invitation_accepted" : "invitation_declined";

  await db.from("nudges").insert({
    sender_id: receiverId,
    receiver_id: inv.sender_id,
    message: `${receiverName} ${verb} din inbjudan till ${inv.activity_type || "pass"} den ${dateLabel}`,
    type,
    reference_id: inv.id,
  });
}

async function markInvitation(
  // deno-lint-ignore no-explicit-any
  db: any,
  invitationId: string,
  status: "accepted" | "declined" | "pending",
) {
  const query = db.from("workout_invitations")
    .update({ status })
    .eq("id", invitationId);

  const guarded = status === "pending" ? query : query.eq("status", "pending");
  const { data, error } = await guarded.select("id").maybeSingle();
  if (error) throw error;
  if (!data && status !== "pending") {
    throw new Error("Invitationen har redan hanterats.");
  }
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
    const invitationId = body?.invitation_id;
    const accept = body?.accept === true;
    const replacePlanWorkoutId = body?.replace_plan_workout_id || null;
    const addAsExtra = body?.add_as_extra === true;

    if (!invitationId) {
      return jsonResponse(400, { error: "Missing invitation_id" }, req);
    }

    const { data: invitation, error: inviteErr } = await db.from("workout_invitations")
      .select("*")
      .eq("id", invitationId)
      .single();

    if (inviteErr || !invitation) {
      return jsonResponse(404, { error: "Invitation not found" }, req);
    }

    const inv = invitation as Invitation;
    if (inv.receiver_id !== profileId) {
      return jsonResponse(403, { error: "Not your invitation" }, req);
    }
    if (inv.status !== "pending") {
      return jsonResponse(409, { error: "Invitationen har redan hanterats." }, req);
    }

    if (!accept) {
      await markInvitation(db, inv.id, "declined");
      await insertResponseNudge(db, inv, profileId, false).catch((e: Error) => {
        console.warn("Could not insert invitation decline nudge:", e.message);
      });
      return jsonResponse(200, { ok: true, status: "declined" }, req);
    }

    if ((replacePlanWorkoutId ? 1 : 0) + (addAsExtra ? 1 : 0) !== 1) {
      return jsonResponse(400, {
        error: "Välj ett pass att ersätta, eller välj att lägga till inbjudan som extra pass.",
      }, req);
    }

    await markInvitation(db, inv.id, "accepted");

    try {
      const workoutBody = invitationWorkoutBody(inv);
      let planAction = "replaced";

      if (replacePlanWorkoutId) {
        const { data: target, error: targetErr } = await db.from("plan_workouts")
          .select("id, plan_week_id, workout_date, day_of_week, sort_order, plan_weeks!inner(id, plan_id, training_plans!inner(id, profile_id, status))")
          .eq("id", replacePlanWorkoutId)
          .single();

        if (targetErr || !target) throw new Error("Hittade inte passet som skulle ersättas.");

        // deno-lint-ignore no-explicit-any
        const ownerId = (target as any).plan_weeks?.training_plans?.profile_id;
        // deno-lint-ignore no-explicit-any
        const planStatus = (target as any).plan_weeks?.training_plans?.status;
        if (ownerId !== profileId || planStatus !== "active") {
          throw new Error("Passet tillhör inte ditt aktiva schema.");
        }
        if ((target as PlanWorkout).workout_date !== inv.workout_date) {
          throw new Error("Passet som ersätts måste ligga på samma datum som inbjudan.");
        }

        const { error: updateErr } = await db.from("plan_workouts")
          .update(workoutBody)
          .eq("id", replacePlanWorkoutId);
        if (updateErr) throw updateErr;
      } else {
        planAction = "added";
        const { data: plan, error: planErr } = await db.from("training_plans")
          .select("id, start_date, end_date")
          .eq("profile_id", profileId)
          .eq("status", "active")
          .lte("start_date", inv.workout_date)
          .gte("end_date", inv.workout_date)
          .maybeSingle();

        if (planErr || !plan) {
          throw new Error("Hittade inget aktivt schema för datumet.");
        }

        const offsetDays = diffDays(plan.start_date, inv.workout_date);
        const weekNumber = Math.floor(offsetDays / 7) + 1;
        const dayOfWeek = ((offsetDays % 7) + 7) % 7;

        const { data: planWeek, error: weekErr } = await db.from("plan_weeks")
          .select("id")
          .eq("plan_id", plan.id)
          .eq("week_number", weekNumber)
          .single();
        if (weekErr || !planWeek) {
          throw new Error("Hittade inte planveckan för datumet.");
        }

        const { data: sameDayRows, error: rowsErr } = await db.from("plan_workouts")
          .select("sort_order")
          .eq("plan_week_id", planWeek.id)
          .eq("day_of_week", dayOfWeek);
        if (rowsErr) throw rowsErr;

        const maxSort = (sameDayRows || []).reduce(
          (max: number, row: { sort_order: number | null }) => Math.max(max, row.sort_order ?? 0),
          -1,
        );

        const { error: insertErr } = await db.from("plan_workouts").insert({
          plan_week_id: planWeek.id,
          workout_date: inv.workout_date,
          day_of_week: dayOfWeek,
          sort_order: maxSort + 1,
          ...workoutBody,
        });
        if (insertErr) throw insertErr;
      }

      await insertResponseNudge(db, inv, profileId, true).catch((e: Error) => {
        console.warn("Could not insert invitation response nudge:", e.message);
      });
      return jsonResponse(200, { ok: true, status: "accepted", plan_action: planAction }, req);
    } catch (e) {
      await markInvitation(db, inv.id, "pending").catch(() => null);
      throw e;
    }
  } catch (e) {
    return jsonResponse(500, { error: (e as Error).message || "Internal error" }, req);
  }
});
