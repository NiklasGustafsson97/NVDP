// Coach Nudge — cron-triggered "talk-worthy event" seeding.
//
// Schedule via Supabase cron (pg_cron) daily around 08:00 local
// (Europe/Stockholm). Example:
//
//   select cron.schedule(
//     'coach-nudge-daily',
//     '0 7 * * *',           -- 07:00 UTC daily (08:00/09:00 Stockholm)
//     $$select net.http_post(
//         url:='<SUPABASE_URL>/functions/v1/coach-nudge',
//         headers:='{"Authorization":"Bearer <SERVICE_ROLE_KEY>"}'::jsonb
//     )$$
//   );
//
// For each profile with an active training plan the function detects the
// following 6 "talk-worthy" events and, if the nudge wasn't already posted
// within the last 24h, inserts an assistant message with suggested chips
// into the user's active coach thread:
//
//   1. missed_workout        — a planned, non-rest session is at least 18h
//                              past its start with no logged workout.
//   2. overload_risk         — 7-day ATL exceeds 1.5× 28-day CTL (ACWR danger
//                              band) or TSB < −30.
//   3. easy_hr_drift         — avg easy-pace HR has climbed ≥3 bpm over the
//                              last 4 weeks vs the prior 4.
//   4. polarization_drift    — last 28 days have <70% easy or >25% hard by
//                              in-zone minutes.
//   5. streak_milestone      — exactly hit 4 / 8 / 12 consecutive completed
//                              weeks today.
//   6. race_day_approaching  — coach_memory.facts.race_targets has a race
//                              ≤ 14 days out that hasn't been mentioned.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  type LoggedWorkout,
  type PlanWorkout,
  addDays,
  estimateLoad,
  isoDate,
  mondayOf,
} from "../_shared/checkin-engine.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") || "";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type NudgeKind =
  | "missed_workout"
  | "overload_risk"
  | "easy_hr_drift"
  | "polarization_drift"
  | "streak_milestone"
  | "race_day_approaching"
  | "weekly_checkin_due";

interface Nudge {
  kind: NudgeKind;
  key: string;
  content: string;
  chips: string[];
}

const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

// ────────────────────────────────────────────────────────────────────────────
//  EWMA helpers (same contract as the client-side PMC).
// ────────────────────────────────────────────────────────────────────────────

function ewmaLast(values: number[], tau: number): number {
  const alpha = 1 - Math.exp(-1 / tau);
  let prev = 0;
  for (const v of values) prev = prev + alpha * (v - prev);
  return prev;
}

function dailyLoadArray(workouts: LoggedWorkout[], userMaxHr: number | null, days: number): number[] {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = addDays(today, -(days - 1));
  const byDate = new Map<string, number>();
  for (const w of workouts) {
    if (!w.workout_date) continue;
    byDate.set(w.workout_date, (byDate.get(w.workout_date) || 0) + estimateLoad(w, userMaxHr));
  }
  const out: number[] = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(start, i);
    out.push(byDate.get(isoDate(d)) || 0);
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
//  Nudge detectors
// ────────────────────────────────────────────────────────────────────────────

async function detectMissedWorkout(
  db: SupabaseClient,
  profileId: string,
  _userMaxHr: number | null,
): Promise<Nudge | null> {
  const now = new Date();
  const yesterday = addDays(now, -1);
  const two = addDays(now, -2);
  const { data: planWos } = await db.from("plan_workouts")
    .select("id, workout_date, label, activity_type, is_rest, day_of_week")
    .gte("workout_date", isoDate(two))
    .lte("workout_date", isoDate(yesterday));
  const candidate = (planWos || []).find((w: PlanWorkout) => !w.is_rest) as PlanWorkout | undefined;
  if (!candidate) return null;
  const { data: logged } = await db.from("workouts")
    .select("id")
    .eq("profile_id", profileId)
    .eq("workout_date", candidate.workout_date)
    .limit(1);
  if (logged && logged.length > 0) return null;

  const label = candidate.label || candidate.activity_type;
  return {
    kind: "missed_workout",
    key: `missed_workout:${candidate.workout_date}`,
    content: `Såg att ${label} på ${candidate.workout_date} inte blev loggat. Hände det något — eller vill du flytta det till en annan dag?`,
    chips: ["Flytta till senare", "Hoppade över", "Gjorde det men glömde logga", "Allt är bra"],
  };
}

async function detectOverloadRisk(
  db: SupabaseClient,
  profileId: string,
  userMaxHr: number | null,
): Promise<Nudge | null> {
  const today = new Date();
  const windowStart = addDays(today, -60);
  const { data: workouts } = await db.from("workouts")
    .select("id, workout_date, activity_type, duration_minutes, intensity, distance_km, avg_hr, max_hr")
    .eq("profile_id", profileId)
    .gte("workout_date", isoDate(windowStart))
    .lte("workout_date", isoDate(today));
  const rows = (workouts || []) as LoggedWorkout[];
  if (rows.length < 5) return null;

  const loads = dailyLoadArray(rows, userMaxHr, 60);
  const ctl = ewmaLast(loads, 42);
  const atl = ewmaLast(loads, 7);
  const tsb = ctl - atl;
  const acwr = ctl > 0 ? atl / ctl : 0;

  if (tsb < -30) {
    return {
      kind: "overload_risk",
      key: `overload_risk:tsb:${isoDate(today)}`,
      content: `Du är rätt trött just nu (TSB ${tsb.toFixed(0)}). Två lugna dagar gör ofta mer än ett pass till. Vad säger kroppen?`,
      chips: ["Orkar ändå", "Behöver vila", "Justera schemat"],
    };
  }
  if (acwr > 1.5) {
    return {
      kind: "overload_risk",
      key: `overload_risk:acwr:${isoDate(today)}`,
      content: `Belastningen har dragit iväg (ACWR ${acwr.toFixed(2)}). Det är skadezon — ska vi dra ner nästa vecka lite?`,
      chips: ["Dra ner volymen", "Jag mår bra", "Förklara"],
    };
  }
  return null;
}

async function detectEasyHrDrift(
  db: SupabaseClient,
  profileId: string,
  _userMaxHr: number | null,
): Promise<Nudge | null> {
  const today = new Date();
  const cutoff = addDays(today, -56);
  const { data: runs } = await db.from("workouts")
    .select("workout_date, activity_type, avg_hr, duration_minutes, intensity")
    .eq("profile_id", profileId)
    .eq("activity_type", "Löpning")
    .gte("workout_date", isoDate(cutoff));
  const easy = (runs || []).filter((w: { intensity: string | null; avg_hr: number | null }) =>
    (w.intensity === "Z1" || w.intensity === "Z2") && w.avg_hr && w.avg_hr >= 80,
  );
  if (easy.length < 6) return null;
  const mid = addDays(today, -28);
  const recent = easy.filter((w: { workout_date: string }) => w.workout_date >= isoDate(mid));
  const prior = easy.filter((w: { workout_date: string }) => w.workout_date < isoDate(mid));
  if (recent.length < 3 || prior.length < 3) return null;
  const wavg = (arr: { avg_hr: number; duration_minutes: number }[]) => {
    const s = arr.reduce((a, b) => a + (b.avg_hr * b.duration_minutes), 0);
    const t = arr.reduce((a, b) => a + b.duration_minutes, 0);
    return t > 0 ? s / t : 0;
  };
  const avgRecent = wavg(recent as { avg_hr: number; duration_minutes: number }[]);
  const avgPrior = wavg(prior as { avg_hr: number; duration_minutes: number }[]);
  const delta = avgRecent - avgPrior;
  if (delta < 3) return null;
  return {
    kind: "easy_hr_drift",
    key: `easy_hr_drift:${isoDate(today)}`,
    content: `Pulsen på easy-passen har gått upp ${delta.toFixed(1)} bpm senaste 4 veckorna vs innan dess. Kan vara sömn, stress eller trötthet. Hur känns det?`,
    chips: ["Sover dåligt", "Känner mig pigg", "Kör hårdare än vanligt", "Inget konstigt"],
  };
}

async function detectPolarizationDrift(
  db: SupabaseClient,
  profileId: string,
  _userMaxHr: number | null,
): Promise<Nudge | null> {
  const today = new Date();
  const cutoff = addDays(today, -28);
  const { data: rows } = await db.from("workouts")
    .select("activity_type, duration_minutes, intensity, hr_zone_seconds")
    .eq("profile_id", profileId)
    .gte("workout_date", isoDate(cutoff));
  if (!rows || rows.length < 6) return null;

  let easy = 0, mod = 0, hard = 0;
  for (const w of rows as { activity_type: string; duration_minutes: number; intensity: string | null; hr_zone_seconds: number[] | null }[]) {
    if (w.activity_type === "Vila" || !w.duration_minutes) continue;
    if (w.hr_zone_seconds && Array.isArray(w.hr_zone_seconds) && w.hr_zone_seconds.length >= 5) {
      easy += (w.hr_zone_seconds[0] || 0) + (w.hr_zone_seconds[1] || 0);
      mod += w.hr_zone_seconds[2] || 0;
      hard += (w.hr_zone_seconds[3] || 0) + (w.hr_zone_seconds[4] || 0);
      continue;
    }
    const sec = w.duration_minutes * 60;
    if (w.intensity === "Z1" || w.intensity === "Z2") easy += sec;
    else if (w.intensity === "Z3" || w.intensity === "mixed") mod += sec;
    else if (w.intensity === "Z4" || w.intensity === "Z5" || w.intensity === "Kvalitet") hard += sec;
    else easy += sec;
  }
  const total = easy + mod + hard;
  if (total <= 0) return null;
  const pEasy = (easy / total) * 100;
  const pHard = (hard / total) * 100;

  if (pEasy < 70) {
    return {
      kind: "polarization_drift",
      key: `polarization_drift:low_easy:${isoDate(today)}`,
      content: `Bara ${Math.round(pEasy)}% av din träning är i Z1-Z2 senaste 4 veckor. Målet är ~80%. Vill du att jag lägger till mer lugn bas?`,
      chips: ["Justera schemat", "Förklara varför", "Jag kör som jag vill"],
    };
  }
  if (pHard > 25) {
    return {
      kind: "polarization_drift",
      key: `polarization_drift:high_hard:${isoDate(today)}`,
      content: `${Math.round(pHard)}% av volymen är i Z4-Z5 senaste månaden. Det är mycket — risk för överträning. Ska vi lätta på kvalitet nästa vecka?`,
      chips: ["Lätta på kvalitet", "Jag mår bra", "Förklara"],
    };
  }
  return null;
}

async function detectStreakMilestone(
  db: SupabaseClient,
  profileId: string,
  _userMaxHr: number | null,
): Promise<Nudge | null> {
  const today = new Date();
  const cutoff = addDays(today, -7 * 14);
  const { data: rows } = await db.from("workouts")
    .select("workout_date, duration_minutes")
    .eq("profile_id", profileId)
    .gte("workout_date", isoDate(cutoff))
    .order("workout_date", { ascending: true });
  if (!rows) return null;

  const weekMap = new Map<string, number>();
  for (const w of rows as { workout_date: string; duration_minutes: number }[]) {
    const mon = isoDate(mondayOf(new Date(w.workout_date + "T00:00:00")));
    weekMap.set(mon, (weekMap.get(mon) || 0) + (w.duration_minutes || 0));
  }

  // Count trailing weeks with ≥60 min, walking back from last full week.
  const now = new Date();
  const dow = (now.getDay() + 6) % 7;
  let cursor = dow === 6 ? mondayOf(now) : mondayOf(addDays(now, -7));
  let streak = 0;
  while (streak < 14) {
    const key = isoDate(cursor);
    const total = weekMap.get(key) || 0;
    if (total < 60) break;
    streak++;
    cursor = addDays(cursor, -7);
  }
  if (![4, 8, 12].includes(streak)) return null;
  return {
    kind: "streak_milestone",
    key: `streak_milestone:${streak}`,
    content: streak === 4
      ? "4 veckor i rad med träning — det är här vanorna börjar bita. Snyggt."
      : streak === 8
      ? "8 veckor i rad. Det här är inte slump — det är en rutin. Grymt jobbat."
      : "12 veckor i rad. Det är ett helt träningskvartal. Vad är nästa mål?",
    chips: streak === 12
      ? ["Sätt ett race-mål", "Kör vidare", "Reflektera"]
      : ["Tack!", "Vad ska jag fokusera på nu?"],
  };
}

async function detectRaceApproaching(
  db: SupabaseClient,
  profileId: string,
  _userMaxHr: number | null,
): Promise<Nudge | null> {
  const { data: mem } = await db.from("coach_memory")
    .select("facts")
    .eq("profile_id", profileId)
    .maybeSingle();
  const facts = (mem?.facts || {}) as Record<string, unknown>;
  const races = Array.isArray(facts.race_targets) ? facts.race_targets as { name?: string; date?: string }[] : [];
  if (races.length === 0) return null;
  const today = new Date();
  const ms14 = 14 * 24 * 60 * 60 * 1000;
  for (const r of races) {
    if (!r?.date) continue;
    const d = new Date(r.date + "T00:00:00");
    if (isNaN(d.getTime())) continue;
    const diff = d.getTime() - today.getTime();
    if (diff <= 0 || diff > ms14) continue;
    const days = Math.max(1, Math.round(diff / (24 * 60 * 60 * 1000)));
    return {
      kind: "race_day_approaching",
      key: `race_day_approaching:${r.date}`,
      content: `${r.name || "Din tävling"} är om ${days} dag${days === 1 ? "" : "ar"}. Vill du att jag drar ihop en taper-plan och pratar race-strategi?`,
      chips: ["Ja, taper-plan", "Race-strategi", "Jag fixar det själv"],
    };
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
//  Sunday weekly check-in — migrated from the legacy modal wizard into chat.
//  Only active for profiles that opted in via coach_checkin_chat_enabled.
//  Seeds the conversation with the first question (overall feel) — the LLM
//  then follows up and ultimately proposes plan changes via
//  propose_plan_changes once enough signal is gathered.
// ────────────────────────────────────────────────────────────────────────────

function _checkinReviewWeekStart(now: Date): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const dow = (d.getDay() + 6) % 7; // Mon=0..Sun=6
  if (dow === 6) {
    // Sunday — review the current ISO week.
    d.setDate(d.getDate() - 6);
    return d;
  }
  // Otherwise fall back to the previous Monday.
  d.setDate(d.getDate() - dow - 7);
  return d;
}

async function detectWeeklyCheckinDue(
  db: SupabaseClient,
  profileId: string,
  _userMaxHr: number | null,
): Promise<Nudge | null> {
  const now = new Date();
  // Only fire on Sundays (local to the cron schedule — UTC Sunday is close
  // enough for an 07:00 UTC run; Stockholm is already Sunday afternoon).
  const dow = (now.getDay() + 6) % 7;
  if (dow !== 6) return null;

  const { data: prof } = await db.from("profiles")
    .select("coach_checkin_chat_enabled")
    .eq("id", profileId)
    .maybeSingle();
  if (!prof?.coach_checkin_chat_enabled) return null;

  const weekStartISO = isoDate(_checkinReviewWeekStart(now));
  const { data: existing } = await db.from("weekly_checkins")
    .select("id, status")
    .eq("profile_id", profileId)
    .eq("week_start_date", weekStartISO)
    .maybeSingle();
  if (existing && (existing.status === "applied" || existing.status === "declined")) return null;

  return {
    kind: "weekly_checkin_due",
    key: `weekly_checkin_due:${weekStartISO}`,
    content:
      "Söndag — dags för veckoavstämning. Hur kändes veckan som helhet? " +
      "Berätta kort, så följer jag upp med ett par frågor och föreslår justeringar för nästa vecka.",
    chips: ["Över förväntan", "Som förväntat", "Tufft", "Skada/Nypning"],
  };
}

// ────────────────────────────────────────────────────────────────────────────
//  Seed the nudge into the active coach thread (with per-key dedupe).
// ────────────────────────────────────────────────────────────────────────────

async function seedNudge(db: SupabaseClient, profileId: string, nudge: Nudge): Promise<boolean> {
  // Dedupe: skip if any coach_messages row in the last 24h has tool_calls
  // containing the same key.
  const since = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString();
  const { data: recent } = await db.from("coach_messages")
    .select("id, tool_calls, created_at")
    .eq("profile_id", profileId)
    .gte("created_at", since);
  for (const m of (recent || []) as { tool_calls: unknown }[]) {
    const calls = Array.isArray(m.tool_calls) ? m.tool_calls as { nudge_key?: string }[] : [];
    if (calls.some((c) => c && c.nudge_key === nudge.key)) return false;
  }

  // Find or create active thread for this profile.
  const { data: existing } = await db.from("coach_threads")
    .select("id")
    .eq("profile_id", profileId)
    .eq("status", "active")
    .maybeSingle();
  let threadId = existing?.id as string | undefined;
  if (!threadId) {
    const { data: fresh } = await db.from("coach_threads")
      .insert({ profile_id: profileId, status: "active" })
      .select("id")
      .single();
    threadId = fresh?.id;
  }
  if (!threadId) return false;

  await db.from("coach_messages").insert({
    thread_id: threadId,
    profile_id: profileId,
    role: "assistant",
    content: nudge.content,
    chips: nudge.chips,
    tool_calls: [{ nudge_kind: nudge.kind, nudge_key: nudge.key }],
  });
  await db.from("coach_threads")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", threadId);
  return true;
}

// ────────────────────────────────────────────────────────────────────────────
//  Handler
// ────────────────────────────────────────────────────────────────────────────

serve(async (req) => {
  try {
    const auth = req.headers.get("authorization") || "";
    const cronToken = req.headers.get("x-cron-secret") || "";
    const serviceOk = auth.includes(SUPABASE_SERVICE_KEY);
    const cronOk = CRON_SECRET && cronToken === CRON_SECRET;
    if (!serviceOk && !cronOk) return json({ error: "unauthorized" }, 401);

    const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Optional ?profile_id= for targeted testing, else run for every profile
    // that has an active plan.
    const url = new URL(req.url);
    const targetProfileId = url.searchParams.get("profile_id");

    let profiles: { id: string; user_max_hr: number | null }[] = [];
    if (targetProfileId) {
      const { data } = await db.from("profiles")
        .select("id, user_max_hr")
        .eq("id", targetProfileId)
        .limit(1);
      profiles = (data || []) as typeof profiles;
    } else {
      const { data: plans } = await db.from("training_plans")
        .select("profile_id")
        .eq("status", "active");
      const ids = [...new Set((plans || []).map((p: { profile_id: string }) => p.profile_id))];
      if (ids.length === 0) return json({ ok: true, processed: 0, nudges: 0 });
      const { data } = await db.from("profiles")
        .select("id, user_max_hr")
        .in("id", ids);
      profiles = (data || []) as typeof profiles;
    }

    // Weekly check-in goes first so that, on Sundays, opted-in profiles always
    // see the check-in prompt rather than a generic missed-workout nudge.
    const detectors = [
      detectWeeklyCheckinDue,
      detectMissedWorkout,
      detectOverloadRisk,
      detectEasyHrDrift,
      detectPolarizationDrift,
      detectStreakMilestone,
      detectRaceApproaching,
    ];

    let seeded = 0;
    const summary: { profile_id: string; kinds: string[] }[] = [];

    for (const p of profiles) {
      const kindsSeeded: string[] = [];
      for (const detector of detectors) {
        try {
          const nudge = await detector(db, p.id, p.user_max_hr);
          if (!nudge) continue;
          const wrote = await seedNudge(db, p.id, nudge);
          if (wrote) { seeded++; kindsSeeded.push(nudge.kind); }
          // Only one nudge per profile per cron run so we don't spam.
          if (kindsSeeded.length >= 1) break;
        } catch (e) {
          console.error("coach-nudge detector error", p.id, e);
        }
      }
      if (kindsSeeded.length) summary.push({ profile_id: p.id, kinds: kindsSeeded });
    }

    return json({ ok: true, processed: profiles.length, nudges: seeded, summary });
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    console.error("coach-nudge error", err);
    return json({ error: "internal" }, 500);
  }
});
