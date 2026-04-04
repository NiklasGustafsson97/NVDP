import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (!RESEND_API_KEY) {
    return new Response(
      JSON.stringify({ error: "RESEND_API_KEY not configured" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    const { receiver_id, sender_name, message } = await req.json();
    if (!receiver_id || !sender_name) {
      return new Response(
        JSON.stringify({ error: "Missing receiver_id or sender_name" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Check receiver's email notification preference
    const { data: profile } = await db
      .from("profiles")
      .select("email_notifications")
      .eq("id", receiver_id)
      .single();

    if (profile && profile.email_notifications === false) {
      return new Response(
        JSON.stringify({ skipped: true, reason: "notifications_disabled" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get receiver's email from auth.users via profile
    const { data: receiverProfile } = await db
      .from("profiles")
      .select("user_id, name")
      .eq("id", receiver_id)
      .single();

    if (!receiverProfile) {
      return new Response(
        JSON.stringify({ error: "Receiver not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data: userData } = await db.auth.admin.getUserById(
      receiverProfile.user_id
    );
    const receiverEmail = userData?.user?.email;
    if (!receiverEmail) {
      return new Response(
        JSON.stringify({ error: "No email for receiver" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const emailBody = message || `${sender_name} gav dig en puff! Dags att träna! 💪`;

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "NVDP <notifications@resend.dev>",
        to: [receiverEmail],
        subject: `${sender_name} gav dig en puff!`,
        html: `
          <div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
            <h2 style="color:#2E86C1;margin:0 0 16px;">NVDP</h2>
            <p style="font-size:16px;color:#333;line-height:1.5;">${emailBody}</p>
            <p style="margin-top:24px;">
              <a href="https://niklasgustafsson97.github.io/NVDP/"
                 style="display:inline-block;padding:12px 28px;background:#D6639E;color:#fff;
                        text-decoration:none;border-radius:8px;font-weight:600;">
                Öppna NVDP
              </a>
            </p>
            <p style="font-size:12px;color:#999;margin-top:32px;">
              Du får detta mail för att ${sender_name} skickade en puff i NVDP.
              Stäng av i appen under Inställningar → Mailnotiser.
            </p>
          </div>
        `,
      }),
    });

    if (!resendRes.ok) {
      const errText = await resendRes.text();
      console.error("Resend error:", errText);
      return new Response(
        JSON.stringify({ error: "Email send failed", detail: errText }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ sent: true }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("send-nudge-email error:", err);
    return new Response(
      JSON.stringify({ error: "Internal error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
