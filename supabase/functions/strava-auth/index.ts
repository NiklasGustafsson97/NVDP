import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  STRAVA_CLIENT_ID,
  STRAVA_CLIENT_SECRET,
  APP_URL,
  supabaseAdmin,
  corsHeaders,
} from "../_shared/strava.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders() });
  }

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state"); // profile_id
  const error = url.searchParams.get("error");

  if (error || !code || !state) {
    return Response.redirect(`${APP_URL}?strava_error=${error || "missing_code"}`, 302);
  }

  try {
    const tokenRes = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: STRAVA_CLIENT_ID,
        client_secret: STRAVA_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error("Strava token exchange failed:", errText);
      return Response.redirect(`${APP_URL}?strava_error=token_exchange_failed`, 302);
    }

    const tokenData = await tokenRes.json();
    const { access_token, refresh_token, expires_at, athlete } = tokenData;

    const db = supabaseAdmin();

    // Remove any previous connection for this Strava athlete from a different
    // profile so the unique constraint on strava_athlete_id won't block us.
    await db
      .from("strava_connections")
      .delete()
      .eq("strava_athlete_id", athlete.id)
      .neq("profile_id", state);

    const { error: upsertErr } = await db.from("strava_connections").upsert(
      {
        profile_id: state,
        strava_athlete_id: athlete.id,
        access_token,
        refresh_token,
        expires_at,
      },
      { onConflict: "profile_id" }
    );

    if (upsertErr) {
      console.error("DB upsert error:", upsertErr);
      return Response.redirect(`${APP_URL}?strava_error=db_error`, 302);
    }

    return Response.redirect(`${APP_URL}?strava_connected=true`, 302);
  } catch (err) {
    console.error("strava-auth error:", err);
    return Response.redirect(`${APP_URL}?strava_error=unknown`, 302);
  }
});
