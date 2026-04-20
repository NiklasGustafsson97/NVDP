import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ═══════════════════════════════════════════════════════════════════
//  ASSESS-FEASIBILITY
//
//  Deterministic endpoint (no LLM). Takes a subset of the generate-plan
//  payload (goal + baseline + constraints) and returns:
//    - CapacityProfile (tier, qualityPerPhase, qualityCapPerWeek, …)
//    - FeasibilityAssessment (riskLevel, factors, coachingNote, …)
//
//  Used by the wizard to warn the user BEFORE we commit LLM tokens to
//  generating a full plan they're about to reject. Authenticated so we
//  can rate-limit and scope to the calling user, but it never writes to
//  the database.
//
//  The capacity / assessment code below is copied from
//  _shared/capacity.ts to keep this file dashboard-deployable (Supabase
//  edge functions don't support relative imports via the web editor).
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

interface FeasibilityFactor { id: string; severity: Severity; text: string; }

interface FeasibilityAssessment {
  riskLevel: RiskLevel;
  factors: FeasibilityFactor[];
  weeksToGoal: number | null;
  rampWarning: string | null;
  coachingNote: string;
  recommendedAdjustments: string[];
  projected?: { projected5kFromRecent: string | null; targetPaceFromGoal: string | null };
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
const TIER_QUALITY_CAP: Record<Tier, number> = { novice: 1, developing: 2, intermediate: 3, advanced: 3 };

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
  if (roomForQuality < qualityCapPerWeek) qualityCapPerWeek = roomForQuality;
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

// ─────────────────────────────────────────────────────────────────────
//  HTTP handler
// ─────────────────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const APP_ORIGINS = (Deno.env.get("APP_ORIGINS") || "https://niklasgustafsson97.github.io")
  .split(",").map((s) => s.trim()).filter(Boolean);

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  const allow = APP_ORIGINS.includes(origin) ? origin : APP_ORIGINS[0] || "null";
  return {
    "Access-Control-Allow-Origin": allow,
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function jsonResponse(req: Request, body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return jsonResponse(req, { error: "method_not_allowed" }, 405);

  try {
    // Authenticate — this endpoint is free (no LLM cost) but we still want
    // to scope to logged-in users so nobody can probe it anonymously.
    const authHeader = req.headers.get("authorization");
    if (!authHeader) return jsonResponse(req, { error: "unauthorized" }, 401);
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return jsonResponse(req, { error: "unauthorized" }, 401);

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return jsonResponse(req, { error: "invalid_body" }, 400);
    }

    // Minimal payload contract: baseline + goal + constraints.sessions_per_week.
    // We accept the same shape the wizard already sends to generate-plan so
    // the client can reuse the payload without reshaping.
    const baseline = body.baseline || {};
    const constraints = body.constraints || {};
    const startDate = body.start_date || new Date().toISOString().split("T")[0];
    const inputs: CapacityInputs = {
      baseline: {
        sessions_per_week: Number(baseline.sessions_per_week) || 0,
        hours_per_week: Number(baseline.hours_per_week) || 0,
        longest_session_minutes: Number(baseline.longest_session_minutes) || 0,
        fitness_level: String(baseline.fitness_level || ""),
        recent_5k: baseline.recent_5k || null,
        recent_10k: baseline.recent_10k || null,
        easy_pace: baseline.easy_pace || null,
      },
      goal: {
        type: String(body.goal_type || ""),
        text: String(body.goal_text || ""),
        date: body.goal_date || null,
      },
      start_date: startDate,
      weekly_session_cap: Number(constraints.sessions_per_week) || 0,
    };

    const profile = profileCapacity(inputs);
    const feasibility = assessFeasibility(inputs, profile);

    return jsonResponse(req, { profile, feasibility }, 200);
  } catch (e) {
    console.error("assess-feasibility error:", e);
    return jsonResponse(req, { error: "internal_error" }, 500);
  }
});
