import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  GARMIN_CLIENT_ID,
  GARMIN_CLIENT_SECRET,
  APP_URL,
  GARMIN_TOKEN_URL,
  supabaseAdmin,
  corsHeaders,
} from "../_shared/garmin.ts";

// SECURITY (assessment H2 + H3):
//   * `state` is validated against `public.oauth_states` — single-use,
//     short-lived, random (no longer the user's profile_id).
//   * PKCE `code_verifier` is read from the DB, not from the callback URL.
//     Previously it was passed as a query parameter (?code_verifier=...),
//     which leaked it to Garmin, referer headers and browser history.

const STATE_MAX_AGE_SECONDS = 15 * 60;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(req) });
  }

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error || !code || !state) {
    return Response.redirect(
      `${APP_URL}?garmin_error=${encodeURIComponent(error || "missing_code")}`,
      302,
    );
  }

  const db = supabaseAdmin();

  // Validate + consume the state.
  const { data: stateRow, error: stateErr } = await db
    .from("oauth_states")
    .select("profile_id, provider, code_verifier, created_at, used_at")
    .eq("state", state)
    .maybeSingle();
  if (stateErr || !stateRow) {
    console.error("garmin-auth: unknown state", stateErr);
    return Response.redirect(`${APP_URL}?garmin_error=invalid_state`, 302);
  }
  if (stateRow.provider !== "garmin") {
    return Response.redirect(`${APP_URL}?garmin_error=invalid_state`, 302);
  }
  if (stateRow.used_at) {
    return Response.redirect(`${APP_URL}?garmin_error=state_already_used`, 302);
  }
  const ageSeconds = (Date.now() - new Date(stateRow.created_at).getTime()) / 1000;
  if (ageSeconds > STATE_MAX_AGE_SECONDS) {
    return Response.redirect(`${APP_URL}?garmin_error=state_expired`, 302);
  }
  const profileId = stateRow.profile_id as string;
  const codeVerifier = stateRow.code_verifier as string | null;
  await db
    .from("oauth_states")
    .update({ used_at: new Date().toISOString() })
    .eq("state", state);

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
      console.error("garmin-auth: token exchange failed", errText);
      return Response.redirect(`${APP_URL}?garmin_error=token_exchange_failed`, 302);
    }

    const tokenData = await tokenRes.json();
    const { access_token, refresh_token, expires_in } = tokenData;
    const garminUserId = tokenData.user_id || tokenData.userId || tokenData.sub || "";
    const expiresAt = Math.floor(Date.now() / 1000) + (expires_in || 3600);

    if (!garminUserId) {
      const profileRes = await fetch("https://apis.garmin.com/wellness-api/rest/user/id", {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      const profileData = profileRes.ok ? await profileRes.json() : {};
      const resolvedUserId = profileData.userId || "unknown";

      if (resolvedUserId === "unknown") {
        console.error("garmin-auth: could not resolve Garmin user ID");
        return Response.redirect(`${APP_URL}?garmin_error=no_user_id`, 302);
      }

      return await upsertConnection(profileId, resolvedUserId, access_token, refresh_token, expiresAt);
    }

    return await upsertConnection(profileId, garminUserId, access_token, refresh_token, expiresAt);
  } catch (err) {
    console.error("garmin-auth error", err);
    return Response.redirect(`${APP_URL}?garmin_error=unknown`, 302);
  }
});

async function upsertConnection(
  profileId: string,
  garminUserId: string,
  accessToken: string,
  refreshToken: string,
  expiresAt: number,
) {
  const db = supabaseAdmin();

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
    { onConflict: "profile_id" },
  );

  if (upsertErr) {
    console.error("garmin-auth: DB upsert error", upsertErr);
    return Response.redirect(`${APP_URL}?garmin_error=db_error`, 302);
  }

  return Response.redirect(`${APP_URL}?garmin_connected=true`, 302);
}
