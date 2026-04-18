import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") || "";
const OPENAI_BASE_URL = Deno.env.get("OPENAI_BASE_URL") || "https://api.openai.com/v1";
const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
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

async function callOpenAI(messages: any[]): Promise<string> {
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
    throw new Error(`OpenAI ${res.status}: ${txt.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });

  try {
    if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not configured");
    const body = await req.json();
    const userPrompt = (body?.prompt || "").toString().trim();
    if (!userPrompt) throw new Error("Missing prompt");
    const currentTemplate = Array.isArray(body?.current_template) ? body.current_template : [];
    const maxHr = body?.max_hr || null;

    let currentSummary = "Inget nuvarande schema (bygg från scratch).";
    if (currentTemplate.length === 7) {
      currentSummary = "Nuvarande veckoschema:\n" + currentTemplate.map((d: any) => {
        const name = DAY_NAMES[d.day_of_week] || `Dag ${d.day_of_week}`;
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

    let parsed: any;
    try { parsed = JSON.parse(raw); } catch (_e) {
      throw new Error("AI returned invalid JSON");
    }
    if (!Array.isArray(parsed?.days) || parsed.days.length !== 7) {
      throw new Error("AI returned malformed days array");
    }
    // Normalize
    const days = parsed.days.map((d: any) => ({
      day_of_week: Number(d.day_of_week),
      is_rest: Boolean(d.is_rest),
      label: d.is_rest ? null : (d.label || null),
      description: d.is_rest ? null : (d.description || null),
    })).sort((a: any, b: any) => a.day_of_week - b.day_of_week);

    return new Response(JSON.stringify({ days }), {
      status: 200,
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 400,
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
    });
  }
});
