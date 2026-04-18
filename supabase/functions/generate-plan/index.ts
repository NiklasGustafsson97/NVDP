import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

const SYSTEM_PROMPT = `You are an elite endurance coach trained in Nils van der Poel's methodology and modern exercise physiology. You generate personalized, periodized training plans with extreme specificity.

ALL output must be valid JSON matching the schema below. No markdown, no commentary outside the JSON object.

## TRAINING PHILOSOPHY (Nils van der Poel / polarized model)

The foundation is polarized training: almost all volume at Z1-Z2 (genuinely easy), with quality sessions either at Z4 (threshold) or Z5 (VO2max). Nothing in between. Volume is the primary driver of aerobic adaptation. Quality sessions are the spice, not the meal.

"Distansträning" (Z2 endurance) must feel truly easy. The athlete must be able to hold a full conversation. If in doubt, go slower. Long Z2 sessions build the aerobic engine more effectively than moderate-hard sessions.

Quality sessions must be structured with exact intervals, recovery, and pace/HR targets. "Intervaller" alone is never an acceptable description.

## CORE PRINCIPLES (hard constraints)

1. INTENSITY DISTRIBUTION: 80% of weekly volume at Z1-Z2, 20% at Z4-Z5. Zero Z3 in base phase. Minimal Z3 in build phase.

2. PROGRESSIVE OVERLOAD: Max 10% weekly volume increase. Long session increases max 1-2 km/week (running) or 15 min/week (cycling).

3. PERIODIZATION:
   - Race goals: Base → Build → Peak → Taper
   - Fitness goals: Base → Build → Maintain (repeating Build-Deload)
   - Base phase (30-40% of plan): Only Z1-Z2 + strides. ONE threshold session/week max. Build volume.
   - Build phase (40-50%): TWO quality sessions/week (1× VO2max intervals, 1× threshold/tempo). Maintain Z2 volume.
   - Peak phase (10-15%): Race-pace work, reduce volume 10-20%, maintain intensity.
   - Taper: Cut volume 40-60%, keep 2 short quality sessions, lots of rest.

4. DELOAD: Every 4th week. Volume at 60-70%. Maintain session count, cut duration. Keep 1 short quality session. Phase label: "deload".

5. QUALITY SESSION TYPES (use these, vary across weeks):
   - "Tröskelpass": 4-6 × 4-5 min at Z4 (threshold HR/pace), 2-3 min easy jog recovery
   - "Tempopass": 15-30 min continuous Z4 (threshold pace)
   - "VO2max-intervaller": 4-6 × 3 min at Z5 (max aerobic, 3 min recovery) or 8-10 × 1 min at Z5 (1 min recovery)
   - "Fartlek": 6-8 × 2 min hard / 2 min easy, unstructured feel
   - "Progressivt långpass": Long Z2 with final 3-5 km accelerating through Z3 into Z4

6. EASY DAY STRUCTURE: Z2 running at conversational pace + 6-10 × 15-20s strides (fast but relaxed, full recovery between). Strides activate fast-twitch fibers without fatigue.

7. LONG SESSION: Sacred session of the week. Builds by 1-2 km/week. Always Z2 except in build phase where progressive finish is permitted. Cap at ~30% of weekly volume.

8. CROSS-TRAINING: Cycling, skiing, and erg at Z2 count as aerobic volume. Use to add volume without running load. Place on easy days or as second session.

9. REST: Minimum 1 full rest day/week (2 for beginners). Rest day before or after the hardest session.

10. WEEK PATTERN: Never two hard days in a row. Example: Rest - Quality - Easy - Quality - Easy+strides - Long - Rest.

11. CONCURRENT STRENGTH: If included, place on the same day as a quality endurance session (AM endurance, PM strength) or on an easy day. Max 1 leg-heavy session/week.

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

Quality sessions should vary across weeks within the same phase. Do not repeat the exact same workout every week. Rotate between threshold intervals, tempo runs, VO2max intervals, fartlek, and progressive long runs.

Example 4-week build rotation:
- Week 1: Tröskelintervaller (4×5 min Z4) + Tempopass (20 min Z4)
- Week 2: VO2max (5×3 min Z5) + Fartlek (8×2 min)
- Week 3: Tröskelintervaller (5×5 min Z4) + Tempopass (25 min Z4)
- Week 4 (deload): Kort fartlek (4×2 min) only

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
- Descriptions max 120 characters.`;

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

async function callOpenAI(userPrompt: string): Promise<LLMPlan> {
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
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
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

async function callAnthropic(userPrompt: string): Promise<LLMPlan> {
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
      messages: [
        { role: "user", content: userPrompt + "\n\nRespond ONLY with valid JSON matching the output schema. No markdown fences." },
      ],
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

async function callGemini(userPrompt: string): Promise<LLMPlan> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: userPrompt + "\n\nRespond ONLY with valid JSON matching the output schema. No markdown fences." }] }],
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

async function generatePlan(userPrompt: string): Promise<LLMPlan> {
  if (LLM_PROVIDER === "gemini" && GEMINI_API_KEY) {
    return callGemini(userPrompt);
  }
  if (LLM_PROVIDER === "anthropic" && ANTHROPIC_API_KEY) {
    return callAnthropic(userPrompt);
  }
  if (OPENAI_API_KEY) {
    return callOpenAI(userPrompt);
  }
  if (GEMINI_API_KEY) {
    return callGemini(userPrompt);
  }
  throw new Error("No LLM API key configured. Set GEMINI_API_KEY (free), OPENAI_API_KEY, or ANTHROPIC_API_KEY in Edge Function secrets.");
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

function buildUserPrompt(req: PlanRequest, workoutHistory: string): string {
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

  return `Generate a ${numWeeks}-week training plan starting ${startDate}.

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
Önskade vilodagar: ${restDays}

## RECENT WORKOUT HISTORY (last 4 weeks)
${workoutHistory || "No logged workouts available."}

Generate the complete plan as JSON.`;
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
      let editPromptPreview: string;
      const history = body.conversation_history || [];
      if (history.length > 0) {
        editPromptPreview = history.map((m: { role: string; content: string }) => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${m.content}`).join('\n\n') +
          `\n\nUSER: "${body.instruction}"\n\nCURRENT PLAN:\n${JSON.stringify(body.current_plan, null, 2)}\n\nApply all the user's instructions. Return the COMPLETE modified plan as JSON.`;
      } else {
        editPromptPreview = `You have an existing training plan (JSON below). The user wants to modify it.\n\nUSER INSTRUCTION: "${body.instruction}"\n\nCURRENT PLAN:\n${JSON.stringify(body.current_plan, null, 2)}\n\nApply the user's instruction to the plan. Return the COMPLETE modified plan in the same JSON format. Keep everything the user didn't ask to change. Respond ONLY with valid JSON.`;
      }

      const previewPlan = await generatePlan(editPromptPreview);
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

    // 5. Build prompt and call LLM
    const startDate = body.start_date || new Date().toISOString().split("T")[0];
    const userPrompt = buildUserPrompt(body, historyStr);
    const plan = await generatePlan(userPrompt);

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
