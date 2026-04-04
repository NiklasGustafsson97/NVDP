import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  GARMIN_CLIENT_ID,
  GARMIN_CLIENT_SECRET,
  APP_URL,
  GARMIN_TOKEN_URL,
  supabaseAdmin,
  corsHeaders,
} from "../_shared/garmin.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders() });
  }

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state"); // profile_id
  const error = url.searchParams.get("error");
  const codeVerifier = url.searchParams.get("code_verifier");

  if (error || !code || !state) {
    return Response.redirect(`${APP_URL}?garmin_error=${error || "missing_code"}`, 302);
  }

  try {
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: GARMIN_CLIENT_ID,
      client_secret: GARMIN_CLIENT_SECRET,
      redirect_uri: `${url.origin}${url.pathname}`,
    });
    if (codeVerifier) {
      params.set("code_verifier", codeVerifier);
    }

    const tokenRes = await fetch(GARMIN_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error("Garmin token exchange failed:", errText);
      return Response.redirect(`${APP_URL}?garmin_error=token_exchange_failed`, 302);
    }

    const tokenData = await tokenRes.json();
    const { access_token, refresh_token, expires_in } = tokenData;
    const garminUserId = tokenData.user_id || tokenData.userId || tokenData.sub || "";
    const expiresAt = Math.floor(Date.now() / 1000) + (expires_in || 3600);

    if (!garminUserId) {
      // Fetch user profile to get Garmin user ID
      const profileRes = await fetch("https://apis.garmin.com/wellness-api/rest/user/id", {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      const profileData = profileRes.ok ? await profileRes.json() : {};
      const resolvedUserId = profileData.userId || "unknown";

      if (resolvedUserId === "unknown") {
        console.error("Could not resolve Garmin user ID");
        return Response.redirect(`${APP_URL}?garmin_error=no_user_id`, 302);
      }

      return await upsertConnection(state, resolvedUserId, access_token, refresh_token, expiresAt);
    }

    return await upsertConnection(state, garminUserId, access_token, refresh_token, expiresAt);
  } catch (err) {
    console.error("garmin-auth error:", err);
    return Response.redirect(`${APP_URL}?garmin_error=unknown`, 302);
  }
});

async function upsertConnection(
  profileId: string,
  garminUserId: string,
  accessToken: string,
  refreshToken: string,
  expiresAt: number
) {
  const db = supabaseAdmin();

  // Remove any previous connection for this Garmin user from a different profile
  await db
    .from("garmin_connections")
    .delete()
    .eq("garmin_user_id", garminUserId)
    .neq("profile_id", profileId);

  const { error: upsertErr } = await db.from("garmin_connections").upsert(
    {
      profile_id: profileId,
      garmin_user_id: garminUserId,
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: expiresAt,
    },
    { onConflict: "profile_id" }
  );

  if (upsertErr) {
    console.error("DB upsert error:", upsertErr);
    return Response.redirect(`${APP_URL}?garmin_error=db_error`, 302);
  }

  return Response.redirect(`${APP_URL}?garmin_connected=true`, 302);
}
