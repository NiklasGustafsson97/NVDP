// Weekly Coach Check-In edge function
// POST with { mode: "propose" | "apply" | "decline", ...payload } and a valid user bearer token.
//
// propose  → computes objective snapshot for the week that just finished,
//            runs the rule-based decision engine (optionally LLM on top)
//            against next week's plan, stores a `weekly_checkins` row
//            with status='pending', and returns the diff.
// apply    → applies the selected changes to plan_workouts and marks
//            the check-in applied.
// decline  → marks the check-in declined. No plan mutation.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") || "";
const OPENAI_BASE_URL = Deno.env.get("OPENAI_BASE_URL") || "https://api.openai.com/v1";
const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

// ────────────────────────────────────────────────────────────────────────────
//  Types
// ────────────────────────────────────────────────────────────────────────────

interface PlanWorkout {
  id: string;
  plan_week_id: string;
  workout_date: string;
  day_of_week: number;
  activity_type: string;
  label: string | null;
  description: string | null;
  target_duration_minutes: number | null;
  target_distance_km: number | null;
  intensity_zone: string | null;
  is_rest: boolean;
  sort_order: number;
}

interface LoggedWorkout {
  id: string;
  workout_date: string;
  activity_type: string;
  duration_minutes: number;
  intensity: string | null;
  distance_km: number | null;
  avg_hr: number | null;
  max_hr: number | null;
}

interface CheckinResponses {
  overall_feel: number;                 // 1-5
  injury_level: "none" | "niggle" | "pain" | "paused";
  injury_note?: string;
  injury_side?: "left" | "right" | "both" | null;
  hardest_session_feel?: "too_hard" | "just_right" | "had_more" | null;
  long_run_feel?: "good" | "tough_end" | "cut_short" | "skipped" | null;
  unavailable_days?: number[];          // 0-6 (Mon=0)
  next_week_context?: string;
  free_text?: string;
}

interface ProposedChange {
  id: string;
  day_of_week: number;
  action:
    | "swap_to_easy"
    | "swap_to_quality"
    | "adjust_long_run"
    | "flatten_long_run"
    | "replace_with_crosstrain"
    | "add_rest"
    | "move_session";
  params: Record<string, unknown>;
  reason_sv: string;
  current_workout: PlanWorkout | null;
  proposed_workout: Partial<PlanWorkout> | null;
  from_day?: number;
  to_day?: number;
}

interface ObjectiveSummary {
  week_start: string;
  week_not_yet_closed: boolean;
  planned_sessions: number;
  logged_sessions: number;
  completion_rate: number;
  weekly_load: number;
  prior_4wk_avg_load: number;
  acwr: number;
  acwr_band: "under" | "sweet" | "caution" | "danger";
  easy_avg_hr: number | null;
  easy_avg_hr_prior_4wk: number | null;
  missed_sessions: { date: string; label: string | null }[];
  next_week_phase: string | null;
  next_week_plan: PlanWorkout[];
}

// ────────────────────────────────────────────────────────────────────────────
//  Date helpers (ISO week, Monday-first)
// ────────────────────────────────────────────────────────────────────────────

function isoDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

function mondayOf(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  const dow = (out.getDay() + 6) % 7; // Mon=0..Sun=6
  out.setDate(out.getDate() - dow);
  return out;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

/**
 * Determine which ISO week is being reviewed.
 * Sunday: the current ISO week's Monday; sets week_not_yet_closed=true
 *         because today's session may not yet be logged.
 * Monday–Saturday: the *previous* Monday (last week).
 */
function reviewWeekStart(now: Date): { weekStart: Date; weekNotYetClosed: boolean } {
  const dow = (now.getDay() + 6) % 7;
  if (dow === 6) {
    // Sunday
    return { weekStart: mondayOf(now), weekNotYetClosed: true };
  }
  // Mon..Sat → previous week
  const prevMon = mondayOf(addDays(now, -7));
  return { weekStart: prevMon, weekNotYetClosed: false };
}

// ────────────────────────────────────────────────────────────────────────────
//  Simple MET / load estimate (trimmed port of site/js/app.js)
// ────────────────────────────────────────────────────────────────────────────

const MET_BY_SPORT: Record<string, number> = {
  Löpning: 10.0,
  Cykel: 7.0,
  Gym: 5.0,
  Hyrox: 8.0,
  Stakmaskin: 9.0,
  Längdskidor: 9.0,
  Vila: 0,
  Annat: 5.0,
};

const INTENSITY_RPE: Record<string, number> = {
  Z1: 1, Z2: 3, Z3: 5, mixed: 5, Kvalitet: 7, Z4: 8, Z5: 10,
};

function estimateLoad(w: LoggedWorkout, userMaxHr: number | null): number {
  if (w.activity_type === "Vila" || !w.duration_minutes) return 0;
  const met = MET_BY_SPORT[w.activity_type] ?? 5.0;
  let im = 1.0;
  if (w.avg_hr && userMaxHr && userMaxHr >= 100) {
    const pct = w.avg_hr / userMaxHr;
    im = Math.max(0.7, Math.min(1.5, 0.7 + (pct - 0.5) * (0.8 / 0.5)));
  } else if (w.intensity && INTENSITY_RPE[w.intensity] != null) {
    const rpe = INTENSITY_RPE[w.intensity];
    im = Math.max(0.7, Math.min(1.5, 0.7 + (rpe - 1) * (0.8 / 9)));
  }
  return w.duration_minutes * met * im;
}

function acwrBand(acwr: number): "under" | "sweet" | "caution" | "danger" {
  if (acwr > 1.5) return "danger";
  if (acwr > 1.3) return "caution";
  if (acwr < 0.8) return "under";
  return "sweet";
}

// ────────────────────────────────────────────────────────────────────────────
//  Quality / long-run detection helpers
// ────────────────────────────────────────────────────────────────────────────

const QUALITY_LABEL_REGEX = /tröskel|tempo|vo2|interval|fartlek|kvalitet/i;
const LONG_RUN_LABEL_REGEX = /långpass|long run/i;

function isQualityWorkout(w: PlanWorkout): boolean {
  if (w.is_rest) return false;
  if (w.intensity_zone && ["Z4", "Z5", "mixed"].includes(w.intensity_zone)) return true;
  if (w.label && QUALITY_LABEL_REGEX.test(w.label)) return true;
  return false;
}

function isLongRun(w: PlanWorkout, allRunning: PlanWorkout[]): boolean {
  if (w.is_rest || w.activity_type !== "Löpning") return false;
  if (w.label && LONG_RUN_LABEL_REGEX.test(w.label)) return true;
  // Fallback: longest running session of the week (by duration or distance), >= 60 min
  const byDuration = [...allRunning].sort((a, b) =>
    (b.target_duration_minutes || 0) - (a.target_duration_minutes || 0),
  );
  return (
    byDuration[0]?.id === w.id &&
    (w.target_duration_minutes || 0) >= 60
  );
}

function isEasyRun(w: PlanWorkout): boolean {
  if (w.is_rest || w.activity_type !== "Löpning") return false;
  if (isQualityWorkout(w)) return false;
  if (w.intensity_zone && ["Z1", "Z2"].includes(w.intensity_zone)) return true;
  if (w.label && /lätt|distans|recovery|jogg/i.test(w.label)) return true;
  return false;
}

function countEasyDays(week: PlanWorkout[]): number {
  return week.filter((w) => !w.is_rest && !isQualityWorkout(w)).length;
}

function countQualityDays(week: PlanWorkout[]): number {
  return week.filter(isQualityWorkout).length;
}

function weekTargetMinutes(week: PlanWorkout[]): number {
  return week.reduce((s, w) => s + (w.target_duration_minutes || 0), 0);
}

// ────────────────────────────────────────────────────────────────────────────
//  Decision engine (rule-based, Slice 1)
// ────────────────────────────────────────────────────────────────────────────

function newChangeId(): string {
  return crypto.randomUUID();
}

interface EngineInput {
  responses: CheckinResponses;
  summary: ObjectiveSummary;
}

interface EngineOutput {
  coach_note: string;
  changes: ProposedChange[];
}

/**
 * Compose the proposed next-week changes from the rule matrix in the plan.
 * Order of operations:
 *   1. Hard injury veto (paused → recovery template; pain → conservative only).
 *   2. Accommodate unavailable days (move_session — free of the 2-change cap).
 *   3. Apply the feel/long-run/quality matrix, capped at 2 "real" changes.
 */
function runDecisionEngine(input: EngineInput): EngineOutput {
  const { responses, summary } = input;
  const next = summary.next_week_plan;
  const changes: ProposedChange[] = [];
  const notes: string[] = [];

  // ── 1. Injury veto ────────────────────────────────────────────────────────
  if (responses.injury_level === "paused") {
    // Convert every non-rest running day into an easy cycle/rest combo.
    for (const w of next) {
      if (w.is_rest) continue;
      if (w.activity_type === "Löpning") {
        changes.push({
          id: newChangeId(),
          day_of_week: w.day_of_week,
          action: "replace_with_crosstrain",
          params: { activity_type: "Cykel", intensity_zone: "Z2" },
          reason_sv: "Pausad löpning — byter till lugn cykel för att behålla konditionen",
          current_workout: w,
          proposed_workout: {
            activity_type: "Cykel",
            label: "Cykel Z2 (återhämtning)",
            description: "Lugn cykel i Z2, 30–45 min, puls klart under tröskel. Ingen belastning på skadan.",
            target_duration_minutes: Math.min(45, w.target_duration_minutes || 30),
            target_distance_km: null,
            intensity_zone: "Z2",
            is_rest: false,
          },
        });
      }
    }
    notes.push("Du sa att du pausar — vi lägger nästa vecka på lugn cykel så du håller grunden utan att belasta skadan. Kolla in med fysio innan vi bygger tillbaka.");
    return { coach_note: notes.join(" "), changes };
  }

  // ── 2. Unavailable days ───────────────────────────────────────────────────
  const unavailable = new Set((responses.unavailable_days || []).filter((d) => d >= 0 && d <= 6));
  if (unavailable.size > 0) {
    const restDays = next.filter((w) => w.is_rest && !unavailable.has(w.day_of_week)).map((w) => w.day_of_week);
    const freeDays = next.filter((w) => !w.is_rest && !unavailable.has(w.day_of_week)).map((w) => w.day_of_week);
    for (const d of unavailable) {
      const session = next.find((w) => w.day_of_week === d);
      if (!session || session.is_rest) continue;
      // Prefer swapping with an existing rest day; otherwise suggest add_rest.
      const target = restDays.shift();
      if (target != null) {
        const restSession = next.find((w) => w.day_of_week === target)!;
        changes.push({
          id: newChangeId(),
          day_of_week: d,
          action: "move_session",
          params: { from_day: d, to_day: target },
          from_day: d,
          to_day: target,
          reason_sv: `Du är upptagen ${dayName(d)} — flyttar passet till ${dayName(target)}`,
          current_workout: session,
          proposed_workout: { ...session, day_of_week: target, workout_date: restSession.workout_date },
        });
      } else if (freeDays.length > 0) {
        // All rest days are also unavailable; drop the session instead.
        changes.push({
          id: newChangeId(),
          day_of_week: d,
          action: "add_rest",
          params: {},
          reason_sv: `Du är upptagen ${dayName(d)} och resten av veckan är fullbokad — vi stryker passet`,
          current_workout: session,
          proposed_workout: {
            activity_type: "Vila",
            label: "Vila",
            description: null,
            target_duration_minutes: 0,
            target_distance_km: null,
            intensity_zone: null,
            is_rest: true,
          },
        });
      }
    }
  }

  // ── 3. Feel / long-run / quality matrix ───────────────────────────────────
  const feel = responses.overall_feel;
  const hardestFeel = responses.hardest_session_feel;
  const longRunFeel = responses.long_run_feel;
  const injury = responses.injury_level;
  const acwr = summary.acwr;

  const allRunning = next.filter((w) => w.activity_type === "Löpning" && !w.is_rest);
  const qualityDays = next.filter(isQualityWorkout);
  const longRunDay = next.find((w) => isLongRun(w, allRunning)) || null;
  const easyDays = next.filter(isEasyRun);

  // Budget for "real" adjustments (move_session does not count toward this).
  let budget = 2;

  const canAdjustLongRun = (delta: number): boolean => {
    if (!longRunDay) return false;
    if (delta > 0 && (acwr > 1.3 || injury !== "none")) return false;
    if (delta < 0 && acwr < 0.8) return false;
    return true;
  };

  const addChange = (c: ProposedChange) => {
    if (budget <= 0) return;
    changes.push(c);
    budget--;
  };

  // Injury niggle → conservative only
  const conservativeOnly = injury === "pain" || injury === "niggle";

  // Long run adjustments first (highest specificity signals)
  if (longRunDay && longRunFeel === "skipped" || longRunFeel === "cut_short") {
    if (canAdjustLongRun(-2) && longRunDay) {
      addChange(buildAdjustLongRun(longRunDay, -2, longRunFeel === "skipped"
        ? "Du hoppade långpasset — vi drar ner det 2 km nästa vecka och bygger tillbaka i lugn takt"
        : "Du kapade långpasset — kortare och lättare nästa vecka"));
    }
  } else if (longRunDay && longRunFeel === "tough_end") {
    if (longRunDay) {
      addChange(buildFlattenLongRun(longRunDay,
        "Det blev tungt i slutet — vi kör långpasset platt nästa vecka istället för progressivt"));
    }
  }

  // Overall feel matrix
  if (feel <= 1) {
    // Helt slut → stripe a quality day to easy + extra rest if possible
    const q = qualityDays[0];
    if (q) {
      addChange(buildSwapToEasy(q,
        "Du var helt slut — vi gör kvalitetspasset till en lugn jogg så du laddar om"));
    }
    const extra = easyDays.find((w) => !changes.some((c) => c.current_workout?.id === w.id));
    if (extra) {
      addChange(buildAddRest(extra,
        "Extra vilodag för att återhämta efter en tuff vecka"));
    }
  } else if (feel === 2) {
    if (acwr > 1.2 && qualityDays[0] && !changes.some((c) => c.current_workout?.id === qualityDays[0].id)) {
      addChange(buildSwapToEasy(qualityDays[0],
        "Tungt vecka och hög belastning — kvalitetspasset blir lugnt nästa vecka"));
    } else if (longRunDay && !changes.some((c) => c.current_workout?.id === longRunDay.id)) {
      addChange(buildFlattenLongRun(longRunDay,
        "Lite tungt — vi plattar ut långpasset utan att dra ner distansen"));
    }
  } else if (feel === 3) {
    // OK → let hardest/long-run signals speak. No additional change unless already added.
  } else if (feel === 4) {
    if (hardestFeel === "had_more" && injury === "none" && acwr < 1.2) {
      // swap_to_quality OR adjust_long_run(+1), pick one
      const easy = easyDays.find((w) => !changes.some((c) => c.current_workout?.id === w.id));
      if (easy) {
        addChange(buildSwapToQuality(easy,
          "Du hade mer att ge — vi lägger in ett extra kvalitetspass nästa vecka"));
      } else if (canAdjustLongRun(+1) && longRunDay) {
        addChange(buildAdjustLongRun(longRunDay, +1,
          "Du hade mer att ge — vi adderar 1 km på långpasset"));
      }
    }
  } else if (feel === 5) {
    if (injury === "none" && acwr < 1.2) {
      if (longRunDay && canAdjustLongRun(+2)) {
        addChange(buildAdjustLongRun(longRunDay, +2,
          "Superkänsla — 2 km extra på långpasset och vi håller resten som planerat"));
      } else {
        const easy = easyDays.find((w) => !changes.some((c) => c.current_workout?.id === w.id));
        if (easy) addChange(buildSwapToQuality(easy, "Superkänsla — extra kvalitetspass nästa vecka"));
      }
    }
  }

  // Hardest session "too hard" override (if not already handled by feel)
  if (hardestFeel === "too_hard" && qualityDays[0] && budget > 0 && !changes.some((c) => c.current_workout?.id === qualityDays[0].id)) {
    addChange(buildSwapToEasy(qualityDays[0],
      "Kvalitetspasset blev för tungt — vi gör nästa veckas version lugnare"));
  }

  // Injury niggle safety net — if any action was missed and we have a niggle, lean easier
  if (conservativeOnly && changes.length === 0 && qualityDays[0]) {
    addChange(buildSwapToEasy(qualityDays[0],
      "Du kände av lite — vi lättar på kvalitetspasset tills det släpper"));
  }

  // ── Hard-constraint pass ──────────────────────────────────────────────────
  const validated = validateChanges(changes, next);

  // ── Coach note composition (templated for Slice 1) ───────────────────────
  const note = validated.length === 0
    ? composeNoChangeNote(feel, injury)
    : composeCoachNote(feel, injury, validated);

  return { coach_note: note, changes: validated };
}

function dayName(d: number): string {
  return ["måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag", "söndag"][d] || `dag ${d}`;
}

// ── Change builders ─────────────────────────────────────────────────────────

function buildSwapToEasy(current: PlanWorkout, reason: string): ProposedChange {
  const duration = Math.min(current.target_duration_minutes || 45, 50);
  return {
    id: newChangeId(),
    day_of_week: current.day_of_week,
    action: "swap_to_easy",
    params: {},
    reason_sv: reason,
    current_workout: current,
    proposed_workout: {
      activity_type: "Löpning",
      label: "Lugn jogg Z2",
      description: `${Math.round(duration / 6)}–${Math.round(duration / 5)} km lugn Z2 (pratstempo). Håll pulsen under tröskel hela vägen.`,
      target_duration_minutes: duration,
      target_distance_km: current.target_distance_km ? Math.min(current.target_distance_km, 8) : null,
      intensity_zone: "Z2",
      is_rest: false,
    },
  };
}

function buildSwapToQuality(current: PlanWorkout, reason: string): ProposedChange {
  const duration = Math.max(45, current.target_duration_minutes || 45);
  return {
    id: newChangeId(),
    day_of_week: current.day_of_week,
    action: "swap_to_quality",
    params: {},
    reason_sv: reason,
    current_workout: current,
    proposed_workout: {
      activity_type: "Löpning",
      label: "Tröskelpass",
      description: "15 min uppvärm Z2 → 4×5 min Z4 (kontrollerat, pratstempo broken), 2–3 min lugn jogg mellan → 10 min nedvarv.",
      target_duration_minutes: duration,
      target_distance_km: current.target_distance_km,
      intensity_zone: "Z4",
      is_rest: false,
    },
  };
}

function buildAdjustLongRun(current: PlanWorkout, deltaKm: number, reason: string): ProposedChange {
  const curKm = current.target_distance_km || 0;
  const newKm = Math.max(6, curKm + deltaKm);
  // Roughly 6 min/km for easy Z2
  const newMin = Math.round(newKm * 6);
  return {
    id: newChangeId(),
    day_of_week: current.day_of_week,
    action: "adjust_long_run",
    params: { delta_km: deltaKm },
    reason_sv: reason,
    current_workout: current,
    proposed_workout: {
      activity_type: "Löpning",
      label: current.label || "Långpass Z2",
      description: `${newKm} km lugn Z2 (pratstempo). Ska kännas kontrollerat hela vägen.`,
      target_duration_minutes: newMin,
      target_distance_km: newKm,
      intensity_zone: "Z2",
      is_rest: false,
    },
  };
}

function buildFlattenLongRun(current: PlanWorkout, reason: string): ProposedChange {
  const km = current.target_distance_km || 12;
  const min = current.target_duration_minutes || Math.round(km * 6);
  return {
    id: newChangeId(),
    day_of_week: current.day_of_week,
    action: "flatten_long_run",
    params: {},
    reason_sv: reason,
    current_workout: current,
    proposed_workout: {
      activity_type: "Löpning",
      label: current.label || "Långpass Z2",
      description: `${km} km helt platt i Z2 — ingen progressiv finish den här gången. Fokus: kontrollerad distans.`,
      target_duration_minutes: min,
      target_distance_km: km,
      intensity_zone: "Z2",
      is_rest: false,
    },
  };
}

function buildAddRest(current: PlanWorkout, reason: string): ProposedChange {
  return {
    id: newChangeId(),
    day_of_week: current.day_of_week,
    action: "add_rest",
    params: {},
    reason_sv: reason,
    current_workout: current,
    proposed_workout: {
      activity_type: "Vila",
      label: "Vila",
      description: null,
      target_duration_minutes: 0,
      target_distance_km: null,
      intensity_zone: null,
      is_rest: true,
    },
  };
}

// ── Hard-constraint validator ───────────────────────────────────────────────

/**
 * Enforce the plan's hard constraints:
 *  - Max 2 changes total (excluding move_session).
 *  - Weekly volume delta ≤ ±15%.
 *  - Polarization: ≥ 1 easy day, ≤ 2 quality days.
 *  - Never introduce Z3.
 */
function validateChanges(changes: ProposedChange[], week: PlanWorkout[]): ProposedChange[] {
  // Drop Z3 introductions outright.
  let filtered = changes.filter((c) => c.proposed_workout?.intensity_zone !== "Z3");

  // Cap non-move changes at 2.
  let realCount = 0;
  filtered = filtered.filter((c) => {
    if (c.action === "move_session") return true;
    realCount++;
    return realCount <= 2;
  });

  // Simulate the applied week and check volume / polarization.
  const simulated = applyChangesToWeek(week, filtered);
  const originalMin = weekTargetMinutes(week);
  const newMin = weekTargetMinutes(simulated);
  if (originalMin > 0 && Math.abs(newMin - originalMin) / originalMin > 0.15) {
    // Too big a swing — drop lowest-priority changes (last first) until within bounds.
    while (filtered.length > 0) {
      const trial = filtered.slice(0, -1);
      const trialWeek = applyChangesToWeek(week, trial);
      const trialMin = weekTargetMinutes(trialWeek);
      if (originalMin === 0 || Math.abs(trialMin - originalMin) / originalMin <= 0.15) {
        filtered = trial;
        break;
      }
      filtered = trial;
    }
  }

  const finalWeek = applyChangesToWeek(week, filtered);
  // Polarization guardrails
  if (countEasyDays(finalWeek) === 0) {
    // Undo any swap_to_quality that eliminated the last easy day.
    filtered = filtered.filter((c) => c.action !== "swap_to_quality");
  }
  if (countQualityDays(applyChangesToWeek(week, filtered)) > 2) {
    filtered = filtered.filter((c) => c.action !== "swap_to_quality");
  }

  return filtered;
}

function applyChangesToWeek(week: PlanWorkout[], changes: ProposedChange[]): PlanWorkout[] {
  const out = week.map((w) => ({ ...w }));
  for (const c of changes) {
    if (c.action === "move_session") {
      const from = out.find((w) => w.day_of_week === c.from_day);
      const to = out.find((w) => w.day_of_week === c.to_day);
      if (from && to) {
        const fromCopy = { ...from };
        Object.assign(from, {
          ...to,
          day_of_week: from.day_of_week,
          workout_date: from.workout_date,
        });
        Object.assign(to, {
          ...fromCopy,
          day_of_week: to.day_of_week,
          workout_date: to.workout_date,
        });
      }
      continue;
    }
    const target = out.find((w) => w.day_of_week === c.day_of_week);
    if (!target || !c.proposed_workout) continue;
    Object.assign(target, c.proposed_workout);
  }
  return out;
}

// ── Coach note composer (templated for Slice 1) ─────────────────────────────

function composeCoachNote(feel: number, injury: string, changes: ProposedChange[]): string {
  const moves = changes.filter((c) => c.action !== "move_session").length;
  const header =
    injury === "pain" ? "Ta det lugnt den här veckan — vi lättar lite så du släpper krämpan." :
    feel <= 2 ? "Du lät sliten. " :
    feel === 3 ? "Stabil vecka. " :
    feel === 4 ? "Fin vecka! " :
    feel === 5 ? "Superkänsla! " : "";

  if (moves === 0 && changes.length > 0) {
    return header + "Jag har bara flyttat pass för att möta dina upptagna dagar — resten hälsar dig nästa vecka.";
  }
  if (moves === 1) {
    return header + "Jag gör en liten justering nästa vecka baserat på hur det här kändes.";
  }
  if (moves >= 2) {
    return header + "Två små tweaks så nästa vecka matchar hur du mår just nu.";
  }
  return header;
}

function composeNoChangeNote(feel: number, injury: string): string {
  if (injury === "pain" || injury === "niggle") {
    return "Håll koll på krämpan. Om det inte släpper, hör av dig innan nästa kvalitetspass.";
  }
  if (feel >= 4) return "Fin vecka! Inget att ändra — kör på som planerat nästa vecka.";
  if (feel === 3) return "Stabilt. Kör schemat som det ligger, så bygger vi vidare.";
  return "Inget akut att ändra den här gången — kör på och se hur veckan känns.";
}

// ────────────────────────────────────────────────────────────────────────────
//  Objective summary builder
// ────────────────────────────────────────────────────────────────────────────

async function buildObjectiveSummary(
  db: SupabaseClient,
  profileId: string,
  userMaxHr: number | null,
  planId: string | null,
  weekStart: Date,
  weekNotYetClosed: boolean,
): Promise<ObjectiveSummary> {
  const weekStartISO = isoDate(weekStart);
  const weekEnd = addDays(weekStart, 6);
  const nextWeekStart = addDays(weekStart, 7);
  const nextWeekEnd = addDays(nextWeekStart, 6);

  // Fetch plan_workouts for review and next week (by date, via plan_id).
  let reviewPlanWorkouts: PlanWorkout[] = [];
  let nextPlanWorkouts: PlanWorkout[] = [];
  let nextPhase: string | null = null;

  if (planId) {
    const { data: weeks } = await db.from("plan_weeks").select("id, week_number, phase").eq("plan_id", planId);
    const weekIds = (weeks || []).map((w: { id: string }) => w.id);
    if (weekIds.length > 0) {
      const { data: allWos } = await db.from("plan_workouts")
        .select("*")
        .in("plan_week_id", weekIds)
        .gte("workout_date", weekStartISO)
        .lte("workout_date", isoDate(nextWeekEnd))
        .order("workout_date", { ascending: true });
      for (const w of (allWos || []) as PlanWorkout[]) {
        if (w.workout_date >= weekStartISO && w.workout_date <= isoDate(weekEnd)) {
          reviewPlanWorkouts.push(w);
        } else if (w.workout_date >= isoDate(nextWeekStart) && w.workout_date <= isoDate(nextWeekEnd)) {
          nextPlanWorkouts.push(w);
        }
      }
      // next-week phase: find the plan_week that contains nextWeekStart
      for (const w of (allWos || []) as PlanWorkout[]) {
        if (w.workout_date >= isoDate(nextWeekStart) && w.workout_date <= isoDate(nextWeekEnd)) {
          const match = (weeks || []).find((pw: { id: string }) => pw.id === w.plan_week_id);
          if (match) nextPhase = (match as { phase: string }).phase;
          break;
        }
      }
    }
  }

  // Sort by day_of_week
  nextPlanWorkouts.sort((a, b) => a.day_of_week - b.day_of_week);
  reviewPlanWorkouts.sort((a, b) => a.day_of_week - b.day_of_week);

  // Fetch logged workouts for the review week and the prior 4 weeks for load baseline.
  const priorStart = addDays(weekStart, -28);
  const { data: logged } = await db.from("workouts")
    .select("id, workout_date, activity_type, duration_minutes, intensity, distance_km, avg_hr, max_hr")
    .eq("profile_id", profileId)
    .gte("workout_date", isoDate(priorStart))
    .lte("workout_date", isoDate(weekEnd))
    .order("workout_date", { ascending: true });

  const loggedAll = (logged || []) as LoggedWorkout[];
  const reviewLogged = loggedAll.filter((w) => w.workout_date >= weekStartISO && w.workout_date <= isoDate(weekEnd));
  const priorLogged = loggedAll.filter((w) => w.workout_date >= isoDate(priorStart) && w.workout_date < weekStartISO);

  const plannedSessions = reviewPlanWorkouts.filter((w) => !w.is_rest).length;
  const loggedSessions = reviewLogged.length;
  const completionRate = plannedSessions > 0 ? loggedSessions / plannedSessions : 0;

  const weeklyLoad = reviewLogged.reduce((s, w) => s + estimateLoad(w, userMaxHr), 0);
  const prior4Load = priorLogged.reduce((s, w) => s + estimateLoad(w, userMaxHr), 0);
  const prior4Avg = prior4Load / 4;
  const acwr = prior4Avg > 0 ? weeklyLoad / prior4Avg : 1.0;

  // Easy-day HR drift: avg HR on Z1/Z2 runs
  const easyHRs = reviewLogged
    .filter((w) => w.activity_type === "Löpning" && ["Z1", "Z2"].includes(w.intensity || "") && w.avg_hr)
    .map((w) => w.avg_hr as number);
  const priorEasyHRs = priorLogged
    .filter((w) => w.activity_type === "Löpning" && ["Z1", "Z2"].includes(w.intensity || "") && w.avg_hr)
    .map((w) => w.avg_hr as number);
  const easyAvgHr = easyHRs.length > 0 ? Math.round(easyHRs.reduce((a, b) => a + b, 0) / easyHRs.length) : null;
  const priorEasyAvgHr = priorEasyHRs.length > 0 ? Math.round(priorEasyHRs.reduce((a, b) => a + b, 0) / priorEasyHRs.length) : null;

  // Missed sessions: planned non-rest days with no logged workout on that date
  const loggedDates = new Set(reviewLogged.map((w) => w.workout_date));
  const missed = reviewPlanWorkouts
    .filter((w) => !w.is_rest && !loggedDates.has(w.workout_date))
    .map((w) => ({ date: w.workout_date, label: w.label }));

  return {
    week_start: weekStartISO,
    week_not_yet_closed: weekNotYetClosed,
    planned_sessions: plannedSessions,
    logged_sessions: loggedSessions,
    completion_rate: Math.round(completionRate * 100) / 100,
    weekly_load: Math.round(weeklyLoad),
    prior_4wk_avg_load: Math.round(prior4Avg),
    acwr: Math.round(acwr * 100) / 100,
    acwr_band: acwrBand(acwr),
    easy_avg_hr: easyAvgHr,
    easy_avg_hr_prior_4wk: priorEasyAvgHr,
    missed_sessions: missed,
    next_week_phase: nextPhase,
    next_week_plan: nextPlanWorkouts,
  };
}

// ────────────────────────────────────────────────────────────────────────────
//  Optional LLM coach (Slice 2) — wraps the rule engine's output
// ────────────────────────────────────────────────────────────────────────────

const COACH_SYSTEM_PROMPT = `You are a conservative, warm endurance-running coach (Nils van der Poel polarized school). Your job is to write a short weekly coach note IN SWEDISH based on the user's answers, the objective week summary, and the proposed changes the rule engine already produced.

Output STRICT JSON only: { "coach_note": "2-3 sentences, Swedish, warm but direct", "refined_reasons": [{"id": "<change_id>", "reason_sv": "one short Swedish sentence"}] }

Rules:
- Do NOT propose new changes. Do NOT remove changes. Only rewrite the coach_note and optionally refine each change's reason_sv to sound more like a human coach.
- Tone: warm, plain-spoken, Swedish, no hype, no emoji unless the user's feel score is 5.
- Never override the rule engine's decisions. If you disagree, say so in the coach_note; do not silently change them.
- Reference the user's actual answers (feel score, injury, long run) when relevant.`;

async function refineWithLLM(
  responses: CheckinResponses,
  summary: ObjectiveSummary,
  baseOutput: EngineOutput,
): Promise<EngineOutput> {
  if (!OPENAI_API_KEY || baseOutput.changes.length === 0 && !responses.free_text) {
    return baseOutput;
  }
  try {
    const userMsg = `User answers:\n${JSON.stringify(responses)}\n\nObjective summary:\n${JSON.stringify({
      weekly_load: summary.weekly_load,
      prior_4wk_avg_load: summary.prior_4wk_avg_load,
      acwr: summary.acwr,
      acwr_band: summary.acwr_band,
      completion_rate: summary.completion_rate,
      easy_avg_hr: summary.easy_avg_hr,
      easy_avg_hr_prior_4wk: summary.easy_avg_hr_prior_4wk,
      missed_sessions: summary.missed_sessions,
      next_week_phase: summary.next_week_phase,
    })}\n\nProposed changes (DO NOT MODIFY, only refine reasons and write coach_note):\n${JSON.stringify(baseOutput.changes.map((c) => ({
      id: c.id,
      day: dayName(c.day_of_week),
      action: c.action,
      current: c.current_workout?.label,
      proposed: c.proposed_workout?.label,
      default_reason_sv: c.reason_sv,
    })))}\n\nReturn { coach_note, refined_reasons: [...] } as strict JSON.`;

    const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        response_format: { type: "json_object" },
        temperature: 0.5,
        messages: [
          { role: "system", content: COACH_SYSTEM_PROMPT },
          { role: "user", content: userMsg },
        ],
      }),
    });
    if (!res.ok) return baseOutput;
    const data = await res.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || "{}");
    if (typeof parsed.coach_note === "string" && parsed.coach_note.trim()) {
      baseOutput.coach_note = parsed.coach_note.trim();
    }
    if (Array.isArray(parsed.refined_reasons)) {
      const byId = new Map(baseOutput.changes.map((c) => [c.id, c]));
      for (const r of parsed.refined_reasons) {
        if (r && typeof r.id === "string" && typeof r.reason_sv === "string") {
          const c = byId.get(r.id);
          if (c) c.reason_sv = r.reason_sv.trim() || c.reason_sv;
        }
      }
    }
    return baseOutput;
  } catch (_e) {
    // LLM is best-effort; never block the check-in if it fails.
    return baseOutput;
  }
}

// ────────────────────────────────────────────────────────────────────────────
//  Apply mode — mutate plan_workouts
// ────────────────────────────────────────────────────────────────────────────

async function applyChanges(
  db: SupabaseClient,
  nextWeekPlan: PlanWorkout[],
  accepted: ProposedChange[],
): Promise<void> {
  // Apply each change in order. For move_session, we swap activity_type/label/description
  // between the two plan_workouts rows (keep each row's date + day_of_week).
  const byDay = new Map(nextWeekPlan.map((w) => [w.day_of_week, w]));

  for (const c of accepted) {
    if (c.action === "move_session") {
      const from = byDay.get(c.from_day as number);
      const to = byDay.get(c.to_day as number);
      if (!from || !to) continue;
      const fromBody = pickWorkoutBody(from);
      const toBody = pickWorkoutBody(to);
      await db.from("plan_workouts").update(toBody).eq("id", from.id);
      await db.from("plan_workouts").update(fromBody).eq("id", to.id);
      // Swap local refs so subsequent changes see the new state.
      Object.assign(from, toBody);
      Object.assign(to, fromBody);
      continue;
    }
    const target = byDay.get(c.day_of_week);
    if (!target || !c.proposed_workout) continue;
    await db.from("plan_workouts").update(c.proposed_workout).eq("id", target.id);
    Object.assign(target, c.proposed_workout);
  }
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

// ────────────────────────────────────────────────────────────────────────────
//  Main handler
// ────────────────────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) return json(401, { error: "No auth header" });
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return json(401, { error: "Invalid token" });

    const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Resolve caller's profile once.
    const { data: profile } = await db.from("profiles")
      .select("id, user_max_hr")
      .eq("user_id", user.id)
      .single();
    if (!profile) return json(404, { error: "Profile not found" });
    const profileId: string = profile.id;
    const userMaxHr: number | null = profile.user_max_hr ?? null;

    const body = await req.json();
    const mode: string = body?.mode || "propose";

    // ─────────────── DECLINE ───────────────
    if (mode === "decline") {
      const { checkin_id } = body as { checkin_id?: string };
      if (!checkin_id) return json(400, { error: "Missing checkin_id" });
      const { data: row } = await db.from("weekly_checkins")
        .select("id, profile_id, status")
        .eq("id", checkin_id)
        .single();
      if (!row || row.profile_id !== profileId) return json(404, { error: "Check-in not found" });
      if (row.status !== "pending") return json(409, { error: `Check-in is ${row.status}` });
      await db.from("weekly_checkins")
        .update({ status: "declined", applied_at: new Date().toISOString() })
        .eq("id", checkin_id);
      return json(200, { ok: true });
    }

    // ─────────────── APPLY ───────────────
    if (mode === "apply") {
      const { checkin_id, accepted_change_ids } = body as {
        checkin_id?: string;
        accepted_change_ids?: string[];
      };
      if (!checkin_id) return json(400, { error: "Missing checkin_id" });
      const accepted = accepted_change_ids || [];
      const { data: row } = await db.from("weekly_checkins")
        .select("id, profile_id, status, proposed_changes, objective_summary, plan_id, week_start_date")
        .eq("id", checkin_id)
        .single();
      if (!row || row.profile_id !== profileId) return json(404, { error: "Check-in not found" });
      if (row.status !== "pending") return json(409, { error: `Check-in is ${row.status}` });

      const proposed = (row.proposed_changes || []) as ProposedChange[];
      const toApply = proposed.filter((c) => accepted.includes(c.id));

      const nextWeekPlan = ((row.objective_summary || {}) as ObjectiveSummary).next_week_plan || [];
      // Re-fetch the current plan_workouts from DB (to guard against stale snapshot).
      if (nextWeekPlan.length > 0) {
        const ids = nextWeekPlan.map((w) => w.id);
        const { data: fresh } = await db.from("plan_workouts").select("*").in("id", ids);
        if (fresh) {
          await applyChanges(db, fresh as PlanWorkout[], toApply);
        }
      }

      await db.from("weekly_checkins").update({
        status: "applied",
        applied_changes: toApply.map((c) => c.id),
        applied_at: new Date().toISOString(),
      }).eq("id", checkin_id);

      return json(200, { ok: true, applied: toApply.length });
    }

    // ─────────────── PROPOSE ───────────────
    const responses = (body?.responses || {}) as CheckinResponses;
    if (typeof responses.overall_feel !== "number" || !responses.injury_level) {
      return json(400, { error: "responses.overall_feel and responses.injury_level are required" });
    }

    const now = new Date();
    const { weekStart, weekNotYetClosed } = reviewWeekStart(now);
    const weekStartISO = isoDate(weekStart);

    // Guard against duplicate check-in for the same ISO week.
    const { data: existing } = await db.from("weekly_checkins")
      .select("id, status")
      .eq("profile_id", profileId)
      .eq("week_start_date", weekStartISO)
      .maybeSingle();
    if (existing && existing.status === "pending") {
      return json(409, { error: "A pending check-in already exists for this week", checkin_id: existing.id });
    }
    if (existing && existing.status === "applied") {
      return json(409, { error: "You already completed this week's check-in", checkin_id: existing.id });
    }

    // Resolve active plan (if any).
    const { data: plan } = await db.from("training_plans")
      .select("id")
      .eq("profile_id", profileId)
      .eq("status", "active")
      .maybeSingle();
    const planId: string | null = plan?.id ?? null;

    if (!planId) {
      return json(400, {
        error: "Veckoavstämning kräver en aktiv AI-plan. Skapa en plan först.",
        code: "no_active_plan",
      });
    }

    const summary = await buildObjectiveSummary(db, profileId, userMaxHr, planId, weekStart, weekNotYetClosed);

    if (summary.next_week_plan.length === 0) {
      return json(400, {
        error: "Hittade inga pass för nästa vecka i din plan.",
        code: "no_next_week",
      });
    }

    const engineOutput = runDecisionEngine({ responses, summary });
    const refined = await refineWithLLM(responses, summary, engineOutput);

    // Insert pending row.
    const { data: inserted, error: insErr } = await db.from("weekly_checkins").insert({
      profile_id: profileId,
      plan_id: planId,
      week_start_date: weekStartISO,
      responses,
      objective_summary: summary,
      proposed_changes: refined.changes,
      coach_note: refined.coach_note,
      status: "pending",
    }).select("id").single();

    if (insErr) {
      console.error("weekly-checkin: insert failed", insErr);
      return json(500, { error: "db_insert_failed" });
    }

    return json(200, {
      checkin_id: inserted.id,
      coach_note: refined.coach_note,
      changes: refined.changes,
      summary: {
        week_start: summary.week_start,
        week_not_yet_closed: summary.week_not_yet_closed,
        completion_rate: summary.completion_rate,
        acwr: summary.acwr,
        acwr_band: summary.acwr_band,
        missed_sessions: summary.missed_sessions,
        next_week_phase: summary.next_week_phase,
      },
      next_week_plan: summary.next_week_plan,
    });
  } catch (err) {
    // SECURITY (assessment H4): never leak err.message to the client.
    console.error("weekly-checkin error:", err);
    return json(500, { error: "internal_error" });
  }
});
