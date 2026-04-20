// Shared training-plan / weekly-template validation helpers.
//
// Why this exists: the LLM-backed plan generators (`generate-plan`,
// `weekly-template-ai`) tend to drift toward "all Z2" output unless we
// codify the polarized-training rules as hard constraints AND verify the
// returned JSON before we accept it. The system prompt says "1-2 quality
// sessions per week"; the model interprets the lower bound as zero.
//
// We treat any workout with intensity_zone in {Z4, Z5, mixed} as a
// "quality" session. Z3 is intentionally excluded — Nils van der Poel
// polarized model considers Z3 the dead zone (too hard to recover from,
// too easy to drive top-end adaptation).

export type Phase =
  | "base"
  | "build"
  | "peak"
  | "taper"
  | "deload"
  | "recovery";

export interface WeekWorkoutLite {
  intensity_zone: string | null;
  is_rest: boolean;
  description?: string | null;
  label?: string | null;
}

export interface WeekLite {
  week_number?: number;
  phase: string;
  workouts: WeekWorkoutLite[];
}

export interface WeekValidation {
  weekNumber: number;
  valid: boolean;
  issues: string[];
  expectedQualityCount: number;
  actualQualityCount: number;
}

export interface PlanValidation {
  valid: boolean;
  weekResults: WeekValidation[];
}

const QUALITY_ZONES = new Set(["Z4", "Z5", "MIXED"]);

// Minimum quality sessions per phase. These are HARD MIN values, not max.
// Base: 1 (threshold or fartlek). Build/peak: 2 (1× VO2max + 1× threshold).
// Deload/taper/recovery: 1 (kept short).
function expectedQualityForPhase(phase: string): number {
  const p = (phase || "").toLowerCase();
  if (p === "base") return 1;
  if (p === "build") return 2;
  if (p === "peak") return 2;
  if (p === "deload") return 1;
  if (p === "taper") return 1;
  if (p === "recovery") return 0;
  // Unknown phase — be conservative, require 1 quality session.
  return 1;
}

function normZone(z: string | null | undefined): string {
  return (z || "").trim().toUpperCase();
}

function isQuality(w: WeekWorkoutLite): boolean {
  if (w.is_rest) return false;
  const z = normZone(w.intensity_zone);
  // Accept both upper- and lowercase "mixed" since QUALITY_ZONES has it
  // capitalised after normZone.
  if (z === "MIXED") return true;
  return QUALITY_ZONES.has(z);
}

function isZ3(w: WeekWorkoutLite): boolean {
  return !w.is_rest && normZone(w.intensity_zone) === "Z3";
}

export function validateWeek(week: WeekLite): WeekValidation {
  const issues: string[] = [];
  const expected = expectedQualityForPhase(week.phase);
  const actual = week.workouts.filter(isQuality).length;

  if (actual < expected) {
    issues.push(
      `Phase "${week.phase}" requires at least ${expected} quality session(s) ` +
        `(intensity_zone Z4/Z5/mixed), but found ${actual}. Polarized training ` +
        `forbids all-Z2 weeks.`,
    );
  }

  // Z3 in base/deload phase violates the polarized model.
  const phaseLower = (week.phase || "").toLowerCase();
  if (phaseLower === "base" || phaseLower === "deload") {
    const z3Count = week.workouts.filter(isZ3).length;
    if (z3Count > 0) {
      issues.push(
        `Phase "${week.phase}" should have zero Z3 sessions (dead zone). ` +
          `Found ${z3Count}. Convert to either Z2 (easier) or Z4 (threshold).`,
      );
    }
  }

  // Quality sessions need specific structure in their description.
  // "Intervaller" alone or a 20-char description for a Z4/Z5 pass is too
  // vague — the user can't execute it.
  for (const w of week.workouts) {
    if (!isQuality(w)) continue;
    const desc = (w.description || "").trim();
    if (desc.length < 40) {
      issues.push(
        `Quality session "${w.label || "(no label)"}" has description ` +
          `under 40 chars — must specify reps × duration × zone × recovery.`,
      );
    }
  }

  return {
    weekNumber: week.week_number ?? 0,
    valid: issues.length === 0,
    issues,
    expectedQualityCount: expected,
    actualQualityCount: actual,
  };
}

export function validatePlan(weeks: WeekLite[]): PlanValidation {
  const weekResults = weeks.map((w) => validateWeek(w));
  return {
    valid: weekResults.every((r) => r.valid),
    weekResults,
  };
}

// Convert validation failures into a follow-up prompt that tells the model
// exactly which weeks to fix and why. We deliberately quote the phase + the
// expected quality count so the model can't argue with the requirement.
export function buildRetryMessage(planValidation: PlanValidation): string {
  const failed = planValidation.weekResults.filter((r) => !r.valid);
  if (failed.length === 0) return "";

  const lines = failed.map((r) => {
    const issueText = r.issues.map((i) => `  - ${i}`).join("\n");
    return `Week ${r.weekNumber} (expected ${r.expectedQualityCount} quality, got ${r.actualQualityCount}):\n${issueText}`;
  });

  return [
    "The previous plan failed validation. Fix the following weeks and ",
    "return the COMPLETE updated plan in the same JSON schema. Do NOT ",
    "remove other weeks. Do NOT downgrade quality sessions to Z2.\n\n",
    lines.join("\n\n"),
    "\n\nFor each failing week, replace one Z2 session with a Z4 threshold ",
    "session (4-6 × 5 min Z4, 2 min lugn jogg) or a Z5 VO2max session ",
    "(5 × 3 min Z5, 3 min vila). Include warm-up + cool-down in the ",
    "description. Never put two quality sessions on consecutive days.",
  ].join("");
}

// Equivalent for the weekly template (single 7-day pattern, no phases).
// Defaults to "build" expectations (2 quality sessions) unless caller
// specifies otherwise.
export function validateWeeklyTemplate(
  days: { is_rest: boolean; description?: string | null; label?: string | null }[],
  phase: string = "build",
): WeekValidation {
  // Map template days to the WeekLite shape. Templates don't carry an
  // explicit intensity_zone field, so we infer quality from the label /
  // description text.
  const workouts: WeekWorkoutLite[] = days.map((d) => {
    const text = `${d.label || ""} ${d.description || ""}`.toLowerCase();
    let zone: string | null = null;
    if (d.is_rest) {
      zone = null;
    } else if (/\bz5\b|vo2max|vo2|max-?intervall/.test(text)) {
      zone = "Z5";
    } else if (/\bz4\b|tr[öo]skel|tempo|threshold|fartlek/.test(text)) {
      zone = "Z4";
    } else if (/\bz3\b/.test(text)) {
      zone = "Z3";
    } else if (/\bz2\b|distans|l[åa]ngpass|long|easy|lugn|recovery/.test(text)) {
      zone = "Z2";
    } else if (/\bz1\b/.test(text)) {
      zone = "Z1";
    }
    return {
      intensity_zone: zone,
      is_rest: d.is_rest,
      description: d.description ?? null,
      label: d.label ?? null,
    };
  });
  return validateWeek({ week_number: 1, phase, workouts });
}

export function buildTemplateRetryMessage(v: WeekValidation): string {
  if (v.valid) return "";
  return [
    "The previous weekly template failed validation. Fix the issues below ",
    "and return the COMPLETE 7-day template as JSON. Do NOT downgrade ",
    "quality sessions to Z2.\n\n",
    v.issues.map((i) => `- ${i}`).join("\n"),
    "\n\nReplace one easy Z2 day with a Z4 threshold session (e.g. ",
    "'15 min uppvärm Z2 → 5×5 min Z4 (2 min lugn jogg) → 10 min nedvarvning') ",
    "or a Z5 VO2max session (e.g. '15 min uppvärm → 5×3 min Z5 (3 min vila) → 10 min nedvarvning'). ",
    "Place quality on Tisdag and Torsdag, never on consecutive days.",
  ].join("");
}
