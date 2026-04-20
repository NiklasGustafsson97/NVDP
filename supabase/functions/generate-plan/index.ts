import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ═══════════════════════════════════════════════════════════════════
//  PLAN VALIDATION HELPERS (inlined from _shared/plan-validation.ts
//  so this file can be deployed standalone via the Supabase dashboard.)
//
//  We treat any workout with intensity_zone in {Z4, Z5, mixed} as a
//  "quality" session. Z3 is intentionally excluded — Nils van der Poel
//  polarized model considers Z3 the dead zone.
// ═══════════════════════════════════════════════════════════════════

interface WeekWorkoutLite {
  intensity_zone: string | null;
  is_rest: boolean;
  description?: string | null;
  label?: string | null;
}

interface WeekLite {
  week_number?: number;
  phase: string;
  workouts: WeekWorkoutLite[];
}

interface WeekValidation {
  weekNumber: number;
  valid: boolean;
  issues: string[];
  expectedQualityCount: number;
  actualQualityCount: number;
}

interface PlanValidation {
  valid: boolean;
  weekResults: WeekValidation[];
}

const QUALITY_ZONES = new Set(["Z4", "Z5", "MIXED"]);

// Legacy default — used only if no CapacityProfile is supplied. Kept for
// safety but now every caller in this file passes a profile.
function defaultExpectedQualityForPhase(phase: string): number {
  const p = (phase || "").toLowerCase();
  if (p === "base") return 1;
  if (p === "build") return 2;
  if (p === "peak") return 2;
  if (p === "deload") return 1;
  if (p === "taper") return 1;
  if (p === "recovery") return 0;
  return 1;
}

function expectedQualityForPhase(phase: string, profile?: CapacityProfile): number {
  const p = (phase || "").toLowerCase() as Phase;
  if (profile && profile.qualityPerPhase[p] !== undefined) {
    return profile.qualityPerPhase[p];
  }
  return defaultExpectedQualityForPhase(phase);
}

function normZone(z: string | null | undefined): string {
  return (z || "").trim().toUpperCase();
}

function isQuality(w: WeekWorkoutLite): boolean {
  if (w.is_rest) return false;
  const z = normZone(w.intensity_zone);
  if (z === "MIXED") return true;
  return QUALITY_ZONES.has(z);
}

function isZ3(w: WeekWorkoutLite): boolean {
  return !w.is_rest && normZone(w.intensity_zone) === "Z3";
}

function validateWeek(week: WeekLite, profile?: CapacityProfile): WeekValidation {
  const issues: string[] = [];
  const expected = expectedQualityForPhase(week.phase, profile);
  const actual = week.workouts.filter(isQuality).length;

  if (actual < expected) {
    issues.push(
      `Phase "${week.phase}" requires at least ${expected} quality session(s) ` +
        `(intensity_zone Z4/Z5/mixed), but found ${actual}. Polarized training ` +
        `forbids all-Z2 weeks.`,
    );
  }

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

function validatePlan(weeks: WeekLite[], profile?: CapacityProfile): PlanValidation {
  const weekResults = weeks.map((w) => validateWeek(w, profile));
  return {
    valid: weekResults.every((r) => r.valid),
    weekResults,
  };
}

function buildRetryMessage(planValidation: PlanValidation): string {
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

// ═══════════════════════════════════════════════════════════════════
//  CAPACITY PROFILING + FEASIBILITY ASSESSMENT (inlined from
//  _shared/capacity.ts so this file deploys standalone via the Supabase
//  dashboard. See that file for full documentation.)
// ═══════════════════════════════════════════════════════════════════

type Phase = "base" | "build" | "peak" | "taper" | "deload" | "recovery";
type Tier = "novice" | "developing" | "intermediate" | "advanced";
type RiskLevel = "comfortable" | "ambitious" | "aggressive" | "unrealistic";
type Severity = "ok" | "warn" | "high";

interface CapacityInputs {
  baseline: {
    sessions_per_week: number;
    hours_per_week: number;
    longest_session_minutes: number;
    fitness_level: string;
    recent_5k?: string | null;
    recent_10k?: string | null;
    easy_pace?: string | null;
  };
  goal: { type: string; text: string; date?: string | null };
  start_date: string;
  weekly_session_cap: number;
}

interface CapacityProfile {
  tier: Tier;
  weeklyVolumeKm: number | null;
  qualityCapPerWeek: number;
  qualityPerPhase: Record<Phase, number>;
  rationale: string;
}

interface FeasibilityFactor {
  id: string;
  severity: Severity;
  text: string;
}

interface FeasibilityAssessment {
  riskLevel: RiskLevel;
  factors: FeasibilityFactor[];
  weeksToGoal: number | null;
  rampWarning: string | null;
  coachingNote: string;
  recommendedAdjustments: string[];
  projected?: {
    projected5kFromRecent: string | null;
    targetPaceFromGoal: string | null;
  };
}

function normalizeFitnessLevel(raw: string): Tier {
  const s = (raw || "").toLowerCase().trim();
  if (!s) return "developing";
  if (/nyb|beginner|novice|starta|ny\b/.test(s)) return "novice";
  if (/avanc|advanced|elite|expert|erfaren\s+tr[aä]nar/.test(s)) return "advanced";
  if (/intermediat|medel|mellan|regelbund|vana/.test(s)) return "intermediate";
  if (/developing|utveckling/.test(s)) return "developing";
  return "developing";
}

function tierFromInputs(i: CapacityInputs): Tier {
  const declared = normalizeFitnessLevel(i.baseline.fitness_level);
  const sessions = i.baseline.sessions_per_week || 0;
  const hours = i.baseline.hours_per_week || 0;
  let volumeTier: Tier;
  if (sessions < 3 || hours < 2.5) volumeTier = "novice";
  else if (sessions < 5 || hours < 4.5) volumeTier = "developing";
  else if (sessions < 6 || hours < 7) volumeTier = "intermediate";
  else volumeTier = "advanced";
  const order: Tier[] = ["novice", "developing", "intermediate", "advanced"];
  const minIdx = Math.min(order.indexOf(declared), order.indexOf(volumeTier));
  return order[minIdx];
}

const TIER_QUALITY_MATRIX: Record<Tier, Record<Phase, number>> = {
  novice:       { base: 0, build: 1, peak: 1, deload: 0, taper: 1, recovery: 0 },
  developing:   { base: 1, build: 2, peak: 2, deload: 1, taper: 1, recovery: 0 },
  intermediate: { base: 1, build: 2, peak: 3, deload: 1, taper: 2, recovery: 0 },
  advanced:     { base: 2, build: 3, peak: 3, deload: 1, taper: 2, recovery: 0 },
};

const TIER_QUALITY_CAP: Record<Tier, number> = {
  novice: 1, developing: 2, intermediate: 3, advanced: 3,
};

function estimateWeeklyVolumeKm(i: CapacityInputs): number | null {
  const hours = i.baseline.hours_per_week;
  if (!hours || hours <= 0) return null;
  const tier = tierFromInputs(i);
  const kmh = { novice: 8, developing: 9, intermediate: 10, advanced: 11 }[tier];
  return Math.round(hours * kmh);
}

function profileCapacity(i: CapacityInputs): CapacityProfile {
  const tier = tierFromInputs(i);
  const qualityPerPhase = { ...TIER_QUALITY_MATRIX[tier] };
  let qualityCapPerWeek = TIER_QUALITY_CAP[tier];
  const cap = i.weekly_session_cap || i.baseline.sessions_per_week || 3;
  const roomForQuality = Math.max(0, cap - 2);
  if (roomForQuality < qualityCapPerWeek) {
    qualityCapPerWeek = roomForQuality;
  }
  for (const p of Object.keys(qualityPerPhase) as Phase[]) {
    if (qualityPerPhase[p] > qualityCapPerWeek) qualityPerPhase[p] = qualityCapPerWeek;
  }
  const weeklyVolumeKm = estimateWeeklyVolumeKm(i);
  const rationale =
    `Tier "${tier}" baserat på ${i.baseline.sessions_per_week || 0} pass/v och ${i.baseline.hours_per_week || 0} tim/v ` +
    `(självskattad nivå: ${i.baseline.fitness_level || "ej angiven"}). Max ${qualityCapPerWeek} kvalitetspass/v.`;
  return { tier, weeklyVolumeKm, qualityCapPerWeek, qualityPerPhase, rationale };
}

interface GoalShape {
  distanceKm: number | null;
  kind: "race" | "fitness" | "other";
  peakWeeklyKm: number | null;
  minWeeks: { novice: number; developing: number; intermediate: number; advanced: number } | null;
  targetSeconds: number | null;
}

function parseGoalText(goalText: string, goalType: string): GoalShape {
  const t = (goalText || "").toLowerCase();
  const isMarathon = /marathon|maraton|42|42,?195/.test(t) && !/halv|half|21/.test(t);
  const isHalf = /halv|half|21(\.|,|\b)/.test(t) || /halvmaraton/.test(t);
  const is10k = /\b10 ?k\b|10 ?km|tiokm/.test(t);
  const is5k = /\b5 ?k\b|5 ?km|femkm/.test(t);
  let distanceKm: number | null = null;
  let peakWeeklyKm: number | null = null;
  let minWeeks: GoalShape["minWeeks"] = null;
  if (isMarathon)      { distanceKm = 42.195; peakWeeklyKm = 60; minWeeks = { novice: 20, developing: 16, intermediate: 14, advanced: 12 }; }
  else if (isHalf)     { distanceKm = 21.0975; peakWeeklyKm = 45; minWeeks = { novice: 14, developing: 12, intermediate: 10, advanced: 8 }; }
  else if (is10k)      { distanceKm = 10;     peakWeeklyKm = 35; minWeeks = { novice: 10, developing: 8,  intermediate: 8,  advanced: 6 }; }
  else if (is5k)       { distanceKm = 5;      peakWeeklyKm = 25; minWeeks = { novice: 8,  developing: 6,  intermediate: 6,  advanced: 4 }; }
  const kind: GoalShape["kind"] = (goalType || "").toLowerCase() === "race"
    ? "race"
    : distanceKm ? "race"
    : /form|h[aä]lsa|m[aå]|fitness|viktminskning|styrka/.test(t) ? "fitness"
    : "other";
  let targetSeconds: number | null = null;
  const timeMatch = t.match(/(\d+):(\d{1,2})(?::(\d{1,2}))?/);
  if (timeMatch) {
    const h = timeMatch[3] ? parseInt(timeMatch[1]) : 0;
    const m = timeMatch[3] ? parseInt(timeMatch[2]) : parseInt(timeMatch[1]);
    const s = timeMatch[3] ? parseInt(timeMatch[3]) : parseInt(timeMatch[2]);
    targetSeconds = h * 3600 + m * 60 + s;
  }
  return { distanceKm, kind, peakWeeklyKm, minWeeks, targetSeconds };
}

function parseHmsToSeconds(txt: string | null | undefined): number | null {
  if (!txt) return null;
  const m = txt.trim().match(/(\d+):(\d{1,2})(?::(\d{1,2}))?/);
  if (!m) return null;
  const h = m[3] ? parseInt(m[1]) : 0;
  const min = m[3] ? parseInt(m[2]) : parseInt(m[1]);
  const s = m[3] ? parseInt(m[3]) : parseInt(m[2]);
  return h * 3600 + min * 60 + s;
}

function formatSeconds(total: number): string {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.round(total % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function riegelProject(t1Sec: number, d1Km: number, d2Km: number): number {
  return t1Sec * Math.pow(d2Km / d1Km, 1.06);
}

function weeksBetween(startDate: string, goalDate: string): number | null {
  try {
    const ms = new Date(goalDate).getTime() - new Date(startDate).getTime();
    if (isNaN(ms)) return null;
    return Math.max(1, Math.round(ms / (7 * 86400000)));
  } catch {
    return null;
  }
}

function assessFeasibility(i: CapacityInputs, p: CapacityProfile): FeasibilityAssessment {
  const factors: FeasibilityFactor[] = [];
  const adjustments: string[] = [];
  const goal = parseGoalText(i.goal.text, i.goal.type);
  const weeksToGoal = i.goal.date ? weeksBetween(i.start_date, i.goal.date) : null;

  if (goal.peakWeeklyKm && p.weeklyVolumeKm !== null) {
    const gap = goal.peakWeeklyKm - p.weeklyVolumeKm;
    const gapPct = gap / goal.peakWeeklyKm;
    if (gapPct >= 0.6) {
      factors.push({ id: "volume_gap_high", severity: "high",
        text: `Din nuvarande volym ~${p.weeklyVolumeKm} km/v är långt under vad målet typiskt kräver (toppvecka ~${goal.peakWeeklyKm} km/v). Gapet är ${Math.round(gapPct * 100)}%.` });
      adjustments.push(`Bygg grundvolym till minst ${Math.round(goal.peakWeeklyKm * 0.6)} km/v innan du kör mer än 2 kvalitetspass per vecka.`);
    } else if (gapPct >= 0.35) {
      factors.push({ id: "volume_gap_warn", severity: "warn",
        text: `Gapet till typisk toppvolym (~${goal.peakWeeklyKm} km/v) är ${Math.round(gapPct * 100)}%. Gör det men ha en längre basfas.` });
    }
  }

  if (goal.minWeeks && weeksToGoal !== null) {
    const req = goal.minWeeks[p.tier];
    if (weeksToGoal < req - 2) {
      factors.push({ id: "time_gap_high", severity: "high",
        text: `Du har ${weeksToGoal} veckor till måldatumet men för din nivå (${p.tier}) rekommenderas minst ${req} veckor för ett seriöst bygge.` });
      adjustments.push(`Skjut fram loppet ${req - weeksToGoal}+ veckor, eller välj ett kortare lopp som första delmål.`);
    } else if (weeksToGoal < req) {
      factors.push({ id: "time_gap_warn", severity: "warn",
        text: `${weeksToGoal} veckor till målet — strax under rekommenderade ${req} veckor för nivå "${p.tier}". Planen blir komprimerad.` });
    }
  }

  let projected5k: string | null = null;
  let targetPace: string | null = null;
  if (goal.distanceKm && goal.targetSeconds && i.baseline.recent_5k) {
    const current5kSec = parseHmsToSeconds(i.baseline.recent_5k);
    if (current5kSec && current5kSec > 0) {
      const projectedGoalSec = riegelProject(current5kSec, 5, goal.distanceKm);
      projected5k = formatSeconds(current5kSec);
      targetPace = formatSeconds(goal.targetSeconds);
      const speedGap = (projectedGoalSec - goal.targetSeconds) / projectedGoalSec;
      if (speedGap >= 0.10) {
        factors.push({ id: "pace_gap_high", severity: "high",
          text: `Baserat på din senaste 5km (${projected5k}) projiceras ~${formatSeconds(projectedGoalSec)} på måldistansen (Riegel). Ditt måltid ${targetPace} är ${Math.round(speedGap * 100)}% snabbare — mycket ambitiöst.` });
        adjustments.push(`Överväg ett mer realistiskt måltid runt ${formatSeconds(projectedGoalSec * 0.97)} (motsvarar ~3% förbättring från nuvarande 5k-form).`);
      } else if (speedGap >= 0.05) {
        factors.push({ id: "pace_gap_warn", severity: "warn",
          text: `Måltiden ${targetPace} är ${Math.round(speedGap * 100)}% snabbare än en rak Riegel-projicering från din 5km (${projected5k} ger ~${formatSeconds(projectedGoalSec)}). Nåbart med disciplinerad kvalitet.` });
      }
    }
  }

  let rampWarning: string | null = null;
  if (goal.peakWeeklyKm && p.weeklyVolumeKm !== null && p.weeklyVolumeKm > 0 && weeksToGoal && weeksToGoal > 0) {
    const requiredRampPct = ((goal.peakWeeklyKm - p.weeklyVolumeKm) / p.weeklyVolumeKm) / weeksToGoal;
    if (requiredRampPct > 0.10) {
      rampWarning = `För att nå ~${goal.peakWeeklyKm} km/v på ${weeksToGoal} veckor krävs ~${Math.round(requiredRampPct * 100)}% veckoökning från ${p.weeklyVolumeKm} km/v. Det överskrider 10%-regeln och ökar skaderisk.`;
      factors.push({ id: "ramp_warning", severity: "warn", text: rampWarning });
    }
  }

  const highCount = factors.filter((f) => f.severity === "high").length;
  const warnCount = factors.filter((f) => f.severity === "warn").length;
  let riskLevel: RiskLevel;
  if (highCount >= 2) riskLevel = "unrealistic";
  else if (highCount === 1) riskLevel = "aggressive";
  else if (warnCount >= 1) riskLevel = "ambitious";
  else riskLevel = "comfortable";

  let coachingNote: string;
  if (riskLevel === "comfortable") {
    coachingNote = `Målet ser rimligt ut givet din nuvarande form (${p.tier}, ~${p.weeklyVolumeKm ?? "?"} km/v). Planen lägger tonvikt på att bygga aerob grund och progressiv kvalitet.`;
  } else if (riskLevel === "ambitious") {
    coachingNote = `Målet är ambitiöst men nåbart. Följ planen disciplinerat — särskilt att lugna pass ska vara lugna. Missade veckor kostar mer här än vanligt.`;
  } else if (riskLevel === "aggressive") {
    coachingNote = `Det här är ett aggressivt mål relativt din nuvarande form. För att klara det måste du ligga nära gränsen för vad som är för hård träning. Skador eller missade veckor kan omöjliggöra måltiden.`;
  } else {
    coachingNote = `Givet nuvarande form är det här målet orealistiskt på utsatt tid utan betydande skaderisk. Vi rekommenderar att du antingen skjuter upp eller väljer ett mer modest delmål först.`;
  }
  if (highCount === 0 && warnCount === 0 && goal.kind === "fitness") {
    coachingNote = `Ett form- och hälsomål är flexibelt — planen bygger stadig volym med ${p.qualityPerPhase.build} kvalitetspass/v i uppbyggnadsfasen. Inga varningsflaggor.`;
  }

  return {
    riskLevel, factors, weeksToGoal, rampWarning, coachingNote,
    recommendedAdjustments: adjustments,
    projected: (projected5k || targetPace) ? { projected5kFromRecent: projected5k, targetPaceFromGoal: targetPace } : undefined,
  };
}

function formatCapacityForPrompt(p: CapacityProfile, f: FeasibilityAssessment): string {
  const qp = p.qualityPerPhase;
  const riskMap: Record<RiskLevel, string> = {
    comfortable: "LOW risk — goal aligns with current form",
    ambitious: "MEDIUM risk — reachable with discipline",
    aggressive: "HIGH risk — borderline realistic",
    unrealistic: "VERY HIGH risk — not achievable on this timeline",
  };
  const factorLines = f.factors.length === 0
    ? "  - (no risk factors detected)"
    : f.factors.map((x) => `  - [${x.severity.toUpperCase()}] ${x.text}`).join("\n");
  return `
## ATHLETE CAPACITY & FEASIBILITY (deterministic — adapt the plan to these constraints)

Athlete tier: ${p.tier} (${p.rationale})
Estimated current weekly volume: ${p.weeklyVolumeKm !== null ? p.weeklyVolumeKm + " km/v" : "okänt"}
Hard cap on quality sessions per week: ${p.qualityCapPerWeek}
Quality session target per phase: base=${qp.base}, build=${qp.build}, peak=${qp.peak}, deload=${qp.deload}, taper=${qp.taper}, recovery=${qp.recovery}

Goal realism: ${riskMap[f.riskLevel]}
${factorLines}
${f.rampWarning ? "Ramp warning: " + f.rampWarning : ""}

Coaching note (reflect this in the plan's "summary" field):
"${f.coachingNote}"

ADAPTATION RULES:
- Use EXACTLY the per-phase quality counts above. These are minimums AND maximums for this athlete.
- If risk is HIGH or VERY HIGH: prioritize ONE primary quality session per week (threshold), skip VO2max until volume catches up, cap weekly volume ramp at 10%/w.
- If risk is LOW: use the full quality-per-phase counts above.
- NEVER exceed ${p.qualityCapPerWeek} quality sessions in any week regardless of phase — that cap is derived from the user's session budget.
`;
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") || "";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") || "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";
const LLM_PROVIDER = Deno.env.get("LLM_PROVIDER") || "openai";

// SECURITY (assessment M3): CORS was `*`, which combined with credentialed
// requests lets any origin invoke this function from a logged-in user's
// browser. We allowlist origins via the APP_ORIGINS env var (comma-separated)
// and fall back to the first configured origin when the request origin isn't
// recognised so the browser denies the response.
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

function supabaseAdmin() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
}

// ═══════════════════════════════════════════════════════════════════
//  TRAINING SCIENCE SYSTEM PROMPT
// ═══════════════════════════════════════════════════════════════════

const SYSTEM_PROMPT = `You are an elite endurance coach trained in Nils van der Poel's methodology, Stephen Seiler's polarized training research, and modern exercise physiology (Edwards HR zones, Foster session-RPE, Gabbett ACWR). You generate personalized, periodized training plans with extreme specificity.

ALL output must be valid JSON matching the schema below. No markdown, no commentary outside the JSON object.

## TRAINING PHILOSOPHY (Nils van der Poel / Seiler polarized model)

The foundation is polarized training: ~80% of volume at Z1-Z2 (genuinely easy), ~20% at Z4-Z5 (quality). Zero or near-zero Z3 — Z3 is the "dead zone": too hard to recover from, too easy to drive top-end adaptation. Volume is the primary driver of aerobic adaptation. Quality sessions are the spice, not the meal — but the spice MUST be present every single week.

"Distansträning" (Z2 endurance) must feel truly easy. The athlete must hold a full conversation. If in doubt, go slower. Long Z2 sessions build the aerobic engine more effectively than moderate-hard sessions.

Quality sessions must be structured with exact intervals, recovery, and pace/HR targets. "Intervaller" alone is NEVER an acceptable description.

## CORE PRINCIPLES (hard constraints — violations will be rejected)

1. INTENSITY DISTRIBUTION: ~80% volume at Z1-Z2, ~20% at Z4-Z5. Zero Z3 in base/deload phases. Minimal Z3 elsewhere (only as part of progressive long runs).

2. QUALITY SESSIONS PER WEEK — EXACT COUNTS FROM ATHLETE CAPACITY:
   The user prompt includes an "ATHLETE CAPACITY & FEASIBILITY" section and a "PHASE PLAN" table that specify the EXACT number of quality sessions per phase for this athlete. These are scaled to the athlete's tier (novice / developing / intermediate / advanced) — a novice may get 0 quality sessions in a base week while an advanced athlete may get 2-3 in a peak week.

   Use THOSE counts, not generic defaults. A "quality session" is any workout with intensity_zone in {"Z4", "Z5", "mixed"}. For non-novice athletes a week where every non-rest workout is "Z2" is FORBIDDEN. For a novice, an all-Z2 base week is acceptable because the per-phase count in their capacity profile is 0.

3. PROGRESSIVE OVERLOAD: Max 10% weekly volume increase. Long session increases max 1-2 km/week (running) or 15 min/week (cycling).

4. PERIODIZATION (Base → Build → Peak → Taper for race goals):
   - Base phase (~30-40% of plan): Build aerobic volume. 1 quality session/week (mostly threshold).
   - Build phase (~40-50%): 2 quality sessions/week (VO2max + threshold). Maintain Z2 volume.
   - Peak phase (~10-15%): Race-pace work, reduce volume 10-20%, maintain intensity.
   - Taper (last 10-14 days): Cut volume 40-60%, keep 1-2 short quality sessions, more rest.

5. DELOAD: Every 4th week. Volume at 60-70%. Same session count, shorter durations. KEEP 1 short quality session (e.g. 4×2 min fartlek). Phase label: "deload".

## SESSION ARCHETYPE LIBRARY (use these — copy structure verbatim, adapt distance/HR to user)

Quality sessions (intensity_zone = Z4, Z5, or mixed):
- Tröskelintervaller (Z4):
    "15 min uppvärm Z2 → 4-6 × 5 min Z4 (2 min lugn jogg mellan) → 10 min nedvarvning"
- Tempopass (Z4):
    "15 min uppvärm Z2 → 20-30 min kontinuerligt Z4 → 10 min nedvarvning"
- VO2max-intervaller långa (Z5):
    "15 min uppvärm Z2 → 5 × 3 min Z5 (3 min mycket lugn jogg) → 10 min nedvarvning"
- VO2max-intervaller korta (Z5):
    "15 min uppvärm Z2 → 8-10 × 1 min Z5 (1 min lugn jogg) → 10 min nedvarvning"
- Fartlek (mixed):
    "10 min uppvärm Z2 → 8 × 2 min Z4-Z5 / 2 min lugnt → 10 min nedvarvning"
- Progressivt långpass (mixed, ends Z4):
    "12 km långpass: 9 km Z2 → 3 km progressivt genom Z3 till Z4 sista km"
- Backintervaller (Z5):
    "15 min uppvärm Z2 → 8-10 × 60-90s uppförsbacke ~Z5 (jogg ner som vila) → 10 min nedvarvning"

Easy sessions (intensity_zone = Z2 or Z1):
- Distanspass Z2: "X km lugn Z2 (pratstempo). Ska kännas enkelt."
- Distans Z2 + strides: "X km lugn Z2 + 6-8 × 20s strides på platt mark (full vila mellan)"
- Långpass Z2: "X km långpass Z2. Vätska efter 60 min. Aldrig öka tempo."
- Återhämtning Z1: "30-40 min mycket lugn Z1. Pulsen aldrig över 65% av max."
- Cross-training Z2 (cykel/erg/skidor): "60-90 min cykel Z2. Bra alternativ till löpning."

6. EASY DAY STRUCTURE: Z2 running at conversational pace + 6-10 × 15-20s strides on easy days mid-week. Strides activate fast-twitch fibers without fatigue.

7. LONG SESSION: Sacred session of the week. Builds by 1-2 km/week. Always Z2 except in build phase where progressive finish (last 3-5 km Z3→Z4) is permitted. Cap at ~30% of weekly volume.

8. CROSS-TRAINING: Cycling, skiing, and erg at Z2 count as aerobic volume. Use to add volume without running load. Place on easy days or as second session.

9. REST: Minimum 1 full rest day/week (2 for beginners). Rest day before or after the hardest session.

10. WEEK PATTERN (mandatory templates — pick the one matching session count):
    - 6 sessions:  [Vila, Kvalitet, Z2+strides, Vila/lätt, Kvalitet, Z2, Långpass]
    - 5 sessions:  [Vila, Kvalitet, Z2, Kvalitet, Vila, Z2, Långpass]
    - 4 sessions:  [Vila, Kvalitet, Z2, Vila, Kvalitet, Vila, Långpass]   (build/peak)
                   [Vila, Kvalitet, Z2, Vila, Z2, Vila, Långpass]         (base — 1 quality)
    - 3 sessions:  [Vila, Kvalitet, Vila, Z2, Vila, Vila, Långpass]
    NEVER place two quality sessions on consecutive days. ALWAYS leave 24-48h before the long session.

11. CONCURRENT STRENGTH: If included, place on the same day as a quality endurance session (AM endurance, PM strength) or on an easy day. Max 1 leg-heavy session/week.

## ANTI-PATTERN CHECKLIST (these will be rejected by post-generation validation)

FORBIDDEN: a week with fewer quality sessions than the PHASE PLAN table specifies for that week (derived from the athlete's capacity profile). Exception: rows where the required count is explicitly 0 (novice base/deload, or recovery weeks).
FORBIDDEN: describing a quality session as just "Intervaller" or "Tröskelpass" without reps × duration × zone × recovery.
FORBIDDEN: Z3 sessions in base or deload phase.
FORBIDDEN: two quality sessions on consecutive days.
FORBIDDEN: a base/build/peak/taper week with zero Z4/Z5 sessions UNLESS the capacity profile for this athlete specifies 0 for that phase (only novices — always verify against the PHASE PLAN table).
FORBIDDEN: a quality session description shorter than 40 characters.

12. USER PREFERENCES OVERRIDE: If the user provides free-text preferences or a specific training philosophy (see sections "USER FREE-TEXT PREFERENCES" and "TRÄNINGSFILOSOFI" in the user message), follow them as hard constraints unless they would cause injury risk. Example: if the user says "gym 2x/week but don't let it affect the running plan", place gym on existing rest days or as a second session on an easy running day — never replace a scheduled endurance session with gym.

## DESCRIPTION SPECIFICITY (critical requirement)

Every non-rest workout description MUST include:
- Exact structure (warm-up duration, main set, cool-down)
- For intervals: number of reps x duration, target HR zone, recovery duration and type
- For Z2 runs: target km and HR zone
- For long runs: target km and any progressive finish instructions

PACE AND HR RULES:
- If the user provides HR data (resting HR, max HR), use Karvonen-calculated zones in descriptions (e.g., "puls 145-155").
- If the user provides recent race times or easy pace, derive training paces from those. Example: if easy pace is 5:45/km, use that for Z2 descriptions.
- If NO HR or pace data is provided, describe intensity using RPE and zone labels only (e.g., "Z2, lugnt pratstempo" or "Z4, ansträngt men kontrollerbart"). Do NOT invent specific pace numbers or HR values.
- NEVER guess a user's pace per km or HR zones without data. Wrong pace prescriptions are worse than no pace prescriptions.

BAD example: "45 min löpning inkl intervaller" (too vague)
BAD example: "8 km Z2 (5:30-6:00/km)" when no pace data was provided (invented numbers)
GOOD example (with HR data): "15 min uppvärm Z2 (puls under 150) -> 5x3 min Z5 (puls 180+), 3 min lugn jogg -> 10 min nedvarvning"
GOOD example (without data): "8 km lugn Z2 (pratstempo, RPE 3-4). Sista 3 km progressivt mot Z4."

## WEEK-TO-WEEK VARIATION

Quality sessions MUST vary across weeks within the same phase. Do not repeat the exact same workout every week. Rotate between threshold intervals, tempo runs, VO2max long, VO2max short, fartlek, hill repeats, and progressive long runs.

Example 4-week build rotation:
- Week 1: Tröskelintervaller (4×5 min Z4) + Tempopass (20 min Z4)
- Week 2: VO2max långa (5×3 min Z5) + Fartlek (8×2 min)
- Week 3: Tröskelintervaller (5×5 min Z4) + VO2max korta (10×1 min Z5)
- Week 4 (deload): Kort fartlek (4×2 min Z4-Z5) — keep one quality session even on deload

## ACTIVITY TYPES (use exactly these Swedish labels)
Löpning, Cykel, Gym, Hyrox, Stakmaskin, Längdskidor, Annat, Vila

## INTENSITY ZONES
Z1, Z2, Z3, Z4, Z5, mixed

## OUTPUT SCHEMA

{
  "plan_name": "string — short descriptive name in Swedish",
  "summary": "string — 1-2 sentence summary in Swedish",
  "weeks": [
    {
      "week_number": 1,
      "phase": "base | build | peak | taper | deload | recovery",
      "target_hours": 4.5,
      "target_sessions": 5,
      "notes": "string — coaching note in Swedish",
      "workouts": [
        {
          "day_of_week": 0,
          "activity_type": "Vila",
          "label": "Vila",
          "description": null,
          "target_duration_minutes": 0,
          "target_distance_km": null,
          "intensity_zone": null,
          "is_rest": true
        },
        {
          "day_of_week": 1,
          "activity_type": "Löpning",
          "label": "Distans Z2",
          "description": "8 km lugn Z2 (5:45-6:15/km). Puls under 150. Ska kännas enkelt.",
          "target_duration_minutes": 48,
          "target_distance_km": 8,
          "intensity_zone": "Z2",
          "is_rest": false
        }
      ]
    }
  ]
}

## RULES FOR OUTPUT
- Every week must have exactly 7 workouts (day_of_week 0=Monday through 6=Sunday).
- Rest days: activity_type="Vila", is_rest=true, target_duration_minutes=0.
- All text in Swedish.
- target_duration_minutes = TOTAL session time including warm-up, work intervals, recovery jogs, and cool-down. For example an interval session with 15 min warm-up, 4×5 min intervals, 3 min recovery ×3, and 10 min cool-down = 54 min, not 15.
- target_hours = sum of durations / 60. target_sessions = count of non-rest days.
- For gym: label the type ("Styrka överkropp", etc.), intensity_zone=null, no individual exercises.
- target_distance_km: set for all running workouts (including warm-up + cool-down distance). null for cycling/gym.
- Descriptions: aim for 60-180 characters. Quality session descriptions MUST be at least 40 chars and include reps × duration × zone × recovery.`;

// ═══════════════════════════════════════════════════════════════════
//  LLM CALL
// ═══════════════════════════════════════════════════════════════════

interface LLMPlan {
  plan_name: string;
  summary: string;
  weeks: {
    week_number: number;
    phase: string;
    target_hours: number;
    target_sessions: number;
    notes: string;
    workouts: {
      day_of_week: number;
      activity_type: string;
      label: string;
      description: string | null;
      target_duration_minutes: number;
      target_distance_km: number | null;
      intensity_zone: string | null;
      is_rest: boolean;
    }[];
  }[];
}

// A user-message turn can be either a fresh prompt or a follow-up correction
// after we found validation issues. We model the turns as an array so each
// provider can wire them into its native conversation format.
interface UserTurn {
  content: string;
  // Optional assistant turn that preceded this user turn. We send it back to
  // the model so the retry has the full context (the broken plan + the fix
  // request).
  priorAssistantContent?: string;
}

async function callOpenAI(turns: UserTurn[]): Promise<LLMPlan> {
  const messages: { role: string; content: string }[] = [
    { role: "system", content: SYSTEM_PROMPT },
  ];
  for (const t of turns) {
    if (t.priorAssistantContent) {
      messages.push({ role: "assistant", content: t.priorAssistantContent });
    }
    messages.push({ role: "user", content: t.content });
  }
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o",
      temperature: 0.4,
      response_format: { type: "json_object" },
      messages,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`generate-plan: OpenAI ${res.status}`, err.slice(0, 500));
    throw new Error("upstream_ai_error");
  }
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

async function callAnthropic(turns: UserTurn[]): Promise<LLMPlan> {
  const messages: { role: string; content: string }[] = [];
  for (const t of turns) {
    if (t.priorAssistantContent) {
      messages.push({ role: "assistant", content: t.priorAssistantContent });
    }
    messages.push({
      role: "user",
      content: t.content + "\n\nRespond ONLY with valid JSON matching the output schema. No markdown fences.",
    });
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 16000,
      temperature: 0.4,
      system: SYSTEM_PROMPT,
      messages,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`generate-plan: Anthropic ${res.status}`, err.slice(0, 500));
    throw new Error("upstream_ai_error");
  }
  const data = await res.json();
  const text = data.content[0].text;
  const jsonStr = text.replace(/^```json?\n?/, "").replace(/\n?```$/, "").trim();
  return JSON.parse(jsonStr);
}

async function callGemini(turns: UserTurn[]): Promise<LLMPlan> {
  const contents: { role: string; parts: { text: string }[] }[] = [];
  for (const t of turns) {
    if (t.priorAssistantContent) {
      contents.push({ role: "model", parts: [{ text: t.priorAssistantContent }] });
    }
    contents.push({
      role: "user",
      parts: [{ text: t.content + "\n\nRespond ONLY with valid JSON matching the output schema. No markdown fences." }],
    });
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents,
      generationConfig: {
        temperature: 0.4,
        responseMimeType: "application/json",
      },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`generate-plan: Gemini ${res.status}`, err.slice(0, 500));
    throw new Error("upstream_ai_error");
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned empty response");
  return JSON.parse(text);
}

async function callLLM(turns: UserTurn[]): Promise<LLMPlan> {
  if (LLM_PROVIDER === "gemini" && GEMINI_API_KEY) {
    return callGemini(turns);
  }
  if (LLM_PROVIDER === "anthropic" && ANTHROPIC_API_KEY) {
    return callAnthropic(turns);
  }
  if (OPENAI_API_KEY) {
    return callOpenAI(turns);
  }
  if (GEMINI_API_KEY) {
    return callGemini(turns);
  }
  throw new Error("No LLM API key configured. Set GEMINI_API_KEY (free), OPENAI_API_KEY, or ANTHROPIC_API_KEY in Edge Function secrets.");
}

// Backwards-compatible: single-prompt callers (edit modes etc.).
async function generatePlan(userPrompt: string): Promise<LLMPlan> {
  return callLLM([{ content: userPrompt }]);
}

// Generate a full multi-week plan and, if validation fails, do exactly ONE
// retry with a follow-up correction message. If retry also fails we return
// the second attempt anyway plus the warnings — the alternative (rejecting
// the whole request) would block the user with no plan at all.
async function generatePlanWithRetry(
  userPrompt: string,
  profile: CapacityProfile,
): Promise<{ plan: LLMPlan; validation: PlanValidation; retried: boolean }> {
  const firstPlan = await callLLM([{ content: userPrompt }]);
  const firstValidation = validatePlan(firstPlan.weeks, profile);
  if (firstValidation.valid) {
    return { plan: firstPlan, validation: firstValidation, retried: false };
  }

  console.warn(
    "generate-plan: validation failed on first attempt, retrying. Issues:",
    JSON.stringify(firstValidation.weekResults.filter((r) => !r.valid), null, 0).slice(0, 800),
  );

  const retryMsg = buildRetryMessage(firstValidation);
  const secondPlan = await callLLM([
    { content: userPrompt },
    {
      priorAssistantContent: JSON.stringify(firstPlan),
      content: retryMsg,
    },
  ]);
  const secondValidation = validatePlan(secondPlan.weeks, profile);
  if (!secondValidation.valid) {
    console.warn(
      "generate-plan: validation still failed after retry. Returning anyway.",
      JSON.stringify(secondValidation.weekResults.filter((r) => !r.valid), null, 0).slice(0, 800),
    );
  }
  return { plan: secondPlan, validation: secondValidation, retried: true };
}

// ═══════════════════════════════════════════════════════════════════
//  EDIT MODE — dedicated prompt + lightweight structural validation
// ═══════════════════════════════════════════════════════════════════

const SV_DAY_TO_NUM: Record<string, number> = {
  "måndag": 0, "mandag": 0, "mån": 0, "man": 0,
  "tisdag": 1, "tis": 1,
  "onsdag": 2, "ons": 2,
  "torsdag": 3, "tors": 3, "tor": 3,
  "fredag": 4, "fre": 4,
  "lördag": 5, "lordag": 5, "lör": 5, "lor": 5,
  "söndag": 6, "sondag": 6, "sön": 6, "son": 6,
};
const DAY_NUM_TO_SV = ["måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag", "söndag"];

// Extract Swedish weekday names the user mentions so we can verify the model
// actually moved something onto those days.
function extractMentionedDayNums(instruction: string): Set<number> {
  const out = new Set<number>();
  const lower = instruction.toLowerCase();
  for (const [word, num] of Object.entries(SV_DAY_TO_NUM)) {
    // Match whole-ish words (bounded by non-letter). Regex-safe: word is ASCII-ish lowercase.
    const re = new RegExp(`(^|[^a-zåäö])${word}([^a-zåäö]|$)`, "i");
    if (re.test(lower)) out.add(num);
  }
  return out;
}

interface EditPromptArgs {
  instruction: string;
  currentPlan: LLMPlan;
  history: Array<{ role: string; content: string }>;
  constraints: Record<string, unknown> | null;
  preferences: Record<string, unknown> | null;
}

function buildEditPrompt(args: EditPromptArgs): string {
  const { instruction, currentPlan, history, constraints, preferences } = args;

  const availDays = Array.isArray((constraints as { available_days?: number[] } | null)?.available_days)
    ? ((constraints as { available_days: number[] }).available_days)
        .map((d) => DAY_NUM_TO_SV[d]).join(", ")
    : "(ej angivet)";
  const restDays = Array.isArray((preferences as { preferred_rest_days?: number[] } | null)?.preferred_rest_days)
    ? ((preferences as { preferred_rest_days: number[] }).preferred_rest_days)
        .map((d) => DAY_NUM_TO_SV[d]).join(", ")
    : "(ej angivet)";

  const historyBlock = history.length > 0
    ? history.map((m) => `${m.role === "user" ? "USER" : "ASSISTANT"}: ${m.content}`).join("\n\n") + "\n\n"
    : "";

  return `${historyBlock}You are editing an existing training plan. Apply ONLY the user's latest instruction — nothing else.

## DAG-MAPPNING (obligatorisk)
Måndag=0, Tisdag=1, Onsdag=2, Torsdag=3, Fredag=4, Lördag=5, Söndag=6

When the user mentions a Swedish weekday (e.g. "lördag", "tisdag"), the corresponding day_of_week number MUST be used. "Långpass på lördagar" means every week's long run MUST have day_of_week=5. "Vilodag på söndag" means every week must have a Vila workout at day_of_week=6.

## PRESERVATION RULE (critical)
Change ONLY what the user explicitly asked for. Every workout the user did NOT mention must be returned byte-for-byte identical to CURRENT PLAN (same label, description, duration, distance, zone, is_rest). Do NOT reword descriptions, do NOT retune durations, do NOT swap activity types. If the user asks to move workout A to a specific day and another workout B already sits there, SWAP them — don't invent new workouts.

## USER ORIGINAL CONSTRAINTS (respect these when moving workouts)
Tillgängliga dagar: ${availDays}
Önskade vilodagar: ${restDays}

## USER INSTRUCTION
"${instruction}"

## CURRENT PLAN
${JSON.stringify(currentPlan, null, 2)}

## VERIFICATION (before responding, check mentally)
1. For every Swedish weekday the user mentioned, is the corresponding day_of_week actually updated in every week you were asked to change?
2. Are all other workouts byte-for-byte identical to CURRENT PLAN?
3. Does every week still have exactly 7 workouts with day_of_week 0..6 once each?

Return the COMPLETE modified plan as valid JSON only. No commentary.`;
}

interface EditValidationIssue {
  weekNumber: number;
  reason: string;
}

// Lightweight structural validation for edits — deliberately NOT reusing
// validatePlan() (which enforces intensity distribution etc.), because a
// small edit shouldn't be rejected over philosophy drift.
function validateEditStructural(
  proposed: LLMPlan,
  original: LLMPlan,
  instruction: string,
): EditValidationIssue[] {
  const issues: EditValidationIssue[] = [];
  if (!proposed?.weeks?.length) {
    issues.push({ weekNumber: 0, reason: "proposed plan has no weeks" });
    return issues;
  }
  if (proposed.weeks.length !== original.weeks.length) {
    issues.push({
      weekNumber: 0,
      reason: `week count changed (${original.weeks.length} → ${proposed.weeks.length}); editing must preserve the plan length`,
    });
  }

  for (const w of proposed.weeks) {
    if (!Array.isArray(w.workouts) || w.workouts.length !== 7) {
      issues.push({ weekNumber: w.week_number, reason: `week ${w.week_number} must have exactly 7 workouts (has ${w.workouts?.length ?? 0})` });
      continue;
    }
    const days = new Set<number>();
    for (const wo of w.workouts) {
      if (typeof wo.day_of_week !== "number" || wo.day_of_week < 0 || wo.day_of_week > 6) {
        issues.push({ weekNumber: w.week_number, reason: `invalid day_of_week=${wo.day_of_week} in week ${w.week_number}` });
      } else {
        days.add(wo.day_of_week);
      }
    }
    if (days.size !== 7) {
      issues.push({ weekNumber: w.week_number, reason: `week ${w.week_number} is missing one or more of day_of_week 0..6 (got ${[...days].sort().join(",")})` });
    }
  }

  // If the user mentioned a Swedish weekday, verify SOMETHING changed on
  // that day_of_week in at least one week — otherwise the model likely
  // ignored the day reference entirely.
  const mentioned = extractMentionedDayNums(instruction);
  if (mentioned.size > 0) {
    for (const dayNum of mentioned) {
      let anyChange = false;
      for (let wi = 0; wi < proposed.weeks.length && wi < original.weeks.length; wi++) {
        const oldWo = original.weeks[wi].workouts.find((x) => x.day_of_week === dayNum);
        const newWo = proposed.weeks[wi].workouts.find((x) => x.day_of_week === dayNum);
        if (!oldWo || !newWo) continue;
        if (oldWo.label !== newWo.label || oldWo.description !== newWo.description ||
            oldWo.activity_type !== newWo.activity_type || oldWo.is_rest !== newWo.is_rest) {
          anyChange = true;
          break;
        }
      }
      if (!anyChange) {
        issues.push({
          weekNumber: 0,
          reason: `user mentioned "${DAY_NUM_TO_SV[dayNum]}" (day_of_week=${dayNum}) but no workout on that day changed in any week`,
        });
      }
    }
  }

  return issues;
}

function buildEditRetryMessage(issues: EditValidationIssue[]): string {
  const lines = issues.slice(0, 8).map((i) => `- ${i.reason}`).join("\n");
  return `Your previous response had structural issues:\n${lines}\n\nFix them and return the complete modified plan as JSON. Remember: Måndag=0, Tisdag=1, Onsdag=2, Torsdag=3, Fredag=4, Lördag=5, Söndag=6. Apply ONLY what the user originally asked for; leave everything else byte-for-byte identical to CURRENT PLAN.`;
}

async function generateEditWithRetry(editPrompt: string, originalPlan: LLMPlan): Promise<LLMPlan> {
  // Extract the user instruction from the prompt for validation (it lives
  // between "## USER INSTRUCTION\n\"" and the closing quote on that line).
  const instrMatch = editPrompt.match(/## USER INSTRUCTION\s*\n\s*"([\s\S]*?)"\s*\n/);
  const instruction = instrMatch ? instrMatch[1] : "";

  const first = await callLLM([{ content: editPrompt }]);
  const firstIssues = validateEditStructural(first, originalPlan, instruction);
  if (firstIssues.length === 0) return first;

  console.warn(
    "generate-plan edit_preview: structural validation failed, retrying. Issues:",
    JSON.stringify(firstIssues, null, 0).slice(0, 600),
  );

  const retryMsg = buildEditRetryMessage(firstIssues);
  const second = await callLLM([
    { content: editPrompt },
    { priorAssistantContent: JSON.stringify(first), content: retryMsg },
  ]);
  const secondIssues = validateEditStructural(second, originalPlan, instruction);
  if (secondIssues.length > 0) {
    console.warn(
      "generate-plan edit_preview: still invalid after retry, returning anyway.",
      JSON.stringify(secondIssues, null, 0).slice(0, 600),
    );
  }
  return second;
}

// ═══════════════════════════════════════════════════════════════════
//  BUILD USER PROMPT
// ═══════════════════════════════════════════════════════════════════

interface PlanRequest {
  goal_type: string;
  goal_text: string;
  goal_date?: string;
  constraints: {
    sessions_per_week: number;
    hours_per_week: number;
    available_days: number[];
    max_session_minutes: number;
    injuries?: string;
  };
  baseline: {
    sessions_per_week: number;
    hours_per_week: number;
    activity_mix: Record<string, number>;
    fitness_level: string;
    longest_session_minutes: number;
    resting_hr?: number | null;
    max_hr?: number | null;
    recent_5k?: string | null;
    recent_10k?: string | null;
    easy_pace?: string | null;
  };
  preferences: {
    activity_types: string[];
    include_gym: boolean;
    preferred_rest_days: number[];
  };
  start_date: string;
}

interface BuildUserPromptResult {
  prompt: string;
  profile: CapacityProfile;
  feasibility: FeasibilityAssessment;
  numWeeks: number;
}

function buildUserPrompt(req: PlanRequest, workoutHistory: string): BuildUserPromptResult {
  const goalDateStr = req.goal_date ? `\nMåldatum: ${req.goal_date}` : "";
  const injuryStr = req.constraints.injuries ? `\nSkador/begränsningar: ${req.constraints.injuries}` : "";
  const availDays = req.constraints.available_days.map((d: number) =>
    ["Mån", "Tis", "Ons", "Tors", "Fre", "Lör", "Sön"][d]
  ).join(", ");
  const restDays = req.preferences.preferred_rest_days.map((d: number) =>
    ["Mån", "Tis", "Ons", "Tors", "Fre", "Lör", "Sön"][d]
  ).join(", ");
  const actTypes = req.preferences.activity_types.join(", ");
  const mixStr = Object.entries(req.baseline.activity_mix)
    .map(([k, v]) => `${k}: ${v}%`)
    .join(", ");

  const today = new Date().toISOString().split("T")[0];
  const startDate = req.start_date || today;

  let numWeeks: number;
  if (req.goal_date) {
    const diffMs = new Date(req.goal_date).getTime() - new Date(startDate).getTime();
    numWeeks = Math.max(4, Math.min(24, Math.ceil(diffMs / (7 * 86400000))));
  } else {
    numWeeks = 12;
  }

  const b = req.baseline;
  let physioStr = "";
  if (b.resting_hr || b.max_hr || b.recent_5k || b.recent_10k || b.easy_pace) {
    physioStr = "\n\n## PHYSIOLOGY & PACE DATA (from user — use these, do NOT guess)";
    if (b.resting_hr) physioStr += `\nVilopuls: ${b.resting_hr} bpm`;
    if (b.max_hr) physioStr += `\nMax puls: ${b.max_hr} bpm`;
    if (b.resting_hr && b.max_hr) {
      const z2lo = Math.round(b.resting_hr + (b.max_hr - b.resting_hr) * 0.6);
      const z2hi = Math.round(b.resting_hr + (b.max_hr - b.resting_hr) * 0.7);
      const z4lo = Math.round(b.resting_hr + (b.max_hr - b.resting_hr) * 0.8);
      const z4hi = Math.round(b.resting_hr + (b.max_hr - b.resting_hr) * 0.87);
      const z5lo = Math.round(b.resting_hr + (b.max_hr - b.resting_hr) * 0.88);
      const z5hi = Math.round(b.resting_hr + (b.max_hr - b.resting_hr) * 0.95);
      physioStr += `\nBeräknade pulszoner (Karvonen): Z2 ${z2lo}-${z2hi}, Z4 ${z4lo}-${z4hi}, Z5 ${z5lo}-${z5hi}`;
    }
    if (b.recent_5k) physioStr += `\nSenaste 5 km: ${b.recent_5k}`;
    if (b.recent_10k) physioStr += `\nSenaste 10 km: ${b.recent_10k}`;
    if (b.easy_pace) physioStr += `\nNuvarande lugnt tempo: ${b.easy_pace} min/km`;
  }

  // Build capacity profile + feasibility from the request so we can:
  //   (a) scale quality-session minimums to the athlete's tier
  //   (b) inject a realism block the LLM must adapt to
  //   (c) return feasibility to the caller (UI renders this)
  const capacityInputs: CapacityInputs = {
    baseline: req.baseline,
    goal: { type: req.goal_type, text: req.goal_text, date: req.goal_date || null },
    start_date: startDate,
    weekly_session_cap: req.constraints.sessions_per_week,
  };
  const profile = profileCapacity(capacityInputs);
  const feasibility = assessFeasibility(capacityInputs, profile);
  const capacityStr = formatCapacityForPrompt(profile, feasibility);

  const phasePlanStr = buildPhasePlanSection(numWeeks, !!req.goal_date, profile);

  const prompt = `Generate a ${numWeeks}-week training plan starting ${startDate}.

## GOAL
Type: ${req.goal_type}
Description: ${req.goal_text}${goalDateStr}

## CONSTRAINTS
Max pass per vecka: ${req.constraints.sessions_per_week}
Max timmar per vecka: ${req.constraints.hours_per_week}
Tillgängliga dagar: ${availDays}
Max längd per pass: ${req.constraints.max_session_minutes} min${injuryStr}

## CURRENT BASELINE
Pass per vecka (snitt): ${req.baseline.sessions_per_week}
Timmar per vecka (snitt): ${req.baseline.hours_per_week}
Aktivitetsmix: ${mixStr}
Fitnessnivå: ${req.baseline.fitness_level}
Längsta pass senaste 4v: ${req.baseline.longest_session_minutes} min${physioStr}

## PREFERENCES
Aktivitetstyper: ${actTypes}
Inkludera gym/styrka: ${req.preferences.include_gym ? "Ja" : "Nej"}
Önskade vilodagar: ${restDays}${buildFreeTextSection(req.preferences)}${buildPhilosophySection(req.preferences)}
${capacityStr}
${phasePlanStr}
## RECENT WORKOUT HISTORY (last 4 weeks)
${workoutHistory || "No logged workouts available."}

Generate the complete plan as JSON. Each week's "phase" field MUST match the PHASE PLAN above, and each week's quality session count MUST match the exact number derived from the athlete's capacity (shown in the PHASE PLAN table). The "summary" field of the plan MUST begin with the coaching note supplied under ATHLETE CAPACITY & FEASIBILITY.`;

  return { prompt, profile, feasibility, numWeeks };
}

// ─────────────────────────────────────────────────────────────────────
// Deterministic phase planner. Removes the model's freedom to interpret
// "base" as "zero quality sessions". We compute the exact phase + quality
// requirement per week and inject it as a table the model must follow.
//
// Heuristics (race-goal aware):
//   < 6 weeks  → 100% build (every week 2 quality)
//   6–11 weeks → 1/3 base, ~half build, last week deload (or taper if race)
//   12–16 weeks → 4w base, then build/peak/taper cycle, deload every 4th
//   16+ weeks  → 5w base, longer build, peak + taper at end if race
// ─────────────────────────────────────────────────────────────────────
function buildPhasePlanSection(numWeeks: number, hasRaceDate: boolean, profile: CapacityProfile): string {
  const phases = computePhasePlan(numWeeks, hasRaceDate);
  const rows = phases.map((p, i) =>
    `Week ${i + 1}: phase="${p}" → ${qualityForPhase(p, profile)} kvalitetspass`
  ).join("\n");
  return `\n## PHASE PLAN (deterministic — every week MUST use exactly this phase + quality count)
${rows}

A "kvalitetspass" = a workout with intensity_zone in {Z4, Z5, mixed}. The required count is a HARD MINIMUM. Adding more is forbidden — the per-phase counts above are derived from the athlete's capacity and must be honored exactly. Even deload weeks for stronger athletes include a short quality session (novices may skip it).
`;
}

function qualityForPhase(p: string, profile?: CapacityProfile): number {
  return expectedQualityForPhase(p, profile);
}

function computePhasePlan(numWeeks: number, hasRaceDate: boolean): string[] {
  const phases: string[] = new Array(numWeeks);

  if (numWeeks < 6) {
    for (let i = 0; i < numWeeks; i++) phases[i] = "build";
    if (hasRaceDate && numWeeks >= 2) phases[numWeeks - 1] = "taper";
    return phases;
  }

  let baseWeeks: number;
  let peakWeeks: number;
  let taperWeeks: number;
  if (numWeeks <= 11) {
    baseWeeks = Math.ceil(numWeeks / 3);
    peakWeeks = 0;
    taperWeeks = hasRaceDate ? 1 : 0;
  } else if (numWeeks <= 16) {
    baseWeeks = 4;
    peakWeeks = hasRaceDate ? 1 : 0;
    taperWeeks = hasRaceDate ? 1 : 0;
  } else {
    baseWeeks = 5;
    peakWeeks = hasRaceDate ? 2 : 0;
    taperWeeks = hasRaceDate ? 2 : 0;
  }

  const buildWeeks = numWeeks - baseWeeks - peakWeeks - taperWeeks;
  let i = 0;
  for (let k = 0; k < baseWeeks; k++) phases[i++] = "base";
  for (let k = 0; k < buildWeeks; k++) phases[i++] = "build";
  for (let k = 0; k < peakWeeks; k++) phases[i++] = "peak";
  for (let k = 0; k < taperWeeks; k++) phases[i++] = "taper";

  // Insert deload every 4th week (overwrite, but never on a taper week).
  for (let w = 3; w < numWeeks; w += 4) {
    if (phases[w] !== "taper" && phases[w] !== "peak") {
      phases[w] = "deload";
    }
  }
  return phases;
}

function buildFreeTextSection(prefs: any): string {
  const free = (prefs?.free_text || "").trim();
  if (!free) return "";
  return `\n\n## USER FREE-TEXT PREFERENCES (treat as hard constraints unless they conflict with safety)\n${free}`;
}

function buildPhilosophySection(prefs: any): string {
  const philo = prefs?.training_philosophy;
  if (!philo) return "";
  const preset = philo.preset;
  const custom = (philo.custom || "").trim();
  if (!preset && !custom) return "";

  let s = "\n\n## TRÄNINGSFILOSOFI (user-chosen — respect these principles throughout the plan)";
  if (preset === "van_der_poel") {
    s += "\nFölj Nils van der Poels filosofi: bygg en stor, lugn aerob grund (majoriteten av volymen i Z1-Z2, genuint lugnt pratstempo). Ha få men riktigt kvalitativa hårda pass (Z4-tröskel eller Z5 VO2max) — inga halvhårda mellanpass i Z3. Progression genom volym först, intensitet sen. Stenhård disciplin kring återhämtning: sömn, lugna dagar lugna, rest day är rest day. Långpasset är veckans viktigaste pass.";
  }
  if (custom) {
    s += `\n${preset ? "Användarens tillägg: " : ""}${custom}`;
  }
  return s;
}

// ═══════════════════════════════════════════════════════════════════
//  MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(req) });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    // 1. Authenticate
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "No auth header" }), {
        status: 401,
        headers: { ...corsHeaders(req), "Content-Type": "application/json" },
      });
    }

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

    // 2. Parse input
    const body: (PlanRequest & {
      profile_id?: string;
      mode?: string;
      plan_id?: string;
      instruction?: string;
      current_plan?: unknown;
      workout_id?: string;
      current_workout?: unknown;
      conversation_history?: { role: string; content: string }[];
      proposed_plan?: unknown;
    }) = await req.json();

    const db = supabaseAdmin();

    // SECURITY: derive profile_id from the JWT, never trust the body.
    // Any body-supplied profile_id is ignored (prevents IDOR).
    const { data: callerProfile, error: profErr } = await db
      .from("profiles")
      .select("id")
      .eq("user_id", user.id)
      .maybeSingle();
    if (profErr || !callerProfile) {
      console.error("generate-plan: profile lookup failed", profErr);
      return new Response(JSON.stringify({ error: "profile_not_found" }), {
        status: 404,
        headers: { ...corsHeaders(req), "Content-Type": "application/json" },
      });
    }
    const profile_id = callerProfile.id;

    // Helper: assert that plan_id (if present) belongs to the caller.
    async function assertPlanOwnership(planId: string): Promise<boolean> {
      const { data: planRow } = await db
        .from("training_plans")
        .select("profile_id")
        .eq("id", planId)
        .maybeSingle();
      return !!planRow && planRow.profile_id === profile_id;
    }

    // ── EDIT_SINGLE MODE: AI modifies one workout ──
    if (body.mode === "edit_single" && body.workout_id && body.instruction && body.current_workout) {
      const singlePrompt = `You are modifying a SINGLE workout in a training plan. Return ONLY a JSON object with the modified workout fields.

CURRENT WORKOUT:
${JSON.stringify(body.current_workout, null, 2)}

USER INSTRUCTION: "${body.instruction}"

Return ONLY a JSON object with these fields: activity_type, label, description, target_duration_minutes, target_distance_km, intensity_zone, is_rest. Use Swedish text. Follow the training philosophy rules. Wrap it in {"plan_name":"edit","summary":"","weeks":[{"week_number":1,"phase":"base","target_hours":0,"target_sessions":0,"notes":"","workouts":[YOUR_WORKOUT]}]}`;

      const rawResult = await generatePlan(singlePrompt);
      const workout = rawResult.weeks?.[0]?.workouts?.[0] || rawResult;

      return new Response(
        JSON.stringify({ workout }),
        { status: 200, headers: { ...corsHeaders(req), "Content-Type": "application/json" } }
      );
    }

    // ── EDIT_APPLY MODE: apply a previously previewed plan ──
    if (body.mode === "edit_apply" && body.plan_id && body.proposed_plan) {
      if (!(await assertPlanOwnership(body.plan_id))) {
        return new Response(JSON.stringify({ error: "forbidden" }), {
          status: 403,
          headers: { ...corsHeaders(req), "Content-Type": "application/json" },
        });
      }
      const editedPlan = body.proposed_plan as LLMPlan;

      const { data: oldWeeks } = await db.from("plan_weeks").select("id").eq("plan_id", body.plan_id);
      if (oldWeeks) {
        for (const w of oldWeeks) {
          await db.from("plan_workouts").delete().eq("plan_week_id", w.id);
        }
        await db.from("plan_weeks").delete().eq("plan_id", body.plan_id);
      }

      const { data: planData } = await db.from("training_plans").select("start_date").eq("id", body.plan_id).single();
      const applyStartDate = planData?.start_date || new Date().toISOString().split("T")[0];
      const applyNumWeeks = editedPlan.weeks.length;
      const applyEndDate = new Date(applyStartDate);
      applyEndDate.setDate(applyEndDate.getDate() + applyNumWeeks * 7 - 1);

      await db.from("training_plans").update({
        name: editedPlan.plan_name,
        end_date: applyEndDate.toISOString().split("T")[0],
      }).eq("id", body.plan_id);

      for (const week of editedPlan.weeks) {
        const { data: weekData, error: weekErr } = await db.from("plan_weeks").insert({
          plan_id: body.plan_id,
          week_number: week.week_number,
          phase: week.phase,
          target_hours: week.target_hours,
          target_sessions: week.target_sessions,
          notes: week.notes,
        }).select("id").single();
        if (weekErr) continue;

        const weekStartDate = new Date(applyStartDate);
        weekStartDate.setDate(weekStartDate.getDate() + (week.week_number - 1) * 7);
        const workoutRows = week.workouts.map((w: LLMPlan["weeks"][0]["workouts"][0], idx: number) => {
          const wDate = new Date(weekStartDate);
          wDate.setDate(wDate.getDate() + w.day_of_week);
          return {
            plan_week_id: weekData.id,
            workout_date: wDate.toISOString().split("T")[0],
            day_of_week: w.day_of_week,
            activity_type: w.activity_type,
            label: w.label,
            description: w.description,
            target_duration_minutes: w.target_duration_minutes || 0,
            target_distance_km: w.target_distance_km || null,
            intensity_zone: w.intensity_zone || null,
            is_rest: w.is_rest,
            sort_order: idx,
          };
        });
        await db.from("plan_workouts").insert(workoutRows);
      }

      return new Response(
        JSON.stringify({ plan_id: body.plan_id, plan_name: editedPlan.plan_name, applied: true }),
        { status: 200, headers: { ...corsHeaders(req), "Content-Type": "application/json" } }
      );
    }

    // ── EDIT_PREVIEW MODE: return proposed plan without writing to DB ──
    if (body.mode === "edit_preview" && body.plan_id && body.instruction) {
      if (!(await assertPlanOwnership(body.plan_id))) {
        return new Response(JSON.stringify({ error: "forbidden" }), {
          status: 403,
          headers: { ...corsHeaders(req), "Content-Type": "application/json" },
        });
      }

      // Pull original constraints + preferences so the edit respects the
      // user's available days / rest-day preferences when moving workouts.
      const { data: planRow } = await db
        .from("training_plans")
        .select("constraints, preferences")
        .eq("id", body.plan_id)
        .maybeSingle();

      const origPlan = body.current_plan as LLMPlan;
      const editPromptPreview = buildEditPrompt({
        instruction: body.instruction,
        currentPlan: origPlan,
        history: body.conversation_history || [],
        constraints: planRow?.constraints || null,
        preferences: planRow?.preferences || null,
      });

      const previewPlan = await generateEditWithRetry(editPromptPreview, origPlan);
      return new Response(
        JSON.stringify({ proposed_plan: previewPlan }),
        { status: 200, headers: { ...corsHeaders(req), "Content-Type": "application/json" } }
      );
    }

    // ── EDIT MODE: modify existing plan via AI chat (legacy direct-apply) ──
    if (body.mode === "edit" && body.plan_id && body.instruction) {
      if (!(await assertPlanOwnership(body.plan_id))) {
        return new Response(JSON.stringify({ error: "forbidden" }), {
          status: 403,
          headers: { ...corsHeaders(req), "Content-Type": "application/json" },
        });
      }
      const editPrompt = `You have an existing training plan (JSON below). The user wants to modify it.

USER INSTRUCTION: "${body.instruction}"

CURRENT PLAN:
${JSON.stringify(body.current_plan, null, 2)}

Apply the user's instruction to the plan. Return the COMPLETE modified plan in the same JSON format. Keep everything the user didn't ask to change. Respond ONLY with valid JSON.`;

      const editedPlan = await generatePlan(editPrompt);

      // Delete old workouts and weeks for this plan
      const { data: oldWeeks } = await db.from("plan_weeks").select("id").eq("plan_id", body.plan_id);
      if (oldWeeks) {
        for (const w of oldWeeks) {
          await db.from("plan_workouts").delete().eq("plan_week_id", w.id);
        }
        await db.from("plan_weeks").delete().eq("plan_id", body.plan_id);
      }

      // Get plan start date
      const { data: planData } = await db.from("training_plans").select("start_date").eq("id", body.plan_id).single();
      const editStartDate = planData?.start_date || new Date().toISOString().split("T")[0];

      // Update plan name if changed
      const numWeeks = editedPlan.weeks.length;
      const editEndDate = new Date(editStartDate);
      editEndDate.setDate(editEndDate.getDate() + numWeeks * 7 - 1);
      await db.from("training_plans").update({
        name: editedPlan.plan_name,
        end_date: editEndDate.toISOString().split("T")[0],
      }).eq("id", body.plan_id);

      // Re-insert weeks and workouts
      for (const week of editedPlan.weeks) {
        const { data: weekData, error: weekErr } = await db.from("plan_weeks").insert({
          plan_id: body.plan_id,
          week_number: week.week_number,
          phase: week.phase,
          target_hours: week.target_hours,
          target_sessions: week.target_sessions,
          notes: week.notes,
        }).select("id").single();

        if (weekErr) continue;

        const weekStartDate = new Date(editStartDate);
        weekStartDate.setDate(weekStartDate.getDate() + (week.week_number - 1) * 7);

        const workoutRows = week.workouts.map((w: LLMPlan["weeks"][0]["workouts"][0], idx: number) => {
          const wDate = new Date(weekStartDate);
          wDate.setDate(wDate.getDate() + w.day_of_week);
          return {
            plan_week_id: weekData.id,
            workout_date: wDate.toISOString().split("T")[0],
            day_of_week: w.day_of_week,
            activity_type: w.activity_type,
            label: w.label,
            description: w.description,
            target_duration_minutes: w.target_duration_minutes || 0,
            target_distance_km: w.target_distance_km || null,
            intensity_zone: w.intensity_zone || null,
            is_rest: w.is_rest,
            sort_order: idx,
          };
        });

        await db.from("plan_workouts").insert(workoutRows);
      }

      return new Response(
        JSON.stringify({
          plan_id: body.plan_id,
          plan_name: editedPlan.plan_name,
          summary: editedPlan.summary,
          weeks: numWeeks,
        }),
        { status: 200, headers: { ...corsHeaders(req), "Content-Type": "application/json" } }
      );
    }

    // 3. Archive existing active plan
    await db.from("training_plans")
      .update({ status: "archived" })
      .eq("profile_id", profile_id)
      .eq("status", "active");

    // 4. Fetch recent workout history for context
    const fourWeeksAgo = new Date();
    fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);
    const { data: recentWorkouts } = await db.from("workouts")
      .select("workout_date, activity_type, duration_minutes, intensity, distance_km")
      .eq("profile_id", profile_id)
      .gte("workout_date", fourWeeksAgo.toISOString().split("T")[0])
      .order("workout_date", { ascending: true });

    let historyStr = "";
    if (recentWorkouts && recentWorkouts.length > 0) {
      historyStr = recentWorkouts.map((w: Record<string, unknown>) => {
        const parts = [`${w.workout_date}: ${w.activity_type}, ${w.duration_minutes} min`];
        if (w.intensity) parts.push(`(${w.intensity})`);
        if (w.distance_km) parts.push(`${w.distance_km} km`);
        return parts.join(" ");
      }).join("\n");
    }

    // 5. Build prompt and call LLM (with one validation-driven retry to
    //    catch all-Z2 weeks before they reach the database).
    const startDate = body.start_date || new Date().toISOString().split("T")[0];
    const { prompt: userPrompt, profile, feasibility } = buildUserPrompt(body, historyStr);
    const { plan, validation, retried } = await generatePlanWithRetry(userPrompt, profile);
    const validationWarnings = validation.valid
      ? []
      : validation.weekResults
          .filter((r) => !r.valid)
          .map((r) => ({
            week_number: r.weekNumber,
            expected_quality: r.expectedQualityCount,
            actual_quality: r.actualQualityCount,
            issues: r.issues,
          }));
    if (retried) {
      console.info(
        `generate-plan: retry triggered. Final validation valid=${validation.valid}, ` +
          `warnings=${validationWarnings.length}`,
      );
    }

    // Prepend coachingNote to the plan summary so it always surfaces in the
    // plan-detail view. Guard against accidental double-prepend if the LLM
    // already echoed it (schema asks it to).
    const note = feasibility.coachingNote;
    const existingSummary = (plan.summary || "").trim();
    if (note && !existingSummary.toLowerCase().includes(note.toLowerCase().slice(0, 40))) {
      plan.summary = existingSummary ? `${note}\n\n${existingSummary}` : note;
    } else if (!existingSummary) {
      plan.summary = note;
    }

    // 6. Calculate end date from plan
    const numWeeks = plan.weeks.length;
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + numWeeks * 7 - 1);
    const endDateStr = endDate.toISOString().split("T")[0];

    // 7. Insert training_plan
    const { data: tpData, error: tpErr } = await db.from("training_plans").insert({
      profile_id,
      name: plan.plan_name || body.goal_text || "Träningsplan",
      goal_type: body.goal_type,
      goal_text: body.goal_text,
      goal_date: body.goal_date || null,
      constraints: body.constraints,
      baseline: body.baseline,
      preferences: body.preferences,
      start_date: startDate,
      end_date: endDateStr,
      status: "active",
      generation_model: LLM_PROVIDER === "gemini" ? "gemini-2.0-flash" : LLM_PROVIDER === "anthropic" ? "claude-sonnet" : "gpt-4o",
    }).select("id").single();

    if (tpErr) {
      console.error("generate-plan: insert training_plan failed", tpErr);
      throw new Error("db_insert_failed");
    }
    const planId = tpData.id;

    // 8. Insert weeks and workouts
    for (const week of plan.weeks) {
      const { data: weekData, error: weekErr } = await db.from("plan_weeks").insert({
        plan_id: planId,
        week_number: week.week_number,
        phase: week.phase,
        target_hours: week.target_hours,
        target_sessions: week.target_sessions,
        notes: week.notes,
      }).select("id").single();

      if (weekErr) {
        console.error("generate-plan: insert plan_week failed", week.week_number, weekErr);
        throw new Error("db_insert_failed");
      }

      const weekStartDate = new Date(startDate);
      weekStartDate.setDate(weekStartDate.getDate() + (week.week_number - 1) * 7);

      const workoutRows = week.workouts.map((w, idx) => {
        const wDate = new Date(weekStartDate);
        wDate.setDate(wDate.getDate() + w.day_of_week);
        return {
          plan_week_id: weekData.id,
          workout_date: wDate.toISOString().split("T")[0],
          day_of_week: w.day_of_week,
          activity_type: w.activity_type,
          label: w.label,
          description: w.description,
          target_duration_minutes: w.target_duration_minutes || 0,
          target_distance_km: w.target_distance_km || null,
          intensity_zone: w.intensity_zone || null,
          is_rest: w.is_rest,
          sort_order: idx,
        };
      });

      const { error: woErr } = await db.from("plan_workouts").insert(workoutRows);
      if (woErr) {
        console.error("generate-plan: insert plan_workouts failed", week.week_number, woErr);
        throw new Error("db_insert_failed");
      }
    }

    // 9. Return success
    return new Response(
      JSON.stringify({
        plan_id: planId,
        plan_name: plan.plan_name,
        summary: plan.summary,
        weeks: numWeeks,
        start_date: startDate,
        end_date: endDateStr,
        validation_warnings: validationWarnings,
        profile,
        feasibility,
      }),
      {
        status: 200,
        headers: { ...corsHeaders(req), "Content-Type": "application/json" },
      }
    );

  } catch (err) {
    console.error("generate-plan error:", err);
    // Never leak raw error details (DB constraint names, upstream bodies, etc.)
    // to the client. Use stable generic codes; log everything server-side.
    return new Response(
      JSON.stringify({ error: "internal_error" }),
      { status: 500, headers: { ...corsHeaders(req), "Content-Type": "application/json" } }
    );
  }
});
