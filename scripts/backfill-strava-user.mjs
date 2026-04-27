#!/usr/bin/env node

const DEFAULT_SINCE = "2025-01-01";
const DEFAULT_PROFILE_NAME = "August";
const DEFAULT_MAX_CHUNKS = 250;

function parseArgs(argv) {
  const args = {
    since: DEFAULT_SINCE,
    name: DEFAULT_PROFILE_NAME,
    profileId: "",
    maxChunks: DEFAULT_MAX_CHUNKS,
    dryRun: false,
    wait: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[++i];
    };

    if (arg === "--profile-id") args.profileId = next();
    else if (arg === "--name" || arg === "--profile-name") args.name = next();
    else if (arg === "--since") args.since = next();
    else if (arg === "--max-chunks") args.maxChunks = Number.parseInt(next(), 10);
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--no-wait") args.wait = false;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.since)) {
    throw new Error("--since must be an ISO date like 2025-01-01");
  }
  if (!Number.isFinite(args.maxChunks) || args.maxChunks < 1) {
    throw new Error("--max-chunks must be a positive integer");
  }
  return args;
}

function usage() {
  return `
Backfill Strava workouts for one profile by repeatedly calling the deployed
strava-sync Edge Function with service-role auth.

Required environment variables:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY

Examples:
  node scripts/backfill-strava-user.mjs --name August
  node scripts/backfill-strava-user.mjs --profile-id <uuid> --since 2025-01-01
  node scripts/backfill-strava-user.mjs --name August --dry-run

Options:
  --name, --profile-name <text>  Find profile by name. Defaults to "August".
  --profile-id <uuid>           Use a known profile id directly.
  --since <YYYY-MM-DD>          Deep-sync floor. Defaults to ${DEFAULT_SINCE}.
  --max-chunks <n>              Safety cap. Defaults to ${DEFAULT_MAX_CHUNKS}.
  --dry-run                     Resolve profile and connection, then stop.
  --no-wait                     Stop instead of waiting when Strava rate-limits.
`.trim();
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value.replace(/\/+$/, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeFetchError(err, url) {
  const cause = err?.cause;
  const parts = [
    `Network request failed for ${url.origin}`,
    err?.message ? `message=${err.message}` : null,
    cause?.code ? `cause.code=${cause.code}` : null,
    cause?.message ? `cause.message=${cause.message}` : null,
  ].filter(Boolean);
  return parts.join("; ");
}

async function restGet({ supabaseUrl, serviceKey, table, params, preferCount = false }) {
  const url = new URL(`${supabaseUrl}/rest/v1/${table}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
  };
  if (preferCount) headers.Prefer = "count=exact";

  let res;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    throw new Error(describeFetchError(err, url));
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    throw new Error(`REST ${table} failed (${res.status}): ${String(text).slice(0, 300)}`);
  }

  return { data, headers: res.headers };
}

async function resolveProfile({ supabaseUrl, serviceKey, profileId, name }) {
  if (profileId) {
    const { data } = await restGet({
      supabaseUrl,
      serviceKey,
      table: "profiles",
      params: { select: "id,name", id: `eq.${profileId}`, limit: "1" },
    });
    if (!Array.isArray(data) || data.length === 0) {
      throw new Error(`No profile found for id ${profileId}`);
    }
    return data[0];
  }

  const { data } = await restGet({
    supabaseUrl,
    serviceKey,
    table: "profiles",
    params: { select: "id,name", name: `ilike.*${name}*`, order: "name.asc" },
  });

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`No profile found matching name "${name}"`);
  }

  const exact = data.filter((p) => String(p.name || "").toLowerCase() === name.toLowerCase());
  const candidates = exact.length > 0 ? exact : data;
  if (candidates.length !== 1) {
    console.log("Multiple matching profiles found. Re-run with --profile-id:");
    for (const p of candidates) console.log(`  ${p.id}  ${p.name}`);
    process.exitCode = 2;
    return null;
  }

  return candidates[0];
}

async function getStravaConnection({ supabaseUrl, serviceKey, profileId }) {
  const { data } = await restGet({
    supabaseUrl,
    serviceKey,
    table: "strava_connections",
    params: {
      select: "id,profile_id,strava_athlete_id,last_sync_at,deep_sync_floor,deep_sync_anchor",
      profile_id: `eq.${profileId}`,
      limit: "1",
    },
  });

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`No Strava connection found for profile ${profileId}`);
  }
  return data[0];
}

async function countStravaWorkouts({ supabaseUrl, serviceKey, profileId, since }) {
  const { headers } = await restGet({
    supabaseUrl,
    serviceKey,
    table: "workouts",
    params: {
      select: "id",
      profile_id: `eq.${profileId}`,
      workout_date: `gte.${since}`,
      source: "eq.strava",
      limit: "1",
    },
    preferCount: true,
  });

  const contentRange = headers.get("content-range") || "";
  const match = contentRange.match(/\/(\d+)$/);
  return match ? Number.parseInt(match[1], 10) : null;
}

async function callSync({ supabaseUrl, serviceKey, profileId, since }) {
  const url = new URL(`${supabaseUrl}/functions/v1/strava-sync`);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ profile_id: profileId, since }),
    });
  } catch (err) {
    throw new Error(describeFetchError(err, url));
  }

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  return { ok: res.ok, status: res.status, json, text };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const supabaseUrl = requireEnv("SUPABASE_URL");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey) throw new Error("Missing env var: SUPABASE_SERVICE_ROLE_KEY");

  const profile = await resolveProfile({
    supabaseUrl,
    serviceKey,
    profileId: args.profileId,
    name: args.name,
  });
  if (!profile) return;

  const conn = await getStravaConnection({ supabaseUrl, serviceKey, profileId: profile.id });
  const beforeCount = await countStravaWorkouts({
    supabaseUrl,
    serviceKey,
    profileId: profile.id,
    since: args.since,
  });

  console.log(`Profile: ${profile.name} (${profile.id})`);
  console.log(`Strava athlete: ${conn.strava_athlete_id}`);
  console.log(`Since: ${args.since}`);
  console.log(`Existing Strava workouts since ${args.since}: ${beforeCount ?? "unknown"}`);

  if (args.dryRun) {
    console.log("Dry run complete. No sync was started.");
    return;
  }

  const totals = {
    imported: 0,
    fetched: 0,
    skipped: 0,
    skippedShort: 0,
    skippedType: 0,
    skippedError: 0,
  };

  for (let chunk = 1; chunk <= args.maxChunks; chunk++) {
    let result = await callSync({
      supabaseUrl,
      serviceKey,
      profileId: profile.id,
      since: args.since,
    });

    let attempt = 1;
    while (!result.ok && [408, 429, 500, 502, 503, 504].includes(result.status) && attempt < 3) {
      const waitMs = [5000, 10000][attempt - 1] || 10000;
      console.log(`Chunk ${chunk}: HTTP ${result.status}, retrying in ${waitMs / 1000}s...`);
      await sleep(waitMs);
      result = await callSync({ supabaseUrl, serviceKey, profileId: profile.id, since: args.since });
      attempt++;
    }

    if (!result.ok || !result.json) {
      if (result.status === 401 && result.text.includes("Invalid token")) {
        throw new Error(
          "strava-sync rejected the service-role call with \"Invalid token\". " +
          "Redeploy the current strava-sync Edge Function first; the local source supports service-role backfills, " +
          "but the deployed function appears stale."
        );
      }
      throw new Error(
        `strava-sync failed on chunk ${chunk} (HTTP ${result.status}): ` +
        `${result.text.slice(0, 800)}`
      );
    }

    const body = result.json;
    totals.imported += body.imported || 0;
    totals.fetched += body.totalFetched || 0;
    totals.skipped += body.skipped || 0;
    totals.skippedShort += body.skippedShort || 0;
    totals.skippedType += body.skippedType || 0;
    totals.skippedError += body.skippedError || 0;

    const pct = typeof body.progress_pct === "number" ? `${body.progress_pct}%` : "n/a";
    console.log(
      `Chunk ${chunk}: progress=${pct}, imported=${body.imported || 0}, ` +
      `fetched=${body.totalFetched || 0}, skipped=${body.skipped || 0}, done=${!!body.done}`
    );

    if (body.done) break;

    if (body.rate_limited) {
      const waitS = Math.max(5, Math.min(1800, Number(body.retry_after_s || 60)));
      if (!args.wait) {
        console.log(`Stopped at Strava rate limit. Re-run later; suggested wait ${waitS}s.`);
        break;
      }
      console.log(`Strava rate-limited; waiting ${waitS}s...`);
      await sleep(waitS * 1000);
    } else {
      await sleep(500);
    }

    if (chunk === args.maxChunks) {
      throw new Error(`Stopped after --max-chunks=${args.maxChunks} before sync reported done`);
    }
  }

  const afterCount = await countStravaWorkouts({
    supabaseUrl,
    serviceKey,
    profileId: profile.id,
    since: args.since,
  });

  console.log("Backfill complete.");
  console.log(
    `Totals: imported=${totals.imported}, fetched=${totals.fetched}, ` +
    `skipped=${totals.skipped}, short=${totals.skippedShort}, ` +
    `type=${totals.skippedType}, errors=${totals.skippedError}`
  );
  console.log(`Strava workouts since ${args.since}: ${beforeCount ?? "unknown"} -> ${afterCount ?? "unknown"}`);
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
