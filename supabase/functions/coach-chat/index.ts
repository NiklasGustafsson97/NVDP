// Coach Chat edge function
//
// POST with { mode: "open" | "send" | "tool" | "archive", ...payload } and a
// valid user bearer token.
//
// open    → finds (or creates) the active thread, builds a context pack,
//           returns the latest 40 messages and any pending chips. If no
//           assistant message has been written within the last 18 hours,
//           a fresh opener message is generated and persisted.
// send    → appends a user message, calls the LLM (with tool support) and
//           persists the assistant reply. Plan-mutating tools are gated
//           behind a user-confirmation step — the LLM may call
//           propose_plan_changes which returns a diff that the frontend
//           renders as a card; the user must explicitly accept before the
//           server runs apply_plan_changes.
// tool    → invoked by the frontend when the user accepts (or declines) a
//           proposed plan diff card. Server applies via the shared
//           checkin-engine helpers.
// archive → marks the active thread archived and creates a new active one
//           (without an opener — opener is generated on next `open`).
//
// CORS is restricted to the APP_ORIGINS allowlist (matches weekly-checkin).
// Plan-mutation logic is shared with weekly-checkin via _shared/checkin-engine.ts.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  type PlanWorkout,
  type ProposedChange,
  type CheckinResponses,
  applyChanges as applyChangesEngine,
  buildObjectiveSummary,
  reviewWeekStart,
  runDecisionEngine,
  validateChanges,
  isoDate,
  addDays,
  mondayOf,
} from "../_shared/checkin-engine.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") || "";
const OPENAI_BASE_URL = Deno.env.get("OPENAI_BASE_URL") || "https://api.openai.com/v1";
const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini";

const APP_ORIGINS = (Deno.env.get("APP_ORIGINS") ||
  "https://niklasgustafsson97.github.io").split(",").map((o) => o.trim()).filter(Boolean);

// Per-minute rate limit for chat sends. Generous enough for normal use,
// tight enough to stop a runaway client.
const COACH_CHAT_PER_MINUTE = 20;
const COACH_CHAT_BUCKET = "coach_chat_per_minute";

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

function json(status: number, body: unknown, req?: Request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

// ────────────────────────────────────────────────────────────────────────────
//  System prompt — Swedish, warm, concise. Mirrors weekly-checkin tone.
// ────────────────────────────────────────────────────────────────────────────

const COACH_SYSTEM_PROMPT = `Du är en konservativ, varm uthållighetscoach (skola: Nils van der Poel, polariserad träning). Du pratar svenska. Du är personlig, rak och kortfattad — som en vän som har koll på data men inte hänger upp sig på den.

Riktlinjer:
- Svara på svenska. Aldrig fler än 2-3 meningar per turn om användaren inte explicit ber om mer.
- Var konkret. "Lättare onsdag, längre söndag" är bättre än "kanske skulle vi titta på balansen".
- Aldrig hype, aldrig emoji-spam (max 1 emoji om det passar).
- Citera siffror när det stärker poängen (ACWR, completion rate, easy-pace HR), inte bara för att visa.
- Om användaren beskriver smärta eller skada: ta det på allvar, föreslå paus eller kontakt med fysio innan plan-ändring. Om det är mer än en kort nypning (eller flera dagars frånvaro nämns): kör start_return_to_training och följ upp med propose_plan_changes. Om memory.facts.return_to_training redan finns: håll dig till den pågående rampan istället för att starta om.

Du har tillgång till verktyg:
- get_workout(date eller workout_id) — slå upp ett specifikt pass (planerat + loggat).
- get_week_summary(week_start) — volym, zon-mix, completion, ACWR för en vecka.
- propose_plan_changes(responses) — kör regelmotorn och returnerar förslag på plan-ändringar för nästa vecka. Användaren måste godkänna i appen — du kan ALDRIG kringgå det.
- log_workout(details) — logga ett genomfört pass åt användaren.
- update_memory(fact_patch) — uppdatera coach_memory.facts (t.ex. niggles, motivators, race_targets).
- predict_race_time(distance_km, target_date?) — Riegel-prognos på användarens senaste löppass. Cita alltid anchor-passet du fick tillbaka när du presenterar tiden, och nämn caveat om värme/bana.
- start_return_to_training(body_part, severity, days_off?, notes?) — när användaren beskriver en skada eller flera dagars ofrivillig vila. Verktyget skriver till minnet och returnerar en 3-veckorsrampa. Följ direkt upp med propose_plan_changes som speglar rampan (sätt responses.injury till severity och använd lämplig free_text/unavailable_days).

Använd verktyg när det är rätt verktyg för jobbet. Annars svara direkt.

Veckoavstämning (söndag): Om första meddelandet i tråden är ditt eget söndagsnudge "Söndag — dags för veckoavstämning" ansvarar du för att genomföra den i chatten — ersätter den gamla guiden. Arbetssätt:
1) Läs användarens första svar (helhetskänsla).
2) Ställ ETT kort uppföljningsfragment i taget, totalt max 3 frågor. Täck: (a) ev. skada/nypning, (b) känsla på tuffaste passet eller långpass, (c) dagar nästa vecka där du inte kan träna eller annan kontext (resa, jobb, event).
3) När du har tillräckligt: kör propose_plan_changes med responses-objekt byggt från svaren: { overall_feel: "above|at|below|very_below", injury: "none|niggle|moderate|severe", hardest_session_feel: "easy|right|hard|too_hard" (om du frågat), long_run_feel: "..." (om du frågat), unavailable_days: ["YYYY-MM-DD", ...], free_text: "..." }. Använd bara fält du verkligen har svar på — regelmotorn tolererar saknade fält.
4) Presentera coach_note kort och låt appen visa diffen. Användaren accepterar/avböjer — du kör ALDRIG apply_plan_changes själv.

Returnera ALLTID JSON: { "reply": "...svenska text...", "chips": ["kort chip 1", "kort chip 2", ...], "tool_call": null | { "name": "...", "arguments": {...} } }. Chips är 0-4 korta svarsförslag (max 4 ord/chip). tool_call sätts om du vill köra ett verktyg; servern kör det och kallar dig igen med resultatet.`;

// ────────────────────────────────────────────────────────────────────────────
//  Tool definitions (purely declarative — handler logic below).
// ────────────────────────────────────────────────────────────────────────────

interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  // diff_id present when a tool returned a proposed plan diff that requires
  // user confirmation before apply_plan_changes can be called.
  diff_id?: string;
}

// ────────────────────────────────────────────────────────────────────────────
//  Types
// ────────────────────────────────────────────────────────────────────────────

interface CoachThread {
  id: string;
  profile_id: string;
  title: string | null;
  last_message_at: string | null;
  status: "active" | "archived";
  created_at: string;
}

interface CoachMessage {
  id: string;
  thread_id: string;
  profile_id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string | null;
  chips: string[] | null;
  tool_calls: unknown;
  tool_result: unknown;
  created_at: string;
}

// Date helpers (isoDate / addDays / mondayOf) are imported from checkin-engine.

// ────────────────────────────────────────────────────────────────────────────
//  Rate limit (mirrors weekly-template-ai pattern). 20/min sliding window.
// ────────────────────────────────────────────────────────────────────────────

async function checkAndIncrementRateLimit(
  db: SupabaseClient,
  userId: string,
): Promise<boolean> {
  const now = new Date();
  // Fixed-minute window so two concurrent calls share the same row.
  const windowStart = new Date(Math.floor(now.getTime() / 60000) * 60000).toISOString();

  const { data: row } = await db
    .from("rate_limits")
    .select("count")
    .eq("user_id", userId)
    .eq("bucket", COACH_CHAT_BUCKET)
    .eq("window_start", windowStart)
    .maybeSingle();

  const current = row?.count ?? 0;
  if (current >= COACH_CHAT_PER_MINUTE) return false;

  await db.from("rate_limits").upsert(
    {
      user_id: userId,
      bucket: COACH_CHAT_BUCKET,
      window_start: windowStart,
      count: current + 1,
    },
    { onConflict: "user_id,bucket,window_start" },
  );
  return true;
}

// ────────────────────────────────────────────────────────────────────────────
//  Thread management
// ────────────────────────────────────────────────────────────────────────────

async function getOrCreateActiveThread(
  db: SupabaseClient,
  profileId: string,
): Promise<CoachThread> {
  const { data: existing } = await db.from("coach_threads")
    .select("*")
    .eq("profile_id", profileId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing) return existing as CoachThread;

  const { data: created, error } = await db.from("coach_threads")
    .insert({ profile_id: profileId, status: "active", title: null })
    .select("*")
    .single();
  if (error) throw error;
  return created as CoachThread;
}

async function fetchRecentMessages(
  db: SupabaseClient,
  threadId: string,
  limit: number,
): Promise<CoachMessage[]> {
  const { data } = await db.from("coach_messages")
    .select("*")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: false })
    .limit(limit);
  const rows = (data || []) as CoachMessage[];
  return rows.reverse();
}

// ────────────────────────────────────────────────────────────────────────────
//  Context pack — what the model sees on every turn (Sprint 1: read-only).
// ────────────────────────────────────────────────────────────────────────────

interface ContextPack {
  today: string;
  profile: {
    display_name: string | null;
    user_max_hr: number | null;
    user_resting_hr: number | null;
  };
  active_plan: {
    id: string;
    title: string | null;
    start_date: string;
    end_date: string;
    target_event_name: string | null;
    target_event_date: string | null;
    target_event_distance_km: number | null;
  } | null;
  next_7_days: Array<{
    workout_date: string;
    day_of_week: number;
    activity_type: string;
    label: string | null;
    intensity_zone: string | null;
    target_duration_minutes: number | null;
    is_rest: boolean;
    description: string | null;
  }>;
  last_14_days_workouts: Array<{
    workout_date: string;
    activity_type: string;
    duration_minutes: number;
    distance_km: number | null;
    intensity: string | null;
    avg_hr: number | null;
    perceived_exertion: number | null;
    notes: string | null;
  }>;
  latest_weekly_checkin: {
    week_start_date: string;
    coach_note: string | null;
    overall_feel: number | null;
    injury_level: string | null;
    acwr: number | null;
    acwr_band: string | null;
  } | null;
  memory: {
    summary: string | null;
    facts: Record<string, unknown>;
  };
}

async function buildContextPack(
  db: SupabaseClient,
  profileId: string,
): Promise<ContextPack> {
  const today = new Date();
  const todayStr = isoDate(today);
  const in7 = isoDate(addDays(today, 7));
  const minus14 = isoDate(addDays(today, -14));

  const [profileRes, planRes, memRes, checkinRes] = await Promise.all([
    db.from("profiles")
      .select("id, display_name, user_max_hr, user_resting_hr")
      .eq("id", profileId).single(),
    db.from("training_plans")
      .select("id, title, start_date, end_date, target_event_name, target_event_date, target_event_distance_km, status")
      .eq("profile_id", profileId)
      .eq("status", "active")
      .order("start_date", { ascending: false })
      .limit(1)
      .maybeSingle(),
    db.from("coach_memory")
      .select("summary, facts")
      .eq("profile_id", profileId)
      .maybeSingle(),
    db.from("weekly_checkins")
      .select("week_start_date, coach_note, responses, objective_summary")
      .eq("profile_id", profileId)
      .order("week_start_date", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const profile = profileRes.data || { display_name: null, user_max_hr: null, user_resting_hr: null };
  const activePlan = planRes.data || null;

  let next7: ContextPack["next_7_days"] = [];
  if (activePlan) {
    const { data: pw } = await db.from("plan_workouts")
      .select("workout_date, day_of_week, activity_type, label, intensity_zone, target_duration_minutes, is_rest, description, plan_week_id")
      .gte("workout_date", todayStr)
      .lte("workout_date", in7)
      .order("workout_date", { ascending: true });
    // Filter to weeks in the active plan via a follow-up join in memory.
    if (pw && pw.length > 0) {
      const weekIds = Array.from(new Set(pw.map((r: { plan_week_id: string }) => r.plan_week_id)));
      const { data: weeks } = await db.from("plan_weeks")
        .select("id, plan_id")
        .in("id", weekIds);
      const ownedIds = new Set(
        (weeks || [])
          .filter((w: { plan_id: string }) => w.plan_id === activePlan.id)
          .map((w: { id: string }) => w.id),
      );
      next7 = pw
        .filter((r: { plan_week_id: string }) => ownedIds.has(r.plan_week_id))
        .map((r) => ({
          workout_date: r.workout_date,
          day_of_week: r.day_of_week,
          activity_type: r.activity_type,
          label: r.label,
          intensity_zone: r.intensity_zone,
          target_duration_minutes: r.target_duration_minutes,
          is_rest: r.is_rest,
          description: r.description,
        }));
    }
  }

  const { data: workouts } = await db.from("workouts")
    .select("workout_date, activity_type, duration_minutes, distance_km, intensity, avg_hr, perceived_exertion, notes")
    .eq("profile_id", profileId)
    .gte("workout_date", minus14)
    .lte("workout_date", todayStr)
    .order("workout_date", { ascending: true });

  const memory = memRes.data || { summary: null, facts: {} };
  const checkin = checkinRes.data;

  let latestCheckin: ContextPack["latest_weekly_checkin"] = null;
  if (checkin) {
    const responses = (checkin.responses || {}) as { overall_feel?: number; injury_level?: string };
    const obj = (checkin.objective_summary || {}) as { acwr?: number; acwr_band?: string };
    latestCheckin = {
      week_start_date: checkin.week_start_date,
      coach_note: checkin.coach_note ?? null,
      overall_feel: responses.overall_feel ?? null,
      injury_level: responses.injury_level ?? null,
      acwr: obj.acwr ?? null,
      acwr_band: obj.acwr_band ?? null,
    };
  }

  return {
    today: todayStr,
    profile: {
      display_name: profile.display_name,
      user_max_hr: profile.user_max_hr,
      user_resting_hr: profile.user_resting_hr,
    },
    active_plan: activePlan
      ? {
        id: activePlan.id,
        title: activePlan.title,
        start_date: activePlan.start_date,
        end_date: activePlan.end_date,
        target_event_name: activePlan.target_event_name,
        target_event_date: activePlan.target_event_date,
        target_event_distance_km: activePlan.target_event_distance_km,
      }
      : null,
    next_7_days: next7,
    last_14_days_workouts: (workouts || []).map((w) => ({
      workout_date: w.workout_date,
      activity_type: w.activity_type,
      duration_minutes: w.duration_minutes,
      distance_km: w.distance_km,
      intensity: w.intensity,
      avg_hr: w.avg_hr,
      perceived_exertion: w.perceived_exertion,
      notes: w.notes,
    })),
    latest_weekly_checkin: latestCheckin,
    memory: { summary: memory.summary, facts: (memory.facts || {}) as Record<string, unknown> },
  };
}

// ────────────────────────────────────────────────────────────────────────────
//  LLM call. Returns { reply, chips }.
//  No streaming yet (Sprint 1 keeps it simple; SSE wrapper is in place but
//  emits a single "message" + "done" event so the frontend can still handle
//  incremental rendering once we enable token streaming).
// ────────────────────────────────────────────────────────────────────────────

interface LLMResponse {
  reply: string;
  chips: string[];
  tool_call: ToolCall | null;
}

interface ExtraTurn {
  role: "user" | "assistant" | "tool";
  content: string;
}

async function callLLM(
  ctx: ContextPack,
  history: CoachMessage[],
  userMessage: string | null,
  isOpener: boolean,
  extraTurns: ExtraTurn[] = [],
): Promise<LLMResponse> {
  const fallback: LLMResponse = isOpener
    ? {
      reply: `Hej${ctx.profile.display_name ? " " + ctx.profile.display_name : ""}. Vad vill du ta upp idag — har du något på hjärtat, eller kör vi en snabb check-in?`,
      chips: ["Kör check-in", "Något på hjärtat", "Justera schemat", "Fråga om ett pass"],
      tool_call: null,
    }
    : { reply: "Coachen är inte tillgänglig just nu. Försök igen om en stund.", chips: [], tool_call: null };

  if (!OPENAI_API_KEY) return fallback;

  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: COACH_SYSTEM_PROMPT },
    {
      role: "system",
      content: `KONTEXT (uppdateras varje turn, ALDRIG visas för användaren):\n${JSON.stringify(ctx)}`,
    },
  ];

  for (const m of history) {
    if (m.role === "user" || m.role === "assistant") {
      messages.push({ role: m.role, content: m.content || "" });
    }
  }

  if (isOpener && !userMessage) {
    messages.push({
      role: "user",
      content: "[SYSTEM: Generera en kort, varm öppnings-greeting på svenska. Föreslå 3-4 chips som hjälper mig komma igång.]",
    });
  } else if (userMessage) {
    messages.push({ role: "user", content: userMessage });
  }

  for (const t of extraTurns) {
    if (t.role === "tool") {
      // Render tool result as a system message so a single chat completion
      // call still works without OpenAI tool-calling protocol.
      messages.push({ role: "system", content: `TOOL_RESULT:\n${t.content}` });
    } else {
      messages.push({ role: t.role, content: t.content });
    }
  }

  try {
    const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        response_format: { type: "json_object" },
        temperature: 0.6,
        messages,
      }),
    });
    if (!res.ok) return fallback;
    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw);
    const reply = typeof parsed.reply === "string" && parsed.reply.trim()
      ? parsed.reply.trim()
      : fallback.reply;
    const chips = Array.isArray(parsed.chips)
      ? parsed.chips.filter((c: unknown) => typeof c === "string").slice(0, 4)
      : [];
    let toolCall: ToolCall | null = null;
    if (parsed.tool_call && typeof parsed.tool_call === "object" && typeof parsed.tool_call.name === "string") {
      toolCall = {
        name: String(parsed.tool_call.name),
        arguments: (parsed.tool_call.arguments && typeof parsed.tool_call.arguments === "object")
          ? parsed.tool_call.arguments as Record<string, unknown>
          : {},
      };
    }
    return { reply, chips, tool_call: toolCall };
  } catch (_e) {
    return fallback;
  }
}

// ────────────────────────────────────────────────────────────────────────────
//  Tool handlers (server-side, run with service-role DB but always scoped
//  to the caller's profile_id).
// ────────────────────────────────────────────────────────────────────────────

const ALLOWED_TOOLS = new Set([
  "get_workout",
  "get_week_summary",
  "propose_plan_changes",
  "apply_plan_changes",
  "log_workout",
  "update_memory",
  "predict_race_time",
  "start_return_to_training",
]);

async function toolGetWorkout(
  db: SupabaseClient,
  profileId: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const date = typeof args.date === "string" ? args.date : null;
  const workoutId = typeof args.workout_id === "string" ? args.workout_id : null;
  if (!date && !workoutId) return { ok: false, error: "Need date or workout_id" };

  let logged: unknown = null;
  let planned: unknown = null;
  if (workoutId) {
    const { data } = await db.from("workouts")
      .select("*")
      .eq("id", workoutId)
      .eq("profile_id", profileId)
      .maybeSingle();
    logged = data;
  } else if (date) {
    const { data } = await db.from("workouts")
      .select("*")
      .eq("profile_id", profileId)
      .eq("workout_date", date);
    logged = data || [];
  }
  if (date) {
    const { data: pw } = await db.from("plan_workouts")
      .select("workout_date, day_of_week, activity_type, label, description, intensity_zone, target_duration_minutes, target_distance_km, is_rest, plan_week_id")
      .eq("workout_date", date);
    planned = pw || [];
  }
  return { ok: true, data: { logged, planned } };
}

async function toolGetWeekSummary(
  db: SupabaseClient,
  profileId: string,
  userMaxHr: number | null,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  let weekStart: Date;
  if (typeof args.week_start === "string") {
    weekStart = new Date(args.week_start + "T00:00:00");
    if (isNaN(weekStart.getTime())) return { ok: false, error: "Invalid week_start" };
    weekStart = mondayOf(weekStart);
  } else {
    weekStart = mondayOf(addDays(new Date(), -7));
  }
  const { data: plan } = await db.from("training_plans")
    .select("id")
    .eq("profile_id", profileId)
    .eq("status", "active")
    .maybeSingle();
  const planId: string | null = plan?.id ?? null;
  const summary = await buildObjectiveSummary(db, profileId, userMaxHr, planId, weekStart, false);
  return {
    ok: true,
    data: {
      week_start: summary.week_start,
      planned_sessions: summary.planned_sessions,
      logged_sessions: summary.logged_sessions,
      completion_rate: summary.completion_rate,
      weekly_load: summary.weekly_load,
      acwr: summary.acwr,
      acwr_band: summary.acwr_band,
      easy_avg_hr: summary.easy_avg_hr,
      easy_avg_hr_prior_4wk: summary.easy_avg_hr_prior_4wk,
      missed_sessions: summary.missed_sessions,
      next_week_phase: summary.next_week_phase,
    },
  };
}

// In-memory diff store keyed by id. Simple LRU (≤ 50 entries) — server-side
// state but acceptable since each diff is also persisted on coach_messages.
const _diffCache = new Map<string, {
  profileId: string;
  changes: ProposedChange[];
  nextWeekPlan: PlanWorkout[];
  createdAt: number;
}>();
function _stashDiff(profileId: string, changes: ProposedChange[], nextWeekPlan: PlanWorkout[]): string {
  const id = crypto.randomUUID();
  if (_diffCache.size >= 50) {
    const oldest = [...(_diffCache.entries())].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (oldest) _diffCache.delete(oldest[0]);
  }
  _diffCache.set(id, { profileId, changes, nextWeekPlan, createdAt: Date.now() });
  return id;
}

async function toolProposePlanChanges(
  db: SupabaseClient,
  profileId: string,
  userMaxHr: number | null,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const responses = (args.responses && typeof args.responses === "object")
    ? args.responses as CheckinResponses
    : null;
  if (!responses || typeof responses.overall_feel !== "number" || !responses.injury_level) {
    return {
      ok: false,
      error: "Need responses.overall_feel (1-5) and responses.injury_level (none|niggle|pain|paused)",
    };
  }
  const { data: plan } = await db.from("training_plans")
    .select("id")
    .eq("profile_id", profileId)
    .eq("status", "active")
    .maybeSingle();
  if (!plan?.id) return { ok: false, error: "No active plan" };

  const { weekStart, weekNotYetClosed } = reviewWeekStart(new Date());
  const summary = await buildObjectiveSummary(db, profileId, userMaxHr, plan.id, weekStart, weekNotYetClosed);
  if (summary.next_week_plan.length === 0) {
    return { ok: false, error: "Inga pass nästa vecka i planen" };
  }
  const engine = runDecisionEngine({ responses, summary });
  // validateChanges already runs inside runDecisionEngine; re-run defensively
  // when the LLM might call this tool with crafted inputs.
  const validated = validateChanges(engine.changes, summary.next_week_plan);
  const diffId = _stashDiff(profileId, validated, summary.next_week_plan);

  return {
    ok: true,
    diff_id: diffId,
    data: {
      diff_id: diffId,
      changes: validated.map((c) => ({
        id: c.id,
        day_of_week: c.day_of_week,
        action: c.action,
        reason_sv: c.reason_sv,
        current: c.current_workout
          ? { label: c.current_workout.label, activity_type: c.current_workout.activity_type, intensity_zone: c.current_workout.intensity_zone, target_duration_minutes: c.current_workout.target_duration_minutes }
          : null,
        proposed: c.proposed_workout
          ? { label: c.proposed_workout.label, activity_type: c.proposed_workout.activity_type, intensity_zone: c.proposed_workout.intensity_zone, target_duration_minutes: c.proposed_workout.target_duration_minutes }
          : null,
      })),
      coach_note: engine.coach_note,
      summary: {
        acwr: summary.acwr,
        acwr_band: summary.acwr_band,
        completion_rate: summary.completion_rate,
        next_week_phase: summary.next_week_phase,
      },
    },
  };
}

async function toolApplyPlanChanges(
  db: SupabaseClient,
  profileId: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const diffId = typeof args.diff_id === "string" ? args.diff_id : null;
  if (!diffId) return { ok: false, error: "Missing diff_id" };
  const stash = _diffCache.get(diffId);
  if (!stash) return { ok: false, error: "Diff expired or unknown — be om en ny propose_plan_changes" };
  if (stash.profileId !== profileId) return { ok: false, error: "Forbidden" };

  const acceptedIds = Array.isArray(args.accepted_change_ids)
    ? (args.accepted_change_ids as unknown[]).filter((s) => typeof s === "string") as string[]
    : stash.changes.map((c) => c.id);
  const accepted = stash.changes.filter((c) => acceptedIds.includes(c.id));

  // Re-fetch plan_workouts to guard against stale snapshot.
  const ids = stash.nextWeekPlan.map((w) => w.id);
  const { data: fresh } = await db.from("plan_workouts").select("*").in("id", ids);
  if (!fresh) return { ok: false, error: "Could not load plan_workouts" };

  await applyChangesEngine(db, fresh as PlanWorkout[], accepted);
  _diffCache.delete(diffId);

  return { ok: true, data: { applied: accepted.length, change_ids: accepted.map((c) => c.id) } };
}

async function toolLogWorkout(
  db: SupabaseClient,
  profileId: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const a = args as Record<string, unknown>;
  const date = typeof a.workout_date === "string" ? a.workout_date : null;
  const type = typeof a.activity_type === "string" ? a.activity_type : null;
  const mins = typeof a.duration_minutes === "number" ? a.duration_minutes : null;
  if (!date || !type || !mins || mins <= 0) {
    return { ok: false, error: "Need workout_date, activity_type, duration_minutes (>0)" };
  }
  const row: Record<string, unknown> = {
    profile_id: profileId,
    workout_date: date,
    activity_type: type,
    duration_minutes: Math.round(mins),
  };
  if (typeof a.distance_km === "number") row.distance_km = a.distance_km;
  if (typeof a.intensity === "string") row.intensity = a.intensity;
  if (typeof a.notes === "string") row.notes = a.notes;
  if (typeof a.perceived_exertion === "number") row.perceived_exertion = a.perceived_exertion;

  const { data, error } = await db.from("workouts").insert(row).select("id").single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, data: { id: data.id, workout_date: date, activity_type: type, duration_minutes: row.duration_minutes } };
}

async function toolUpdateMemory(
  db: SupabaseClient,
  profileId: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const patch = (args.fact_patch && typeof args.fact_patch === "object")
    ? args.fact_patch as Record<string, unknown>
    : null;
  if (!patch) return { ok: false, error: "Need fact_patch object" };

  const { data: existing } = await db.from("coach_memory")
    .select("facts")
    .eq("profile_id", profileId)
    .maybeSingle();

  const merged = { ...(existing?.facts || {}), ...patch };
  if (existing) {
    await db.from("coach_memory")
      .update({ facts: merged, updated_at: new Date().toISOString() })
      .eq("profile_id", profileId);
  } else {
    await db.from("coach_memory")
      .insert({ profile_id: profileId, facts: merged });
  }
  return { ok: true, data: { facts: merged } };
}

// ────────────────────────────────────────────────────────────────────────────
//  Race-time prediction via Riegel formula: T₂ = T₁ · (D₂ / D₁)^1.06
//
//  Inputs: distance_km (required), optional target_date (string, informational)
//  Strategy: Look at the last 120 days of logged runs with at least 3 km and
//  a non-trivial duration, derive seconds/km, and pick the effort whose
//  Riegel-projected time at the target distance is fastest (i.e. the
//  user's current aerobic "best" projected onto the target). We also
//  return the anchor workout so the coach can cite it honestly.
// ────────────────────────────────────────────────────────────────────────────
async function toolPredictRaceTime(
  db: SupabaseClient,
  profileId: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const dist = typeof args.distance_km === "number" ? args.distance_km : Number(args.distance_km);
  if (!Number.isFinite(dist) || dist < 1 || dist > 200) {
    return { ok: false, error: "Need distance_km between 1 and 200." };
  }
  const targetDate = typeof args.target_date === "string" ? args.target_date : null;

  const since = isoDate(addDays(new Date(), -120));
  const { data: runs } = await db.from("workouts")
    .select("id, workout_date, activity_type, distance_km, duration_minutes")
    .eq("profile_id", profileId)
    .gte("workout_date", since)
    .order("workout_date", { ascending: false })
    .limit(400);

  const candidates = ((runs || []) as { id: string; workout_date: string; activity_type: string | null; distance_km: number | null; duration_minutes: number | null }[])
    .filter((w) => {
      const act = (w.activity_type || "").toLowerCase();
      const isRun = act === "run" || act === "running" || act === "löpning" || act === "trail_run";
      const d = w.distance_km || 0;
      const t = w.duration_minutes || 0;
      return isRun && d >= 3 && t >= 15 && t / d >= 2.5 && t / d <= 15; // sanity pace bounds
    });

  if (candidates.length === 0) {
    return { ok: false, error: "Hittar inga löppass ≥3 km senaste 120 dagar att räkna på." };
  }

  // For each candidate, compute predicted seconds at target distance via Riegel.
  let best: {
    predicted_seconds: number;
    source_workout_id: string;
    source_date: string;
    source_distance_km: number;
    source_pace_sec_per_km: number;
  } | null = null;
  for (const w of candidates) {
    const d1 = w.distance_km!;
    const t1Sec = w.duration_minutes! * 60;
    // Riegel is most reliable when D₂/D₁ ∈ [0.5, 4]; skip extreme extrapolations.
    const ratio = dist / d1;
    if (ratio < 0.25 || ratio > 5) continue;
    const predicted = t1Sec * Math.pow(ratio, 1.06);
    if (!best || predicted < best.predicted_seconds) {
      best = {
        predicted_seconds: predicted,
        source_workout_id: w.id,
        source_date: w.workout_date,
        source_distance_km: d1,
        source_pace_sec_per_km: t1Sec / d1,
      };
    }
  }

  if (!best) {
    return { ok: false, error: "Alla underlagspass låg för långt från måldistansen för tillförlitlig prognos." };
  }

  const fmt = (sec: number): string => {
    const s = Math.round(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
    return `${m}:${String(r).padStart(2, "0")}`;
  };
  const paceSec = best.predicted_seconds / dist;

  return {
    ok: true,
    data: {
      distance_km: dist,
      target_date: targetDate,
      predicted_time: fmt(best.predicted_seconds),
      predicted_seconds: Math.round(best.predicted_seconds),
      predicted_pace: `${Math.floor(paceSec / 60)}:${String(Math.round(paceSec % 60)).padStart(2, "0")}/km`,
      anchor: {
        workout_id: best.source_workout_id,
        date: best.source_date,
        distance_km: best.source_distance_km,
        pace: `${Math.floor(best.source_pace_sec_per_km / 60)}:${String(Math.round(best.source_pace_sec_per_km % 60)).padStart(2, "0")}/km`,
      },
      method: "Riegel (exponent 1.06) på bästa löppass senaste 120 dagarna.",
      caveat: "Riegel förutsätter liknande form och underlag; addera ~2–5% för värmebarriär och bana.",
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
//  Return-to-training — records the niggle in coach_memory and returns a
//  structured ramp (3-week conservative reintroduction). The LLM should
//  follow up with propose_plan_changes to actually mutate next week's plan.
// ────────────────────────────────────────────────────────────────────────────
async function toolStartReturnToTraining(
  db: SupabaseClient,
  profileId: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const bodyPart = typeof args.body_part === "string" ? args.body_part.trim() : "";
  if (!bodyPart) return { ok: false, error: "Need body_part." };
  const severityIn = typeof args.severity === "string" ? args.severity.toLowerCase() : "mild";
  const severity: "mild" | "moderate" | "severe" =
    severityIn === "severe" ? "severe" : severityIn === "moderate" ? "moderate" : "mild";
  const daysOff = Number.isFinite(Number(args.days_off)) ? Math.max(0, Math.min(60, Math.round(Number(args.days_off)))) : 0;
  const notes = typeof args.notes === "string" ? args.notes.slice(0, 400) : "";

  // Volume ramp: mild → 70/85/100%, moderate → 50/70/90%, severe → 30/55/80% of baseline.
  const ramp =
    severity === "severe"
      ? [0.3, 0.55, 0.8]
      : severity === "moderate"
      ? [0.5, 0.7, 0.9]
      : [0.7, 0.85, 1.0];

  // Persist niggle in coach_memory.facts so it re-enters future context packs.
  const { data: mem } = await db.from("coach_memory")
    .select("facts")
    .eq("profile_id", profileId)
    .maybeSingle();
  const facts = (mem?.facts || {}) as Record<string, unknown>;
  const niggles = Array.isArray(facts.niggles) ? [...facts.niggles as Record<string, unknown>[]] : [];
  niggles.push({
    body_part: bodyPart,
    severity,
    days_off: daysOff,
    note: notes,
    since_date: isoDate(new Date()),
    rtr_started_at: new Date().toISOString(),
  });
  const patch: Record<string, unknown> = {
    ...facts,
    niggles,
    return_to_training: {
      body_part: bodyPart,
      severity,
      started_at: new Date().toISOString(),
      ramp,
    },
  };
  if (mem) {
    await db.from("coach_memory")
      .update({ facts: patch, updated_at: new Date().toISOString() })
      .eq("profile_id", profileId);
  } else {
    await db.from("coach_memory").insert({ profile_id: profileId, facts: patch });
  }

  return {
    ok: true,
    data: {
      body_part: bodyPart,
      severity,
      days_off: daysOff,
      ramp_percent: ramp.map((r) => Math.round(r * 100)),
      week_plan: [
        { week: 1, volume_pct: Math.round(ramp[0] * 100), intensity: "Z1/Z2 bara, inga intervaller", rule: "Stopp om smärtan >3/10 eller ökar dag efter." },
        { week: 2, volume_pct: Math.round(ramp[1] * 100), intensity: "Z1/Z2 + korta stridar/strides om smärtfritt", rule: "Lägg till 1 kvalitet om du varit smärtfri hela vecka 1." },
        { week: 3, volume_pct: Math.round(ramp[2] * 100), intensity: "Polariserad: Z1/Z2 + 1 kvalitet (tröskel eller intervaller)", rule: "Tillbaka till full struktur om smärtfri + inga kompensationsrörelser." },
      ],
      next_action: "Kör propose_plan_changes med responses.injury satt (moderate/severe), unavailable_days för planerade hårda pass och free_text: 'Return to training efter " + bodyPart + "'.",
    },
  };
}

async function runTool(
  db: SupabaseClient,
  profileId: string,
  userMaxHr: number | null,
  call: ToolCall,
): Promise<ToolResult> {
  if (!ALLOWED_TOOLS.has(call.name)) {
    return { ok: false, error: `Unknown tool: ${call.name}` };
  }
  try {
    switch (call.name) {
      case "get_workout":
        return await toolGetWorkout(db, profileId, call.arguments || {});
      case "get_week_summary":
        return await toolGetWeekSummary(db, profileId, userMaxHr, call.arguments || {});
      case "propose_plan_changes":
        return await toolProposePlanChanges(db, profileId, userMaxHr, call.arguments || {});
      case "apply_plan_changes":
        return await toolApplyPlanChanges(db, profileId, call.arguments || {});
      case "log_workout":
        return await toolLogWorkout(db, profileId, call.arguments || {});
      case "update_memory":
        return await toolUpdateMemory(db, profileId, call.arguments || {});
      case "predict_race_time":
        return await toolPredictRaceTime(db, profileId, call.arguments || {});
      case "start_return_to_training":
        return await toolStartReturnToTraining(db, profileId, call.arguments || {});
      default:
        return { ok: false, error: "Unhandled tool" };
    }
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    return { ok: false, error: err };
  }
}

// ────────────────────────────────────────────────────────────────────────────
//  Memory summarization — refreshes coach_memory.summary and .facts based
//  on the latest thread-turn. Gated so we don't LLM-call every turn.
// ────────────────────────────────────────────────────────────────────────────

const MEMORY_SUMMARY_PROMPT = `Du uppdaterar ett långtidsminne för en uthållighetscoach. Du får nuvarande summary, nuvarande facts (JSON) och ett utdrag ur senaste samtalen.

Returnera STRICT JSON:
{
  "summary": "(oförändrad) eller 2-4 meningar svenska om användarens nuläge, mål, skador, preferenser",
  "facts_patch": { ... }
}

facts_patch ska bara innehålla ändrade/nya fält jämfört med nuvarande facts. Standardfält (alla optional):
- niggles: [{ body_part, note, since_date }]
- motivators: [string]
- race_targets: [{ name, date, distance_km?, goal_time? }]
- preferences: { easy_days?: [string], quality_days?: [string], long_run_day?: string }
- recent_highlight: string
- constraints: [string]

Var konservativ. Spekulera aldrig. Om inget tydligt uppdateras: { "summary": "(oförändrad)", "facts_patch": {} }.`;

async function maybeSummarizeMemory(
  db: SupabaseClient,
  profileId: string,
  threadId: string,
): Promise<void> {
  if (!OPENAI_API_KEY) return;
  try {
    const { data: existing } = await db.from("coach_memory")
      .select("summary, facts, updated_at")
      .eq("profile_id", profileId)
      .maybeSingle();

    // Gate: skip if we summarised in the last 3 hours.
    if (existing?.updated_at) {
      const age = Date.now() - new Date(existing.updated_at).getTime();
      if (age < 3 * 60 * 60 * 1000) return;
    }

    const { data: msgs } = await db.from("coach_messages")
      .select("role, content, created_at")
      .eq("thread_id", threadId)
      .order("created_at", { ascending: false })
      .limit(20);
    const arr = ((msgs || []) as { role: string; content: string }[])
      .filter((m) => m.role === "user" || m.role === "assistant")
      .reverse();
    if (arr.length < 4) return;

    const transcript = arr
      .map((m) => `${m.role === "user" ? "User" : "Coach"}: ${(m.content || "").slice(0, 400)}`)
      .join("\n");

    const userMsg = `NUVARANDE SUMMARY:\n${existing?.summary || "(tom)"}\n\nNUVARANDE FACTS (JSON):\n${JSON.stringify(existing?.facts || {})}\n\nSENASTE SAMTAL:\n${transcript}`;

    const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        response_format: { type: "json_object" },
        temperature: 0.2,
        messages: [
          { role: "system", content: MEMORY_SUMMARY_PROMPT },
          { role: "user", content: userMsg },
        ],
      }),
    });
    if (!res.ok) return;
    const data = await res.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || "{}");
    const newSummary = typeof parsed.summary === "string" && parsed.summary && parsed.summary !== "(oförändrad)"
      ? parsed.summary.trim()
      : null;
    const patch = (parsed.facts_patch && typeof parsed.facts_patch === "object" && !Array.isArray(parsed.facts_patch))
      ? parsed.facts_patch as Record<string, unknown>
      : {};
    const mergedFacts = { ...(existing?.facts || {}), ...patch };

    const update: Record<string, unknown> = {
      facts: mergedFacts,
      updated_at: new Date().toISOString(),
    };
    if (newSummary) update.summary = newSummary;

    if (existing) {
      await db.from("coach_memory").update(update).eq("profile_id", profileId);
    } else {
      await db.from("coach_memory").insert({ profile_id: profileId, ...update });
    }
  } catch (e) {
    console.error("coach-chat: memory summarization failed", e);
  }
}

// ────────────────────────────────────────────────────────────────────────────
//  Main handler
// ────────────────────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" }, req);

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) return json(401, { error: "No auth header" }, req);
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return json(401, { error: "Invalid token" }, req);

    const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const { data: profile } = await db.from("profiles")
      .select("id, user_max_hr")
      .eq("user_id", user.id)
      .single();
    if (!profile) return json(404, { error: "Profile not found" }, req);
    const profileId: string = profile.id;
    const userMaxHr: number | null = profile.user_max_hr ?? null;

    const body = await req.json().catch(() => ({}));
    const mode: string = body?.mode || "open";

    // ─────────────── ARCHIVE ───────────────
    if (mode === "archive") {
      const thread = await getOrCreateActiveThread(db, profileId);
      await db.from("coach_threads")
        .update({ status: "archived", archived_at: new Date().toISOString() })
        .eq("id", thread.id);
      // Create a fresh active thread (no messages yet — opener on next `open`).
      const { data: fresh } = await db.from("coach_threads")
        .insert({ profile_id: profileId, status: "active" })
        .select("*")
        .single();
      return json(200, { ok: true, thread: fresh }, req);
    }

    // ─────────────── OPEN ───────────────
    if (mode === "open") {
      const thread = await getOrCreateActiveThread(db, profileId);
      const messages = await fetchRecentMessages(db, thread.id, 40);

      // Generate an opener if no assistant message in the last 18h.
      const eighteenHoursAgo = Date.now() - 18 * 60 * 60 * 1000;
      const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
      const needOpener = !lastAssistant || new Date(lastAssistant.created_at).getTime() < eighteenHoursAgo;

      if (needOpener) {
        const ctx = await buildContextPack(db, profileId);
        const llm = await callLLM(ctx, messages, null, true);
        const { data: inserted } = await db.from("coach_messages").insert({
          thread_id: thread.id,
          profile_id: profileId,
          role: "assistant",
          content: llm.reply,
          chips: llm.chips,
        }).select("*").single();
        await db.from("coach_threads")
          .update({ last_message_at: new Date().toISOString() })
          .eq("id", thread.id);
        if (inserted) messages.push(inserted as CoachMessage);
      }

      return json(200, {
        thread,
        messages,
      }, req);
    }

    // ─────────────── SEND ───────────────
    if (mode === "send") {
      const { content } = body as { content?: string };
      if (!content || typeof content !== "string" || !content.trim()) {
        return json(400, { error: "Missing content" }, req);
      }
      const trimmed = content.trim().slice(0, 4000);

      const allowed = await checkAndIncrementRateLimit(db, user.id);
      if (!allowed) return json(429, { error: "rate_limited" }, req);

      const thread = await getOrCreateActiveThread(db, profileId);

      // Persist user turn.
      const { data: userMsg } = await db.from("coach_messages").insert({
        thread_id: thread.id,
        profile_id: profileId,
        role: "user",
        content: trimmed,
      }).select("*").single();

      const history = await fetchRecentMessages(db, thread.id, 20);
      const ctx = await buildContextPack(db, profileId);

      // Tool-calling loop. LLM can request one tool per turn; we run it,
      // feed the result back, and let LLM produce the final reply. Cap at
      // 3 tool calls per turn to prevent runaway costs.
      let llm = await callLLM(ctx, history, trimmed, false);
      const toolCallsMade: { name: string; arguments: Record<string, unknown>; result: ToolResult }[] = [];
      const extraTurns: ExtraTurn[] = [];
      let lastDiffId: string | null = null;

      for (let i = 0; i < 3 && llm.tool_call; i++) {
        const call = llm.tool_call;

        // apply_plan_changes is user-gated: never run from an LLM turn, only
        // from an explicit `tool` mode POST from the frontend after the user
        // accepts a diff card. Tell the LLM that.
        if (call.name === "apply_plan_changes") {
          extraTurns.push({
            role: "assistant",
            content: JSON.stringify({ reply: "[intern: förra svaret hade tool_call apply_plan_changes]", chips: [] }),
          });
          extraTurns.push({
            role: "tool",
            content: JSON.stringify({
              ok: false,
              error: "apply_plan_changes kan bara köras av användaren i appen. Visa diffen via propose_plan_changes och be om bekräftelse.",
            }),
          });
          llm = await callLLM(ctx, history, trimmed, false, extraTurns);
          continue;
        }

        const result = await runTool(db, profileId, userMaxHr, call);
        toolCallsMade.push({ name: call.name, arguments: call.arguments, result });
        if (result.diff_id) lastDiffId = result.diff_id;

        extraTurns.push({
          role: "assistant",
          content: JSON.stringify({ reply: llm.reply, chips: llm.chips, tool_call: call }),
        });
        extraTurns.push({
          role: "tool",
          content: JSON.stringify({ name: call.name, result }),
        });

        llm = await callLLM(ctx, history, trimmed, false, extraTurns);
      }

      const toolCallsLog = toolCallsMade.length > 0
        ? toolCallsMade.map((t) => ({ name: t.name, arguments: t.arguments }))
        : null;
      const toolResultLog = toolCallsMade.length > 0
        ? { calls: toolCallsMade.map((t) => ({ name: t.name, ok: t.result.ok, data: t.result.data, diff_id: t.result.diff_id, error: t.result.error })) }
        : null;

      const { data: assistantMsg } = await db.from("coach_messages").insert({
        thread_id: thread.id,
        profile_id: profileId,
        role: "assistant",
        content: llm.reply,
        chips: llm.chips,
        tool_calls: toolCallsLog,
        tool_result: toolResultLog,
      }).select("*").single();

      await db.from("coach_threads")
        .update({ last_message_at: new Date().toISOString() })
        .eq("id", thread.id);

      // Background memory refresh (waitUntil if the runtime supports it).
      const memPromise = maybeSummarizeMemory(db, profileId, thread.id);
      // deno-lint-ignore no-explicit-any
      const er = (globalThis as any).EdgeRuntime;
      if (er && typeof er.waitUntil === "function") {
        try { er.waitUntil(memPromise); } catch (_) { /* ignore */ }
      } else {
        // Fall-through: don't block the response; Deno may still flush in time.
        memPromise.catch(() => { /* already logged */ });
      }

      return json(200, {
        thread,
        user_message: userMsg,
        assistant_message: assistantMsg,
        diff_id: lastDiffId,
      }, req);
    }

    // ─────────────── TOOL (user-initiated, from diff-card confirmations) ───────────────
    if (mode === "tool") {
      const { tool_name, arguments: toolArgs } = body as {
        tool_name?: string;
        arguments?: Record<string, unknown>;
      };
      if (!tool_name || typeof tool_name !== "string") {
        return json(400, { error: "Missing tool_name" }, req);
      }
      // Only user-confirmable tools are exposed directly; proposing is the
      // LLM's job, applying/logging is the user's.
      const USER_CALLABLE = new Set(["apply_plan_changes", "log_workout", "update_memory"]);
      if (!USER_CALLABLE.has(tool_name)) {
        return json(400, { error: `Tool not user-callable: ${tool_name}` }, req);
      }
      const allowed = await checkAndIncrementRateLimit(db, user.id);
      if (!allowed) return json(429, { error: "rate_limited" }, req);

      const result = await runTool(db, profileId, userMaxHr, {
        name: tool_name,
        arguments: toolArgs || {},
      });

      // Append a system/tool message + a short assistant confirmation so the
      // chat history stays coherent.
      const thread = await getOrCreateActiveThread(db, profileId);
      await db.from("coach_messages").insert({
        thread_id: thread.id,
        profile_id: profileId,
        role: "tool",
        content: `${tool_name} (user-triggered)`,
        tool_calls: [{ name: tool_name, arguments: toolArgs || {} }],
        tool_result: result,
      });

      let assistantText = "";
      if (tool_name === "apply_plan_changes" && result.ok) {
        const applied = (result.data as { applied?: number })?.applied ?? 0;
        assistantText = applied > 0
          ? `Klart — ${applied} ${applied === 1 ? "ändring" : "ändringar"} applicerade på nästa vecka.`
          : "Inga ändringar applicerade.";
      } else if (tool_name === "log_workout" && result.ok) {
        assistantText = "Passet är loggat. Bra jobbat!";
      } else if (tool_name === "update_memory" && result.ok) {
        assistantText = "Antecknat.";
      } else if (!result.ok) {
        assistantText = `Hmm, det gick inte: ${result.error || "okänt fel"}.`;
      } else {
        assistantText = "Klart.";
      }
      const { data: assistantMsg } = await db.from("coach_messages").insert({
        thread_id: thread.id,
        profile_id: profileId,
        role: "assistant",
        content: assistantText,
        chips: [],
      }).select("*").single();

      await db.from("coach_threads")
        .update({ last_message_at: new Date().toISOString() })
        .eq("id", thread.id);

      return json(200, {
        ok: result.ok,
        result,
        assistant_message: assistantMsg,
      }, req);
    }

    return json(400, { error: `Unknown mode: ${mode}` }, req);
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    return json(500, { error: "internal", detail: err }, req);
  }
});
