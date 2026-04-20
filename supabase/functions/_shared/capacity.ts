// Capacity profiling + feasibility assessment for training plans.
//
// Why this exists: the system used to hardcode "every user needs ≥2 quality
// sessions per week in build phase". That's dangerous for a beginner who
// runs twice a week and will overtrain, and conservative for an advanced
// athlete who could handle 3. This module replaces those hardcoded minimums
// with a tiered calculation driven by:
//   - baseline volume (sessions/week, hours/week)
//   - declared fitness level
//   - the user's weekly session cap (they can't do 3 quality if they only
//     run 3 times total — there has to be room for ≥2 Z2 recovery days)
//
// The second responsibility is REALISM: compare the user's current form to
// the demands of their stated goal and produce a risk level + coaching note
// so the wizard can warn them before generating a plan they can't execute.
// Everything here is deterministic — no LLM calls, no side effects. The
// goal is to ship a hard-to-argue-with numerical baseline that the LLM
// (and the UI) can both reference.

export type Phase = "base" | "build" | "peak" | "taper" | "deload" | "recovery";
export type Tier = "novice" | "developing" | "intermediate" | "advanced";
export type RiskLevel = "comfortable" | "ambitious" | "aggressive" | "unrealistic";
export type Severity = "ok" | "warn" | "high";

export interface CapacityInputs {
  baseline: {
    sessions_per_week: number;
    hours_per_week: number;
    longest_session_minutes: number;
    fitness_level: string;
    recent_5k?: string | null;
    recent_10k?: string | null;
    easy_pace?: string | null;
  };
  goal: {
    type: string;
    text: string;
    date?: string | null;
  };
  start_date: string;
  weekly_session_cap: number;
}

export interface CapacityProfile {
  tier: Tier;
  weeklyVolumeKm: number | null;
  qualityCapPerWeek: number;
  qualityPerPhase: Record<Phase, number>;
  rationale: string;
}

export interface FeasibilityFactor {
  id: string;
  severity: Severity;
  text: string;
}

export interface FeasibilityAssessment {
  riskLevel: RiskLevel;
  factors: FeasibilityFactor[];
  weeksToGoal: number | null;
  rampWarning: string | null;
  coachingNote: string;
  recommendedAdjustments: string[];
  projected?: {
    // From Riegel projection — helpful for the UI even if pace-gap isn't
    // strictly "high severity".
    projected5kFromRecent: string | null;
    targetPaceFromGoal: string | null;
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Tier detection
// ─────────────────────────────────────────────────────────────────────

function normalizeFitnessLevel(raw: string): Tier {
  const s = (raw || "").toLowerCase().trim();
  if (!s) return "developing";
  if (/nyb|beginner|novice|starta|ny\b/.test(s)) return "novice";
  if (/avanc|advanced|elite|expert|erfaren\s+tr[aä]nar/.test(s)) return "advanced";
  if (/intermediat|medel|mellan|regelbund|vana/.test(s)) return "intermediate";
  if (/developing|utveckling/.test(s)) return "developing";
  // Default: assume developing (3-4 sessions/w of life training).
  return "developing";
}

function tierFromInputs(i: CapacityInputs): Tier {
  const declared = normalizeFitnessLevel(i.baseline.fitness_level);
  const sessions = i.baseline.sessions_per_week || 0;
  const hours = i.baseline.hours_per_week || 0;

  // Volume-based tier estimate — we trust volume more than self-reported
  // level, because people systematically over-rate themselves.
  let volumeTier: Tier;
  if (sessions < 3 || hours < 2.5) volumeTier = "novice";
  else if (sessions < 5 || hours < 4.5) volumeTier = "developing";
  else if (sessions < 6 || hours < 7) volumeTier = "intermediate";
  else volumeTier = "advanced";

  // Take the more conservative of declared vs. volume-derived. We go
  // ONE tier above "developing" if both agree on something higher.
  const order: Tier[] = ["novice", "developing", "intermediate", "advanced"];
  const declaredIdx = order.indexOf(declared);
  const volumeIdx = order.indexOf(volumeTier);
  const minIdx = Math.min(declaredIdx, volumeIdx);
  return order[minIdx];
}

// Base quality-session allocation per phase per tier. These are HARD
// MINIMUMS that the LLM must hit. Higher caps are enforced via
// qualityCapPerWeek so we don't end up with e.g. a novice doing 3 hard
// sessions in a week.
const TIER_QUALITY_MATRIX: Record<Tier, Record<Phase, number>> = {
  novice:       { base: 0, build: 1, peak: 1, deload: 0, taper: 1, recovery: 0 },
  developing:   { base: 1, build: 2, peak: 2, deload: 1, taper: 1, recovery: 0 },
  intermediate: { base: 1, build: 2, peak: 3, deload: 1, taper: 2, recovery: 0 },
  advanced:     { base: 2, build: 3, peak: 3, deload: 1, taper: 2, recovery: 0 },
};

const TIER_QUALITY_CAP: Record<Tier, number> = {
  novice: 1,
  developing: 2,
  intermediate: 3,
  advanced: 3,
};

function estimateWeeklyVolumeKm(i: CapacityInputs): number | null {
  const hours = i.baseline.hours_per_week;
  if (!hours || hours <= 0) return null;
  // Crude km/h conversion by tier; only used for realism checks (not for
  // prescribed paces). Novice: 8 km/h, developing: 9, intermediate: 10,
  // advanced: 11. This doesn't even need to be accurate — it just lets us
  // say "you currently do ~24 km/week, marathon peaks are 50-70 km/week".
  const tier = tierFromInputs(i);
  const kmh = { novice: 8, developing: 9, intermediate: 10, advanced: 11 }[tier];
  return Math.round(hours * kmh);
}

export function profileCapacity(i: CapacityInputs): CapacityProfile {
  const tier = tierFromInputs(i);
  const qualityPerPhase = { ...TIER_QUALITY_MATRIX[tier] };
  let qualityCapPerWeek = TIER_QUALITY_CAP[tier];

  // If the user only has room for e.g. 3 sessions/week, we must leave at
  // least 2 of those as Z2/recovery. Otherwise every day becomes hard.
  const cap = i.weekly_session_cap || i.baseline.sessions_per_week || 3;
  const roomForQuality = Math.max(0, cap - 2);
  if (roomForQuality < qualityCapPerWeek) {
    qualityCapPerWeek = roomForQuality;
  }

  // Clamp qualityPerPhase to the effective cap.
  for (const p of Object.keys(qualityPerPhase) as Phase[]) {
    if (qualityPerPhase[p] > qualityCapPerWeek) {
      qualityPerPhase[p] = qualityCapPerWeek;
    }
  }

  const weeklyVolumeKm = estimateWeeklyVolumeKm(i);
  const rationale =
    `Tier "${tier}" baserat på ${i.baseline.sessions_per_week || 0} pass/v och ${i.baseline.hours_per_week || 0} tim/v ` +
    `(självskattad nivå: ${i.baseline.fitness_level || "ej angiven"}). Max ${qualityCapPerWeek} kvalitetspass/v ` +
    `(behöver minst 2 lugna återhämtningsdagar mellan kvalitet).`;

  return { tier, weeklyVolumeKm, qualityCapPerWeek, qualityPerPhase, rationale };
}

// ─────────────────────────────────────────────────────────────────────
//  Feasibility assessment
// ─────────────────────────────────────────────────────────────────────

interface GoalShape {
  distanceKm: number | null; // 5, 10, 21.0975, 42.195 if race
  kind: "race" | "fitness" | "other";
  peakWeeklyKm: number | null;
  minWeeks: { novice: number; developing: number; intermediate: number; advanced: number } | null;
  targetSeconds: number | null; // from parsed goal time
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
    : distanceKm
      ? "race"
      : /form|h[aä]lsa|m[aå]|fitness|viktminskning|styrka/.test(t)
        ? "fitness"
        : "other";

  // Parse "sub 3:30", "under 1:45", "1:45:00", "mål: 20:30" etc.
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

// Riegel: T2 = T1 × (D2/D1)^1.06. We use it to project a marathon time
// from a 5k (T1) — the exponent makes this a known-conservative estimate.
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

export function assessFeasibility(i: CapacityInputs, p: CapacityProfile): FeasibilityAssessment {
  const factors: FeasibilityFactor[] = [];
  const adjustments: string[] = [];

  const goal = parseGoalText(i.goal.text, i.goal.type);
  const weeksToGoal = i.goal.date ? weeksBetween(i.start_date, i.goal.date) : null;

  // ─── Volume gap ─────────────────────────────────────────────────────
  if (goal.peakWeeklyKm && p.weeklyVolumeKm !== null) {
    const gap = goal.peakWeeklyKm - p.weeklyVolumeKm;
    const gapPct = gap / goal.peakWeeklyKm;
    if (gapPct >= 0.6) {
      factors.push({
        id: "volume_gap_high",
        severity: "high",
        text: `Din nuvarande volym ~${p.weeklyVolumeKm} km/v är långt under vad målet typiskt kräver (toppvecka ~${goal.peakWeeklyKm} km/v). Gapet är ${Math.round(gapPct * 100)}%.`,
      });
      adjustments.push(`Bygg grundvolym till minst ${Math.round(goal.peakWeeklyKm * 0.6)} km/v innan du kör mer än 2 kvalitetspass per vecka.`);
    } else if (gapPct >= 0.35) {
      factors.push({
        id: "volume_gap_warn",
        severity: "warn",
        text: `Gapet till typisk toppvolym (~${goal.peakWeeklyKm} km/v) är ${Math.round(gapPct * 100)}%. Gör det men ha en längre basfas.`,
      });
    }
  }

  // ─── Time gap ──────────────────────────────────────────────────────
  if (goal.minWeeks && weeksToGoal !== null) {
    const req = goal.minWeeks[p.tier];
    if (weeksToGoal < req - 2) {
      factors.push({
        id: "time_gap_high",
        severity: "high",
        text: `Du har ${weeksToGoal} veckor till måldatumet men för din nivå (${p.tier}) rekommenderas minst ${req} veckor för ett seriöst bygge.`,
      });
      adjustments.push(`Skjut fram loppet ${req - weeksToGoal}+ veckor, eller välj ett kortare lopp som första delmål.`);
    } else if (weeksToGoal < req) {
      factors.push({
        id: "time_gap_warn",
        severity: "warn",
        text: `${weeksToGoal} veckor till målet — strax under rekommenderade ${req} veckor för nivå "${p.tier}". Planen blir komprimerad.`,
      });
    }
  }

  // ─── Pace gap (only if we have recent_5k and goal has a target time) ─
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
        factors.push({
          id: "pace_gap_high",
          severity: "high",
          text: `Baserat på din senaste 5km (${projected5k}) projiceras ~${formatSeconds(projectedGoalSec)} på måldistansen enligt Riegel. Ditt måltid ${targetPace} är ${Math.round(speedGap * 100)}% snabbare — mycket ambitiöst.`,
        });
        adjustments.push(`Överväg ett mer realistiskt måltid runt ${formatSeconds(projectedGoalSec * 0.97)} (motsvarar ~3% förbättring från nuvarande 5k-form).`);
      } else if (speedGap >= 0.05) {
        factors.push({
          id: "pace_gap_warn",
          severity: "warn",
          text: `Måltiden ${targetPace} är ${Math.round(speedGap * 100)}% snabbare än vad en rak Riegel-projicering från din 5km (${projected5k}) ger (~${formatSeconds(projectedGoalSec)}). Nåbart men kräver disciplinerad kvalitet.`,
        });
      }
    }
  }

  // ─── Ramp warning ──────────────────────────────────────────────────
  let rampWarning: string | null = null;
  if (goal.peakWeeklyKm && p.weeklyVolumeKm !== null && weeksToGoal && weeksToGoal > 0) {
    const requiredRampPct = ((goal.peakWeeklyKm - p.weeklyVolumeKm) / p.weeklyVolumeKm) / weeksToGoal;
    if (requiredRampPct > 0.10) {
      rampWarning =
        `För att nå ~${goal.peakWeeklyKm} km/v på ${weeksToGoal} veckor krävs ~${Math.round(requiredRampPct * 100)}% veckoökning från nuvarande ${p.weeklyVolumeKm} km/v. ` +
        `Det överskrider 10 %-regeln och ökar skaderisk (ACWR >1.5).`;
      factors.push({ id: "ramp_warning", severity: "warn", text: rampWarning });
    }
  }

  // ─── Aggregate to risk level ───────────────────────────────────────
  const highCount = factors.filter((f) => f.severity === "high").length;
  const warnCount = factors.filter((f) => f.severity === "warn").length;
  let riskLevel: RiskLevel;
  if (highCount >= 2) riskLevel = "unrealistic";
  else if (highCount === 1) riskLevel = "aggressive";
  else if (warnCount >= 2) riskLevel = "ambitious";
  else if (warnCount === 1) riskLevel = "ambitious";
  else riskLevel = "comfortable";

  // ─── Coaching note (Swedish, 1-3 sentences) ─────────────────────────
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
    riskLevel,
    factors,
    weeksToGoal,
    rampWarning,
    coachingNote,
    recommendedAdjustments: adjustments,
    projected: (projected5k || targetPace) ? { projected5kFromRecent: projected5k, targetPaceFromGoal: targetPace } : undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Pretty-print helpers for prompt injection
// ─────────────────────────────────────────────────────────────────────

export function formatCapacityForPrompt(p: CapacityProfile, f: FeasibilityAssessment): string {
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

Coaching note (echo this in the plan's "summary" field, prepended if the summary has other content):
"${f.coachingNote}"

ADAPTATION RULES:
- If risk is HIGH or VERY HIGH: prioritize ONE primary quality session per week (threshold), skip VO2max until volume catches up, cap weekly volume ramp at 10%/w.
- If risk is LOW: use the full quality-per-phase counts above.
- NEVER exceed ${p.qualityCapPerWeek} quality sessions in any week regardless of phase — that cap is derived from the user's session budget.
`;
}
