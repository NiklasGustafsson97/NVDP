// SECURITY (assessment H2 + H3): Issues an OAuth `state` (and for Garmin, a
// PKCE code_verifier / code_challenge pair) server-side, stored in
// `public.oauth_states`. The frontend never has to generate or store a PKCE
// verifier, which prevents it from leaking into URL history / referer headers
// and prevents a predictable `state = profile_id` (account-linking CSRF).
//
// Authenticated endpoint. Body: { provider: "strava" | "garmin" }.
// Response: { state: string, code_challenge?: string }

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Origin allowlist (see assessment M3). Comma-separated env var.
const APP_ORIGINS = (Deno.env.get("APP_ORIGINS") ||
  "https://niklasgustafsson97.github.io").split(",").map((o) => o.trim()).filter(Boolean);

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  const allow = APP_ORIGINS.includes(origin) ? origin : APP_ORIGINS[0] || "";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function jsonResponse(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

function randomBase64Url(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64UrlEncode(buf);
}

function base64UrlEncode(buf: Uint8Array): string {
  let binary = "";
  for (const b of buf) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Base64Url(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(digest));
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(req) });
  }
  if (req.method !== "POST") {
    return jsonResponse(req, { error: "method_not_allowed" }, 405);
  }

  // Authenticate caller — only a logged-in user can initiate an OAuth link.
  const authHeader = req.headers.get("authorization");
  if (!authHeader) return jsonResponse(req, { error: "unauthorized" }, 401);
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return jsonResponse(req, { error: "unauthorized" }, 401);

  // Parse + validate body.
  let body: { provider?: string } = {};
  try {
    body = await req.json();
  } catch {
    return jsonResponse(req, { error: "bad_json" }, 400);
  }
  const provider = body.provider;
  if (provider !== "strava" && provider !== "garmin") {
    return jsonResponse(req, { error: "invalid_provider" }, 400);
  }

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Look up caller's profile (never trust a body-supplied profile_id).
  const { data: profile, error: profErr } = await db
    .from("profiles")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (profErr || !profile) {
    console.error("oauth-state: profile lookup failed", profErr);
    return jsonResponse(req, { error: "profile_not_found" }, 404);
  }

  // Generate random state (32 bytes → ~43 chars base64url).
  const state = randomBase64Url(32);

  // For Garmin, generate PKCE verifier + challenge.
  let codeVerifier: string | null = null;
  let codeChallenge: string | undefined = undefined;
  if (provider === "garmin") {
    codeVerifier = randomBase64Url(48);
    codeChallenge = await sha256Base64Url(codeVerifier);
  }

  const { error: insErr } = await db.from("oauth_states").insert({
    state,
    profile_id: profile.id,
    provider,
    code_verifier: codeVerifier,
  });
  if (insErr) {
    console.error("oauth-state: insert failed", insErr);
    return jsonResponse(req, { error: "state_store_failed" }, 500);
  }

  return jsonResponse(req, {
    state,
    ...(codeChallenge ? { code_challenge: codeChallenge, code_challenge_method: "S256" } : {}),
  });
});
