// Weekly Coach Check-In edge function
// POST with { mode: "propose" | "apply" | "decline", ...payload } and a valid user bearer token.
//
// propose  → computes objective snapshot for the week that just finished,
//            runs the rule-based decision engine (optionally LLM on top)
//            against next week's plan, stores a `weekly_checkins` row
//            with status='pending', and returns the diff.
// apply    → applies the selected changes to plan_workouts and marks
//            the check-in applied.
// decline  → marks the check-in declined. No plan mutation.
//
// Engine, validator, builders, and applyChanges live in
// site/supabase/functions/_shared/checkin-engine.ts so coach-chat can reuse them.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  type CheckinResponses,
  type EngineOutput,
  type ObjectiveSummary,
  type PlanWorkout,
  type ProposedChange,
  applyChanges,
  buildObjectiveSummary,
  dayName,
  isoDate,
  reviewWeekStart,
  runDecisionEngine,
} from "../_shared/checkin-engine.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") || "";
const OPENAI_BASE_URL = Deno.env.get("OPENAI_BASE_URL") || "https://api.openai.com/v1";
const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini";

// SECURITY (assessment M3): CORS was `*`. Restrict to an APP_ORIGINS
// allowlist (comma-separated env var) so a malicious origin can't invoke
// the endpoint with a user's credentials.
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

function json(status: number, body: unknown, req?: Request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

// ────────────────────────────────────────────────────────────────────────────
//  Optional LLM coach — wraps the rule engine's output (refine reasons + note)
// ────────────────────────────────────────────────────────────────────────────

const COACH_SYSTEM_PROMPT = `You are a conservative, warm endurance-running coach (Nils van der Poel polarized school). Your job is to write a short weekly coach note IN SWEDISH based on the user's answers, the objective week summary, and the proposed changes the rule engine already produced.

Output STRICT JSON only: { "coach_note": "2-3 sentences, Swedish, warm but direct", "refined_reasons": [{"id": "<change_id>", "reason_sv": "one short Swedish sentence"}] }

Rules:
- Do NOT propose new changes. Do NOT remove changes. Only rewrite the coach_note and optionally refine each change's reason_sv to sound more like a human coach.
- Tone: warm, plain-spoken, Swedish, no hype, no emoji unless the user's feel score is 5.
- Never override the rule engine's decisions. If you disagree, say so in the coach_note; do not silently change them.
- Reference the user's actual answers (feel score, injury, long run) when relevant.`;

async function refineWithLLM(
  responses: CheckinResponses,
  summary: ObjectiveSummary,
  baseOutput: EngineOutput,
): Promise<EngineOutput> {
  if (!OPENAI_API_KEY || baseOutput.changes.length === 0 && !responses.free_text) {
    return baseOutput;
  }
  try {
    const userMsg = `User answers:\n${JSON.stringify(responses)}\n\nObjective summary:\n${JSON.stringify({
      weekly_load: summary.weekly_load,
      prior_4wk_avg_load: summary.prior_4wk_avg_load,
      acwr: summary.acwr,
      acwr_band: summary.acwr_band,
      completion_rate: summary.completion_rate,
      easy_avg_hr: summary.easy_avg_hr,
      easy_avg_hr_prior_4wk: summary.easy_avg_hr_prior_4wk,
      missed_sessions: summary.missed_sessions,
      next_week_phase: summary.next_week_phase,
    })}\n\nProposed changes (DO NOT MODIFY, only refine reasons and write coach_note):\n${JSON.stringify(baseOutput.changes.map((c) => ({
      id: c.id,
      day: dayName(c.day_of_week),
      action: c.action,
      current: c.current_workout?.label,
      proposed: c.proposed_workout?.label,
      default_reason_sv: c.reason_sv,
    })))}\n\nReturn { coach_note, refined_reasons: [...] } as strict JSON.`;

    const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        response_format: { type: "json_object" },
        temperature: 0.5,
        messages: [
          { role: "system", content: COACH_SYSTEM_PROMPT },
          { role: "user", content: userMsg },
        ],
      }),
    });
    if (!res.ok) return baseOutput;
    const data = await res.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || "{}");
    if (typeof parsed.coach_note === "string" && parsed.coach_note.trim()) {
      baseOutput.coach_note = parsed.coach_note.trim();
    }
    if (Array.isArray(parsed.refined_reasons)) {
      const byId = new Map(baseOutput.changes.map((c) => [c.id, c]));
      for (const r of parsed.refined_reasons) {
        if (r && typeof r.id === "string" && typeof r.reason_sv === "string") {
          const c = byId.get(r.id);
          if (c) c.reason_sv = r.reason_sv.trim() || c.reason_sv;
        }
      }
    }
    return baseOutput;
  } catch (_e) {
    return baseOutput;
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

    const body = await req.json();
    const mode: string = body?.mode || "propose";

    // ─────────────── DECLINE ───────────────
    if (mode === "decline") {
      const { checkin_id } = body as { checkin_id?: string };
      if (!checkin_id) return json(400, { error: "Missing checkin_id" }, req);
      const { data: row } = await db.from("weekly_checkins")
        .select("id, profile_id, status")
        .eq("id", checkin_id)
        .single();
      if (!row || row.profile_id !== profileId) return json(404, { error: "Check-in not found" }, req);
      if (row.status !== "pending") return json(409, { error: `Check-in is ${row.status}` }, req);
      await db.from("weekly_checkins")
        .update({ status: "declined", applied_at: new Date().toISOString() })
        .eq("id", checkin_id);
      return json(200, { ok: true }, req);
    }

    // ─────────────── APPLY ───────────────
    if (mode === "apply") {
      const { checkin_id, accepted_change_ids } = body as {
        checkin_id?: string;
        accepted_change_ids?: string[];
      };
      if (!checkin_id) return json(400, { error: "Missing checkin_id" }, req);
      const accepted = accepted_change_ids || [];
      const { data: row } = await db.from("weekly_checkins")
        .select("id, profile_id, status, proposed_changes, objective_summary, plan_id, week_start_date")
        .eq("id", checkin_id)
        .single();
      if (!row || row.profile_id !== profileId) return json(404, { error: "Check-in not found" }, req);
      if (row.status !== "pending") return json(409, { error: `Check-in is ${row.status}` }, req);

      const proposed = (row.proposed_changes || []) as ProposedChange[];
      const toApply = proposed.filter((c) => accepted.includes(c.id));

      const nextWeekPlan = ((row.objective_summary || {}) as ObjectiveSummary).next_week_plan || [];
      if (nextWeekPlan.length > 0) {
        const ids = nextWeekPlan.map((w) => w.id);
        const { data: fresh } = await db.from("plan_workouts").select("*").in("id", ids);
        if (fresh) {
          await applyChanges(db, fresh as PlanWorkout[], toApply);
        }
      }

      await db.from("weekly_checkins").update({
        status: "applied",
        applied_changes: toApply.map((c) => c.id),
        applied_at: new Date().toISOString(),
      }).eq("id", checkin_id);

      return json(200, { ok: true, applied: toApply.length }, req);
    }

    // ─────────────── PROPOSE ───────────────
    const responses = (body?.responses || {}) as CheckinResponses;
    if (typeof responses.overall_feel !== "number" || !responses.injury_level) {
      return json(400, { error: "responses.overall_feel and responses.injury_level are required" }, req);
    }

    const now = new Date();
    const { weekStart, weekNotYetClosed } = reviewWeekStart(now);
    const weekStartISO = isoDate(weekStart);

    const { data: existing } = await db.from("weekly_checkins")
      .select("id, status")
      .eq("profile_id", profileId)
      .eq("week_start_date", weekStartISO)
      .maybeSingle();
    if (existing && existing.status === "pending") {
      return json(409, { error: "A pending check-in already exists for this week", checkin_id: existing.id }, req);
    }
    if (existing && existing.status === "applied") {
      return json(409, { error: "You already completed this week's check-in", checkin_id: existing.id }, req);
    }

    const { data: plan } = await db.from("training_plans")
      .select("id")
      .eq("profile_id", profileId)
      .eq("status", "active")
      .maybeSingle();
    const planId: string | null = plan?.id ?? null;

    if (!planId) {
      return json(400, {
        error: "Veckoavstämning kräver en aktiv AI-plan. Skapa en plan först.",
        code: "no_active_plan",
      }, req);
    }

    const summary = await buildObjectiveSummary(db, profileId, userMaxHr, planId, weekStart, weekNotYetClosed);

    if (summary.next_week_plan.length === 0) {
      return json(400, {
        error: "Hittade inga pass för nästa vecka i din plan.",
        code: "no_next_week",
      }, req);
    }

    const engineOutput = runDecisionEngine({ responses, summary });
    const refined = await refineWithLLM(responses, summary, engineOutput);

    const { data: inserted, error: insErr } = await db.from("weekly_checkins").insert({
      profile_id: profileId,
      plan_id: planId,
      week_start_date: weekStartISO,
      responses,
      objective_summary: summary,
      proposed_changes: refined.changes,
      coach_note: refined.coach_note,
      status: "pending",
    }).select("id").single();

    if (insErr) {
      console.error("weekly-checkin: insert failed", insErr);
      return json(500, { error: "db_insert_failed" }, req);
    }

    return json(200, {
      checkin_id: inserted.id,
      coach_note: refined.coach_note,
      changes: refined.changes,
      summary: {
        week_start: summary.week_start,
        week_not_yet_closed: summary.week_not_yet_closed,
        completion_rate: summary.completion_rate,
        acwr: summary.acwr,
        acwr_band: summary.acwr_band,
        missed_sessions: summary.missed_sessions,
        next_week_phase: summary.next_week_phase,
      },
      next_week_plan: summary.next_week_plan,
    }, req);
  } catch (err) {
    // SECURITY (assessment H4): never leak err.message to the client.
    console.error("weekly-checkin error:", err);
    return json(500, { error: "internal_error" }, req);
  }
});
