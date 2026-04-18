// Weekly check-in reminder — cron-triggered email.
//
// Schedule via Supabase cron (pg_cron) to run every Sunday around 17:00
// local (Europe/Stockholm). Example SQL (set up once, outside this repo):
//
//   select cron.schedule(
//     'weekly-checkin-reminder',
//     '0 17 * * 0',          -- 17:00 UTC every Sunday (adjust for TZ)
//     $$select net.http_post(
//         url:='<SUPABASE_URL>/functions/v1/weekly-checkin-reminder',
//         headers:='{"Authorization":"Bearer <SERVICE_ROLE_KEY>"}'::jsonb
//     )$$
//   );
//
// The function:
//   1. Authenticates using the service role (no user JWT required).
//   2. Finds every profile with an active training_plan, an email on file,
//      `weekly_checkin_reminders = true`, and no weekly_checkins row for
//      the ISO week just finished.
//   3. Sends a short Swedish reminder email via Resend.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const APP_URL = Deno.env.get("APP_URL") || "https://niklasgustafsson97.github.io/NVDP/";
const CRON_SECRET = Deno.env.get("CRON_SECRET") || "";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function isoDate(d: Date) { return d.toISOString().split("T")[0]; }

/** Monday of the ISO week being reviewed. On Sunday (cron day), that's the
 *  current week's Monday; on any other weekday the previous Monday. */
function reviewMonday(now: Date): Date {
  const d = new Date(now); d.setUTCHours(0, 0, 0, 0);
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  if (dow === 6) {
    d.setUTCDate(d.getUTCDate() - 6);
  } else {
    d.setUTCDate(d.getUTCDate() - dow - 7);
  }
  return d;
}

serve(async (req) => {
  try {
    // Defence in depth: require either service-role bearer or CRON_SECRET header.
    const auth = req.headers.get("authorization") || "";
    const cronToken = req.headers.get("x-cron-secret") || "";
    const serviceOk = auth.includes(SUPABASE_SERVICE_KEY);
    const cronOk = CRON_SECRET && cronToken === CRON_SECRET;
    if (!serviceOk && !cronOk) {
      return json({ error: "unauthorized" }, 401);
    }
    if (!RESEND_API_KEY) {
      return json({ error: "RESEND_API_KEY not configured" }, 500);
    }

    const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const weekStart = reviewMonday(new Date());
    const weekStartISO = isoDate(weekStart);

    // 1. Pull every profile with an active plan and reminders enabled.
    const { data: activePlans } = await db
      .from("training_plans")
      .select("profile_id")
      .eq("status", "active");
    const profileIds = [...new Set((activePlans || []).map((r: { profile_id: string }) => r.profile_id))];

    if (profileIds.length === 0) return json({ sent: 0, reason: "no active plans" });

    const { data: profiles } = await db
      .from("profiles")
      .select("id, user_id, name, weekly_checkin_reminders")
      .in("id", profileIds);

    const targets = (profiles || []).filter((p: { weekly_checkin_reminders: boolean }) =>
      p.weekly_checkin_reminders !== false
    );

    // 2. Exclude anyone who already filed a check-in this ISO week.
    const { data: existing } = await db
      .from("weekly_checkins")
      .select("profile_id, status")
      .eq("week_start_date", weekStartISO)
      .in("profile_id", targets.map((p: { id: string }) => p.id));
    const donePids = new Set((existing || []).map((r: { profile_id: string }) => r.profile_id));

    const toEmail = targets.filter((p: { id: string }) => !donePids.has(p.id));

    // 3. Send.
    let sent = 0;
    let errors = 0;
    for (const p of toEmail) {
      try {
        const { data: userData } = await db.auth.admin.getUserById(p.user_id);
        const email = userData?.user?.email;
        if (!email) continue;

        const firstName = String(p.name || "").split(" ")[0] || "du";
        const subject = "Dags för veckoavstämning med coachen";
        const html = `
          <div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
            <h2 style="color:#2E86C1;margin:0 0 16px;">NVDP</h2>
            <p style="font-size:16px;color:#333;line-height:1.5;">Hej ${escapeHtml(firstName)}!</p>
            <p style="font-size:16px;color:#333;line-height:1.5;">
              Söndag kväll — perfekt tid att kolla in med coachen.
              Ta en minut, berätta hur veckan gick, så anpassar vi nästa vecka efter det.
            </p>
            <p style="margin-top:24px;">
              <a href="${APP_URL}" style="display:inline-block;padding:12px 28px;background:#2E86C1;
                 color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">
                Öppna veckoavstämningen
              </a>
            </p>
            <p style="font-size:12px;color:#999;margin-top:32px;">
              Du får detta mail varje söndag eftersom du har en aktiv plan i NVDP.
              Stäng av i appen under Inställningar.
            </p>
          </div>`;

        const r = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${RESEND_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: "NVDP <notifications@resend.dev>",
            to: [email],
            subject,
            html,
          }),
        });
        if (r.ok) sent++; else errors++;
      } catch (_e) {
        errors++;
      }
    }

    return json({ sent, errors, candidates: toEmail.length, week_start: weekStartISO });
  } catch (err) {
    console.error("weekly-checkin-reminder error:", err);
    console.error("weekly-checkin-reminder error:", err);
    return json({ error: "internal_error" }, 500);
  }
});

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
