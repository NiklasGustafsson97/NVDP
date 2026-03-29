import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") || "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";
const LLM_PROVIDER = Deno.env.get("LLM_PROVIDER") || "openai";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
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

const SYSTEM_PROMPT = `You are an elite endurance coach and exercise physiologist. You generate personalized, periodized training plans grounded in current sports science.

ALL output must be valid JSON matching the schema below. No markdown, no commentary outside the JSON object.

## CORE PRINCIPLES (hard constraints — never violate)

1. INTENSITY DISTRIBUTION: 80% of weekly volume at Z1-Z2 (conversational pace), 20% at Z4-Z5. Minimize Z3 ("gray zone") except in race-specific build/peak phases.

2. PROGRESSIVE OVERLOAD: Increase total weekly volume by no more than 10% per week. For long sessions, increase duration by no more than 10% per week.

3. PERIODIZATION:
   - Race goals: Base → Build → Peak → Taper
   - Fitness / general goals: Base → Build → Maintain (repeating Build-Deload cycles)
   - Weight loss goals: Base → Build → Maintain with caloric deficit considerations (keep intensity moderate, prioritize volume)
   - Base phase: 30-40% of total plan duration. All Z1-Z2, build aerobic engine.
   - Build phase: 40-50% of plan. Introduce Z4/Z5 intervals, sport-specific work.
   - Peak phase: 10-15% of plan. Highest intensity, race-pace work. Only for race goals.
   - Taper: 1 week for races under 10K, 2 weeks for half-marathon, 3 weeks for marathon+. Reduce volume 40-60%, maintain or slightly increase intensity frequency.

4. DELOAD CYCLE: Every 4th week is a deload week (3 build + 1 deload). Deload reduces volume to 60-70% of previous week. Maintain session count, cut duration. Phase label: "deload".

5. REST DAYS: Minimum 1 full rest day per week (2 for beginners). Place rest day before or after the hardest session of the week.

6. LONG SESSION: One long endurance session per week. Cap at 30% of total weekly volume. Increase by max 10% per week.

7. CONCURRENT TRAINING: When mixing strength and endurance:
   - Hard endurance and heavy strength on the SAME day (AM/PM split) is preferable to placing them on consecutive days.
   - Keep easy endurance days truly easy.
   - Limit leg-heavy strength to 1x/week during high-volume endurance phases.

8. SPECIFICITY: Weight training volume toward the goal activity type. If goal is "Hyrox", include running + functional fitness. If goal is "Halvmarathon", primarily running with cross-training.

9. STARTING POINT: The first week of the plan must match the user's current baseline (weekly hours, sessions, activity mix). Never start higher than current level.

10. WEEK STRUCTURE: Distribute hard and easy days. Never schedule two high-intensity sessions on consecutive days. Pattern: Hard - Easy - Easy - Hard - Easy - Long - Rest (or similar).

## ACTIVITY TYPES (use exactly these Swedish labels)
Löpning, Cykel, Gym, Hyrox, Stakmaskin, Längdskidor, Annat, Vila

## INTENSITY ZONES (use exactly these labels)
Z1, Z2, Z3, Z4, Z5, mixed

## OUTPUT SCHEMA

{
  "plan_name": "string — short descriptive name in Swedish",
  "summary": "string — 1-2 sentence summary of the plan approach in Swedish",
  "weeks": [
    {
      "week_number": 1,
      "phase": "base | build | peak | taper | deload | recovery",
      "target_hours": 4.5,
      "target_sessions": 5,
      "notes": "string — short coaching note for the week in Swedish",
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
          "label": "Z2 löpning",
          "description": "40 min lugn löpning i Z2. Konversationstempo.",
          "target_duration_minutes": 40,
          "target_distance_km": null,
          "intensity_zone": "Z2",
          "is_rest": false
        }
      ]
    }
  ]
}

## RULES FOR OUTPUT
- Every week must have exactly 7 workouts (one per day, day_of_week 0=Monday through 6=Sunday).
- Rest days: activity_type="Vila", is_rest=true, target_duration_minutes=0.
- All text (labels, descriptions, notes) must be in Swedish.
- Descriptions should be specific and actionable: include duration, pace guidance, interval structure if applicable.
- target_hours must equal the sum of all workout durations for that week divided by 60.
- target_sessions counts non-rest workouts.
- For gym sessions: label the session type (e.g., "Styrka överkropp", "Styrka helkropp") but don't prescribe individual exercises.
- Intensity zone for gym sessions: null.
- Keep descriptions concise (under 100 characters).`;

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
    throw new Error(`OpenAI API error ${res.status}: ${err}`);
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
    throw new Error(`Anthropic API error ${res.status}: ${err}`);
  }
  const data = await res.json();
  const text = data.content[0].text;
  const jsonStr = text.replace(/^```json?\n?/, "").replace(/\n?```$/, "").trim();
  return JSON.parse(jsonStr);
}

async function generatePlan(userPrompt: string): Promise<LLMPlan> {
  if (LLM_PROVIDER === "anthropic" && ANTHROPIC_API_KEY) {
    return callAnthropic(userPrompt);
  }
  if (OPENAI_API_KEY) {
    return callOpenAI(userPrompt);
  }
  throw new Error("No LLM API key configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY in Edge Function secrets.");
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
Längsta pass senaste 4v: ${req.baseline.longest_session_minutes} min

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
    return new Response("ok", { headers: corsHeaders() });
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
        headers: { ...corsHeaders(), "Content-Type": "application/json" },
      });
    }

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { ...corsHeaders(), "Content-Type": "application/json" },
      });
    }

    // 2. Parse input
    const body: PlanRequest & { profile_id: string } = await req.json();
    const { profile_id } = body;
    if (!profile_id) {
      return new Response(JSON.stringify({ error: "Missing profile_id" }), {
        status: 400,
        headers: { ...corsHeaders(), "Content-Type": "application/json" },
      });
    }

    const db = supabaseAdmin();

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
      goal_type: body.goal_type,
      goal_text: body.goal_text,
      goal_date: body.goal_date || null,
      constraints: body.constraints,
      baseline: body.baseline,
      preferences: body.preferences,
      start_date: startDate,
      end_date: endDateStr,
      status: "active",
      generation_model: LLM_PROVIDER === "anthropic" ? "claude-sonnet" : "gpt-4o",
    }).select("id").single();

    if (tpErr) throw new Error(`Insert training_plan failed: ${JSON.stringify(tpErr)}`);
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

      if (weekErr) throw new Error(`Insert plan_week ${week.week_number} failed: ${JSON.stringify(weekErr)}`);

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
      if (woErr) throw new Error(`Insert plan_workouts week ${week.week_number} failed: ${JSON.stringify(woErr)}`);
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
        headers: { ...corsHeaders(), "Content-Type": "application/json" },
      }
    );

  } catch (err) {
    console.error("generate-plan error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Internal error" }),
      { status: 500, headers: { ...corsHeaders(), "Content-Type": "application/json" } }
    );
  }
});
