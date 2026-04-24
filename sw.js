// NVDP — Service Worker
// =====================
// Two responsibilities:
//   1) Asset precache + stale-while-revalidate so the app loads instantly on
//      repeat visits and shows a useful offline shell when the network is
//      unavailable. (Improvement #4 in the plan: turn sw.js from a push-only
//      worker into a real PWA worker.)
//   2) Push notifications + click handling, with same-origin URL hardening
//      from the original assessment fix (M7) preserved.
//
// Cache strategy:
//   * App shell (index.html, css/style.css, js/*.js) → stale-while-revalidate.
//     The cached copy is served immediately; a background fetch refreshes the
//     cache so the next load is up to date.
//   * Navigations (HTML) → network-first, fall back to cached index.html so
//     offline launches still show the SPA shell instead of a browser error.
//   * Cross-origin requests (Supabase, jsDelivr, unpkg) → bypass the SW.
//     We never want to serve a stale Supabase response or pin a CDN bundle.
//
// Versioning:
//   Bump CACHE_VERSION whenever you ship breaking SW changes. Old caches are
//   deleted on `activate`. The cache-bust workflow (.github/workflows/
//   cache-bust.yml) appends `?v=<git-sha>` to the asset references in
//   index.html, which naturally produces fresh requests; precache just keeps
//   the latest known-good copy around for offline.

const CACHE_VERSION = "v1-2026-04-24";
const SHELL_CACHE = `nvdp-shell-${CACHE_VERSION}`;
const ASSETS_CACHE = `nvdp-assets-${CACHE_VERSION}`;

// Bare paths (no `?v=` query). At runtime we strip the query before lookup
// so asset URLs match regardless of cache-bust suffix.
const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/app.js",
  "./js/config.js",
  "./js/gate.js",
  "./js/seed.js",
];

// ── Install: precache the shell. ────────────────────────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // `addAll` is atomic — if any one fetch fails, none are cached.
      // Use individual fetches so a missing optional file doesn't void the
      // entire install.
      Promise.all(
        PRECACHE_URLS.map((url) =>
          fetch(url, { cache: "reload" })
            .then((res) => (res.ok ? cache.put(url, res) : null))
            .catch(() => null),
        ),
      ),
    ).then(() => self.skipWaiting()),
  );
});

// ── Activate: drop old cache versions. ──────────────────────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith("nvdp-") && k !== SHELL_CACHE && k !== ASSETS_CACHE)
          .map((k) => caches.delete(k)),
      ),
    ).then(() => self.clients.claim()),
  );
});

function stripQuery(url) {
  const u = new URL(url);
  u.search = "";
  return u.toString();
}

function isSameOriginAsset(url) {
  return url.origin === self.location.origin &&
    /\.(css|js|svg|png|jpg|jpeg|webp|woff2?)$/.test(url.pathname);
}

// ── Fetch: routing. ─────────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Only handle GETs. POST/PUT/etc. always go to the network.
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Cross-origin (Supabase, CDNs) → bypass entirely.
  if (url.origin !== self.location.origin) return;

  // HTML navigations → network-first, fall back to cached shell.
  if (req.mode === "navigate" || req.headers.get("accept")?.includes("text/html")) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // Update the shell cache so the next offline launch is fresh.
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put("./index.html", copy)).catch(() => {});
          return res;
        })
        .catch(() =>
          caches.match("./index.html").then((r) => r || new Response("Offline", { status: 503 })),
        ),
    );
    return;
  }

  // Same-origin static assets → stale-while-revalidate.
  if (isSameOriginAsset(url)) {
    const stripped = stripQuery(req.url);
    event.respondWith(
      caches.open(ASSETS_CACHE).then(async (cache) => {
        const cached = await cache.match(stripped);
        const networkPromise = fetch(req)
          .then((res) => {
            if (res && res.ok) cache.put(stripped, res.clone()).catch(() => {});
            return res;
          })
          .catch(() => null);
        return cached || (await networkPromise) || new Response("", { status: 504 });
      }),
    );
    return;
  }

  // Anything else (e.g. /sw.js itself) → default network behavior.
});

// ── Push notifications (preserved from original SW). ────────────────────

// SECURITY (assessment M7): the `url` field in a push payload is supplied
// by whoever owns the push subscription. Anything that isn't a same-origin
// path gets rewritten to `/`.
function safeNotificationURL(raw) {
  try {
    const u = new URL(raw, self.location.origin);
    if (u.origin !== self.location.origin) return "/";
    return u.pathname + u.search + u.hash;
  } catch {
    return "/";
  }
}

self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || "NVDP";
  const options = {
    body: data.body || "Du har fått en puff! Dags att träna! 💪",
    icon: data.icon || undefined,
    badge: data.badge || undefined,
    data: { url: safeNotificationURL(data.url || "/") },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = safeNotificationURL(event.notification.data?.url || "/");
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(url) && "focus" in client) return client.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
