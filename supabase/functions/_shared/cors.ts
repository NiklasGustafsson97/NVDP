// Shared CORS helper for Edge Functions.
//
// Single source of truth for the browser-origin allowlist and the headers
// returned on both preflight (OPTIONS) and real responses. Each function
// previously copy-pasted this 8-line helper; bugs (e.g. forgetting a method
// or missing the Vary header) had to be fixed in every copy.
//
// SECURITY (assessment M3): browser origins are restricted to an allowlist
// configured via the `APP_ORIGINS` env var (comma-separated). When the
// caller's origin is not in the allowlist we fall back to the first
// configured origin so CORS effectively denies the request. Falling back to
// `*` would silently permit credentialed requests from any site.

const APP_ORIGINS = (Deno.env.get("APP_ORIGINS") ||
  "https://niklasgustafsson97.github.io")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

export interface CorsOptions {
  /** HTTP methods to allow. Defaults to "POST, OPTIONS". */
  methods?: string;
  /** Extra request headers to allow on top of the standard auth/apikey set. */
  extraHeaders?: string[];
}

const DEFAULT_HEADERS = ["authorization", "x-client-info", "apikey", "content-type"];

export function corsHeaders(req?: Request, opts: CorsOptions = {}): Record<string, string> {
  const origin = req?.headers.get("origin") || "";
  const allow = APP_ORIGINS.includes(origin) ? origin : APP_ORIGINS[0] || "null";
  const headers = [...DEFAULT_HEADERS, ...(opts.extraHeaders || [])].join(", ");
  return {
    "Access-Control-Allow-Origin": allow,
    "Vary": "Origin",
    "Access-Control-Allow-Headers": headers,
    "Access-Control-Allow-Methods": opts.methods || "POST, OPTIONS",
  };
}

/** Standard JSON response with CORS + content-type set. */
export function jsonResponse(status: number, body: unknown, req?: Request, opts?: CorsOptions): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req, opts), "Content-Type": "application/json" },
  });
}

/** Handle the OPTIONS preflight. Returns null when not a preflight request. */
export function handlePreflight(req: Request, opts?: CorsOptions): Response | null {
  if (req.method !== "OPTIONS") return null;
  return new Response("ok", { headers: corsHeaders(req, opts) });
}
