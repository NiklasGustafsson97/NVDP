import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

const SYSTEM_PROMPT = `You are an elite endurance coach trained in Nils van der Poel's polarized training methodology. You design weekly training templates (recurring 7-day patterns).

Output STRICT JSON only — no markdown, no commentary. Schema:
{
  "days": [
    { "day_of_week": 0-6 (0=Monday, 6=Sunday), "is_rest": boolean, "label": string|null, "description": string|null },
    ... (exactly 7 entries, one per day_of_week 0..6)
  ]
}

Rules for label and description:
- "label" = short pass name in Swedish (e.g. "Distans Z2", "Tröskelpass", "Långpass Z2", "Cykel Z2", "Vila", "Lätt + strides")
- "description" = specific instructions: distance in km, target HR/pace zone, structure (e.g. "8 km lugn löpning Z2 (5:45-6:00/km)", "15 min uppvärm Z2 → 4×5 min i tröskel Z4 (1 min vila) → 10 min lugn", "12-14 km långpass Z2 (5:45-6:15/km)")
- Use 80/20 polarized: most days Z1-Z2 easy, 1-2 quality sessions per week max
- Always include at least 1 rest day (is_rest: true, label: null, description: null)
- Long session on Saturday or Sunday by default
- Never two hard days in a row
- Be SPECIFIC: km, time, zones, structure. Never generic ("intervaller" alone is bad).

The user will give you free-text instructions on what they want. They may also provide a current template to start from. Modify it accordingly. If they ask for a fresh schedule, build one from scratch following the rules above.`;

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

    let currentSummary = "Inget nuvarande schema (bygg från scratch).";
    if (currentTemplate.length === 7) {
      currentSummary = "Nuvarande veckoschema:\n" + currentTemplate.map((d: Record<string, unknown>) => {
        const dow = Number(d.day_of_week);
        const name = DAY_NAMES[dow] || `Dag ${dow}`;
        if (d.is_rest) return `- ${name}: Vila`;
        return `- ${name}: ${d.label || "(inget pass)"}${d.description ? " — " + d.description : ""}`;
      }).join("\n");
    }

    const userMsg = `${currentSummary}

${maxHr ? `Användarens maxpuls: ${maxHr} bpm.` : ""}

Önskemål:
${userPrompt}

Returnera ett komplett 7-dagars veckoschema som JSON enligt schemat. Bevara delar av nuvarande schema som inte berörs av önskemålet.`;

    const raw = await callOpenAI([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMsg },
    ]);

    let parsed: { days?: Array<Record<string, unknown>> };
    try {
      parsed = JSON.parse(raw);
    } catch (_e) {
      console.error("weekly-template-ai: invalid AI JSON", raw.slice(0, 300));
      return jsonResponse(req, { error: "ai_invalid_json" }, 502);
    }
    if (!Array.isArray(parsed?.days) || parsed.days.length !== 7) {
      console.error("weekly-template-ai: malformed days", parsed);
      return jsonResponse(req, { error: "ai_malformed_response" }, 502);
    }
    const days = parsed.days.map((d: Record<string, unknown>) => ({
      day_of_week: Number(d.day_of_week),
      is_rest: Boolean(d.is_rest),
      label: d.is_rest ? null : (d.label || null),
      description: d.is_rest ? null : (d.description || null),
    })).sort((a, b) => a.day_of_week - b.day_of_week);

    return jsonResponse(req, { days }, 200);
  } catch (e) {
    console.error("weekly-template-ai error:", e);
    return jsonResponse(req, { error: "internal_error" }, 500);
  }
});
