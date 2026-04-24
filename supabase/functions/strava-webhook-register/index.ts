// strava-webhook-register — manage the Strava push-subscription that
// drives real-time activity imports.
//
// Why this function exists:
//   Strava webhooks are the single biggest API-cost lever we have. With
//   a live subscription, Strava pushes us each new activity once (~1
//   detail call + maybe 1 zones call to import); without it, every user
//   needs an incremental poll every few hours to catch new activities,
//   which costs 30 users × ~2 list calls/day = wasted budget that
//   competes with deep-syncs and ad-hoc loads.
//
//   Strava only permits ONE push_subscription per OAuth application, so
//   the lifecycle is: register once → forget → re-register if it ever
//   gets deleted (Strava drops subscriptions if our callback returns
//   non-2xx for ~24h). This function makes that lifecycle scriptable
//   from chat or CI instead of a hand-typed curl.
//
// Endpoints:
//   POST   → idempotent register: GET existing subs, only POST if none
//             match our callback_url. Returns the active subscription.
//   GET    → list current subscriptions for our client_id (debug).
//   DELETE → unsubscribe (rarely used; mostly for rotating verify_token).
//
// Auth:
//   Requires header `x-cron-secret: <CRON_SECRET>` OR a service-role
//   bearer token. Same defence-in-depth pattern as
//   weekly-checkin-reminder / coach-nudge — keeps this function
//   uninvocable by anonymous browsers even though it ships with
//   --no-verify-jwt (so admins can curl it without minting a user JWT).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const STRAVA_CLIENT_ID = Deno.env.get("STRAVA_CLIENT_ID")!;
const STRAVA_CLIENT_SECRET = Deno.env.get("STRAVA_CLIENT_SECRET")!;
const STRAVA_VERIFY_TOKEN = Deno.env.get("STRAVA_VERIFY_TOKEN") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") || "";

// Default callback_url is our own strava-webhook function on this same
// Supabase project. Overridable via request body so we can point at a
// preview deploy from CI.
const DEFAULT_CALLBACK_URL = `${SUPABASE_URL}/functions/v1/strava-webhook`;

const STRAVA_API = "https://www.strava.com/api/v3/push_subscriptions";

interface StravaSubscription {
  id: number;
  application_id: number;
  callback_url: string;
  created_at: string;
  updated_at: string;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-cron-secret, content-type",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

async function listSubscriptions(): Promise<StravaSubscription[]> {
  const url = new URL(STRAVA_API);
  url.searchParams.set("client_id", STRAVA_CLIENT_ID);
  url.searchParams.set("client_secret", STRAVA_CLIENT_SECRET);
  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Strava list subs failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return await res.json() as StravaSubscription[];
}

async function createSubscription(callbackUrl: string): Promise<StravaSubscription> {
  // Strava expects application/x-www-form-urlencoded here, NOT JSON. Get
  // this wrong and you receive a confusing 400 with `field: callback_url`
  // even though the URL is fine.
  const form = new URLSearchParams({
    client_id: STRAVA_CLIENT_ID,
    client_secret: STRAVA_CLIENT_SECRET,
    callback_url: callbackUrl,
    verify_token: STRAVA_VERIFY_TOKEN,
  });
  const res = await fetch(STRAVA_API, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    // Strava 400 example when our /strava-webhook GET handler doesn't
    // echo hub.challenge: `{"errors":[{"resource":"PushSubscription",
    // "field":"callback url","code":"GET hub.challenge?"}]}` — surface
    // the raw error so the caller can act on it.
    throw new Error(`Strava create sub failed: ${res.status} ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as StravaSubscription;
}

async function deleteSubscription(id: number): Promise<void> {
  const url = new URL(`${STRAVA_API}/${id}`);
  url.searchParams.set("client_id", STRAVA_CLIENT_ID);
  url.searchParams.set("client_secret", STRAVA_CLIENT_SECRET);
  const res = await fetch(url.toString(), { method: "DELETE" });
  if (!res.ok && res.status !== 204) {
    const body = await res.text();
    throw new Error(`Strava delete sub failed: ${res.status} ${body.slice(0, 200)}`);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders() });
  }

  // Defence in depth: same check pattern as weekly-checkin-reminder.
  const auth = req.headers.get("authorization") || "";
  const cronToken = req.headers.get("x-cron-secret") || "";
  const serviceOk = !!SUPABASE_SERVICE_KEY && auth.includes(SUPABASE_SERVICE_KEY);
  const cronOk = !!CRON_SECRET && cronToken === CRON_SECRET;
  if (!serviceOk && !cronOk) {
    return json({ error: "unauthorized" }, 401);
  }

  if (!STRAVA_VERIFY_TOKEN) {
    // We must never POST a subscription with an empty verify_token —
    // it would let anyone spoof events at our /strava-webhook callback.
    return json({ error: "STRAVA_VERIFY_TOKEN env var is not set" }, 500);
  }

  try {
    if (req.method === "GET") {
      const subs = await listSubscriptions();
      return json({ subscriptions: subs });
    }

    if (req.method === "POST") {
      let callbackUrl = DEFAULT_CALLBACK_URL;
      try {
        const body = await req.json();
        if (body && typeof body.callback_url === "string") {
          callbackUrl = body.callback_url;
        }
      } catch {
        // empty body is fine — use default callback
      }

      // Idempotent: if a sub already targets our callback, return it
      // instead of trying to create a duplicate (Strava 400's on dup).
      const existing = await listSubscriptions();
      const match = existing.find((s) => s.callback_url === callbackUrl);
      if (match) {
        return json({
          subscription: match,
          created: false,
          note: "Subscription already exists for this callback_url.",
        });
      }

      const sub = await createSubscription(callbackUrl);
      return json({ subscription: sub, created: true });
    }

    if (req.method === "DELETE") {
      let targetId: number | null = null;
      const url = new URL(req.url);
      const idParam = url.searchParams.get("id");
      if (idParam) targetId = Number(idParam);
      if (targetId === null || Number.isNaN(targetId)) {
        // No explicit id: delete every sub (typical recovery path when
        // we're rotating STRAVA_VERIFY_TOKEN and need a clean slate).
        const subs = await listSubscriptions();
        for (const s of subs) await deleteSubscription(s.id);
        return json({ deleted: subs.map((s) => s.id) });
      }
      await deleteSubscription(targetId);
      return json({ deleted: [targetId] });
    }

    return json({ error: "method_not_allowed" }, 405);
  } catch (err) {
    console.error("strava-webhook-register error:", err);
    return json({ error: (err as Error).message }, 500);
  }
});
