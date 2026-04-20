import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ═══════════════════════════════════════════════════════════════════
//  WEEKLY TEMPLATE VALIDATION HELPERS (inlined from
//  _shared/plan-validation.ts so this file deploys standalone via the
//  Supabase dashboard.)
//
//  We treat any day whose label or description mentions Z4/Z5/threshold/
//  VO2max/fartlek/tempo as a "quality" session.
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

const QUALITY_ZONES = new Set(["Z4", "Z5", "MIXED"]);

// ═══════════════════════════════════════════════════════════════════
//  CAPACITY PROFILING (inlined subset from _shared/capacity.ts).
//
//  Weekly templates don't need the full feasibility assessment — we just
//  need the qualityPerPhase map so a beginner's "standard week" requires
//  only 1 quality session instead of 2.
// ═══════════════════════════════════════════════════════════════════

type Phase = "base" | "build" | "peak" | "taper" | "deload" | "recovery";
type Tier = "novice" | "developing" | "intermediate" | "advanced";

interface MiniBaseline {
  sessions_per_week?: number;
  hours_per_week?: number;
  fitness_level?: string;
}

interface CapacityProfile {
  tier: Tier;
  qualityCapPerWeek: number;
  qualityPerPhase: Record<Phase, number>;
}

const TIER_QUALITY_MATRIX: Record<Tier, Record<Phase, number>> = {
  novice:       { base: 0, build: 1, peak: 1, deload: 0, taper: 1, recovery: 0 },
  developing:   { base: 1, build: 2, peak: 2, deload: 1, taper: 1, recovery: 0 },
  intermediate: { base: 1, build: 2, peak: 3, deload: 1, taper: 2, recovery: 0 },
  advanced:     { base: 2, build: 3, peak: 3, deload: 1, taper: 2, recovery: 0 },
};
const TIER_QUALITY_CAP: Record<Tier, number> = { novice: 1, developing: 2, intermediate: 3, advanced: 3 };

function normalizeFitnessLevel(raw: string): Tier {
  const s = (raw || "").toLowerCase().trim();
  if (!s) return "developing";
  if (/nyb|beginner|novice|starta|ny\b/.test(s)) return "novice";
  if (/avanc|advanced|elite|expert|erfaren\s+tr[aä]nar/.test(s)) return "advanced";
  if (/intermediat|medel|mellan|regelbund|vana/.test(s)) return "intermediate";
  if (/developing|utveckling/.test(s)) return "developing";
  return "developing";
}

function profileCapacityLite(baseline: MiniBaseline, weeklySessionCap?: number | null): CapacityProfile {
  const declared = normalizeFitnessLevel(baseline.fitness_level || "");
  const sessions = baseline.sessions_per_week || 0;
  const hours = baseline.hours_per_week || 0;
  let volumeTier: Tier;
  if (sessions < 3 || hours < 2.5) volumeTier = "novice";
  else if (sessions < 5 || hours < 4.5) volumeTier = "developing";
  else if (sessions < 6 || hours < 7) volumeTier = "intermediate";
  else volumeTier = "advanced";
  const order: Tier[] = ["novice", "developing", "intermediate", "advanced"];
  const tier = order[Math.min(order.indexOf(declared), order.indexOf(volumeTier))];

  const qualityPerPhase = { ...TIER_QUALITY_MATRIX[tier] };
  let qualityCapPerWeek = TIER_QUALITY_CAP[tier];
  const cap = weeklySessionCap || sessions || 3;
  const roomForQuality = Math.max(0, cap - 2);
  if (roomForQuality < qualityCapPerWeek) qualityCapPerWeek = roomForQuality;
  for (const p of Object.keys(qualityPerPhase) as Phase[]) {
    if (qualityPerPhase[p] > qualityCapPerWeek) qualityPerPhase[p] = qualityCapPerWeek;
  }
  return { tier, qualityCapPerWeek, qualityPerPhase };
}

function expectedQualityForPhase(phase: string, profile?: CapacityProfile): number {
  const p = (phase || "").toLowerCase() as Phase;
  if (profile && profile.qualityPerPhase[p] !== undefined) {
    return profile.qualityPerPhase[p];
  }
  // Legacy defaults if no profile is available.
  if (p === "base") return 1;
  if (p === "build") return 2;
  if (p === "peak") return 2;
  if (p === "deload") return 1;
  if (p === "taper") return 1;
  if (p === "recovery") return 0;
  return 1;
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

function validateWeeklyTemplate(
  days: { is_rest: boolean; description?: string | null; label?: string | null }[],
  phase: string = "build",
  profile?: CapacityProfile,
): WeekValidation {
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
  return validateWeek({ week_number: 1, phase, workouts }, profile);
}

function buildTemplateRetryMessage(v: WeekValidation): string {
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

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") || "";
const OPENAI_BASE_URL = Deno.env.get("OPENAI_BASE_URL") || "https://api.openai.com/v1";
const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini";
const APP_ORIGINS = (Deno.env.get("APP_ORIGINS") || "https://niklasgustafsson97.github.io")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Per-user daily quota for this (paid, LLM-backed) endpoint.
const WEEKLY_TEMPLATE_AI_DAILY_LIMIT = 20;
// Hard cap on user-supplied prompt length to prevent prompt-stuffing abuse.
const MAX_PROMPT_CHARS = 4000;

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  const allow = APP_ORIGINS.includes(origin) ? origin : APP_ORIGINS[0] || "null";
  return {
    "Access-Control-Allow-Origin": allow,
    "Vary": "Origin",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function jsonResponse(req: Request, body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

const DAY_NAMES = ["Måndag", "Tisdag", "Onsdag", "Torsdag", "Fredag", "Lördag", "Söndag"];

const SYSTEM_PROMPT = `You are an elite endurance coach trained in Nils van der Poel's methodology and Stephen Seiler's polarized training research. You design weekly training templates (recurring 7-day patterns).

Output STRICT JSON only — no markdown, no commentary. Schema:
{
  "days": [
    { "day_of_week": 0-6 (0=Monday, 6=Sunday), "is_rest": boolean, "label": string|null, "description": string|null },
    ... (exactly 7 entries, one per day_of_week 0..6)
  ]
}

## TRAINING PHILOSOPHY (polarized 80/20)

~80% of weekly volume at Z1-Z2 (genuinely easy, conversational), ~20% at Z4-Z5 (quality). Zero or near-zero Z3 — Z3 is the dead zone. Quality sessions are the spice that drives adaptation, but the spice MUST be present every week.

## QUALITY SESSIONS — HARD MINIMUM (not maximum)

A standard week MUST contain at least 2 quality sessions (1× threshold + 1× VO2max OR 1× threshold + 1× fartlek). A pure-recovery week MUST still contain 1 short quality session unless the user explicitly asks for zero. A week where every non-rest day is pure Z2 is FORBIDDEN — that violates polarized training.

A "quality session" is a session whose label or description clearly contains a Z4 or Z5 work block (threshold, tempo, intervaller, VO2max, fartlek).

## SESSION ARCHETYPE LIBRARY (use these — copy structure verbatim)

Quality sessions:
- Tröskelintervaller: "15 min uppvärm Z2 → 4-6 × 5 min Z4 (2 min lugn jogg) → 10 min nedvarvning"
- Tempopass:          "15 min uppvärm Z2 → 20-30 min kontinuerligt Z4 → 10 min nedvarvning"
- VO2max långa:       "15 min uppvärm Z2 → 5 × 3 min Z5 (3 min lugn jogg) → 10 min nedvarvning"
- VO2max korta:       "15 min uppvärm Z2 → 8-10 × 1 min Z5 (1 min lugn jogg) → 10 min nedvarvning"
- Fartlek:            "10 min uppvärm Z2 → 8 × 2 min Z4-Z5 / 2 min lugnt → 10 min nedvarvning"
- Backintervaller:    "15 min uppvärm Z2 → 8-10 × 60-90s uppförsbacke ~Z5 (jogg ner) → 10 min nedvarvning"

Easy sessions:
- Distans Z2:           "8 km lugn Z2 (pratstempo). Ska kännas enkelt."
- Distans Z2 + strides: "6 km lugn Z2 + 6-8 × 20s strides på platt mark"
- Långpass Z2:          "12-15 km långpass Z2. Aldrig öka tempo."
- Återhämtning Z1:      "30-40 min mycket lugn Z1. Pulsen aldrig över 65% av max."
- Cross-training Z2:    "60-90 min cykel Z2. Bra alternativ för aerob volym."

## WEEK PATTERN RULES

- "label" = short pass name in Swedish (e.g. "Distans Z2", "Tröskelpass", "VO2max-intervaller", "Långpass", "Vila")
- "description" = specific structure: distance/time, zone, reps × duration × recovery for intervals
- Always include at least 1 rest day (is_rest: true, label: null, description: null)
- Long session on Saturday or Sunday by default
- NEVER two quality sessions on consecutive days
- Place quality sessions on Tuesday + Thursday or Tuesday + Friday by default
- Be SPECIFIC: km, time, zones, structure. Never generic ("intervaller" alone is FORBIDDEN)

## ANTI-PATTERN CHECKLIST (will be rejected by validation)

FORBIDDEN: a 7-day template where every non-rest day is just "Distans Z2" or any single-zone Z2 description.
FORBIDDEN: quality session description shorter than 40 characters.
FORBIDDEN: a quality day described only as "Intervaller" or "Tröskelpass" without reps × duration × zone × recovery.
FORBIDDEN: two quality sessions on consecutive days.

## EXAMPLE (5-session week with 2 quality sessions)

Måndag: Vila
Tisdag: Tröskelintervaller — "15 min uppvärm Z2 → 5×5 min Z4 (2 min lugn jogg) → 10 min nedvarvning"
Onsdag: Distans Z2 — "6 km lugn Z2 + 6×20s strides"
Torsdag: VO2max — "15 min uppvärm Z2 → 5×3 min Z5 (3 min vila) → 10 min nedvarvning"
Fredag: Vila eller lätt cykel
Lördag: Distans Z2 — "8 km lugn Z2 (pratstempo)"
Söndag: Långpass — "14 km långpass Z2 (lugnt, jämnt)"

The user will give you free-text instructions. They may also provide a current template to start from — modify it accordingly while preserving the 2-quality-sessions rule. If they ask for a fresh schedule, build one from scratch following the rules above.`;

async function callOpenAI(messages: { role: string; content: string }[]): Promise<string> {
  const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages,
      response_format: { type: "json_object" },
      temperature: 0.7,
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    // Log full upstream error for diagnostics; do NOT return to client.
    console.error(`weekly-template-ai: OpenAI ${res.status}: ${txt.slice(0, 500)}`);
    throw new Error("upstream_ai_error");
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

// Parse and normalize the AI's JSON response into our DayTemplate[] shape.
// Returns null if the JSON is malformed or doesn't have exactly 7 days.
interface DayTemplate {
  day_of_week: number;
  is_rest: boolean;
  label: string | null;
  description: string | null;
}

function parseTemplateResponse(raw: string): DayTemplate[] | null {
  let parsed: { days?: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(raw);
  } catch (_e) {
    console.error("weekly-template-ai: invalid AI JSON", raw.slice(0, 300));
    return null;
  }
  if (!Array.isArray(parsed?.days) || parsed.days.length !== 7) {
    console.error("weekly-template-ai: malformed days", parsed);
    return null;
  }
  return parsed.days.map((d: Record<string, unknown>) => ({
    day_of_week: Number(d.day_of_week),
    is_rest: Boolean(d.is_rest),
    label: d.is_rest ? null : ((d.label as string) || null),
    description: d.is_rest ? null : ((d.description as string) || null),
  })).sort((a, b) => a.day_of_week - b.day_of_week);
}

async function checkAndIncrementRateLimit(
  db: ReturnType<typeof createClient>,
  userId: string,
): Promise<boolean> {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const windowStart = today.toISOString();

  const { data: row } = await db
    .from("rate_limits")
    .select("count")
    .eq("user_id", userId)
    .eq("bucket", "weekly_template_ai_daily")
    .eq("window_start", windowStart)
    .maybeSingle();

  const current = row?.count ?? 0;
  if (current >= WEEKLY_TEMPLATE_AI_DAILY_LIMIT) return false;

  await db.from("rate_limits").upsert(
    {
      user_id: userId,
      bucket: "weekly_template_ai_daily",
      window_start: windowStart,
      count: current + 1,
    },
    { onConflict: "user_id,bucket,window_start" },
  );
  return true;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return jsonResponse(req, { error: "method_not_allowed" }, 405);

  try {
    if (!OPENAI_API_KEY) {
      console.error("weekly-template-ai: OPENAI_API_KEY not configured");
      return jsonResponse(req, { error: "internal_error" }, 500);
    }

    // ── Authenticate caller ────────────────────────────────────────────────
    const authHeader = req.headers.get("authorization");
    if (!authHeader) return jsonResponse(req, { error: "unauthorized" }, 401);
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return jsonResponse(req, { error: "unauthorized" }, 401);

    // ── Rate limit ────────────────────────────────────────────────────────
    const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const allowed = await checkAndIncrementRateLimit(db, user.id);
    if (!allowed) return jsonResponse(req, { error: "rate_limited" }, 429);

    // ── Parse + validate input ────────────────────────────────────────────
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return jsonResponse(req, { error: "invalid_body" }, 400);
    }
    const userPromptRaw = (body.prompt || "").toString().trim();
    if (!userPromptRaw) return jsonResponse(req, { error: "missing_prompt" }, 400);
    if (userPromptRaw.length > MAX_PROMPT_CHARS) {
      return jsonResponse(req, { error: "prompt_too_long" }, 400);
    }
    const userPrompt = userPromptRaw;
    const currentTemplate = Array.isArray(body.current_template) ? body.current_template : [];
    const maxHr = typeof body.max_hr === "number" ? body.max_hr : null;

    // Build a capacity profile from the optional baseline so quality-session
    // minimums scale to the user's level. Falls back to "developing" defaults
    // if baseline is missing (older clients) — same as pre-capacity behaviour.
    const baseline = (body.baseline && typeof body.baseline === "object") ? body.baseline : {};
    const weeklySessionCap = typeof body.weekly_session_cap === "number" ? body.weekly_session_cap : null;
    const profile = profileCapacityLite(baseline, weeklySessionCap);

    let currentSummary = "Inget nuvarande schema (bygg från scratch).";
    if (currentTemplate.length === 7) {
      currentSummary = "Nuvarande veckoschema:\n" + currentTemplate.map((d: Record<string, unknown>) => {
        const dow = Number(d.day_of_week);
        const name = DAY_NAMES[dow] || `Dag ${dow}`;
        if (d.is_rest) return `- ${name}: Vila`;
        return `- ${name}: ${d.label || "(inget pass)"}${d.description ? " — " + d.description : ""}`;
      }).join("\n");
    }

    // Inline a compact capacity note so the LLM scales quality count to tier.
    const capacityNote =
      `\n## ATHLETE CAPACITY (from baseline)\n` +
      `Tier: ${profile.tier}. ` +
      `Quality sessions/week for a standard template: ${profile.qualityPerPhase.build} ` +
      `(recovery week: ${profile.qualityPerPhase.deload}). ` +
      `Max ${profile.qualityCapPerWeek} kvalitetspass/v — never exceed.`;

    const userMsg = `${currentSummary}
${capacityNote}

${maxHr ? `Användarens maxpuls: ${maxHr} bpm.` : ""}

Önskemål:
${userPrompt}

Returnera ett komplett 7-dagars veckoschema som JSON enligt schemat. Kvalitetspass-antalet MÅSTE matcha athlete capacity ovan — ${profile.qualityPerPhase.build} kvalitetspass i en standardvecka. Bevara delar av nuvarande schema som inte berörs av önskemålet.`;

    // Try once, validate, and on failure re-prompt the model with an
    // explicit fix request. This catches the common all-Z2 drift before we
    // return the template to the user.
    const initialMessages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMsg },
    ];
    const firstRaw = await callOpenAI(initialMessages);
    const firstParsed = parseTemplateResponse(firstRaw);
    if (!firstParsed) {
      return jsonResponse(req, { error: "ai_malformed_response" }, 502);
    }
    let days = firstParsed;
    let validation = validateWeeklyTemplate(days, "build", profile);

    if (!validation.valid) {
      console.warn(
        "weekly-template-ai: validation failed on first attempt, retrying. Issues:",
        validation.issues.join(" | ").slice(0, 500),
      );
      const retryMsg = buildTemplateRetryMessage(validation);
      const secondRaw = await callOpenAI([
        ...initialMessages,
        { role: "assistant", content: firstRaw },
        { role: "user", content: retryMsg },
      ]);
      const secondParsed = parseTemplateResponse(secondRaw);
      if (secondParsed) {
        days = secondParsed;
        validation = validateWeeklyTemplate(days, "build", profile);
        if (!validation.valid) {
          console.warn(
            "weekly-template-ai: validation still failed after retry. Returning anyway.",
            validation.issues.join(" | ").slice(0, 500),
          );
        } else {
          console.info("weekly-template-ai: retry produced a valid template.");
        }
      }
    }

    return jsonResponse(req, {
      days,
      validation_warnings: validation.valid ? [] : validation.issues,
      profile,
    }, 200);
  } catch (e) {
    console.error("weekly-template-ai error:", e);
    return jsonResponse(req, { error: "internal_error" }, 500);
  }
});
