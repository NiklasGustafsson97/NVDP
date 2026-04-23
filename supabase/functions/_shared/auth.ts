// Shared auth helper for Edge Functions.
//
// Resolves a request's bearer token to a `{ user, profileId, db }` triple:
//   * `user`      — Supabase auth user (from the user-scoped client)
//   * `profileId` — the matching `profiles.id` (most app tables FK to this,
//                   not directly to `auth.users.id`)
//   * `db`        — service-role client for downstream queries
//
// Returns `{ error }` with a ready-to-send `Response` on any failure so call
// sites stay flat:
//
//   const auth = await requireUserProfile(req);
//   if (auth.error) return auth.error;
//   const { user, profileId, db } = auth;
//
// SECURITY: every user-facing function deploys with `--no-verify-jwt` due to
// the ES256 gateway limitation (see deploy-functions.yml). This helper IS the
// auth gate — it MUST be the first thing each handler does.

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jsonResponse } from "./cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export interface AuthOk {
  error: null;
  // deno-lint-ignore no-explicit-any
  user: any;
  profileId: string;
  db: SupabaseClient;
}

export interface AuthErr {
  error: Response;
}

export type AuthResult = AuthOk | AuthErr;

export async function requireUserProfile(req: Request): Promise<AuthResult> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) return { error: jsonResponse(401, { error: "No auth header" }, req) };

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return { error: jsonResponse(401, { error: "Invalid token" }, req) };

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { data: profile } = await db
    .from("profiles")
    .select("id")
    .eq("user_id", user.id)
    .single();
  if (!profile) return { error: jsonResponse(404, { error: "Profile not found" }, req) };

  return { error: null, user, profileId: profile.id as string, db };
}

/** Service-role client for cron / webhook handlers that authenticate via a shared secret. */
export function serviceClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
}
