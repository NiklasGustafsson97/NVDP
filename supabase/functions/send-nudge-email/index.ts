import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
// Comma-separated list of allowed browser origins, e.g.
//   "https://niklasgustafsson97.github.io,https://nvdp.app"
const APP_ORIGINS = (Deno.env.get("APP_ORIGINS") || "https://niklasgustafsson97.github.io")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Rate-limit: max nudge emails a single sender may trigger per day.
const NUDGE_DAILY_LIMIT = 30;

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

function jsonResponse(
  req: Request,
  body: unknown,
  status: number,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

// HTML-escape for safe embedding of user-supplied text into an HTML email body.
function escapeHtml(input: string): string {
  return String(input)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Returns true if the per-sender daily nudge quota is still available; also
// atomically increments the counter by 1 for today's bucket.
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
    .eq("bucket", "nudge_email_daily")
    .eq("window_start", windowStart)
    .maybeSingle();

  const current = row?.count ?? 0;
  if (current >= NUDGE_DAILY_LIMIT) return false;

  // Upsert new count. No atomic check-and-increment across concurrent
  // invocations, but acceptable for a 30/day budget.
  await db.from("rate_limits").upsert(
    {
      user_id: userId,
      bucket: "nudge_email_daily",
      window_start: windowStart,
      count: current + 1,
    },
    { onConflict: "user_id,bucket,window_start" },
  );
  return true;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(req) });
  }
  if (req.method !== "POST") {
    return jsonResponse(req, { error: "method_not_allowed" }, 405);
  }

  if (!RESEND_API_KEY) {
    console.error("send-nudge-email: RESEND_API_KEY not configured");
    return jsonResponse(req, { error: "internal_error" }, 500);
  }

  try {
    // ── Authenticate caller ────────────────────────────────────────────────
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return jsonResponse(req, { error: "unauthorized" }, 401);
    }
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) {
      return jsonResponse(req, { error: "unauthorized" }, 401);
    }

    // ── Parse + validate input ────────────────────────────────────────────
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return jsonResponse(req, { error: "invalid_body" }, 400);
    }
    const receiver_id = typeof body.receiver_id === "string" ? body.receiver_id : null;
    const message = typeof body.message === "string" ? body.message.slice(0, 500) : "";
    if (!receiver_id) {
      return jsonResponse(req, { error: "invalid_body" }, 400);
    }

    const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // ── Resolve sender profile from JWT (NEVER from body) ─────────────────
    const { data: senderProfile, error: sErr } = await db
      .from("profiles")
      .select("id, name")
      .eq("user_id", user.id)
      .maybeSingle();
    if (sErr || !senderProfile) {
      console.error("send-nudge-email: sender profile lookup failed", sErr);
      return jsonResponse(req, { error: "internal_error" }, 500);
    }
    if (senderProfile.id === receiver_id) {
      return jsonResponse(req, { error: "forbidden" }, 403);
    }

    // ── Rate limit: per-sender daily quota ────────────────────────────────
    const allowed = await checkAndIncrementRateLimit(db, user.id);
    if (!allowed) {
      return jsonResponse(req, { error: "rate_limited" }, 429);
    }

    // ── Authorize: must share a friendship or group with receiver ────────
    // Friendship (accepted)
    const { data: friendship } = await db
      .from("friendships")
      .select("id")
      .eq("status", "accepted")
      .or(
        `and(requester_id.eq.${senderProfile.id},receiver_id.eq.${receiver_id}),` +
          `and(requester_id.eq.${receiver_id},receiver_id.eq.${senderProfile.id})`,
      )
      .maybeSingle();

    let authorized = !!friendship;

    // Same group
    if (!authorized) {
      const { data: pair } = await db
        .from("profiles")
        .select("id, group_id")
        .in("id", [senderProfile.id, receiver_id]);
      if (pair && pair.length === 2) {
        const s = pair.find((p) => p.id === senderProfile.id);
        const r = pair.find((p) => p.id === receiver_id);
        if (s?.group_id && s.group_id === r?.group_id) {
          authorized = true;
        }
      }
    }
    if (!authorized) {
      return jsonResponse(req, { error: "forbidden" }, 403);
    }

    // ── Receiver email + notification preference ─────────────────────────
    const { data: receiverProfile } = await db
      .from("profiles")
      .select("user_id, email_notifications")
      .eq("id", receiver_id)
      .maybeSingle();
    if (!receiverProfile) {
      return jsonResponse(req, { error: "not_found" }, 404);
    }
    if (receiverProfile.email_notifications === false) {
      return jsonResponse(req, { skipped: true, reason: "notifications_disabled" }, 200);
    }
    const { data: userData } = await db.auth.admin.getUserById(receiverProfile.user_id);
    const receiverEmail = userData?.user?.email;
    if (!receiverEmail) {
      return jsonResponse(req, { error: "not_found" }, 404);
    }

    // ── Build email (escape all user-supplied text) ──────────────────────
    const senderNameSafe = escapeHtml(senderProfile.name || "NVDP");
    const emailBodyRaw = message || `${senderProfile.name || "Någon"} gav dig en puff! Dags att träna!`;
    const emailBodySafe = escapeHtml(emailBodyRaw);

    const subject = `${senderProfile.name || "Någon"} gav dig en puff!`;
    const plainText =
      `${emailBodyRaw}\n\n` +
      `Öppna NVDP: https://niklasgustafsson97.github.io/NVDP/\n\n` +
      `Du får detta mail för att ${senderProfile.name || "en vän"} skickade en puff i NVDP. ` +
      `Stäng av i appen under Inställningar → Mailnotiser.`;

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "NVDP <notifications@resend.dev>",
        to: [receiverEmail],
        subject,
        text: plainText,
        html: `
          <div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
            <h2 style="color:#2E86C1;margin:0 0 16px;">NVDP</h2>
            <p style="font-size:16px;color:#333;line-height:1.5;">${emailBodySafe}</p>
            <p style="margin-top:24px;">
              <a href="https://niklasgustafsson97.github.io/NVDP/"
                 style="display:inline-block;padding:12px 28px;background:#D6639E;color:#fff;
                        text-decoration:none;border-radius:8px;font-weight:600;">
                Öppna NVDP
              </a>
            </p>
            <p style="font-size:12px;color:#999;margin-top:32px;">
              Du får detta mail för att ${senderNameSafe} skickade en puff i NVDP.
              Stäng av i appen under Inställningar → Mailnotiser.
            </p>
          </div>
        `,
      }),
    });

    if (!resendRes.ok) {
      const errText = await resendRes.text();
      console.error("send-nudge-email: Resend error", resendRes.status, errText);
      return jsonResponse(req, { error: "email_send_failed" }, 502);
    }

    return jsonResponse(req, { sent: true }, 200);
  } catch (err) {
    console.error("send-nudge-email error:", err);
    return jsonResponse(req, { error: "internal_error" }, 500);
  }
});
