// Shared check-in / decision-engine module.
//
// Extracted from site/supabase/functions/weekly-checkin/index.ts so that the
// coach-chat function can reuse exactly the same rule engine, validator and
// plan-mutation logic without duplicating it.
//
// All exports are pure / DB-driven helpers — no HTTP, no auth. Callers are
// responsible for resolving the profile and building a Supabase client.

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// ────────────────────────────────────────────────────────────────────────────
//  Types
// ────────────────────────────────────────────────────────────────────────────

export interface PlanWorkout {
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

export interface LoggedWorkout {
  id: string;
  workout_date: string;
  activity_type: string;
  duration_minutes: number;
  intensity: string | null;
  distance_km: number | null;
  avg_hr: number | null;
  max_hr: number | null;
}

export interface CheckinResponses {
  overall_feel: number; // 1-5
  injury_level: "none" | "niggle" | "pain" | "paused";
  injury_note?: string;
  injury_side?: "left" | "right" | "both" | null;
  hardest_session_feel?: "too_hard" | "just_right" | "had_more" | null;
  long_run_feel?: "good" | "tough_end" | "cut_short" | "skipped" | null;
  unavailable_days?: number[];
  next_week_context?: string;
  free_text?: string;
}

export interface ProposedChange {
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

export interface ObjectiveSummary {
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

export interface EngineInput {
  responses: CheckinResponses;
  summary: ObjectiveSummary;
}

export interface EngineOutput {
  coach_note: string;
  changes: ProposedChange[];
}

// ────────────────────────────────────────────────────────────────────────────
//  Date helpers
// ────────────────────────────────────────────────────────────────────────────

export function isoDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

export function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

export function mondayOf(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  const dow = (out.getDay() + 6) % 7;
  out.setDate(out.getDate() - dow);
  return out;
}

export function reviewWeekStart(now: Date): { weekStart: Date; weekNotYetClosed: boolean } {
  const dow = (now.getDay() + 6) % 7;
  if (dow === 6) return { weekStart: mondayOf(now), weekNotYetClosed: true };
  const prevMon = mondayOf(addDays(now, -7));
  return { weekStart: prevMon, weekNotYetClosed: false };
}

export function dayName(d: number): string {
  return ["måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag", "söndag"][d] || `dag ${d}`;
}

// ────────────────────────────────────────────────────────────────────────────
//  Load estimation (same constants as ALGORITHM.md spec; range [0.7, 1.5])
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

export function estimateLoad(w: LoggedWorkout, userMaxHr: number | null): number {
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

export function acwrBand(acwr: number): "under" | "sweet" | "caution" | "danger" {
  if (acwr > 1.5) return "danger";
  if (acwr > 1.3) return "caution";
  if (acwr < 0.8) return "under";
  return "sweet";
}

// ────────────────────────────────────────────────────────────────────────────
//  Plan classification helpers
// ────────────────────────────────────────────────────────────────────────────

export const QUALITY_LABEL_REGEX = /tröskel|tempo|vo2|interval|fartlek|kvalitet/i;
export const LONG_RUN_LABEL_REGEX = /långpass|long run/i;

export function isQualityWorkout(w: PlanWorkout): boolean {
  if (w.is_rest) return false;
  if (w.intensity_zone && ["Z4", "Z5", "mixed"].includes(w.intensity_zone)) return true;
  if (w.label && QUALITY_LABEL_REGEX.test(w.label)) return true;
  return false;
}

export function isLongRun(w: PlanWorkout, allRunning: PlanWorkout[]): boolean {
  if (w.is_rest || w.activity_type !== "Löpning") return false;
  if (w.label && LONG_RUN_LABEL_REGEX.test(w.label)) return true;
  const byDuration = [...allRunning].sort((a, b) =>
    (b.target_duration_minutes || 0) - (a.target_duration_minutes || 0),
  );
  return (
    byDuration[0]?.id === w.id &&
    (w.target_duration_minutes || 0) >= 60
  );
}

export function isEasyRun(w: PlanWorkout): boolean {
  if (w.is_rest || w.activity_type !== "Löpning") return false;
  if (isQualityWorkout(w)) return false;
  if (w.intensity_zone && ["Z1", "Z2"].includes(w.intensity_zone)) return true;
  if (w.label && /lätt|distans|recovery|jogg/i.test(w.label)) return true;
  return false;
}

export function countEasyDays(week: PlanWorkout[]): number {
  return week.filter((w) => !w.is_rest && !isQualityWorkout(w)).length;
}

export function countQualityDays(week: PlanWorkout[]): number {
  return week.filter(isQualityWorkout).length;
}

export function weekTargetMinutes(week: PlanWorkout[]): number {
  return week.reduce((s, w) => s + (w.target_duration_minutes || 0), 0);
}

// ────────────────────────────────────────────────────────────────────────────
//  Decision engine
// ────────────────────────────────────────────────────────────────────────────

function newChangeId(): string {
  return crypto.randomUUID();
}

export function runDecisionEngine(input: EngineInput): EngineOutput {
  const { responses, summary } = input;
  const next = summary.next_week_plan;
  const changes: ProposedChange[] = [];
  const notes: string[] = [];

  if (responses.injury_level === "paused") {
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

  const unavailable = new Set((responses.unavailable_days || []).filter((d) => d >= 0 && d <= 6));
  if (unavailable.size > 0) {
    const restDays = next.filter((w) => w.is_rest && !unavailable.has(w.day_of_week)).map((w) => w.day_of_week);
    const freeDays = next.filter((w) => !w.is_rest && !unavailable.has(w.day_of_week)).map((w) => w.day_of_week);
    for (const d of unavailable) {
      const session = next.find((w) => w.day_of_week === d);
      if (!session || session.is_rest) continue;
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

  const feel = responses.overall_feel;
  const hardestFeel = responses.hardest_session_feel;
  const longRunFeel = responses.long_run_feel;
  const injury = responses.injury_level;
  const acwr = summary.acwr;

  const allRunning = next.filter((w) => w.activity_type === "Löpning" && !w.is_rest);
  const qualityDays = next.filter(isQualityWorkout);
  const longRunDay = next.find((w) => isLongRun(w, allRunning)) || null;
  const easyDays = next.filter(isEasyRun);

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

  const conservativeOnly = injury === "pain" || injury === "niggle";

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

  if (feel <= 1) {
    const q = qualityDays[0];
    if (q) addChange(buildSwapToEasy(q, "Du var helt slut — vi gör kvalitetspasset till en lugn jogg så du laddar om"));
    const extra = easyDays.find((w) => !changes.some((c) => c.current_workout?.id === w.id));
    if (extra) addChange(buildAddRest(extra, "Extra vilodag för att återhämta efter en tuff vecka"));
  } else if (feel === 2) {
    if (acwr > 1.2 && qualityDays[0] && !changes.some((c) => c.current_workout?.id === qualityDays[0].id)) {
      addChange(buildSwapToEasy(qualityDays[0], "Tungt vecka och hög belastning — kvalitetspasset blir lugnt nästa vecka"));
    } else if (longRunDay && !changes.some((c) => c.current_workout?.id === longRunDay.id)) {
      addChange(buildFlattenLongRun(longRunDay, "Lite tungt — vi plattar ut långpasset utan att dra ner distansen"));
    }
  } else if (feel === 4) {
    if (hardestFeel === "had_more" && injury === "none" && acwr < 1.2) {
      const easy = easyDays.find((w) => !changes.some((c) => c.current_workout?.id === w.id));
      if (easy) addChange(buildSwapToQuality(easy, "Du hade mer att ge — vi lägger in ett extra kvalitetspass nästa vecka"));
      else if (canAdjustLongRun(+1) && longRunDay) {
        addChange(buildAdjustLongRun(longRunDay, +1, "Du hade mer att ge — vi adderar 1 km på långpasset"));
      }
    }
  } else if (feel === 5) {
    if (injury === "none" && acwr < 1.2) {
      if (longRunDay && canAdjustLongRun(+2)) {
        addChange(buildAdjustLongRun(longRunDay, +2, "Superkänsla — 2 km extra på långpasset och vi håller resten som planerat"));
      } else {
        const easy = easyDays.find((w) => !changes.some((c) => c.current_workout?.id === w.id));
        if (easy) addChange(buildSwapToQuality(easy, "Superkänsla — extra kvalitetspass nästa vecka"));
      }
    }
  }

  if (hardestFeel === "too_hard" && qualityDays[0] && budget > 0 && !changes.some((c) => c.current_workout?.id === qualityDays[0].id)) {
    addChange(buildSwapToEasy(qualityDays[0], "Kvalitetspasset blev för tungt — vi gör nästa veckas version lugnare"));
  }

  if (conservativeOnly && changes.length === 0 && qualityDays[0]) {
    addChange(buildSwapToEasy(qualityDays[0], "Du kände av lite — vi lättar på kvalitetspasset tills det släpper"));
  }

  const validated = validateChanges(changes, next);
  const note = validated.length === 0
    ? composeNoChangeNote(feel, injury)
    : composeCoachNote(feel, injury, validated);

  return { coach_note: note, changes: validated };
}

// ── Change builders ─────────────────────────────────────────────────────────

export function buildSwapToEasy(current: PlanWorkout, reason: string): ProposedChange {
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

export function buildSwapToQuality(current: PlanWorkout, reason: string): ProposedChange {
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

export function buildAdjustLongRun(current: PlanWorkout, deltaKm: number, reason: string): ProposedChange {
  const curKm = current.target_distance_km || 0;
  const newKm = Math.max(6, curKm + deltaKm);
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

export function buildFlattenLongRun(current: PlanWorkout, reason: string): ProposedChange {
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

export function buildAddRest(current: PlanWorkout, reason: string): ProposedChange {
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

export function validateChanges(changes: ProposedChange[], week: PlanWorkout[]): ProposedChange[] {
  let filtered = changes.filter((c) => c.proposed_workout?.intensity_zone !== "Z3");

  let realCount = 0;
  filtered = filtered.filter((c) => {
    if (c.action === "move_session") return true;
    realCount++;
    return realCount <= 2;
  });

  const simulated = applyChangesToWeek(week, filtered);
  const originalMin = weekTargetMinutes(week);
  const newMin = weekTargetMinutes(simulated);
  if (originalMin > 0 && Math.abs(newMin - originalMin) / originalMin > 0.15) {
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

  if (countEasyDays(applyChangesToWeek(week, filtered)) === 0) {
    filtered = filtered.filter((c) => c.action !== "swap_to_quality");
  }
  if (countQualityDays(applyChangesToWeek(week, filtered)) > 2) {
    filtered = filtered.filter((c) => c.action !== "swap_to_quality");
  }

  return filtered;
}

export function applyChangesToWeek(week: PlanWorkout[], changes: ProposedChange[]): PlanWorkout[] {
  const out = week.map((w) => ({ ...w }));
  for (const c of changes) {
    if (c.action === "move_session") {
      const from = out.find((w) => w.day_of_week === c.from_day);
      const to = out.find((w) => w.day_of_week === c.to_day);
      if (from && to) {
        const fromCopy = { ...from };
        Object.assign(from, { ...to, day_of_week: from.day_of_week, workout_date: from.workout_date });
        Object.assign(to, { ...fromCopy, day_of_week: to.day_of_week, workout_date: to.workout_date });
      }
      continue;
    }
    const target = out.find((w) => w.day_of_week === c.day_of_week);
    if (!target || !c.proposed_workout) continue;
    Object.assign(target, c.proposed_workout);
  }
  return out;
}

// ── Coach note composer ─────────────────────────────────────────────────────

export function composeCoachNote(feel: number, injury: string, changes: ProposedChange[]): string {
  const moves = changes.filter((c) => c.action !== "move_session").length;
  const header =
    injury === "pain" ? "Ta det lugnt den här veckan — vi lättar lite så du släpper krämpan." :
    feel <= 2 ? "Du lät sliten. " :
    feel === 3 ? "Stabil vecka. " :
    feel === 4 ? "Fin vecka! " :
    feel === 5 ? "Superkänsla! " : "";

  if (moves === 0 && changes.length > 0) return header + "Jag har bara flyttat pass för att möta dina upptagna dagar — resten hälsar dig nästa vecka.";
  if (moves === 1) return header + "Jag gör en liten justering nästa vecka baserat på hur det här kändes.";
  if (moves >= 2) return header + "Två små tweaks så nästa vecka matchar hur du mår just nu.";
  return header;
}

export function composeNoChangeNote(feel: number, injury: string): string {
  if (injury === "pain" || injury === "niggle") return "Håll koll på krämpan. Om det inte släpper, hör av dig innan nästa kvalitetspass.";
  if (feel >= 4) return "Fin vecka! Inget att ändra — kör på som planerat nästa vecka.";
  if (feel === 3) return "Stabilt. Kör schemat som det ligger, så bygger vi vidare.";
  return "Inget akut att ändra den här gången — kör på och se hur veckan känns.";
}

// ────────────────────────────────────────────────────────────────────────────
//  Objective summary
// ────────────────────────────────────────────────────────────────────────────

export async function buildObjectiveSummary(
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
      for (const w of (allWos || []) as PlanWorkout[]) {
        if (w.workout_date >= isoDate(nextWeekStart) && w.workout_date <= isoDate(nextWeekEnd)) {
          const match = (weeks || []).find((pw: { id: string }) => pw.id === w.plan_week_id);
          if (match) nextPhase = (match as { phase: string }).phase;
          break;
        }
      }
    }
  }

  nextPlanWorkouts.sort((a, b) => a.day_of_week - b.day_of_week);
  reviewPlanWorkouts.sort((a, b) => a.day_of_week - b.day_of_week);

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

  const easyHRs = reviewLogged
    .filter((w) => w.activity_type === "Löpning" && ["Z1", "Z2"].includes(w.intensity || "") && w.avg_hr)
    .map((w) => w.avg_hr as number);
  const priorEasyHRs = priorLogged
    .filter((w) => w.activity_type === "Löpning" && ["Z1", "Z2"].includes(w.intensity || "") && w.avg_hr)
    .map((w) => w.avg_hr as number);
  const easyAvgHr = easyHRs.length > 0 ? Math.round(easyHRs.reduce((a, b) => a + b, 0) / easyHRs.length) : null;
  const priorEasyAvgHr = priorEasyHRs.length > 0 ? Math.round(priorEasyHRs.reduce((a, b) => a + b, 0) / priorEasyHRs.length) : null;

  // Per-session missed detection — handles days with multiple planned
  // workouts (e.g. AM run + PM gym). For each non-rest plan_workout we
  // greedily pair it with a logged workout on the same date with matching
  // activity_type. Unpaired plan_workouts are missed.
  const remainingByDate = new Map<string, LoggedWorkout[]>();
  for (const w of reviewLogged) {
    if (!remainingByDate.has(w.workout_date)) remainingByDate.set(w.workout_date, []);
    remainingByDate.get(w.workout_date)!.push(w);
  }
  const missed: { date: string; label: string | null }[] = [];
  // Iterate sorted by sort_order so primary sessions match first.
  const sortedPlan = reviewPlanWorkouts
    .filter((w) => !w.is_rest)
    .slice()
    .sort((a, b) =>
      a.workout_date === b.workout_date
        ? (a.sort_order ?? 0) - (b.sort_order ?? 0)
        : a.workout_date.localeCompare(b.workout_date)
    );
  for (const pw of sortedPlan) {
    const pool = remainingByDate.get(pw.workout_date) || [];
    const idx = pool.findIndex((w) => (w.activity_type || "") === (pw.activity_type || ""));
    if (idx >= 0) {
      pool.splice(idx, 1);
    } else {
      missed.push({ date: pw.workout_date, label: pw.label });
    }
  }

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
//  Apply changes (mutates plan_workouts).
// ────────────────────────────────────────────────────────────────────────────

export function pickWorkoutBody(w: PlanWorkout) {
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

export async function applyChanges(
  db: SupabaseClient,
  nextWeekPlan: PlanWorkout[],
  accepted: ProposedChange[],
): Promise<void> {
  // Multi-pass-aware day index: each day_of_week maps to an array sorted by
  // sort_order. The decision-engine ProposedChange shape only references
  // day_of_week (not a specific plan_workout_id), so we always operate on the
  // PRIMARY (sort_order=0) entry. This preserves backward compat for
  // single-pass days and keeps the AI from accidentally mutating an
  // afternoon strength session when it intended to move the main run.
  const byDay = new Map<number, PlanWorkout[]>();
  for (const w of nextWeekPlan) {
    if (!byDay.has(w.day_of_week)) byDay.set(w.day_of_week, []);
    byDay.get(w.day_of_week)!.push(w);
  }
  for (const list of byDay.values()) list.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

  const primary = (dow: number): PlanWorkout | undefined => byDay.get(dow)?.[0];

  for (const c of accepted) {
    if (c.action === "move_session") {
      const from = primary(c.from_day as number);
      const to = primary(c.to_day as number);
      if (!from || !to) continue;
      const fromBody = pickWorkoutBody(from);
      const toBody = pickWorkoutBody(to);
      await db.from("plan_workouts").update(toBody).eq("id", from.id);
      await db.from("plan_workouts").update(fromBody).eq("id", to.id);
      Object.assign(from, toBody);
      Object.assign(to, fromBody);
      continue;
    }
    const target = primary(c.day_of_week);
    if (!target || !c.proposed_workout) continue;
    await db.from("plan_workouts").update(c.proposed_workout).eq("id", target.id);
    Object.assign(target, c.proposed_workout);
  }
}
