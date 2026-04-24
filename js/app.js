/* ══════════════════════════════════════════
   NVDP — Main Application Logic
   ══════════════════════════════════════════ */

// Intercept failed fetches to log full URL + status for debugging
const _origFetch = window.fetch;
window.fetch = async function(...args) {
  const res = await _origFetch.apply(this, args);
  if (!res.ok && res.status >= 400) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    console.warn(`[NVDP] HTTP ${res.status} → ${url}`);
  }
  return res;
};

// ════════════════════════════════════════════════════════════════
//  ACTION DELEGATION (replaces inline onclick handlers)
// ════════════════════════════════════════════════════════════════
// Instead of `<button onclick="navigate('coach')">` (which forces CSP
// `script-src 'unsafe-inline'`), markup uses:
//
//     <button data-action="navigate" data-arg="coach">…</button>
//
// One delegated `click` listener on `document` looks up the handler in
// `_actions` and dispatches. New handlers are registered with
// `registerAction(name, fn)`. Click-targets that need an arg pass it via
// `data-arg`.
//
// Migration plan: every `onclick="foo(arg)"` in index.html should be
// replaced with `data-action="foo" data-arg="arg"` and a matching call to
// `registerAction("foo", () => foo(arg))`. Once zero inline handlers remain
// the CSP can drop `'unsafe-inline'` from `script-src`.
const _actions = Object.create(null);
function registerAction(name, fn) {
  if (typeof name !== 'string' || typeof fn !== 'function') return;
  _actions[name] = fn;
}
function _runAction(el, ev) {
  const name = el.getAttribute('data-action');
  if (!name) return;
  const fn = _actions[name];
  if (!fn) {
    console.warn('[NVDP] Unknown data-action:', name);
    return;
  }
  const arg = el.getAttribute('data-arg');
  try {
    fn(arg, ev, el);
  } catch (e) {
    console.error('[NVDP] action handler failed:', name, e);
  }
}
document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  // Prevent default for anchors with no real href so we don't append `#` to URL.
  if (el.tagName === 'A' && (!el.getAttribute('href') || el.getAttribute('href') === '#')) {
    ev.preventDefault();
  }
  _runAction(el, ev);
}, false);
// Keyboard activation for non-button elements (Enter / Space).
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter' && ev.key !== ' ') return;
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  // Native buttons already fire click on Enter/Space — don't double-fire.
  if (el.tagName === 'BUTTON') return;
  ev.preventDefault();
  _runAction(el, ev);
}, false);

// ── Supabase Client ──
// Persist session in localStorage so users stay logged in across visits (refresh token).
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storage: localStorage,
  },
});

// ── App State ──
let currentUser = null;
let currentProfile = null;
let allProfiles = [];
let currentView = 'dashboard';
let schemaPersonIdx = 0;
let schemaWeekOffset = 0;
// Schema view toggle (Vecka / Månad). Persisted between sessions so the user
// lands on the same view they used last. Default = 'week' first time.
let _schemaView = (() => {
  try {
    const v = localStorage.getItem('schema_view_mode');
    return (v === 'month' || v === 'week') ? v : 'week';
  } catch (_e) { return 'week'; }
})();
let schemaMonthOffset = 0;
let trendMode = 'total'; // fixed: no toggle
let selectedWorkout = null;
let editingWorkoutId = null;

// ── Day Names ──
const DAY_NAMES = ['Mån', 'Tis', 'Ons', 'Tors', 'Fre', 'Lör', 'Sön'];
const DAY_NAMES_FULL = ['Måndag', 'Tisdag', 'Onsdag', 'Torsdag', 'Fredag', 'Lördag', 'Söndag'];

// ── Init ──
let _initDone = false;

const GATE_PASSED_KEY = 'nvdp_gate_passed';

// ── Lazy Leaflet (PERF-01: ladda karta först när den behövs) ──
let _leafletPromise = null;
function ensureLeafletLoaded() {
  if (typeof L !== 'undefined' && document.querySelector('link[data-nvdp-leaflet-css]')) {
    return Promise.resolve();
  }
  if (_leafletPromise) return _leafletPromise;
  _leafletPromise = new Promise((resolve, reject) => {
    let cssLoaded = false;
    let jsLoaded = false;
    const maybeResolve = () => { if (cssLoaded && jsLoaded) resolve(); };

    // SECURITY (assessment M6): add Subresource Integrity to Leaflet assets
    // so a compromised unpkg CDN cannot silently swap in malicious code.
    // Hashes are sha-384 of leaflet@1.9.4. Update together whenever the
    // pinned version changes.
    const LEAFLET_CSS_URL = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    const LEAFLET_CSS_SRI = 'sha384-sHL9NAb7lN7rfvG5lfHpm643Xkcjzp4jFvuavGOndn6pjVqS6ny56CAt3nsEVT4H';
    const LEAFLET_JS_URL = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    const LEAFLET_JS_SRI = 'sha384-cxOPjt7s7Iz04uaHJceBmS+qpjv2JkIHNVcuOrM+YHwZOmJGBXI00mdUXEq65HTH';

    let link = document.querySelector('link[data-nvdp-leaflet-css]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = LEAFLET_CSS_URL;
      link.integrity = LEAFLET_CSS_SRI;
      link.crossOrigin = 'anonymous';
      link.referrerPolicy = 'no-referrer';
      link.setAttribute('data-nvdp-leaflet-css', '1');
      link.onload = () => { cssLoaded = true; maybeResolve(); };
      link.onerror = () => { cssLoaded = true; maybeResolve(); };
      document.head.appendChild(link);
    } else {
      cssLoaded = true;
    }

    if (typeof L !== 'undefined') {
      jsLoaded = true;
      maybeResolve();
    } else {
      const s = document.createElement('script');
      s.src = LEAFLET_JS_URL;
      s.integrity = LEAFLET_JS_SRI;
      s.crossOrigin = 'anonymous';
      s.referrerPolicy = 'no-referrer';
      s.onload = () => { jsLoaded = true; maybeResolve(); };
      s.onerror = () => reject(new Error('Leaflet'));
      document.head.appendChild(s);
    }
  });
  return _leafletPromise;
}

function getMapTileUrl() {
  const theme = document.documentElement.getAttribute('data-theme') || 'dark';
  return theme === 'light'
    ? 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'
    : 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
}

const _mapObserver = typeof IntersectionObserver !== 'undefined'
  ? new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        _mapObserver.unobserve(el);
        _initLeafletMap(el);
      });
    }, { rootMargin: '200px' })
  : null;

function _initLeafletMap(el) {
  if (el.dataset.leaflet) return;
  el.dataset.leaflet = '1';
  try {
    const coords = decodePolyline(el.dataset.polyline);
    if (coords.length < 2) { el.style.display = 'none'; return; }
    const map = L.map(el, {
      zoomControl: false, attributionControl: false,
      dragging: false, scrollWheelZoom: false, doubleClickZoom: false,
      touchZoom: false, boxZoom: false, keyboard: false
    });
    L.tileLayer(getMapTileUrl(), { maxZoom: 18 }).addTo(map);
    const line = L.polyline(coords, {
      color: '#3B9DFF', weight: 3.5, opacity: 0.9,
      lineCap: 'round', lineJoin: 'round'
    }).addTo(map);
    map.fitBounds(line.getBounds(), { padding: [4, 4], animate: false });
    el._leafletMap = map;
    el._leafletTile = map._layers && Object.values(map._layers).find(l => l._url);
  } catch (e) { el.style.display = 'none'; }
}

async function initMapThumbnails() {
  try { await ensureLeafletLoaded(); } catch { return; }
  if (typeof L === 'undefined') return;
  document.querySelectorAll('.wo-map[data-polyline]:not([data-leaflet])').forEach(el => {
    if (_mapObserver) {
      _mapObserver.observe(el);
    } else {
      _initLeafletMap(el);
    }
  });
}

let _toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('app-toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}

// ════════════════════════════════════════════════════════════════
//  LAZY SCRIPT LOADER
// ════════════════════════════════════════════════════════════════
// Use to defer heavy CDN bundles (Chart.js, Sortable, Leaflet, etc.) until
// the view that needs them actually opens. Returns a promise that resolves
// once the script is loaded; subsequent calls for the same URL return the
// cached promise (no duplicate fetches).
//
//   await loadScript('https://cdn.jsdelivr.net/...');
//   new Chart(...);
const _scriptCache = new Map();
function loadScript(src, opts = {}) {
  if (_scriptCache.has(src)) return _scriptCache.get(src);
  const p = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    if (opts.integrity) s.integrity = opts.integrity;
    if (opts.crossOrigin) s.crossOrigin = opts.crossOrigin;
    s.onload = () => resolve();
    s.onerror = () => {
      _scriptCache.delete(src);
      reject(new Error(`Failed to load script: ${src}`));
    };
    document.head.appendChild(s);
  });
  _scriptCache.set(src, p);
  return p;
}

// ════════════════════════════════════════════════════════════════
//  TINY STATE STORE (subscribe-on-key)
// ════════════════════════════════════════════════════════════════
// New code should read/write app-wide state through `store` so views can
// subscribe to changes and re-render only what changed. Existing legacy
// `currentUser` / `currentProfile` / etc. globals are still authoritative
// for now — setters that mirror to the store are added in initApp /
// loadProfile so subscribers get notified.
//
//   store.get('coachUnread')                 // current value
//   store.set('coachUnread', 3)              // notify all subscribers
//   const off = store.on('coachUnread', n => …)  // subscribe; call off() to unsubscribe
//   store.update('coachUnread', n => n + 1)  // functional update
const store = (() => {
  const state = Object.create(null);
  const subs = Object.create(null);
  function get(key) { return state[key]; }
  function set(key, value) {
    if (state[key] === value) return;
    state[key] = value;
    const list = subs[key];
    if (!list) return;
    for (const fn of list) {
      try { fn(value); } catch (e) { console.error('[NVDP] store sub failed:', key, e); }
    }
  }
  function update(key, fn) { set(key, fn(state[key])); }
  function on(key, fn) {
    (subs[key] || (subs[key] = [])).push(fn);
    return () => { subs[key] = (subs[key] || []).filter(f => f !== fn); };
  }
  return { get, set, update, on };
})();

// ════════════════════════════════════════════════════════════════
//  DATA LAYER (consistent error handling)
// ════════════════════════════════════════════════════════════════
// Thin wrapper around the `sb` Supabase client. Every call returns
// `{ data, error }` and surfaces unexpected errors to the user via toast
// (instead of the historical pattern of `catch (_) { /* ignore */ }`).
//
// Add new endpoints here as code is migrated off raw `sb.from(...)` calls
// to centralize the error path.
const api = {
  /** Run a Supabase query and consistently surface unexpected failures. */
  async _run(label, promise) {
    try {
      const { data, error } = await promise;
      if (error) {
        console.warn(`[NVDP] api.${label} failed:`, error.message || error);
        return { data: null, error };
      }
      return { data, error: null };
    } catch (e) {
      console.error(`[NVDP] api.${label} threw:`, e);
      // Don't toast for every silent miss — only the call site decides.
      return { data: null, error: e };
    }
  },

  coach: {
    /** Count assistant messages newer than `since` for this profile. */
    unreadCount(profileId, since) {
      return api._run('coach.unreadCount',
        sb.from('coach_messages')
          .select('id', { count: 'exact', head: true })
          .eq('profile_id', profileId)
          .eq('role', 'assistant')
          .gt('created_at', since)
      );
    },
  },

  profile: {
    update(profileId, patch) {
      return api._run('profile.update',
        sb.from('profiles').update(patch).eq('id', profileId)
      );
    },
  },

  workouts: {
    /** List workouts in a date range for one or more profile ids. */
    list(profileIds, fromDate, toDate) {
      const ids = Array.isArray(profileIds) ? profileIds : [profileIds];
      let q = sb.from('workouts')
        .select('*')
        .in('profile_id', ids)
        .order('workout_date', { ascending: false });
      if (fromDate) q = q.gte('workout_date', fromDate);
      if (toDate)   q = q.lte('workout_date', toDate);
      return api._run('workouts.list', q);
    },
  },
};

/** AUTH-03: korta svenska fel från Supabase */
function mapAuthError(msg) {
  const m = String(msg || '').toLowerCase();
  if (m.includes('invalid login') || m.includes('invalid_credentials') || m.includes('invalid email or password')) {
    return 'Fel email eller lösenord.';
  }
  if (m.includes('email not confirmed')) return 'Bekräfta din email innan du loggar in.';
  if (m.includes('user already registered')) return 'Det finns redan ett konto med den emailen.';
  if (m.includes('network') || m.includes('fetch')) return 'Nätverksfel. Kontrollera anslutningen.';
  return msg || 'Något gick fel. Försök igen.';
}

let _wmFocusBefore = null;
let _wmMapInstance = null;

function gateOpen() {
  return (
    sessionStorage.getItem('gate_passed') === '1' ||
    localStorage.getItem(GATE_PASSED_KEY) === '1'
  );
}

/** After beta gate succeeds: restore Supabase session if token still in localStorage */
async function resumeSessionAfterGate() {
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (session && !_initDone) {
      await initApp(session.user, session.access_token);
    }
  } catch (e) {
    console.error('resumeSessionAfterGate:', e);
  }
}
window.NVDP_resumeAfterGate = resumeSessionAfterGate;

async function fetchProfilesDirect(accessToken) {
  const resp = await fetch(SUPABASE_URL + '/rest/v1/profiles?select=*', {
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': 'Bearer ' + accessToken
    }
  });
  if (!resp.ok) throw new Error('Profiles fetch failed: ' + resp.status);
  return resp.json();
}

document.addEventListener('DOMContentLoaded', async () => {
  restoreSettings();
  document.getElementById('log-type')?.addEventListener('change', suggestLogMinutesFromHistory);
  window.addEventListener('offline', () => showToast('Ingen anslutning'));
  try {
    sb.auth.onAuthStateChange(async (event, session) => {
      try {
        if (event === 'SIGNED_IN' && session && !_initDone) {
          await initApp(session.user, session.access_token);
        } else if (event === 'SIGNED_OUT') {
          _initDone = false;
          showAuth();
        }
      } catch (err) {
        console.error('Auth state change error:', err);
      }
    });

    const { data: { session } } = await sb.auth.getSession();
    if (session && !_initDone) {
      if (gateOpen()) await initApp(session.user, session.access_token);
    } else if (!session && gateOpen()) {
      showAuth();
    }
  } catch (err) {
    console.error('Init error:', err);
    if (gateOpen()) showAuth();
  }
});

// ═══════════════════════
//  AUTH
// ═══════════════════════
let authMode = 'login';

function toggleAuthMode() {
  authMode = authMode === 'login' ? 'register' : 'login';
  document.getElementById('auth-title').textContent = authMode === 'login' ? 'Logga in' : 'Skapa konto';
  document.getElementById('auth-submit').textContent = authMode === 'login' ? 'Logga in' : 'Skapa konto';
  document.getElementById('auth-toggle-text').textContent = authMode === 'login' ? 'Inget konto?' : 'Har du redan konto?';
  document.getElementById('auth-toggle').textContent = authMode === 'login' ? 'Skapa konto' : 'Logga in';
  document.getElementById('auth-name-group').classList.toggle('hidden', authMode === 'login');
  document.getElementById('auth-error').classList.add('hidden');
  document.getElementById('auth-forgot-panel')?.classList.add('hidden');
  document.getElementById('auth-forgot-msg')?.classList.add('hidden');
  document.getElementById('auth-forgot-wrap')?.classList.toggle('hidden', authMode !== 'login');
}

document.getElementById('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  const errEl = document.getElementById('auth-error');
  const btn = document.getElementById('auth-submit');
  errEl.classList.add('hidden');
  errEl.style.color = '';
  btn.disabled = true;
  btn.textContent = authMode === 'login' ? 'Loggar in...' : 'Skapar konto...';

  if (authMode === 'register') {
    const firstName = document.getElementById('auth-firstname').value.trim();
    const lastName = document.getElementById('auth-lastname').value.trim();
    if (!firstName || !lastName || firstName.length < 2 || lastName.length < 2) {
      errEl.style.color = 'var(--red)';
      errEl.textContent = 'Ange både förnamn och efternamn (minst 2 tecken vardera).';
      errEl.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Skapa konto';
      return;
    }
    const name = `${firstName} ${lastName}`;
    const reservedNames = ['niklas', 'love', 'niklas gustafsson', 'love gustafsson'];
    if (reservedNames.includes(name.toLowerCase())) {
      errEl.style.color = 'var(--red)';
      errEl.textContent = 'Det namnet är redan taget. Välj ett annat.';
      errEl.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Skapa konto';
      return;
    }
    const { data, error } = await sb.auth.signUp({
      email, password,
      options: { data: { name } }
    });
    btn.disabled = false;
    btn.textContent = 'Skapa konto';
    if (error) { errEl.style.color = 'var(--red)'; errEl.textContent = mapAuthError(error.message); errEl.classList.remove('hidden'); return; }
    if (data.session) {
      // Email confirmation disabled -- session created, onAuthStateChange handles redirect
      return;
    }
    // Email confirmation enabled -- tell the user
    errEl.style.color = 'var(--green)';
    errEl.textContent = 'Konto skapat! Kolla din email och klicka på bekräftelselänken, sen kan du logga in.';
    errEl.classList.remove('hidden');
    authMode = 'login';
    document.getElementById('auth-title').textContent = 'Logga in';
    document.getElementById('auth-submit').textContent = 'Logga in';
    document.getElementById('auth-toggle-text').textContent = 'Inget konto?';
    document.getElementById('auth-toggle').textContent = 'Skapa konto';
    document.getElementById('auth-name-group').classList.add('hidden');
  } else {
    try {
      const { data: signInData, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) {
        btn.disabled = false;
        btn.textContent = 'Logga in';
        errEl.style.color = 'var(--red)';
        errEl.textContent = mapAuthError(error.message);
        errEl.classList.remove('hidden');
        return;
      }
      btn.textContent = 'Laddar...';
      if (signInData?.session) {
        try {
          await initApp(signInData.session.user, signInData.session.access_token);
        } catch (initErr) {
          console.error('initApp error during login:', initErr);
          document.getElementById('auth-view').style.display = 'none';
          document.getElementById('app').classList.add('active');
        }
      }
    } catch (ex) {
      btn.disabled = false;
      btn.textContent = 'Logga in';
      errEl.style.color = 'var(--red)';
      errEl.textContent = mapAuthError(ex.message);
      errEl.classList.remove('hidden');
    }
  }
});

function toggleForgotPassword() {
  document.getElementById('auth-forgot-panel')?.classList.toggle('hidden');
}

async function sendPasswordResetEmail() {
  const msg = document.getElementById('auth-forgot-msg');
  const email = document.getElementById('auth-email').value.trim();
  if (!email) {
    if (msg) { msg.textContent = 'Fyll i email i fältet ovan.'; msg.style.color = 'var(--red)'; msg.classList.remove('hidden'); }
    return;
  }
  const { error } = await sb.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + window.location.pathname,
  });
  if (msg) {
    msg.classList.remove('hidden');
    if (error) {
      msg.style.color = 'var(--red)';
      msg.textContent = mapAuthError(error.message);
    } else {
      msg.style.color = 'var(--green)';
      msg.textContent = 'Om kontot finns har vi skickat en återställningslänk till din email.';
    }
  }
}

async function logout() {
  closeSideMenu();
  await sb.auth.signOut();
  showAuth();
}

function toggleSideMenu() {
  const menu = document.getElementById('side-menu');
  const overlay = document.getElementById('side-menu-overlay');
  const open = menu.classList.contains('open');
  if (open) { closeSideMenu(); } else { openSideMenu(); }
}

function openSideMenu() {
  document.getElementById('topbar-search-panel')?.classList.add('hidden');
  document.getElementById('nudge-panel')?.classList.add('hidden');
  _nudgePanelOpen = false;
  document.getElementById('side-menu').classList.add('open');
  document.getElementById('side-menu-overlay').classList.remove('hidden');
  document.body.classList.add('nvdp-side-open');
  updateSideMenuContent();
}

function closeSideMenu() {
  document.getElementById('side-menu').classList.remove('open');
  document.getElementById('side-menu-overlay').classList.add('hidden');
  document.body.classList.remove('nvdp-side-open');
}

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('nvdp-theme', theme);
  const toggle = document.querySelector('#theme-toggle input');
  if (toggle) toggle.checked = theme === 'light';
  if (window._chartSeasonPie) { window._chartSeasonPie.update(); }
  const newUrl = getMapTileUrl();
  document.querySelectorAll('.wo-map[data-leaflet]').forEach(el => {
    if (el._leafletMap) {
      el._leafletMap.eachLayer(layer => {
        if (layer._url) { layer.setUrl(newUrl); }
      });
    }
  });
}

function setUnit(unit) {
  localStorage.setItem('nvdp-unit', unit);
  const toggle = document.querySelector('#unit-toggle input');
  if (toggle) toggle.checked = unit === 'mi';
}

function setWeekStart(ws) {
  localStorage.setItem('nvdp-weekstart', ws);
  const toggle = document.querySelector('#weekstart-toggle input');
  if (toggle) toggle.checked = ws === 'sun';
}

async function setEmailNotif(on) {
  const toggle = document.querySelector('#email-notif-toggle input');
  if (toggle) toggle.checked = on;
  if (currentProfile) {
    await sb.from('profiles').update({ email_notifications: on }).eq('id', currentProfile.id);
  }
}

function restoreSettings() {
  const theme = localStorage.getItem('nvdp-theme') || 'dark';
  const unit = localStorage.getItem('nvdp-unit') || 'km';
  const ws = localStorage.getItem('nvdp-weekstart') || 'mon';
  if (theme !== 'dark') document.documentElement.setAttribute('data-theme', theme);
  const themeToggle = document.querySelector('#theme-toggle input');
  if (themeToggle) themeToggle.checked = theme === 'light';
  const unitToggle = document.querySelector('#unit-toggle input');
  if (unitToggle) unitToggle.checked = unit === 'mi';
  const wsToggle = document.querySelector('#weekstart-toggle input');
  if (wsToggle) wsToggle.checked = ws === 'sun';

  const wkCol = localStorage.getItem('nvdp_dash_week_collapsed');
  const dashPanel = document.getElementById('dash-week-collapsible');
  const dashBtn = document.getElementById('dash-schema-toggle');
  if (wkCol === '1' && dashPanel && dashBtn) {
    dashPanel.classList.add('dash-week-collapsed');
    dashBtn.setAttribute('aria-expanded', 'false');
  }
}

function restoreEmailNotifToggle() {
  if (!currentProfile) return;
  const on = currentProfile.email_notifications !== false;
  const toggle = document.querySelector('#email-notif-toggle input');
  if (toggle) toggle.checked = on;
  const ccToggle = document.querySelector('#coach-checkin-chat-toggle input');
  if (ccToggle) ccToggle.checked = currentProfile.coach_checkin_chat_enabled === true;
}

async function setCoachCheckinChatEnabled(on) {
  const toggle = document.querySelector('#coach-checkin-chat-toggle input');
  if (toggle) toggle.checked = on;
  if (!currentProfile) return;
  const { error } = await sb.from('profiles')
    .update({ coach_checkin_chat_enabled: !!on })
    .eq('id', currentProfile.id);
  if (error) {
    alert('Kunde inte uppdatera inställningen.');
    if (toggle) toggle.checked = !on;
    return;
  }
  currentProfile.coach_checkin_chat_enabled = !!on;
  if (typeof updateCoachCheckinBanner === 'function') updateCoachCheckinBanner();
}
if (typeof window !== 'undefined') window.setCoachCheckinChatEnabled = setCoachCheckinChatEnabled;

function updateSideMenuContent() {
  const smName = document.getElementById('sm-name');
  const smEmail = document.getElementById('sm-email');
  const smAvatar = document.getElementById('sm-avatar');
  if (currentProfile) {
    smName.textContent = currentProfile.name;
    smAvatar.textContent = currentProfile.name[0].toUpperCase();
  }
  if (currentUser) smEmail.textContent = currentUser.email;

  const maxHrInput = document.getElementById('sm-max-hr');
  const maxHrDisplay = document.getElementById('sm-max-hr-display');
  const maxHrText = document.getElementById('sm-max-hr-text');
  const maxHrEdit = document.getElementById('sm-max-hr-edit');
  if (maxHrInput && currentProfile?.user_max_hr) {
    maxHrInput.value = currentProfile.user_max_hr;
    if (maxHrDisplay && maxHrText && maxHrEdit) {
      maxHrText.textContent = currentProfile.user_max_hr + ' bpm';
      maxHrDisplay.classList.remove('hidden');
      maxHrEdit.classList.add('hidden');
    }
  } else if (maxHrDisplay && maxHrEdit) {
    maxHrDisplay.classList.add('hidden');
    maxHrEdit.classList.remove('hidden');
  }

  updateGroupSettingsCard();

  updateStravaUI();
  restoreEmailNotifToggle();
}

const AVATAR_OPTIONS = ['🏃','🚴','💪','🧘','⛷️','🏊','🎯','🔥','⚡','🌟','🏔️','🦁','🐺','🦅','🐻','🎸'];

function openAvatarPicker() {
  const picker = document.getElementById('avatar-picker');
  const grid = document.getElementById('avatar-picker-grid');
  picker.classList.toggle('hidden');
  if (!picker.classList.contains('hidden')) {
    grid.innerHTML = AVATAR_OPTIONS.map(e =>
      `<div class="avatar-option${currentProfile?.avatar === e ? ' selected' : ''}" onclick="selectAvatar('${e}')">${e}</div>`
    ).join('');
  }
}

async function selectAvatar(emoji) {
  if (!currentProfile) return;
  const token = (await sb.auth.getSession()).data.session.access_token;
  await fetch(SUPABASE_URL + '/rest/v1/profiles?id=eq.' + currentProfile.id, {
    method: 'PATCH',
    headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ avatar: emoji })
  });
  currentProfile.avatar = emoji;
  document.getElementById('avatar-picker').classList.add('hidden');
  refreshAvatars();
}

function refreshAvatars() {
  const a = currentProfile?.avatar;
  const initial = (currentProfile?.name || 'U')[0].toUpperCase();
  document.getElementById('user-avatar').textContent = a || initial;
  document.getElementById('sm-avatar').textContent = a || initial;
  if (a) {
    document.getElementById('user-avatar').style.fontSize = '1.1rem';
    document.getElementById('sm-avatar').style.fontSize = '1.3rem';
  } else {
    document.getElementById('user-avatar').style.fontSize = '';
    document.getElementById('sm-avatar').style.fontSize = '';
  }
}

function editProfileName() {
  const row = document.getElementById('name-edit-row');
  const input = document.getElementById('name-edit-input');
  row.classList.toggle('hidden');
  if (!row.classList.contains('hidden')) {
    input.value = currentProfile?.name || '';
    input.focus();
  }
}

async function saveProfileName() {
  const input = document.getElementById('name-edit-input');
  const newName = input.value.trim();
  if (!newName || !currentProfile) return;
  const token = (await sb.auth.getSession()).data.session.access_token;
  await fetch(SUPABASE_URL + '/rest/v1/profiles?id=eq.' + currentProfile.id, {
    method: 'PATCH',
    headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: newName })
  });
  currentProfile.name = newName;
  document.getElementById('name-edit-row').classList.add('hidden');
  document.getElementById('sm-name').textContent = newName;
  refreshAvatars();
}

async function saveMaxHR(val) {
  const hr = parseInt(val, 10);
  if (!currentProfile || isNaN(hr) || hr < 100 || hr > 230) {
    if (val) await showAlertModal('Ogiltigt värde', 'Maxpuls måste vara mellan 100 och 230 bpm.');
    return;
  }
  const token = (await sb.auth.getSession()).data.session.access_token;
  let res;
  try {
    res = await fetch(SUPABASE_URL + '/rest/v1/profiles?id=eq.' + currentProfile.id, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify({ user_max_hr: hr })
    });
  } catch (e) {
    console.error('saveMaxHR network error:', e);
    await showAlertModal('Kunde inte spara', 'Nätverksfel — försök igen.');
    return;
  }
  if (!res.ok) {
    const body = await res.text();
    console.error('saveMaxHR failed:', res.status, body);
    let msg = `Kunde inte spara maxpuls (HTTP ${res.status}).`;
    if (res.status === 400 && body.includes('user_max_hr')) {
      msg += '\n\nKolumnen user_max_hr saknas i databasen. Kör SQL-migrationen 20260418_strava_enrichment_catchup.sql.';
    } else if (body) {
      msg += '\n\n' + body.substring(0, 200);
    }
    await showAlertModal('Fel', msg);
    return;
  }
  const rows = await res.json().catch(() => null);
  const saved = Array.isArray(rows) && rows[0]?.user_max_hr;
  if (saved !== hr) {
    console.error('saveMaxHR: server returned different value', rows);
    await showAlertModal('Fel', 'Sparade men servern returnerade fel värde. Kontrollera RLS-policy på profiles.');
    return;
  }
  currentProfile.user_max_hr = hr;
  const d = document.getElementById('sm-max-hr-display');
  const t = document.getElementById('sm-max-hr-text');
  const e = document.getElementById('sm-max-hr-edit');
  if (d && t && e) { t.textContent = hr + ' bpm'; d.classList.remove('hidden'); e.classList.add('hidden'); }
}

function unlockMaxHR() {
  const d = document.getElementById('sm-max-hr-display');
  const e = document.getElementById('sm-max-hr-edit');
  if (d && e) { d.classList.add('hidden'); e.classList.remove('hidden'); document.getElementById('sm-max-hr')?.focus(); }
}

function showAuth() {
  if (!gateOpen()) return;
  document.getElementById('auth-view').style.display = 'flex';
  document.getElementById('app').classList.remove('active');
  document.body.style.overflow = 'hidden';
  _initDone = false;
  currentUser = null;
  currentProfile = null;
}

// ═══════════════════════
//  APP INIT
// ═══════════════════════
async function initApp(user, accessToken) {
  if (_initDone) return;
  _initDone = true;
  try {
    currentUser = user;
    const gateEl = document.getElementById('gate');
    if (gateEl) gateEl.style.display = 'none';
    localStorage.setItem(GATE_PASSED_KEY, '1');
    sessionStorage.setItem('gate_passed', '1');
    document.getElementById('auth-view').style.display = 'none';
    document.getElementById('app').classList.add('active');
    document.body.style.overflow = '';

    let profiles = [];
    try {
      profiles = await fetchProfilesDirect(accessToken);
    } catch (e) {
      console.error('Profiles fetch error:', e);
    }
    allProfiles = profiles || [];
    currentProfile = allProfiles.find(p => p.user_id === user.id) || allProfiles[0];
    // Mirror to the store so subscribers (badges, future view-models) react.
    store.set('currentProfile', currentProfile);
    store.set('allProfiles', allProfiles);

    if (!currentProfile && allProfiles.length === 0) {
      const fallbackName = user.user_metadata?.name || user.email?.split('@')[0] || 'User';
      try {
        const resp = await fetch(SUPABASE_URL + '/rest/v1/profiles', {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': 'Bearer ' + accessToken,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
          },
          body: JSON.stringify({ user_id: user.id, name: fallbackName })
        });
        if (resp.ok) {
          const created = await resp.json();
          if (created.length > 0) {
            allProfiles = created;
            currentProfile = created[0];
            store.set('currentProfile', currentProfile);
            store.set('allProfiles', allProfiles);
          }
        }
      } catch (e) {
        console.error('Profile create failed:', e);
      }
    }

    refreshAvatars();

    const typeSelect = document.getElementById('log-type');
    if (typeSelect.options.length <= 1) {
      ACTIVITY_TYPES.filter(t => t !== 'Vila').forEach(t => {
        const opt = document.createElement('option');
        opt.value = t; opt.textContent = t;
        typeSelect.appendChild(opt);
      });
    }

    document.getElementById('log-date').value = isoDate(new Date());
    // Mount the History-API router. If the URL already has a hash route
    // (e.g. user opened a deep link), `initRouter` dispatches into the
    // right view itself; otherwise we fall through to the default
    // `currentView` below.
    let routedFromHash = false;
    try {
      const hadHashRoute = !!location.hash;
      initRouter();
      routedFromHash = hadHashRoute;
    } catch (e) { console.error('router init error:', e); }
    if (!routedFromHash) {
      try { navigate(currentView); } catch (e) { console.error('navigate error:', e); }
    }
    try { updateNudgeBadge(); } catch (e) { console.error('nudge badge error:', e); }
    try { updateFriendRequestBadge(); } catch (e) { console.error('friend badge error:', e); }
    try { setInterval(updateFriendRequestBadge, 60000); } catch (e) {}
    try { registerPushSubscription(); } catch (e) { console.error('push sub error:', e); }
    try { checkStravaConnection(); } catch (e) { console.error('strava check error:', e); }
    try { handleStravaRedirect(); } catch (e) { console.error('strava redirect error:', e); }
    try { checkGarminConnection(); } catch (e) { console.error('garmin check error:', e); }
    try { handleGarminRedirect(); } catch (e) { console.error('garmin redirect error:', e); }
  } catch (err) {
    console.error('initApp error:', err);
    document.getElementById('auth-view').style.display = 'none';
    document.getElementById('app').classList.add('active');
  }
}

// ═══════════════════════
//  NAVIGATION
// ═══════════════════════
function navigate(view, param) {
  // NAV-02: bottennav data-view="progress" → vy-element #view-trends ("Din progress"). Håll mappningen synkad.
  currentView = view;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const viewId = view === 'progress' ? 'trends' : view;
  const viewEl = document.getElementById('view-' + viewId);
  if (viewEl) viewEl.classList.add('active');
  // Friend profile reached via the Social tab — keep that nav item highlighted.
  const navKey = view === 'friend-profile' ? 'social' : view;
  const navEl = document.querySelector(`.nav-item[data-view="${navKey}"]`);
  if (navEl) navEl.classList.add('active');

  if (view === 'dashboard' || view === 'progress') {
    _activePlan = null;
    _activePlanWeeks = [];
    _activePlanWorkouts = [];
  }
  if (view === 'dashboard') {
    _dashSelectedDate = null;
    loadDashboard();
  }
  else if (view === 'log') resetLogForm();
  else if (view === 'progress') loadTrends();
  else if (view === 'group') loadGroup();
  else if (view === 'social') loadSocial();
  else if (view === 'friend-profile') loadFriendProfile(param);
  else if (view === 'coach') { loadCoach(); markCoachViewed(); }

  // Lock page scroll so only the chat list scrolls when on the Coach tab.
  if (typeof document !== 'undefined' && document.body) {
    document.body.classList.toggle('chat-mode', view === 'coach');
  }

  // Reflect the current view in the URL hash so back/forward and refresh
  // preserve the user's place. `_navInternal` is set by the popstate handler
  // when the browser triggers the navigation, so we don't push a duplicate
  // history entry in that case.
  if (!_navInternal) {
    try {
      const hash = '#/' + view + (param ? '/' + encodeURIComponent(param) : '');
      if (location.hash !== hash) {
        history.pushState({ view, param }, '', hash);
      }
    } catch (_) { /* hash routing is best-effort */ }
  }
}
// Expose navigate via the action delegation system so markup can use
// `data-action="navigate" data-arg="dashboard"` instead of `onclick="navigate('dashboard')"`.
registerAction('navigate', (arg) => navigate(arg));

// ════════════════════════════════════════════════════════════════
//  HISTORY-API ROUTER
// ════════════════════════════════════════════════════════════════
// Supports URL hashes like `#/dashboard`, `#/coach`, `#/group/abc`,
// `#/profile/xyz`, `#/workout/123`. Browser back/forward and shared deep
// links route to the right view via `navigate()` (which also updates the
// hash). Mounted at app boot via `initRouter()`.
let _navInternal = false;
const VALID_ROUTES = new Set([
  'dashboard', 'progress', 'coach', 'social', 'group',
  'log', 'friend-profile',
]);
function _parseHash() {
  const raw = (location.hash || '').replace(/^#\/?/, '');
  if (!raw) return { view: null, param: null };
  const [view, ...rest] = raw.split('/');
  const param = rest.length ? decodeURIComponent(rest.join('/')) : null;
  return { view, param };
}
function _routeFromHash() {
  const { view, param } = _parseHash();
  if (!view || !VALID_ROUTES.has(view)) return;
  _navInternal = true;
  try { navigate(view, param); } finally { _navInternal = false; }
}
function initRouter() {
  window.addEventListener('popstate', _routeFromHash);
  // Boot-time deep link: if the URL already has a hash route, honor it.
  if (location.hash) _routeFromHash();
}

// ════════════════════════════════════════════════════════════════
//  DIALOG HELPER (focus trap + Escape + restore focus)
// ════════════════════════════════════════════════════════════════
// Use for any modal/drawer overlay. Sets ARIA, traps Tab focus inside,
// closes on Escape, and restores focus to the element that opened the
// dialog when it closes.
//
//   openDialog('coach-history-drawer', { onClose: closeCoachHistory });
//   closeDialog('coach-history-drawer');
//
// Markup contract: the dialog root is shown by removing `hidden` (or by
// the caller's existing logic). We don't toggle visibility ourselves —
// the helper only manages a11y and focus.
const _dialogStack = [];
function _focusableIn(root) {
  const sel = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(root.querySelectorAll(sel)).filter(el => el.offsetParent !== null || el === document.activeElement);
}
function _onDialogKeydown(ev) {
  const top = _dialogStack[_dialogStack.length - 1];
  if (!top) return;
  if (ev.key === 'Escape') {
    ev.preventDefault();
    closeDialog(top.id);
    return;
  }
  if (ev.key !== 'Tab') return;
  const focusable = _focusableIn(top.root);
  if (focusable.length === 0) { ev.preventDefault(); return; }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (ev.shiftKey && active === first) {
    ev.preventDefault();
    last.focus();
  } else if (!ev.shiftKey && active === last) {
    ev.preventDefault();
    first.focus();
  }
}
function openDialog(id, opts = {}) {
  const root = document.getElementById(id);
  if (!root) return;
  // Close any existing entry for this id (idempotent re-open).
  closeDialog(id);
  if (!root.hasAttribute('role')) root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  _dialogStack.push({ id, root, previousFocus, onClose: opts.onClose });
  if (_dialogStack.length === 1) document.addEventListener('keydown', _onDialogKeydown, true);
  // Focus the first focusable element, or the dialog root itself.
  const focusable = _focusableIn(root);
  const target = focusable[0] || root;
  if (target === root && !root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
  setTimeout(() => target.focus(), 0);
}
function closeDialog(id) {
  const idx = _dialogStack.findIndex(d => d.id === id);
  if (idx === -1) return;
  const [entry] = _dialogStack.splice(idx, 1);
  entry.root.removeAttribute('aria-modal');
  if (_dialogStack.length === 0) document.removeEventListener('keydown', _onDialogKeydown, true);
  if (entry.previousFocus && document.contains(entry.previousFocus)) {
    try { entry.previousFocus.focus(); } catch (_) {}
  }
  if (typeof entry.onClose === 'function') {
    try { entry.onClose(); } catch (e) { console.error('[NVDP] dialog onClose failed:', e); }
  }
}
window.openDialog = openDialog;
window.closeDialog = closeDialog;

// ═══════════════════════
//  COACH UNREAD BADGE
// ═══════════════════════
async function refreshCoachUnreadBadge() {
  if (!currentProfile) return;
  const lastView = currentProfile.last_coach_view_at || '1970-01-01T00:00:00.000Z';
  // Centralized data layer + error handling (see `api` above).
  const { data: _ignored, error } = { data: null, error: null };
  // Supabase head-count returns the count via the `count` field, not `data`.
  // Pull it out manually here.
  try {
    const res = await sb
      .from('coach_messages')
      .select('id', { count: 'exact', head: true })
      .eq('profile_id', currentProfile.id)
      .eq('role', 'assistant')
      .gt('created_at', lastView);
    if (res.error) {
      console.warn('[NVDP] refreshCoachUnreadBadge failed', res.error);
      return;
    }
    // Drive the UI via the store. Subscribers (registered in initApp)
    // diff-update the badge so we don't churn DOM unnecessarily.
    store.set('coachUnread', res.count || 0);
  } catch (e) {
    console.warn('[NVDP] refreshCoachUnreadBadge threw', e);
  }
}

async function markCoachViewed() {
  if (!currentProfile) return;
  const now = new Date().toISOString();
  const { error } = await api.profile.update(currentProfile.id, { last_coach_view_at: now });
  if (!error) currentProfile.last_coach_view_at = now;
  store.set('coachUnread', 0);
}

// Diff-by-key DOM update for the coach unread badge: only touch text/class
// when the value actually changes. Subscribed once at app init so the badge
// reacts to any store update from anywhere in the app.
function _renderCoachUnreadBadge(count) {
  const badge = document.getElementById('coach-unread-badge');
  if (!badge) return;
  const next = !count ? '' : (count > 9 ? '9+' : String(count));
  if (badge.textContent !== next) badge.textContent = next;
  const shouldHide = !count;
  badge.classList.toggle('hidden', shouldHide);
}
store.on('coachUnread', _renderCoachUnreadBadge);

window.refreshCoachUnreadBadge = refreshCoachUnreadBadge;

// ═══════════════════════
//  HELPERS
// ═══════════════════════
function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function mondayOfWeek(d) {
  const dt = new Date(d);
  dt.setHours(12, 0, 0, 0);
  const day = dt.getDay();
  const diff = (day === 0 ? -6 : 1) - day;
  dt.setDate(dt.getDate() + diff);
  return dt;
}

function addDays(d, n) { const r = new Date(d); r.setHours(12, 0, 0, 0); r.setDate(r.getDate() + n); return r; }

function weekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function stripDayPrefix(label) {
  return label.replace(/^(Mån|Tis|Ons|Tors|Fre|Lör|Sön)\s*[-–,]\s*/i, '');
}

function formatDate(d) {
  const dt = new Date(d);
  return dt.toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' });
}

function isDeloadWeek(mondayDate) {
  const p1Start = parseISOWeekKeyLocal(P1_START);
  const p2Start = parseISOWeekKeyLocal(P2_START);
  const md = mondayDate instanceof Date ? new Date(mondayDate.getTime()) : parseISOWeekKeyLocal(mondayDate);
  md.setHours(12, 0, 0, 0);
  p1Start.setHours(12, 0, 0, 0);
  p2Start.setHours(12, 0, 0, 0);
  let weeksSinceStart;
  if (md >= p2Start) {
    weeksSinceStart = Math.floor((md - p2Start) / (7 * 86400000));
  } else {
    weeksSinceStart = Math.floor((md - p1Start) / (7 * 86400000));
  }
  return weeksSinceStart >= 0 && (weeksSinceStart + 1) % 4 === 0;
}

/** Måndagsnyckel YYYY-MM-DD → lokalt datum (undviker UTC-förskjutning). */
function parseISOWeekKeyLocal(iso) {
  const p = String(iso).split('-').map(Number);
  if (p.length < 3 || p.some(n => Number.isNaN(n))) {
    const d = new Date(iso);
    d.setHours(12, 0, 0, 0);
    return d;
  }
  const dt = new Date(p[0], p[1] - 1, p[2]);
  dt.setHours(12, 0, 0, 0);
  return dt;
}

/** Basvecka för WoW-%: hoppa över deload som jämförelse så veckan efter deload jämförs med veckan före deload. */
function wowBaselineWeekIndex(weekKeys, i) {
  if (i < 1) return null;
  const prevMon = parseISOWeekKeyLocal(weekKeys[i - 1]);
  if (isDeloadWeek(prevMon)) {
    if (i >= 2) return i - 2;
    return null;
  }
  return i - 1;
}

/** Föregående kalender-måndag; om den veckan är deload, hoppa ytterligare en vecka bakåt. */
function calendarBaselineMonday(fromMonday) {
  let m = addDays(fromMonday, -7);
  if (isDeloadWeek(m)) m = addDays(m, -7);
  return m;
}

// ─── Weekly-chart 12-week window helpers ─────────────────────────────────────
// All weekly time-series charts (Effort, Aktivitetsmix, Easy HR, Group hours,
// Group effort) used to dump every available week onto one axis. That made the
// X axis cramped and triggered the "V25 → V8" bug where the label resets at a
// year boundary because weekNumber() is year-local. These helpers give every
// chart a contiguous Monday-by-Monday timeline plus a 12-week sliding window.

const WEEKLY_CHART_WINDOW_OPTIONS = [6, 12, 36];
const WEEKLY_CHART_WINDOW_DEFAULT = 12;
// Kept for any legacy callers / constants that still reference it.
const WEEKLY_CHART_WINDOW = WEEKLY_CHART_WINDOW_DEFAULT;

/** State per chart canvas id → end-anchor index into the contiguous week list.
 *  A value of null (or missing) means "show the latest window". */
window._weeklyChartAnchor = window._weeklyChartAnchor || {};

/** State per chart canvas id → currently selected window size (one of
 *  WEEKLY_CHART_WINDOW_OPTIONS). Defaults to WEEKLY_CHART_WINDOW_DEFAULT. */
window._weeklyChartWindow = window._weeklyChartWindow || {};

/** Resolve the current window size for a chart, falling back to default. */
function _getChartWindowSize(chartId) {
  const v = window._weeklyChartWindow[chartId];
  return WEEKLY_CHART_WINDOW_OPTIONS.includes(v) ? v : WEEKLY_CHART_WINDOW_DEFAULT;
}

/** Build a contiguous list of Monday ISO keys between two Monday ISO keys
 *  (inclusive). Used so chart X axis is monotonic in real time and gaps in
 *  data render as zero rather than visually-adjacent labels jumping
 *  weeks/years. */
function _buildContiguousWeeks(firstMonIso, lastMonIso) {
  if (!firstMonIso || !lastMonIso) return [];
  const start = parseISOWeekKeyLocal(firstMonIso);
  const end = parseISOWeekKeyLocal(lastMonIso);
  if (end < start) return [];
  const out = [];
  let cursor = new Date(start.getTime());
  // Hard cap to avoid runaway loops if data ever contains a bad date.
  let safety = 520;
  while (cursor <= end && safety-- > 0) {
    out.push(isoDate(cursor));
    cursor = addDays(cursor, 7);
  }
  return out;
}

/** Return the N-week window ending at anchorIdx (clamped). If anchorIdx is
 *  null/undefined, defaults to the latest window. `size` defaults to the
 *  app-wide default (12) but per-chart callers should pass the user-selected
 *  size from _getChartWindowSize(chartId). Returns
 *  { weeks, startIdx, endIdx, anchor } where anchor is the resolved end index. */
function _sliceWeekWindow(allWeekKeys, anchorIdx, size = WEEKLY_CHART_WINDOW_DEFAULT) {
  const n = allWeekKeys.length;
  if (n === 0) return { weeks: [], startIdx: 0, endIdx: -1, anchor: -1 };
  let end = (anchorIdx === null || anchorIdx === undefined) ? n - 1 : anchorIdx;
  end = Math.max(0, Math.min(n - 1, end));
  // Window must always be exactly `size` long when there's enough data, even
  // if the user paged past the start.
  let start = Math.max(0, end - size + 1);
  // If we're at the very start of history and have <size weeks, expand end
  // forward instead so we still try to show `size`.
  if (end - start + 1 < size) {
    end = Math.min(n - 1, start + size - 1);
  }
  return { weeks: allWeekKeys.slice(start, end + 1), startIdx: start, endIdx: end, anchor: end };
}

/** Format a short date range like "5 maj – 21 jul" for the navigator subtitle.
 *  Uses Sunday of the last week as the end of the visual range. */
function _formatWeekRangeLabel(firstMonIso, lastMonIso) {
  if (!firstMonIso || !lastMonIso) return '';
  const a = parseISOWeekKeyLocal(firstMonIso);
  const b = addDays(parseISOWeekKeyLocal(lastMonIso), 6);
  const fmt = (d) => d.toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' });
  return `${fmt(a)} – ${fmt(b)}`;
}

/** Inject (or refresh) a small navigator strip into the parent .card of the
 *  given chart canvas. Buttons mutate window._weeklyChartAnchor[chartId] and
 *  window._weeklyChartWindow[chartId] and call rerender() to redraw the chart.
 *  The strip carries a 6/12/36-week segmented selector so the user can trade
 *  granularity (6 → recent trends) for horizon (36 → seasonal context); the
 *  prev/next buttons page by the active window so the visual stride matches
 *  the visible range. */
function _renderChartWeekNav(chartId, totalWeeks, windowInfo, rerender) {
  const canvas = document.getElementById(chartId);
  if (!canvas) return;
  const container = canvas.closest('.chart-container') || canvas.parentElement;
  if (!container) return;
  const card = container.parentElement; // typically the .card wrapper
  if (!card) return;

  const activeSize = _getChartWindowSize(chartId);

  let nav = card.querySelector(`.chart-week-nav[data-chart="${chartId}"]`);
  if (!nav) {
    nav = document.createElement('div');
    nav.className = 'chart-week-nav';
    nav.dataset.chart = chartId;
    const sizeButtons = WEEKLY_CHART_WINDOW_OPTIONS.map((n) => `
      <button type="button" class="chart-week-nav-size-btn" data-size="${n}"
              role="radio" aria-checked="false" aria-label="Visa ${n} veckor">${n} v</button>
    `).join('');
    nav.innerHTML = `
      <div class="chart-week-nav-size" role="radiogroup" aria-label="Antal veckor">${sizeButtons}</div>
      <button type="button" class="chart-week-nav-btn" data-dir="prev" aria-label="Föregående fönster">‹</button>
      <span class="chart-week-nav-range"></span>
      <button type="button" class="chart-week-nav-btn" data-dir="next" aria-label="Nästa fönster">›</button>
      <button type="button" class="chart-week-nav-latest" data-dir="latest">Senaste</button>
    `;
    container.parentElement.insertBefore(nav, container);
  }

  const { weeks, startIdx, endIdx } = windowInfo;
  const rangeEl = nav.querySelector('.chart-week-nav-range');
  if (rangeEl) {
    rangeEl.textContent = weeks.length
      ? _formatWeekRangeLabel(weeks[0], weeks[weeks.length - 1])
      : '';
  }
  const prevBtn = nav.querySelector('[data-dir="prev"]');
  const nextBtn = nav.querySelector('[data-dir="next"]');
  const latestBtn = nav.querySelector('[data-dir="latest"]');
  if (prevBtn) {
    prevBtn.disabled = startIdx <= 0;
    prevBtn.setAttribute('aria-label', `Föregående ${activeSize} veckor`);
  }
  if (nextBtn) {
    nextBtn.disabled = endIdx >= totalWeeks - 1;
    nextBtn.setAttribute('aria-label', `Nästa ${activeSize} veckor`);
  }
  if (latestBtn) latestBtn.hidden = endIdx >= totalWeeks - 1;

  nav.querySelectorAll('.chart-week-nav-size-btn').forEach((btn) => {
    const size = Number(btn.dataset.size);
    const isActive = size === activeSize;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-checked', isActive ? 'true' : 'false');
    btn.onclick = () => {
      if (size === activeSize) return;
      window._weeklyChartWindow[chartId] = size;
      // Snap to the latest data on size change so the new window always
      // shows the most recent N weeks (avoids "I picked 36 weeks but the
      // chart is still anchored to an old window" surprise).
      window._weeklyChartAnchor[chartId] = null;
      rerender();
    };
  });

  // Replace listeners by reattaching (idempotent). Pages by the currently
  // active window size so the prev/next stride matches what the user sees.
  const handler = (delta, jumpToLatest) => () => {
    const cur = (window._weeklyChartAnchor[chartId] === null || window._weeklyChartAnchor[chartId] === undefined)
      ? totalWeeks - 1
      : window._weeklyChartAnchor[chartId];
    if (jumpToLatest) {
      window._weeklyChartAnchor[chartId] = null;
    } else {
      const next = Math.max(0, Math.min(totalWeeks - 1, cur + delta));
      // If user steps past the latest, treat as "latest" so future data flows in.
      window._weeklyChartAnchor[chartId] = (delta > 0 && next === totalWeeks - 1) ? null : next;
    }
    rerender();
  };
  if (prevBtn) { prevBtn.onclick = handler(-activeSize, false); }
  if (nextBtn) { nextBtn.onclick = handler(+activeSize, false); }
  if (latestBtn) { latestBtn.onclick = handler(0, true); }
}

/** Render the unified "this is what the graph tells you" callout below a
 *  chart card. Every weekly trend chart targets one of these slots so the
 *  insight format (badge + title + sub + optional headline) looks identical
 *  across the app. Clears + re-applies className so band changes (ok / warn /
 *  bad / neutral) animate cleanly between renders. */
function _renderChartInsight(slotId, opts) {
  const el = document.getElementById(slotId);
  if (!el) return;
  opts = opts || {};
  const band = ['ok', 'warn', 'bad', 'neutral'].includes(opts.band) ? opts.band : 'neutral';
  const title = opts.title || '';
  const sub = opts.sub || '';
  const headline = (opts.headline === 0 || opts.headline) ? String(opts.headline) : '';
  const headlineLabel = opts.headlineLabel || '';
  if (!title && !sub && !headline) {
    el.className = 'chart-insight';
    el.innerHTML = '';
    return;
  }
  el.className = `chart-insight chart-insight--${band}`;
  el.innerHTML = `
    <span class="chart-insight-badge" aria-hidden="true"></span>
    <div class="chart-insight-text">
      ${title ? `<div class="chart-insight-title">${escapeHTML(title)}</div>` : ''}
      ${sub ? `<div class="chart-insight-sub">${escapeHTML(sub)}</div>` : ''}
    </div>
    ${headline ? `<div class="chart-insight-headline">
      <span class="chart-insight-value">${escapeHTML(headline)}</span>
      ${headlineLabel ? `<span class="chart-insight-label">${escapeHTML(headlineLabel)}</span>` : ''}
    </div>` : ''}`;
}

function getCurrentPeriod(date) {
  const d = new Date(date);
  if (d >= new Date(P2_START) && d <= new Date(P2_END)) return 2;
  if (d >= new Date(P1_START) && d <= new Date(P1_END)) return 1;
  return null;
}

// ═══════════════════════
//  CONFIRM / ALERT MODAL
// ═══════════════════════
let _confirmResolve = null;

function showConfirmModal(title, message, confirmLabel = 'Bekräfta', danger = false) {
  return new Promise(resolve => {
    _confirmResolve = resolve;
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = message;
    const actionsEl = document.getElementById('confirm-actions');
    const btnClass = danger ? 'btn btn-danger btn-sm' : 'btn btn-primary btn-sm';
    actionsEl.innerHTML = `
      <button class="btn btn-ghost btn-sm" onclick="closeConfirmModal(false)">Avbryt</button>
      <button class="${btnClass}" onclick="closeConfirmModal(true)">${confirmLabel}</button>`;
    document.getElementById('confirm-modal').classList.remove('hidden');
  });
}

function showAlertModal(title, message) {
  return new Promise(resolve => {
    _confirmResolve = resolve;
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = message;
    const actionsEl = document.getElementById('confirm-actions');
    actionsEl.innerHTML = `<button class="btn btn-primary btn-sm" onclick="closeConfirmModal(true)">OK</button>`;
    document.getElementById('confirm-modal').classList.remove('hidden');
  });
}

function closeConfirmModal(result) {
  document.getElementById('confirm-modal').classList.add('hidden');
  if (_confirmResolve) { _confirmResolve(result); _confirmResolve = null; }
}

// ═══════════════════════
//  VIEW LOADING
// ═══════════════════════
function showViewLoading(viewId) {
  const el = document.getElementById(viewId);
  if (!el) return;
  const existing = el.querySelector('.view-loading');
  if (existing) return;
  const loader = document.createElement('div');
  loader.className = 'view-loading';
  loader.innerHTML = '<div class="spinner"></div>';
  el.prepend(loader);
}

function hideViewLoading(viewId) {
  const el = document.getElementById(viewId);
  if (!el) return;
  const loader = el.querySelector('.view-loading');
  if (loader) loader.remove();
}

// ═══════════════════════
//  DATA FETCHING
// ═══════════════════════
async function fetchWorkouts(profileId, from, to) {
  // PostgREST silently caps each response at 1000 rows. With ASC ordering
  // that means callers without a date range (notably _loadTrends, which
  // pulls the user's entire history for the Din progress charts) lose the
  // *most recent* rows once the user crosses 1000 workouts — Strava +
  // Garmin imports get there fast. The visible symptom was Säsongstotaler
  // 2026 showing absurdly low YTD numbers vs 2025, because the truncation
  // landed somewhere in 2025 and 2026 was almost entirely chopped off.
  // Page through in 1000-row chunks (same pattern as fetchAllWorkouts) so
  // every caller always sees the full window, regardless of how big the
  // history grows.
  const PAGE = 1000;
  const all = [];
  let offset = 0;
  while (true) {
    let q = sb.from('workouts').select('*').order('workout_date', { ascending: true });
    if (profileId) q = q.eq('profile_id', profileId);
    if (from) q = q.gte('workout_date', from);
    if (to) q = q.lte('workout_date', to);
    q = q.range(offset, offset + PAGE - 1);
    const { data, error } = await q;
    if (error) {
      console.error('fetchWorkouts page error', error);
      break;
    }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    offset += PAGE;
    // Safety net so a runaway loop never hangs the app.
    if (offset > 100000) break;
  }
  return all;
}

async function fetchAllWorkouts() {
  // PostgREST defaults to a 1000-row cap per response. Without explicit
  // pagination we silently lose history once a group passes that threshold —
  // which makes weekly trend charts (group + personal) appear to "start" at
  // whatever week the truncation lands on. Page through the table in 1000-row
  // chunks so charts always see the full history.
  const PAGE = 1000;
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from('workouts')
      .select('*')
      .order('workout_date', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      console.error('fetchAllWorkouts page error', error);
      break;
    }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
    // Safety net so a runaway loop never hangs the app.
    if (from > 100000) break;
  }
  return all;
}

async function fetchReactions(workoutId) {
  const { data } = await sb.from('workout_reactions').select('*').eq('workout_id', workoutId);
  return data || [];
}

async function fetchReactionsBulk(workoutIds) {
  if (!workoutIds.length) return [];
  const { data } = await sb.from('workout_reactions').select('*').in('workout_id', workoutIds);
  return data || [];
}

async function fetchComments(workoutId) {
  const { data } = await sb.from('workout_comments').select('*').eq('workout_id', workoutId).order('created_at', { ascending: true });
  return data || [];
}

async function fetchCommentsBulk(workoutIds) {
  if (!workoutIds.length) return [];
  const { data } = await sb.from('workout_comments').select('*').in('workout_id', workoutIds).order('created_at', { ascending: true });
  return data || [];
}

// PERF: Optimistic-like infrastructure.
// _myReactionMap caches my current reaction per workout so click handlers can
// compute the next state synchronously (no SELECT needed). It's populated by
// every feed/modal renderer that knows my state, and mutated on optimistic
// click. Used both to skip the read in toggleReaction and as the source of
// truth for _applyOptimisticLike's old/new state diff.
window._myReactionMap = window._myReactionMap || new Map();

function _setMyReactionFromList(workoutId, reactions) {
  if (!currentProfile || !workoutId || !reactions) return;
  const mine = reactions.find(r => r.workout_id === workoutId && r.profile_id === currentProfile.id);
  window._myReactionMap.set(workoutId, mine ? mine.reaction : null);
}

function _bulkSyncMyReactions(reactions) {
  if (!currentProfile || !Array.isArray(reactions)) return;
  for (const r of reactions) {
    if (r.profile_id !== currentProfile.id) continue;
    window._myReactionMap.set(r.workout_id, r.reaction);
  }
}

// _applyOptimisticLike toggles the active class, SVG fill, and count text on
// every visible reaction button matching this workout id (group + social +
// personal recent + open modal), without rebuilding any feed. Returns the
// previous + new state so the caller can roll back on a DB error.
function _applyOptimisticLike(workoutId, type) {
  const prev = window._myReactionMap.has(workoutId)
    ? window._myReactionMap.get(workoutId)
    : null;
  // Same button pressed twice → clear; otherwise switch/set.
  const next = (prev === type) ? null : type;
  window._myReactionMap.set(workoutId, next);

  const safeId = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(workoutId) : workoutId;
  const containers = document.querySelectorAll(`[data-workout-id="${safeId}"]`);

  containers.forEach(scope => {
    ['like', 'dislike'].forEach(t => {
      const btn = scope.querySelector(`[data-react-btn="${t}"]`);
      if (!btn) return;
      const isActiveNow = (next === t);
      btn.classList.toggle('active', isActiveNow);

      const svg = btn.querySelector('svg');
      if (svg) svg.setAttribute('fill', isActiveNow ? 'currentColor' : 'none');

      const countEl = btn.querySelector('[data-react-count]');
      if (countEl) {
        const cur = parseInt(countEl.getAttribute('data-count') || '0', 10) || 0;
        let delta = 0;
        if (prev === t && next !== t) delta -= 1;
        if (prev !== t && next === t) delta += 1;
        const nextCount = Math.max(0, cur + delta);
        countEl.setAttribute('data-count', String(nextCount));
        countEl.textContent = nextCount > 0 ? String(nextCount) : '';
      }
    });
  });

  return { prev, next };
}

// toggleReaction now optionally accepts the previous reaction so the click
// handler can skip the round-trip SELECT. When omitted (legacy callers) we
// still fetch to stay safe. Always returns the new reaction state.
async function toggleReaction(workoutId, reactionType, knownPrev) {
  let prev = knownPrev;
  let prevId = null;
  if (prev === undefined) {
    const existing = await fetchReactions(workoutId);
    const mine = existing.find(r => r.profile_id === currentProfile.id);
    prev = mine ? mine.reaction : null;
    prevId = mine ? mine.id : null;
  }
  const next = (prev === reactionType) ? null : reactionType;

  if (prev && next === null) {
    if (prevId) {
      await sb.from('workout_reactions').delete().eq('id', prevId);
    } else {
      await sb.from('workout_reactions').delete().eq('workout_id', workoutId).eq('profile_id', currentProfile.id);
    }
  } else if (prev && next && prev !== next) {
    if (prevId) {
      await sb.from('workout_reactions').update({ reaction: next }).eq('id', prevId);
    } else {
      await sb.from('workout_reactions').update({ reaction: next }).eq('workout_id', workoutId).eq('profile_id', currentProfile.id);
    }
  } else if (!prev && next) {
    await sb.from('workout_reactions').insert({ workout_id: workoutId, profile_id: currentProfile.id, reaction: next });
  }
  window._myReactionMap.set(workoutId, next);
  return next;
}

async function addComment(workoutId, text) {
  if (!text.trim()) return;
  await sb.from('workout_comments').insert({ workout_id: workoutId, profile_id: currentProfile.id, text: text.trim() });
}

async function deleteComment(commentId) {
  await sb.from('workout_comments').delete().eq('id', commentId);
}

async function fetchPlans(periodId) {
  const { data } = await sb.from('period_plans').select('*').eq('period_id', periodId).order('day_of_week');
  return data || [];
}

// The legacy `period_plans` weekly template is shared across all users in a
// period. Only the original training group (Niklas, Love) keeps it as a
// default schedule when they have no AI plan; everyone else sees an empty
// state with a "Skapa ditt första schema" CTA instead.
function isLegacyPlanProfile(profile) {
  if (!profile?.name) return false;
  const first = profile.name.split(' ')[0];
  return Array.isArray(LEGACY_PLAN_USERS) && LEGACY_PLAN_USERS.includes(first);
}

async function fetchPeriods() {
  const { data } = await sb.from('periods').select('*').order('start_date');
  return data || [];
}

function getProfileByName(name) {
  return allProfiles.find(p => p.name.toLowerCase().includes(name.toLowerCase()));
}

// ═══════════════════════
//  DASHBOARD
// ═══════════════════════
async function loadDashboard() {
  showViewLoading('view-dashboard');
  try { await _loadDashboard(); } catch (e) {
    console.error('Dashboard error:', e);
    showToast('Kunde inte ladda dashboard. Kontrollera anslutningen.');
  }
  hideViewLoading('view-dashboard');
  refreshCoachUnreadBadge();
}
let _dashSelectedDate = null;
let _dashPlanWorkouts = [];
let _dashWeekWorkouts = [];

// Calendar strip config
const CAL_STRIP_PAST_DAYS = 60;
const CAL_STRIP_FUTURE_DAYS = 120;
const CAL_STRIP_VISIBLE_CELLS = 4;
const CAL_STRIP_INITIAL_DATA_RADIUS = 14;
const CAL_STRIP_EXTEND_BUFFER = 7;
const CAL_STRIP_EXTEND_RADIUS = 14;
let _calStripAnchorDate = null;
let _calStripLoadedRange = null;
let _calStripScrollHandlerAttached = false;
let _calStripRafPending = false;

async function _loadDashboard() {
  const now = new Date();
  const name = currentProfile?.name || 'du';
  const firstName = name.split(' ')[0];

  document.getElementById('dash-greeting').textContent = `Hej ${firstName}!`;
  document.getElementById('dash-date').textContent = now.toLocaleDateString('sv-SE', { weekday: 'long', day: 'numeric', month: 'long' });

  if (!_dashSelectedDate) _dashSelectedDate = isoDate(now);

  if (PLAN_GENERATION_ENABLED && !_activePlan) {
    _activePlan = await fetchActivePlan(currentProfile?.id);
    if (_activePlan) _activePlanWeeks = await fetchPlanWeeks(_activePlan.id);
  }

  await _renderDashCalendar();
  await _renderDashDayCard(_dashSelectedDate);

  await _loadSchema();
}

const _DASH_DAY_LETTER = ['S', 'M', 'T', 'O', 'T', 'F', 'L'];

let _dashLegacyPlans = null;

async function _renderDashCalendar() {
  const track = document.getElementById('cal-strip-track');
  const scrollArea = document.getElementById('cal-strip-scroll-area');
  if (!track || !scrollArea) return;

  const now = new Date();
  const todayStr = isoDate(now);
  const anchorDate = addDays(now, -CAL_STRIP_PAST_DAYS);
  _calStripAnchorDate = anchorDate;
  const totalDays = CAL_STRIP_PAST_DAYS + CAL_STRIP_FUTURE_DAYS + 1;

  // Initial data window: today ± CAL_STRIP_INITIAL_DATA_RADIUS days
  const dataStart = addDays(now, -CAL_STRIP_INITIAL_DATA_RADIUS);
  const dataEnd = addDays(now, CAL_STRIP_INITIAL_DATA_RADIUS);
  const dataStartStr = isoDate(dataStart);
  const dataEndStr = isoDate(dataEnd);

  _dashWeekWorkouts = await fetchWorkouts(currentProfile?.id, dataStartStr, dataEndStr);
  _calStripWorkouts = _dashWeekWorkouts;
  _calStripRange = { start: dataStartStr, end: dataEndStr };
  _calStripLoadedRange = { start: dataStartStr, end: dataEndStr };

  // Pre-fetch legacy plans for the visible window so day taps are instant.
  // Only the original training group still uses the shared template — for
  // everyone else the day card naturally falls back to "Ingen planerad
  // träning", and skipping the fetch saves a round-trip on cold start.
  _dashLegacyPlans = null;
  if (isLegacyPlanProfile(currentProfile)) {
    try {
      const periods = await fetchPeriods();
      const period = periods.find(p => dataStartStr >= p.start_date && dataEndStr <= p.end_date);
      if (period) _dashLegacyPlans = await fetchPlans(period.id);
    } catch (e) { /* ignore */ }
  }

  _dashPlanWorkouts = [];
  if (_activePlan) {
    try {
      _dashPlanWorkouts = await fetchPlanWorkoutsByDate(_activePlan.id, dataStartStr, dataEndStr);
    } catch (e) { /* ignore */ }
  }

  const workoutDates = new Set(_dashWeekWorkouts.map(w => w.workout_date));
  const planDates = new Set();
  _dashPlanWorkouts.forEach(p => { if (!p.is_rest) planDates.add(p.workout_date); });

  let html = '';
  for (let d = 0; d < totalDays; d++) {
    const cellDate = addDays(anchorDate, d);
    const cellStr = isoDate(cellDate);
    const isToday = cellStr === todayStr;
    const isSelected = cellStr === _dashSelectedDate;
    const isPast = cellDate < now && !isToday;
    const hasDone = workoutDates.has(cellStr);
    const hasPlanned = planDates.has(cellStr);

    let dotClass = 'cal-dot-none';
    if (hasDone) dotClass = 'cal-dot-done';
    else if (isPast && hasPlanned) dotClass = 'cal-dot-missed';
    else if (hasPlanned) dotClass = 'cal-dot-planned';

    const classes = ['cal-cell'];
    if (isToday) classes.push('cal-today');
    if (isSelected && !isToday) classes.push('cal-selected');

    const dayLetter = _DASH_DAY_LETTER[cellDate.getDay()];
    html += `<div class="${classes.join(' ')}" data-date="${cellStr}" onclick="dashCalSelectDay('${cellStr}')">
      <div class="cal-cell-day">${dayLetter}</div>
      <div class="cal-cell-num">${cellDate.getDate()}</div>
      <div class="cal-cell-dot ${dotClass}"></div>
    </div>`;
  }
  track.innerHTML = html;

  _updateCalStripCellSize();

  // Default view: Yesterday, Today, Tomorrow, Day-after-tomorrow (yesterday as leftmost)
  requestAnimationFrame(() => {
    _updateCalStripCellSize();
    _scrollCalToDate(isoDate(addDays(now, -1)), { behavior: 'auto' });
    _updateCalStripHeader();
  });

  if (!_calStripScrollHandlerAttached) {
    scrollArea.addEventListener('scroll', _onCalStripScroll, { passive: true });
    _attachCalStripDragAndWheel(scrollArea);
    window.addEventListener('resize', _updateCalStripCellSize);
    _calStripScrollHandlerAttached = true;
  }
}

function _updateCalStripCellSize() {
  const scrollArea = document.getElementById('cal-strip-scroll-area');
  const track = document.getElementById('cal-strip-track');
  if (!scrollArea || !track) return;
  const w = scrollArea.clientWidth;
  if (w <= 0) return;
  scrollArea.style.setProperty('--cal-strip-area-width', `${w}px`);
  const gap = 8;
  const cellW = (w - 3 * gap) / 4;
  track.querySelectorAll('.cal-cell').forEach(cell => {
    cell.style.width = `${cellW}px`;
    cell.style.flex = '0 0 auto';
  });
  const totalCells = track.children.length;
  track.style.width = `${totalCells * cellW + (totalCells - 1) * gap}px`;
}

function _attachCalStripDragAndWheel(scrollArea) {
  // Vertical wheel -> horizontal scroll (desktop mice have no horizontal axis)
  scrollArea.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    e.preventDefault();
    scrollArea.scrollLeft += e.deltaY;
  }, { passive: false });

  // Pointer drag-to-scroll (desktop)
  let dragging = false;
  let dragMoved = false;
  let startX = 0;
  let startScroll = 0;
  let pointerId = null;
  const DRAG_THRESHOLD = 5;

  scrollArea.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') return;
    if (e.button !== 0) return;
    dragging = true;
    dragMoved = false;
    startX = e.clientX;
    startScroll = scrollArea.scrollLeft;
    pointerId = e.pointerId;
  });

  scrollArea.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== pointerId) return;
    const dx = e.clientX - startX;
    if (!dragMoved && Math.abs(dx) > DRAG_THRESHOLD) {
      dragMoved = true;
      scrollArea.classList.add('cal-strip-dragging');
      try { scrollArea.setPointerCapture(pointerId); } catch (_) {}
    }
    if (dragMoved) {
      e.preventDefault();
      scrollArea.scrollLeft = startScroll - dx;
    }
  });

  const endDrag = (e) => {
    if (!dragging) return;
    if (e && e.pointerId !== pointerId) return;
    dragging = false;
    scrollArea.classList.remove('cal-strip-dragging');
    try { scrollArea.releasePointerCapture(pointerId); } catch (_) {}
    pointerId = null;
  };
  scrollArea.addEventListener('pointerup', endDrag);
  scrollArea.addEventListener('pointercancel', endDrag);
  scrollArea.addEventListener('pointerleave', endDrag);

  // Swallow the click that follows a drag so it doesn't select a day
  scrollArea.addEventListener('click', (e) => {
    if (dragMoved) {
      e.stopPropagation();
      e.preventDefault();
      dragMoved = false;
    }
  }, true);
}

function _scrollCalToDate(dateStr, { behavior = 'auto' } = {}) {
  const scrollArea = document.getElementById('cal-strip-scroll-area');
  if (!scrollArea) return;
  const cell = scrollArea.querySelector(`.cal-cell[data-date="${dateStr}"]`);
  if (!cell) return;
  scrollArea.scrollTo({ left: cell.offsetLeft, behavior });
}

function _getVisibleCalDates() {
  const scrollArea = document.getElementById('cal-strip-scroll-area');
  const track = document.getElementById('cal-strip-track');
  if (!scrollArea || !track || !_calStripAnchorDate) return [];
  const first = track.firstElementChild;
  if (!first) return [];
  const cellWidth = first.getBoundingClientRect().width;
  if (cellWidth <= 0) return [];
  const gapStr = getComputedStyle(track).columnGap || getComputedStyle(track).gap || '0';
  const gap = parseFloat(gapStr) || 0;
  const step = cellWidth + gap;
  const startIdx = Math.max(0, Math.round(scrollArea.scrollLeft / step));
  const dates = [];
  for (let i = 0; i < CAL_STRIP_VISIBLE_CELLS; i++) {
    dates.push(isoDate(addDays(_calStripAnchorDate, startIdx + i)));
  }
  return dates;
}

function _updateCalStripHeader() {
  const monthLabel = document.getElementById('cal-strip-month');
  const todayBtn = document.getElementById('cal-strip-today-btn');
  const visible = _getVisibleCalDates();
  if (visible.length === 0) return;

  const firstVisible = new Date(visible[0] + 'T12:00:00');
  const wk = weekNumber(firstVisible);
  if (monthLabel) {
    monthLabel.textContent = `V${wk} \u2014 ${firstVisible.toLocaleDateString('sv-SE', { month: 'long', year: 'numeric' })}`;
  }

  const todayStr = isoDate(new Date());
  if (todayBtn) todayBtn.classList.toggle('hidden', visible.includes(todayStr));
}

function _onCalStripScroll() {
  if (_calStripRafPending) return;
  _calStripRafPending = true;
  requestAnimationFrame(() => {
    _calStripRafPending = false;
    _updateCalStripHeader();
    _maybeExtendCalStripData();
  });
}

async function _maybeExtendCalStripData() {
  if (!_calStripLoadedRange) return;
  const visible = _getVisibleCalDates();
  if (visible.length === 0) return;

  const leftEdge = new Date(visible[0] + 'T12:00:00');
  const rightEdge = new Date(visible[visible.length - 1] + 'T12:00:00');
  const loadStartDate = new Date(_calStripLoadedRange.start + 'T12:00:00');
  const loadEndDate = new Date(_calStripLoadedRange.end + 'T12:00:00');

  let newStart = _calStripLoadedRange.start;
  let newEnd = _calStripLoadedRange.end;
  const dayMs = 86400000;

  if ((leftEdge - loadStartDate) / dayMs < CAL_STRIP_EXTEND_BUFFER) {
    newStart = isoDate(addDays(leftEdge, -CAL_STRIP_EXTEND_RADIUS));
  }
  if ((loadEndDate - rightEdge) / dayMs < CAL_STRIP_EXTEND_BUFFER) {
    newEnd = isoDate(addDays(rightEdge, CAL_STRIP_EXTEND_RADIUS));
  }

  if (newStart === _calStripLoadedRange.start && newEnd === _calStripLoadedRange.end) return;

  // Mark range optimistically to avoid parallel re-entry
  _calStripLoadedRange = { start: newStart, end: newEnd };
  try {
    const [workouts, planWorkouts] = await Promise.all([
      fetchWorkouts(currentProfile?.id, newStart, newEnd),
      _activePlan ? fetchPlanWorkoutsByDate(_activePlan.id, newStart, newEnd) : Promise.resolve([]),
    ]);
    _dashWeekWorkouts = workouts;
    _calStripWorkouts = workouts;
    _calStripRange = { start: newStart, end: newEnd };
    _dashPlanWorkouts = planWorkouts;
    _repaintCalStripDots();
  } catch (e) {
    console.warn('cal-strip extend failed', e);
  }
}

function _repaintCalStripDots() {
  const now = new Date();
  const workoutDates = new Set((_dashWeekWorkouts || []).map(w => w.workout_date));
  const planDates = new Set();
  (_dashPlanWorkouts || []).forEach(p => { if (!p.is_rest) planDates.add(p.workout_date); });
  document.querySelectorAll('.cal-strip-track .cal-cell').forEach(cell => {
    const cellStr = cell.getAttribute('data-date');
    if (!cellStr) return;
    const cellDate = new Date(cellStr + 'T12:00:00');
    const isToday = cell.classList.contains('cal-today');
    const isPast = cellDate < now && !isToday;
    const hasDone = workoutDates.has(cellStr);
    const hasPlanned = planDates.has(cellStr);
    let dotClass = 'cal-dot-none';
    if (hasDone) dotClass = 'cal-dot-done';
    else if (isPast && hasPlanned) dotClass = 'cal-dot-missed';
    else if (hasPlanned) dotClass = 'cal-dot-planned';
    const dot = cell.querySelector('.cal-cell-dot');
    if (dot) dot.className = `cal-cell-dot ${dotClass}`;
  });
}

async function _renderDashDayCard(dateStr) {
  const el = document.getElementById('dash-day-content');
  if (!el) return;

  const date = new Date(dateStr + 'T12:00:00');
  const dayOfWeek = (date.getDay() + 6) % 7;
  const now = new Date();
  const todayStr = isoDate(now);
  const isToday = dateStr === todayStr;
  const dayLabel = isToday ? 'Idag' : date.toLocaleDateString('sv-SE', { weekday: 'long', day: 'numeric', month: 'short' });

  const cardEl = document.getElementById('dash-day-card');
  if (cardEl) cardEl.classList.toggle('is-today', isToday);

  const dayWorkouts = _dashWeekWorkouts.filter(w => w.workout_date === dateStr);
  const planWorkout = _dashPlanWorkouts.find(pw => pw.workout_date === dateStr);

  let useAiPlan = !!(_activePlan && dateStr >= _activePlan.start_date && dateStr <= _activePlan.end_date);
  let legacyPlan = null;
  if (!useAiPlan && _dashLegacyPlans && isLegacyPlanProfile(currentProfile)) {
    legacyPlan = _dashLegacyPlans.find(p => p.day_of_week === dayOfWeek) || null;
  }

  const plan = planWorkout || legacyPlan;
  const isPast = date < now && !isToday;
  const dayPhase = useAiPlan ? _getPhaseForDate(dateStr) : null;
  const isAssessmentWeek = dayPhase === 'assessment';

  let html = `<div class="ddc-header"><span class="ddc-day-label">${dayLabel}</span>`;

  if (plan && !plan.is_rest && dayPhase) {
    html += `<span class="ddc-phase phase-${dayPhase}">${PHASE_LABELS[dayPhase] || dayPhase}</span>`;
  }
  html += '</div>';

  if (isAssessmentWeek) {
    html += `<div class="assessment-banner ddc-assessment-banner">
      <span class="ab-icon" aria-hidden="true">⚑</span>
      <span class="ab-text"><strong>Bedömningsvecka.</strong> Vi kalibrerar puls och tempo — kör testpassen så friska som möjligt och logga puls/tempo.</span>
    </div>`;
  }

  if (plan && plan.is_rest) {
    html += `<div class="ddc-rest">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="24" height="24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
      <span>Vilodag</span>
    </div>`;
  } else if (plan) {
    const label = useAiPlan ? (plan.label || plan.activity_type) : stripDayPrefix(plan.label);
    const desc = plan.description || '';
    const zone = (useAiPlan && plan.intensity_zone) ? plan.intensity_zone : null;
    const actType = plan.activity_type || '';

    const isAssessmentWorkout = isAssessmentWeek && typeof label === 'string' && /^Bedömning/i.test(label);
    html += `<div class="ddc-plan${isAssessmentWorkout ? ' ddc-plan--assessment' : ''}">`;
    html += `<div class="ddc-plan-title">`;
    if (actType) html += `<span class="ddc-activity-icon">${activityEmoji(actType)}</span>`;
    html += `<span>${label}</span>`;
    if (isAssessmentWorkout) html += `<span class="day-badge--test">TEST</span>`;
    if (zone) html += `<span class="zone-badge zone-${zone.toLowerCase()}">${zone}</span>`;
    html += '</div>';

    const kmMatch = desc.match(/(\d+(?:[–\-]\d+)?)\s*km/);
    const estMin = estimateDurationFromDescription(desc, plan.target_duration_minutes);
    if (kmMatch || estMin > 0) {
      html += '<div class="ddc-plan-meta">';
      if (kmMatch) html += `<span class="ddc-meta-chip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M18 8h1a4 4 0 010 8h-1M2 8h16v9a4 4 0 01-4 4H6a4 4 0 01-4-4V8z"/></svg>${kmMatch[1]} km</span>`;
      if (estMin > 0) html += `<span class="ddc-meta-chip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>${estMin} min</span>`;
      html += '</div>';
    }
    if (desc) html += `<div class="ddc-plan-desc">${desc}</div>`;
    html += '</div>';
  } else {
    html += `<div class="ddc-rest"><span>Ingen planerad träning</span></div>`;
  }

  if (dayWorkouts.length > 0) {
    html += '<div class="ddc-done-section">';
    html += `<div class="ddc-done-label">${dayWorkouts.length > 1 ? dayWorkouts.length + ' genomförda pass' : 'Genomfört'}</div>`;
    dayWorkouts.forEach(w => {
      // Inline feel-prompt: shown when an auto-synced (Strava etc.) workout has no perceived_exertion yet.
      const isAutoSynced = !!(w.external_source || w.strava_id || w.source === 'strava' || w.source === 'garmin');
      const missingFeel = (w.perceived_exertion === null || w.perceived_exertion === undefined);
      const showFeelPrompt = isAutoSynced && missingFeel;
      html += `<div class="ddc-done-item clickable" onclick='openWorkoutModal(${JSON.stringify(w).replace(/'/g, "&#39;")})'>
        ${buildWorkoutBody(w)}
      </div>`;
      if (showFeelPrompt) {
        html += `<div class="feel-inline-prompt" id="feel-inline-${w.id}" data-wid="${w.id}" onclick="event.stopPropagation()">
          <span class="feel-inline-label">Hur kändes det?</span>
          <button type="button" class="feel-pill" data-value="2" onclick="saveInlineFeel('${w.id}', 2, this)"><span class="feel-emoji" aria-hidden="true">😮‍💨</span><span>Tungt</span></button>
          <button type="button" class="feel-pill" data-value="3" onclick="saveInlineFeel('${w.id}', 3, this)"><span class="feel-emoji" aria-hidden="true">🙂</span><span>Lagom</span></button>
          <button type="button" class="feel-pill" data-value="4" onclick="saveInlineFeel('${w.id}', 4, this)"><span class="feel-emoji" aria-hidden="true">💪</span><span>Hade mer</span></button>
        </div>`;
      }
    });
    html += '</div>';
  } else if (isPast && plan && !plan.is_rest) {
    html += `<div class="ddc-missed">Missat</div>`;
  }

  el.innerHTML = html;
  requestAnimationFrame(() => initMapThumbnails());
}

function _getPhaseForDate(dateStr) {
  if (!_activePlan || !_activePlanWeeks) return null;
  for (const w of _activePlanWeeks) {
    const ws = new Date(_activePlan.start_date);
    ws.setDate(ws.getDate() + (w.week_number - 1) * 7);
    const we = addDays(ws, 6);
    if (dateStr >= isoDate(ws) && dateStr <= isoDate(we)) return w.phase;
  }
  return null;
}

function dashCalGoToday() {
  const now = new Date();
  const todayStr = isoDate(now);
  _dashSelectedDate = todayStr;
  _scrollCalToDate(isoDate(addDays(now, -1)), { behavior: 'smooth' });
  _renderDashDayCard(todayStr);
  _updateCalStripSelected();
  _updateCalStripHeader();
}

function _updateCalStripSelected() {
  const cells = document.querySelectorAll('#cal-strip-track .cal-cell');
  cells.forEach(c => {
    c.classList.remove('cal-selected');
    if (c.classList.contains('cal-today')) return;
    if (c.getAttribute('data-date') === _dashSelectedDate) c.classList.add('cal-selected');
  });
}

function dashCalSelectDay(dateStr) {
  _dashSelectedDate = dateStr;
  _renderDashDayCard(dateStr);
  _updateCalStripSelected();
  if (typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 600px)').matches) {
    document.getElementById('dash-day-card')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function quickLogFromDashboard() {
  const d = _dashSelectedDate || isoDate(new Date());
  navigate('log');
  requestAnimationFrame(() => {
    const inp = document.getElementById('log-date');
    if (inp) inp.value = d;
    suggestLogMinutesFromHistory();
  });
}

function toggleDashWeekSection() {
  const panel = document.getElementById('dash-week-collapsible');
  const btn = document.getElementById('dash-schema-toggle');
  if (!panel || !btn) return;
  panel.classList.toggle('dash-week-collapsed');
  const collapsed = panel.classList.contains('dash-week-collapsed');
  btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  localStorage.setItem('nvdp_dash_week_collapsed', collapsed ? '1' : '0');
}

function toggleEffortHelp() {
  const p = document.getElementById('effort-help-panel');
  const b = document.querySelector('.effort-help-btn');
  if (!p) return;
  p.classList.toggle('hidden');
  const hidden = p.classList.contains('hidden');
  if (b) b.setAttribute('aria-expanded', hidden ? 'false' : 'true');
}

function toggleIntensityMore() {
  const ex = document.getElementById('intensity-pills-extra');
  const btn = document.getElementById('intensity-more-btn');
  if (!ex || !btn) return;
  ex.classList.toggle('hidden');
  btn.textContent = ex.classList.contains('hidden') ? 'Visa fler zoner' : 'Dölj extra zoner';
}

function suggestLogMinutesFromHistory() {
  const type = document.getElementById('log-type')?.value;
  if (!type) return;
  try {
    const raw = localStorage.getItem('nvdp_avg_min_' + type);
    if (!raw) return;
    const n = parseInt(raw, 10);
    const minsEl = document.getElementById('log-minutes');
    if (n > 0 && n <= 600 && minsEl) {
      minsEl.value = String(n);
    }
  } catch (e) { /* ignore */ }
}

function copyGroupInviteCode() {
  const code = document.getElementById('group-share-code')?.textContent?.trim();
  if (!code || code === '———') return;
  navigator.clipboard?.writeText(code).then(() => showToast('Kod kopierad')).catch(() => showToast('Kunde inte kopiera'));
}

let _recentWorkouts = [];
let _recentShown = 0;
const RECENT_PAGE = 10;

function showMoreRecent() {
  const el = document.getElementById('recent-workouts');
  if (!el || !_recentWorkouts.length) return;
  // Strava-style feed cards (shared with group + social) instead of the
  // older compact list rows. Each card is clickable to open the workout
  // modal; we bind handlers per-row after insert so DB-sourced fields
  // never end up in inline onclick attributes.
  el.classList.add('feed-stack');
  const batch = _recentWorkouts.slice(_recentShown, _recentShown + RECENT_PAGE);
  const ownerName = currentProfile?.name || 'Du';
  const ownerColor = currentProfile?.color || ACTIVITY_COLORS.Löpning || '#2E86C1';
  const ownerAvatar = currentProfile?.avatar || ownerName[0].toUpperCase();
  const html = batch.map(w => {
    return _buildFeedCardHtml(w, {
      ownerName,
      ownerColor,
      ownerAvatar,
      cardClickAttr: '',
      cardDataAttrs: `data-recent-wid="${escapeHTML(w.id)}" data-workout-id="${escapeHTML(w.id)}"`,
    });
  }).join('');
  _recentShown += batch.length;

  const oldBtn = el.querySelector('.recent-more-btn');
  if (oldBtn) oldBtn.remove();

  el.insertAdjacentHTML('beforeend', html);
  batch.forEach(w => {
    const node = el.querySelector(`[data-recent-wid="${w.id}"]:not([data-wired])`);
    if (node) {
      node.setAttribute('data-wired', '1');
      node.addEventListener('click', () => openWorkoutModal(w));
    }
  });

  if (_recentShown < _recentWorkouts.length) {
    const remaining = _recentWorkouts.length - _recentShown;
    el.insertAdjacentHTML('beforeend',
      `<button class="recent-more-btn btn-show-more" onclick="showMoreRecent()">Visa fler (${remaining} kvar)</button>`
    );
  }
  requestAnimationFrame(() => initMapThumbnails());
}

function isRestDay(dayIdx, plans) {
  if (!plans || plans.length === 0) return dayIdx === 0 || dayIdx === 6;
  const plan = plans.find(p => p.day_of_week === dayIdx);
  if (!plan) return false;
  return plan.is_rest;
}

async function renderWeeklySummary(weekWorkouts, plans, monday, profile) {
  const card = document.getElementById('weekly-summary-card');
  const el = document.getElementById('weekly-summary');
  if (!card || !el) return;

  const now = new Date();
  const todayDow = (now.getDay() + 6) % 7;
  if (todayDow < 4 && weekWorkouts.length < 3) {
    card.classList.add('hidden');
    return;
  }

  const totalMins = weekWorkouts.reduce((s, w) => s + w.duration_minutes, 0);
  const totalHours = (totalMins / 60).toFixed(1);
  const sessionCount = weekWorkouts.length;
  const totalDist = weekWorkouts.reduce((s, w) => s + (w.distance_km || 0), 0);
  const longest = weekWorkouts.reduce((max, w) => w.duration_minutes > (max?.duration_minutes || 0) ? w : max, null);

  const prevMonday = addDays(monday, -7);
  const prevEnd = addDays(prevMonday, todayDow);
  const { data: prevWorkouts } = await sb.from('workouts').select('*')
    .eq('profile_id', profile?.id)
    .gte('workout_date', isoDate(prevMonday))
    .lte('workout_date', isoDate(prevEnd));
  const prevMins = (prevWorkouts || []).reduce((s, w) => s + w.duration_minutes, 0);
  const prevSessions = (prevWorkouts || []).length;
  const prevDist = (prevWorkouts || []).reduce((s, w) => s + (w.distance_km || 0), 0);
  const prevLongest = (prevWorkouts || []).reduce((max, w) => w.duration_minutes > (max?.duration_minutes || 0) ? w : max, null);

  function deltaHTML(cur, prev, unit) {
    if (prev === 0 && cur === 0) return '';
    const diff = cur - prev;
    const sign = diff > 0 ? '+' : '';
    const cls = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat';
    const decimals = unit === 'h' || unit === 'km' ? 1 : 0;
    const val = decimals ? diff.toFixed(decimals) : Math.round(diff);
    return `<span class="ws-delta ${cls}">${sign}${val}${unit}</span>`;
  }

  const longestMin = longest?.duration_minutes || 0;
  const prevLongestMin = prevLongest?.duration_minutes || 0;

  let items = [];
  // BUGFIX: deltaHTML formats a numeric diff with a unit suffix without doing
  // any unit conversion, so passing minutes with unit='h' rendered "-277h"
  // when the actual delta was ~-4.6 h. Convert to hours BEFORE handing the
  // value to deltaHTML so the rendered "+/-Xh" matches reality.
  items.push(`<div class="ws-stat"><span class="ws-val">${totalHours}h</span><span class="ws-label">total tid</span>${deltaHTML(totalMins / 60, prevMins / 60, 'h')}</div>`);
  items.push(`<div class="ws-stat"><span class="ws-val">${sessionCount}</span><span class="ws-label">pass</span>${deltaHTML(sessionCount, prevSessions, '')}</div>`);
  items.push(`<div class="ws-stat"><span class="ws-val">${totalDist > 0 ? totalDist.toFixed(1) : '0'}km</span><span class="ws-label">distans</span>${deltaHTML(totalDist, prevDist, 'km')}</div>`);
  items.push(`<div class="ws-stat"><span class="ws-val">${longest ? longest.duration_minutes + "'" : '—'}</span><span class="ws-label">längsta</span>${deltaHTML(longestMin, prevLongestMin, "'")}</div>`);

  el.innerHTML = `<div class="ws-grid">${items.join('')}</div>`;
  card.classList.remove('hidden');
}

function activityEmoji(type) {
  const map = { 'Löpning': '&#127939;', 'Cykel': '&#128690;', 'Gym': '&#127947;', 'Annat': '&#9889;', 'Hyrox': '&#128293;', 'Stakmaskin': '&#129494;', 'Längdskidor': '&#9924;', 'Vila': '&#128164;' };
  return map[type] || '&#9889;';
}

// ═══════════════════════
//  WORKOUT MODAL (Edit / Delete)
// ═══════════════════════
// Strava-style workout modal: hero map (or gradient fallback) → stat-grid →
// elevation chart → splits-as-bars → laps table → notes → source link →
// reactions/comments. Falls back gracefully when fields are missing so a
// manual log without GPS still looks intentional rather than broken.
async function openWorkoutModal(w) {
  _wmFocusBefore = document.activeElement;
  selectedWorkout = w;
  const isOwn = w.profile_id === currentProfile.id;
  const ownerProfile = allProfiles.find(p => p.id === w.profile_id);
  const ownerName = ownerProfile ? ownerProfile.name : '';

  const titlePrefix = isOwn ? '' : ownerName + ' — ';
  const autoTitle = _autoWorkoutTitle(w);
  document.getElementById('wm-title').textContent = titlePrefix + autoTitle;

  // Tear down any prior chart/map before rebuilding the body so we don't
  // leak Chart.js or Leaflet instances when the user opens modal A → B → A.
  if (_wmMapInstance) {
    try { _wmMapInstance.remove(); } catch (e) { /* ignore */ }
    _wmMapInstance = null;
  }
  if (window._wmElevChart) {
    try { window._wmElevChart.destroy(); } catch (e) { /* ignore */ }
    window._wmElevChart = null;
  }

  const splits = w.splits_data ? (typeof w.splits_data === 'string' ? JSON.parse(w.splits_data) : w.splits_data) : null;
  const laps = w.laps_data ? (typeof w.laps_data === 'string' ? JSON.parse(w.laps_data) : w.laps_data) : null;

  let body = '';

  // ── 1. Hero ────────────────────────────────────────────────────────────
  const intBadge = w.intensity ? `<span class="intensity-badge">${escapeHTML(w.intensity)}</span>` : '';
  const srcBadge = (w.source === 'strava' || w.source === 'garmin') ? _feedSourceBadge(w) : '';
  const overlayMeta = `${escapeHTML(formatDate(w.workout_date))}${w.workout_time ? ' · ' + escapeHTML(w.workout_time) : ''}`;
  if (w.map_polyline) {
    body += `<div class="wm-hero wm-hero--map">
      <div id="wm-map" class="wm-hero-map"></div>
      <div class="wm-hero-overlay">
        <div class="wm-hero-title">${escapeHTML(autoTitle)} ${intBadge}</div>
        <div class="wm-hero-meta">${overlayMeta}${srcBadge ? ' ' + srcBadge : ''}</div>
      </div>
    </div>`;
  } else {
    body += `<div class="wm-hero wm-hero--gradient">
      <span class="wm-hero-emoji">${activityEmoji(w.activity_type)}</span>
      <div class="wm-hero-overlay">
        <div class="wm-hero-title">${escapeHTML(autoTitle)} ${intBadge}</div>
        <div class="wm-hero-meta">${overlayMeta}${srcBadge ? ' ' + srcBadge : ''}</div>
      </div>
    </div>`;
  }

  // ── 2. Stat grid ───────────────────────────────────────────────────────
  const stats = [];
  if (w.distance_km) stats.push({ label: 'Distans', value: (+w.distance_km).toFixed(2), unit: 'km' });
  if (w.duration_minutes != null) {
    const mins = w.duration_minutes;
    const hh = Math.floor(mins / 60);
    const mm = mins % 60;
    stats.push({ label: 'Tid', value: hh > 0 ? `${hh}:${String(mm).padStart(2, '0')}` : `${mm}`, unit: hh > 0 ? 'h' : 'min' });
  }
  if (w.avg_speed_kmh) {
    if (w.activity_type === 'Cykel') {
      stats.push({ label: 'Snitthastighet', value: (+w.avg_speed_kmh).toFixed(1), unit: 'km/h' });
    } else {
      const paceMin = 60 / w.avg_speed_kmh;
      const m = Math.floor(paceMin);
      const s = String(Math.round((paceMin % 1) * 60)).padStart(2, '0');
      stats.push({ label: 'Snittempo', value: `${m}:${s}`, unit: '/km' });
    }
  }
  if (w.avg_hr) stats.push({ label: 'Snittpuls', value: Math.round(w.avg_hr), unit: 'bpm' });
  if (w.max_hr) stats.push({ label: 'Maxpuls', value: Math.round(w.max_hr), unit: 'bpm' });
  if (w.elevation_gain_m) stats.push({ label: 'Höjdmeter', value: Math.round(w.elevation_gain_m), unit: 'm' });
  if (w.effort != null) stats.push({ label: 'Belastning', value: (+w.effort).toFixed(1), unit: '' });
  if (w.calories) stats.push({ label: 'Kalorier', value: w.calories, unit: 'kcal' });
  if (w.avg_cadence) stats.push({ label: 'Kadens', value: Math.round(w.avg_cadence), unit: 'spm' });

  if (stats.length > 0) {
    body += `<div class="wm-stat-grid">` + stats.map(s =>
      `<div class="wm-stat"><div class="wm-stat-value">${escapeHTML(String(s.value))}${s.unit ? `<span class="wm-stat-unit">${escapeHTML(s.unit)}</span>` : ''}</div><div class="wm-stat-label">${escapeHTML(s.label)}</div></div>`
    ).join('') + `</div>`;
  }

  // ── 3. Elevation chart (canvas, populated below after innerHTML) ──────
  const hasElevSeries = splits && splits.some(s => s.elevation_difference != null);
  if (hasElevSeries && splits.length >= 2) {
    body += `<div class="wm-section">
      <div class="wm-section-title">Höjdprofil</div>
      <div class="wm-elev-chart"><canvas id="wm-elev-canvas"></canvas></div>
    </div>`;
  }

  // ── 4. Splits as bars ──────────────────────────────────────────────────
  if (splits && splits.length > 0) {
    // Compute bar widths from pace: faster = longer accent bar. We anchor
    // 100% width to the fastest km in the session and scale others linearly
    // by speed ratio so visually scanning becomes "longer = stronger".
    const speeds = splits.map(s => s.average_speed > 0 ? s.average_speed : 0);
    const maxSpeed = Math.max(...speeds, 0.001);
    body += `<div class="wm-section">
      <div class="wm-section-title">Kilometersplits</div>
      <div class="wm-splits">`;
    splits.forEach((s, i) => {
      const km = s.split || (i + 1);
      const mins = Math.floor((s.moving_time || 0) / 60);
      const secs = (s.moving_time || 0) % 60;
      const pace = s.average_speed > 0 ? 1000 / s.average_speed / 60 : 0;
      const paceMin = Math.floor(pace);
      const paceSec = Math.round((pace - paceMin) * 60);
      const paceStr = pace > 0 ? `${paceMin}:${String(paceSec).padStart(2, '0')}` : '—';
      const widthPct = speeds[i] > 0 ? Math.max(8, (speeds[i] / maxSpeed) * 100) : 8;
      const isFastest = speeds[i] === maxSpeed && maxSpeed > 0;
      const hr = s.average_heartrate ? `<span class="wm-split-pill">${Math.round(s.average_heartrate)}♥</span>` : '';
      const elev = s.elevation_difference != null ? `<span class="wm-split-pill wm-split-pill--elev">${s.elevation_difference > 0 ? '+' : ''}${Math.round(s.elevation_difference)}m</span>` : '';
      body += `<div class="wm-split-row${isFastest ? ' wm-split-row--fast' : ''}">
        <div class="wm-split-km">Km ${km}</div>
        <div class="wm-split-bar"><div class="wm-split-bar-fill" style="width:${widthPct.toFixed(1)}%"></div></div>
        <div class="wm-split-pace">${paceStr}<span class="wm-split-pace-unit">/km</span></div>
        <div class="wm-split-pills">${hr}${elev}</div>
      </div>`;
    });
    body += `</div>
      <div class="wm-splits-legend">Längre stapel = snabbare km</div>
    </div>`;
  }

  // ── 5. Laps ────────────────────────────────────────────────────────────
  if (laps && laps.length > 1) {
    let lapsHtml = `<div class="wm-section">
      <div class="wm-section-title">Varv</div>
      <div class="wm-table-scroll"><table class="wm-splits-table wm-table"><thead><tr><th>#</th><th>Distans</th><th>Tid</th><th>Tempo</th><th>Puls</th></tr></thead><tbody>`;
    laps.forEach((lap, idx) => {
      const dist = (lap.distance / 1000).toFixed(2);
      const mins = Math.floor(lap.moving_time / 60);
      const secs = lap.moving_time % 60;
      const pace = lap.average_speed > 0 ? 1000 / lap.average_speed / 60 : 0;
      const paceMin = Math.floor(pace);
      const paceSec = Math.round((pace - paceMin) * 60);
      const paceStr = pace > 0 ? `${paceMin}:${String(paceSec).padStart(2, '0')}/km` : '—';
      const hr = lap.average_heartrate ? Math.round(lap.average_heartrate) : '—';
      lapsHtml += `<tr><td>${idx + 1}</td><td>${dist} km</td><td>${mins}:${String(secs).padStart(2, '0')}</td><td>${paceStr}</td><td>${hr}</td></tr>`;
    });
    lapsHtml += '</tbody></table></div></div>';
    body += lapsHtml;
  }

  // ── 6. Notes ───────────────────────────────────────────────────────────
  if (w.notes && w.notes !== 'Importerad' && !w.notes.startsWith('[Strava]')) {
    body += `<div class="wm-notes-block"><div class="wm-section-title">Anteckning</div><blockquote class="wm-notes-quote">${escapeHTML(w.notes)}</blockquote></div>`;
  }

  // ── 7. Source link ─────────────────────────────────────────────────────
  if (w.source === 'strava' && w.strava_activity_id) {
    body += `<div class="wm-source-row"><a href="https://www.strava.com/activities/${encodeURIComponent(w.strava_activity_id)}" target="_blank" rel="noopener" class="strava-view-link">Visa på Strava ↗</a></div>`;
  } else if (w.source === 'garmin' && w.garmin_activity_id) {
    body += `<div class="wm-source-row"><a href="https://connect.garmin.com/modern/activity/${encodeURIComponent(w.garmin_activity_id)}" target="_blank" rel="noopener" class="garmin-view-link">Visa på Garmin ↗</a></div>`;
  }

  // ── 8. Reactions + comments (loaded async) ────────────────────────────
  body += `<div id="wm-reactions" class="wm-reactions"><span class="text-dim">Laddar...</span></div>`;
  body += `<div id="wm-comments" class="wm-comments"><span class="text-dim">Laddar...</span></div>`;

  document.getElementById('wm-body').innerHTML = body;

  // Map init (Leaflet) — same lifecycle as before but inside the hero now.
  if (w.map_polyline) {
    ensureLeafletLoaded().then(() => {
      setTimeout(() => {
        const modalEl = document.getElementById('workout-modal');
        if (!modalEl || modalEl.classList.contains('hidden')) return;
        const mapEl = document.getElementById('wm-map');
        if (!mapEl || !mapEl.isConnected || typeof L === 'undefined') return;
        if (mapEl._leaflet_id) return;
        let coords;
        try { coords = decodePolyline(w.map_polyline); } catch (e) { return; }
        if (!coords || coords.length < 2) return;
        try {
          const tmpLine = L.polyline(coords);
          const bounds = tmpLine.getBounds();
          const center = bounds.getCenter();
          const map = L.map(mapEl, {
            zoomControl: false,
            attributionControl: false,
            center: center,
            zoom: 13,
            preferCanvas: true
          });
          L.tileLayer(getMapTileUrl(), { maxZoom: 18 }).addTo(map);
          L.polyline(coords, { color: '#000', weight: 7, opacity: 0.15, lineCap: 'round', lineJoin: 'round' }).addTo(map);
          L.polyline(coords, { color: '#3B9DFF', weight: 4, opacity: 0.95, lineCap: 'round', lineJoin: 'round' }).addTo(map);
          map.fitBounds(bounds, { padding: [20, 20], animate: false });
          _wmMapInstance = map;
          setTimeout(() => { try { map.invalidateSize(); map.fitBounds(bounds, { padding: [20, 20], animate: false }); } catch (e) { /* ignore */ } }, 320);
        } catch (e) {
          console.error('Workout modal map init failed:', e);
        }
      }, 100);
    }).catch(() => {});
  }

  // Elevation chart (Chart.js) — derive cumulative elevation from per-km
  // elevation_difference, since Strava's split payload doesn't include the
  // absolute altitude track. We start at 0 so the curve is "relative gain"
  // which is what runners actually care about.
  if (hasElevSeries && splits.length >= 2) {
    setTimeout(() => {
      const canvas = document.getElementById('wm-elev-canvas');
      if (!canvas || typeof Chart === 'undefined') return;
      const labels = splits.map((s, i) => 'Km ' + (s.split || (i + 1)));
      let cum = 0;
      const data = splits.map(s => {
        cum += (s.elevation_difference || 0);
        return Math.round(cum);
      });
      const textDim = getComputedStyle(document.body).getPropertyValue('--text-dim').trim() || '#888';
      try {
        window._wmElevChart = new Chart(canvas.getContext('2d'), {
          type: 'line',
          data: {
            labels,
            datasets: [{
              data,
              borderColor: '#9B7CFF',
              backgroundColor: 'rgba(155,124,255,0.18)',
              borderWidth: 2,
              fill: true,
              tension: 0.35,
              pointRadius: 0,
              pointHoverRadius: 4,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `${ctx.parsed.y} m` } } },
            scales: {
              x: { ticks: { color: textDim, maxTicksLimit: 6 }, grid: { display: false } },
              y: { ticks: { color: textDim, callback: (v) => v + ' m' }, grid: { color: 'rgba(255,255,255,0.05)' } },
            },
          },
        });
      } catch (e) { console.error('Elev chart failed:', e); }
    }, 80);
  }

  const actionsEl = document.getElementById('wm-edit-actions');
  if (actionsEl) actionsEl.style.display = isOwn ? 'flex' : 'none';

  document.getElementById('workout-modal').classList.remove('hidden');

  loadModalSocial(w.id, isOwn);
}

async function loadModalSocial(workoutId, isOwn) {
  if (isOwn === undefined) {
    isOwn = selectedWorkout && selectedWorkout.profile_id === currentProfile.id;
  }
  const [reactions, comments] = await Promise.all([fetchReactions(workoutId), fetchComments(workoutId)]);

  const likes = reactions.filter(r => r.reaction === 'like');
  const dislikes = reactions.filter(r => r.reaction === 'dislike');
  const myReaction = reactions.find(r => r.profile_id === currentProfile.id);

  const reactEl = document.getElementById('wm-reactions');
  if (reactEl) {
    const likeNames = likes.map(r => { const p = allProfiles.find(pr => pr.id === r.profile_id); return p ? p.name.split(' ')[0] : ''; }).filter(Boolean);
    const dislikeNames = dislikes.map(r => { const p = allProfiles.find(pr => pr.id === r.profile_id); return p ? p.name.split(' ')[0] : ''; }).filter(Boolean);
    const likeTooltip = likeNames.length ? likeNames.join(', ') : '';
    const dislikeTooltip = dislikeNames.length ? dislikeNames.join(', ') : '';

    // Tag the reactions container with the workout id so the optimistic
    // helper can find + toggle these buttons via the shared selector
    // (same as feed cards). data-react-btn + data-react-count make the
    // markup match the feed-card structure.
    reactEl.setAttribute('data-workout-id', workoutId);
    if (isOwn) {
      const summary = [];
      if (likes.length) summary.push(`👍 ${likes.length}`);
      if (dislikes.length) summary.push(`👎 ${dislikes.length}`);
      reactEl.innerHTML = summary.length
        ? `<div class="reaction-bar"><span class="reaction-summary" title="${likeTooltip}">${summary.join('  ')}</span></div>`
        : '';
    } else {
      const likeActive = myReaction?.reaction === 'like';
      const dislikeActive = myReaction?.reaction === 'dislike';
      reactEl.innerHTML = `
        <div class="reaction-bar">
          <button class="react-btn${likeActive ? ' active' : ''}" data-react-btn="like" onclick="handleReaction('${workoutId}', 'like')" title="${likeTooltip}">
            <span class="react-icon">👍</span><span class="react-count" data-react-count data-count="${likes.length}">${likes.length || ''}</span>
          </button>
          <button class="react-btn${dislikeActive ? ' active' : ''}" data-react-btn="dislike" onclick="handleReaction('${workoutId}', 'dislike')" title="${dislikeTooltip}">
            <span class="react-icon">👎</span><span class="react-count" data-react-count data-count="${dislikes.length}">${dislikes.length || ''}</span>
          </button>
        </div>`;
    }
  }
  // Seed _myReactionMap so the next click has accurate "previous state"
  // even if the user opened the modal directly (no feed render preceded it).
  if (currentProfile) {
    window._myReactionMap.set(workoutId, myReaction ? myReaction.reaction : null);
  }

  const commEl = document.getElementById('wm-comments');
  if (commEl) {
    let html = '<div class="comments-section">';
    html += `<div class="comment-section-label">Kommentarer</div>`;

    if (comments.length > 0) {
      html += '<div class="comment-list">';
      comments.forEach(c => {
        const author = allProfiles.find(p => p.id === c.profile_id);
        const name = author ? author.name.split(' ')[0] : '?';
        const isMine = c.profile_id === currentProfile.id;
        const ago = timeAgo(c.created_at);
        html += `<div class="comment-item">
          <div class="comment-author">${name} <span class="comment-time">${ago}</span></div>
          <div class="comment-text">${escapeHTML(c.text)}</div>
          ${isMine ? `<button class="comment-delete" onclick="handleDeleteComment('${c.id}', '${workoutId}')" title="Ta bort">&#10005;</button>` : ''}
        </div>`;
      });
      html += '</div>';
    } else {
      html += '<div class="comment-empty">Inga kommentarer \u00e4nnu</div>';
    }

    html += `<div class="comment-input-row">
      <input type="text" id="wm-comment-input" class="comment-input" placeholder="Skriv en kommentar..." onkeydown="if(event.key==='Enter')handleAddComment('${workoutId}')">
      <button class="btn btn-sm btn-primary comment-send" onclick="handleAddComment('${workoutId}')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
      </button>
    </div>`;
    html += '</div>';
    commEl.innerHTML = html;
  }
}

// SECURITY (assessment H1): escape HTML metacharacters for safe interpolation
// into both element content AND attribute values. Escapes &, <, >, ", ',
// backtick, and = so the output is safe inside unquoted, single-quoted, or
// double-quoted attributes. Always pass DB-sourced strings through this before
// interpolating into an innerHTML template string.
function escapeHTML(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"'`=/]/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
    '`': '&#96;',
    '=': '&#61;',
    '/': '&#47;',
  }[c]));
}

function decodePolyline(encoded) {
  const coords = [];
  let idx = 0, lat = 0, lng = 0;
  while (idx < encoded.length) {
    let b, shift = 0, result = 0;
    do { b = encoded.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    coords.push([lat / 1e5, lng / 1e5]);
  }
  return coords;
}

function timeAgo(isoStr) {
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'nu';
  if (mins < 60) return mins + ' min';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h';
  const days = Math.floor(hrs / 24);
  return days + 'd';
}

function handleReaction(workoutId, type) {
  // Modal click → optimistic toggle. Because the modal's reactions div was
  // tagged with data-workout-id (loadModalSocial), and every visible feed
  // card carries the same attribute, _applyOptimisticLike updates the
  // modal AND every feed in one synchronous pass. The DB write fires in
  // the background; on error we roll back + toast.
  const { prev, next } = _applyOptimisticLike(workoutId, type);
  toggleReaction(workoutId, type, prev)
    .then(() => {
      // Mirror the change into the group-feed reactions cache so that
      // pagination (showMoreFeed) reflects the new state without a refetch.
      if (_feedReactionsCache && Array.isArray(_feedReactionsCache.reactions) && currentProfile) {
        const arr = _feedReactionsCache.reactions;
        for (let i = arr.length - 1; i >= 0; i--) {
          const r = arr[i];
          if (r.workout_id === workoutId && r.profile_id === currentProfile.id) arr.splice(i, 1);
        }
        if (next) {
          arr.push({ workout_id: workoutId, profile_id: currentProfile.id, reaction: next });
        }
      }
    })
    .catch(err => {
      console.warn('toggleReaction failed, rolling back', err);
      _applyOptimisticLike(workoutId, prev || type);
      if (typeof showToast === 'function') showToast('Kunde inte spara reaktion');
    });
}

async function handleAddComment(workoutId) {
  const input = document.getElementById('wm-comment-input');
  if (!input || !input.value.trim()) return;
  await addComment(workoutId, input.value);
  await loadModalSocial(workoutId);
}

async function handleDeleteComment(commentId, workoutId) {
  await deleteComment(commentId);
  await loadModalSocial(workoutId);
}

function closeWorkoutModal() {
  document.getElementById('workout-modal').classList.add('hidden');
  selectedWorkout = null;
  if (_wmMapInstance) {
    try { _wmMapInstance.remove(); } catch (e) { /* ignore */ }
    _wmMapInstance = null;
  }
  if (window._wmElevChart) {
    try { window._wmElevChart.destroy(); } catch (e) { /* ignore */ }
    window._wmElevChart = null;
  }
  if (_wmFocusBefore && typeof _wmFocusBefore.focus === 'function') {
    try { _wmFocusBefore.focus(); } catch (e) { /* ignore */ }
  }
  _wmFocusBefore = null;
}

function askCoachAboutWorkout() {
  if (!selectedWorkout) return;
  const w = selectedWorkout;
  const isMine = w.profile_id === currentProfile?.id;
  if (!isMine) return;
  const parts = [`Berätta om passet jag körde ${w.workout_date}`];
  if (w.activity_type) parts.push(`— ${w.activity_type}`);
  if (w.duration_minutes) parts.push(`, ${w.duration_minutes} min`);
  if (w.distance_km) parts.push(`, ${w.distance_km} km`);
  if (w.intensity) parts.push(` (${w.intensity})`);
  if (w.avg_hr) parts.push(`, snittpuls ${w.avg_hr}`);
  const prompt = parts.join('') + '. Hur ser det ut, och vad ska jag tänka på framåt?';
  closeWorkoutModal();
  navigate('coach');
  setTimeout(() => {
    const input = document.getElementById('coach-input');
    if (input) {
      input.value = prompt;
      input.dispatchEvent(new Event('input'));
      input.focus();
    }
  }, 120);
}
window.askCoachAboutWorkout = askCoachAboutWorkout;

function editWorkout() {
  if (!selectedWorkout) return;
  const workout = { ...selectedWorkout };
  closeWorkoutModal();
  navigate('log');
  editingWorkoutId = workout.id;
  document.getElementById('log-date').value = workout.workout_date;
  document.getElementById('log-time').value = workout.workout_time || '';
  document.getElementById('log-type').value = workout.activity_type;
  document.getElementById('log-minutes').value = workout.duration_minutes;
  document.getElementById('log-distance').value = workout.distance_km || '';
  const rawNotes = workout.notes || '';
  document.getElementById('log-notes').value = rawNotes === 'Importerad' ? '' : rawNotes;
  document.querySelectorAll('.intensity-pill').forEach(p => {
    p.classList.toggle('active', p.dataset.value === workout.intensity);
  });
  document.getElementById('log-intensity').value = workout.intensity || '';
  // Preselect feel chip from existing perceived_exertion (RPE) if it was set via feel chips.
  const existingRpe = workout.perceived_exertion;
  let feelVal = '';
  if (existingRpe === 7) feelVal = '2';
  else if (existingRpe === 5) feelVal = '3';
  else if (existingRpe === 3) feelVal = '4';
  document.getElementById('log-feel-value').value = feelVal;
  document.querySelectorAll('#log-feel .feel-pill').forEach(p => {
    p.classList.toggle('active', p.dataset.value === feelVal);
  });
  document.getElementById('log-form').querySelector('[type="submit"]').textContent = 'Uppdatera pass';
}

async function deleteWorkout() {
  if (!selectedWorkout) return;
  const confirmed = await showConfirmModal('Ta bort pass', 'Är du säker på att du vill ta bort detta pass?', 'Ta bort', true);
  if (!confirmed) return;
  const { error } = await sb.from('workouts').delete().eq('id', selectedWorkout.id);
  if (error) { await showAlertModal('Fel', 'Kunde inte ta bort: ' + error.message); return; }
  closeWorkoutModal();
  navigate(currentView);
}

// ═══════════════════════
//  LOG WORKOUT
// ═══════════════════════
document.querySelectorAll('.intensity-pill').forEach(pill => {
  pill.addEventListener('click', () => {
    const hidden = document.getElementById('log-intensity');
    if (pill.classList.contains('active')) {
      pill.classList.remove('active');
      hidden.value = '';
    } else {
      document.querySelectorAll('.intensity-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      hidden.value = pill.dataset.value;
    }
  });
});

// Feel pills (per-pass feel) — scoped to #log-feel
document.querySelectorAll('#log-feel .feel-pill').forEach(pill => {
  pill.addEventListener('click', () => {
    const hidden = document.getElementById('log-feel-value');
    if (pill.classList.contains('active')) {
      pill.classList.remove('active');
      hidden.value = '';
    } else {
      document.querySelectorAll('#log-feel .feel-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      hidden.value = pill.dataset.value;
    }
  });
});

// Map feel chip value (2/3/4) → RPE per ALGORITHM.md spec.
// 2=Tungt → RPE 7, 3=Lagom → RPE 5, 4=Hade mer → RPE 3.
function feelToRpe(feel) {
  const f = parseInt(feel, 10);
  if (f === 2) return 7;
  if (f === 3) return 5;
  if (f === 4) return 3;
  return null;
}

// Save feel from an inline prompt on dashboard day card. Patches workouts.perceived_exertion.
async function saveInlineFeel(workoutId, feelVal, btnEl) {
  const rpe = feelToRpe(feelVal);
  if (rpe === null) return;
  const wrap = document.getElementById('feel-inline-' + workoutId);
  if (wrap) {
    wrap.querySelectorAll('.feel-pill').forEach(p => p.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');
  }
  try {
    const { error } = await sb.from('workouts')
      .update({ perceived_exertion: rpe })
      .eq('id', workoutId);
    if (error) throw error;
    // Reflect change locally so UI doesn't reshow the prompt on next render.
    if (Array.isArray(_dashWeekWorkouts)) {
      const w = _dashWeekWorkouts.find(x => x.id === workoutId);
      if (w) w.perceived_exertion = rpe;
    }
    if (wrap) {
      wrap.classList.add('saved');
      wrap.querySelector('.feel-inline-label').textContent = 'Tack!';
    }
  } catch (e) {
    console.error('saveInlineFeel failed', e);
    if (wrap) wrap.querySelector('.feel-inline-label').textContent = 'Kunde inte spara';
  }
}
window.saveInlineFeel = saveInlineFeel;

document.getElementById('log-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const date = document.getElementById('log-date').value;
  const time = document.getElementById('log-time').value || null;
  const type = document.getElementById('log-type').value;
  const mins = parseInt(document.getElementById('log-minutes').value);
  const distRaw = document.getElementById('log-distance').value;
  const distance = distRaw ? parseFloat(distRaw) : null;
  const intensity = document.getElementById('log-intensity').value || null;
  const notes = document.getElementById('log-notes').value.trim();
  const feelRaw = document.getElementById('log-feel-value').value;
  const rpe = feelToRpe(feelRaw);

  const row = {
    profile_id: currentProfile.id,
    workout_date: date,
    activity_type: type,
    duration_minutes: mins,
    notes: notes || null
  };
  if (time) row.workout_time = time;
  if (distance !== null) row.distance_km = distance;
  if (intensity) row.intensity = intensity;
  if (rpe !== null) row.perceived_exertion = rpe;

  let error;
  if (editingWorkoutId) {
    const res = await sb.from('workouts').update(row).eq('id', editingWorkoutId);
    error = res.error;
  } else {
    const res = await sb.from('workouts').insert(row);
    error = res.error;
  }

  if (error) {
    showAlertModal('Fel', 'Kunde inte spara: ' + error.message);
    return;
  }

  editingWorkoutId = null;
  try {
    const keyMin = 'nvdp_avg_min_' + type;
    const keyN = 'nvdp_avg_n_' + type;
    const prevN = parseInt(localStorage.getItem(keyN) || '0', 10);
    const prevAvg = parseInt(localStorage.getItem(keyMin) || '0', 10);
    const newN = prevN + 1;
    const newAvg = prevN > 0 ? Math.round((prevAvg * prevN + mins) / newN) : mins;
    localStorage.setItem(keyMin, String(newAvg));
    localStorage.setItem(keyN, String(newN));
  } catch (e) { /* ignore */ }

  document.getElementById('log-form-container').classList.add('hidden');
  document.getElementById('log-success').classList.remove('hidden');
  const intLabel = intensity ? ` (${intensity})` : '';
  document.getElementById('log-success-text').textContent = `${type}${intLabel} ${mins} min — ${formatDate(date)}`;
});

function resetLogForm() {
  editingWorkoutId = null;
  document.getElementById('log-form-container').classList.remove('hidden');
  document.getElementById('log-success').classList.add('hidden');
  document.getElementById('log-form').reset();
  document.getElementById('log-date').value = isoDate(new Date());
  document.getElementById('log-time').value = '';
  document.getElementById('log-intensity').value = '';
  document.querySelectorAll('.intensity-pill').forEach(p => p.classList.remove('active'));
  const fv = document.getElementById('log-feel-value');
  if (fv) fv.value = '';
  document.querySelectorAll('#log-feel .feel-pill').forEach(p => p.classList.remove('active'));
  const ex = document.getElementById('intensity-pills-extra');
  const imb = document.getElementById('intensity-more-btn');
  if (ex && !ex.classList.contains('hidden')) {
    ex.classList.add('hidden');
    if (imb) imb.textContent = 'Visa fler zoner';
  }
  document.getElementById('log-form').querySelector('[type="submit"]').textContent = 'Spara pass';
}

// ═══════════════════════
//  SCHEMA
// ═══════════════════════
async function loadSchema() {
  try { await _loadSchema(); } catch (e) { console.error('Schema error:', e); }
}
let _calStripWorkouts = null;
let _calStripRange = null;

async function _loadSchema() {
  const tabsEl = document.getElementById('schema-person-tabs');
  tabsEl.innerHTML = '';

  // Keep the Vecka/Månad pill UI in sync with persisted state on every load
  // (covers cold-start, view-change, and external nav).
  document.querySelectorAll('#schema-view-toggle .schema-view-pill').forEach((b) => {
    const active = b.dataset.view === _schemaView;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  if (_schemaView === 'month') {
    return _loadSchemaMonth();
  }

  const profile = currentProfile;
  const now = new Date();
  const currentMonday = mondayOfWeek(now);
  const targetMonday = addDays(currentMonday, schemaWeekOffset * 7);
  const targetSunday = addDays(targetMonday, 6);
  const wk = weekNumber(targetMonday);
  const todayBtn = document.getElementById('schema-today-btn');
  if (todayBtn) todayBtn.classList.toggle('hidden', schemaWeekOffset === 0);

  const workouts = await fetchWorkouts(profile?.id, isoDate(targetMonday), isoDate(targetSunday));
  const invitations = await fetchInvitationsForWeek(profile?.id, isoDate(targetMonday), isoDate(targetSunday));
  const isOwnSchema = profile?.id === currentProfile?.id;

  // Check for AI-generated plan
  if (isOwnSchema && PLAN_GENERATION_ENABLED) {
    if (!_activePlan) {
      _activePlan = await fetchActivePlan(profile?.id);
      if (_activePlan) {
        _activePlanWeeks = await fetchPlanWeeks(_activePlan.id);
      }
    }
  }

  const isInActivePlan = _activePlan &&
    isoDate(targetMonday) >= _activePlan.start_date &&
    isoDate(targetSunday) <= _activePlan.end_date;

  if (isOwnSchema && isInActivePlan) {
    // AI plan mode
    const planWorkouts = await fetchPlanWorkoutsByDate(_activePlan.id, isoDate(targetMonday), isoDate(targetSunday));
    const currentWeek = planWorkouts.length > 0 ? planWorkouts[0].plan_weeks : null;
    const phase = currentWeek?.phase || 'base';
    const weekNum = currentWeek?.week_number || '?';
    const phaseLabel = PHASE_LABELS[phase] || phase;

    document.getElementById('schema-week-label').textContent =
      `V${wk} — ${phaseLabel} v${weekNum} — ${formatDate(targetMonday)} till ${formatDate(targetSunday)}`;

    renderGenerateButton();
    updateSchemaEditBar();
    renderSchemaPlan(workouts, planWorkouts, targetMonday, invitations, isOwnSchema, profile, phase);
  } else {
    // Legacy mode (period_plans). Only the original training group keeps the
    // shared weekly template as a default; new users get an empty state with
    // a CTA to create their first AI schedule.
    _schemaEditMode = false;
    const deload = isDeloadWeek(targetMonday);
    document.getElementById('schema-week-label').textContent =
      `V${wk}${deload ? ' (Deload)' : ''} — ${formatDate(targetMonday)} till ${formatDate(targetSunday)}`;

    renderGenerateButton();
    updateSchemaEditBar();

    if (isOwnSchema && !isLegacyPlanProfile(profile)) {
      renderSchemaEmpty(targetMonday, targetSunday);
    } else {
      const periods = await fetchPeriods();
      const mondayStr = isoDate(targetMonday);
      const period = periods.find(p => mondayStr >= p.start_date && mondayStr <= p.end_date);
      let plans = [];
      if (period) plans = await fetchPlans(period.id);

      renderSchema(workouts, plans, targetMonday, deload, invitations, isOwnSchema, profile);
    }
  }
  try { await updateCoachCheckinBanner(); } catch (_e) { /* non-blocking */ }
}

// ═════════════════════════════════════════════════════════════════════
//  MONTH VIEW
//  ─────────────────────────────────────────────────────────────────
//  Renders the schema as a calendar grid (Mon-first). Each cell shows
//  the day number plus a compact summary of plan/actual workouts; the
//  user taps a cell to open the day detail modal which reuses the
//  same data plumbing as the week view.
// ═════════════════════════════════════════════════════════════════════

// Month state — per-render context the day-cell click handler needs.
let _monthRenderCtx = null;

async function _loadSchemaMonth() {
  const profile = currentProfile;
  const monthStart = _monthStartFromOffset(schemaMonthOffset);
  const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0);

  // Visible grid spans the Monday of the week containing the 1st through
  // the Sunday of the week containing the last day, so we always show a
  // tidy 5- or 6-row calendar with leading/trailing days dimmed.
  const gridStart = mondayOfWeek(monthStart);
  const gridEndMonday = mondayOfWeek(monthEnd);
  const gridEnd = addDays(gridEndMonday, 6);

  const todayBtn = document.getElementById('schema-today-btn');
  if (todayBtn) todayBtn.classList.toggle('hidden', schemaMonthOffset === 0);

  // Update label — month name in Swedish.
  const monthNames = ['januari','februari','mars','april','maj','juni','juli','augusti','september','oktober','november','december'];
  const monthName = monthNames[monthStart.getMonth()];
  const labelEl = document.getElementById('schema-week-label');
  if (labelEl) labelEl.textContent = `${monthName.charAt(0).toUpperCase() + monthName.slice(1)} ${monthStart.getFullYear()}`;

  const workouts = await fetchWorkouts(profile?.id, isoDate(gridStart), isoDate(gridEnd));
  const isOwnSchema = profile?.id === currentProfile?.id;

  // Plan workouts (AI plan) — only fetched for the owner. We don't bother
  // overlapping multiple plans here; if a plan covers any part of the grid
  // we pull its workouts for the visible range.
  let planWorkouts = [];
  if (isOwnSchema && PLAN_GENERATION_ENABLED) {
    if (!_activePlan) {
      _activePlan = await fetchActivePlan(profile?.id);
      if (_activePlan) _activePlanWeeks = await fetchPlanWeeks(_activePlan.id);
    }
    if (_activePlan) {
      planWorkouts = await fetchPlanWorkoutsByDate(_activePlan.id, isoDate(gridStart), isoDate(gridEnd));
    }
  }

  // Legacy period_plans fallback for cells outside any AI plan window.
  // Only the original training group sees the shared template; for everyone
  // else the cells just stay empty (the top-of-page pill provides the CTA).
  let legacyPlans = [];
  if (isOwnSchema && isLegacyPlanProfile(profile) &&
      (!_activePlan || isoDate(monthStart) < _activePlan.start_date || isoDate(monthEnd) > _activePlan.end_date)) {
    const periods = await fetchPeriods();
    const period = periods.find(p => isoDate(monthStart) <= p.end_date && isoDate(monthEnd) >= p.start_date);
    if (period) legacyPlans = await fetchPlans(period.id);
  }

  renderGenerateButton();
  updateSchemaEditBar();
  renderSchemaMonth({
    workouts, planWorkouts, legacyPlans,
    gridStart, gridEnd, monthStart, monthEnd,
    isOwnSchema, profile,
  });
  try { await updateCoachCheckinBanner(); } catch (_e) { /* non-blocking */ }
}

// ── Month-cell classifier helpers ───────────────────────────────────
// Builds a Map<isoWeekKey, maxMinutes> across all visible plan + actual
// workouts so we can mark the longest pass of each week with an "L" tag
// even when the user hasn't typed "lång" in the label.
function _smcWeekMaxMins(workouts, planWorkouts) {
  const max = new Map();
  const bump = (dateStr, mins) => {
    if (!mins || mins <= 0) return;
    const key = _isoWeekKey(dateStr);
    if (!key) return;
    if (!max.has(key) || mins > max.get(key)) max.set(key, mins);
  };
  for (const pw of planWorkouts || []) {
    if (pw.is_rest) continue;
    bump(pw.workout_date, pw.duration_minutes || 0);
  }
  for (const w of workouts || []) bump(w.workout_date, w.duration_minutes || 0);
  return max;
}

// ISO week key (e.g. "2026-W17") shared between plan + actual lookups.
function _isoWeekKey(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00Z');
  if (isNaN(d.getTime())) return null;
  // ISO: Thursday in current week defines the year/week.
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const diff = (d - firstThursday) / 86400000;
  const week = 1 + Math.round((diff - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// Returns the small letter-tag span for a month-cell item. Priority:
// long > quality > z2. Strength / non-aerobic falls back to "K" since
// gym + hyrox sessions are by nature high-intensity. We always emit a
// tag so every cell carries at-a-glance context.
function _smcTagHtml(item, dateObj, weekMaxByIso) {
  const text = `${item.label || ''} ${item.desc || ''}`.toLowerCase();
  const zone = (item.zone || '').toLowerCase();
  const mins = item.mins || 0;
  const type = (item.type || '').toLowerCase();

  const isoKey = _isoWeekKey(isoDate(dateObj));
  const weekMax = isoKey ? (weekMaxByIso.get(isoKey) || 0) : 0;
  const isLong =
    /lång|long|long run|långpass/.test(text) ||
    (weekMax >= 60 && mins >= weekMax) ||
    (type.includes('löp') && mins >= 90) ||
    (type.includes('cyk') && mins >= 120);
  if (isLong) return '<span class="smc-pass-tag smc-pass-tag--long" title="Långpass">L</span>';

  const isQuality =
    ['z3', 'z4', 'z5', 'mixed'].includes(zone) ||
    /intervall|tempo|kvalitet|fartlek|backe|tröskel|threshold|hyrox|wod|crossfit/.test(text) ||
    type.includes('hyrox');
  if (isQuality) return '<span class="smc-pass-tag smc-pass-tag--quality" title="Kvalitetspass">K</span>';

  // Strength / gym always reads as quality stress.
  if (type.includes('gym') || type.includes('styrk') || /styrka|gym|lyft|crossfit/.test(text)) {
    return '<span class="smc-pass-tag smc-pass-tag--quality" title="Styrkepass">K</span>';
  }

  // Everything else (explicit z1/z2 OR endurance with no zone) collapses
  // to Z2 — that's the calmest aerobic bucket and the right default for
  // unspecified löp/cykel/promenad.
  return '<span class="smc-pass-tag smc-pass-tag--z2" title="Lugnt aerobt pass">Z2</span>';
}

// Rough distance estimate from minutes when target_distance_km is
// missing on the plan row. Uses zone-aware pace defaults so the user
// sees a sensible km figure on every aerobic pass without having to
// hand-edit each one.
function _smcEstimateKm(item) {
  if (item.km && item.km > 0) return item.km;
  const mins = item.mins || 0;
  if (!mins) return 0;
  const type = (item.type || '').toLowerCase();
  const zone = (item.zone || '').toLowerCase();
  // Running pace (min/km) by zone; default Z2.
  const runPace = { z1: 6.6, z2: 6.0, z3: 5.0, z4: 4.5, z5: 4.0, mixed: 5.2 };
  // Cycling speed (km/h) by zone; default Z2.
  const cycKmh  = { z1: 18,  z2: 24,  z3: 28,  z4: 32,  z5: 36,  mixed: 28 };
  if (type.includes('löp') || type.includes('vandring') || type.includes('promenad')) {
    const pace = runPace[zone] || runPace.z2;
    return mins / pace;
  }
  if (type.includes('cyk')) {
    const kmh = cycKmh[zone] || cycKmh.z2;
    return (mins / 60) * kmh;
  }
  // Stakmaskin / längdskidor — treat as endurance with Z2 default speed.
  if (type.includes('skid') || type.includes('stak')) {
    return (mins / 60) * 12;
  }
  return 0; // Gym / Hyrox / Annat: distance not meaningful.
}

function renderSchemaMonth(ctx) {
  _monthRenderCtx = ctx;
  const { workouts, planWorkouts, legacyPlans, gridStart, gridEnd, monthStart } = ctx;
  const container = document.getElementById('schema-content');
  if (!container) return;

  const todayStr = isoDate(new Date());
  const weekdayLabels = ['Mån','Tis','Ons','Tor','Fre','Lör','Sön'];

  let html = '<div class="schema-month-grid">';
  for (const lbl of weekdayLabels) html += `<div class="smc-weekday">${lbl}</div>`;

  const totalDays = Math.round((gridEnd - gridStart) / 86400000) + 1;
  for (let i = 0; i < totalDays; i++) {
    const d = addDays(gridStart, i);
    const dayStr = isoDate(d);
    const inMonth = d.getMonth() === monthStart.getMonth();
    const isToday = dayStr === todayStr;
    const dayWorkouts = workouts.filter(w => w.workout_date === dayStr);
    const planForDay = planWorkouts.filter(pw => pw.workout_date === dayStr);

    // Legacy plan fallback — only when AI plan has no entry for this day
    // AND the day falls outside any AI plan window.
    let legacyForDay = [];
    if (planForDay.length === 0 && legacyPlans.length > 0) {
      const inActivePlan = _activePlan
        && dayStr >= _activePlan.start_date
        && dayStr <= _activePlan.end_date;
      if (!inActivePlan) {
        const dow = (d.getDay() + 6) % 7;
        const lp = legacyPlans.find(p => p.day_of_week === dow);
        if (lp) legacyForDay = [lp];
      }
    }

    const restPlan = planForDay.length > 0 && planForDay.every(p => p.is_rest);
    const hasPlannedWork = planForDay.some(p => !p.is_rest) || legacyForDay.length > 0;
    const isPast = dayStr < todayStr;
    const isDone = dayWorkouts.length > 0;
    const isMissed = isPast && hasPlannedWork && !isDone;

    const cellCls = ['smc-cell'];
    if (!inMonth) cellCls.push('smc-out');
    if (isToday) cellCls.push('smc-today');
    if (restPlan) cellCls.push('smc-rest');
    if (isDone) cellCls.push('smc-done');
    if (isMissed) cellCls.push('smc-missed');

    let dayNumHtml = isToday
      ? `<span class="smc-day-num smc-day-num--today">${d.getDate()}</span>`
      : `<span class="smc-day-num">${d.getDate()}</span>`;

    let statusDot = '';
    if (isDone) statusDot = '<span class="smc-status-dot smc-status-dot--done" aria-label="Genomfört"></span>';
    else if (isMissed) statusDot = '<span class="smc-status-dot smc-status-dot--missed" aria-label="Missat"></span>';

    // Compact body — show up to 2 lines (plan or actual), then "+N".
    const lines = [];
    if (restPlan) {
      lines.push('<div class="smc-rest-pill">Vila</div>');
    } else {
      // Prefer planned items; fall back to actual if no plan exists.
      const items = planForDay.filter(p => !p.is_rest).map(pw => ({
        type: pw.activity_type || 'Löpning',
        zone: pw.intensity_zone || '',
        mins: pw.duration_minutes || 0,
        km: pw.target_distance_km || 0,
        label: pw.label || '',
        desc: pw.description || '',
      }));
      if (items.length === 0 && legacyForDay.length > 0) {
        for (const lp of legacyForDay) {
          items.push({
            type: lp.activity_type || 'Löpning',
            zone: '', mins: lp.duration_minutes || 0, km: 0,
            label: lp.title || '', desc: lp.description || '',
          });
        }
      }
      // If nothing was planned but we have actuals, show those instead.
      if (items.length === 0 && dayWorkouts.length > 0) {
        for (const w of dayWorkouts) {
          items.push({
            type: w.activity_type, zone: w.intensity || '',
            mins: w.duration_minutes || 0,
            km: w.distance_km || 0,
            label: '', desc: w.notes || '',
          });
        }
      }

      // Classify each item as long / quality / z2 / null so the user can
      // tell at a glance what the day's character is. Long-pass uses a
      // per-week max so it works even without explicit labels.
      const weekMaxByIso = _smcWeekMaxMins(workouts, planWorkouts);
      const visible = items.slice(0, 2);
      for (const it of visible) {
        const tagHtml = _smcTagHtml(it, d, weekMaxByIso);
        const km = _smcEstimateKm(it);
        const distStr = km > 0 ? `${km < 10 ? km.toFixed(1) : Math.round(km)}km` : '';
        const minStr = it.mins ? `${it.mins}'` : '';
        const meta = [distStr, minStr].filter(Boolean).join(' · ');
        lines.push(
          `<div class="smc-pass-line">` +
            `<span class="smc-pass-emoji">${activityEmoji(it.type)}</span>` +
            tagHtml +
            (meta ? `<span class="smc-pass-meta">${meta}</span>` : '') +
          `</div>`
        );
      }
      if (items.length > visible.length) {
        lines.push(`<div class="smc-more">+${items.length - visible.length} till</div>`);
      }
    }

    const clickAttr = inMonth ? ` onclick="openDayDetailModal('${dayStr}')"` : '';
    html += `<div class="${cellCls.join(' ')}"${clickAttr}>` +
      `<div class="smc-day-row">${dayNumHtml}${statusDot}</div>` +
      lines.join('') +
      `</div>`;
  }
  html += '</div>';
  container.innerHTML = html;
}

// ── Day detail modal ─────────────────────────────────────────────────
// Opens when the user taps a cell in the month grid. Shows the planned
// workouts (AI plan or legacy) and any actual workouts for that day,
// reusing existing per-workout click handlers (openWorkoutModal,
// openPlanModal, openPlanWorkoutEdit) so the modal is fully functional
// without re-implementing the week-view interactions.
function openDayDetailModal(dayStr) {
  const ctx = _monthRenderCtx;
  if (!ctx) return;
  const modal = document.getElementById('day-detail-modal');
  const titleEl = document.getElementById('day-detail-title');
  const bodyEl = document.getElementById('day-detail-body');
  if (!modal || !bodyEl) return;

  const d = new Date(dayStr + 'T00:00:00');
  const dayNamesFull = ['Måndag','Tisdag','Onsdag','Torsdag','Fredag','Lördag','Söndag'];
  const monthShort = ['jan','feb','mar','apr','maj','jun','jul','aug','sep','okt','nov','dec'];
  const dow = (d.getDay() + 6) % 7;
  if (titleEl) titleEl.textContent = `${dayNamesFull[dow]} ${d.getDate()} ${monthShort[d.getMonth()]}`;

  const dayWorkouts = ctx.workouts.filter(w => w.workout_date === dayStr);
  const planForDay = ctx.planWorkouts.filter(pw => pw.workout_date === dayStr);

  // Legacy fallback (same logic as the cell renderer).
  let legacyForDay = [];
  if (planForDay.length === 0 && ctx.legacyPlans.length > 0) {
    const inActivePlan = _activePlan && dayStr >= _activePlan.start_date && dayStr <= _activePlan.end_date;
    if (!inActivePlan) {
      const lp = ctx.legacyPlans.find(p => p.day_of_week === dow);
      if (lp) legacyForDay = [lp];
    }
  }

  let html = '';

  // Planned section
  if (planForDay.length > 0 || legacyForDay.length > 0) {
    html += '<div class="day-detail-section-label">Planerat</div>';
    for (const pw of planForDay) {
      if (pw.is_rest) {
        html += '<div class="ddc-card ddc-rest"><div class="ddc-line">💤 Vilodag</div></div>';
      } else {
        const zoneBadge = pw.intensity_zone ? ` <span class="zone-badge zone-${pw.intensity_zone.toLowerCase()}">${pw.intensity_zone}</span>` : '';
        const mins = pw.duration_minutes ? ` · ${pw.duration_minutes} min` : '';
        const label = pw.label ? escapeHTML(pw.label) : escapeHTML(pw.activity_type || 'Pass');
        const desc = pw.description ? `<div class="ddc-desc">${escapeHTML(pw.description)}</div>` : '';
        const safe = JSON.stringify({ label: pw.label, description: pw.description, is_rest: pw.is_rest, day_of_week: pw.day_of_week, plan_workout_id: pw.id }).replace(/"/g, '&quot;');
        const clickAttr = ctx.isOwnSchema ? ` onclick="closeDayDetailModal();openPlanModal('${dayStr}', ${safe}, '${dayNamesFull[dow]}')" style="cursor:pointer;"` : '';
        html += `<div class="ddc-card"${clickAttr}><div class="ddc-line">${activityEmoji(pw.activity_type)} <strong>${label}</strong>${zoneBadge}${mins}</div>${desc}</div>`;
      }
    }
    for (const lp of legacyForDay) {
      const mins = lp.duration_minutes ? ` · ${lp.duration_minutes} min` : '';
      html += `<div class="ddc-card"><div class="ddc-line">${activityEmoji(lp.activity_type)} <strong>${escapeHTML(lp.title || lp.activity_type)}</strong>${mins}</div></div>`;
    }
  }

  // Actual section
  if (dayWorkouts.length > 0) {
    html += '<div class="day-detail-section-label">Genomfört</div>';
    for (const w of dayWorkouts) {
      const dist = w.distance_km ? ` · ${parseFloat(w.distance_km).toFixed(1)} km` : '';
      const mins = w.duration_minutes ? ` · ${w.duration_minutes}'` : '';
      const safe = JSON.stringify(w).replace(/"/g, '&quot;');
      html += `<div class="ddc-card" onclick="closeDayDetailModal();openWorkoutModal(${safe})" style="cursor:pointer;"><div class="ddc-line">${activityEmoji(w.activity_type)} <strong>${escapeHTML(w.activity_type)}</strong>${dist}${mins}</div></div>`;
    }
  }

  if (!html) html = '<div class="day-detail-empty">Inget pass den här dagen.</div>';

  bodyEl.innerHTML = html;
  modal.classList.remove('hidden');
}

function closeDayDetailModal() {
  const modal = document.getElementById('day-detail-modal');
  if (modal) modal.classList.add('hidden');
}

// ── Calendar Strip ──
const CAL_DAY_LETTERS = ['M', 'T', 'O', 'T', 'F', 'L', 'S'];

function schemaWeekPrev() {
  if (_schemaView === 'month') { schemaMonthPrev(); return; }
  const now = new Date();
  const currentMonday = mondayOfWeek(now);
  const targetMonday = addDays(currentMonday, (schemaWeekOffset - 1) * 7);
  const minMonday = new Date(P1_START);
  if (targetMonday < minMonday) return;
  schemaWeekOffset--;
  _calStripWorkouts = null;
  loadSchema();
}
function schemaWeekNext() {
  if (_schemaView === 'month') { schemaMonthNext(); return; }
  schemaWeekOffset++; _calStripWorkouts = null; loadSchema();
}
function schemaWeekToday() {
  if (_schemaView === 'month') { schemaMonthToday(); return; }
  schemaWeekOffset = 0; _calStripWorkouts = null; loadSchema();
}

// Month-view nav. Offsets count whole calendar months relative to "today's
// month" so 0 = current month, -1 = previous month, etc.
function schemaMonthPrev() {
  const minMonday = new Date(P1_START);
  const target = _monthStartFromOffset(schemaMonthOffset - 1);
  // Don't navigate before the first available period.
  const monthEnd = new Date(target.getFullYear(), target.getMonth() + 1, 0);
  if (monthEnd < minMonday) return;
  schemaMonthOffset--;
  _calStripWorkouts = null;
  loadSchema();
}
function schemaMonthNext() { schemaMonthOffset++; _calStripWorkouts = null; loadSchema(); }
function schemaMonthToday() { schemaMonthOffset = 0; _calStripWorkouts = null; loadSchema(); }

function _monthStartFromOffset(offset) {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + offset, 1);
}

// Switches between the week and month view. Persists the choice so the user
// lands on the same view next time. Re-renders by calling loadSchema().
function setSchemaView(mode) {
  if (mode !== 'week' && mode !== 'month') return;
  if (_schemaView === mode) return;
  _schemaView = mode;
  try { localStorage.setItem('schema_view_mode', mode); } catch (_e) { /* private mode */ }
  // Sync pill UI immediately (don't wait for the next render).
  document.querySelectorAll('#schema-view-toggle .schema-view-pill').forEach((b) => {
    const active = b.dataset.view === mode;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  // Hide the "Idag" button until the new view's offset is computed in
  // _loadSchema; it will reappear automatically when offset !== 0.
  const todayBtn = document.getElementById('schema-today-btn');
  if (todayBtn) todayBtn.classList.add('hidden');
  // Manual edit mode is week-only. Drop it silently when switching to month.
  if (mode === 'month' && _schemaEditMode) {
    _schemaEditMode = false;
    _destroyScheduleSortable && _destroyScheduleSortable();
  }
  loadSchema();
}

function getWeekIndexInPeriod(monday) {
  const p1Start = new Date(P1_START);
  const p2Start = new Date(P2_START);
  const md = new Date(monday);
  let periodStart;
  if (md >= p2Start) periodStart = p2Start;
  else periodStart = p1Start;
  return Math.floor((md - periodStart) / (7 * 86400000));
}

function getBuildWeekIndex(weekIdx) {
  let build = 0;
  for (let i = 0; i < weekIdx; i++) {
    if ((i + 1) % 4 !== 0) build++;
  }
  return build;
}

function scaleDescription(desc, factor) {
  if (!desc || factor === 1) return desc;
  return desc
    .replace(/(\d+)([–\-])(\d+)(\s*km\b)(?!\s*[/)])/g, (_, lo, dash, hi, suffix) => {
      return Math.round(parseInt(lo) * factor) + dash + Math.round(parseInt(hi) * factor) + suffix;
    })
    .replace(/(?<!\d[–\-])(\d+)(\s*km\b)(?!\s*[/)])/g, (m, num, suffix, offset) => {
      if (desc.substring(Math.max(0, offset - 6), offset).match(/[:\d]\/$/)) return m;
      return Math.round(parseInt(num) * factor) + suffix;
    })
    .replace(/(\d+)([–\-])(\d+)(\s*min)\s*(cykel|stakmaskin|längdskidor)/gi, (_, lo, dash, hi, suffix, act) => {
      return Math.round(parseInt(lo) * factor) + dash + Math.round(parseInt(hi) * factor) + suffix + ' ' + act;
    });
}

function projectPlan(plan, weekIdx, isDeload) {
  if (!plan || plan.is_rest) return plan;
  const buildIdx = getBuildWeekIndex(weekIdx);
  const factor = isDeload ? 0.7 : Math.pow(1.08, buildIdx);
  const projected = { ...plan };
  projected.label = stripDayPrefix(plan.label);
  projected.description = scaleDescription(plan.description, factor);
  return projected;
}

function dedupPlanText(label, desc) {
  if (!desc || !label) return { label, desc };
  const lbl = label.toLowerCase().trim();
  const descLower = desc.toLowerCase();
  if (descLower.includes(lbl) || lbl === 'z2' || lbl === 'kvalitet') {
    return { label: null, desc };
  }
  return { label, desc };
}

function stripProgressionText(desc) {
  if (!desc) return desc;
  return desc
    .split(/(?<=[.!])\s+/)
    .filter(s => !/öka\s|per vecka|kommande|nästa vecka|progressi|bygg\s+upp|varje vecka/i.test(s))
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function estimateDurationFromDescription(description, storedMinutes) {
  if (!description) return storedMinutes || 0;
  const desc = description.toLowerCase();
  let total = 0;

  const intervalRe = /(\d+)\s*[×x]\s*(\d+)\s*min/g;
  const matched = new Set();
  let m;
  let lastReps = 0;
  while ((m = intervalRe.exec(desc)) !== null) {
    const reps = parseInt(m[1]);
    const dur = parseInt(m[2]);
    total += reps * dur;
    lastReps = reps;
    for (let i = m.index; i < m.index + m[0].length; i++) matched.add(i);
  }

  const plainRe = /(\d+)\s*min/g;
  while ((m = plainRe.exec(desc)) !== null) {
    let overlap = false;
    for (let i = m.index; i < m.index + m[0].length; i++) {
      if (matched.has(i)) { overlap = true; break; }
    }
    if (overlap) continue;
    const val = parseInt(m[1]);
    const after = desc.slice(m.index + m[0].length, m.index + m[0].length + 20);
    if (lastReps > 1 && /^\s*(vila|återhämtning|jogg|lugn|mellan|paus|rest)/i.test(after)) {
      total += val * (lastReps - 1);
    } else {
      total += val;
    }
  }

  return (total > 0 && total > (storedMinutes || 0)) ? total : (storedMinutes || 0);
}

function workoutScoreChip(w) {
  if (!w || w.activity_type === 'Vila' || !w.duration_minutes) return '';
  try {
    const raw = calcWorkoutEffort(w);
    if (!raw || raw <= 0) return '';
    const score = effortRawToDisplay(raw);
    let band = 'low';
    if (score >= 2.0) band = 'peak';
    else if (score >= 1.0) band = 'high';
    else if (score >= 0.5) band = 'med';
    const im = _intensityMultiplier(w);
    const title = `Belastning: ${score.toFixed(2)} (IM ${im.toFixed(2)})`;
    return `<span class="score-chip score-chip--${band}" title="${title}">Belastning ${score.toFixed(1)}</span>`;
  } catch (_) {
    return '';
  }
}

function buildWorkoutBody(w, opts = {}) {
  const { showMap = false, showScore = true } = opts;
  let text = '';

  const scoreChip = showScore ? workoutScoreChip(w) : '';
  text += `<div class="wo-label">${w.activity_type}`;
  if (w.intensity) text += ` <span class="intensity-badge">${w.intensity}</span>`;
  if (scoreChip) text += ` ${scoreChip}`;
  text += '</div>';

  const primary = [];
  if (w.duration_minutes) primary.push(`${w.duration_minutes} min`);
  if (w.distance_km) primary.push(`${w.distance_km} km`);
  if (primary.length) text += `<div class="wo-meta">${primary.join(' · ')}</div>`;

  const secondary = [];
  if (w.avg_hr) secondary.push(`\u2665 ${w.avg_hr} bpm`);
  if (w.elevation_gain_m) secondary.push(`\u25B2 ${Math.round(w.elevation_gain_m)} m`);
  if (w.avg_speed_kmh && w.activity_type === 'Löpning') {
    const pace = 60 / w.avg_speed_kmh;
    const pMin = Math.floor(pace);
    const pSec = String(Math.round((pace - pMin) * 60)).padStart(2, '0');
    secondary.push(`${pMin}:${pSec}/km`);
  }
  if (secondary.length) text += `<div class="wo-secondary">${secondary.join('  ')}</div>`;

  if (showMap && w.map_polyline) {
    return `<div class="wo-body-flex"><div class="wo-body-text">${text}</div><div class="wo-map wo-map-thumb" id="wo-map-${escapeHTML(w.id)}" data-polyline="${escapeHTML(w.map_polyline)}"></div></div>`;
  }

  return text;
}

function activityIcon(type) {
  const c = ACTIVITY_COLORS[type] || 'var(--accent)';
  const letter = (type || '?')[0].toUpperCase();
  return `<div class="sr-activity-icon" style="background:${c}22;color:${c}">${letter}</div>`;
}

function renderSchema(workouts, plans, monday, isDeload, invitations, isOwnSchema, profile) {
  invitations = invitations || [];
  const container = document.getElementById('schema-content');
  const todayStr = isoDate(new Date());
  const weekIdx = getWeekIndexInPeriod(monday);
  const profileId = profile?.id || currentProfile?.id;

  let html = '';
  for (let i = 0; i < 7; i++) {
    const dayDate = addDays(monday, i);
    const dayStr = isoDate(dayDate);
    const basePlan = plans.find(p => p.day_of_week === i);
    const plan = projectPlan(basePlan, weekIdx, isDeload);
    const dayWorkouts = workouts.filter(w => w.workout_date === dayStr);
    const isToday = dayStr === todayStr;
    const isFuture = dayDate > new Date();

    const dayInvs = invitations.filter(inv => inv.workout_date === dayStr);
    const acceptedInv = dayInvs.find(inv => inv.status === 'accepted');
    const pendingInv = dayInvs.find(inv => inv.status === 'pending');

    let statusClass = 'future';
    if (dayWorkouts.length > 0) statusClass = 'done';
    else if (plan?.is_rest) statusClass = 'rest';
    else if (!isFuture) statusClass = 'missed';

    let planText = '';
    if (acceptedInv) {
      const partnerId = acceptedInv.sender_id === profileId ? acceptedInv.receiver_id : acceptedInv.sender_id;
      const partner = allProfiles.find(p => p.id === partnerId);
      const initials = partner ? partner.name.split(' ').map(n => n[0]).join('').toUpperCase() : '?';
      planText = `<span class="shared-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>${initials}</span> `;
      planText += acceptedInv.description || acceptedInv.activity_type;
    } else if (plan?.is_rest) {
      planText = '<span class="sr-rest-label">Vila</span>';
    } else if (plan) {
      const lbl = plan.label || '';
      const desc = stripProgressionText(plan.description || '');
      const kmMatch = desc.match(/(\d+(?:[–\-]\d+)?)\s*km/);
      const kmStr = kmMatch ? kmMatch[1] + ' km' : '';
      if (lbl && desc) {
        planText = `<div class="sr-plan-label">${lbl}${kmStr ? `<span class="sr-km-badge">${kmStr}</span>` : ''}</div><div class="sr-plan-desc">${desc}</div>`;
      } else {
        planText = desc || lbl;
      }
    }

    if (pendingInv && !acceptedInv) {
      const isSender = pendingInv.sender_id === profileId;
      planText += isSender
        ? ' <span class="invite-pending-badge">Inbjudan skickad</span>'
        : ' <span class="invite-pending-badge">Inbjudan mottagen</span>';
    }

    let mainContent = '';
    if (dayWorkouts.length > 0) {
      mainContent = dayWorkouts.map(w => {
        return `<div class="clickable-workout" onclick='openWorkoutModal(${JSON.stringify(w).replace(/'/g, "&#39;")})'>
          ${buildWorkoutBody(w)}
        </div>`;
      }).join('');
    } else {
      mainContent = `<div class="sr-plan-text">${planText}</div>`;
    }

    let rightContent = '';
    if (statusClass === 'missed') {
      rightContent = '<div class="sr-missed-mark">Missat</div>';
    }

    const canClick = isOwnSchema && (isFuture || isToday) && !plan?.is_rest && dayWorkouts.length === 0;
    const clickAttr = canClick ? ` onclick="openPlanModal('${dayStr}', ${JSON.stringify(plan || {}).replace(/"/g, '&quot;')}, '${DAY_NAMES_FULL[i]}')" style="cursor:pointer;"` : '';

    html += `<div class="sr-card${isToday ? ' sr-today' : ''} sr-${statusClass}"${clickAttr}>
      <div class="sr-left">
        <div class="sr-day">${DAY_NAMES[i]}</div>
        <div class="sr-date">${dayDate.getDate()}/${dayDate.getMonth() + 1}</div>
      </div>
      <div class="sr-main">
        ${mainContent}
      </div>
      <div class="sr-right-status">${rightContent}</div>
    </div>`;
  }

  container.innerHTML = html;
  requestAnimationFrame(() => initMapThumbnails());
}

// Empty state shown in the week view when the user has no AI plan and is
// not part of the original training group (so the legacy `period_plans`
// fallback shouldn't apply). The CTA opens the plan wizard.
function renderSchemaEmpty(_monday, _sunday) {
  const container = document.getElementById('schema-content');
  if (!container) return;
  container.innerHTML = `
    <div class="card schema-empty-state">
      <div class="schema-empty-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="40" height="40">
          <rect x="3" y="4" width="18" height="18" rx="2"/>
          <line x1="16" y1="2" x2="16" y2="6"/>
          <line x1="8" y1="2" x2="8" y2="6"/>
          <line x1="3" y1="10" x2="21" y2="10"/>
        </svg>
      </div>
      <h3 class="schema-empty-title">Du har inget träningsschema än</h3>
      <p class="schema-empty-body">Skapa ditt första schema så bygger vi en plan som matchar ditt mål, din tid och din nuvarande nivå.</p>
      <button type="button" class="schema-empty-cta" onclick="openPlanWizard()">
        Skapa ditt första schema
      </button>
    </div>`;
}

// ── AI Plan Schema Renderer ──

// State for drag-and-drop schedule swapping. Captured by renderSchemaPlan so
// the Sortable handler can resolve indexes back to plan_workouts rows.
let _schemaDndState = null;

// ─────────────────────────────────────────────────────────────
//  Greedy pairing of planned and logged workouts on the same day.
//  Returns { planMatched: Map<planId, loggedId>, loggedMatched: Set<loggedId> }.
//  Matching rule: same activity_type, in plan sort_order order. Loose pair —
//  no FK between workouts and plan_workouts.
// ─────────────────────────────────────────────────────────────
function _pairPlanAndLogged(planList, loggedList) {
  const planMatched = new Map();
  const loggedMatched = new Set();
  const remainingLogged = loggedList.slice();
  for (const pw of planList) {
    if (pw.is_rest) continue;
    const idx = remainingLogged.findIndex(w => (w.activity_type || '') === (pw.activity_type || ''));
    if (idx >= 0) {
      const matched = remainingLogged.splice(idx, 1)[0];
      planMatched.set(pw.id, matched.id);
      loggedMatched.add(matched.id);
    }
  }
  return { planMatched, loggedMatched };
}

// Build a single plan_workout's HTML inside the PLAN zone.
function _renderPlanCard(planWo, opts) {
  const { canDrag, isOwnSchema, isFuture, isToday, statusPill, dayOfWeek, dayStr } = opts;

  const dragHandle = canDrag
    ? '<div class="sr-drag-handle" aria-label="Dra för att flytta" title="Dra för att flytta passet"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg></div>'
    : '';

  const editable = _schemaEditMode && planWo && !planWo.is_rest;
  const clickAttr = editable
    ? ` onclick="openPlanWorkoutEdit(${escapeHTML(JSON.stringify(planWo)).replace(/"/g, '&quot;')})" style="cursor:pointer;"`
    : (isOwnSchema && (isFuture || isToday) && !planWo.is_rest
        ? ` onclick="openPlanModal('${dayStr}', ${JSON.stringify({ label: planWo.label, description: planWo.description, is_rest: planWo.is_rest, day_of_week: planWo.day_of_week, plan_workout_id: planWo.id }).replace(/"/g, '&quot;')}, '${DAY_NAMES_FULL[dayOfWeek]}')" style="cursor:pointer;"`
        : '');

  const isAssessmentWorkout = !planWo.is_rest && typeof planWo.label === 'string' && /^Bedömning/i.test(planWo.label);

  let body;
  if (planWo.is_rest) {
    body = '<div class="sr-plan-label sr-rest-label">Vila</div>';
  } else {
    const zoneBadge = planWo.intensity_zone
      ? ` <span class="zone-badge zone-${planWo.intensity_zone.toLowerCase()}">${planWo.intensity_zone}</span>`
      : '';
    const testBadge = isAssessmentWorkout ? ` <span class="day-badge--test">TEST</span>` : '';
    const lbl = planWo.label || planWo.activity_type || 'Pass';
    const desc = stripProgressionText(planWo.description || '');
    const estMin = estimateDurationFromDescription(planWo.description, planWo.target_duration_minutes);
    const durStr = estMin > 0 ? `${estMin} min` : '';
    const meta = (estMin > 0 || planWo.target_distance_km)
      ? `<span class="sr-target">${durStr}${planWo.target_distance_km ? (durStr ? ' · ' : '') + planWo.target_distance_km + ' km' : ''}</span>`
      : '';
    body = `<div class="sr-plan-label">${lbl}${zoneBadge}${testBadge} ${meta}</div>`;
    if (desc) body += `<div class="sr-plan-desc">${desc}</div>`;
  }

  const dndAttrs = canDrag
    ? ` data-day-of-week="${dayOfWeek}" data-plan-workout-id="${planWo.id}" data-sort-order="${planWo.sort_order ?? 0}"`
    : ` data-day-of-week="${dayOfWeek}" data-sort-order="${planWo.sort_order ?? 0}"`;

  return `<div class="sr-pass-card sr-pass-plan${canDrag ? ' sr-draggable' : ''}${planWo.is_rest ? ' sr-pass-rest' : ''}${isAssessmentWorkout ? ' sr-pass-assessment' : ''}"${dndAttrs}${clickAttr}>
    <div class="sr-pass-body">${body}${statusPill || ''}</div>
    ${dragHandle}
  </div>`;
}

function renderSchemaPlan(workouts, planWorkouts, monday, invitations, isOwnSchema, profile, phase) {
  invitations = invitations || [];
  const container = document.getElementById('schema-content');
  const todayStr = isoDate(new Date());
  const profileId = profile?.id || currentProfile?.id;
  const isAssessmentWeek = phase === 'assessment';

  let html = '';
  if (isAssessmentWeek) {
    html += `<div class="assessment-banner schema-assessment-banner">
      <span class="ab-icon" aria-hidden="true">⚑</span>
      <span class="ab-text"><strong>Bedömningsvecka.</strong> Tre testpass kalibrerar puls, tröskel och 5&nbsp;km — resterande veckor anpassas efter resultaten.</span>
    </div>`;
  }
  for (let i = 0; i < 7; i++) {
    const dayDate = addDays(monday, i);
    const dayStr = isoDate(dayDate);
    const dayWorkouts = workouts.filter(w => w.workout_date === dayStr);
    const dayPlans = planWorkouts
      .filter(pw => pw.day_of_week === i)
      .slice()
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    const isToday = dayStr === todayStr;
    const isFuture = dayDate > new Date();
    const isPast = !isFuture && !isToday;

    const dayInvs = invitations.filter(inv => inv.workout_date === dayStr);
    const acceptedInv = dayInvs.find(inv => inv.status === 'accepted');
    const pendingInv = dayInvs.find(inv => inv.status === 'pending');

    // Pair plan vs logged for status pill computation.
    const { planMatched, loggedMatched } = _pairPlanAndLogged(dayPlans, dayWorkouts);
    const nonRestPlans = dayPlans.filter(p => !p.is_rest);
    const allRest = dayPlans.length > 0 && nonRestPlans.length === 0;
    const anyMissed = nonRestPlans.some(p => !planMatched.has(p.id));
    const anyMatched = nonRestPlans.some(p => planMatched.has(p.id));

    // Day-level status (used for outer card chrome / today highlight).
    let statusClass = 'future';
    if (allRest) statusClass = 'rest';
    else if (nonRestPlans.length === 0 && dayWorkouts.length > 0) statusClass = 'done';
    else if (nonRestPlans.length > 0 && !anyMissed) statusClass = 'done';
    else if (isPast && anyMissed) statusClass = 'missed';
    else if (isToday && anyMatched) statusClass = 'done';

    // Build PLAN zone — one card per plan_workout (or a placeholder).
    const planCardsHtml = dayPlans.length === 0
      ? (acceptedInv
          ? `<div class="sr-pass-card sr-pass-shared"><div class="sr-pass-body">${(() => {
              const partnerId = acceptedInv.sender_id === profileId ? acceptedInv.receiver_id : acceptedInv.sender_id;
              const partner = allProfiles.find(p => p.id === partnerId);
              const initials = partner ? partner.name.split(' ').map(n => n[0]).join('').toUpperCase() : '?';
              const text = acceptedInv.description || acceptedInv.activity_type;
              return `<span class="shared-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>${initials}</span> ${text}`;
            })()}</div></div>`
          : '<div class="sr-pass-empty">Ingen plan</div>')
      : dayPlans.map(planWo => {
          const isMatched = planMatched.has(planWo.id);
          let statusPill = '';
          if (planWo.is_rest) {
            statusPill = '<span class="sr-pill sr-pill--rest">Vila</span>';
          } else if (isMatched) {
            statusPill = '<span class="sr-pill sr-pill--matched">Gjort</span>';
          } else if (isPast) {
            statusPill = '<span class="sr-pill sr-pill--missed">Missat</span>';
          } else if (isToday) {
            statusPill = '<span class="sr-pill sr-pill--planned">Idag</span>';
          } else {
            statusPill = '<span class="sr-pill sr-pill--planned">Planerat</span>';
          }
          const canDrag = isOwnSchema && _schemaEditMode;
          return _renderPlanCard(planWo, {
            canDrag, isOwnSchema, isFuture, isToday, statusPill,
            dayOfWeek: i, dayStr,
          });
        }).join('');

    // Build ACTUAL (Gjort) zone — only render if there's anything logged.
    const actualCardsHtml = dayWorkouts.length === 0
      ? ''
      : dayWorkouts.map(w => {
          const isExtra = !loggedMatched.has(w.id) && nonRestPlans.length > 0;
          const extraPill = isExtra ? '<span class="sr-pill sr-pill--extra">Extra</span>' : '';
          return `<div class="sr-pass-card sr-pass-actual" onclick='openWorkoutModal(${JSON.stringify(w).replace(/'/g, "&#39;")})' style="cursor:pointer;">
            <div class="sr-pass-body">${buildWorkoutBody(w)}${extraPill}</div>
          </div>`;
        }).join('');

    const inviteBadge = (pendingInv && !acceptedInv)
      ? (pendingInv.sender_id === profileId
          ? '<span class="invite-pending-badge">Inbjudan skickad</span>'
          : '<span class="invite-pending-badge">Inbjudan mottagen</span>')
      : '';

    html += `<div class="sr-card${isToday ? ' sr-today' : ''}${_schemaEditMode ? ' sr-edit-mode' : ''} sr-${statusClass}" data-day-of-week="${i}">
      <div class="sr-left">
        <div class="sr-day">${DAY_NAMES[i]}</div>
        <div class="sr-date">${dayDate.getDate()}/${dayDate.getMonth() + 1}</div>
      </div>
      <div class="sr-main">
        <div class="sr-zones">
          <div class="sr-plan-zone" data-day-of-week="${i}">
            ${planCardsHtml}
          </div>
          <div class="sr-actual-zone${actualCardsHtml ? '' : ' sr-actual-zone--empty'}">
            <div class="sr-zone-label">Gjort</div>
            ${actualCardsHtml}
          </div>
          ${inviteBadge ? `<div class="sr-invite-row">${inviteBadge}</div>` : ''}
        </div>
      </div>
    </div>`;
  }

  container.innerHTML = html;
  requestAnimationFrame(() => initMapThumbnails());

  // Bind / rebind drag-and-drop after every render. State carries the plan
  // context needed to map dropped DOM positions back to plan_workouts rows.
  // Drag-and-drop is only active in manual edit mode.
  if (isOwnSchema && _schemaEditMode) {
    _schemaDndState = {
      planWorkouts: planWorkouts.slice(),
      planWeekId: planWorkouts[0]?.plan_week_id || null,
      monday: isoDate(monday),
    };
    _initScheduleSortable();
  } else {
    _schemaDndState = null;
    _destroyScheduleSortable();
  }
}

// ─────────────────────────────────────────────────────────────
//  Schedule drag-and-drop: move a single plan_workout to another day or
//  another slot within the same day. Talks to the move-plan-workout edge
//  function which atomically updates day_of_week, sort_order and recomputes
//  workout_date for the row.
// ─────────────────────────────────────────────────────────────

let _scheduleSortableInstances = [];

function _destroyScheduleSortable() {
  for (const inst of _scheduleSortableInstances) {
    try { inst.destroy(); } catch (_) { /* noop */ }
  }
  _scheduleSortableInstances = [];
}

function _initScheduleSortable() {
  _destroyScheduleSortable();
  if (typeof Sortable === 'undefined') {
    console.warn('SortableJS not loaded — schedule drag disabled');
    return;
  }
  const zones = document.querySelectorAll('#schema-content .sr-plan-zone');
  zones.forEach(zone => {
    const inst = Sortable.create(zone, {
      group: 'schedule-plans',
      animation: 150,
      handle: '.sr-drag-handle',
      draggable: '.sr-draggable',
      ghostClass: 'sr-card-ghost',
      chosenClass: 'sr-card-chosen',
      dragClass: 'sr-card-drag',
      delay: 120,
      delayOnTouchOnly: true,
      touchStartThreshold: 4,
      onEnd: handleScheduleMove,
    });
    _scheduleSortableInstances.push(inst);
  });
}

async function handleScheduleMove(evt) {
  const state = _schemaDndState;
  if (!state) return;

  const item = evt.item;
  const planWorkoutId = item?.dataset?.planWorkoutId;
  const toZone = evt.to;
  const toDow = toZone ? Number(toZone.dataset?.dayOfWeek) : NaN;
  const newIndex = typeof evt.newDraggableIndex === 'number' ? evt.newDraggableIndex : evt.newIndex;
  const fromDow = evt.from ? Number(evt.from.dataset?.dayOfWeek) : NaN;
  const oldIndex = typeof evt.oldDraggableIndex === 'number' ? evt.oldDraggableIndex : evt.oldIndex;

  if (!planWorkoutId || Number.isNaN(toDow)) {
    await _loadSchema();
    return;
  }

  // Same zone, same slot → no-op.
  if (fromDow === toDow && oldIndex === newIndex) {
    return;
  }

  showToast('Sparar...', 1200);

  try {
    const session = (await sb.auth.getSession()).data.session;
    if (!session) throw new Error('not logged in');
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/move-plan-workout`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'apikey': SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        plan_workout_id: planWorkoutId,
        to_day_of_week: toDow,
        to_sort_order: newIndex,
      }),
    });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${txt.substring(0, 200)}`);
    }
    showToast('Pass flyttat');
  } catch (e) {
    console.error('move-plan-workout failed', e);
    showToast('Kunde inte spara — försök igen');
  }

  await _loadSchema();
}

// ═══════════════════════
//  WORKOUT INVITATIONS
// ═══════════════════════
let _pendingInvitePlan = null;
let _inviteTargetDate = null;
let _inviteSelectedUser = null;

async function fetchInvitationsForWeek(profileId, startDate, endDate) {
  if (!profileId) return [];
  try {
    const { data } = await sb.from('workout_invitations')
      .select('*')
      .or(`sender_id.eq.${profileId},receiver_id.eq.${profileId}`)
      .gte('workout_date', startDate)
      .lte('workout_date', endDate);
    return data || [];
  } catch (e) {
    console.error('Fetch invitations error:', e);
    return [];
  }
}

function openPlanModal(dateStr, plan, dayName) {
  _inviteTargetDate = dateStr;
  _pendingInvitePlan = plan;

  const d = new Date(dateStr);
  const dateLabel = `${dayName} ${d.getDate()}/${d.getMonth() + 1}`;
  document.getElementById('pm-title').textContent = dateLabel;

  let body = '';
  if (plan && plan.label) {
    body += `<div class="modal-detail-row"><span class="mdr-label">Aktivitet</span><span class="mdr-value">${escapeHTML(stripDayPrefix(plan.label))}</span></div>`;
  }
  if (plan && plan.description) {
    body += `<div class="modal-detail-row"><span class="mdr-label">Beskrivning</span><span class="mdr-value">${escapeHTML(plan.description)}</span></div>`;
  }
  if (!plan || (!plan.label && !plan.description)) {
    body += '<div class="text-dim" style="padding:8px 0;">Inget planerat pass</div>';
  }

  document.getElementById('pm-body').innerHTML = body;
  document.getElementById('pm-actions').innerHTML =
    `<button class="btn btn-primary btn-sm" onclick="openInvitePicker()">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16" style="vertical-align:-3px;margin-right:4px;"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>
      Bjud in
    </button>`;

  document.getElementById('plan-modal').classList.remove('hidden');
}

function closePlanModal() {
  document.getElementById('plan-modal').classList.add('hidden');
  _pendingInvitePlan = null;
  _inviteTargetDate = null;
}

function openInvitePicker() {
  try {
    closePlanModal();
    _inviteSelectedUser = null;
    document.getElementById('invite-form').classList.add('hidden');
    document.getElementById('invite-search').value = '';
    document.getElementById('invite-search').classList.remove('hidden');
    renderInviteUserList('');
    document.getElementById('invite-picker').classList.remove('hidden');
    setTimeout(() => document.getElementById('invite-search').focus(), 100);
  } catch (e) {
    console.error('openInvitePicker error:', e);
    showAlertModal('Fel', 'Kunde inte öppna inbjudan. Försök igen.');
  }
}

function closeInvitePicker() {
  document.getElementById('invite-picker').classList.add('hidden');
  _inviteSelectedUser = null;
}

function filterInviteUsers() {
  const q = document.getElementById('invite-search').value;
  renderInviteUserList(q);
}

function renderInviteUserList(query) {
  const q = query.toLowerCase().trim();
  const users = allProfiles.filter(p => p.id !== currentProfile.id && (!q || p.name.toLowerCase().includes(q)));
  const listEl = document.getElementById('invite-user-list');

  if (users.length === 0) {
    listEl.innerHTML = '<div class="text-dim" style="padding:12px;">Inga användare hittades</div>';
    return;
  }

  listEl.innerHTML = users.map(p => {
    const initials = p.name.split(' ').map(n => n[0]).join('').toUpperCase();
    return `<div class="invite-user-row" onclick="selectInviteUser('${escapeHTML(p.id)}')">
      <div class="invite-user-avatar">${escapeHTML(initials)}</div>
      <div class="invite-user-name">${escapeHTML(p.name)}</div>
    </div>`;
  }).join('');
}

function selectInviteUser(userId) {
  _inviteSelectedUser = allProfiles.find(p => p.id === userId);
  if (!_inviteSelectedUser) return;

  document.getElementById('invite-user-list').innerHTML =
    `<div class="invite-user-row selected">
      <div class="invite-user-avatar">${escapeHTML(_inviteSelectedUser.name.split(' ').map(n => n[0]).join('').toUpperCase())}</div>
      <div class="invite-user-name">${escapeHTML(_inviteSelectedUser.name)}</div>
      <span class="invite-check">&#10003;</span>
    </div>`;
  document.getElementById('invite-search').classList.add('hidden');

  const plan = _pendingInvitePlan || {};
  const label = plan.label ? stripDayPrefix(plan.label) : '';
  document.getElementById('invite-activity').value = label || '';
  document.getElementById('invite-duration').value = parseDuration(plan.description) || '';
  document.getElementById('invite-intensity').value = parseIntensity(plan.description || plan.label) || '';
  document.getElementById('invite-desc').value = plan.description || '';
  document.getElementById('invite-form').classList.remove('hidden');
}

function parseDuration(desc) {
  if (!desc) return '';
  const m = desc.match(/(\d+)\s*min/);
  return m ? m[1] : '';
}

function parseIntensity(text) {
  if (!text) return '';
  const m = text.match(/Z\d/i);
  return m ? m[0].toUpperCase() : '';
}

async function confirmSendInvitation() {
  if (!_inviteSelectedUser || !_inviteTargetDate) return;

  const activity = document.getElementById('invite-activity').value.trim();
  if (!activity) {
    await showAlertModal('Saknas', 'Fyll i aktivitetstyp.');
    return;
  }

  const dur = parseInt(document.getElementById('invite-duration').value) || null;
  const intensity = document.getElementById('invite-intensity').value.trim() || null;
  const desc = document.getElementById('invite-desc').value.trim() || null;

  try {
    const { error } = await sb.from('workout_invitations').insert({
      sender_id: currentProfile.id,
      receiver_id: _inviteSelectedUser.id,
      workout_date: _inviteTargetDate,
      activity_type: activity,
      duration_minutes: dur,
      intensity: intensity,
      description: desc,
      status: 'pending'
    });
    if (error) throw error;

    const dateObj = new Date(_inviteTargetDate);
    const dateLabel = `${dateObj.getDate()}/${dateObj.getMonth() + 1}`;
    await sb.from('nudges').insert({
      sender_id: currentProfile.id,
      receiver_id: _inviteSelectedUser.id,
      message: `${currentProfile.name} bjöd in dig till ${activity} den ${dateLabel}`,
      type: 'invitation',
      reference_id: null
    });

    closeInvitePicker();
    await showAlertModal('Skickat', `Inbjudan skickad till ${_inviteSelectedUser.name}!`);
    loadSchema();
  } catch (e) {
    console.error('Send invitation error:', e);
    if (e.code === '23505') {
      await showAlertModal('Redan skickat', 'Du har redan bjudit in denna person till pass den dagen.');
    } else {
      await showAlertModal('Fel', 'Kunde inte skicka inbjudan. Försök igen.');
    }
  }
}

async function respondToInvitation(invitationId, accept) {
  const newStatus = accept ? 'accepted' : 'declined';
  try {
    const { data: inv, error: fetchErr } = await sb.from('workout_invitations')
      .select('*').eq('id', invitationId).single();
    if (fetchErr) throw fetchErr;

    const { error } = await sb.from('workout_invitations')
      .update({ status: newStatus }).eq('id', invitationId);
    if (error) throw error;

    const sender = allProfiles.find(p => p.id === inv.sender_id);
    const senderName = sender ? sender.name : 'Någon';
    const receiverName = currentProfile.name;
    const dateObj = new Date(inv.workout_date);
    const dateLabel = `${dateObj.getDate()}/${dateObj.getMonth() + 1}`;

    if (accept) {
      await sb.from('nudges').insert({
        sender_id: currentProfile.id,
        receiver_id: inv.sender_id,
        message: `${receiverName} accepterade din inbjudan till ${inv.activity_type} den ${dateLabel}`,
        type: 'invitation_accepted',
        reference_id: invitationId
      });
    } else {
      await sb.from('nudges').insert({
        sender_id: currentProfile.id,
        receiver_id: inv.sender_id,
        message: `${receiverName} avböjde din inbjudan till ${inv.activity_type} den ${dateLabel}`,
        type: 'invitation_declined',
        reference_id: invitationId
      });
    }

    await loadNudges();
    updateNudgeBadge();
    if (currentView === 'dashboard') loadSchema();
  } catch (e) {
    console.error('Invitation response error:', e);
    await showAlertModal('Fel', 'Kunde inte svara på inbjudan.');
  }
}

// ═══════════════════════
//  TRENDS (Personal)
// ═══════════════════════
let chartMixPersonal = null;
let effortMode = 'absolute';
// Sprint 2: Progress sub-tabs (Allmän / Dina mål / Aktiviteter).
// Default = allmän. Persisted in-memory only — leaving and returning to
// the Progress view resets to default, which is the right behaviour for
// the "primary signals first" mental model.
let _progressSubtab = 'allman';
function setProgressSubtab(id) {
  if (!['allman', 'mal', 'aktiviteter'].includes(id)) return;
  _progressSubtab = id;
  document.querySelectorAll('.progress-subnav-btn').forEach((btn) => {
    const isActive = btn.id === `progress-subtab-${id}-btn`;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
  document.querySelectorAll('.progress-subtab').forEach((el) => {
    const isActive = el.id === `progress-subtab-${id}`;
    el.classList.toggle('active', isActive);
    if (isActive) el.removeAttribute('hidden');
    else el.setAttribute('hidden', '');
  });
}

// Group sub-tabs: Progress (default) and Aktiviteter (the social feed).
// Persisted in localStorage so users land back where they left. The feed is
// lazy-rendered the first time the user lands on the Aktiviteter tab in a
// session — initial group load only paints the Progress cards so opening
// Grupp stays fast even on big groups.
let _groupSubtab = 'progress';
let _groupFeedRenderedOnce = false;
function setGroupSubtab(id) {
  if (!['progress', 'aktiviteter'].includes(id)) return;
  _groupSubtab = id;
  try { localStorage.setItem('group:subtab', id); } catch (e) { /* ignore */ }
  document.querySelectorAll('#group-has-group .progress-subnav-btn').forEach((btn) => {
    const isActive = btn.id === `group-subtab-${id}-btn`;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
  document.querySelectorAll('#group-has-group .progress-subtab').forEach((el) => {
    const isActive = el.id === `group-subtab-${id}`;
    el.classList.toggle('active', isActive);
    if (isActive) el.removeAttribute('hidden');
    else el.setAttribute('hidden', '');
  });
  // Lazy-render the feed the first time someone opens Aktiviteter.
  if (id === 'aktiviteter' && !_groupFeedRenderedOnce && _cachedGroupWorkouts.length && _cachedGroupMembers.length) {
    _groupFeedRenderedOnce = true;
    renderGroupFeed(_cachedGroupWorkouts, _cachedGroupMembers);
  }
}

let _mixUnit = 'hours';

function setTrendMode(mode) { trendMode = mode; loadTrends(); }
function setEffortMode(mode) { effortMode = mode; loadTrends(); }
function setMixUnit(unit) {
  _mixUnit = unit;
  // Sprint 2: combined Aktivitetsmix card has both per-week stacked bar
  // and lifetime per-activity totals, controlled by the same Tid/Distans
  // toggle. Keep them in sync here so we don't need a second control.
  _seasonBarMode = unit;
  // Sprint follow-up: Sasongstotaler-kortet i Allmän progress har nu sin
  // egen Tid/Distans-toggle. Synka båda så att de aldrig drar isär — den
  // ena kan klickas, den andra ska följa med visuellt.
  const isKm = unit === 'km';
  const t1 = document.querySelector('#mix-unit-toggle input');
  const t2 = document.querySelector('#season-bars-unit-toggle input');
  if (t1) t1.checked = isKm;
  if (t2) t2.checked = isKm;
  loadTrends();
}

async function loadTrends() {
  if (!currentProfile) return;
  // One-time effort recalibration nudge after IM range fix (Sprint 1.3).
  // Older weekly bars will look slightly different — let the user know once.
  try {
    if (!localStorage.getItem('nvdp_im_recalib_v1')) {
      showToast('Vi har kalibrerat belastnings­skalan — äldre veckor kan se lite annorlunda ut.');
      localStorage.setItem('nvdp_im_recalib_v1', '1');
    }
  } catch (_) { /* ignore */ }
  document.querySelectorAll('#view-trends .chart-skeleton').forEach(el => el.classList.add('active'));
  showViewLoading('view-trends');
  try { await _loadTrends(); } catch (e) { console.error('Trends error:', e); }
  finally {
    hideViewLoading('view-trends');
    document.querySelectorAll('#view-trends .chart-skeleton').forEach(el => el.classList.remove('active'));
  }
  // Sprint 2: weekly check-in history moved from Progress to the Coach
  // history drawer (see openCoachHistory). Nothing to render here anymore.
}
async function _loadTrends() {
  const myWorkouts = await fetchWorkouts(currentProfile.id);
  if (myWorkouts.length === 0) {
    document.querySelector('#view-trends .page-header p').textContent = 'Inga pass loggade ännu';
    return;
  }

  const isNorm = effortMode === 'normalized';
  const weeklyTitleEl = document.getElementById('trends-weekly-title');
  if (weeklyTitleEl) {
    weeklyTitleEl.textContent = isNorm ? 'Belastning per vecka' : 'Timmar per vecka';
  }
  // mix title is set later when chart renders (respects _mixUnit toggle)

  // Week summary card moved to dashboard - clear here to avoid duplication
  const deltaEl = document.getElementById('volume-delta');
  if (deltaEl) deltaEl.innerHTML = '';
  const wsCard = document.getElementById('weekly-summary-card');
  if (wsCard) wsCard.classList.add('hidden');

  // Activity mix stacked bar (extracted so the 12-week navigator can re-render
  // it without re-fetching workouts).
  renderMixChart(myWorkouts);

  // Season totals: summary card + horizontal bar charts
  renderSeasonTotals(myWorkouts);

  // Sprint 2: "Den här veckan" — quick week-vs-prev-week stats card at the
  // top of Allmän progress.
  renderProgressWeekSummary(myWorkouts);

  // Sprint 4: Goals (Dina mål sub-tab). Runs in parallel with the rest of
  // the chart rendering so the sub-tab is populated the first time the user
  // clicks it without needing a re-fetch.
  loadGoals(myWorkouts).catch((e) => console.warn('Goals load failed:', e));

  // Effort per week chart
  renderEffortChart(myWorkouts);

  // Personal fitness score (CTL trend vs day-28 baseline)
  renderPmcChart(myWorkouts);

  // Polarization (senaste 4 v) + easy-pace HR trend
  renderPolarizationCard(myWorkouts);
  renderEasyHrChart(myWorkouts);
  renderVo2maxChart(myWorkouts);

  // Weekly summary + recent workouts (moved from dashboard)
  const now2 = new Date();
  const monday2 = mondayOfWeek(now2);
  const sunday2 = addDays(monday2, 6);
  const weekWorkouts2 = await fetchWorkouts(currentProfile.id, isoDate(monday2), isoDate(sunday2));

  let weekPlanItems2 = [];
  if (PLAN_GENERATION_ENABLED) {
    if (!_activePlan) {
      _activePlan = await fetchActivePlan(currentProfile.id);
      if (_activePlan) _activePlanWeeks = await fetchPlanWeeks(_activePlan.id);
    }
    if (_activePlan) {
      const todayStr2 = isoDate(now2);
      if (todayStr2 >= _activePlan.start_date && todayStr2 <= _activePlan.end_date) {
        const pw = await fetchPlanWorkoutsByDate(_activePlan.id, isoDate(monday2), isoDate(sunday2));
        weekPlanItems2 = pw.map(p => ({ day_of_week: p.day_of_week, label: p.label || p.activity_type, description: p.description, is_rest: p.is_rest }));
      }
    }
  }
  if (weekPlanItems2.length === 0) {
    const periods = await fetchPeriods();
    const todayStr2 = isoDate(now2);
    const period = periods.find(p => todayStr2 >= p.start_date && todayStr2 <= p.end_date);
    if (period) {
      const plans = await fetchPlans(period.id);
      weekPlanItems2 = plans.map(p => ({ day_of_week: p.day_of_week, label: stripDayPrefix(p.label), description: p.description, is_rest: p.is_rest }));
    }
  }
  renderWeeklySummary(weekWorkouts2, weekPlanItems2, monday2, currentProfile);

  const { data: recent } = await sb.from('workouts').select('*')
    .eq('profile_id', currentProfile.id)
    .order('workout_date', { ascending: false });

  const recentEl = document.getElementById('recent-workouts');
  if (!recent || recent.length === 0) {
    recentEl.innerHTML = '<div class="empty-state"><div class="icon">&#127939;</div><p>Inga pass loggade ännu</p></div>';
  } else {
    _recentWorkouts = recent;
    _recentShown = 0;
    recentEl.innerHTML = '';
    showMoreRecent();
  }
}

// ── MET-based effort scoring (Ainsworth Compendium 2011) ──
// WorkoutScore = Duration_min × MET(sport, speed) × ElevationFactor × IntensityMultiplier

const SPORT_TYPE_MAP = {
  'Löpning': 'Run',
  'Hyrox':   'Run',
  'Cykel':   'Ride',
  'Gym':     'WeightTraining',
  'Längdskidor': 'Other',
  'Stakmaskin':  'Rowing',
  'Annat':   'Other',
  'Vila':    'Other',
  'Simning': 'Swim',
  'Vandring':'Hike',
  'Promenad':'Walk',
};

const DEFAULT_MET = 5.0;

// maxSpeedMps is exclusive upper bound; met is the value for that bracket
const MET_TABLE = {
  Run: [
    { maxSpeedMps: 2.222, met: 8.3 },
    { maxSpeedMps: 2.694, met: 9.3 },
    { maxSpeedMps: 3.000, met: 10.5 },
    { maxSpeedMps: 3.361, met: 12.0 },
    { maxSpeedMps: 3.833, met: 13.5 },
    { maxSpeedMps: 4.028, met: 14.0 },
    { maxSpeedMps: 4.472, met: 14.8 },
    { maxSpeedMps: 4.861, met: 16.0 },
    { maxSpeedMps: Infinity, met: 16.8 },
  ],
  Ride: [
    { maxSpeedMps: 4.444, met: 4.0 },
    { maxSpeedMps: 5.278, met: 6.8 },
    { maxSpeedMps: 6.111, met: 8.0 },
    { maxSpeedMps: 7.222, met: 10.0 },
    { maxSpeedMps: 8.333, met: 12.0 },
    { maxSpeedMps: Infinity, met: 16.0 },
  ],
  Swim: [
    { maxSpeedMps: 0.7, met: 6.0 },
    { maxSpeedMps: 1.0, met: 10.3 },
    { maxSpeedMps: Infinity, met: 13.0 },
  ],
  Rowing: [
    { maxSpeedMps: 2.0, met: 5.0 },
    { maxSpeedMps: 3.0, met: 7.0 },
    { maxSpeedMps: Infinity, met: 12.0 },
  ],
  WeightTraining: [
    { rpeMax: 3, met: 3.5 },
    { rpeMax: 6, met: 5.0 },
    { rpeMax: 10, met: 8.0 },
  ],
  HIIT: [
    { rpeMax: 3, met: 6.0 },
    { rpeMax: 6, met: 8.0 },
    { rpeMax: 10, met: 10.0 },
  ],
  Walk: [
    { maxSpeedMps: 1.250, met: 2.5 },
    { maxSpeedMps: 1.667, met: 3.5 },
    { maxSpeedMps: Infinity, met: 4.3 },
  ],
  Hike: [
    { maxSpeedMps: 1.250, met: 5.3 },
    { maxSpeedMps: 1.667, met: 6.0 },
    { maxSpeedMps: Infinity, met: 7.3 },
  ],
  Other: [
    { maxSpeedMps: Infinity, met: DEFAULT_MET },
  ],
};

// Map intensity strings to RPE values for tier selection & fallback
const INTENSITY_TO_RPE = {
  'Z1': 1, 'Z2': 3, 'mixed': 5, 'Z3': 5,
  'Kvalitet': 7, 'Z4': 8, 'Z5': 10,
};

function _lookupMET(sport, speedMps, rpe) {
  const brackets = MET_TABLE[sport];
  if (!brackets) return DEFAULT_MET;

  // RPE-based tier selection (strength, HIIT, or when no speed)
  if (brackets[0].rpeMax !== undefined) {
    const r = rpe ?? 5;
    for (const b of brackets) { if (r <= b.rpeMax) return b.met; }
    return brackets[brackets.length - 1].met;
  }

  if (speedMps == null || speedMps <= 0) {
    // No speed — use RPE to pick easy/moderate/hard
    if (rpe != null) {
      if (rpe <= 3) return brackets[0].met;
      if (rpe <= 6) return brackets[Math.min(1, brackets.length - 1)].met;
      return brackets[brackets.length - 1].met;
    }
    return brackets[Math.min(1, brackets.length - 1)].met;
  }

  // Interpolated speed-based lookup
  for (let i = 0; i < brackets.length; i++) {
    if (speedMps < brackets[i].maxSpeedMps) {
      if (i === 0) return brackets[0].met;
      const lo = brackets[i - 1].maxSpeedMps === Infinity ? 0 : brackets[i - 1].maxSpeedMps;
      const hi = brackets[i].maxSpeedMps === Infinity ? lo * 2 : brackets[i].maxSpeedMps;
      const frac = (speedMps - lo) / (hi - lo);
      return brackets[i - 1].met + frac * (brackets[i].met - brackets[i - 1].met);
    }
  }
  return brackets[brackets.length - 1].met;
}

// Outdoor activities with realistic non-flat terrain (used for elevation default).
const OUTDOOR_ACTIVITY_TYPES = new Set(['Löpning', 'Cykel', 'Längdskidor']);
// Population-typical gradient assumed when elevation data is missing for an
// outdoor activity (~5 m/km → factor 1.05). Indoor/no-distance activities → 1.0.
const DEFAULT_OUTDOOR_ELEV_FACTOR = 1.05;
// Default HRmax assumed when neither profile user_max_hr nor a reliable proxy
// is available. Population mean for adults ≈ 190 bpm. Used only as last resort.
const DEFAULT_HRMAX = 190;

function _elevationFactor(elevGainM, distKm, activityType) {
  const isOutdoor = OUTDOOR_ACTIVITY_TYPES.has(activityType);
  if (!elevGainM || elevGainM <= 0 || !distKm || distKm <= 0) {
    return isOutdoor ? DEFAULT_OUTDOOR_ELEV_FACTOR : 1.0;
  }
  const gradient = elevGainM / (distKm * 1000);
  return Math.min(2.0, 1.0 + gradient * 10);
}

function _intensityMultiplier(w) {
  // Per ALGORITHM.md §4: IM range [0.70, 1.50] across all 4 fallback levels.
  // Anchor points: 60% HRmax → 0.70 (Z1 ceiling), 75% HRmax → 1.00 (mid-Z3,
  // typical tempo / steady distance), 100% HRmax → 1.50 (pure Z5).
  const LO = 0.7, HI = 1.5;
  // Level 1: Edwards HR zone distribution. IM = 0.7 + (WI − 1.0) × 0.2.
  const zs = w.hr_zone_seconds;
  if (zs && Array.isArray(zs) && zs.length >= 5) {
    const total = zs.reduce((a, b) => a + b, 0);
    if (total > 0) {
      const wi = zs.reduce((s, sec, i) => s + (sec / total) * (i + 1), 0);
      return Math.max(LO, Math.min(HI, 0.7 + (wi - 1.0) * 0.2));
    }
  }
  // Level 2: average HR. HRmax priority: profile → DEFAULT_HRMAX.
  // NOTE: w.max_hr (session peak) is intentionally NOT used as a fallback —
  // session peak ≈ 1.05–1.15 × avg_hr, which inflates pctMax and thus IM.
  // Linear map: 60% HRmax → 0.70, 75% → 1.00, 100% → 1.50 (slope 2.0).
  const maxHr = (currentProfile?.user_max_hr && currentProfile.user_max_hr >= 100)
    ? currentProfile.user_max_hr
    : DEFAULT_HRMAX;
  if (w.avg_hr && w.avg_hr >= 30) {
    const pctMax = w.avg_hr / maxHr;
    return Math.max(LO, Math.min(HI, 2.0 * pctMax - 0.5));
  }
  // Level 3: RPE 1–10. IM = 0.7 + (RPE − 1) × (0.8 / 9).
  if (w.perceived_exertion && w.perceived_exertion >= 1) {
    const rpe = Math.min(10, w.perceived_exertion);
    return Math.max(LO, Math.min(HI, 0.7 + (rpe - 1) * (0.8 / 9)));
  }
  // Level 4: no intensity data → IM = 1.0 (symmetric range, neutral default).
  return 1.0;
}

function calcWorkoutEffort(w) {
  if (w.activity_type === 'Vila') return 0;
  const sport = SPORT_TYPE_MAP[w.activity_type] || 'Other';
  const speedMps = w.avg_speed_kmh ? w.avg_speed_kmh / 3.6 : null;
  const rpe = w.intensity ? (INTENSITY_TO_RPE[w.intensity] ?? null) : null;
  const met = _lookupMET(sport, speedMps, rpe);
  const elev = _elevationFactor(w.elevation_gain_m, w.distance_km, w.activity_type);
  const im = _intensityMultiplier(w);
  return w.duration_minutes * met * elev * im;
}

/** Rå effort → visningsvärde (Effort) så veckosummor hamnar nära faktiska träningstimmar. */
function effortRawToDisplay(rawEffort) {
  const div = typeof EFFORT_DISPLAY_DIVISOR === 'number' && EFFORT_DISPLAY_DIVISOR > 0
    ? EFFORT_DISPLAY_DIVISOR
    : 600;
  return rawEffort / div;
}

function durationWeightedHours(w) {
  const m = w.duration_minutes || 0;
  const wt = (typeof ACTIVITY_HOUR_WEIGHT !== 'undefined' && ACTIVITY_HOUR_WEIGHT[w.activity_type] != null)
    ? ACTIVITY_HOUR_WEIGHT[w.activity_type]
    : 1;
  return (m / 60) * wt;
}

let _seasonBarMode = 'hours';
function setSeasonBarMode(mode) {
  _seasonBarMode = mode;
  if (window._lastSeasonWorkouts) renderSeasonActivityBars(window._lastSeasonWorkouts, mode);
}

// Sprint 2: "Den här veckan" — three primary stats with a delta vs the
// equivalent stretch of the previous week. Both windows are clamped to
// the same weekday-of-week count so we don't compare a Tuesday-so-far
// against a full prior week (which would always look "down").
function renderProgressWeekSummary(workouts) {
  const card = document.getElementById('progress-week-summary-card');
  const body = document.getElementById('progress-week-summary-body');
  if (!card || !body) return;

  const now = new Date();
  const todayDow = (now.getDay() + 6) % 7; // 0 = Mon
  const thisMon = mondayOfWeek(now);
  const prevMon = addDays(thisMon, -7);
  // For "förra veckan" we compare the same Mon..(today's weekday) slice.
  // Earlier in the week (Mon → small slice) the comparison still makes sense
  // because we're comparing *equivalent days lived*, not a full vs partial.
  const prevSameSlice = addDays(prevMon, todayDow);

  function inWindow(w, start, end) {
    if (!w.workout_date) return false;
    const d = new Date(w.workout_date + 'T00:00:00');
    return d >= start && d <= end;
  }
  const thisWeek = workouts.filter((w) => inWindow(w, thisMon, now));
  const prevWeek = workouts.filter((w) => inWindow(w, prevMon, prevSameSlice));

  const passesNow = thisWeek.length;
  const passesPrev = prevWeek.length;
  const distNow = thisWeek.reduce((s, w) => s + (w.distance_km || 0), 0);
  const distPrev = prevWeek.reduce((s, w) => s + (w.distance_km || 0), 0);
  // Längsta löppass = furthest single run by distance (km). Hyrox is
  // intentionally excluded — those are mixed-modality and the distance
  // number isn't comparable to a regular long run.
  const isRun = (w) => w.activity_type === 'Löpning';
  const longestRunNow = thisWeek.filter(isRun).reduce((m, w) => Math.max(m, w.distance_km || 0), 0);
  const longestRunPrev = prevWeek.filter(isRun).reduce((m, w) => Math.max(m, w.distance_km || 0), 0);
  // Längsta pass (cross-discipline) = longest single session by duration
  // across ALL activity types so a heavy gym day or a long ski tour can win.
  const longestSessionMinNow = thisWeek.reduce((m, w) => Math.max(m, w.duration_minutes || 0), 0);
  const longestSessionMinPrev = prevWeek.reduce((m, w) => Math.max(m, w.duration_minutes || 0), 0);

  // SVG arrows inherit color via currentColor → .pws-stat-delta.up/down/flat.
  const arrowUp = '<svg class="pws-stat-delta-ico" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>';
  const arrowDown = '<svg class="pws-stat-delta-ico" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>';
  const arrowFlat = '<svg class="pws-stat-delta-ico" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>';

  // Format a minute count as "1h 25m" / "45m" so the duration stat reads
  // naturally for both short gym sessions and long ski tours.
  function fmtMin(min) {
    const m = Math.max(0, Math.round(min));
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
  }

  function delta(cur, prev, unit) {
    if (prev === 0 && cur === 0) {
      return `<span class="pws-stat-delta flat">${arrowFlat}<span>—</span></span>`;
    }
    if (prev === 0) {
      let valStr;
      if (unit === 'count') valStr = `+${cur.toFixed(0)}`;
      else if (unit === 'min') valStr = `+${fmtMin(cur)}`;
      else valStr = `+${cur.toFixed(1)} ${unit}`;
      return `<span class="pws-stat-delta up">${arrowUp}<span>${valStr}</span></span>`;
    }
    const diff = cur - prev;
    const cls = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat';
    const icon = diff > 0 ? arrowUp : diff < 0 ? arrowDown : arrowFlat;
    const sign = diff > 0 ? '+' : '';
    let valStr;
    if (unit === 'count') valStr = `${sign}${diff}`;
    else if (unit === 'min') valStr = `${sign}${fmtMin(Math.abs(diff))}`.replace('+−', '−'); // sign already prepended
    else valStr = `${sign}${diff.toFixed(1)} ${unit}`;
    // For minutes we re-attach the sign manually because fmtMin always
    // returns a positive token; collapse the redundant '+' on negative diffs.
    if (unit === 'min') {
      const signTok = diff > 0 ? '+' : diff < 0 ? '−' : '';
      valStr = `${signTok}${fmtMin(Math.abs(diff))}`;
    }
    return `<span class="pws-stat-delta ${cls}">${icon}<span>${valStr}</span></span>`;
  }

  if (passesNow === 0 && passesPrev === 0) {
    body.innerHTML = '<div class="pws-empty">Inga pass loggade ännu denna vecka. Logga ett pass så fyller vi i sammanfattningen.</div>';
    return;
  }

  body.innerHTML = `<div class="pws-grid">
    <div class="pws-stat">
      <span class="pws-stat-val">${passesNow}</span>
      <span class="pws-stat-label">Pass</span>
      ${delta(passesNow, passesPrev, 'count')}
    </div>
    <div class="pws-stat">
      <span class="pws-stat-val">${distNow.toFixed(1)} km</span>
      <span class="pws-stat-label">Total distans</span>
      ${delta(distNow, distPrev, 'km')}
    </div>
    <div class="pws-stat">
      <span class="pws-stat-val">${longestRunNow.toFixed(1)} km</span>
      <span class="pws-stat-label">Längsta löppass</span>
      ${delta(longestRunNow, longestRunPrev, 'km')}
    </div>
    <div class="pws-stat">
      <span class="pws-stat-val">${longestSessionMinNow > 0 ? fmtMin(longestSessionMinNow) : '—'}</span>
      <span class="pws-stat-label">Längsta pass</span>
      ${delta(longestSessionMinNow, longestSessionMinPrev, 'min')}
    </div>
  </div>`;
}

// ─────────────────────────────────────────────────────────────
//  Sprint 4: Goals (Dina mål sub-tab).
//  Four goal types, all stored in public.user_goals:
//    - distance_per_period   "200 km / månad"
//    - count_per_period      "4 pass / vecka"
//    - race_time             "Marathon på 3:30"
//    - plan_derived_race     auto-created when an AI plan's goal_type='race'
//  All reads/writes go through RLS-protected queries (migration
//  20260422_user_goals.sql); no service-role needed.
// ─────────────────────────────────────────────────────────────

let _userGoals = [];

async function fetchUserGoals(profileId) {
  if (!profileId) return [];
  try {
    const { data, error } = await sb.from('user_goals')
      .select('*')
      .eq('profile_id', profileId)
      .eq('active', true)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  } catch (e) {
    console.error('Fetch user goals error:', e);
    return [];
  }
}

// Keep a 1:1 plan-derived goal in sync with the current active plan.
// Runs best-effort: failures are logged but don't block goals render.
//
// Race plans get goal_type='plan_derived_race' (with target_value=sec on
// the race time, target_distance_km set, target_date = race date). Every
// other plan (fitness / weight_loss / sport_specific / custom) gets
// goal_type='plan_derived' with sentinel target values (the frontend
// ignores them — milestones + capacity profile drive the UI). The new
// generate-plan/confirm_plan path already creates these rows; this
// helper fills the gap for legacy plans created before that change
// shipped.
async function _ensurePlanDerivedGoal(plan, profileId) {
  if (!plan || !profileId) return;
  const isRace = plan.goal_type === 'race';
  if (isRace && !plan.goal_date) return; // race plans need a target date

  try {
    const goalType = isRace ? 'plan_derived_race' : 'plan_derived';
    const existing = _userGoals.find(
      (g) => (g.goal_type === goalType || g.goal_type === 'plan_derived' || g.goal_type === 'plan_derived_race')
        && g.plan_id === plan.id,
    );
    const title = plan.goal_text || plan.name || (isRace ? 'Racemål från plan' : 'Mål från plan');
    const raceDistanceKm = (() => {
      const v = plan?.constraints?.race_distance_km;
      const n = typeof v === 'number' ? v : parseFloat(v);
      return (Number.isFinite(n) && n > 0) ? n : null;
    })();

    if (!existing) {
      const payload = {
        profile_id: profileId,
        plan_id: plan.id,
        goal_type: goalType,
        title,
        target_value: isRace ? 0 : 1,
        target_unit: isRace ? 'race' : 'plan',
        target_date: isRace ? plan.goal_date : (plan.end_date || null),
        baseline_date: plan.start_date || null,
        notes: plan.goal_text || null,
        ...(raceDistanceKm ? { target_distance_km: raceDistanceKm } : {}),
      };
      const { data, error } = await sb.from('user_goals').insert(payload).select().single();
      if (!error && data) _userGoals.unshift(data);
      else if (error) console.warn('plan-derived goal insert failed:', error);
    } else {
      const patch = {};
      if (existing.goal_type !== goalType) patch.goal_type = goalType;
      if (existing.title !== title) patch.title = title;
      const targetDate = isRace ? plan.goal_date : (plan.end_date || null);
      if (existing.target_date !== targetDate) patch.target_date = targetDate;
      if (raceDistanceKm && existing.target_distance_km !== raceDistanceKm) {
        patch.target_distance_km = raceDistanceKm;
      }
      if (Object.keys(patch).length > 0) {
        const { data, error } = await sb.from('user_goals')
          .update(patch)
          .eq('id', existing.id)
          .select()
          .single();
        if (!error && data) Object.assign(existing, data);
      }
    }
  } catch (e) {
    console.warn('Plan-derived goal sync failed (non-fatal):', e);
  }
}

// Back-compat alias for the previous race-only helper.
const _ensurePlanDerivedRaceGoal = _ensurePlanDerivedGoal;

// Cache of plan_milestones keyed by plan_id. Loaded lazily from
// loadGoals() and re-fetched whenever the active plan changes.
let _planMilestones = {};

async function _fetchPlanMilestones(planId) {
  if (!planId) return [];
  try {
    const { data, error } = await sb.from('plan_milestones')
      .select('*')
      .eq('plan_id', planId)
      .order('sort_order', { ascending: true })
      .order('target_week_number', { ascending: true });
    if (error) throw error;
    return data || [];
  } catch (e) {
    // plan_milestones is a new table — older deployments may not have it
    // yet. Fail silently and let the rest of the goals tab render.
    if (e?.code === 'PGRST205' || /plan_milestones/i.test(e?.message || '')) {
      return [];
    }
    console.warn('fetch plan_milestones failed:', e);
    return [];
  }
}

async function loadGoals(workouts) {
  if (!currentProfile) return;
  _userGoals = await fetchUserGoals(currentProfile.id);

  // Make sure the active plan is loaded before deciding whether to
  // backfill the plan_derived row. loadGoals can run before the schedule
  // view has had a chance to set the _activePlan global, which would
  // otherwise cause the primary goal card to be skipped on first load.
  let plan = _activePlan;
  if (!plan) {
    plan = await fetchActivePlan(currentProfile.id);
    if (plan) _activePlan = plan;
  }

  if (plan) {
    await _ensurePlanDerivedGoal(plan, currentProfile.id);
    _planMilestones[plan.id] = await _fetchPlanMilestones(plan.id);
  }
  renderGoals(workouts || window._lastSeasonWorkouts || []);
}

function renderGoals(workouts) {
  const raceSection = document.getElementById('goals-race-section');
  const raceCards = document.getElementById('goals-race-cards');
  const customSection = document.getElementById('goals-custom-section');
  const customCards = document.getElementById('goals-custom-cards');
  const customLabel = document.getElementById('goals-custom-label');
  if (!raceSection || !raceCards || !customSection || !customCards) return;

  // Primary goal: prefer the active plan's plan-derived row. This is the
  // goal the user set when they created the plan, so it always takes the
  // top slot regardless of type (race / fitness / weight loss / etc.).
  const primary = _activePlan
    ? _userGoals.find(
        (g) => g.plan_id === _activePlan.id
          && (g.goal_type === 'plan_derived_race' || g.goal_type === 'plan_derived'),
      )
    : null;

  // The primary card and any standalone race_time entries live in the
  // "race" section. Plan-derived non-race goals don't otherwise belong
  // anywhere — they only ever render via the primary card.
  const standaloneRaces = _userGoals.filter(
    (g) => g.goal_type === 'race_time' && (!primary || g.id !== primary.id),
  );
  const custom = _userGoals.filter((g) => g.goal_type === 'distance_per_period' || g.goal_type === 'count_per_period');

  let raceHtml = '';
  if (primary) {
    raceHtml += renderPlanDerivedGoalCard(primary, workouts, _activePlan);
  }
  if (standaloneRaces.length > 0) {
    raceHtml += standaloneRaces.map((g) => renderRaceGoalCard(g, workouts)).join('');
  }

  if (!raceHtml) {
    raceSection.hidden = true;
    raceCards.innerHTML = '';
  } else {
    raceSection.hidden = false;
    raceCards.innerHTML = raceHtml;
  }

  if (custom.length === 0 && !raceHtml) {
    // No primary goal AND no custom goals — i.e. user has never created a
    // plan and hasn't added any custom goals. Nudge them toward both.
    customCards.innerHTML = `
      <div class="card goal-empty-state">
        <div class="goal-empty-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="32" height="32"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>
        </div>
        <h3 class="goal-empty-title">Inget mål än</h3>
        <p class="goal-empty-body">När du skapar en träningsplan dyker dess huvudmål upp här automatiskt — med en uppskattning av om du är på rätt väg och din sannolikhet att nå det. Du kan också lägga till egna mål (km per månad, antal pass per år eller en tidsmål på en distans).</p>
      </div>`;
    customLabel.hidden = true;
  } else if (custom.length === 0) {
    customCards.innerHTML = '';
    customLabel.hidden = true;
  } else {
    customLabel.hidden = false;
    customCards.innerHTML = custom.map((g) => renderCustomGoalCard(g, workouts)).join('');
  }
}

// ── Custom goal progress ────────────────────────────────────────────────
function _periodWindow(goal) {
  const now = new Date();
  if (goal.period === 'week') {
    const start = mondayOfWeek(now);
    const end = addDays(start, 7);
    return { start, end, label: 'Denna vecka' };
  }
  if (goal.period === 'month') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return { start, end, label: 'Denna månad' };
  }
  if (goal.period === 'year') {
    const start = new Date(now.getFullYear(), 0, 1);
    const end = new Date(now.getFullYear() + 1, 0, 1);
    return { start, end, label: `${now.getFullYear()}` };
  }
  return null;
}

function _sumForGoal(goal, workouts) {
  const win = _periodWindow(goal);
  if (!win) return 0;
  const inWin = workouts.filter((w) => {
    if (!w.workout_date) return false;
    const d = new Date(w.workout_date + 'T00:00:00');
    return d >= win.start && d < win.end;
  });
  if (goal.goal_type === 'count_per_period') return inWin.length;
  if (goal.goal_type === 'distance_per_period') {
    if (goal.target_unit === 'km') return inWin.reduce((s, w) => s + (w.distance_km || 0), 0);
    if (goal.target_unit === 'minutes') return inWin.reduce((s, w) => s + (w.duration_minutes || 0), 0);
    if (goal.target_unit === 'workouts') return inWin.length;
  }
  return 0;
}

function _formatGoalValue(v, unit) {
  if (unit === 'km') return `${v.toFixed(1)} km`;
  if (unit === 'minutes') return `${Math.round(v)} min`;
  if (unit === 'workouts') return `${Math.round(v)} pass`;
  return `${v}`;
}

function renderCustomGoalCard(goal, workouts) {
  const current = _sumForGoal(goal, workouts);
  const target = Number(goal.target_value) || 0;
  const pct = target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0;
  const rawPct = target > 0 ? (current / target) * 100 : 0;

  const win = _periodWindow(goal);
  // How far through the period are we? Compare pct-completion-of-goal vs
  // pct-of-period-elapsed so user sees "behind pace" / "on pace" at a glance.
  let paceHint = '';
  let paceClass = '';
  if (win && target > 0) {
    const now = new Date();
    const totalMs = win.end.getTime() - win.start.getTime();
    const elapsedMs = Math.max(0, Math.min(totalMs, now.getTime() - win.start.getTime()));
    const pctElapsed = (elapsedMs / totalMs) * 100;
    const diff = rawPct - pctElapsed;
    if (diff >= -5 && diff <= 5) {
      paceHint = 'På plan';
      paceClass = 'on-track';
    } else if (diff > 5) {
      paceHint = `Före schema (+${Math.round(diff)} %)`;
      paceClass = 'ahead';
    } else {
      paceHint = `Efter schema (${Math.round(diff)} %)`;
      paceClass = 'lagging';
    }
  }

  const remaining = Math.max(0, target - current);
  const remainingTxt = remaining > 0
    ? `Kvar: ${_formatGoalValue(remaining, goal.target_unit)}`
    : 'Klart! 🎉';

  return `<div class="card goal-card" data-goal-id="${goal.id}">
    <div class="goal-card-header">
      <div class="goal-card-title-wrap">
        <div class="goal-card-title">${_escapeHtml(goal.title)}</div>
        <div class="goal-card-sub">${win ? win.label : ''}${paceHint ? ` · <span class="goal-pace-pill ${paceClass}">${paceHint}</span>` : ''}</div>
      </div>
      <button type="button" class="goal-card-menu" aria-label="Ta bort mål" onclick="confirmDeleteGoal('${goal.id}')">×</button>
    </div>
    <div class="goal-progress-row">
      <div class="goal-progress-track"><div class="goal-progress-fill" style="width:${pct}%"></div></div>
      <div class="goal-progress-stat">${_formatGoalValue(current, goal.target_unit)} / ${_formatGoalValue(target, goal.target_unit)} <span class="goal-progress-pct">(${pct} %)</span></div>
    </div>
    <div class="goal-card-footer">${remainingTxt}</div>
  </div>`;
}

// ── Race goal card + indicators ─────────────────────────────────────────

function _daysBetween(a, b) {
  const MS = 86400000;
  return Math.round((b.getTime() - a.getTime()) / MS);
}

// Compare a "recent 28 d" window vs the preceding 28 d. Returns a status
// chip based on the relative change. Thresholds are intentionally wide so
// normal training noise doesn't flip the chip every week.
function _goalTrendStatus(recentVal, earlierVal, opts = {}) {
  const { upIsGood = true, neutralPct = 3 } = opts;
  if (!Number.isFinite(recentVal) || !Number.isFinite(earlierVal) || earlierVal <= 0) {
    return { cls: 'neutral', label: 'För få data', pct: null };
  }
  const pct = ((recentVal - earlierVal) / earlierVal) * 100;
  const pctRounded = +pct.toFixed(1);
  let cls;
  if (Math.abs(pct) <= neutralPct) cls = 'on-track';
  else if (pct > 0) cls = upIsGood ? 'ahead' : 'lagging';
  else cls = upIsGood ? 'lagging' : 'ahead';
  const labelMap = {
    'on-track': 'Stabil',
    'ahead': upIsGood ? 'Stigande' : 'Sjunkande',
    'lagging': upIsGood ? 'Sjunkande' : 'Stigande',
  };
  return { cls, label: labelMap[cls], pct: pctRounded };
}

function _computeRaceIndicators(workouts) {
  const now = new Date();
  const start28 = addDays(now, -28);
  const start56 = addDays(now, -56);

  function inWin(w, s, e) {
    if (!w.workout_date) return false;
    const d = new Date(w.workout_date + 'T00:00:00');
    return d >= s && d < e;
  }
  const recent = workouts.filter((w) => inWin(w, start28, now));
  const earlier = workouts.filter((w) => inWin(w, start56, start28));

  // VDOT: qualifying runs only (HR >= VO2MAX_QUAL_HR_PCT of HRmax, currently
  // 70 %). Average over the window.
  const maxHr = (currentProfile && Number(currentProfile.user_max_hr)) || EF_DEFAULT_MAX_HR;
  function avgVdot(arr) {
    const vs = arr
      .filter((w) => _isVdotQualifyingPass(w, maxHr))
      .map((w) => _vdotFromWorkout(w))
      .filter((v) => v !== null);
    if (!vs.length) return NaN;
    return vs.reduce((a, b) => a + b, 0) / vs.length;
  }
  const vdotRecent = avgVdot(recent);
  const vdotEarlier = avgVdot(earlier);

  // Weekly volume (hours): normalise by window length so a full 28 d
  // earlier window is comparable to a partial recent window if we ever
  // extend the lookback.
  const hoursRecent = recent.reduce((s, w) => s + (w.duration_minutes || 0), 0) / 60;
  const hoursEarlier = earlier.reduce((s, w) => s + (w.duration_minutes || 0), 0) / 60;

  // Consistency: pass/week, averaged over the 28 d window (= 4 weeks).
  const countRecent = recent.length / 4;
  const countEarlier = earlier.length / 4;

  return {
    vdot: {
      status: _goalTrendStatus(vdotRecent, vdotEarlier, { upIsGood: true, neutralPct: 2 }),
      recent: vdotRecent,
      earlier: vdotEarlier,
    },
    volume: {
      status: _goalTrendStatus(hoursRecent, hoursEarlier, { upIsGood: true, neutralPct: 10 }),
      recent: hoursRecent,
      earlier: hoursEarlier,
    },
    consistency: {
      status: _goalTrendStatus(countRecent, countEarlier, { upIsGood: true, neutralPct: 10 }),
      recent: countRecent,
      earlier: countEarlier,
    },
  };
}

function _formatSecondsAsPace(totalSec) {
  if (!Number.isFinite(totalSec) || totalSec <= 0) return '';
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.round(totalSec % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

// Invert Daniels' VDOT formula: given a VDOT score and a race distance,
// predict the finishing time (in seconds). The forward VDOT formula
// (see _vdotFromWorkout) couples velocity and duration through %max, so
// no closed-form inverse exists — we bisect over time. Monotonicity
// holds: longer time -> slower velocity -> lower vo2 -> lower predicted
// VDOT, so binary search converges in ~60 iterations to sub-second
// precision over the 1-800 min search window (covers everything from a
// hard mile to a 13 h ultra).
function _predictRaceTimeFromVdot(vdot, distanceKm) {
  if (!Number.isFinite(vdot) || vdot <= 0) return null;
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) return null;
  let lo = 1;
  let hi = 800;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const v = (distanceKm * 1000) / mid;
    const vo2 = -4.60 + 0.182258 * v + 0.000104 * v * v;
    const pct = 0.8
      + 0.1894393 * Math.exp(-0.012778 * mid)
      + 0.2989558 * Math.exp(-0.1932605 * mid);
    if (pct <= 0) { lo = mid; continue; }
    const predVdot = vo2 / pct;
    if (predVdot > vdot) lo = mid; else hi = mid;
  }
  return ((lo + hi) / 2) * 60;
}

// Probability that the user will hit their race-time target on race day.
// Inputs:
//   goal      — user_goals row (race_time or plan_derived_race) with
//               target_value (sec), target_distance_km, target_date.
//   workouts  — recent workout list (already filtered to runs is fine,
//               we re-filter here via _isVdotQualifyingPass).
//   indicators — output of _computeRaceIndicators(); we use its
//                volume/consistency status to dampen the probability
//                when training is trending the wrong way.
// Output:
//   { pct, label, cls, projection_sec }
//   pct=null when there is too little data to project.
function _computeRaceProbability(goal, workouts, indicators) {
  if (!goal || !goal.target_value || !goal.target_distance_km || !goal.target_date) {
    return { pct: null, label: 'För lite data', cls: 'unknown', projection_sec: null };
  }
  const targetSec = Number(goal.target_value);
  const distKm = Number(goal.target_distance_km);
  const targetDate = new Date(goal.target_date + 'T00:00:00');
  const now = new Date();

  const maxHr = (currentProfile && Number(currentProfile.user_max_hr)) || EF_DEFAULT_MAX_HR;
  const start28 = addDays(now, -28);
  const start56 = addDays(now, -56);
  function inWin(w, s, e) {
    if (!w.workout_date) return false;
    const d = new Date(w.workout_date + 'T00:00:00');
    return d >= s && d < e;
  }
  function avgVdot(arr) {
    const vs = arr
      .filter((w) => _isVdotQualifyingPass(w, maxHr))
      .map((w) => _vdotFromWorkout(w))
      .filter((v) => v !== null);
    if (!vs.length) return { avg: NaN, n: 0 };
    return { avg: vs.reduce((a, b) => a + b, 0) / vs.length, n: vs.length };
  }
  const recent = workouts.filter((w) => inWin(w, start28, now));
  const earlier = workouts.filter((w) => inWin(w, start56, start28));
  const r = avgVdot(recent);
  const e = avgVdot(earlier);

  // Need at least one recent qualifying pass to project at all.
  if (!Number.isFinite(r.avg) || r.n < 1) {
    return { pct: null, label: 'För lite data', cls: 'unknown', projection_sec: null };
  }

  // Weekly improvement rate. If we don't have an earlier window, assume
  // flat (no projected gains) — the safer default than guessing a trend
  // from a single window.
  let perWeek = 0;
  if (Number.isFinite(e.avg) && e.n >= 1) {
    perWeek = (r.avg - e.avg) / 4; // 28 d / 7
  }

  const weeksToRace = Math.max(0, _daysBetween(now, targetDate) / 7);
  // Cap projected gains to avoid wild extrapolation: realistic VDOT
  // improvement maxes around +0.5 / week sustained; we cap at +0.4/week.
  const cappedPerWeek = Math.max(-0.5, Math.min(0.4, perWeek));
  const projectedVdot = r.avg + cappedPerWeek * weeksToRace;
  const projectedSec = _predictRaceTimeFromVdot(projectedVdot, distKm);
  if (!Number.isFinite(projectedSec)) {
    return { pct: null, label: 'För lite data', cls: 'unknown', projection_sec: null };
  }

  // Logistic mapping: gap = (projected − target) / target. Negative gap
  // means we're projecting faster than target (good). k=0.04 means a 4 %
  // shortfall lands at ~50 %, 8 % shortfall at ~12 %, 4 % surplus at ~88 %.
  const gap = (projectedSec - targetSec) / targetSec;
  let pct = 1 / (1 + Math.exp(gap / 0.04));

  // Penalty when training is trending the wrong way. Only react to
  // 'lagging' — if volume/consistency are merely 'on-track' we leave the
  // pace projection as the source of truth.
  if (indicators) {
    if (indicators.volume?.status?.cls === 'lagging') pct *= 0.9;
    if (indicators.consistency?.status?.cls === 'lagging') pct *= 0.9;
  }

  pct = Math.max(0.01, Math.min(0.99, pct));
  const pctRounded = Math.round(pct * 100);
  let label, cls;
  if (pctRounded >= 75) { label = 'Mycket troligt'; cls = 'great'; }
  else if (pctRounded >= 50) { label = 'Troligt'; cls = 'good'; }
  else if (pctRounded >= 25) { label = 'Osäkert'; cls = 'warn'; }
  else { label = 'Tufft'; cls = 'risk'; }

  return { pct: pctRounded, label, cls, projection_sec: projectedSec };
}

// ── Plan-form probability for non-race plans (fitness / weight loss / etc.)
// Race plans get a sharp pace-projection (above). Everything else gets a
// "form" score combining: milestone hit-rate, ACWR / volume trend, and
// consistency (sessions per week vs. plan target). The output shape is
// identical to _computeRaceProbability so the render code can be reused.
function _computePlanFormProbability(plan, workouts, milestones, indicators) {
  if (!plan) return { pct: null, label: 'Ingen plan', cls: 'unknown', projection_sec: null };

  // Base score: how many milestones we've hit so far vs. how many should
  // already be evaluated by today (target_week_number passed). A user who
  // is mid-plan with no completed milestones is at neutral 50 %.
  const today = new Date();
  let hit = 0, due = 0;
  if (Array.isArray(milestones) && plan.start_date) {
    const startMs = new Date(plan.start_date + 'T00:00:00').getTime();
    for (const m of milestones) {
      if (m.metric_type === 'assessment_baseline') continue; // baseline-only
      const wk = Number(m.target_week_number);
      if (!Number.isFinite(wk)) continue;
      const milestoneDate = new Date(startMs + (wk - 1) * 7 * 86400000);
      if (milestoneDate > today) continue;
      due++;
      if (m.status === 'on_track' || m.status === 'completed' || m.status === 'hit') hit++;
    }
  }
  let score = due > 0 ? hit / due : 0.55;

  // Indicators trim the score toward the truth: lagging volume or
  // consistency drops it; positive trend lifts it.
  if (indicators) {
    if (indicators.volume?.status?.cls === 'lagging') score *= 0.85;
    else if (indicators.volume?.status?.cls === 'ahead') score = Math.min(0.95, score * 1.05);
    if (indicators.consistency?.status?.cls === 'lagging') score *= 0.85;
    if (indicators.vdot?.status?.cls === 'lagging') score *= 0.92;
  }

  score = Math.max(0.05, Math.min(0.95, score));
  const pctRounded = Math.round(score * 100);
  let label, cls;
  if (pctRounded >= 75) { label = 'På rätt väg'; cls = 'great'; }
  else if (pctRounded >= 50) { label = 'Troligt om du håller i'; cls = 'good'; }
  else if (pctRounded >= 30) { label = 'Tufft just nu'; cls = 'warn'; }
  else { label = 'Långt efter'; cls = 'risk'; }
  return { pct: pctRounded, label, cls, projection_sec: null };
}

// Evaluate a single milestone against logged workouts.
// Returns 'hit' | 'on_track' | 'off_track' | 'missed' | 'pending'.
// Pending = target week is in the future. We deliberately keep this
// simple — the canonical evaluator lives in the goals_eval edge function
// (see plan), but the frontend version is enough to drive the UI when
// the server hasn't computed the status yet.
function _evaluateMilestone(milestone, plan, workouts) {
  if (!milestone || !plan) return 'pending';
  if (milestone.status && milestone.status !== 'pending') return milestone.status;
  if (milestone.metric_type === 'assessment_baseline') {
    return milestone.evaluated_at ? 'hit' : 'pending';
  }
  const wk = Number(milestone.target_week_number);
  if (!Number.isFinite(wk) || !plan.start_date) return 'pending';
  const target = new Date(plan.start_date + 'T00:00:00');
  target.setDate(target.getDate() + (wk - 1) * 7);
  if (target > new Date()) return 'pending';
  // Past-due milestones with no evaluation get a neutral "off_track"
  // until the server supplies real data.
  return 'off_track';
}

// Roll a list of milestones up into a single status the primary card
// can display alongside the headline. Hit-rate ≥ 80 % → on track,
// ≥ 50 % → mixed, < 50 % → behind.
function _rollupPlanStatus(plan, workouts, milestones) {
  if (!plan) return { cls: 'unknown', label: 'Ingen plan' };
  const considered = (milestones || []).filter((m) => m.metric_type !== 'assessment_baseline');
  if (considered.length === 0) {
    return { cls: 'unknown', label: 'Ingen utvärdering ännu' };
  }
  let hit = 0, due = 0;
  for (const m of considered) {
    const status = _evaluateMilestone(m, plan, workouts);
    if (status === 'pending') continue;
    due++;
    if (status === 'hit' || status === 'on_track' || status === 'completed') hit++;
  }
  if (due === 0) return { cls: 'pending', label: 'Inga milstolpar förfallna än' };
  const ratio = hit / due;
  if (ratio >= 0.8) return { cls: 'på-väg', label: 'På väg mot målet' };
  if (ratio >= 0.5) return { cls: 'tufft', label: 'Tufft, men möjligt' };
  return { cls: 'efter', label: 'Efter — coachen justerar' };
}

// "Frågor om ditt mål" panel: 2-3 short Q&A items the user might be
// wondering about, derived from the plan + indicators. Each item has a
// question, a short answer, and an optional "Justera" CTA that opens
// the plan-edit modal.
function _buildGoalQuestions(plan, indicators, milestones, prob) {
  const items = [];
  // Q1: am I on pace?
  if (prob && prob.pct !== null) {
    items.push({
      icon: '🎯',
      q: 'Är jag på pace mot målet?',
      a: `${prob.label} — ${prob.pct}% sannolikhet baserat på senaste 4 veckorna.`,
    });
  }
  // Q2: any indicator lagging?
  if (indicators?.volume?.status?.cls === 'lagging') {
    items.push({
      icon: '📉',
      q: 'Varför ser min volym tråkig ut?',
      a: 'Du har loggat mindre volym än de föregående 4 veckorna. Lägg några pratspass på lediga dagar — det räcker långt.',
      cta: { label: 'Justera schemat', onclick: 'openPlanEditModal()' },
    });
  } else if (indicators?.consistency?.status?.cls === 'lagging') {
    items.push({
      icon: '📅',
      q: 'Varför sjunker min konsekvens?',
      a: 'Du missar fler pass än vanligt. Säg till coachen vad som hindrar — så flyttar vi pass eller drar ner.',
      cta: { label: 'Vecko-avstämning', onclick: 'openCoachCheckin()' },
    });
  }
  // Q3: next milestone
  const upcoming = (milestones || [])
    .filter((m) => m.metric_type !== 'assessment_baseline' && m.target_week_number != null)
    .sort((a, b) => a.target_week_number - b.target_week_number)
    .find((m) => {
      if (!plan?.start_date) return true;
      const t = new Date(plan.start_date + 'T00:00:00');
      t.setDate(t.getDate() + (m.target_week_number - 1) * 7);
      return t > new Date();
    });
  if (upcoming) {
    const t = upcoming.title || 'Nästa milstolpe';
    const wk = upcoming.target_week_number ? `v${upcoming.target_week_number}` : '';
    items.push({
      icon: '📍',
      q: 'Vad är nästa milstolpe?',
      a: `${t}${wk ? ` (${wk})` : ''}${upcoming.description ? ' — ' + upcoming.description : ''}`,
    });
  }
  return items.slice(0, 3);
}

function renderPlanDerivedGoalCard(goal, workouts, plan) {
  const isRace = goal.goal_type === 'plan_derived_race';
  const milestones = plan ? (_planMilestones[plan.id] || []) : [];
  const indicators = _computeRaceIndicators(workouts);
  const headline = _rollupPlanStatus(plan, workouts, milestones);

  // Probability — race plans get the pace projection, everything else gets
  // the form-based estimate.
  const probability = isRace
    ? _computeRaceProbability(goal, workouts, indicators)
    : _computePlanFormProbability(plan, workouts, milestones, indicators);

  const targetDate = goal.target_date
    ? new Date(goal.target_date + 'T00:00:00')
    : (plan?.end_date ? new Date(plan.end_date + 'T00:00:00') : null);
  const startDate = goal.baseline_date
    ? new Date(goal.baseline_date + 'T00:00:00')
    : (plan?.start_date ? new Date(plan.start_date + 'T00:00:00') : new Date(goal.created_at));

  const now = new Date();
  let timelineHtml = '';
  if (targetDate) {
    const totalDays = Math.max(1, _daysBetween(startDate, targetDate));
    const elapsedDays = Math.max(0, Math.min(totalDays, _daysBetween(startDate, now)));
    const pctTime = Math.round((elapsedDays / totalDays) * 100);
    const daysLeft = Math.max(0, _daysBetween(now, targetDate));
    const daysLeftTxt = daysLeft === 0 ? 'Idag!' : daysLeft === 1 ? 'Imorgon' : `${daysLeft} dagar kvar`;
    timelineHtml = `
      <div class="goal-timeline">
        <div class="goal-timeline-track">
          <div class="goal-timeline-fill" style="width:${pctTime}%"></div>
          <div class="goal-timeline-dot goal-timeline-dot--now" style="left:${pctTime}%" title="Idag"></div>
        </div>
        <div class="goal-timeline-labels">
          <span class="goal-timeline-label">${startDate.toISOString().slice(0, 10)}</span>
          <span class="goal-timeline-label goal-timeline-label--now">${daysLeftTxt}</span>
          <span class="goal-timeline-label">${targetDate.toISOString().slice(0, 10)}</span>
        </div>
      </div>`;
  }

  const milestoneTimelineHtml = milestones.length === 0 ? '' : `
    <div class="milestone-timeline">
      <div class="milestone-timeline-title">Milstolpar</div>
      ${milestones.map((m) => {
        const status = _evaluateMilestone(m, plan, workouts);
        const isAssess = m.metric_type === 'assessment_baseline';
        const wk = m.target_week_number != null ? `V${m.target_week_number}` : '—';
        const cssStatus = ({
          hit: 'hit',
          completed: 'hit',
          on_track: 'on',
          off_track: 'lag',
          missed: 'miss',
          pending: 'pending',
        })[status] || 'pending';
        const pillCls = `milestone-status-pill--${cssStatus}`;
        const pillLabel = ({
          hit: 'Klart',
          on_track: 'På väg',
          off_track: 'Efter',
          completed: 'Klart',
          missed: 'Missat',
          pending: 'Kommande',
        })[status] || 'Kommande';
        return `<div class="milestone-row${isAssess ? ' milestone-row--assessment' : ''}">
          <div class="milestone-week">${wk}</div>
          <div class="milestone-body">
            <div class="milestone-title">${_escapeHtml(m.title || 'Milstolpe')}</div>
            ${m.description ? `<div class="milestone-evidence">${_escapeHtml(m.description)}</div>` : ''}
          </div>
          <span class="milestone-status-pill ${pillCls}">${pillLabel}</span>
        </div>`;
      }).join('')}
    </div>`;

  // Probability block (re-used from race card — same shape).
  let probabilityHtml = '';
  if (probability && probability.pct !== null) {
    const targetTxt = isRace && goal.target_value
      ? `Mål: ${_formatSecondsAsPace(Number(goal.target_value))}`
      : (plan?.goal_text || goal.title || 'Målet');
    const projTxt = isRace && probability.projection_sec
      ? `Projicerad tid på racedagen: ${_formatSecondsAsPace(probability.projection_sec)}`
      : '';
    probabilityHtml = `<div class="goal-probability goal-probability--${probability.cls}">
      <div class="gp-pct">${probability.pct}%</div>
      <div class="gp-text">
        <div class="gp-label">${probability.label}</div>
        <div class="gp-detail">${_escapeHtml(targetTxt)}${projTxt ? ` · ${_escapeHtml(projTxt)}` : ''}</div>
      </div>
    </div>`;
  } else if (probability) {
    probabilityHtml = `<div class="goal-probability goal-probability--unknown">
      <div class="gp-pct">—</div>
      <div class="gp-text">
        <div class="gp-label">${probability.label || 'För lite data'}</div>
        <div class="gp-detail">Logga några pass så uppdaterar vi sannolikheten.</div>
      </div>
    </div>`;
  }

  const questions = _buildGoalQuestions(plan, indicators, milestones, probability);
  const questionsHtml = questions.length === 0 ? '' : `
    <div class="goal-questions">
      <div class="goal-questions-title">Frågor om ditt mål</div>
      ${questions.map((q) => `
        <div class="goal-question">
          <span class="gq-icon" aria-hidden="true">${q.icon}</span>
          <div>
            <div class="gq-q">${_escapeHtml(q.q)}</div>
            <div class="gq-a">${_escapeHtml(q.a)}</div>
            ${q.cta ? `<button type="button" class="gq-fix btn btn-ghost btn-sm" onclick="${q.cta.onclick}">${_escapeHtml(q.cta.label)}</button>` : ''}
          </div>
        </div>
      `).join('')}
    </div>`;

  // Headline class drives the colored chip + accent on the card edge.
  const headlineCls = `goal-headline--${headline.cls}`;
  const planName = plan?.name || plan?.goal_text || goal.title || 'Ditt mål';

  return `<div class="card goal-card goal-card--race goal-card--primary" data-goal-id="${goal.id}">
    <div class="goal-card-header">
      <div class="goal-card-title-wrap">
        <span class="goal-chip-primary">Huvudmål från din plan</span>
        <div class="goal-card-title">${_escapeHtml(planName)}</div>
        <div class="goal-headline ${headlineCls}">${_escapeHtml(headline.label)}</div>
      </div>
    </div>
    ${probabilityHtml}
    ${timelineHtml}
    ${milestoneTimelineHtml}
    ${questionsHtml}
  </div>`;
}

function renderRaceGoalCard(goal, workouts) {
  const now = new Date();
  const startDate = goal.baseline_date
    ? new Date(goal.baseline_date + 'T00:00:00')
    : new Date(goal.created_at);
  const targetDate = goal.target_date ? new Date(goal.target_date + 'T00:00:00') : null;

  let timelineHtml = '';
  if (targetDate) {
    const totalDays = Math.max(1, _daysBetween(startDate, targetDate));
    const elapsedDays = Math.max(0, Math.min(totalDays, _daysBetween(startDate, now)));
    const pct = Math.round((elapsedDays / totalDays) * 100);
    const daysLeft = Math.max(0, _daysBetween(now, targetDate));
    const daysLeftTxt = daysLeft === 0
      ? 'Idag!'
      : daysLeft === 1
        ? 'Imorgon'
        : `${daysLeft} dagar kvar`;
    timelineHtml = `
      <div class="goal-timeline">
        <div class="goal-timeline-track">
          <div class="goal-timeline-fill" style="width:${pct}%"></div>
          <div class="goal-timeline-dot goal-timeline-dot--now" style="left:${pct}%" title="Idag"></div>
        </div>
        <div class="goal-timeline-labels">
          <span class="goal-timeline-label">${startDate.toISOString().slice(0, 10)}</span>
          <span class="goal-timeline-label goal-timeline-label--now">${daysLeftTxt}</span>
          <span class="goal-timeline-label">${targetDate.toISOString().slice(0, 10)}</span>
        </div>
      </div>`;
  }

  const ind = _computeRaceIndicators(workouts);
  const indicators = [
    { key: 'vdot', label: 'VO2max', ...ind.vdot },
    { key: 'volume', label: 'Volym (h/v)', ...ind.volume },
    { key: 'consistency', label: 'Konsekvens (pass/v)', ...ind.consistency },
  ];
  const indicatorsHtml = `<div class="goal-indicators">${indicators.map((x) => {
    const pctTxt = x.status.pct !== null ? `${x.status.pct > 0 ? '+' : ''}${x.status.pct} %` : '—';
    return `<div class="goal-indicator goal-indicator--${x.status.cls}">
      <span class="goal-indicator-label">${x.label}</span>
      <span class="goal-indicator-value">${x.status.label}</span>
      <span class="goal-indicator-delta">${pctTxt} vs förra 4 v</span>
    </div>`;
  }).join('')}</div>`;

  // Sub text: target pace for race_time, plan-derived note otherwise.
  let subTxt = '';
  if (goal.target_distance_km && goal.target_value) {
    const totalSec = Number(goal.target_value);
    if (totalSec > 0) {
      const paceSec = totalSec / Number(goal.target_distance_km);
      subTxt = `${Number(goal.target_distance_km).toFixed(2)} km på ${_formatSecondsAsPace(totalSec)} · pace ${_formatSecondsAsPace(paceSec)}/km`;
    }
  }

  // "From your plan" block: shown only when this goal was auto-derived
  // from an active AI plan. Gives the user one-click context (which plan
  // is this tied to?) and a shortcut back to the schedule.
  let planBlockHtml = '';
  if (goal.goal_type === 'plan_derived_race' && _activePlan && goal.plan_id === _activePlan.id) {
    const planName = _activePlan.name || _activePlan.goal_text || 'Aktiv träningsplan';
    planBlockHtml = `<div class="goal-plan-block">
      <div class="goal-plan-block-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
      </div>
      <div class="goal-plan-block-text">
        <div class="goal-plan-block-label">Från ditt schema</div>
        <div class="goal-plan-block-name">${_escapeHtml(planName)}</div>
      </div>
      <button type="button" class="btn btn-ghost btn-sm" onclick="navigate('dashboard')">Visa schema</button>
    </div>`;
  }

  // Probability pill: only when we have a quantitative target time AND a
  // qualifying VDOT history. _computeRaceProbability returns pct=null when
  // it can't project, in which case we fall back to a soft hint.
  let probabilityHtml = '';
  if (goal.target_distance_km && goal.target_value && Number(goal.target_value) > 0) {
    const prob = _computeRaceProbability(goal, workouts, ind);
    if (prob.pct !== null) {
      const targetTxt = _formatSecondsAsPace(Number(goal.target_value));
      const projTxt = prob.projection_sec
        ? `Projicerad tid på racedagen: ${_formatSecondsAsPace(prob.projection_sec)}`
        : '';
      probabilityHtml = `<div class="goal-probability goal-probability--${prob.cls}">
        <div class="gp-pct">${prob.pct}%</div>
        <div class="gp-text">
          <div class="gp-label">${prob.label} att klara ${_escapeHtml(targetTxt)}</div>
          ${projTxt ? `<div class="gp-detail">${_escapeHtml(projTxt)}</div>` : ''}
        </div>
      </div>`;
    } else {
      probabilityHtml = `<div class="goal-probability goal-probability--unknown">
        <div class="gp-pct">—</div>
        <div class="gp-text">
          <div class="gp-label">För lite data för sannolikhet</div>
          <div class="gp-detail">Logga några löppass med puls (≥ ${Math.round(VO2MAX_QUAL_HR_PCT * 100)} % HRmax) så projicerar vi racetiden.</div>
        </div>
      </div>`;
    }
  }

  const canDelete = goal.goal_type === 'race_time'; // plan-derived rides with the plan
  const deleteBtn = canDelete
    ? `<button type="button" class="goal-card-menu" aria-label="Ta bort mål" onclick="confirmDeleteGoal('${goal.id}')">×</button>`
    : '';

  return `<div class="card goal-card goal-card--race" data-goal-id="${goal.id}">
    <div class="goal-card-header">
      <div class="goal-card-title-wrap">
        <div class="goal-card-title">${_escapeHtml(goal.title)}</div>
        ${subTxt ? `<div class="goal-card-sub">${_escapeHtml(subTxt)}</div>` : ''}
      </div>
      ${deleteBtn}
    </div>
    ${planBlockHtml}
    ${probabilityHtml}
    ${timelineHtml}
    ${indicatorsHtml}
  </div>`;
}

function _escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Add / delete goal ───────────────────────────────────────────────────

function openAddGoalSheet() {
  const modal = document.getElementById('goal-add-modal');
  if (!modal) return;
  const errEl = document.getElementById('goal-add-error');
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
  document.getElementById('goal-add-form')?.reset();
  // Default-fill target date 8 weeks out for race goals.
  const dateEl = document.getElementById('goal-race-date');
  if (dateEl) {
    const d = addDays(new Date(), 56);
    dateEl.value = isoDate(d);
  }
  onGoalTypeChange();
  onRaceDistancePresetChange();
  modal.classList.remove('hidden');
  // Wire focus trap + Escape via the standard Dialog helper.
  openDialog('goal-add-modal');
}

function closeAddGoalSheet() {
  document.getElementById('goal-add-modal')?.classList.add('hidden');
  closeDialog('goal-add-modal');
}

function onGoalTypeChange() {
  const type = document.getElementById('goal-type-select')?.value;
  const periodBlock = document.getElementById('goal-fields-period');
  const raceBlock = document.getElementById('goal-fields-race');
  if (!periodBlock || !raceBlock) return;
  const isRace = type === 'race_time';
  periodBlock.hidden = isRace;
  raceBlock.hidden = !isRace;
  // Sensible unit default per type.
  const unitEl = document.getElementById('goal-target-unit');
  if (unitEl && !isRace) {
    unitEl.value = type === 'count_per_period' ? 'workouts' : 'km';
  }
}

function onRaceDistancePresetChange() {
  const sel = document.getElementById('goal-race-distance')?.value;
  const wrap = document.getElementById('goal-race-custom-wrap');
  if (!wrap) return;
  wrap.hidden = sel !== 'custom';
}

function _readAddGoalForm() {
  const type = document.getElementById('goal-type-select').value;
  const titleRaw = document.getElementById('goal-title-input').value.trim();

  if (type === 'distance_per_period' || type === 'count_per_period') {
    const target = Number(document.getElementById('goal-target-value').value);
    const unit = document.getElementById('goal-target-unit').value;
    const period = document.getElementById('goal-period-select').value;
    if (!target || target <= 0) throw new Error('Ange ett positivt mål-värde.');
    const unitLabels = { km: 'km', workouts: 'pass', minutes: 'minuter' };
    const periodLabels = { week: 'vecka', month: 'månad', year: 'år' };
    const title = titleRaw || `${target} ${unitLabels[unit]} / ${periodLabels[period]}`;
    return {
      goal_type: type,
      title,
      target_value: target,
      target_unit: unit,
      period,
      period_anchor: isoDate(new Date()),
    };
  }

  // race_time
  const distSel = document.getElementById('goal-race-distance').value;
  const distKm = distSel === 'custom'
    ? Number(document.getElementById('goal-race-custom-km').value)
    : Number(distSel);
  if (!distKm || distKm <= 0) throw new Error('Ange distans.');
  const h = Number(document.getElementById('goal-race-hours').value) || 0;
  const m = Number(document.getElementById('goal-race-minutes').value) || 0;
  const s = Number(document.getElementById('goal-race-seconds').value) || 0;
  const totalSec = h * 3600 + m * 60 + s;
  if (totalSec <= 0) throw new Error('Ange måltid.');
  const dateStr = document.getElementById('goal-race-date').value;
  if (!dateStr) throw new Error('Ange måldatum.');
  const distLabel = distKm === 21.0975 ? 'Halvmaraton' : distKm === 42.195 ? 'Maraton' : `${distKm} km`;
  const title = titleRaw || `${distLabel} på ${_formatSecondsAsPace(totalSec)}`;
  return {
    goal_type: 'race_time',
    title,
    target_value: totalSec,
    target_unit: 'seconds',
    target_distance_km: distKm,
    target_date: dateStr,
    baseline_date: isoDate(new Date()),
  };
}

async function submitAddGoal() {
  const btn = document.getElementById('goal-add-submit');
  const errEl = document.getElementById('goal-add-error');
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
  let payload;
  try {
    payload = _readAddGoalForm();
  } catch (e) {
    if (errEl) { errEl.textContent = e.message; errEl.hidden = false; }
    return;
  }
  if (!currentProfile) {
    if (errEl) { errEl.textContent = 'Profil ej laddad — försök igen om en stund.'; errEl.hidden = false; }
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = 'Sparar…'; }
  try {
    payload.profile_id = currentProfile.id;
    const { data, error } = await sb.from('user_goals').insert(payload).select().single();
    if (error) throw error;
    _userGoals.unshift(data);
    closeAddGoalSheet();
    renderGoals(window._lastSeasonWorkouts || []);
    showToast('Mål tillagt');
  } catch (e) {
    console.error('Add goal failed:', e);
    if (errEl) { errEl.textContent = e.message || 'Kunde inte spara målet.'; errEl.hidden = false; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Spara'; }
  }
}

async function confirmDeleteGoal(goalId) {
  if (!goalId) return;
  if (!confirm('Ta bort det här målet?')) return;
  try {
    const { error } = await sb.from('user_goals').delete().eq('id', goalId);
    if (error) throw error;
    _userGoals = _userGoals.filter((g) => g.id !== goalId);
    renderGoals(window._lastSeasonWorkouts || []);
    showToast('Mål borttaget');
  } catch (e) {
    console.error('Delete goal failed:', e);
    showToast('Kunde inte ta bort målet');
  }
}

function renderSeasonTotals(workouts) {
  window._lastSeasonWorkouts = workouts;

  const now = new Date();
  const curYear = now.getFullYear();
  const curYearStart = new Date(curYear, 0, 1);
  // Same calendar day in previous year. Truncating both windows to the
  // same year-relative day-of-year gives us an apples-to-apples YTD-vs-YTD
  // comparison ("Where are you now compared to where you were on this
  // exact date last year?").
  const prevYearSameDay = new Date(curYear - 1, now.getMonth(), now.getDate());
  const prevYearStart = new Date(curYear - 1, 0, 1);

  function inWindow(w, start, end) {
    if (!w.workout_date) return false;
    const d = new Date(w.workout_date + 'T00:00:00');
    return d >= start && d <= end;
  }
  const ytdNow = workouts.filter((w) => inWindow(w, curYearStart, now));
  const ytdPrev = workouts.filter((w) => inWindow(w, prevYearStart, prevYearSameDay));

  const sumHours = (arr) => arr.reduce((s, w) => s + (w.duration_minutes || 0), 0) / 60;
  const sumKm = (arr) => arr.reduce((s, w) => s + (w.distance_km || 0), 0);
  const sumElev = (arr) => arr.reduce((s, w) => s + (w.elevation_gain_m || 0), 0);

  const ytdSessionsNow = ytdNow.length;
  const ytdSessionsPrev = ytdPrev.length;
  const ytdHoursNow = sumHours(ytdNow);
  const ytdHoursPrev = sumHours(ytdPrev);
  const ytdKmNow = sumKm(ytdNow);
  const ytdKmPrev = sumKm(ytdPrev);
  const ytdElevNow = sumElev(ytdNow);
  const ytdElevPrev = sumElev(ytdPrev);

  // Format the YoY delta as a small pill under each stat. We compare YTD
  // up to today vs the same calendar window last year so the pill is
  // apples-to-apples (not "this year so far vs full last year"). Hide the
  // pill entirely if there's no history a year back to avoid misleading
  // "+∞%" or noisy "—" labels.
  function yoyPill(cur, prev) {
    if (!prev || prev === 0) return '';
    const pct = Math.round(((cur - prev) / prev) * 100);
    const sign = pct > 0 ? '+' : '';
    const cls = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
    return `<span class="season-stat-yoy ${cls}" title="Hittills i år vs samma datum ${curYear - 1}">${sign}${pct}% vs samma datum ${curYear - 1}</span>`;
  }

  // Update the card title to make the YTD scope explicit. Previously the
  // big numbers showed lifetime totals while the pill compared YTD — now
  // both numbers and pills are YTD, so the heading reflects that.
  const titleEl = document.querySelector('#season-totals-card .card-title, #season-totals-card h3, [data-season-totals-title]');
  if (titleEl && !titleEl.dataset.ytdLabeled) {
    titleEl.textContent = `Säsongstotaler (${curYear})`;
    titleEl.dataset.ytdLabeled = '1';
  }

  const summaryEl = document.getElementById('season-totals-summary');
  if (summaryEl) {
    summaryEl.innerHTML = `<div class="season-totals-grid">
      <div class="season-stat">
        <span class="season-stat-val">${ytdSessionsNow}</span>
        <span class="season-stat-label">Pass</span>
        ${yoyPill(ytdSessionsNow, ytdSessionsPrev)}
      </div>
      <div class="season-stat">
        <span class="season-stat-val">${ytdHoursNow.toFixed(1)}h</span>
        <span class="season-stat-label">Timmar</span>
        ${yoyPill(ytdHoursNow, ytdHoursPrev)}
      </div>
      <div class="season-stat">
        <span class="season-stat-val">${ytdKmNow.toFixed(0)}km</span>
        <span class="season-stat-label">Distans</span>
        ${yoyPill(ytdKmNow, ytdKmPrev)}
      </div>
      <div class="season-stat">
        <span class="season-stat-val">${Math.round(ytdElevNow).toLocaleString('sv-SE')}m</span>
        <span class="season-stat-label">Höjdmeter</span>
        ${yoyPill(ytdElevNow, ytdElevPrev)}
      </div>
    </div>`;
  }

  renderSeasonActivityBars(workouts, _seasonBarMode);
}

function renderSeasonActivityBars(workouts, mode) {
  const byType = {};
  workouts.forEach(w => {
    if (!byType[w.activity_type]) byType[w.activity_type] = { hours: 0, km: 0 };
    byType[w.activity_type].hours += w.duration_minutes / 60;
    byType[w.activity_type].km += (w.distance_km || 0);
  });

  const types = Object.keys(byType).sort((a, b) => byType[b][mode === 'km' ? 'km' : 'hours'] - byType[a][mode === 'km' ? 'km' : 'hours']);
  const maxVal = Math.max(...types.map(t => byType[t][mode === 'km' ? 'km' : 'hours']), 1);

  const barsEl = document.getElementById('season-activity-bars');
  if (!barsEl) return;

  barsEl.innerHTML = types.map(t => {
    const val = mode === 'km' ? byType[t].km : byType[t].hours;
    const pct = Math.round((val / maxVal) * 100);
    const label = mode === 'km' ? val.toFixed(1) + ' km' : val.toFixed(1) + 'h';
    const color = ACTIVITY_COLORS[t] || '#555';
    return `<div class="season-bar-row">
      <span class="season-bar-label">${t}</span>
      <div class="season-bar-track">
        <div class="season-bar-fill" style="width:${pct}%;background:${color};">${label}</div>
      </div>
    </div>`;
  }).join('');
}

// Sprint 3: Effort target band.
// We compute a rolling 3-week mean of prior weeks' Effort, build a
// ±EFFORT_BAND_PCT band around it, and color-code the bars based on
// whether that week landed under / inside / over the band. Same idea as
// Strava's Relative Effort coach: "is this week consistent with what
// you've been doing, or is it a silent jump that'll bite you later?"
const EFFORT_BAND_LOOKBACK = 3;     // weeks of history used to build the band
const EFFORT_BAND_PCT = 0.15;       // ±15 % around the rolling mean
const EFFORT_BAND_FILL = 'rgba(56,178,124,0.10)';
const EFFORT_BAR_COLORS = {
  on:      { fill: 'rgba(56,178,124,0.55)', border: 'rgba(56,178,124,0.95)' },
  under:   { fill: 'rgba(243,156,18,0.55)', border: 'rgba(243,156,18,0.95)' },
  over:    { fill: 'rgba(231,76,60,0.55)',  border: 'rgba(231,76,60,0.95)' },
  neutral: { fill: 'rgba(214,99,158,0.50)', border: 'rgba(214,99,158,0.85)' },
};

function _effortBandClassify(effortData) {
  // Returns parallel arrays:
  //   targetUpper / targetLower — null where we don't yet have enough history
  //   classes — 'under' | 'on' | 'over' | 'neutral' (the latter for ungraded weeks)
  const targetUpper = new Array(effortData.length).fill(null);
  const targetLower = new Array(effortData.length).fill(null);
  const classes = new Array(effortData.length).fill('neutral');
  for (let i = 0; i < effortData.length; i++) {
    if (i < EFFORT_BAND_LOOKBACK) continue;
    let sum = 0;
    let cnt = 0;
    for (let j = i - EFFORT_BAND_LOOKBACK; j < i; j++) {
      sum += effortData[j];
      cnt++;
    }
    if (cnt === 0) continue;
    const mean = sum / cnt;
    if (mean <= 0.01) continue; // no meaningful baseline yet
    targetLower[i] = +(mean * (1 - EFFORT_BAND_PCT)).toFixed(2);
    targetUpper[i] = +(mean * (1 + EFFORT_BAND_PCT)).toFixed(2);
    const v = effortData[i];
    if (v < targetLower[i]) classes[i] = 'under';
    else if (v > targetUpper[i]) classes[i] = 'over';
    else classes[i] = 'on';
  }
  return { targetUpper, targetLower, classes };
}

function renderMixChart(workouts) {
  const mixCanvas = document.getElementById('chart-mix-personal');
  if (!mixCanvas) return;
  if (chartMixPersonal) chartMixPersonal.destroy();

  const isNorm = effortMode === 'normalized';
  const yUnit = isNorm ? ' belastning' : 'h';
  const mixIsKm = _mixUnit === 'km';
  const mixYUnit = mixIsKm ? ' km' : yUnit;
  const mixTitleEl = document.getElementById('trends-mix-title');
  if (mixTitleEl) mixTitleEl.textContent = mixIsKm ? 'Aktivitetsmix (km)' : (isNorm ? 'Aktivitetsmix (belastning)' : 'Aktivitetsmix (timmar)');

  const weekWorkouts = {};
  workouts.forEach(w => {
    const mon = mondayOfWeek(new Date(w.workout_date));
    const key = isoDate(mon);
    if (!weekWorkouts[key]) weekWorkouts[key] = [];
    weekWorkouts[key].push(w);
  });
  const allDataWeeks = Object.keys(weekWorkouts).sort();
  if (allDataWeeks.length === 0) return;
  const allWeekKeys = _buildContiguousWeeks(allDataWeeks[0], allDataWeeks[allDataWeeks.length - 1]);
  const win = _sliceWeekWindow(allWeekKeys, window._weeklyChartAnchor['chart-mix-personal'], _getChartWindowSize('chart-mix-personal'));
  const visibleWeeks = win.weeks;

  const labels = visibleWeeks.map(w => {
    const mon = parseISOWeekKeyLocal(w);
    const wn = weekNumber(mon);
    return isDeloadWeek(mon) ? `V${wn} (D)` : `V${wn}`;
  });

  const types = ['Löpning', 'Cykel', 'Gym', 'Annat', 'Hyrox', 'Stakmaskin', 'Längdskidor'];

  // Per-week effort cache only when needed.
  const weekEffortByType = {};
  if (isNorm && !mixIsKm) {
    visibleWeeks.forEach(w => {
      weekEffortByType[w] = {};
      (weekWorkouts[w] || []).forEach(wo => {
        weekEffortByType[w][wo.activity_type] = (weekEffortByType[w][wo.activity_type] || 0) + calcWorkoutEffort(wo);
      });
    });
  }

  const datasets = types.filter(t => visibleWeeks.some(w => {
    const wos = (weekWorkouts[w] || []).filter(wo => wo.activity_type === t);
    if (mixIsKm) return wos.reduce((s, wo) => s + (wo.distance_km || 0), 0) > 0;
    if (isNorm) return (weekEffortByType[w]?.[t] || 0) > 0;
    return wos.reduce((s, wo) => s + durationWeightedHours(wo), 0) > 0;
  })).map(t => ({
    label: t,
    data: visibleWeeks.map(w => {
      const wos = (weekWorkouts[w] || []).filter(wo => wo.activity_type === t);
      if (mixIsKm) return +wos.reduce((s, wo) => s + (wo.distance_km || 0), 0).toFixed(1);
      if (isNorm) return +effortRawToDisplay(weekEffortByType[w]?.[t] || 0).toFixed(2);
      return +wos.reduce((s, wo) => s + durationWeightedHours(wo), 0).toFixed(2);
    }),
    backgroundColor: ACTIVITY_COLORS[t] || '#555',
    borderRadius: 4
  }));

  chartMixPersonal = new Chart(mixCanvas.getContext('2d'), {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { color: '#aaa', usePointStyle: true, boxWidth: 12 } },
        tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.parsed.y.toFixed(1)}${mixYUnit}` } }
      },
      scales: {
        y: { stacked: true, beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#888', callback: v => v.toFixed(1) + mixYUnit } },
        x: { stacked: true, grid: { display: false }, ticks: { color: '#888' } }
      }
    }
  });

  _renderChartWeekNav('chart-mix-personal', allWeekKeys.length, win, () => renderMixChart(workouts));
}

function renderEffortChart(workouts) {
  const effortCanvas = document.getElementById('chart-effort');
  if (!effortCanvas) return;
  if (window._chartEffort) window._chartEffort.destroy();

  const weekMap = {};
  // Group raw workouts per ISO-Monday week so the diagnostic below can list
  // which sessions actually contributed to each bar (or didn't, when a week
  // shows zero in the chart).
  const weekRaw = {};
  workouts.forEach(w => {
    const d = new Date(w.workout_date);
    const mon = mondayOfWeek(d);
    const key = isoDate(mon);
    if (!weekMap[key]) weekMap[key] = { effort: 0, hours: 0 };
    weekMap[key].effort += calcWorkoutEffort(w);
    weekMap[key].hours += (w.duration_minutes || 0) / 60;
    if (!weekRaw[key]) weekRaw[key] = [];
    weekRaw[key].push(w);
  });

  const dataWeeks = Object.keys(weekMap).sort();
  if (dataWeeks.length === 0) return;
  // Contiguous Monday timeline (fills gaps so the X axis is monotonic in
  // real time and "V25 → V8" jumps disappear).
  const allWeekKeys = _buildContiguousWeeks(dataWeeks[0], dataWeeks[dataWeeks.length - 1]);
  // Compute the FULL effort/hours/class series on the contiguous timeline so
  // the rolling band lookback stays anchored to real calendar weeks regardless
  // of which 12-week window the user is currently viewing.
  const effortDataAll = allWeekKeys.map(w => +effortRawToDisplay((weekMap[w]?.effort) || 0).toFixed(2));
  const hoursDataAll = allWeekKeys.map(w => +((weekMap[w]?.hours) || 0).toFixed(1));
  const isDeloadAll = allWeekKeys.map(w => isDeloadWeek(parseISOWeekKeyLocal(w)));
  const { targetUpper: targetUpperAll, targetLower: targetLowerAll, classes: classesAll } = _effortBandClassify(effortDataAll);

  // Slice down to the visible window (size selectable: 6 / 12 / 36).
  const win = _sliceWeekWindow(allWeekKeys, window._weeklyChartAnchor['chart-effort'], _getChartWindowSize('chart-effort'));
  const visibleWeeks = win.weeks;
  const effortData = effortDataAll.slice(win.startIdx, win.endIdx + 1);
  const hoursData = hoursDataAll.slice(win.startIdx, win.endIdx + 1);
  const isDeload = isDeloadAll.slice(win.startIdx, win.endIdx + 1);
  const targetUpper = targetUpperAll.slice(win.startIdx, win.endIdx + 1);
  const targetLower = targetLowerAll.slice(win.startIdx, win.endIdx + 1);
  const classes = classesAll.slice(win.startIdx, win.endIdx + 1);

  const labels = visibleWeeks.map((w, i) => {
    const mon = parseISOWeekKeyLocal(w);
    const wn = weekNumber(mon);
    return isDeload[i] ? `V${wn} (D)` : `V${wn}`;
  });

  // Bars: color per classification. Deload weeks that classify as 'under'
  // are kept as 'under' (amber) — that's actually informative ("yes you
  // dropped, and that was planned"), but we exclude deloads from the
  // X-of-Y subtitle counter so the score isn't penalised for planned dips.
  const barFills = classes.map((c) => EFFORT_BAR_COLORS[c].fill);
  const barBorders = classes.map((c) => EFFORT_BAR_COLORS[c].border);

  const textColor = getComputedStyle(document.body).getPropertyValue('--text-dim').trim() || '#888';

  window._chartEffort = new Chart(effortCanvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        // Bars come first so legend ordering stays familiar; draw order is
        // controlled with `order:` so the band still renders behind them.
        {
          label: 'Belastning (staplar)',
          data: effortData,
          backgroundColor: barFills,
          borderColor: barBorders,
          borderWidth: 1,
          borderRadius: 3,
          order: 2,
        },
        // Upper edge of the rolling target band. We fill DOWN from this
        // line to the lower-edge dataset (`fill: '+1'` = the next dataset
        // in the data array). spanGaps:false so missing band ends in the
        // first 3 weeks visibly leave the band un-drawn instead of
        // interpolating across them.
        {
          label: `Mål-band (rullande ${EFFORT_BAND_LOOKBACK}v ±${Math.round(EFFORT_BAND_PCT * 100)} %)`,
          data: targetUpper,
          type: 'line',
          borderColor: 'rgba(56,178,124,0.45)',
          backgroundColor: EFFORT_BAND_FILL,
          borderWidth: 1,
          borderDash: [4, 3],
          pointRadius: 0,
          fill: '+1',
          spanGaps: false,
          order: 4,
        },
        {
          label: '_band-lower',
          data: targetLower,
          type: 'line',
          borderColor: 'rgba(56,178,124,0.45)',
          borderWidth: 1,
          borderDash: [4, 3],
          pointRadius: 0,
          fill: false,
          spanGaps: false,
          order: 4,
        },
        {
          label: 'Timmar',
          data: hoursData,
          type: 'line',
          borderColor: 'rgba(46,134,193,0.7)',
          backgroundColor: 'rgba(46,134,193,0.1)',
          borderWidth: 2,
          pointRadius: 3,
          fill: false,
          order: 1,
          yAxisID: 'y1',
        }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            color: textColor, usePointStyle: true, boxWidth: 12,
            // Hide the lower-band dataset from the legend — it's just a
            // technical companion to the upper band's fill target.
            filter: (item) => item.text !== '_band-lower',
          },
        },
        tooltip: {
          callbacks: {
            label: (c) => {
              if (c.dataset.label === 'Belastning (staplar)') {
                return `Belastning: ${c.parsed.y.toFixed(1)}`;
              }
              if (c.dataset.label === 'Timmar') {
                return `Timmar: ${c.parsed.y.toFixed(1)} h`;
              }
              if (c.dataset.label === '_band-lower') return null;
              // Upper-band line tooltip
              const lo = targetLower[c.dataIndex];
              const hi = c.parsed.y;
              if (lo === null || hi === null) return null;
              return `Mål-band: Belastning ${lo.toFixed(1)}–${hi.toFixed(1)}`;
            },
            afterBody: (items) => {
              if (!items.length) return [];
              const i = items[0].dataIndex;
              const cls = classes[i];
              if (cls === 'neutral') return ['Inget mål-band än (behöver 3 v historik).'];
              if (isDeload[i]) {
                if (cls === 'under') return ['Planerad deload — under bandet by design.'];
              }
              const labelMap = {
                on: 'Inom mål-bandet',
                under: 'Under bandet — för låg belastning',
                over: 'Över bandet — risk för översatsning',
              };
              return [labelMap[cls]];
            },
          }
        }
      },
      scales: {
        y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: textColor }, title: { display: true, text: 'Belastning (skalad)', color: textColor } },
        y1: { beginAtZero: true, position: 'right', grid: { display: false }, ticks: { color: textColor, callback: v => v + 'h' }, title: { display: true, text: 'Timmar', color: textColor } },
        x: { grid: { display: false }, ticks: { color: textColor, maxRotation: 45, minRotation: 0 } }
      }
    }
  });

  // Insight: count classifications strictly within the visible 12 w window so
  // the subtitle ("X över / Y under") always matches the colored bars the
  // user can actually see. Earlier behaviour walked the FULL series back-
  // wards and produced "3 över / 4 under" while the chart on screen showed
  // 5 över / 1 under — confusing because the counter was sourced from older
  // weeks scrolled off the visible window. Deload weeks are still skipped
  // from the count because they're planned dips, not signal — but they
  // remain visible as bars.
  const gradedVisible = [];
  for (let i = 0; i < classes.length; i++) {
    if (classes[i] === 'neutral') continue;
    if (isDeload[i]) continue;
    gradedVisible.push(classes[i]);
  }
  if (gradedVisible.length === 0) {
    _renderChartInsight('effort-insight', {
      band: 'neutral',
      title: 'Inte graderad än',
      sub: `Bygg ≥ ${EFFORT_BAND_LOOKBACK + 1} v historik så ritar vi mål-bandet.`,
    });
  } else {
    const onCnt = gradedVisible.filter((c) => c === 'on').length;
    const overCnt = gradedVisible.filter((c) => c === 'over').length;
    const underCnt = gradedVisible.filter((c) => c === 'under').length;
    const total = gradedVisible.length;
    // Headline title still reflects "this week" so it stays actionable.
    const lastCls = classes[classes.length - 1];
    const lastDeload = isDeload[isDeload.length - 1];
    let title, band;
    if (lastDeload) { title = 'Planerad deload'; band = 'neutral'; }
    else if (lastCls === 'on') { title = 'I bandet denna vecka'; band = 'ok'; }
    else if (lastCls === 'over') { title = 'För hög denna vecka'; band = 'bad'; }
    else if (lastCls === 'under') { title = 'För låg denna vecka'; band = 'warn'; }
    else { title = 'Inte graderad än'; band = 'neutral'; }
    _renderChartInsight('effort-insight', {
      band,
      title,
      sub: `${onCnt} i bandet · ${overCnt} över · ${underCnt} under (av ${total} graderade veckor i fönstret)`,
    });
  }

  const legendEl = document.getElementById('effort-legend');
  if (legendEl) {
    legendEl.innerHTML = `
      <div class="effort-legend-item"><span class="effort-legend-dot" style="background:${EFFORT_BAR_COLORS.on.border}"></span> Inom bandet — konsekvent med dina senaste ${EFFORT_BAND_LOOKBACK} v.</div>
      <div class="effort-legend-item"><span class="effort-legend-dot" style="background:${EFFORT_BAR_COLORS.over.border}"></span> Över bandet (>+${Math.round(EFFORT_BAND_PCT * 100)} %) — kolla återhämtning innan nästa hårda pass.</div>
      <div class="effort-legend-item"><span class="effort-legend-dot" style="background:${EFFORT_BAR_COLORS.under.border}"></span> Under bandet (&lt;−${Math.round(EFFORT_BAND_PCT * 100)} %) — låg vecka. OK om planerad deload.</div>
      <div class="effort-legend-item"><span class="effort-legend-dot" style="background:${EFFORT_BAR_COLORS.neutral.border}"></span> Inte graderad än — färre än ${EFFORT_BAND_LOOKBACK} v historik.</div>
      <div class="effort-legend-item effort-legend-meta">Belastning = normaliserad träningsbelastning (rå score ÷ ${EFFORT_DISPLAY_DIVISOR} ≈ 1 h @ MET 10). Bandet = ±${Math.round(EFFORT_BAND_PCT * 100)} % runt rullande ${EFFORT_BAND_LOOKBACK}-veckorssnitt av föregående veckor.</div>
    `;
  }

  _renderChartWeekNav('chart-effort', allWeekKeys.length, win, () => renderEffortChart(workouts));

  // Diagnostic: when the user reports "this week was 0 in the chart but I
  // logged passes", flip on window.__DIAG_EFFORT in DevTools and reload to
  // dump every workout the chart saw per visible week, plus the values it
  // computed. Tells us instantly whether the cause is "no workouts in
  // myWorkouts" vs "workouts present but duration_minutes is 0/null" vs
  // "calcWorkoutEffort returned 0 because of activity_type / IM".
  if (window.__DIAG_EFFORT) {
    try {
      // eslint-disable-next-line no-console
      console.groupCollapsed('[effort-chart diag] visible window per-week dump');
      visibleWeeks.forEach((wk, i) => {
        const mon = parseISOWeekKeyLocal(wk);
        const wn = weekNumber(mon);
        const sessions = weekRaw[wk] || [];
        const rawEff = (weekMap[wk]?.effort) || 0;
        const hrs = (weekMap[wk]?.hours) || 0;
        // eslint-disable-next-line no-console
        console.groupCollapsed(`V${wn} (${wk}) — ${sessions.length} pass · effort=${effortData[i]} · timmar=${hoursData[i]} · klass=${classes[i]}`);
        sessions.forEach((w) => {
          // eslint-disable-next-line no-console
          console.log({
            id: w.id,
            date: w.workout_date,
            type: w.activity_type,
            source: w.source,
            durationMin: w.duration_minutes,
            distanceKm: w.distance_km,
            intensity: w.intensity,
            avgHr: w.avg_hr,
            rpe: w.perceived_exertion,
            calcEffortRaw: calcWorkoutEffort(w),
          });
        });
        if (sessions.length === 0) {
          // eslint-disable-next-line no-console
          console.log('— inga pass i denna vecka enligt myWorkouts —');
        }
        // eslint-disable-next-line no-console
        console.log({ weeklyEffortRaw: rawEff, weeklyHoursRaw: hrs });
        // eslint-disable-next-line no-console
        console.groupEnd();
      });
      // eslint-disable-next-line no-console
      console.groupEnd();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[effort-chart diag] dump failed', e);
    }
  } else {
    // eslint-disable-next-line no-console
    console.info('[effort-chart] sätt window.__DIAG_EFFORT = true och kör loadTrends() för att dumpa V6–V9-detaljer i konsolen.');
  }
}

// ─────────────────────────────────────────────────────────────
//  Performance Management Chart: CTL (42d), ATL (7d), TSB (CTL−ATL).
//  Impulse = per-day summed calcWorkoutEffort (raw), then EWMA per TrainingPeaks.
// ─────────────────────────────────────────────────────────────

function _dailyLoadSeries(workouts, days = 120) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = addDays(today, -(days - 1));
  const series = [];
  const byDate = new Map();
  for (const w of workouts) {
    if (!w.workout_date) continue;
    const d = w.workout_date;
    byDate.set(d, (byDate.get(d) || 0) + calcWorkoutEffort(w));
  }
  for (let i = 0; i < days; i++) {
    const d = addDays(start, i);
    const iso = isoDate(d);
    series.push({ date: iso, load: byDate.get(iso) || 0 });
  }
  return series;
}

function _ewma(values, tau) {
  const alpha = 1 - Math.exp(-1 / tau);
  let prev = 0;
  const out = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    prev = prev + alpha * (values[i] - prev);
    out[i] = prev;
  }
  return out;
}

// Day-index used as the "where I started" anchor for the personal
// fitness score. CTL is an EWMA with tau=42d, so we wait ~30 days for the
// curve to settle into a meaningful baseline before we anchor to it. New
// users with less history get a "bygger baseline" insight instead of a
// noisy ratio that explodes on tiny denominators.
const FITNESS_BASELINE_DAY = 28;
const FITNESS_BASELINE_MIN_CTL = 1.0;

function renderPmcChart(workouts) {
  const ctlCanvas = document.getElementById('chart-pmc-ctl');
  if (!ctlCanvas || typeof Chart === 'undefined') return;
  if (window._chartPmcCtl) window._chartPmcCtl.destroy();

  // Find earliest workout so we can build the FULL CTL history (needed for
  // the personal fitness baseline). The chart itself only shows the latest
  // 12 ISO weeks (matching every other progress chart's cadence), but the
  // ratio denominator is still anchored to the user's first month of
  // training so the headline number is comparable across windows.
  const allDates = [];
  for (const w of workouts) if (w.workout_date) allDates.push(w.workout_date);
  if (allDates.length === 0) {
    _renderChartInsight('pmc-ctl-insight', { band: 'neutral', title: 'För lite data', sub: 'Logga några pass så fylls fitness-kurvan i.' });
    return;
  }
  allDates.sort();
  const firstDate = allDates[0];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const firstDateObj = new Date(firstDate + 'T00:00:00');
  const totalDays = Math.max(1, Math.round((today - firstDateObj) / 86400000) + 1);

  const fullSeries = _dailyLoadSeries(workouts, totalDays);
  if (fullSeries.every((s) => s.load === 0)) {
    _renderChartInsight('pmc-ctl-insight', { band: 'neutral', title: 'För lite data', sub: 'Logga några pass så fylls fitness-kurvan i.' });
    return;
  }

  // Scale raw effort to Effort display so the EWMA values align with the
  // Effort chart. CTL (42d EWMA) is the only series we plot now — Formtopp
  // (TSB-based 0–100 score) was retired because the line stayed flat near
  // the middle of the 0–100 range for steady trainers.
  const fullLoads = fullSeries.map((s) => effortRawToDisplay(s.load));
  const fullCtl = _ewma(fullLoads, 42);

  // Personal fitness baseline = CTL on day FITNESS_BASELINE_DAY of the
  // user's training history (or null if they don't have that much data
  // yet, or their CTL still hasn't crossed the meaningful-baseline floor).
  let baselineCtl = null;
  let baselineDateIso = null;
  if (fullCtl.length > FITNESS_BASELINE_DAY) {
    const candidate = fullCtl[FITNESS_BASELINE_DAY];
    if (candidate >= FITNESS_BASELINE_MIN_CTL) {
      baselineCtl = candidate;
      baselineDateIso = fullSeries[FITNESS_BASELINE_DAY]?.date || null;
    }
  }

  // Aggregate the daily CTL into ISO-week buckets so the x-axis can use
  // V-numbers like every other Din progress chart. We take the mean of the
  // CTL values within each week — CTL itself is already a smoothed EWMA so
  // the weekly mean just resamples it at a coarser cadence without losing
  // trend information.
  const weekAgg = new Map(); // mondayIso -> { sum, count }
  for (let i = 0; i < fullSeries.length; i++) {
    const dayIso = fullSeries[i].date;
    const monIso = isoDate(mondayOfWeek(new Date(dayIso + 'T00:00:00')));
    if (!weekAgg.has(monIso)) weekAgg.set(monIso, { sum: 0, count: 0 });
    const e = weekAgg.get(monIso);
    e.sum += fullCtl[i];
    e.count++;
  }
  const dataWeeks = [...weekAgg.keys()].sort();
  if (dataWeeks.length === 0) {
    _renderChartInsight('pmc-ctl-insight', { band: 'neutral', title: 'För lite data', sub: 'Logga några pass så fylls fitness-kurvan i.' });
    return;
  }

  // Contiguous Monday timeline + 12-week sliding window navigator, same
  // pattern as renderEffortChart / renderEasyHrChart.
  const allWeekKeys = _buildContiguousWeeks(dataWeeks[0], dataWeeks[dataWeeks.length - 1]);
  const win = _sliceWeekWindow(allWeekKeys, window._weeklyChartAnchor['chart-pmc-ctl'], _getChartWindowSize('chart-pmc-ctl'));
  const visibleWeeks = win.weeks;
  const labels = visibleWeeks.map((k) => `V${weekNumber(parseISOWeekKeyLocal(k))}`);
  const ctl = visibleWeeks.map((k) => {
    const e = weekAgg.get(k);
    return e ? e.sum / e.count : null;
  });

  const textColor = getComputedStyle(document.body).getPropertyValue('--text-dim').trim() || '#888';
  const ctlColor = 'rgba(46, 134, 193, 0.9)';

  // Personal fitness score on #pmc-ctl-card. Either ratio (if we have a
  // baseline) or raw CTL fallback (if user is still building history).
  // The ratio version starts at ~1.0 and drifts upward as fitness improves
  // vs day 28 of training.
  const useRatio = baselineCtl !== null;
  const fitnessData = ctl.map((c) => {
    if (c === null) return null;
    return useRatio ? +(c / baselineCtl).toFixed(3) : +c.toFixed(2);
  });
  const yTitle = useRatio ? 'Fitness-score' : 'Belastning (bygger baseline)';
  const numericData = fitnessData.filter((v) => v !== null);
  const yMin = useRatio && numericData.length ? Math.max(0, Math.min(...numericData) * 0.95) : 0;
  window._chartPmcCtl = new Chart(ctlCanvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Fitness-score',
          data: fitnessData,
          borderColor: ctlColor,
          backgroundColor: 'rgba(46,134,193,0.15)',
          borderWidth: 2,
          pointRadius: 3,
          pointHoverRadius: 5,
          fill: true,
          tension: 0.25,
          spanGaps: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => useRatio
              ? `Fitness-score: ${c.parsed.y.toFixed(2)} (${(c.parsed.y * 100 - 100 >= 0 ? '+' : '') + (c.parsed.y * 100 - 100).toFixed(0)} % vs start)`
              : `Belastning: ${c.parsed.y.toFixed(1)}`,
          },
        },
      },
      scales: {
        y: {
          min: useRatio ? yMin : 0,
          beginAtZero: !useRatio,
          grid: { color: 'rgba(255,255,255,0.05)' },
          ticks: { color: textColor, callback: (v) => useRatio ? Number(v).toFixed(2) : Number(v).toFixed(1) },
          title: { display: true, text: yTitle, color: textColor },
        },
        x: {
          grid: { display: false },
          ticks: { color: textColor, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 },
        },
      },
    },
  });

  _renderChartWeekNav('chart-pmc-ctl', allWeekKeys.length, win, () => renderPmcChart(workouts));

  // Insight uses the FULL daily series so the headline always describes
  // "now", not whichever 12-week window the user happens to be browsing.
  const lastCtl = fullCtl[fullCtl.length - 1];

  if (baselineCtl !== null) {
    const ratio = lastCtl / baselineCtl;
    const ratioPct = (ratio - 1) * 100;
    const baselineDate = baselineDateIso
      ? (() => { const d = new Date(baselineDateIso + 'T00:00:00'); return `V${weekNumber(d)} ${d.getFullYear()}`; })()
      : 'start';
    const sub = ratio >= 1
      ? `+${ratioPct.toFixed(0)} % bättre än när du började mäta (${baselineDate}).`
      : `${ratioPct.toFixed(0)} % vs när du började mäta (${baselineDate}).`;
    _renderChartInsight('pmc-ctl-insight', {
      band: ratio >= 1.05 ? 'ok' : (ratio >= 0.95 ? 'neutral' : 'warn'),
      title: 'Personal fitness score',
      sub,
      headline: ratio.toFixed(2),
      headlineLabel: 'FITNESS',
    });
  } else {
    const daysSoFar = fullCtl.length;
    _renderChartInsight('pmc-ctl-insight', {
      band: 'neutral',
      title: 'Bygger baseline',
      sub: `${daysSoFar} av ${FITNESS_BASELINE_DAY} dagar tränings­historik. Vi anker fitness-scoren när vi har minst ${FITNESS_BASELINE_DAY} dagars data.`,
    });
  }
}

// ─────────────────────────────────────────────────────────────
//  Card UX helpers — generic info popover.
//  Used by Effort per vecka, Personal fitness score, and Group Effort.
//  NOTE: name intentionally avoids `togglePopover`, which is a native
//  HTMLElement method (Popover API). Inline `onclick` handlers resolve
//  identifiers against the element first, so a global `togglePopover`
//  gets shadowed by the button's built-in method and throws
//  NotSupportedError on non-popover elements.
// ─────────────────────────────────────────────────────────────
function toggleInfoPopover(popoverId, btnId) {
  const pop = document.getElementById(popoverId);
  const btn = btnId ? document.getElementById(btnId) : null;
  if (!pop) return;
  const open = pop.classList.toggle('hidden') === false;
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

if (typeof window !== 'undefined') {
  window.toggleInfoPopover = toggleInfoPopover;
}

// ─────────────────────────────────────────────────────────────
//  Polarization mix (last 4 weeks): easy (Z1-Z2) / mod (Z3) / hard (Z4-Z5).
//  Target for polarized training: ~80/0-10/20 by time-in-zone.
// ─────────────────────────────────────────────────────────────

const _POLARIZATION_BANDS = {
  easy: new Set(['Z1', 'Z2']),
  mod: new Set(['Z3', 'mixed']),
  hard: new Set(['Z4', 'Z5', 'Kvalitet']),
};

// Activities where avg_speed_kmh is a meaningful intensity proxy when HR
// data is missing. Indoor / strength / Hyrox don't get pace-based
// classification — they keep the existing "intensity tag → easy default"
// fallback.
const _PACE_PROXY_TYPES = new Set(['Löpning', 'Cykel', 'Vandring', 'Promenad']);

// Speed-ratio bands used by _classifyByPace. r = avg_speed_kmh / vT, where
// vT is the user's own threshold-speed proxy (95th percentile of recent
// sustained sessions for that activity type). Cycling is given a slightly
// wider window because terrain has a much bigger effect on average cycling
// speed than on running pace.
const _PACE_BANDS = {
  default: { easy: 0.76, hard: 0.88 },
  Cykel: { easy: 0.78, hard: 0.90 },
};

const _MIN_PACE_PROXY_SESSIONS = 3;
const _PACE_PROXY_MIN_DURATION_MIN = 12;
const _PACE_PROXY_LOOKBACK_DAYS = 84; // ~12 weeks
const _PACE_PROXY_PERCENTILE = 0.95;

// Auto-derive a per-user, per-activity-type threshold speed (km/h) from
// recent history. Returns null when there isn't enough qualifying data —
// callers must then skip the pace fallback for that activity type.
function _estimateThresholdSpeedKmh(workouts, activityType) {
  if (!Array.isArray(workouts)) return null;
  const today = new Date();
  const cutoffIso = isoDate(addDays(today, -_PACE_PROXY_LOOKBACK_DAYS));
  const speeds = [];
  for (const w of workouts) {
    if (w.activity_type !== activityType) continue;
    if (!w.workout_date || w.workout_date < cutoffIso) continue;
    if (!(w.duration_minutes >= _PACE_PROXY_MIN_DURATION_MIN)) continue;
    const sp = Number(w.avg_speed_kmh);
    if (!(sp > 0)) continue;
    speeds.push(sp);
  }
  if (speeds.length < _MIN_PACE_PROXY_SESSIONS) return null;
  speeds.sort((a, b) => a - b);
  const idx = Math.min(speeds.length - 1, Math.floor(_PACE_PROXY_PERCENTILE * (speeds.length - 1)));
  return speeds[idx] || null;
}

// Classify a single workout into easy/mod/hard seconds using its average
// speed compared to the per-user threshold proxy. Returns null when the
// workout doesn't have usable speed data.
function _classifyByPace(w, vT) {
  const sp = Number(w.avg_speed_kmh);
  const mins = w.duration_minutes || 0;
  if (!(sp > 0) || !(vT > 0) || mins <= 0) return null;
  const seconds = mins * 60;
  const bands = _PACE_BANDS[w.activity_type] || _PACE_BANDS.default;
  const r = sp / vT;
  if (r < bands.easy) return { easy: seconds, mod: 0, hard: 0 };
  if (r > bands.hard) return { easy: 0, mod: 0, hard: seconds };
  return { easy: 0, mod: seconds, hard: 0 };
}

function _classifyWorkoutIntensity(w, ctx) {
  if (w.activity_type === 'Vila') return null;
  if (w.hr_zone_seconds && Array.isArray(w.hr_zone_seconds) && w.hr_zone_seconds.length >= 5) {
    const [z1, z2, z3, z4, z5] = w.hr_zone_seconds;
    return { easy: (z1 || 0) + (z2 || 0), mod: z3 || 0, hard: (z4 || 0) + (z5 || 0), proxy: false };
  }
  const mins = w.duration_minutes || 0;
  if (mins <= 0) return null;
  const seconds = mins * 60;

  // Pace-based proxy when HR is missing but we have a per-user threshold
  // speed for this activity type. Slots in BEFORE the logged-intensity
  // tag so users without HR data get something meaningful even if they
  // didn't bother tagging the session manually.
  const vT = ctx && ctx.vTByType ? ctx.vTByType[w.activity_type] : null;
  if (vT && _PACE_PROXY_TYPES.has(w.activity_type)) {
    const cls = _classifyByPace(w, vT);
    if (cls) return { ...cls, proxy: true };
  }

  if (w.intensity && _POLARIZATION_BANDS.easy.has(w.intensity)) return { easy: seconds, mod: 0, hard: 0, proxy: false };
  if (w.intensity && _POLARIZATION_BANDS.mod.has(w.intensity)) return { easy: 0, mod: seconds, hard: 0, proxy: false };
  if (w.intensity && _POLARIZATION_BANDS.hard.has(w.intensity)) return { easy: 0, mod: 0, hard: seconds, proxy: false };
  // Default: treat unspecified as easy (common for low-intensity endurance).
  return { easy: seconds, mod: 0, hard: 0, proxy: false };
}

function renderPolarizationCard(workouts) {
  const legendEl = document.getElementById('polarization-legend');
  const segEasy = document.getElementById('pol-seg-easy');
  const segHard = document.getElementById('pol-seg-hard');
  if (!legendEl || !segEasy || !segHard) return;

  const warnBtn = document.getElementById('polarization-proxy-warn');
  const proxyPopover = document.getElementById('polarization-proxy-popover');
  const proxyShareLine = document.getElementById('polarization-proxy-share-line');

  const today = new Date();
  const cutoff = addDays(today, -28);
  const cutoffIso = isoDate(cutoff);
  const recent = workouts.filter((w) => w.workout_date && w.workout_date >= cutoffIso);

  // Build per-activity threshold-speed proxies from the FULL history we
  // have on hand (not just the last 28 days). A wider window gives a
  // more stable "fastest sustained" reference and avoids the proxy
  // collapsing during a deload week.
  const vTByType = {};
  for (const at of _PACE_PROXY_TYPES) {
    const vT = _estimateThresholdSpeedKmh(workouts, at);
    if (vT) vTByType[at] = vT;
  }
  const ctx = { vTByType };

  // Polarized model: only two buckets — easy (Z1-Z2) vs hard (Z3-Z5).
  // Z3 ("gråzonen") is folded into hard on purpose so time spent there
  // counts against the easy share, in line with the principle "Ingen
  // gråzon — antingen lugnt eller tydligt kvalitet".
  let easy = 0, hard = 0, modSeconds = 0, proxySeconds = 0;
  for (const w of recent) {
    const cls = _classifyWorkoutIntensity(w, ctx);
    if (!cls) continue;
    easy += cls.easy;
    hard += cls.hard + cls.mod;
    modSeconds += cls.mod;
    if (cls.proxy) proxySeconds += cls.easy + cls.mod + cls.hard;
  }
  const total = easy + hard;
  const proxyShare = total > 0 ? proxySeconds / total : 0;

  // Toggle the "proxy data" warning icon + popover line. We hide the
  // icon entirely below 5% so a single HR-less session in an otherwise
  // HR-rich window doesn't shout at the user.
  if (warnBtn) warnBtn.classList.toggle('hidden', proxyShare < 0.05);
  if (proxyPopover && proxyShare < 0.05) proxyPopover.classList.add('hidden');
  if (proxyShareLine) {
    proxyShareLine.textContent = proxyShare > 0
      ? `Cirka ${Math.round(proxyShare * 100)}% av tiden i mätaren är pace-uppskattad.`
      : '';
  }

  if (total === 0) {
    segEasy.style.width = '100%'; segHard.style.width = '0%';
    segEasy.style.background = 'var(--bg-card-hover)';
    segEasy.textContent = ''; segHard.textContent = '';
    legendEl.innerHTML = '';
    _renderChartInsight('polarization-insight', {
      band: 'neutral',
      title: 'För lite data',
      sub: 'Logga några pass så fylls mätaren.',
    });
    return;
  }
  const pEasy = (easy / total) * 100;
  const pHard = (hard / total) * 100;
  const pMod = (modSeconds / total) * 100;

  segEasy.style.width = pEasy.toFixed(1) + '%';
  segHard.style.width = pHard.toFixed(1) + '%';
  segEasy.style.background = '';
  segEasy.textContent = pEasy >= 12 ? Math.round(pEasy) + '%' : '';
  segHard.textContent = pHard >= 12 ? Math.round(pHard) + '%' : '';

  const fmt = (sec) => (sec / 3600).toFixed(1) + ' h';
  legendEl.innerHTML = `
    <div class="polarization-legend-item"><span class="pol-dot pol-dot--easy"></span>Easy (Z1-Z2) — ${fmt(easy)} · ${Math.round(pEasy)}%</div>
    <div class="polarization-legend-item"><span class="pol-dot pol-dot--hard"></span>Hårt (Z3-Z5) — ${fmt(hard)} · ${Math.round(pHard)}%</div>
  `;

  // Z3-time is still tracked separately so we can warn when "hard" is
  // really just a bunch of unintentional gray-zone work.
  const z3DominantHard = pMod >= 12 && modSeconds > (hard - modSeconds);

  let band, title, sub;
  if (pEasy >= 75 && pHard >= 10 && pHard <= 25) {
    band = 'ok';
    title = `Polariserad mix (${Math.round(pEasy)}/${Math.round(pHard)})`;
    sub = 'Exakt där du ska vara — mål ~80% easy, ~20% hårt.';
  } else if (pEasy < 70) {
    band = 'bad';
    title = `Bara ${Math.round(pEasy)}% easy`;
    sub = 'För lite lågintensivt — bygg mer aerob bas i Z1-Z2.';
  } else if (pHard > 25) {
    band = 'bad';
    title = `${Math.round(pHard)}% hårt`;
    sub = 'Risk för överträning — backa intensiteten.';
  } else if (pHard < 8) {
    band = 'neutral';
    title = `Bara ${Math.round(pHard)}% hårt`;
    sub = 'Du kan lägga in mer kvalitet om formen tillåter.';
  } else if (z3DominantHard) {
    band = 'warn';
    title = `${Math.round(pMod)}% i Z3 ("gråzonen")`;
    sub = 'Styr mer mot Z2 (lugnt) eller Z4 (tydligt hårt) istället.';
  } else if (proxyShare >= 0.5) {
    // When most of the displayed time was classified via the pace
    // proxy, soften the headline so users understand the mix is an
    // estimate rather than measured HR-zone time.
    band = 'neutral';
    title = `Mix: ${Math.round(pEasy)}/${Math.round(pHard)} (uppskattad)`;
    sub = 'Mest pace-baserad — koppla en pulsmätare för exakt mix.';
  } else {
    band = 'neutral';
    title = `Mix: ${Math.round(pEasy)}/${Math.round(pHard)}`;
    sub = 'OK balans — mål ~80% easy, ~20% hårt.';
  }
  _renderChartInsight('polarization-insight', { band, title, sub });
}

// ─────────────────────────────────────────────────────────────
//  Aerob effektivitet (EF):  EF = GAP_kmh / avg_HR × 100
//  Per-km splits filtreras: skippa första 10 min av varje pass,
//  behåll splits där avg_hr ligger i 60–80 % av maxHR (Z2-band).
//  GAP justerar farten för stigning via Minetti-polynom.
//  Stigande EF = fortare till samma puls = bättre aerob form.
// ─────────────────────────────────────────────────────────────

const EF_WARMUP_CUT_SEC = 600;
const EF_Z2_MIN_PCT = 0.60;
const EF_Z2_MAX_PCT = 0.80;
const EF_DEFAULT_MAX_HR = 195;
const EF_MIN_KM_AFTER_FILTER = 2;

function gapAdjustSpeedKmh(speedKmh, gradeDecimal) {
  if (!speedKmh || speedKmh <= 0) return null;
  const g = Math.max(-0.30, Math.min(0.30, gradeDecimal || 0));
  // Minetti et al. (2002) cost of running, J/(kg·m). Cr(0) = 3.6.
  const Cr = 155.4 * g ** 5 - 30.4 * g ** 4 - 43.3 * g ** 3 + 46.3 * g ** 2 + 19.5 * g + 3.6;
  if (Cr <= 0) return speedKmh;
  return speedKmh * (3.6 / Cr);
}

function efPassAggregate(workout, hrMin, hrMax) {
  const raw = workout.splits_data;
  if (!raw) return null;
  let splits;
  try { splits = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { return null; }
  if (!Array.isArray(splits) || splits.length === 0) return null;

  let elapsed = 0;
  let gapKmhSum = 0, hrSum = 0, weightSum = 0, distMeters = 0;

  for (const s of splits) {
    const moving = Number(s.moving_time) || 0;
    const startElapsed = elapsed;
    elapsed += moving;
    if (startElapsed < EF_WARMUP_CUT_SEC) continue;

    const hr = Number(s.average_heartrate);
    if (!hr || hr < hrMin || hr > hrMax) continue;

    const speedMps = Number(s.average_speed);
    const dist = Number(s.distance);
    if (!speedMps || speedMps <= 0 || !dist || dist <= 0) continue;

    const grade = (Number(s.elevation_difference) || 0) / dist;
    const speedKmh = speedMps * 3.6;
    const gapKmh = gapAdjustSpeedKmh(speedKmh, grade);
    if (!gapKmh) continue;

    const w = moving;
    gapKmhSum += gapKmh * w;
    hrSum += hr * w;
    weightSum += w;
    distMeters += dist;
  }

  if (weightSum === 0 || distMeters < EF_MIN_KM_AFTER_FILTER * 1000) return null;
  return {
    weight: weightSum,
    gapKmh: gapKmhSum / weightSum,
    avgHr: hrSum / weightSum,
    km: distMeters / 1000,
  };
}

function renderEasyHrChart(workouts) {
  const canvas = document.getElementById('chart-easy-hr');
  if (!canvas || typeof Chart === 'undefined') return;
  if (window._chartEasyHr) window._chartEasyHr.destroy();

  const maxHr = (currentProfile && Number(currentProfile.user_max_hr)) || EF_DEFAULT_MAX_HR;
  const hrMin = Math.round(maxHr * EF_Z2_MIN_PCT);
  const hrMax = Math.round(maxHr * EF_Z2_MAX_PCT);

  const runs = workouts.filter((w) =>
    w.activity_type === 'Löpning' && w.workout_date && w.splits_data
  );

  const byWeek = new Map();
  let qualifiedPasses = 0;
  for (const w of runs) {
    const agg = efPassAggregate(w, hrMin, hrMax);
    if (!agg) continue;
    qualifiedPasses++;
    const mon = mondayOfWeek(new Date(w.workout_date + 'T00:00:00'));
    const key = isoDate(mon);
    if (!byWeek.has(key)) byWeek.set(key, { gapSum: 0, hrSum: 0, weightSum: 0, kmSum: 0, passes: 0 });
    const entry = byWeek.get(key);
    entry.gapSum += agg.gapKmh * agg.weight;
    entry.hrSum += agg.avgHr * agg.weight;
    entry.weightSum += agg.weight;
    entry.kmSum += agg.km;
    entry.passes++;
  }
  const dataKeys = [...byWeek.keys()].sort();

  if (dataKeys.length < 2) {
    _renderChartInsight('easy-hr-insight', {
      band: 'neutral',
      title: qualifiedPasses === 0 ? 'Inga kvalificerade pass än' : 'Bygg historik',
      sub: qualifiedPasses === 0
        ? `Behöver löppass med splits från Strava och puls i ${hrMin}–${hrMax} bpm efter de första 10 min.`
        : 'Behöver minst 2 veckor med kvalificerade Z2-pass för att rita trenden.',
    });
    return;
  }

  // Contiguous Monday timeline; weeks without qualifying passes render as
  // null gaps (spanGaps keeps the line continuous so a missed Z2 week doesn't
  // break the trend visually).
  //
  // We also trim leading empty weeks: if the user has one stray qualifying
  // pass from months ago plus recent activity, _buildContiguousWeeks would
  // otherwise stretch the categorical x-axis across a dozen empty bars.
  // Cap the lookback at the user-selected window size (6 / 12 / 36) and start
  // at the first week with data inside that window so the chart begins where
  // data actually begins.
  const easyHrSize = _getChartWindowSize('chart-easy-hr');
  const lastDataKey = dataKeys[dataKeys.length - 1];
  const earliestVisibleKey = isoDate(addDays(parseISOWeekKeyLocal(lastDataKey), -7 * (easyHrSize - 1)));
  const firstKey = dataKeys.find((k) => k >= earliestVisibleKey) ?? lastDataKey;
  const allWeekKeys = _buildContiguousWeeks(firstKey, lastDataKey);
  const win = _sliceWeekWindow(allWeekKeys, window._weeklyChartAnchor['chart-easy-hr'], easyHrSize);
  const visibleWeeks = win.weeks;

  const labels = visibleWeeks.map((k) => `V${weekNumber(parseISOWeekKeyLocal(k))}`);
  const efData = visibleWeeks.map((k) => {
    const e = byWeek.get(k);
    if (!e) return null;
    const gap = e.gapSum / e.weightSum;
    const hr = e.hrSum / e.weightSum;
    return +(gap / hr * 100).toFixed(2);
  });
  const ctxData = visibleWeeks.map((k) => {
    const e = byWeek.get(k);
    if (!e) return null;
    return {
      gap: +(e.gapSum / e.weightSum).toFixed(2),
      hr: Math.round(e.hrSum / e.weightSum),
      km: +e.kmSum.toFixed(1),
      passes: e.passes,
    };
  });
  // Recent EF stats for the subtitle — always over the FULL series so they
  // describe "now", not the browsed window.
  const efDataAll = dataKeys.map((k) => {
    const e = byWeek.get(k);
    const gap = e.gapSum / e.weightSum;
    const hr = e.hrSum / e.weightSum;
    return +(gap / hr * 100).toFixed(2);
  });

  const textColor = getComputedStyle(document.body).getPropertyValue('--text-dim').trim() || '#888';
  window._chartEasyHr = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'EF (GAP km/h ÷ HR × 100)',
        data: efData,
        borderColor: 'rgba(56, 178, 124, 0.95)',
        backgroundColor: 'rgba(56, 178, 124, 0.12)',
        borderWidth: 2.5,
        pointRadius: 3,
        pointHoverRadius: 5,
        fill: true,
        tension: 0.25,
        spanGaps: true,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => `EF: ${c.parsed.y.toFixed(2)}`,
            afterLabel: (c) => {
              const d = ctxData[c.dataIndex];
              if (!d) return '';
              return [
                `GAP: ${d.gap.toFixed(2)} km/h`,
                `Puls: ${d.hr} bpm`,
                `${d.passes} pass · ${d.km.toFixed(1)} km kvalificerad`,
              ];
            },
          },
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(255,255,255,0.05)' },
          ticks: { color: textColor, callback: (v) => v.toFixed(1) },
          title: { display: true, text: 'EF', color: textColor },
        },
        x: {
          grid: { display: false },
          ticks: { color: textColor, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 },
        },
      },
    },
  });

  // Insight works off the FULL series so it always describes the most
  // recent trend regardless of which window is being browsed.
  const recentEf = efDataAll.slice(-4);
  const earlierEf = efDataAll.slice(-8, -4);
  const avgRecent = recentEf.reduce((a, b) => a + b, 0) / recentEf.length;

  _renderChartWeekNav('chart-easy-hr', allWeekKeys.length, win, () => renderEasyHrChart(workouts));

  if (earlierEf.length === 0) {
    _renderChartInsight('easy-hr-insight', {
      band: 'neutral',
      title: 'Bygg historik',
      sub: `Behöver ~8 veckor med kvalificerade Z2-pass för att jämföra trenden. Senaste 4 v: EF ${avgRecent.toFixed(2)}.`,
      headline: avgRecent.toFixed(2),
      headlineLabel: 'EF · 4 V',
    });
    return;
  }
  const avgEarlier = earlierEf.reduce((a, b) => a + b, 0) / earlierEf.length;
  const deltaPct = (avgRecent - avgEarlier) / avgEarlier * 100;
  let band, title, sub;
  if (deltaPct >= 3) {
    band = 'ok';
    title = `Aerob form starkare (+${deltaPct.toFixed(1)} %)`;
    sub = `Samma puls bär ${(avgRecent - avgEarlier).toFixed(2)} km/h fortare GAP. Z2-band ${hrMin}–${hrMax} bpm.`;
  } else if (deltaPct <= -3) {
    band = 'bad';
    title = `EF ner ${Math.abs(deltaPct).toFixed(1)} %`;
    sub = `Mot förra 4-veckors. Kolla sömn, stress, värme — eller om du smyger upp pulsen i Z2 (${hrMin}–${hrMax} bpm).`;
  } else {
    band = 'neutral';
    title = `Stabil aerob profil (${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(1)} %)`;
    sub = `EF mot förra 4-veckors. Z2-band ${hrMin}–${hrMax} bpm.`;
  }
  _renderChartInsight('easy-hr-insight', {
    band, title, sub,
    headline: avgRecent.toFixed(2),
    headlineLabel: 'EF · 4 V',
  });
}

// ─────────────────────────────────────────────────────────────
//  VO2max (estimerad) — Jack Daniels VDOT
//  Per pass:  v = (km * 1000) / min   (m/min)
//             VO2 = -4.60 + 0.182258·v + 0.000104·v²
//             %max = 0.8 + 0.1894393·exp(-0.012778·t) + 0.2989558·exp(-0.1932605·t)
//             VDOT = VO2 / %max
//  Bara löppass med duration ≥ 12 min och rimligt VDOT (20-90).
//  Per vecka visas bästa pass — VDOT speglar aktuell tävlingsform.
// ─────────────────────────────────────────────────────────────

function _vdotFromWorkout(w) {
  if (!w || w.activity_type !== 'Löpning') return null;
  const dur = Number(w.duration_minutes);
  const km = Number(w.distance_km);
  if (!dur || dur < 12 || !km || km <= 0) return null;
  const v = (km * 1000) / dur;
  const vo2 = -4.60 + 0.182258 * v + 0.000104 * v * v;
  const pct = 0.8
    + 0.1894393 * Math.exp(-0.012778 * dur)
    + 0.2989558 * Math.exp(-0.1932605 * dur);
  if (pct <= 0) return null;
  const vdot = vo2 / pct;
  if (!Number.isFinite(vdot) || vdot < 20 || vdot > 90) return null;
  return vdot;
}

// Minimum % of HRmax for a run to count toward the VDOT trend. Lowered from
// 0.85 -> 0.70 so we get a Garmin-like density of data points instead of
// only 3 per ~year (85% gated nearly everything except tempo/threshold/
// race). The 28-day rolling mean (VO2MAX_SMOOTH_DAYS) absorbs the per-pass
// noise from easier sessions, so the trend stays meaningful even though
// raw dots scatter wider. Anything below 70% is still likely a recovery
// jog where Daniels' formula meaningfully underestimates fitness, so we
// keep some floor rather than removing the gate entirely.
const VO2MAX_QUAL_HR_PCT = 0.70;
// Window length for the smoothed trend curve. Garmin uses a similar
// long-running average; 28 days is long enough to dampen single-pass noise
// without lagging the trend by months.
const VO2MAX_SMOOTH_DAYS = 28;
// VO2max no longer hard-codes its visible window — it uses the same
// per-chart 6 / 12 / 36-week selector as every other Din progress chart.
// _getChartWindowSize('chart-vo2max') resolves the active size; the X axis
// is still tightened further to the Monday of the first qualifying pass
// inside the window so we don't render empty leading weeks when data only
// starts mid-window.
const _MS_PER_DAY = 86400000;

function _isVdotQualifyingPass(w, hrMax) {
  if (!w || w.activity_type !== 'Löpning') return false;
  if (!w.workout_date || !w.duration_minutes || !w.distance_km) return false;
  if (w.duration_minutes < 12 || w.distance_km <= 0) return false;
  if (!w.avg_hr || !hrMax) return false;
  return w.avg_hr >= VO2MAX_QUAL_HR_PCT * hrMax;
}

function renderVo2maxChart(workouts) {
  const canvas = document.getElementById('chart-vo2max');
  if (!canvas || typeof Chart === 'undefined') return;
  if (window._chartVo2max) window._chartVo2max.destroy();

  const profileMaxHr = currentProfile && Number(currentProfile.user_max_hr);
  const hrMax = profileMaxHr || EF_DEFAULT_MAX_HR;
  const usingFallbackHrMax = !profileMaxHr;

  // Step 1: collect qualifying runs only — pass with avg_hr above the
  // VO2MAX_QUAL_HR_PCT * HRmax floor (currently 70 %, see constant for
  // rationale). Recovery jogs below that floor would drag the raw dots
  // down further than Daniels' formula intends, but the 28 d rolling
  // mean smooths out individual noise so the trend stays useful.
  const points = [];
  for (const w of workouts) {
    if (!_isVdotQualifyingPass(w, hrMax)) continue;
    const vdot = _vdotFromWorkout(w);
    if (vdot === null) continue;
    const dateObj = new Date(w.workout_date + 'T00:00:00');
    points.push({
      x: dateObj.valueOf(),
      y: +vdot.toFixed(1),
      meta: {
        date: w.workout_date,
        km: Number(w.distance_km),
        min: Number(w.duration_minutes),
        avgHr: Number(w.avg_hr),
        hrPct: Math.round((w.avg_hr / hrMax) * 100),
        intensity: w.intensity || null,
        label: w.label || w.activity_type,
      },
    });
  }

  // Empty / sparse states — be specific so the user knows whether they
  // need to log more passes, add HR data, or set their HRmax.
  if (points.length === 0) {
    const sub = usingFallbackHrMax
      ? `Sätt din max-puls i profilen så vi kan filtrera kvalpass korrekt. Använder default ${EF_DEFAULT_MAX_HR} bpm tills vidare. Behöver pass med snittpuls ≥ ${Math.round(VO2MAX_QUAL_HR_PCT * 100)}% av HRmax.`
      : `Inga löppass med snittpuls ≥ ${Math.round(VO2MAX_QUAL_HR_PCT * 100)}% av HRmax (${Math.round(hrMax * VO2MAX_QUAL_HR_PCT)} bpm). Logga ett pass med pulsdata så ritar vi trenden.`;
    _renderChartInsight('vo2max-insight', {
      band: usingFallbackHrMax ? 'warn' : 'neutral',
      title: 'Inga kvalpass än',
      sub,
    });
    return;
  }

  points.sort((a, b) => a.x - b.x);

  // Step 2: per-pass 28-day rolling mean. We use a two-pointer sliding
  // window because points is already date-sorted; this keeps the smoothing
  // O(n) and means each smoothed value at date D averages every qualifying
  // VDOT in [D − 28d, D]. Note we run this over the FULL history so that
  // the leftmost dot in the visible window still has a real 28 d lookback
  // behind it, even though we'll clip the display below.
  let lo = 0;
  let runningSum = 0;
  for (let i = 0; i < points.length; i++) {
    const cutoff = points[i].x - VO2MAX_SMOOTH_DAYS * _MS_PER_DAY;
    runningSum += points[i].y;
    while (lo < i && points[lo].x < cutoff) {
      runningSum -= points[lo].y;
      lo++;
    }
    const winSize = i - lo + 1;
    points[i].smoothed = +(runningSum / winSize).toFixed(2);
    points[i].windowCount = winSize;
  }

  // Step 2b: clip to the visible window using the unified per-chart
  // selector (6 / 12 / 36 weeks, default 12). _sliceWeekWindow + the shared
  // nav strip mean VO2max obeys the same cadence as every other Din
  // progress chart. The X axis is still tightened to the Monday of the
  // first qualifying pass inside the window so we don't render leading
  // empty weeks when data only starts mid-window.
  const vo2Size = _getChartWindowSize('chart-vo2max');
  const firstPointMonIso = isoDate(mondayOfWeek(new Date(points[0].x)));
  const lastPointMonIso = isoDate(mondayOfWeek(new Date(points[points.length - 1].x)));
  const allWeekKeys = _buildContiguousWeeks(firstPointMonIso, lastPointMonIso);
  const win = _sliceWeekWindow(allWeekKeys, window._weeklyChartAnchor['chart-vo2max'], vo2Size);
  const visibleWeeks = win.weeks;
  const windowStartMs = visibleWeeks.length
    ? parseISOWeekKeyLocal(visibleWeeks[0]).valueOf()
    : 0;
  const windowEndMs = visibleWeeks.length
    ? addDays(parseISOWeekKeyLocal(visibleWeeks[visibleWeeks.length - 1]), 7).valueOf()
    : Date.now();
  const visiblePoints = points.filter((p) => p.x >= windowStartMs && p.x < windowEndMs);

  // Always render the nav strip — even on sparse states — so the user can
  // page back to where there is data.
  _renderChartWeekNav('chart-vo2max', allWeekKeys.length, win, () => renderVo2maxChart(workouts));

  if (visiblePoints.length === 0) {
    _renderChartInsight('vo2max-insight', {
      band: 'neutral',
      title: 'Inga kvalpass i fönstret',
      sub: `Inga kvalpass i de valda ${vo2Size} veckorna. Logga ett löppass med puls eller bläddra bakåt för att se historik.`,
    });
    return;
  }

  // Tighten the left bound to the Monday of the first qualifying pass in
  // the window so we don't render leading empty weeks when data only
  // starts mid-window. The selected window cap above is still the upper
  // bound on how far back we look; this just trims leading whitespace.
  const tightStartMs = mondayOfWeek(new Date(visiblePoints[0].x)).valueOf();

  if (visiblePoints.length === 1) {
    const v = visiblePoints[0].y;
    _renderChartInsight('vo2max-insight', {
      band: 'neutral',
      title: 'Behöver ett kvalpass till',
      sub: `Behöver ≥ 2 kvalpass i fönstret för att rita trend. Senaste: VO2max ${v.toFixed(1)} · 1 kvalpass.`,
      headline: v.toFixed(1),
      headlineLabel: 'VO2MAX',
    });
    _drawVo2maxChart(canvas, visiblePoints, /* withTrend */ false, tightStartMs, windowEndMs);
    return;
  }

  _drawVo2maxChart(canvas, visiblePoints, /* withTrend */ true, tightStartMs, windowEndMs);

  // Step 3: insight uses the smoothed value (not raw per-pass) so a single
  // hot tempo pass doesn't flip the narrative from "stabil" to "form upp"
  // overnight.
  const last = visiblePoints[visiblePoints.length - 1];
  const latestSmoothed = last.smoothed;
  const passCountStr = `${visiblePoints.length} kvalpass · valda ${vo2Size} v`;

  // Compare smoothed value now vs ~4 weeks earlier — pick the latest point
  // in the visible window whose date is <= (now - 28d). If we don't have
  // 4 weeks of qualifying passes inside the window yet, fall back to a
  // softer "build history" message.
  const fourWeeksAgoMs = last.x - 28 * _MS_PER_DAY;
  let priorIdx = -1;
  for (let i = visiblePoints.length - 2; i >= 0; i--) {
    if (visiblePoints[i].x <= fourWeeksAgoMs) { priorIdx = i; break; }
  }
  if (priorIdx < 0) {
    _renderChartInsight('vo2max-insight', {
      band: 'neutral',
      title: 'Bygg historik',
      sub: `Behöver ~4 veckor med kvalpass för att jämföra trenden. ${passCountStr}.`,
      headline: latestSmoothed.toFixed(1),
      headlineLabel: 'VO2MAX',
    });
    return;
  }
  const priorSmoothed = visiblePoints[priorIdx].smoothed;
  const delta = latestSmoothed - priorSmoothed;
  let band, title, sub;
  if (delta >= 0.8) {
    band = 'ok';
    title = `Form upp: VO2max +${delta.toFixed(1)} mot för 4 v sen`;
    sub = `Snabbare på samma puls. ${passCountStr}.`;
  } else if (delta <= -0.8) {
    band = 'bad';
    title = `Form ner: VO2max ${delta.toFixed(1)} mot för 4 v sen`;
    sub = `Kolla återhämtning, värme eller om kvalpassen tappat skärpa. ${passCountStr}.`;
  } else {
    band = 'neutral';
    title = `Stabil snittad VO2max (${delta >= 0 ? '+' : ''}${delta.toFixed(1)})`;
    sub = `Mot för 4 veckor sen. ${passCountStr}.`;
  }
  _renderChartInsight('vo2max-insight', {
    band, title, sub,
    headline: latestSmoothed.toFixed(1),
    headlineLabel: 'VO2MAX',
  });
}

function _drawVo2maxChart(canvas, points, withTrend, xMinMs, xMaxMs) {
  const textColor = getComputedStyle(document.body).getPropertyValue('--text-dim').trim() || '#888';
  const yValues = points.map((p) => p.y);
  if (withTrend) {
    for (const p of points) yValues.push(p.smoothed);
  }
  // Y-axis anchored at 0 so a small dip doesn't visually look like a 90 %
  // collapse. Trade-off: the trend line lives in the upper portion of the
  // canvas, but absolute scale is honest. Upper bound gets ~10 % headroom.
  const maxVal = Math.ceil(Math.max(...yValues) * 1.1);

  // Two layers:
  //   1. Faint scattered dots = each individual qualifying pass.
  //   2. Thick smoothed line = 28-day rolling mean. This is the number
  //      the user should anchor "Är jag i bättre form än för en månad sen?"
  //      on; the dots are there for transparency.
  const datasets = [
    {
      label: 'Kvalpass (per pass)',
      data: points.map((p) => ({ x: p.x, y: p.y, meta: p.meta })),
      parsing: false,
      borderColor: 'rgba(214, 99, 158, 0.4)',
      backgroundColor: 'rgba(214, 99, 158, 0.4)',
      pointRadius: 2.5,
      pointHoverRadius: 5,
      showLine: false,
      fill: false,
      order: 2,
    },
  ];
  if (withTrend) {
    datasets.push({
      label: `Snittad VO2max (${VO2MAX_SMOOTH_DAYS}d)`,
      data: points.map((p) => ({ x: p.x, y: p.smoothed, meta: p.meta, windowCount: p.windowCount })),
      parsing: false,
      borderColor: 'rgba(214, 99, 158, 0.95)',
      backgroundColor: 'rgba(214, 99, 158, 0.12)',
      borderWidth: 3,
      pointRadius: 0,
      pointHoverRadius: 4,
      fill: true,
      tension: 0.3,
      spanGaps: true,
      order: 1,
    });
  }

  window._chartVo2max = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,
      interaction: { mode: 'nearest', intersect: false, axis: 'x' },
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: textColor, usePointStyle: true, boxWidth: 10, padding: 14 },
        },
        tooltip: {
          callbacks: {
            title: (items) => {
              const m = items[0]?.raw?.meta;
              if (!m) return '';
              return `V${weekNumber(new Date(m.date + 'T00:00:00'))} · ${m.date}`;
            },
            label: (c) => {
              const isTrend = c.dataset.label && c.dataset.label.startsWith('Snittad');
              if (isTrend) {
                const cnt = c.raw.windowCount;
                return `Snittad VO2max: ${c.raw.y.toFixed(1)} (${cnt} pass i fönstret)`;
              }
              return `VO2max (pass): ${c.raw.y.toFixed(1)}`;
            },
            afterLabel: (c) => {
              if (c.dataset.label && c.dataset.label.startsWith('Snittad')) return '';
              const m = c.raw?.meta;
              if (!m) return '';
              const pace = (m.min / m.km);
              const paceMin = Math.floor(pace);
              const paceSec = Math.round((pace - paceMin) * 60).toString().padStart(2, '0');
              return [
                `${m.km.toFixed(1)} km · ${m.min} min · ${paceMin}:${paceSec}/km`,
                `Snittpuls ${m.avgHr} bpm (${m.hrPct}% av HRmax)`,
                m.intensity ? `Zon: ${m.intensity}` : '',
              ].filter(Boolean);
            },
          },
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          min: 0,
          max: maxVal,
          grid: { color: 'rgba(255,255,255,0.05)' },
          ticks: { color: textColor, callback: (v) => v.toFixed(0) },
          title: { display: true, text: 'VO2max (ml/kg/min)', color: textColor },
        },
        x: {
          type: 'time',
          // Hard-pin the visible range so Chart.js can't auto-fit a year of
          // sparse history and produce the V29 -> V49 -> V1 -> V13 wrap-
          // around. Bounds come from renderVo2maxChart's 12 w window.
          min: xMinMs,
          max: xMaxMs,
          time: { unit: 'week', isoWeekday: 1 },
          grid: { display: false },
          ticks: {
            color: textColor,
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 12,
            callback: (value) => 'V' + weekNumber(new Date(value)),
          },
        },
      },
    },
  });
}

// ═══════════════════════
//  GROUP
// ═══════════════════════
let grpChartMode = 'total';
let grpEffortMode = 'absolute';
let chartGroupWeekly = null;
let _cachedGroupWorkouts = [];
let _cachedGroupMembers = [];
let _cachedGroupCode = '';
let _cachedGroupCreatedBy = null;

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

async function loadGroup() {
  if (!currentProfile) return;
  showViewLoading('view-group');
  try { await _loadGroup(); } catch (e) { console.error('Group error:', e); }
  hideViewLoading('view-group');
}
async function _loadGroup() {
  const myGroup = currentProfile.group_id;
  const noGroupEl = document.getElementById('group-no-group');
  const hasGroupEl = document.getElementById('group-has-group');

  if (!myGroup) {
    noGroupEl.classList.remove('hidden');
    hasGroupEl.classList.add('hidden');
    return;
  }

  noGroupEl.classList.add('hidden');
  hasGroupEl.classList.remove('hidden');

  // Fetch group info
  let group = null;
  try {
    const resp = await fetch(SUPABASE_URL + '/rest/v1/groups?id=eq.' + myGroup + '&select=*', {
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + (await sb.auth.getSession()).data.session.access_token }
    });
    const groups = await resp.json();
    group = groups[0];
  } catch (e) { console.error('Group fetch error:', e); }

  if (group) {
    _cachedGroupCode = group.code;
    _cachedGroupCreatedBy = group.created_by;
    document.getElementById('group-subtitle').textContent = group.name;
    const shareCode = document.getElementById('group-share-code');
    if (shareCode) shareCode.textContent = group.code || '———';
  }

  // Fetch group members
  const token = (await sb.auth.getSession()).data.session.access_token;
  let members = [];
  try {
    const resp = await fetch(SUPABASE_URL + '/rest/v1/profiles?group_id=eq.' + myGroup + '&select=*', {
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + token }
    });
    members = await resp.json();
  } catch (e) { console.error('Members fetch error:', e); }

  // Leaderboard: hours this week
  const now = new Date();
  const monday = mondayOfWeek(now);
  const sunday = addDays(monday, 6);
  const allWorkouts = await fetchAllWorkouts();
  _cachedGroupWorkouts = allWorkouts;
  _cachedGroupMembers = members;
  updateGroupSettingsCard();

  const weekHours = members.map(m => {
    const mw = allWorkouts.filter(w => w.profile_id === m.id && w.workout_date >= isoDate(monday) && w.workout_date <= isoDate(sunday));
    return { name: m.name, hours: mw.reduce((s, w) => s + w.duration_minutes, 0) / 60, id: m.id };
  }).sort((a, b) => b.hours - a.hours);

  const lbEl = document.getElementById('group-leaderboard');
  const rankClasses = ['gold', 'silver', 'bronze'];
  lbEl.innerHTML = weekHours.map((m, i) => `
    <div class="lb-row clickable" onclick="openMemberProfile('${escapeHTML(m.id)}')">
      <div class="lb-rank ${rankClasses[i] || ''}">${i + 1}</div>
      <div class="lb-name">${escapeHTML(m.name)}</div>
      <div class="lb-value">${m.hours.toFixed(1)}h</div>
    </div>`).join('');

  // Group weekly detail (day-by-day per member)
  const periods = await fetchPeriods();
  const todayStr = isoDate(new Date());
  const period = periods.find(p => todayStr >= p.start_date && todayStr <= p.end_date);
  let grpPlans = [];
  if (period) grpPlans = await fetchPlans(period.id);
  renderGroupWeekDetail(allWorkouts, members, grpPlans);

  // Restore persisted sub-tab (defaults to 'progress'). Render the feed only
  // if Aktiviteter is the active tab — otherwise wait for setGroupSubtab to
  // trigger lazy render. Avoids eager work on the more expensive view.
  let savedSubtab = 'progress';
  try { savedSubtab = localStorage.getItem('group:subtab') || 'progress'; } catch (e) { /* ignore */ }
  if (!['progress', 'aktiviteter'].includes(savedSubtab)) savedSubtab = 'progress';
  setGroupSubtab(savedSubtab);
  if (savedSubtab === 'aktiviteter') {
    _groupFeedRenderedOnce = true;
    renderGroupFeed(allWorkouts, members);
  } else {
    _groupFeedRenderedOnce = false;
  }

  // Group weekly chart
  renderGroupChart(allWorkouts, members);
  renderGroupEffortChart(allWorkouts, members);

  // Season totals bars
  const colors = ['#2E86C1', '#E74C3C', '#2ECC71', '#9B59B6', '#F39C12', '#1ABC9C'];
  const maxTotal = Math.max(...members.map(m => allWorkouts.filter(w => w.profile_id === m.id).reduce((s, w) => s + w.duration_minutes, 0) / 60), 1);
  const barsEl = document.getElementById('group-totals-bars');
  barsEl.innerHTML = members.map((m, i) => {
    const total = allWorkouts.filter(w => w.profile_id === m.id).reduce((s, w) => s + w.duration_minutes, 0) / 60;
    return `<div class="compare-bar-row">
      <div class="compare-bar-label">${escapeHTML(m.name.split(' ')[0])}</div>
      <div class="compare-bar-track"><div class="compare-bar-fill" style="width:${(total/maxTotal)*100}%;background:${colors[i % colors.length]};">${total.toFixed(1)}h</div></div>
    </div>`;
  }).join('');
}

function setGrpChartMode(mode) {
  grpChartMode = mode;
  if (_cachedGroupWorkouts.length > 0 && _cachedGroupMembers.length > 0) {
    renderGroupChart(_cachedGroupWorkouts, _cachedGroupMembers);
  } else { loadGroup(); }
}
function setGrpEffortMode(mode) {
  grpEffortMode = mode;
  if (_cachedGroupWorkouts.length > 0 && _cachedGroupMembers.length > 0) {
    renderGroupChart(_cachedGroupWorkouts, _cachedGroupMembers);
  } else { loadGroup(); }
}

function renderGroupChart(allWorkouts, members) {
  const colors = ['#2E86C1', '#E74C3C', '#2ECC71', '#9B59B6', '#F39C12', '#1ABC9C'];
  const isGrpNorm = grpEffortMode === 'normalized';
  const gUnit = isGrpNorm ? ' belastning' : 'h';
  const weekData = {};
  allWorkouts.forEach(w => {
    const mon = mondayOfWeek(new Date(w.workout_date));
    const key = isoDate(mon);
    if (!weekData[key]) weekData[key] = {};
    const types = grpChartMode === 'cardio' ? CARDIO_TYPES : [...CARDIO_TYPES, 'Gym'];
    if (!types.includes(w.activity_type)) return;
    const val = isGrpNorm ? calcWorkoutEffort(w) : w.duration_minutes;
    weekData[key][w.profile_id] = (weekData[key][w.profile_id] || 0) + val;
  });

  if (chartGroupWeekly) chartGroupWeekly.destroy();
  const canvas = document.getElementById('chart-group-weekly');
  if (!canvas) return;

  const dataWeeks = Object.keys(weekData).sort();
  if (dataWeeks.length === 0) return;
  const allWeekKeys = _buildContiguousWeeks(dataWeeks[0], dataWeeks[dataWeeks.length - 1]);
  const win = _sliceWeekWindow(allWeekKeys, window._weeklyChartAnchor['chart-group-weekly'], _getChartWindowSize('chart-group-weekly'));
  const visibleWeeks = win.weeks;

  const labels = visibleWeeks.map(w => {
    const mon = parseISOWeekKeyLocal(w);
    const wn = weekNumber(mon);
    return isDeloadWeek(mon) ? `V${wn} (D)` : `V${wn}`;
  });

  const titleEl = document.getElementById('grp-chart-title');
  if (titleEl) titleEl.textContent = isGrpNorm ? 'Belastning per vecka' : 'Timmar per vecka';

  const datasets = members.map((m, i) => ({
    label: m.name.split(' ')[0],
    data: visibleWeeks.map(w => isGrpNorm ? +effortRawToDisplay(weekData[w]?.[m.id] || 0).toFixed(2) : (weekData[w]?.[m.id] || 0) / 60),
    borderColor: colors[i % colors.length],
    backgroundColor: colors[i % colors.length],
    tension: 0.35, fill: false, pointRadius: 5, pointHoverRadius: 7, borderWidth: 2.5
  }));

  chartGroupWeekly = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: { position: 'bottom', labels: { color: '#aaa', usePointStyle: true, padding: 16 } },
        tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.parsed.y.toFixed(1)}${gUnit}` } }
      },
      scales: {
        y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#888', callback: v => v.toFixed(1) + gUnit } },
        x: { grid: { display: false }, ticks: { color: '#888' } }
      }
    }
  });

  _renderChartWeekNav('chart-group-weekly', allWeekKeys.length, win, () => renderGroupChart(allWorkouts, members));

  // Insight: who's most active in the most recent week of the FULL series
  // (not the visible window) so the callout always describes "now".
  const latestWeekKey = dataWeeks[dataWeeks.length - 1];
  const latestEntry = weekData[latestWeekKey] || {};
  let topId = null, topVal = 0;
  for (const m of members) {
    const raw = latestEntry[m.id] || 0;
    const val = isGrpNorm ? effortRawToDisplay(raw) : raw / 60;
    if (val > topVal) { topVal = val; topId = m.id; }
  }
  const topMember = members.find((m) => m.id === topId);
  if (topMember && topVal > 0) {
    const valStr = isGrpNorm ? `Belastning ${topVal.toFixed(1)}` : `${topVal.toFixed(1)} h`;
    _renderChartInsight('group-weekly-insight', {
      band: 'ok',
      title: `Mest aktiv: ${topMember.name.split(' ')[0]}`,
      sub: `${valStr} denna vecka${isGrpNorm ? ' (skalad)' : ''}.`,
      headline: isGrpNorm ? topVal.toFixed(1) : topVal.toFixed(1) + 'h',
      headlineLabel: isGrpNorm ? 'BELASTNING' : 'TIMMAR',
    });
  } else {
    _renderChartInsight('group-weekly-insight', {
      band: 'neutral',
      title: 'Tyst vecka i gruppen',
      sub: 'Ingen har loggat något än denna vecka.',
    });
  }
}

function renderGroupEffortChart(allWorkouts, members) {
  const canvas = document.getElementById('chart-group-effort');
  if (!canvas) return;
  if (window._chartGroupEffort) window._chartGroupEffort.destroy();

  const colors = ['#2E86C1', '#E74C3C', '#2ECC71', '#9B59B6', '#F39C12', '#1ABC9C'];
  const weekMap = {};
  allWorkouts.forEach(w => {
    const mon = mondayOfWeek(new Date(w.workout_date));
    const key = isoDate(mon);
    if (!weekMap[key]) weekMap[key] = {};
    if (!weekMap[key][w.profile_id]) weekMap[key][w.profile_id] = { effort: 0, hours: 0 };
    weekMap[key][w.profile_id].effort += calcWorkoutEffort(w);
    weekMap[key][w.profile_id].hours += w.duration_minutes / 60;
  });

  const dataWeeks = Object.keys(weekMap).sort();
  if (dataWeeks.length === 0) return;
  const allWeekKeys = _buildContiguousWeeks(dataWeeks[0], dataWeeks[dataWeeks.length - 1]);
  const win = _sliceWeekWindow(allWeekKeys, window._weeklyChartAnchor['chart-group-effort'], _getChartWindowSize('chart-group-effort'));
  const visibleWeeks = win.weeks;

  const labels = visibleWeeks.map(w => {
    const mon = parseISOWeekKeyLocal(w);
    const wn = weekNumber(mon);
    return isDeloadWeek(mon) ? `V${wn} (D)` : `V${wn}`;
  });
  const textColor = getComputedStyle(document.body).getPropertyValue('--text-dim').trim() || '#888';

  const datasets = members.map((m, i) => ({
    label: m.name.split(' ')[0],
    data: visibleWeeks.map(w => +effortRawToDisplay(weekMap[w]?.[m.id]?.effort || 0).toFixed(2)),
    borderColor: colors[i % colors.length],
    backgroundColor: colors[i % colors.length],
    tension: 0.35, fill: false, pointRadius: 5, pointHoverRadius: 7, borderWidth: 2.5,
  }));

  window._chartGroupEffort = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: { position: 'bottom', labels: { color: textColor, usePointStyle: true, padding: 16 } },
        tooltip: { callbacks: { label: c => `${c.dataset.label}: Belastning ${c.parsed.y.toFixed(1)}` } }
      },
      scales: {
        y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: textColor, callback: v => v.toFixed(1) }, title: { display: true, text: 'Belastning', color: textColor } },
        x: { grid: { display: false }, ticks: { color: textColor } }
      }
    }
  });

  const legendEl = document.getElementById('group-effort-legend');
  if (legendEl) {
    legendEl.innerHTML = `<div class="effort-legend-item"><span class="effort-legend-dot" style="background:rgba(214,99,158,0.8)"></span> Belastning = skalad träningsbelastning (rå score ÷ ${EFFORT_DISPLAY_DIVISOR}), samma som på Din progress.</div>`;
  }

  _renderChartWeekNav('chart-group-effort', allWeekKeys.length, win, () => renderGroupEffortChart(allWorkouts, members));

  // Insight: classify each member's most recent week against their own
  // 3-week rolling band (same logic as the personal Effort chart) so the
  // group rollup reads "X i bandet · Y över / Z under denna vecka".
  let nOn = 0, nOver = 0, nUnder = 0, nUngraded = 0;
  for (const m of members) {
    const memberSeriesAll = allWeekKeys.map((k) =>
      +effortRawToDisplay(weekMap[k]?.[m.id]?.effort || 0).toFixed(2)
    );
    const { classes } = _effortBandClassify(memberSeriesAll);
    const last = classes[classes.length - 1];
    if (last === 'on') nOn++;
    else if (last === 'over') nOver++;
    else if (last === 'under') nUnder++;
    else nUngraded++;
  }
  const total = members.length;
  let band, title, sub;
  if (total === 0) {
    band = 'neutral';
    title = 'Inga medlemmar';
    sub = 'Bjud in vänner så fylls grafen.';
  } else if (nOver > nOn && nOver >= nUnder) {
    band = 'warn';
    title = `${nOver} av ${total} över bandet denna vecka`;
    sub = `${nOn} i bandet · ${nUnder} under${nUngraded ? ` · ${nUngraded} utan band-historik` : ''}.`;
  } else if (nUnder > nOn && nUnder >= nOver) {
    band = 'neutral';
    title = `${nUnder} av ${total} under bandet denna vecka`;
    sub = `${nOn} i bandet · ${nOver} över${nUngraded ? ` · ${nUngraded} utan band-historik` : ''}.`;
  } else if (nOn > 0) {
    band = 'ok';
    title = `${nOn} av ${total} i bandet denna vecka`;
    sub = `${nOver} över · ${nUnder} under${nUngraded ? ` · ${nUngraded} utan band-historik` : ''}.`;
  } else {
    band = 'neutral';
    title = 'Bygger band-historik';
    sub = `Behöver ≥ ${EFFORT_BAND_LOOKBACK + 1} v per medlem för att gradera veckan.`;
  }
  _renderChartInsight('group-effort-insight', { band, title, sub });
}

async function createGroup() {
  const name = document.getElementById('group-create-name').value.trim();
  if (!name) return;
  const code = generateCode();
  const token = (await sb.auth.getSession()).data.session.access_token;

  try {
    const resp = await fetch(SUPABASE_URL + '/rest/v1/groups', {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json', 'Prefer': 'return=representation'
      },
      body: JSON.stringify({ name, code, created_by: currentProfile.id })
    });
    const created = await resp.json();
    if (created.length > 0) {
      await fetch(SUPABASE_URL + '/rest/v1/profiles?id=eq.' + currentProfile.id, {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ group_id: created[0].id })
      });
      currentProfile.group_id = created[0].id;
      showToast('Grupp skapad — dela koden med vänner.');
      loadGroup();
    }
  } catch (e) { console.error('Create group error:', e); }
}

async function joinGroup() {
  const code = document.getElementById('group-join-code').value.trim().toUpperCase();
  const errEl = document.getElementById('group-join-error');
  errEl.classList.add('hidden');
  if (code.length !== 6) { errEl.textContent = 'Koden ska vara 6 tecken'; errEl.classList.remove('hidden'); return; }

  try {
    // RLS lockdown (20260418_rls_lockdown.sql) hides the groups table from
    // non-members, so a direct REST query returns 0 rows even when the code
    // is valid. The SECURITY DEFINER RPC `join_group_by_code` bypasses RLS
    // and only leaks (id, name) for an exact code match — that's what we use.
    const { data: groups, error: lookupErr } = await sb.rpc('join_group_by_code', { p_code: code });
    if (lookupErr) throw lookupErr;
    if (!groups || groups.length === 0) {
      errEl.textContent = 'Ingen grupp med den koden';
      errEl.classList.remove('hidden');
      return;
    }
    const { error: patchErr } = await sb
      .from('profiles')
      .update({ group_id: groups[0].id })
      .eq('id', currentProfile.id);
    if (patchErr) throw patchErr;
    currentProfile.group_id = groups[0].id;
    showToast('Du gick med i gruppen!');
    loadGroup();
  } catch (e) {
    console.error('joinGroup error:', e);
    errEl.textContent = 'Något gick fel';
    errEl.classList.remove('hidden');
  }
}

async function leaveGroup() {
  const confirmed = await showConfirmModal('Lämna grupp', 'Är du säker på att du vill lämna gruppen?', 'Lämna', true);
  if (!confirmed) return;
  const token = (await sb.auth.getSession()).data.session.access_token;
  await fetch(SUPABASE_URL + '/rest/v1/profiles?id=eq.' + currentProfile.id, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ group_id: null })
  });
  currentProfile.group_id = null;
  loadGroup();
}

function copyGroupCode() {
  navigator.clipboard.writeText(_cachedGroupCode).then(() => {
    const btn = document.querySelector('#group-settings-info .btn');
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = 'Kopierad!';
    setTimeout(() => btn.textContent = orig, 1500);
  });
}

function toggleGroupSettings() {
  const card = document.getElementById('group-settings-card');
  if (!card) return;
  // toggle returns true when the class was added (=newly hidden), false
  // when it was removed (=now visible). We invert to know visibility.
  const wasHidden = card.classList.toggle('hidden');
  if (!wasHidden) {
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function updateGroupSettingsCard() {
  const card = document.getElementById('group-settings-card');
  const info = document.getElementById('group-settings-info');
  const gearBtn = document.getElementById('group-settings-btn');
  if (!card || !info) return;
  if (!currentProfile?.group_id) {
    card.classList.add('hidden');
    if (gearBtn) gearBtn.classList.add('hidden');
    return;
  }
  // Settings card stays hidden by default — user opens it via the gear
  // button in the page header. We only fill the content here so it's
  // ready to display the moment they click the gear.
  if (gearBtn) gearBtn.classList.remove('hidden');
  const code = _cachedGroupCode || '------';
  const memberEls = _cachedGroupMembers || [];
  const isAdmin = _cachedGroupCreatedBy === currentProfile.id;
  // SECURITY (assessment H1): member.name is DB-sourced and may contain quotes
  // or HTML. We escape for HTML body, and since the name is passed into an
  // onclick attribute, we fetch it by id from a data attribute at click time
  // instead of inlining it into the attribute value.
  const memberList = memberEls.map(m => {
    const isMe = m.id === currentProfile.id;
    const safeName = escapeHTML(m.name);
    const removeBtn = isAdmin && !isMe
      ? `<button class="btn btn-sm btn-danger-text" onclick="removeGroupMember('${escapeHTML(m.id)}')" data-member-name="${safeName}" style="margin-left:auto;padding:2px 8px;font-size:0.75rem;">Ta bort</button>`
      : '';
    return `<div class="sm-member" style="display:flex;align-items:center;gap:8px;">${safeName}${isMe ? ' (du)' : ''}${isAdmin && !isMe ? '<span style="font-size:0.7rem;color:var(--text-muted);margin-left:4px;"></span>' : ''}${removeBtn}</div>`;
  }).join('');
  info.innerHTML = `
    <div class="sm-code-row">
      <span class="sm-code">${escapeHTML(code)}</span>
      <button class="btn btn-sm btn-ghost" onclick="copyGroupCode()">Kopiera</button>
    </div>
    <div class="sm-members">${memberList}</div>
    <button class="sm-item sm-leave" onclick="leaveGroup()" style="margin-top:12px;">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
      Lämna grupp
    </button>`;
}

async function removeGroupMember(profileId) {
  // Read member name from the button's data attribute rather than as a string
  // argument (avoids attribute-injection XSS via apostrophe in name).
  const btn = document.querySelector(`button[data-member-name][onclick*="removeGroupMember('${profileId}')"]`);
  const memberName = btn ? btn.dataset.memberName : 'medlemmen';
  const confirmed = await showConfirmModal('Ta bort medlem', `Vill du ta bort ${memberName} från gruppen?`, 'Ta bort', true);
  if (!confirmed) return;
  const token = (await sb.auth.getSession()).data.session.access_token;
  await fetch(SUPABASE_URL + '/rest/v1/profiles?id=eq.' + profileId, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ group_id: null })
  });
  loadGroup();
}

// ═══════════════════════
//  GROUP WEEKLY DETAIL + NUDGE
// ═══════════════════════
let _sentNudges = new Set();

const GWD_DEFAULT_SHOW = 3;

// Count consecutive missed training days for a member, starting from
// yesterday and walking backwards. A "missed" day is a non-rest, non-
// future calendar day with zero logged workouts. Rest days neither
// count as missed nor break the streak — they're skipped. Returns
// early as soon as the streak is broken or we've inspected `lookback`
// days. Lookback of 10 days is enough to catch any 3-in-a-row streak
// that crosses Sunday/Monday week boundaries.
function _consecutiveMissedDays(memberId, allWorkouts, plans, lookback = 10) {
  const now = new Date();
  let streak = 0;
  for (let i = 1; i <= lookback; i++) {
    const day = addDays(now, -i);
    const dayStr = isoDate(day);
    const dow = (day.getDay() + 6) % 7; // Mon=0 .. Sun=6
    const hasWorkout = allWorkouts.some(
      (w) => w.profile_id === memberId && w.workout_date === dayStr
    );
    if (hasWorkout) break;
    if (isRestDay(dow, plans)) continue;
    streak++;
    if (streak >= 3) break; // no need to keep counting past the threshold
  }
  return streak;
}

function renderGroupWeekDetail(allWorkouts, members, plans) {
  const el = document.getElementById('group-week-detail');
  if (!el) return;

  const now = new Date();
  const monday = mondayOfWeek(now);
  const todayStr = isoDate(now);
  const todayDow = (now.getDay() + 6) % 7;
  const colors = ['#2E86C1', '#E74C3C', '#2ECC71', '#9B59B6', '#F39C12', '#1ABC9C'];

  const memberStats = members.map((m, mi) => {
    let totalMins = 0;
    let missedCount = 0;
    let sessionCount = 0;

    const daysHTML = Array.from({ length: 7 }, (_, di) => {
      const dayDate = addDays(monday, di);
      const dayStr = isoDate(dayDate);
      const dayW = allWorkouts.filter(w => w.profile_id === m.id && w.workout_date === dayStr);
      const mins = dayW.reduce((s, w) => s + w.duration_minutes, 0);
      totalMins += mins;
      if (dayW.length > 0) sessionCount += dayW.length;
      const isFuture = dayDate > now;
      const isRest = isRestDay(di, plans);

      let cls = 'future';
      if (mins > 0) cls = 'done';
      else if (isRest) cls = 'rest';
      else if (!isFuture) { cls = 'missed'; missedCount++; }

      const label = mins > 0 ? mins + "'" : (cls === 'rest' ? '—' : (cls === 'missed' ? '✗' : '·'));
      return `<div class="grp-day-cell ${cls}"><div class="day-lbl">${DAY_NAMES[di]}</div>${label}</div>`;
    }).join('');

    const missedStreak = _consecutiveMissedDays(m.id, allWorkouts, plans);
    return { m, mi, totalMins, missedCount, missedStreak, sessionCount, daysHTML };
  });

  memberStats.sort((a, b) => b.sessionCount - a.sessionCount || b.totalMins - a.totalMins);

  const cards = memberStats.map(({ m, mi, totalMins, missedStreak, sessionCount, daysHTML }) => {
    const isMe = m.id === currentProfile.id;
    const nudgeId = `nudge-${m.id}`;
    const canNudge = !isMe && missedStreak >= 3;
    const alreadySent = _sentNudges.has(m.id);
    // SECURITY (assessment H1): m.name is DB-sourced, so we avoid inlining
    // it into the onclick attribute. Pass only the id and look up the name
    // from a data attribute at click time.
    const nudgeHTML = canNudge
      ? `<button class="nudge-btn${alreadySent ? ' sent' : ''}" id="${escapeHTML(nudgeId)}" onclick="sendNudge('${escapeHTML(m.id)}', this)" data-member-name="${escapeHTML(m.name)}" ${alreadySent ? 'disabled' : ''}>
           ${alreadySent ? '✓ Puff skickad' : '👊 Ge en puff'}
         </button>`
      : '';

    return `<div class="grp-member-week">
      <div class="grp-mw-header clickable" onclick="openMemberProfile('${escapeHTML(m.id)}')">
        <div class="grp-mw-avatar" style="background:${colors[mi % colors.length]}">${escapeHTML(m.name[0].toUpperCase())}</div>
        <div class="grp-mw-name">${escapeHTML(m.name)}${isMe ? ' (du)' : ''}</div>
        <div class="grp-mw-total">${sessionCount} pass · ${(totalMins / 60).toFixed(1)}h</div>
      </div>
      <div class="grp-mw-days">${daysHTML}</div>
      ${nudgeHTML}
    </div>`;
  });

  const showAll = members.length <= GWD_DEFAULT_SHOW;
  const visibleCards = showAll ? cards : cards.slice(0, GWD_DEFAULT_SHOW);
  const hiddenCards = showAll ? [] : cards.slice(GWD_DEFAULT_SHOW);
  const toggleBtn = hiddenCards.length > 0
    ? `<button class="btn btn-ghost btn-sm gwd-toggle" onclick="toggleGroupWeekExpand(this)">Visa alla (${members.length})</button>`
    : '';

  el.innerHTML = visibleCards.join('') +
    (hiddenCards.length ? `<div class="gwd-hidden-cards" style="display:none;">${hiddenCards.join('')}</div>` : '') +
    toggleBtn;
}

function toggleGroupWeekExpand(btn) {
  const hidden = btn.previousElementSibling;
  if (!hidden) return;
  const expanded = hidden.style.display !== 'none';
  hidden.style.display = expanded ? 'none' : 'block';
  btn.textContent = expanded ? `Visa alla (${hidden.children.length + GWD_DEFAULT_SHOW})` : 'Visa färre';
}

let _feedReactionsCache = null;
let _feedAllItems = [];
let _feedShown = 0;
const FEED_PAGE = 10;

async function renderGroupFeed(allWorkouts, members) {
  const feedEl = document.getElementById('group-feed');
  const moreBtn = document.getElementById('feed-more-btn');
  if (!feedEl) return;

  _feedAllItems = allWorkouts
    .filter(w => members.some(m => m.id === w.profile_id))
    .reverse();
  _feedShown = 0;

  if (_feedAllItems.length === 0) {
    feedEl.innerHTML = '<div class="empty-state"><p>Inga loggade pass ännu</p></div>';
    if (moreBtn) moreBtn.classList.add('hidden');
    return;
  }

  const visible = _feedAllItems.slice(0, FEED_PAGE);
  _feedShown = visible.length;
  const workoutIds = visible.map(w => w.id);
  const [reactions, comments] = await Promise.all([
    fetchReactionsBulk(workoutIds),
    fetchCommentsBulk(workoutIds)
  ]);
  _feedReactionsCache = { recent: _feedAllItems, members, reactions, comments };

  feedEl.innerHTML = renderFeedItems(visible, members, reactions, comments);
  if (moreBtn) moreBtn.classList.toggle('hidden', _feedShown >= _feedAllItems.length);
}

async function showMoreFeed() {
  if (!_feedReactionsCache) return;
  const { members, reactions: prevReactions, comments: prevComments } = _feedReactionsCache;
  const nextBatch = _feedAllItems.slice(_feedShown, _feedShown + FEED_PAGE);
  if (nextBatch.length === 0) return;

  const newIds = nextBatch.map(w => w.id);
  const [newReactions, newComments] = await Promise.all([
    fetchReactionsBulk(newIds),
    fetchCommentsBulk(newIds)
  ]);
  const allReactions = [...prevReactions, ...newReactions];
  const allComments = [...prevComments, ...newComments];
  _feedReactionsCache.reactions = allReactions;
  _feedReactionsCache.comments = allComments;

  const feedEl = document.getElementById('group-feed');
  feedEl.innerHTML += renderFeedItems(nextBatch, members, allReactions, allComments);
  _feedShown += nextBatch.length;

  const moreBtn = document.getElementById('feed-more-btn');
  if (moreBtn) moreBtn.classList.toggle('hidden', _feedShown >= _feedAllItems.length);
}

// ───────────────────────────────────────────────────────────────────────────
// Feed helpers (Strava-style cards): polyline-to-SVG, auto-title, KPI grid.
// _polylineToSvg renders the GPS track inline (no tile requests, no Leaflet)
// so the feed scrolls smoothly even with 30+ activities. We normalise the
// coordinates into a 320x180 viewBox and draw a single path. Y is flipped
// because lat increases northward but SVG y grows downward.
// ───────────────────────────────────────────────────────────────────────────
function _polylineToSvg(polyline, opts) {
  if (!polyline) return '';
  let coords;
  try { coords = decodePolyline(polyline); } catch (e) { return ''; }
  if (!coords || coords.length < 2) return '';
  const w = (opts && opts.width) || 320;
  const h = (opts && opts.height) || 180;
  const stroke = (opts && opts.stroke) || 'var(--accent, #3B9DFF)';
  const pad = 6;
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const [lat, lng] of coords) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  const dLat = Math.max(maxLat - minLat, 1e-9);
  const dLng = Math.max(maxLng - minLng, 1e-9);
  // Lock 1:1 aspect so the route shape is preserved (don't stretch a
  // north-south route into a wide rectangle). We pick the tighter of the
  // two scales and centre the result.
  const scale = Math.min((w - pad * 2) / dLng, (h - pad * 2) / dLat);
  const offsetX = (w - dLng * scale) / 2;
  const offsetY = (h - dLat * scale) / 2;
  const pts = coords.map(([lat, lng]) => {
    const x = offsetX + (lng - minLng) * scale;
    const y = offsetY + (maxLat - lat) * scale;
    return x.toFixed(1) + ',' + y.toFixed(1);
  }).join(' ');
  return `<svg class="feed-hero-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">`
    + `<polyline points="${pts}" fill="none" stroke="rgba(0,0,0,0.25)" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/>`
    + `<polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`
    + `</svg>`;
}

// Strava-style auto title: "Morgonlöpning", "Kvällscykling" etc. We derive
// the time-of-day bucket from workout_time when available, otherwise fall
// back to a plain activity label so the title is never empty.
function _timeOfDayLabel(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return null;
  const m = timeStr.match(/^(\d{1,2})/);
  if (!m) return null;
  const hr = parseInt(m[1], 10);
  if (isNaN(hr)) return null;
  if (hr < 11) return 'Morgon';
  if (hr < 14) return 'Lunch';
  if (hr < 18) return 'Eftermiddags';
  if (hr < 22) return 'Kvälls';
  return 'Natt';
}
function _activityNoun(type) {
  // Lowercase Swedish noun for combination with time-of-day prefix.
  const map = {
    'Löpning': 'löpning',
    'Cykel': 'cykling',
    'Gym': 'gympass',
    'Hyrox': 'hyroxpass',
    'Stakmaskin': 'stakpass',
    'Längdskidor': 'skidåkning',
    'Vila': 'vila',
    'Annat': 'pass',
  };
  return map[type] || (type ? type.toLowerCase() : 'pass');
}
function _autoWorkoutTitle(w) {
  const tod = _timeOfDayLabel(w.workout_time);
  const noun = _activityNoun(w.activity_type);
  if (tod) {
    // "Morgon" + "löpning" → "Morgonlöpning". Lower-case noun lets us
    // concatenate without a space — matches Strava's Swedish UI.
    return tod + noun;
  }
  // No clock → capitalise activity label (e.g. "Löpning").
  return w.activity_type || 'Pass';
}

// KPI grid per activity type. Returns the HTML for 3-4 stat tiles. Only
// includes a tile when the underlying value exists, so a manual log without
// pace/HR doesn't render hollow placeholders.
function _kpiGridHtml(w) {
  const tiles = [];
  const isEndurance = w.activity_type === 'Löpning' || w.activity_type === 'Cykel'
    || w.activity_type === 'Längdskidor' || w.activity_type === 'Stakmaskin';

  if (w.distance_km && isEndurance) {
    tiles.push({ label: 'Distans', value: (+w.distance_km).toFixed(2) + ' km' });
  }
  if (w.duration_minutes != null) {
    const mins = w.duration_minutes;
    const hh = Math.floor(mins / 60);
    const mm = mins % 60;
    const tStr = hh > 0 ? `${hh}h ${String(mm).padStart(2, '0')}m` : `${mm} min`;
    tiles.push({ label: 'Tid', value: tStr });
  }
  if (isEndurance && w.avg_speed_kmh) {
    if (w.activity_type === 'Cykel') {
      tiles.push({ label: 'Snitt', value: (+w.avg_speed_kmh).toFixed(1) + ' km/h' });
    } else {
      const paceMin = 60 / w.avg_speed_kmh;
      const m = Math.floor(paceMin);
      const s = String(Math.round((paceMin % 1) * 60)).padStart(2, '0');
      tiles.push({ label: 'Tempo', value: `${m}:${s}/km` });
    }
  }
  if (w.avg_hr) {
    tiles.push({ label: 'Snittpuls', value: Math.round(w.avg_hr) + ' bpm' });
  }
  // Strength-style sessions: surface effort + RPE-like cues since pace/distance are noise.
  if (!isEndurance && w.effort != null) {
    tiles.push({ label: 'Belastning', value: (+w.effort).toFixed(1) });
  }
  return tiles.slice(0, 4).map(t =>
    `<div class="feed-kpi"><div class="feed-kpi-value">${escapeHTML(t.value)}</div><div class="feed-kpi-label">${escapeHTML(t.label)}</div></div>`
  ).join('');
}

function _feedSourceBadge(w) {
  if (w.source === 'strava') return `<span class="feed-source-badge feed-source-badge--strava" title="Importerad från Strava">Strava</span>`;
  if (w.source === 'garmin') return `<span class="feed-source-badge feed-source-badge--garmin" title="Importerad från Garmin">Garmin</span>`;
  return '';
}

// ───────────────────────────────────────────────────────────────────────────
// Shared Strava-style card builder used by group / social / personal feeds.
// Keeps the visual language identical across all three surfaces; callers
// vary only in (a) what handler opens the workout modal, and (b) which
// reaction/comment buttons (if any) sit in the action row. Hero uses a
// real Leaflet map (lazy-loaded via .wo-map) so the user can actually see
// the streets the route ran on; fallback is a coloured gradient + emoji.
// ───────────────────────────────────────────────────────────────────────────
function _buildFeedCardHtml(w, opts) {
  opts = opts || {};
  const ownerName = opts.ownerName || '';
  const ownerColor = opts.ownerColor || '#2E86C1';
  const ownerAvatar = (opts.ownerAvatar != null && opts.ownerAvatar !== '') ? String(opts.ownerAvatar) : (ownerName[0] || '?').toUpperCase();
  // Single-character avatars that aren't latin letters/digits are treated
  // as emoji (so we render them transparent w/o the coloured circle).
  const isEmojiAvatar = ownerAvatar && ownerAvatar.length <= 2 && !/^[a-zA-Z0-9]$/.test(ownerAvatar);

  const intBadge = w.intensity ? `<span class="intensity-badge">${escapeHTML(w.intensity)}</span>` : '';
  const showNote = w.notes && w.notes !== 'Importerad' && !String(w.notes).startsWith('[Strava]');
  const notesSnip = showNote ? `<div class="feed-notes">${escapeHTML(w.notes)}</div>` : '';

  const heroInner = w.map_polyline
    ? `<div class="wo-map feed-hero-map" data-polyline="${escapeHTML(w.map_polyline)}"></div>`
    : `<div class="feed-hero-fallback" style="background:linear-gradient(135deg, ${ownerColor}55, ${ownerColor}22);"><span class="feed-hero-emoji">${activityEmoji(w.activity_type)}</span></div>`;

  const title = _autoWorkoutTitle(w);
  const dateLine = `${escapeHTML(formatDate(w.workout_date))}${w.workout_time ? ' · ' + escapeHTML(w.workout_time) : ''}`;

  const headerExtra = opts.headerClickAttr || '';
  const headerCursor = opts.headerClickAttr ? 'cursor:pointer;' : '';
  const avatarStyle = isEmojiAvatar
    ? `background:transparent;font-size:1.05rem;${headerCursor}`
    : `background:${ownerColor};${headerCursor}`;

  // Action row: caller passes pre-built HTML (different for group vs
  // social vs no-actions on personal recent). When omitted we render no
  // actions block so there's no empty footer.
  const actionsHtml = opts.actionsHtml || '';
  const lastCommentHtml = opts.lastCommentHtml || '';

  const cardClick = opts.cardClickAttr || '';
  const cardId = opts.cardId ? ` id="${escapeHTML(opts.cardId)}"` : '';
  const cardData = opts.cardDataAttrs || '';

  return `<article class="feed-card"${cardId} ${cardClick} ${cardData}>
    <header class="feed-card-header">
      <div class="feed-avatar" style="${avatarStyle}" ${headerExtra}>${escapeHTML(ownerAvatar)}</div>
      <div class="feed-info">
        <div class="feed-name" style="${headerCursor}" ${headerExtra}>${escapeHTML(ownerName || '?')}</div>
        <div class="feed-date">${dateLine}</div>
      </div>
      ${_feedSourceBadge(w)}
    </header>
    <div class="feed-card-title">
      <span class="feed-card-title-emoji">${activityEmoji(w.activity_type)}</span>
      <span class="feed-card-title-text">${escapeHTML(title)}</span>
      ${intBadge}
    </div>
    <div class="feed-hero">${heroInner}</div>
    <div class="feed-kpi-grid">${_kpiGridHtml(w)}</div>
    ${notesSnip}
    ${actionsHtml}
    ${lastCommentHtml}
  </article>`;
}

function renderFeedItems(items, members, reactions, comments) {
  const colors = ['#2E86C1', '#E74C3C', '#2ECC71', '#9B59B6', '#F39C12', '#1ABC9C'];
  const html = items.map(w => {
    const globalIdx = _feedAllItems.indexOf(w);
    const mi = members.findIndex(m => m.id === w.profile_id);
    const member = members[mi] || {};
    const color = colors[mi % colors.length] || '#2E86C1';
    const likes = reactions.filter(r => r.workout_id === w.id && r.reaction === 'like');
    const dislikes = reactions.filter(r => r.workout_id === w.id && r.reaction === 'dislike');
    const myReaction = reactions.find(r => r.workout_id === w.id && r.profile_id === currentProfile.id);
    const wComments = (comments || []).filter(c => c.workout_id === w.id);
    const commentCount = wComments.length;
    const lastComment = wComments.length ? wComments[wComments.length - 1] : null;

    let lastCommentHtml = '';
    if (lastComment) {
      const commenter = members.find(m => m.id === lastComment.profile_id);
      const commenterName = commenter ? commenter.name : '?';
      const truncated = lastComment.text.length > 80 ? lastComment.text.slice(0, 80) + '...' : lastComment.text;
      lastCommentHtml = `<div class="feed-last-comment"><span class="feed-comment-author">${escapeHTML(commenterName)}</span> ${escapeHTML(truncated)}</div>`;
    }

    const likeActive = myReaction?.reaction === 'like';
    const dislikeActive = myReaction?.reaction === 'dislike';
    const actionsHtml = `<div class="feed-reactions" onclick="event.stopPropagation()">
      <button class="react-btn-sm${likeActive ? ' active' : ''}" data-react-btn="like" onclick="event.stopPropagation();handleFeedReaction('${escapeHTML(w.id)}','like')" aria-label="Gilla">
        <svg viewBox="0 0 24 24" fill="${likeActive ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.5" width="14" height="14"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>
        <span class="react-count" data-react-count data-count="${likes.length}">${likes.length || ''}</span>
      </button>
      <button class="react-btn-sm${dislikeActive ? ' active' : ''}" data-react-btn="dislike" onclick="event.stopPropagation();handleFeedReaction('${escapeHTML(w.id)}','dislike')" aria-label="Ogilla">
        <svg viewBox="0 0 24 24" fill="${dislikeActive ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.5" width="14" height="14"><path d="M10 15V19a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z"/><path d="M17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg>
        <span class="react-count" data-react-count data-count="${dislikes.length}">${dislikes.length || ''}</span>
      </button>
      <span class="feed-comment-count" aria-label="Kommentarer">💬 ${commentCount || ''}</span>
    </div>`;

    // Seed _myReactionMap from this render so optimistic clicks have a
    // truthful "previous state" without needing a fresh fetch.
    if (myReaction) window._myReactionMap.set(w.id, myReaction.reaction);
    else if (!window._myReactionMap.has(w.id)) window._myReactionMap.set(w.id, null);

    return _buildFeedCardHtml(w, {
      ownerName: member.name || '?',
      ownerColor: color,
      ownerAvatar: (member.name || '?')[0].toUpperCase(),
      cardClickAttr: `onclick="openFeedWorkout(${globalIdx})"`,
      cardDataAttrs: `data-workout-id="${escapeHTML(w.id)}"`,
      actionsHtml,
      lastCommentHtml,
    });
  }).join('');
  // Lazy-init Leaflet for any new .feed-hero-map nodes the next paint.
  requestAnimationFrame(() => initMapThumbnails());
  return html;
}

function openFeedWorkout(idx) {
  if (!_feedReactionsCache) return;
  const w = _feedReactionsCache.recent[idx];
  if (w) openWorkoutModal(w);
}

function handleFeedReaction(workoutId, type) {
  // Optimistic: update DOM on the same frame as the click. We compute prev
  // from the in-memory map (seeded by the last render) and pass it to
  // toggleReaction so the DB write skips the SELECT.
  const { prev, next } = _applyOptimisticLike(workoutId, type);
  toggleReaction(workoutId, type, prev)
    .then(() => {
      // Mutate the cached reaction list in place so a subsequent showMoreFeed
      // (which appends rows from the cache) reflects the new state without a
      // refetch. Avoids the visible DOM rebuild that used to flash here.
      if (_feedReactionsCache && Array.isArray(_feedReactionsCache.reactions) && currentProfile) {
        const arr = _feedReactionsCache.reactions;
        for (let i = arr.length - 1; i >= 0; i--) {
          const r = arr[i];
          if (r.workout_id === workoutId && r.profile_id === currentProfile.id) arr.splice(i, 1);
        }
        if (next) {
          arr.push({ workout_id: workoutId, profile_id: currentProfile.id, reaction: next });
        }
      }
    })
    .catch(err => {
      console.warn('toggleReaction failed, rolling back', err);
      _applyOptimisticLike(workoutId, prev || type);
      if (typeof showToast === 'function') showToast('Kunde inte spara reaktion');
    });
}

async function refreshFeedReactions() {
  if (_cachedGroupWorkouts.length && _cachedGroupMembers.length) {
    await renderGroupFeed(_cachedGroupWorkouts, _cachedGroupMembers);
  }
}

async function sendNudge(receiverId, btnEl) {
  if (_sentNudges.has(receiverId)) return;
  // receiverName is read from the button's data attribute when needed, but
  // currently not used beyond logging — kept for future expansion.
  // const receiverName = btnEl ? btnEl.dataset.memberName : '';

  try {
    const { error } = await sb.from('nudges').insert({
      sender_id: currentProfile.id,
      receiver_id: receiverId,
      message: `${currentProfile.name} gav dig en puff! Dags att träna! 💪`
    });
    if (error) throw error;

    _sentNudges.add(receiverId);
    btnEl.classList.add('sent');
    btnEl.disabled = true;
    btnEl.innerHTML = '✓ Puff skickad';

    sendPushToUser(receiverId);

    // Send email notification
    try {
      const { data: { session } } = await sb.auth.getSession();
      fetch(SUPABASE_FUNCTIONS_URL + '/send-nudge-email', {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': 'Bearer ' + session.access_token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          receiver_id: receiverId,
          message: `${currentProfile.name} gav dig en puff! Dags att träna! 💪`
        })
      });
    } catch (emailErr) {
      console.error('Nudge email error:', emailErr);
    }
  } catch (e) {
    console.error('Nudge error:', e);
    showAlertModal('Fel', 'Kunde inte skicka puff. Försök igen.');
  }
}

// ═══════════════════════
//  NUDGE NOTIFICATIONS
// ═══════════════════════
let _nudgePanelOpen = false;

function toggleNudgePanel() {
  _nudgePanelOpen = !_nudgePanelOpen;
  document.getElementById('nudge-panel').classList.toggle('hidden', !_nudgePanelOpen);
  if (_nudgePanelOpen) loadNudges();
}

async function loadNudges() {
  if (!currentProfile) return;
  try {
    const { data: nudges } = await sb.from('nudges')
      .select('*')
      .eq('receiver_id', currentProfile.id)
      .order('created_at', { ascending: false })
      .limit(30);

    const listEl = document.getElementById('nudge-list');
    if (!nudges || nudges.length === 0) {
      listEl.innerHTML = '<div class="empty-state"><p>Inga notiser</p></div>';
      return;
    }

    let pendingInvIds = [];
    const invitationNudges = nudges.filter(n => n.type === 'invitation');
    if (invitationNudges.length > 0) {
      const { data: invs } = await sb.from('workout_invitations')
        .select('*')
        .eq('receiver_id', currentProfile.id)
        .eq('status', 'pending');
      pendingInvIds = (invs || []).map(inv => inv.id);
    }

    const senderProfiles = {};
    for (const p of allProfiles) { senderProfiles[p.id] = p; }

    listEl.innerHTML = nudges.map(n => {
      const sender = senderProfiles[n.sender_id];
      const senderName = sender ? sender.name : 'Någon';
      const ago = formatTimeAgo(new Date(n.created_at));
      const nType = n.type || 'nudge';

      let icon = '👊';
      let actions = '';
      if (nType === 'invitation') {
        icon = '📩';
        const hasPending = invitationNudges.length > 0;
        if (hasPending) {
          actions = `<div class="nudge-actions">
            <button class="btn btn-sm invite-accept-btn" onclick="event.stopPropagation();acceptInviteFromNudge('${escapeHTML(n.sender_id)}', '${escapeHTML(n.id)}')">Acceptera</button>
            <button class="btn btn-sm invite-decline-btn" onclick="event.stopPropagation();declineInviteFromNudge('${escapeHTML(n.sender_id)}', '${escapeHTML(n.id)}')">Avböj</button>
          </div>`;
        }
      } else if (nType === 'invitation_accepted') {
        icon = '✅';
      } else if (nType === 'invitation_declined') {
        icon = '❌';
      }

      return `<div class="nudge-item${n.seen ? '' : ' unread'}">
        <div class="nudge-icon">${icon}</div>
        <div class="nudge-content">
          <div class="nudge-sender">${escapeHTML(senderName)}</div>
          <div class="nudge-msg">${escapeHTML(n.message)}</div>
          ${actions}
          <div class="nudge-time">${escapeHTML(ago)}</div>
        </div>
      </div>`;
    }).join('');

    const unseenIds = nudges.filter(n => !n.seen).map(n => n.id);
    if (unseenIds.length > 0) {
      await sb.from('nudges').update({ seen: true }).in('id', unseenIds);
      updateNudgeBadge();
    }
  } catch (e) {
    console.error('Load nudges error:', e);
  }
}

async function acceptInviteFromNudge(senderId, nudgeId) {
  try {
    const { data: invs } = await sb.from('workout_invitations')
      .select('*')
      .eq('sender_id', senderId)
      .eq('receiver_id', currentProfile.id)
      .eq('status', 'pending')
      .order('workout_date', { ascending: true })
      .limit(1);

    if (!invs || invs.length === 0) {
      await showAlertModal('Hm', 'Hittade ingen väntande inbjudan.');
      return;
    }
    await respondToInvitation(invs[0].id, true);
    await showAlertModal('Accepterat', `Du har accepterat inbjudan till ${invs[0].activity_type}!`);
  } catch (e) {
    console.error('Accept invite error:', e);
  }
}

async function declineInviteFromNudge(senderId, nudgeId) {
  try {
    const { data: invs } = await sb.from('workout_invitations')
      .select('*')
      .eq('sender_id', senderId)
      .eq('receiver_id', currentProfile.id)
      .eq('status', 'pending')
      .order('workout_date', { ascending: true })
      .limit(1);

    if (!invs || invs.length === 0) {
      await showAlertModal('Hm', 'Hittade ingen väntande inbjudan.');
      return;
    }
    await respondToInvitation(invs[0].id, false);
    await showAlertModal('Avböjt', 'Inbjudan avböjd.');
  } catch (e) {
    console.error('Decline invite error:', e);
  }
}

async function updateNudgeBadge() {
  if (!currentProfile) return;
  try {
    const { count } = await sb.from('nudges')
      .select('*', { count: 'exact', head: true })
      .eq('receiver_id', currentProfile.id)
      .eq('seen', false);

    const badge = document.getElementById('nudge-badge');
    if (count > 0) {
      badge.textContent = count > 9 ? '9+' : count;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  } catch (e) {
    console.error('Badge update error:', e);
  }
}

function formatTimeAgo(date) {
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'Just nu';
  if (diffMins < 60) return `${diffMins} min sedan`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h sedan`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return 'Igår';
  return `${diffDays} dagar sedan`;
}

// ═══════════════════════
//  STRAVA INTEGRATION
// ═══════════════════════
let _stravaConnection = null;

async function checkStravaConnection() {
  if (!currentProfile) return;
  try {
    const { data, error } = await sb.from('strava_connections')
      .select('*')
      .eq('profile_id', currentProfile.id)
      .maybeSingle();
    _stravaConnection = error ? null : data;
  } catch (e) {
    _stravaConnection = null;
  }
  updateStravaUI();
  autoSyncStravaIfStale();
}

async function autoSyncStravaIfStale() {
  if (!_stravaConnection || !currentProfile) return;
  const lastSync = _stravaConnection.last_sync_at;
  if (lastSync) {
    const elapsed = Date.now() - new Date(lastSync).getTime();
    if (elapsed < 3600_000) return;
  }
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return;
    // Pass since:null so the server takes the incremental path. Sending
    // a truthy `since` puts the function into chunked deep-sync mode,
    // which is reserved for "Synka allt".
    const res = await fetch(SUPABASE_FUNCTIONS_URL + '/strava-sync', {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + session.access_token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ profile_id: currentProfile.id, since: null }),
    });

    let bodyText = '';
    let result = null;
    try {
      bodyText = await res.text();
      if (bodyText) result = JSON.parse(bodyText);
    } catch (e) {
      console.warn('Auto-sync Strava: response not JSON', { status: res.status, body: bodyText.slice(0, 300), parseError: e });
    }

    if (!res.ok || !result) {
      console.error('Auto-sync Strava failed:', { status: res.status, body: bodyText.slice(0, 500) });
      return;
    }

    console.log(`Strava auto-sync: imported=${result.imported}, fetched=${result.totalFetched}, skipped=${result.skipped}`, result.debug);
    if (result.last_sync_at) _stravaConnection.last_sync_at = result.last_sync_at;
    updateStravaUI();
    if (result.imported > 0) navigate(currentView);
  } catch (e) {
    console.error('Auto-sync Strava failed:', e);
  }
}

function updateStravaUI() {
  const el = document.getElementById('sm-strava-info');
  if (!el) return;

  if (!STRAVA_CLIENT_ID) {
    el.innerHTML = '<div class="strava-sync-info">Strava Client ID ej konfigurerat</div>';
    return;
  }

  if (_stravaConnection) {
    const syncText = _stravaConnection.last_sync_at
      ? `Senast synkad: ${new Date(_stravaConnection.last_sync_at).toLocaleString('sv-SE', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
      : 'Ej synkad ännu';
    el.innerHTML = `
      <div class="strava-status">
        <div class="strava-connected-row">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="20 6 9 17 4 12"/></svg>
          Strava kopplad
        </div>
        <div class="strava-sync-info">${syncText}</div>
        <div class="strava-actions">
          <button class="strava-sync-btn" id="strava-sync-btn" onclick="syncStrava()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            Synka
          </button>
          <button class="strava-sync-btn strava-deep-sync-btn" onclick="syncStravaAll()">Synka allt</button>
          <button class="strava-disconnect-btn" onclick="disconnectStrava()">Koppla från</button>
        </div>
        <div class="strava-powered-by">
          <svg viewBox="0 0 24 24" width="10" height="10" fill="#FC4C02"><path d="M15.387 17.944l-2.089-4.116h-3.065L15.387 24l5.15-10.172h-3.066m-7.008-5.599l2.836 5.599h4.172L10.463 0l-7 13.828h4.169"/></svg>
          Powered by Strava
        </div>
      </div>`;
  } else {
    el.innerHTML = `
      <button class="strava-connect-btn" onclick="connectStrava()">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="#fff"><path d="M15.387 17.944l-2.089-4.116h-3.065L15.387 24l5.15-10.172h-3.066m-7.008-5.599l2.836 5.599h4.172L10.463 0l-7 13.828h4.169"/></svg>
        Connect with Strava
      </button>`;
  }
}

async function connectStrava() {
  if (!STRAVA_CLIENT_ID || !currentProfile) return;
  try {
    // SECURITY (assessment H2): fetch a random, single-use `state` from the
    // `oauth-state` Edge Function instead of using the guessable profile_id.
    const { data: { session } } = await sb.auth.getSession();
    const res = await fetch(SUPABASE_FUNCTIONS_URL + '/oauth-state', {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + session.access_token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ provider: 'strava' }),
    });
    if (!res.ok) {
      await showAlertModal('Fel', 'Kunde inte starta Strava-anslutning. Försök igen.');
      return;
    }
    const { state } = await res.json();
    const scope = 'activity:read_all';
    const url = `https://www.strava.com/oauth/authorize?client_id=${STRAVA_CLIENT_ID}&redirect_uri=${encodeURIComponent(STRAVA_REDIRECT_URI)}&response_type=code&scope=${scope}&state=${encodeURIComponent(state)}&approval_prompt=force`;
    window.location.href = url;
  } catch (e) {
    console.error('connectStrava error:', e);
    await showAlertModal('Fel', 'Kunde inte starta Strava-anslutning. Försök igen.');
  }
}

async function disconnectStrava() {
  if (!_stravaConnection) return;
  const confirmed = await showConfirmModal(
    'Koppla från Strava',
    'Dina manuella pass påverkas inte. Automatisk import stoppas.',
    'Koppla från',
    true
  );
  if (!confirmed) return;

  const { error } = await sb.from('strava_connections')
    .delete()
    .eq('id', _stravaConnection.id);
  if (error) {
    await showAlertModal('Fel', 'Kunde inte koppla från: ' + error.message);
    return;
  }
  _stravaConnection = null;
  updateStravaUI();
}

function buildStravaSyncMessage(result, deep = false) {
  const imp = result.imported || 0;
  const fetched = result.totalFetched || 0;
  const sShort = result.skippedShort || 0;
  const sType = result.skippedType || 0;
  const sErr = result.skippedError || 0;
  const lines = [];

  if (imp > 0) {
    lines.push(`${imp} pass importerade${deep ? ' (full synk)' : ''}.`);
  } else if (fetched === 0) {
    lines.push('Strava returnerade 0 aktiviteter.');
    lines.push('Möjliga orsaker:');
    lines.push('• Behörigheten saknar "all activities" — koppla från och anslut igen, godkänn alla rutor.');
    lines.push('• Aktiviteterna är äldre än sökperioden (vanlig synk tittar 14 dagar bakåt; använd "Synka allt" för full historik).');
  } else {
    lines.push('Inga nya pass att importera.');
    lines.push(`Hämtade ${fetched} från Strava, men inga var nya.`);
  }

  if (sShort > 0) lines.push(`${sShort} pass hoppades över (kortare än 5 min).`);
  if (sType > 0) lines.push(`${sType} pass hoppades över (sport-typ filtreras: t.ex. Walk, Hike, Yoga, Tennis).`);
  if (sErr > 0) lines.push(`${sErr} pass kunde inte sparas (databas-fel) — testa synka igen.`);

  if (fetched > 0 && imp === 0 && sShort === 0 && sType === 0 && sErr === 0) {
    lines.push('(Alla hämtade pass finns redan i din historik.)');
  }

  return lines.join('\n');
}

async function syncStrava() {
  if (!_stravaConnection || !currentProfile) return;
  const btn = document.getElementById('strava-sync-btn');
  if (btn) { btn.classList.add('syncing'); btn.textContent = 'Synkar...'; }

  try {
    // Pass since:null so the server takes the incremental path. The deep
    // sync (chunked, cursor-based) is reserved for "Synka allt".
    const req = await _stravaSyncRequest(null);
    const { res, result, bodyText, parseError } = req;

    if (res.ok && result) {
      if (result.last_sync_at) _stravaConnection.last_sync_at = result.last_sync_at;
      updateStravaUI();
      console.log(
        `Strava sync: imported=${result.imported}, fetched=${result.totalFetched}, ` +
        `skipped=${result.skipped} (short=${result.skippedShort||0}, type=${result.skippedType||0}, ` +
        `error=${result.skippedError||0})`,
        result.debug
      );
      await showAlertModal('Synk klar', buildStravaSyncMessage(result));
      navigate(currentView);
    } else {
      const status = res.status;
      const detail = _formatStravaSyncError({ status, result, bodyText, parseError });
      console.error('Strava sync failed:', { status, body: bodyText?.slice(0, 1000), parseError });
      await showAlertModal('Synk-fel', `Tekniskt fel (HTTP ${status}). ${detail}`);
    }
  } catch (e) {
    console.error('Strava sync error:', e);
    await showAlertModal('Synk-fel', 'Nätverksfel vid synkning');
  }

  if (btn) { btn.classList.remove('syncing'); btn.textContent = 'Synka'; }
}

// Fixed historical floor for the deep "Synka allt" backfill. Covers full
// current season + ample CTL warm-up. The server walks BACKWARDS from now
// to this floor across many short edge-fn invocations (cursor on
// strava_connections), so the floor doesn't need to track "N years from
// now" — it's a hard calendar date. Revisit annually when the season
// rolls over and the warm-up window stops being useful.
function _deepSyncFloorDate() { return '2025-01-01'; }

// Backwards-compat shim in case anything in the wild still calls the old
// name (devtools snippets, console plays). Safe to remove once nobody
// references it.
function _deepSyncSinceDate() { return _deepSyncFloorDate(); }

function _setDeepSyncProgress(text) {
  const btn = document.querySelector('.strava-deep-sync-btn');
  if (btn) {
    btn.textContent = text || 'Synka allt';
    if (text) btn.classList.add('syncing'); else btn.classList.remove('syncing');
  }
  // Also surface progress in the inline sync info line so users see it
  // even if the button label is truncated on narrow screens.
  const info = document.querySelector('.strava-sync-info');
  if (info && text) {
    info.dataset.deepSyncOriginal = info.dataset.deepSyncOriginal || info.textContent || '';
    info.textContent = text;
  } else if (info && info.dataset.deepSyncOriginal) {
    info.textContent = info.dataset.deepSyncOriginal;
    delete info.dataset.deepSyncOriginal;
  }
}

async function _stravaSyncRequest(sinceDate) {
  const { data: { session } } = await sb.auth.getSession();
  const res = await fetch(SUPABASE_FUNCTIONS_URL + '/strava-sync', {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': 'Bearer ' + session.access_token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ profile_id: currentProfile.id, since: sinceDate || null }),
  });

  // 503/504/timeout/HTML pages: read body as text, never as JSON. The old
  // code did res.json() unconditionally and then claimed "Okänt fel" when
  // the parse failed.
  let result = null;
  let parseError = null;
  let bodyText = '';
  try {
    bodyText = await res.text();
    if (bodyText) result = JSON.parse(bodyText);
  } catch (e) {
    parseError = e;
  }
  return { res, result, bodyText, parseError };
}

// Build a human-readable error line for Strava sync failures. Supabase's
// Edge Functions gateway returns 502s for two very different things — our
// own function returning 502 with a JSON body (e.g. strava_api_error), or
// the runtime itself failing (BOOT_ERROR, WORKER_LIMIT, timeout) with an
// HTML / plain-text body. The previous logic only surfaced bodies < 200
// chars, which silently swallowed every gateway error and made debugging
// 502s impossible. Now we always surface SOMETHING:
//   * JSON {"error":"..."} → use the error field
//   * Short text body → show as-is
//   * Long / HTML body → look for known platform keywords and tag the
//     failure (boot, timeout, capacity) so the user (and we) know it's a
//     platform issue, not a Strava issue.
function _formatStravaSyncError({ status, result, bodyText, parseError }) {
  if (result?.error === 'strava_auth_revoked') {
    return 'Strava-anslutningen har återkallats eller löpt ut. Klicka "Koppla från" och anslut Strava igen.';
  }
  if (result?.error === 'strava_api_error') {
    // Server now forwards the upstream Strava status + a short message.
    const ss = result.strava_status ? ` ${result.strava_status}` : '';
    const sm = result.strava_message ? `: ${result.strava_message}` : '';
    return `Strava API-fel${ss}${sm}`;
  }
  if (result?.error) return result.error;
  const text = (bodyText || '').trim();
  if (!text) {
    return parseError ? 'svaret kunde inte tolkas' : 'inget felmeddelande från servern';
  }
  if (text.length <= 200) return text;
  const upper = text.toUpperCase();
  if (upper.includes('BOOT_ERROR') || upper.includes('UNCAUGHT EXCEPTION')) {
    return 'edge function kraschade vid start (BOOT_ERROR) — kontrollera Supabase function-loggarna';
  }
  if (upper.includes('WORKER_LIMIT') || upper.includes('CPU TIME') || upper.includes('WALL CLOCK') || upper.includes('TIMEOUT')) {
    return 'edge function tidsade ut eller slog i resursgränsen — kontrollera Supabase function-loggarna';
  }
  if (upper.includes('<HTML') || upper.includes('BAD GATEWAY') || upper.includes('NGINX') || upper.includes('CLOUDFLARE')) {
    return `gateway-fel (${status}) — Supabase-runtime svarade inte med JSON; kontrollera function-loggarna`;
  }
  return text.slice(0, 200) + '…';
}

async function syncStravaAll() {
  if (!_stravaConnection || !currentProfile) return;
  const sinceDate = _deepSyncFloorDate();
  const confirmed = await showConfirmModal(
    'Synka allt från Strava',
    `Detta hämtar alla aktiviteter sedan ${sinceDate} från Strava och fyller i hela tränings­historiken som syns i graferna. Det görs i flera mindre steg och kan ta någon minut.\n\nVanlig synk sker automatiskt varje timme.`,
    'Synka allt ändå',
    false
  );
  if (!confirmed) return;

  _setDeepSyncProgress('Synkar... 0%');

  let totalImported = 0;
  let totalFetched = 0;
  let totalSkipped = 0;
  let totalSkippedShort = 0;
  let totalSkippedType = 0;
  let totalSkippedError = 0;
  let chunkIdx = 0;
  let lastResult = null;

  try {
    while (true) {
      chunkIdx++;
      _setDeepSyncProgress(`Synkar... batch ${chunkIdx} • ${totalImported} importerade`);

      // Try the request, with up to 3 retries for transient platform
      // errors (503/504, network glitch, edge fn cold-start kill).
      let attempt = 0;
      let req = null;
      while (attempt < 3) {
        attempt++;
        req = await _stravaSyncRequest(sinceDate);
        if (req.res.ok && req.result) break;

        const status = req.res.status;
        const transient = (status >= 500 && status <= 599) || status === 0 || status === 408;
        if (!transient || attempt >= 3) break;

        const waitMs = [5_000, 10_000, 20_000][Math.min(attempt - 1, 2)];
        _setDeepSyncProgress(`Tillfälligt fel (HTTP ${status}). Försöker igen om ${waitMs / 1000}s...`);
        await new Promise(r => setTimeout(r, waitMs));
      }

      if (!req.res.ok || !req.result) {
        const status = req.res.status;
        const detail = _formatStravaSyncError({
          status,
          result: req.result,
          bodyText: req.bodyText,
          parseError: req.parseError,
        });
        const msg = `Tekniskt fel (HTTP ${status}). ${detail}`;
        console.error('Strava deep sync request failed:', status, req.bodyText?.slice(0, 1000), req.parseError);
        await showAlertModal('Synk-fel', msg);
        break;
      }

      const result = req.result;
      lastResult = result;
      totalImported += result.imported || 0;
      totalFetched += result.totalFetched || 0;
      totalSkipped += result.skipped || 0;
      totalSkippedShort += result.skippedShort || 0;
      totalSkippedType += result.skippedType || 0;
      totalSkippedError += result.skippedError || 0;

      if (result.last_sync_at) _stravaConnection.last_sync_at = result.last_sync_at;

      const pct = Math.max(0, Math.min(100, result.progress_pct || 0));
      _setDeepSyncProgress(`Synkar... ${pct}% • ${totalImported} importerade`);

      console.log(
        `Strava deep sync chunk ${chunkIdx}: imported=${result.imported}, fetched=${result.totalFetched}, ` +
        `skipped=${result.skipped} (short=${result.skippedShort||0}, type=${result.skippedType||0}, ` +
        `error=${result.skippedError||0}), pct=${pct}, done=${result.done}`,
        result.debug
      );

      if (result.done) break;

      if (result.rate_limited) {
        const waitS = Math.max(5, Math.min(120, result.retry_after_s || 60));
        _setDeepSyncProgress(`Strava rate-limit, väntar ${waitS}s...`);
        await new Promise(r => setTimeout(r, waitS * 1000));
      }

      // Small inter-chunk pause keeps us well under Strava's 100req/15min.
      await new Promise(r => setTimeout(r, 500));
    }

    if (lastResult && lastResult.done) {
      const summary = buildStravaSyncMessage({
        imported: totalImported,
        totalFetched,
        skipped: totalSkipped,
        skippedShort: totalSkippedShort,
        skippedType: totalSkippedType,
        skippedError: totalSkippedError,
      }, true);
      await showAlertModal('Full synk klar', summary);
      navigate(currentView);
    }
  } catch (e) {
    console.error('Strava deep sync error:', e);
    await showAlertModal('Synk-fel', 'Nätverksfel vid synkning');
  } finally {
    updateStravaUI();
  }
}

function handleStravaRedirect() {
  const params = new URLSearchParams(window.location.search);
  if (params.has('strava_connected')) {
    history.replaceState(null, '', window.location.pathname);
    setTimeout(() => showAlertModal('Strava kopplad!', 'Ditt Strava-konto är nu anslutet. Dina pass synkas automatiskt.'), 500);
  } else if (params.has('strava_error')) {
    const err = params.get('strava_error');
    history.replaceState(null, '', window.location.pathname);
    setTimeout(() => showAlertModal('Strava-fel', 'Kunde inte koppla Strava: ' + err), 500);
  }
}

function stravaSourceBadge(workout) {
  if (workout.source !== 'strava') return '';
  return `<span class="strava-badge"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.387 17.944l-2.089-4.116h-3.065L15.387 24l5.15-10.172h-3.066m-7.008-5.599l2.836 5.599h4.172L10.463 0l-7 13.828h4.169"/></svg>Strava</span>`;
}

// ═══════════════════════
//  GARMIN INTEGRATION
// ═══════════════════════
let _garminConnection = null;

async function checkGarminConnection() {
  if (!currentProfile) return;
  try {
    const { data, error } = await sb.from('garmin_connections')
      .select('*')
      .eq('profile_id', currentProfile.id)
      .maybeSingle();
    _garminConnection = error ? null : data;
  } catch (e) {
    _garminConnection = null;
  }
  updateGarminUI();
}

function updateGarminUI() {
  const el = document.getElementById('sm-garmin-info');
  if (!el) return;

  if (!GARMIN_CLIENT_ID) {
    el.innerHTML = '<div class="garmin-sync-info">Garmin Client ID ej konfigurerat</div>';
    return;
  }

  if (_garminConnection) {
    const syncText = _garminConnection.last_sync_at
      ? `Senast synkad: ${new Date(_garminConnection.last_sync_at).toLocaleString('sv-SE', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
      : 'Ej synkad ännu';
    el.innerHTML = `
      <div class="garmin-status">
        <div class="garmin-connected-row">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="20 6 9 17 4 12"/></svg>
          Garmin kopplad
        </div>
        <div class="garmin-sync-info">${syncText}</div>
        <div class="garmin-actions">
          <button class="garmin-sync-btn" id="garmin-sync-btn" onclick="syncGarmin()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            Synka nu
          </button>
          <button class="garmin-disconnect-btn" onclick="disconnectGarmin()">Koppla från</button>
        </div>
      </div>`;
  } else {
    el.innerHTML = `
      <button class="garmin-connect-btn" onclick="connectGarmin()">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="#fff"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
        Connect with Garmin
      </button>`;
  }
}

async function connectGarmin() {
  if (!GARMIN_CLIENT_ID || !currentProfile) return;
  try {
    // SECURITY (assessment H2 + H3): request a random `state` and a PKCE
    // `code_challenge` from the server. The matching `code_verifier` stays
    // on the server; we never receive it or include it in the URL.
    const { data: { session } } = await sb.auth.getSession();
    const res = await fetch(SUPABASE_FUNCTIONS_URL + '/oauth-state', {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + session.access_token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ provider: 'garmin' }),
    });
    if (!res.ok) {
      await showAlertModal('Fel', 'Kunde inte starta Garmin-anslutning. Försök igen.');
      return;
    }
    const { state, code_challenge, code_challenge_method } = await res.json();
    const qs = new URLSearchParams({
      client_id: GARMIN_CLIENT_ID,
      redirect_uri: GARMIN_REDIRECT_URI,
      response_type: 'code',
      scope: 'activity:read',
      state,
    });
    if (code_challenge) {
      qs.set('code_challenge', code_challenge);
      qs.set('code_challenge_method', code_challenge_method || 'S256');
    }
    window.location.href = `${GARMIN_AUTH_URL}?${qs.toString()}`;
  } catch (e) {
    console.error('connectGarmin error:', e);
    await showAlertModal('Fel', 'Kunde inte starta Garmin-anslutning. Försök igen.');
  }
}

async function disconnectGarmin() {
  if (!_garminConnection) return;
  const confirmed = await showConfirmModal(
    'Koppla från Garmin',
    'Dina manuella pass påverkas inte. Automatisk import stoppas.',
    'Koppla från',
    true
  );
  if (!confirmed) return;

  const { error } = await sb.from('garmin_connections')
    .delete()
    .eq('id', _garminConnection.id);
  if (error) {
    await showAlertModal('Fel', 'Kunde inte koppla från: ' + error.message);
    return;
  }
  _garminConnection = null;
  updateGarminUI();
}

async function syncGarmin() {
  if (!_garminConnection || !currentProfile) return;
  const btn = document.getElementById('garmin-sync-btn');
  if (btn) { btn.classList.add('syncing'); btn.textContent = 'Synkar...'; }

  try {
    const { data: { session } } = await sb.auth.getSession();
    const res = await fetch(SUPABASE_FUNCTIONS_URL + '/garmin-sync', {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + session.access_token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ profile_id: currentProfile.id }),
    });

    const result = await res.json();
    if (res.ok) {
      _garminConnection.last_sync_at = result.last_sync_at;
      updateGarminUI();
      if (result.debug) console.log('Garmin sync debug:', result.debug);
      let msg = result.imported > 0
        ? `${result.imported} nya pass importerade.`
        : 'Inga nya pass att importera.';
      if (result.skipped > 0) msg += `\n${result.skipped} pass hoppades över.`;
      if (result.debug?.firstError) msg += `\n${result.skipped || 'Några'} pass kunde inte sparas. Testa synka igen.`;
      await showAlertModal('Synk klar', msg);
      navigate(currentView);
    } else {
      await showAlertModal('Synk-fel', result.error || 'Okänt fel');
    }
  } catch (e) {
    console.error('Garmin sync error:', e);
    await showAlertModal('Synk-fel', 'Nätverksfel vid synkning');
  }

  if (btn) { btn.classList.remove('syncing'); btn.textContent = 'Synka nu'; }
}

function handleGarminRedirect() {
  const params = new URLSearchParams(window.location.search);
  if (params.has('garmin_connected')) {
    history.replaceState(null, '', window.location.pathname);
    setTimeout(() => showAlertModal('Garmin kopplad!', 'Ditt Garmin-konto är nu anslutet. Dina pass synkas automatiskt.'), 500);
  } else if (params.has('garmin_error')) {
    const err = params.get('garmin_error');
    history.replaceState(null, '', window.location.pathname);
    setTimeout(() => showAlertModal('Garmin-fel', 'Kunde inte koppla Garmin: ' + err), 500);
  }
}

function garminSourceBadge(workout) {
  if (workout.source !== 'garmin') return '';
  return `<span class="garmin-badge"><svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>Garmin</span>`;
}

function sourceBadge(workout) {
  return stravaSourceBadge(workout) + garminSourceBadge(workout);
}

// ═══════════════════════
//  MEMBER PROFILE MODAL
// ═══════════════════════
async function openMemberProfile(memberId) {
  const modal = document.getElementById('member-profile-modal');
  const titleEl = document.getElementById('mp-title');
  const bodyEl = document.getElementById('mp-body');
  if (!modal || !bodyEl) return;

  let member = allProfiles.find(p => p.id === memberId);
  if (!member) {
    await refreshAllProfiles();
    member = allProfiles.find(p => p.id === memberId);
  }
  if (!member) return;

  const isMe = memberId === currentProfile.id;
  titleEl.textContent = isMe ? `${member.name} (du)` : member.name;
  bodyEl.innerHTML = '<div class="text-dim" style="padding:16px;text-align:center;">Laddar...</div>';
  modal.classList.remove('hidden');

  const { data: workouts } = await sb.from('workouts').select('*')
    .eq('profile_id', memberId)
    .order('workout_date', { ascending: false });
  const all = workouts || [];

  const now = new Date();
  const monday = mondayOfWeek(now);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const weekW = all.filter(w => w.workout_date >= isoDate(monday));
  const monthW = all.filter(w => w.workout_date >= isoDate(monthStart));

  const weekMins = weekW.reduce((s, w) => s + w.duration_minutes, 0);
  const monthMins = monthW.reduce((s, w) => s + w.duration_minutes, 0);
  const totalSessions = all.length;

  // Activity type breakdown (last 30 days)
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const last30 = all.filter(w => w.workout_date >= isoDate(thirtyDaysAgo));
  const typeCounts = {};
  last30.forEach(w => { typeCounts[w.activity_type] = (typeCounts[w.activity_type] || 0) + 1; });
  const typeEntries = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]);

  let html = '<div class="mp-stats">';
  html += `<div class="mp-stat"><div class="mp-stat-value">${(weekMins / 60).toFixed(1)}h</div><div class="mp-stat-label">Denna vecka</div></div>`;
  html += `<div class="mp-stat"><div class="mp-stat-value">${(monthMins / 60).toFixed(1)}h</div><div class="mp-stat-label">Denna månad</div></div>`;
  html += `<div class="mp-stat"><div class="mp-stat-value">${totalSessions}</div><div class="mp-stat-label">Totalt pass</div></div>`;
  html += '</div>';

  if (typeEntries.length > 0) {
    html += '<div class="mp-section-title">Senaste 30 dagarna</div>';
    html += '<div class="mp-type-bars">';
    const maxCount = typeEntries[0][1];
    typeEntries.forEach(([type, count]) => {
      const pct = Math.round((count / maxCount) * 100);
      const color = ACTIVITY_COLORS[type] || '#555';
      html += `<div class="mp-type-row">
        <span class="mp-type-label">${activityEmoji(type)} ${escapeHTML(type)}</span>
        <div class="mp-type-bar-bg"><div class="mp-type-bar" style="width:${pct}%;background:${color};"></div></div>
        <span class="mp-type-count">${count}</span>
      </div>`;
    });
    html += '</div>';
  }

  // Recent workouts
  const recentSlice = all.slice(0, 10);
  if (recentSlice.length > 0) {
    html += '<div class="mp-section-title">Senaste pass</div>';
    html += '<div class="mp-recent">';
    // SECURITY (assessment H1): wire click handlers after render instead of
    // serialising the DB row into an inline onclick attribute (which allowed
    // attribute-injection via field values containing single quotes / HTML).
    const mpRecent = recentSlice.map((w, i) => ({ w, idx: i }));
    mpRecent.forEach(({ w, idx }) => {
      const distStr = w.distance_km ? ` | ${w.distance_km} km` : '';
      const intBadge = w.intensity ? `<span class="intensity-badge">${escapeHTML(w.intensity)}</span>` : '';
      const mapThumb = w.map_polyline ? `<div class="wo-map wo-map-mini" data-polyline="${escapeHTML(w.map_polyline)}"></div>` : '';
      html += `<div class="workout-item clickable${w.map_polyline ? ' workout-item-with-map' : ''}" data-mp-recent-idx="${idx}">
        <div class="workout-icon" style="background:${ACTIVITY_COLORS[w.activity_type] || '#555'}22;">${activityEmoji(w.activity_type)}</div>
        <div class="workout-info">
          <div class="name">${escapeHTML(w.activity_type)}${intBadge}</div>
          <div class="meta">${formatDate(w.workout_date)}</div>
        </div>
        <div class="workout-info duration">${w.duration_minutes} min${distStr}</div>
        ${mapThumb}
      </div>`;
    });
    html += '</div>';
  }

  bodyEl.innerHTML = html;
  // Attach click handlers for recent-workout items (see comment above).
  if (recentSlice.length > 0) {
    bodyEl.querySelectorAll('[data-mp-recent-idx]').forEach(node => {
      const idx = parseInt(node.getAttribute('data-mp-recent-idx'), 10);
      const w = recentSlice[idx];
      if (w) node.addEventListener('click', () => openWorkoutModal(w));
    });
  }
  requestAnimationFrame(() => initMapThumbnails());
}

function closeMemberProfile() {
  document.getElementById('member-profile-modal')?.classList.add('hidden');
}

// ═══════════════════════
//  PUSH NOTIFICATIONS
// ═══════════════════════
async function registerPushSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const reg = await navigator.serviceWorker.register('sw.js');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return;

    const sub = await reg.pushManager.getSubscription();
    if (sub) return; // already subscribed

    // Note: VAPID public key must be configured for production push
    // For now, we store subscription intent; actual push requires server-side VAPID setup
    console.log('Push notification support detected. Configure VAPID keys for full push support.');
  } catch (e) {
    console.log('Push registration not available:', e.message);
  }
}

async function sendPushToUser(receiverId) {
  // Placeholder: In production, this would call a Supabase Edge Function
  // that retrieves the receiver's push subscription and sends a web push.
  // For now, the nudge is stored in the DB and shown when the user opens the app.
  console.log('Nudge stored in DB for user', receiverId);
}

// ═══════════════════════════════════════════════════════════════════
//  AI TRAINING PLAN GENERATOR
// ═══════════════════════════════════════════════════════════════════

let _activePlan = null;
let _activePlanWeeks = [];
let _activePlanWorkouts = [];
let _schemaEditMode = false;
let _wizardStep = 0;
let _wizardShowIntro = true;
let _wizardGoalType = null;
// Realism step state. _wizardRealism is the latest assess-feasibility
// response; _wizardRealismCTA is the current "next" button label (varies
// from "Generera schema" to "Generera ändå" depending on risk).
let _wizardRealism = null;
let _wizardRealismCTA = 'Generera schema';
// Step 5 (milestone review) state. After /generate-plan returns the draft
// plan_id + milestones, we hold the response here and only call
// /generate-plan?mode=confirm_plan when the user clicks "Aktivera schema".
let _wizardDraftPlan = null;

// ── Fetch active plan ──

async function fetchActivePlan(profileId) {
  if (!profileId) return null;
  try {
    const { data } = await sb.from('training_plans')
      .select('*')
      .eq('profile_id', profileId)
      .eq('status', 'active')
      .maybeSingle();
    return data;
  } catch (e) {
    console.error('Fetch active plan error:', e);
    return null;
  }
}

async function fetchPlanWeeks(planId) {
  const { data } = await sb.from('plan_weeks')
    .select('*')
    .eq('plan_id', planId)
    .order('week_number');
  return data || [];
}

async function fetchPlanWorkoutsForWeek(weekId) {
  const { data } = await sb.from('plan_workouts')
    .select('*')
    .eq('plan_week_id', weekId)
    .order('day_of_week');
  return data || [];
}

async function fetchPlanWorkoutsByDate(planId, startDate, endDate) {
  const { data } = await sb.from('plan_workouts')
    .select('*, plan_weeks!inner(plan_id, week_number, phase, notes)')
    .eq('plan_weeks.plan_id', planId)
    .gte('workout_date', startDate)
    .lte('workout_date', endDate)
    .order('workout_date');
  return data || [];
}

// ── Edit mode toggle ──
//
// The Redigera-pill (renderGenerateButton) opens a choice modal where the
// user picks between manual drag-drop and AI-assisted edit. Manual mode
// auto-saves; the only exit affordance is a floating "Klar" button rendered
// above the schema content (#schema-edit-done-bar).

function toggleSchemaEditMode() {
  _schemaEditMode = !_schemaEditMode;
  loadSchema();
}

function exitSchemaEditMode() {
  if (!_schemaEditMode) return;
  _schemaEditMode = false;
  loadSchema();
}

function updateSchemaEditBar() {
  // The pill itself (rendered by renderGenerateButton) replaces the old
  // edit-bar; the only thing left to manage here is the floating "Klar"
  // button, which is shown only while in edit mode.
  const doneBar = document.getElementById('schema-edit-done-bar');
  if (doneBar) doneBar.classList.toggle('hidden', !_schemaEditMode);
}

// ── Edit choice modal (Redigera → manuellt eller AI) ──

function openSchemaEditChoice() {
  const modal = document.getElementById('schema-edit-choice-modal');
  if (modal) modal.classList.remove('hidden');
}

function closeSchemaEditChoice() {
  const modal = document.getElementById('schema-edit-choice-modal');
  if (modal) modal.classList.add('hidden');
}

function chooseEditManual() {
  closeSchemaEditChoice();
  // Manual edit only makes sense in the week view (drag-drop targets the
  // weekly grid). Switch silently if the user is currently in month view.
  if (_schemaView === 'month') {
    _schemaView = 'week';
    try { localStorage.setItem('schema_view_mode', 'week'); } catch (_e) { /* ok */ }
  }
  if (!_schemaEditMode) toggleSchemaEditMode(); else loadSchema();
}

function chooseEditAi() {
  closeSchemaEditChoice();
  if (typeof closePlanManager === 'function') closePlanManager();
  openPlanEditModal();
}

// ── Generate button ──

function renderGenerateButton() {
  const container = document.getElementById('schema-generate-btn-container');
  if (!container) return;
  if (!PLAN_GENERATION_ENABLED) { container.innerHTML = ''; return; }
  if (!currentProfile) { container.innerHTML = ''; return; }

  const label = _activePlan
    ? (_activePlan.name || _activePlan.goal_text || 'Träningsplan')
    : 'Skapa träningsschema';
  const aiBadge = _activePlan?.generation_model ? '<span class="schema-pill-ai">AI</span>' : '';

  // Default surface is just one primary pill + a kebab. Editing, creating
  // a new plan and managing all plans live inside the popover menu so the
  // top of the dashboard stays calm.
  const primaryAction = _activePlan ? 'openPlanManager()' : 'openPlanWizard()';
  const editItem = _activePlan
    ? `<button type="button" class="schema-pill-menu-item" onclick="closeSchemaPillMenu();openSchemaEditChoice()">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
         <span>Redigera schemat</span>
       </button>`
    : '';
  const manageItem = _activePlan
    ? `<button type="button" class="schema-pill-menu-item" onclick="closeSchemaPillMenu();openPlanManager()">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
         <span>Hantera alla scheman</span>
       </button>`
    : '';

  // Without an active plan the primary pill already does "Skapa nytt
  // schema", so the kebab would just duplicate it. Hide it in that state.
  const showMenu = !!_activePlan;
  const kebabHtml = showMenu
    ? `<div class="schema-pill-menu-wrap">
        <button type="button" class="schema-pill-icon-btn" id="schema-pill-menu-btn" aria-label="Fler val" aria-haspopup="true" aria-expanded="false" onclick="toggleSchemaPillMenu(event)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
            <circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/>
          </svg>
        </button>
        <div class="schema-pill-menu hidden" id="schema-pill-menu" role="menu">
          <button type="button" class="schema-pill-menu-item" onclick="closeSchemaPillMenu();openPlanWizard()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            <span>Skapa nytt schema</span>
          </button>
          ${editItem}
          ${manageItem}
        </div>
      </div>`
    : '';

  container.innerHTML = `
    <div class="schema-pill-row">
      <button type="button" class="schema-plan-pill" onclick="${primaryAction}">
        <span class="schema-pill-label">${label}${aiBadge}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      ${kebabHtml}
    </div>`;
}

// ── Schema-pill kebab menu ──
let _schemaPillMenuOpen = false;

function _ensureSchemaPillBackdrop() {
  let bd = document.getElementById('schema-pill-menu-backdrop');
  if (!bd) {
    bd = document.createElement('div');
    bd.id = 'schema-pill-menu-backdrop';
    bd.className = 'schema-pill-menu-backdrop hidden';
    bd.addEventListener('click', closeSchemaPillMenu);
    document.body.appendChild(bd);
  }
  return bd;
}

function toggleSchemaPillMenu(ev) {
  if (ev) ev.stopPropagation();
  const menu = document.getElementById('schema-pill-menu');
  const btn = document.getElementById('schema-pill-menu-btn');
  if (!menu || !btn) return;
  _schemaPillMenuOpen = !_schemaPillMenuOpen;
  const bd = _ensureSchemaPillBackdrop();
  menu.classList.toggle('hidden', !_schemaPillMenuOpen);
  bd.classList.toggle('hidden', !_schemaPillMenuOpen);
  btn.setAttribute('aria-expanded', _schemaPillMenuOpen ? 'true' : 'false');
  if (_schemaPillMenuOpen) {
    setTimeout(() => {
      document.addEventListener('keydown', _schemaPillMenuKeyHandler);
    }, 0);
  } else {
    document.removeEventListener('keydown', _schemaPillMenuKeyHandler);
  }
}

function closeSchemaPillMenu() {
  if (!_schemaPillMenuOpen) return;
  _schemaPillMenuOpen = false;
  const menu = document.getElementById('schema-pill-menu');
  const btn = document.getElementById('schema-pill-menu-btn');
  const bd = document.getElementById('schema-pill-menu-backdrop');
  if (menu) menu.classList.add('hidden');
  if (bd) bd.classList.add('hidden');
  if (btn) btn.setAttribute('aria-expanded', 'false');
  document.removeEventListener('keydown', _schemaPillMenuKeyHandler);
}

function _schemaPillMenuKeyHandler(e) {
  if (e.key === 'Escape') closeSchemaPillMenu();
}

// ═══════════════════════
//  PLAN WIZARD
// ═══════════════════════

function openPlanWizard() {
  _wizardStep = 0;
  _wizardShowIntro = true;
  _wizardGoalType = null;
  _wizardRealism = null;
  _wizardRealismCTA = 'Generera schema';
  _wizardDraftPlan = null;

  const grid = document.getElementById('wizard-goal-grid');
  grid.innerHTML = GOAL_TYPES.map(g =>
    `<div class="wizard-goal-card" data-goal="${g.id}" onclick="selectWizardGoal('${g.id}')">
      <span class="goal-icon">${g.icon}</span>
      <span>${g.label}</span>
    </div>`
  ).join('');

  document.getElementById('wizard-goal-fields').classList.add('hidden');
  document.getElementById('wiz-race-fields').style.display = 'none';
  const raceDistSel = document.getElementById('wiz-race-distance');
  if (raceDistSel) raceDistSel.value = '10';
  const raceDistCustom = document.getElementById('wiz-race-distance-custom');
  if (raceDistCustom) raceDistCustom.value = '';
  const raceDistCustomWrap = document.getElementById('wiz-race-distance-custom-wrap');
  if (raceDistCustomWrap) raceDistCustomWrap.hidden = true;

  const actGrid = document.getElementById('wiz-activity-types');
  actGrid.innerHTML = ACTIVITY_TYPES.filter(t => t !== 'Vila').map(t =>
    `<button type="button" class="wiz-activity-check active" data-type="${t}" onclick="toggleWizActivity(this)">${t}</button>`
  ).join('');

  const nextMon = new Date();
  const dow = nextMon.getDay();
  const diff = dow === 0 ? 1 : dow === 1 ? 0 : 8 - dow;
  nextMon.setDate(nextMon.getDate() + diff);
  document.getElementById('wiz-start-date').value = isoDate(nextMon);

  document.getElementById('wiz-resting-hr').value = '';
  const mhr = document.getElementById('wiz-max-hr');
  if (mhr) mhr.value = currentProfile?.user_max_hr ?? '';
  document.getElementById('wiz-recent-5k').value = '';
  document.getElementById('wiz-recent-10k').value = '';
  document.getElementById('wiz-easy-pace').value = '';
  const prefillHint = document.getElementById('wiz-prefill-hint');
  if (prefillHint) prefillHint.classList.add('hidden');
  prefillWizardFromLastPlan();

  const freeText = document.getElementById('wiz-free-text');
  if (freeText) freeText.value = '';
  const vdp = document.getElementById('wiz-philosophy-vdp');
  if (vdp) vdp.checked = false;
  const philoText = document.getElementById('wiz-philosophy-text');
  if (philoText) philoText.value = '';

  autoPopulateBaseline();
  updateWizardUI();
  document.getElementById('plan-wizard').classList.remove('hidden');
}

function closePlanWizard() {
  document.getElementById('plan-wizard').classList.add('hidden');
  _wizardDraftPlan = null;
}

// TWEAK-2: prefill the wizard's physiology fields (resting HR, max HR, 5k/10k
// times, easy pace) from the user's most recently created training plan so
// they don't have to retype values that haven't changed. Runs async after the
// modal opens — the user typically reads the goal grid first, so the slight
// delay is invisible.
async function prefillWizardFromLastPlan() {
  if (!currentProfile) return;
  try {
    const { data: lastPlan, error } = await sb.from('training_plans')
      .select('baseline')
      .eq('profile_id', currentProfile.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    const b = lastPlan?.baseline;
    if (!b || typeof b !== 'object') return;

    let didFill = false;
    const setIfPresent = (id, val) => {
      if (val === null || val === undefined || val === '') return;
      const el = document.getElementById(id);
      if (!el || el.value) return; // don't clobber what the user already typed
      el.value = val;
      didFill = true;
    };
    setIfPresent('wiz-resting-hr', b.resting_hr);
    setIfPresent('wiz-max-hr', b.max_hr);
    setIfPresent('wiz-recent-5k', b.recent_5k);
    setIfPresent('wiz-recent-10k', b.recent_10k);
    setIfPresent('wiz-easy-pace', b.easy_pace);

    if (didFill) {
      const hint = document.getElementById('wiz-prefill-hint');
      if (hint) hint.classList.remove('hidden');
    }
  } catch (e) {
    console.warn('Prefill from last plan failed:', e);
  }
}

function selectWizardGoal(goalId) {
  _wizardGoalType = goalId;
  document.querySelectorAll('.wizard-goal-card').forEach(c => c.classList.toggle('selected', c.dataset.goal === goalId));
  document.getElementById('wizard-goal-fields').classList.remove('hidden');
  document.getElementById('wiz-race-fields').style.display = (goalId === 'race') ? '' : 'none';
  if (goalId === 'race') onWizRaceDistanceChange();

  const placeholders = {
    race: 't.ex. Halvmarathon under 1:45',
    fitness: 't.ex. Bygga kondition och må bra',
    weight_loss: 't.ex. Tappa 5 kg och behålla muskelmassa',
    sport_specific: 't.ex. Förbättra Hyrox-tid till under 75 min',
    custom: 'Beskriv ditt mål...',
  };
  document.getElementById('wiz-goal-text').placeholder = placeholders[goalId] || '';
}

function toggleWizActivity(btn) {
  btn.classList.toggle('active');
}

// TWEAK-3: race distance picker. Custom input is shown only when the user
// picks "Annan…" from the preset dropdown.
function onWizRaceDistanceChange() {
  const sel = document.getElementById('wiz-race-distance');
  const wrap = document.getElementById('wiz-race-distance-custom-wrap');
  if (!sel || !wrap) return;
  wrap.hidden = sel.value !== 'custom';
}

// Returns the chosen race distance in km (or null when invalid). Used by
// collectWizardPayload + the post-save plan_derived_race goal hookup.
function readWizRaceDistanceKm() {
  const sel = document.getElementById('wiz-race-distance');
  if (!sel) return null;
  if (sel.value === 'custom') {
    const v = parseFloat(document.getElementById('wiz-race-distance-custom')?.value || '');
    return (Number.isFinite(v) && v > 0) ? v : null;
  }
  const v = parseFloat(sel.value);
  return (Number.isFinite(v) && v > 0) ? v : null;
}

async function autoPopulateBaseline() {
  if (!currentProfile) return;
  try {
    const fourWeeksAgo = new Date();
    fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);
    const workouts = await fetchWorkouts(currentProfile.id, isoDate(fourWeeksAgo), isoDate(new Date()));

    if (workouts.length === 0) {
      document.getElementById('wiz-baseline-auto').classList.add('hidden');
      return;
    }

    const totalMins = workouts.reduce((s, w) => s + w.duration_minutes, 0);
    const weekCount = 4;
    const avgSessions = Math.round(workouts.length / weekCount * 10) / 10;
    const avgHours = Math.round(totalMins / weekCount / 60 * 10) / 10;
    const longestSession = Math.max(...workouts.map(w => w.duration_minutes));

    document.getElementById('wiz-base-sessions').value = Math.round(avgSessions);
    document.getElementById('wiz-base-hours').value = avgHours;
    document.getElementById('wiz-base-longest').value = longestSession;
    document.getElementById('wiz-baseline-auto').classList.remove('hidden');
  } catch (e) {
    console.error('Auto-populate baseline error:', e);
  }
}

function updateWizardUI() {
  // Hide every wizard pane first, then activate the one matching our state.
  // Step 4 is the realism check; it has its own pane (#wizard-step-realism)
  // and is handled separately below because it has no intro screen.
  for (let i = 0; i <= 3; i++) {
    const introEl = document.getElementById(`wizard-intro-${i}`);
    const stepEl = document.getElementById(`wizard-step-${i}`);
    if (introEl) introEl.classList.toggle('active', _wizardShowIntro && i === _wizardStep);
    if (stepEl) stepEl.classList.toggle('active', !_wizardShowIntro && i === _wizardStep);
  }
  const realismEl = document.getElementById('wizard-step-realism');
  if (realismEl) realismEl.classList.toggle('active', _wizardStep === 4);
  const milestonesEl = document.getElementById('wizard-step-milestones');
  if (milestonesEl) {
    const isOn = _wizardStep === 5;
    milestonesEl.classList.toggle('active', isOn);
    milestonesEl.style.display = isOn ? 'block' : 'none';
  }

  // Progress dots: current step is active; earlier steps are done. On intro,
  // the current step has not been completed yet, so use the same rule.
  document.querySelectorAll('.wizard-step-dot').forEach(dot => {
    const s = parseInt(dot.dataset.step);
    dot.classList.toggle('active', s === _wizardStep);
    dot.classList.toggle('done', s < _wizardStep);
  });

  // Back button is removed (not just hidden) on the very first intro screen so
  // the primary "Fortsätt" button can fill the full width of the nav row.
  const prevBtn = document.getElementById('wiz-prev');
  const atFirstScreen = _wizardStep === 0 && _wizardShowIntro;
  prevBtn.style.display = atFirstScreen ? 'none' : '';
  prevBtn.style.visibility = '';
  const navEl = document.getElementById('wizard-nav');
  if (navEl) navEl.classList.toggle('is-single', atFirstScreen);

  // Next button label reflects where we're going. Step 3 now advances to the
  // realism check (step 4) instead of generating directly, so the label on
  // step 3 is "Analysera mål". Step 4's CTA ("Generera ändå" or "Generera
  // schema") is rendered dynamically based on the assessed risk level.
  const nextBtn = document.getElementById('wiz-next');
  if (_wizardShowIntro) {
    nextBtn.textContent = 'Fortsätt';
  } else if (_wizardStep === 3) {
    nextBtn.textContent = 'Analysera mål';
  } else if (_wizardStep === 4) {
    nextBtn.textContent = _wizardRealismCTA || 'Generera schema';
  } else if (_wizardStep === 5) {
    nextBtn.textContent = 'Aktivera schema';
  } else {
    nextBtn.textContent = 'Nästa';
  }

  const stepBanner = document.getElementById('wizard-step-banner');
  if (stepBanner) stepBanner.textContent = `Steg ${_wizardStep + 1} av 6`;

  document.querySelectorAll('.wiz-day-btn').forEach(btn => {
    btn.onclick = () => btn.classList.toggle('active');
  });

  document.querySelectorAll('#wiz-fitness-level .intensity-pill').forEach(pill => {
    pill.onclick = () => {
      document.querySelectorAll('#wiz-fitness-level .intensity-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
    };
  });
}

function wizardPrev() {
  // Flow backwards through: intro 0 → form 0 → intro 1 → form 1 → intro 2 →
  // form 2 → intro 3 → form 3 → realism (step 4, no intro). From the realism
  // step, "back" returns to form 3 so the user can adjust preferences.
  // Step 5 (milestone review) is post-draft-creation: there's no "back" to
  // pre-generate state; the user must either activate or close the wizard.
  if (_wizardStep === 5) {
    return;
  }
  if (_wizardStep === 4) {
    _wizardStep = 3;
    _wizardShowIntro = false;
    updateWizardUI();
    return;
  }
  if (_wizardShowIntro) {
    if (_wizardStep === 0) return; // already at the very start
    _wizardStep--;
    _wizardShowIntro = false;
  } else {
    _wizardShowIntro = true;
  }
  updateWizardUI();
}

async function wizardNext() {
  // On an intro screen, just reveal the form for the current step.
  if (_wizardShowIntro) {
    _wizardShowIntro = false;
    updateWizardUI();
    return;
  }

  // On a form screen, validate then advance (or submit on the last step).
  if (_wizardStep === 0 && !_wizardGoalType) {
    await showAlertModal('Välj mål', 'Du måste välja en måltyp för att fortsätta.');
    return;
  }

  if (_wizardStep < 3) {
    _wizardStep++;
    _wizardShowIntro = true;
    updateWizardUI();
    return;
  }

  // Step 3 → step 4 (realism). Step 4 → submit. We pre-validate basic
  // required fields here so the assess-feasibility call has something to
  // work with — submitPlanWizard repeats these checks for the actual
  // generate call.
  if (_wizardStep === 3) {
    const payload = collectWizardPayload();
    if (!payload) return; // collectWizardPayload showed the appropriate alert
    _wizardStep = 4;
    _wizardShowIntro = false;
    _wizardRealism = null;
    _wizardRealismCTA = 'Generera schema';
    updateWizardUI();
    await runRealismCheck(payload);
    return;
  }

  if (_wizardStep === 4) {
    await submitPlanWizard();
    return;
  }

  if (_wizardStep === 5) {
    await confirmDraftPlan();
    return;
  }
}

// Reads every wizard field and returns a generate-plan payload, or null if
// validation fails (in which case the function shows the alert itself).
// Extracted so the realism step (step 4) can build the same payload to
// pre-flight against /assess-feasibility.
function collectWizardPayload() {
  const goalText = document.getElementById('wiz-goal-text').value.trim();
  const goalDate = document.getElementById('wiz-goal-date').value || null;
  const goalTime = document.getElementById('wiz-goal-time').value.trim();
  const raceDistanceKm = (_wizardGoalType === 'race') ? readWizRaceDistanceKm() : null;

  let fullGoalText = goalText;
  if (goalTime && _wizardGoalType === 'race') fullGoalText += ` (mål: ${goalTime})`;

  const sessionsPerWeek = parseInt(document.getElementById('wiz-sessions').value);
  const hoursPerWeek = parseFloat(document.getElementById('wiz-hours').value);
  const maxSessionMin = parseInt(document.getElementById('wiz-max-session').value);
  const injuries = document.getElementById('wiz-injuries').value.trim() || null;

  const availDays = [];
  document.querySelectorAll('#wiz-avail-days .wiz-day-btn.active').forEach(b => availDays.push(parseInt(b.dataset.day)));

  const baseSessions = parseInt(document.getElementById('wiz-base-sessions').value) || 3;
  const baseHours = parseFloat(document.getElementById('wiz-base-hours').value) || 3;
  const baseLongest = parseInt(document.getElementById('wiz-base-longest').value) || 60;
  const fitnessLevel = document.querySelector('#wiz-fitness-level .intensity-pill.active')?.dataset.value || 'intermediate';

  const restingHr = parseInt(document.getElementById('wiz-resting-hr').value) || null;
  const maxHr = parseInt(document.getElementById('wiz-max-hr').value) || null;
  const recent5k = document.getElementById('wiz-recent-5k').value.trim() || null;
  const recent10k = document.getElementById('wiz-recent-10k').value.trim() || null;
  const easyPace = document.getElementById('wiz-easy-pace').value.trim() || null;

  const activityTypes = [];
  document.querySelectorAll('#wiz-activity-types .wiz-activity-check.active').forEach(b => activityTypes.push(b.dataset.type));

  const restDays = [];
  document.querySelectorAll('#wiz-rest-days .wiz-day-btn.active').forEach(b => restDays.push(parseInt(b.dataset.day)));

  const startDate = document.getElementById('wiz-start-date').value;

  if (!fullGoalText) {
    showAlertModal('Saknar mål', 'Beskriv ditt mål innan du genererar.');
    return null;
  }
  if (activityTypes.length === 0) {
    showAlertModal('Saknar aktiviteter', 'Välj minst en aktivitetstyp.');
    return null;
  }

  const activityMix = {};
  const pct = Math.round(100 / activityTypes.length);
  activityTypes.forEach((t, i) => {
    activityMix[t] = i === activityTypes.length - 1 ? 100 - pct * (activityTypes.length - 1) : pct;
  });

  return {
    profile_id: currentProfile.id,
    goal_type: _wizardGoalType,
    goal_text: fullGoalText,
    goal_date: goalDate,
    constraints: {
      sessions_per_week: sessionsPerWeek,
      hours_per_week: hoursPerWeek,
      available_days: availDays,
      max_session_minutes: maxSessionMin,
      injuries: injuries,
      ...(raceDistanceKm ? { race_distance_km: raceDistanceKm } : {}),
    },
    baseline: {
      sessions_per_week: baseSessions,
      hours_per_week: baseHours,
      activity_mix: activityMix,
      fitness_level: fitnessLevel,
      longest_session_minutes: baseLongest,
      resting_hr: restingHr,
      max_hr: maxHr,
      recent_5k: recent5k,
      recent_10k: recent10k,
      easy_pace: easyPace,
    },
    preferences: {
      activity_types: activityTypes,
      include_gym: activityTypes.includes('Gym'),
      preferred_rest_days: restDays,
      include_assessment_week_1: !!document.getElementById('wiz-assessment-week-1')?.checked,
      free_text: document.getElementById('wiz-free-text')?.value?.trim() || null,
      training_philosophy: {
        preset: document.getElementById('wiz-philosophy-vdp')?.checked ? 'van_der_poel' : null,
        custom: document.getElementById('wiz-philosophy-text')?.value?.trim() || null,
      },
    },
    start_date: startDate,
  };
}

// Calls the deterministic /assess-feasibility endpoint and renders the
// realism callout. Always shows the panel — even on a network failure
// we let the user proceed (we just hide the warning UI).
async function runRealismCheck(payload) {
  const loadingEl = document.getElementById('wiz-realism-loading');
  const contentEl = document.getElementById('wiz-realism-content');
  loadingEl.classList.remove('hidden');
  contentEl.classList.add('hidden');

  try {
    const session = (await sb.auth.getSession()).data.session;
    const res = await fetch(SUPABASE_FUNCTIONS_URL + '/assess-feasibility', {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + session.access_token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'assess_failed');
    _wizardRealism = result;
    renderRealism(result);
  } catch (e) {
    console.warn('Realism check failed, showing soft fallback:', e);
    // Fail soft: render a minimal "all clear" panel and let the user
    // proceed. We don't want a flaky network call to block plan creation.
    _wizardRealism = null;
    renderRealism({
      profile: null,
      feasibility: {
        riskLevel: 'comfortable',
        factors: [],
        coachingNote: 'Vi kunde inte göra en pre-koll just nu — du kan fortfarande generera planen och se resultatet.',
        recommendedAdjustments: [],
      },
    });
  }
  loadingEl.classList.add('hidden');
  contentEl.classList.remove('hidden');
}

const RISK_LABELS = {
  comfortable: 'Rimligt mål',
  ambitious: 'Ambitiöst mål',
  aggressive: 'Aggressivt mål',
  unrealistic: 'Orealistiskt på utsatt tid',
};

function renderRealism(result) {
  const f = result.feasibility || {};
  const p = result.profile || null;
  const risk = f.riskLevel || 'comfortable';

  const badgeEl = document.getElementById('wiz-realism-badge');
  badgeEl.className = `wiz-realism-badge risk-${risk}`;
  badgeEl.textContent = RISK_LABELS[risk] || risk;

  document.getElementById('wiz-realism-note').textContent = f.coachingNote || '';

  const profEl = document.getElementById('wiz-realism-profile');
  if (p) {
    const qp = p.qualityPerPhase || {};
    profEl.innerHTML =
      `Profil: <strong>${escapeHTML(p.tier)}</strong> · ` +
      `~${p.weeklyVolumeKm ?? '?'} km/v · ` +
      `kvalitet/v: base ${qp.base ?? '?'} · build ${qp.build ?? '?'} · peak ${qp.peak ?? '?'} · taper ${qp.taper ?? '?'} ` +
      `(max ${p.qualityCapPerWeek ?? '?'}/v).`;
    profEl.classList.remove('hidden');
  } else {
    profEl.classList.add('hidden');
  }

  const factorsEl = document.getElementById('wiz-realism-factors');
  const factors = Array.isArray(f.factors) ? [...f.factors] : [];
  // Sort: high → warn → ok so the most important issue is at the top.
  const sevOrder = { high: 0, warn: 1, ok: 2 };
  factors.sort((a, b) => (sevOrder[a.severity] ?? 9) - (sevOrder[b.severity] ?? 9));
  if (factors.length === 0) {
    factorsEl.innerHTML = '';
  } else {
    factorsEl.innerHTML = factors.map(fac => {
      const icon = fac.severity === 'high' ? '!' : fac.severity === 'warn' ? '⚠' : '✓';
      return `<div class="wiz-realism-factor sev-${escapeHTML(fac.severity)}">
        <span class="wiz-realism-factor-icon">${icon}</span>
        <span>${escapeHTML(fac.text)}</span>
      </div>`;
    }).join('');
  }

  const adjEl = document.getElementById('wiz-realism-adjustments');
  const adjustments = Array.isArray(f.recommendedAdjustments) ? f.recommendedAdjustments : [];
  // Append assessment-week notices so the user knows what's about to be
  // baked into their plan. Two independent triggers:
  //   1. the user opted in to the week-1 assessment via the checkbox
  //   2. the plan is going to be >= 20 weeks long (auto mid-plan)
  const assessmentMsgs = [];
  try {
    if (document.getElementById('wiz-assessment-week-1')?.checked) {
      assessmentMsgs.push(
        'Vecka 1 blir en bedömningsvecka — hård puls och tempo dialas in innan planen rampar.',
      );
    }
    const startStr = document.getElementById('wiz-start-date')?.value;
    const goalStr = document.getElementById('wiz-goal-date')?.value;
    if (startStr && goalStr) {
      const diffMs = new Date(goalStr).getTime() - new Date(startStr).getTime();
      const numW = Math.max(4, Math.min(24, Math.ceil(diffMs / (7 * 86400000))));
      if (numW >= 20) {
        assessmentMsgs.push(
          'Vi lägger automatiskt en bedömningsvecka i mitten (ersätter en deload) för att kalibrera om puls och tempo — planen blir lika lång som planerat.',
        );
      }
    }
  } catch (_e) { /* fall through */ }

  if (adjustments.length === 0 && assessmentMsgs.length === 0) {
    adjEl.innerHTML = '';
  } else {
    const adjHtml = adjustments.length > 0
      ? `<div class="wiz-realism-adjustments-title">Förslag på justeringar</div>` +
        `<ul>${adjustments.map(a => `<li>${escapeHTML(a)}</li>`).join('')}</ul>`
      : '';
    const asHtml = assessmentMsgs.length > 0
      ? `<div class="wiz-realism-adjustments-title" style="margin-top:8px;">Bedömningsveckor i din plan</div>` +
        `<ul>${assessmentMsgs.map(m => `<li>${escapeHTML(m)}</li>`).join('')}</ul>`
      : '';
    adjEl.innerHTML = adjHtml + asHtml;
  }

  const hint = document.getElementById('wiz-realism-cta-hint');
  if (risk === 'aggressive' || risk === 'unrealistic') {
    _wizardRealismCTA = 'Generera ändå';
    hint.textContent = 'Du kan välja "Tillbaka" för att justera målet, eller fortsätta ändå.';
  } else {
    _wizardRealismCTA = 'Generera schema';
    hint.textContent = '';
  }
  // Refresh the next-button label.
  updateWizardUI();
}

async function submitPlanWizard() {
  const payload = collectWizardPayload();
  if (!payload) return;

  // Show loading (hides all intros + form steps; starts fact rotation)
  document.querySelectorAll('.wizard-step').forEach(s => s.classList.remove('active'));
  document.getElementById('wizard-step-loading').style.display = 'block';
  document.getElementById('wizard-nav').style.display = 'none';
  startWizRunLoader();

  try {
    const session = (await sb.auth.getSession()).data.session;
    const res = await fetch(SUPABASE_FUNCTIONS_URL + '/generate-plan', {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + session.access_token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const result = await res.json();

    if (!res.ok) {
      throw new Error(result.error || 'Generation failed');
    }

    stopWizRunLoader();
    document.getElementById('wizard-step-loading').style.display = 'none';
    document.getElementById('wizard-nav').style.display = '';

    // generate-plan now returns a *draft* plan and a list of suggested
    // milestones. Advance to the milestone-review step instead of jumping
    // straight to the dashboard. The plan is only activated once the user
    // confirms via /generate-plan?mode=confirm_plan.
    if (result.requires_confirmation) {
      _wizardDraftPlan = result;
      _wizardStep = 5;
      _wizardShowIntro = false;
      updateWizardUI();
      renderWizardMilestones(result);
      return;
    }

    // Legacy fallback: server didn't return a draft (older edge function).
    closePlanWizard();
    const coachingNote = result.feasibility?.coachingNote
      ? `\n\nCoach: ${result.feasibility.coachingNote}`
      : '';
    await showAlertModal(
      'Schema skapat!',
      `${result.plan_name}\n${result.weeks} veckor: ${result.start_date} till ${result.end_date}${coachingNote}`,
    );

    _activePlan = null;
    _activePlanWeeks = [];
    _activePlanWorkouts = [];
    navigate('dashboard');

  } catch (e) {
    console.error('Plan generation error:', e);
    stopWizRunLoader();
    document.getElementById('wizard-step-loading').style.display = 'none';
    document.getElementById('wizard-nav').style.display = '';
    // Return to the realism step (step 4) so the user can retry without
    // losing the realism context.
    _wizardStep = 4;
    _wizardShowIntro = false;
    updateWizardUI();
    if (_wizardRealism) renderRealism(_wizardRealism);
    await showAlertModal('Fel', 'Kunde inte generera schema: ' + e.message);
  }
}

// Renders the milestone-review step (#5) using the response from a draft
// plan creation. Surfaces server-injected assessment-baseline checkpoints
// distinctly from milestones the LLM proposed so the user can tell what's
// hard-coded vs. heuristic.
function renderWizardMilestones(result) {
  const summaryEl = document.getElementById('wiz-milestones-summary');
  const listEl = document.getElementById('wiz-milestones-list');
  if (!summaryEl || !listEl) return;

  const milestones = Array.isArray(result?.milestones) ? result.milestones : [];
  const assessmentWeeks = Array.isArray(result?.assessment_weeks) ? result.assessment_weeks : [];
  const planName = escapeHTML(result?.plan_name || 'Ditt schema');
  const weeks = result?.weeks ?? '?';

  const assessmentLine = assessmentWeeks.length > 0
    ? `Vi har lagt in <strong>bedömningsvecka${assessmentWeeks.length === 1 ? '' : 'or'}</strong> i v${assessmentWeeks.join(', v')} för att kalibrera puls och tempo.`
    : '';
  summaryEl.innerHTML = `
    <div class="wiz-milestones-plan-name">${planName}</div>
    <div class="wiz-milestones-plan-meta">${weeks} veckor · ${milestones.length} milstolpe${milestones.length === 1 ? '' : 'r'}</div>
    ${assessmentLine ? `<div class="wiz-milestones-assess-note">${assessmentLine}</div>` : ''}
  `;

  if (milestones.length === 0) {
    listEl.innerHTML = `<div class="wiz-milestones-empty">Inga milstolpar genererades — du kan lägga till dem manuellt under <strong>Dina mål</strong>.</div>`;
    return;
  }

  const sorted = [...milestones].sort((a, b) => {
    const wa = a.target_week_number ?? 999;
    const wb = b.target_week_number ?? 999;
    if (wa !== wb) return wa - wb;
    return (a.sort_order ?? 0) - (b.sort_order ?? 0);
  });

  listEl.innerHTML = sorted.map(m => {
    const isAssess = m.metric_type === 'assessment_baseline' || m.source === 'server_assessment';
    const wk = m.target_week_number != null ? `V${m.target_week_number}` : '—';
    const title = escapeHTML(m.title || 'Milstolpe');
    const desc = m.description ? `<div class="wiz-milestone-desc">${escapeHTML(m.description)}</div>` : '';
    const target = (m.target_value != null && m.target_unit)
      ? `<div class="wiz-milestone-target">Mål: ${escapeHTML(String(m.target_value))} ${escapeHTML(m.target_unit)}</div>`
      : '';
    const tag = isAssess
      ? `<span class="wiz-milestone-tag wiz-milestone-tag--assess">Bedömning</span>`
      : `<span class="wiz-milestone-tag">Mål</span>`;
    return `
      <div class="wiz-milestone-row${isAssess ? ' wiz-milestone-row--assess' : ''}">
        <div class="wiz-milestone-week">${wk}</div>
        <div class="wiz-milestone-body">
          <div class="wiz-milestone-head">
            <div class="wiz-milestone-title">${title}</div>
            ${tag}
          </div>
          ${desc}
          ${target}
        </div>
      </div>
    `;
  }).join('');
}

// Activates the draft plan via /generate-plan?mode=confirm_plan, passing
// any (potentially edited) milestones back to the server so they end up
// in plan_milestones. Currently milestones are non-editable in the
// review step, but the round-trip is in place for future editing.
async function confirmDraftPlan() {
  if (!_wizardDraftPlan?.plan_id) {
    await showAlertModal('Fel', 'Inget utkast att aktivera.');
    return;
  }

  const nextBtn = document.getElementById('wiz-next');
  const prevBtn = document.getElementById('wiz-prev');
  const origNext = nextBtn ? nextBtn.textContent : '';
  if (nextBtn) { nextBtn.disabled = true; nextBtn.textContent = 'Aktiverar…'; }
  if (prevBtn) prevBtn.disabled = true;

  try {
    const session = (await sb.auth.getSession()).data.session;
    const res = await fetch(SUPABASE_FUNCTIONS_URL + '/generate-plan', {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + session.access_token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        mode: 'confirm_plan',
        plan_id: _wizardDraftPlan.plan_id,
        milestones: Array.isArray(_wizardDraftPlan.milestones) ? _wizardDraftPlan.milestones : [],
      }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Confirm failed');

    closePlanWizard();
    const draft = _wizardDraftPlan;
    _wizardDraftPlan = null;

    const coachingNote = draft.feasibility?.coachingNote
      ? `\n\nCoach: ${draft.feasibility.coachingNote}`
      : '';
    await showAlertModal(
      'Schema aktiverat!',
      `${draft.plan_name}\n${draft.weeks} veckor: ${draft.start_date} till ${draft.end_date}${coachingNote}`,
    );

    _activePlan = null;
    _activePlanWeeks = [];
    _activePlanWorkouts = [];
    navigate('dashboard');
  } catch (e) {
    console.error('Plan confirm error:', e);
    await showAlertModal('Fel', 'Kunde inte aktivera schema: ' + e.message);
    if (nextBtn) { nextBtn.disabled = false; nextBtn.textContent = origNext || 'Aktivera schema'; }
    if (prevBtn) prevBtn.disabled = false;
  }
}

// ═══════════════════════════════════════════════════════════════════
//  WIZARD RUN LOADER — rotating training curiosa during generation
// ═══════════════════════════════════════════════════════════════════

const WIZ_RUN_FACTS = [
  "En maratonlöpare tar i snitt 40 000 steg.",
  "Endorfiner börjar frigöras redan efter ca 20 minuters löpning.",
  "Mjölksyra får oftast skulden, men det är vätejoner som gör musklerna sura.",
  "Världsrekordet på maraton går i 2:35/km — i över två timmar.",
  "Eliud Kipchoge sprang under 2 timmar på maraton (inofficiellt) — 21 km/h i snitt.",
  "Elitlöpare gör ~80 % av sin träning i låg intensitet (Zon 1–2).",
  "Uthållighetsträning kan göra hjärtats slagvolym 20–40 % större.",
  "En 10 km löpning förbränner ungefär 600–700 kcal.",
  "VO₂max kan öka 15–20 % på 12 veckor med rätt träning.",
  "Redan 2 % vätskeförlust sänker prestationen märkbart.",
  "Adaptationen sker under återhämtningen — inte under passet.",
  "Zon 2-träning bygger mitokondrier — cellens kraftverk.",
  "Stegfrekvens runt 170–180 steg/min minskar skaderisken för många.",
  "Styrketräning 2 ggr/vecka ger mätbart bättre löpekonomi.",
  "Sömn är den enskilt viktigaste återhämtningsfaktorn.",
  "Höjdträning ökar EPO-produktionen och syreupptaget i blodet.",
];

let _wizRunFactTimer = null;
let _wizRunFactIndex = -1;

function showNextWizRunFact() {
  const el = document.getElementById('wiz-run-fact-text');
  if (!el) return;
  // Pick a different fact from the previous one.
  let next;
  do {
    next = Math.floor(Math.random() * WIZ_RUN_FACTS.length);
  } while (WIZ_RUN_FACTS.length > 1 && next === _wizRunFactIndex);
  _wizRunFactIndex = next;

  el.style.opacity = '0';
  setTimeout(() => {
    el.textContent = WIZ_RUN_FACTS[next];
    el.style.opacity = '1';
  }, 220);
}

function startWizRunLoader() {
  stopWizRunLoader();
  _wizRunFactIndex = -1;
  showNextWizRunFact();
  _wizRunFactTimer = setInterval(showNextWizRunFact, 11400);
}

function stopWizRunLoader() {
  if (_wizRunFactTimer) {
    clearInterval(_wizRunFactTimer);
    _wizRunFactTimer = null;
  }
}

// ═══════════════════════════════════════════════════════════════════
//  PLAN MANAGER — list, switch, rename, delete saved plans
// ═══════════════════════════════════════════════════════════════════

async function fetchAllPlansForProfile(profileId) {
  if (!profileId) return [];
  try {
    const { data } = await sb.from('training_plans')
      .select('*')
      .eq('profile_id', profileId)
      .order('created_at', { ascending: false });
    return data || [];
  } catch (e) {
    console.error('Fetch all plans error:', e);
    return [];
  }
}

let _pmExpandedPlanId = null;
let _pmPreviewWeekIdx = 0;
let _pmPreviewCache = {};

async function fetchPlanPreview(planId) {
  if (_pmPreviewCache[planId]) return _pmPreviewCache[planId];
  const weeks = await fetchPlanWeeks(planId);
  const allWo = [];
  for (const w of weeks) {
    const { data } = await sb.from('plan_workouts').select('*').eq('plan_week_id', w.id).order('day_of_week');
    allWo.push(...(data || []));
  }
  const result = { weeks, workouts: allWo };
  _pmPreviewCache[planId] = result;
  return result;
}

function buildPlanPreviewHTML(plan, preview, weekIdx) {
  const DAY = ['Mån', 'Tis', 'Ons', 'Tors', 'Fre', 'Lör', 'Sön'];
  const weeks = preview.weeks;
  if (!weeks.length) return '<div class="pm-preview-empty">Inga veckor i schemat.</div>';

  const phases = {};
  weeks.forEach(w => {
    const p = PHASE_LABELS[w.phase] || w.phase || '?';
    phases[p] = (phases[p] || 0) + 1;
  });
  const phaseStr = Object.entries(phases).map(([k, v]) => `${v}v ${k}`).join(', ');

  const clampedIdx = Math.max(0, Math.min(weekIdx, weeks.length - 1));
  const week = weeks[clampedIdx];
  const weekWo = preview.workouts.filter(wo => wo.plan_week_id === week.id);

  const isAssessmentWeek = week.phase === 'assessment';

  let grid = '';
  for (let d = 0; d < 7; d++) {
    const wo = weekWo.find(w => w.day_of_week === d);
    if (wo?.is_rest) {
      grid += `<div class="pm-prev-day"><span class="pm-prev-day-name">${DAY[d]}</span><span class="pm-prev-rest">Vila</span></div>`;
    } else if (wo) {
      const isAssessmentWorkout = typeof wo.label === 'string' && /^Bedömning/i.test(wo.label);
      const zone = wo.intensity_zone ? `<span class="zone-badge zone-${escapeHTML(wo.intensity_zone.toLowerCase())}" style="font-size:0.6rem;padding:1px 4px;">${escapeHTML(wo.intensity_zone)}</span>` : '';
      const dur = wo.target_duration_minutes ? `${wo.target_duration_minutes}m` : '';
      const testBadge = isAssessmentWorkout ? `<span class="day-badge--test">TEST</span>` : '';
      grid += `<div class="pm-prev-day${isAssessmentWorkout ? ' pm-prev-day--assess' : ''}"><span class="pm-prev-day-name">${DAY[d]}</span><span class="pm-prev-label">${escapeHTML(wo.label || wo.activity_type)}${testBadge}</span><span class="pm-prev-meta">${zone} ${dur}</span></div>`;
    } else {
      grid += `<div class="pm-prev-day"><span class="pm-prev-day-name">${DAY[d]}</span><span class="pm-prev-rest">—</span></div>`;
    }
  }

  const isActive = plan.status === 'active';
  const phaseLabel = PHASE_LABELS[week.phase] || week.phase || '';

  // Plan summary now begins with the feasibility coaching note (prepended
  // by generate-plan). Surface it as a callout above the phase grid so the
  // user is reminded what the realism check said when revisiting the plan.
  const summaryText = (plan.summary || '').trim();
  const summaryCallout = summaryText
    ? `<div class="plan-coaching-callout"><div class="plan-coaching-icon">💡</div><div class="plan-coaching-text">${escapeHTML(summaryText)}</div></div>`
    : '';

  const assessmentBanner = isAssessmentWeek
    ? `<div class="assessment-banner pm-assessment-banner">
        <span class="ab-icon" aria-hidden="true">⚑</span>
        <span class="ab-text"><strong>Bedömningsvecka.</strong> Tre testpass kalibrerar puls och tempo.</span>
      </div>`
    : '';

  return `
    ${summaryCallout}
    <div class="pm-preview-summary">
      <div class="pm-preview-phases">${phaseStr}</div>
      <div class="pm-preview-weeks-label">${weeks.length} veckor · ${plan.start_date} — ${plan.end_date}</div>
    </div>
    <div class="pm-preview-week-nav">
      <button class="pm-prev-arrow" onclick="event.stopPropagation();pmPreviewWeek('${plan.id}',-1)" ${clampedIdx === 0 ? 'disabled' : ''}>‹</button>
      <span class="pm-prev-week-label${isAssessmentWeek ? ' pm-prev-week-label--assess' : ''}">Vecka ${week.week_number}${phaseLabel ? ' · ' + phaseLabel : ''}</span>
      <button class="pm-prev-arrow" onclick="event.stopPropagation();pmPreviewWeek('${plan.id}',1)" ${clampedIdx >= weeks.length - 1 ? 'disabled' : ''}>›</button>
    </div>
    ${assessmentBanner}
    <div class="pm-prev-grid">${grid}</div>
    <div class="pm-preview-actions">
      ${isActive ? '' : `<button class="btn btn-primary btn-sm" onclick="event.stopPropagation();activatePlan('${plan.id}')">Aktivera</button>`}
      ${isActive ? `<button class="btn btn-outline btn-sm" onclick="event.stopPropagation();closePlanManager();openPlanEditModal();">Redigera med AI</button>` : ''}
      <button class="btn btn-outline btn-sm" onclick="event.stopPropagation();renamePlan('${plan.id}','${(plan.name || plan.goal_text || '').replace(/'/g, "\\'")}')">Byt namn</button>
      <button class="btn btn-danger-text btn-sm" onclick="event.stopPropagation();deletePlan('${plan.id}')">Ta bort</button>
    </div>`;
}

async function togglePlanPreview(planId) {
  if (_pmExpandedPlanId === planId) {
    _pmExpandedPlanId = null;
    const el = document.getElementById('pm-preview-' + planId);
    if (el) el.classList.add('hidden');
    return;
  }
  // Collapse any open preview
  document.querySelectorAll('.pm-preview-panel').forEach(el => el.classList.add('hidden'));
  _pmExpandedPlanId = planId;
  _pmPreviewWeekIdx = 0;

  const el = document.getElementById('pm-preview-' + planId);
  if (el) {
    el.innerHTML = '<div class="pm-preview-loading"><span class="spinner-sm"></span></div>';
    el.classList.remove('hidden');
    const plans = await fetchAllPlansForProfile(currentProfile?.id);
    const plan = plans.find(p => p.id === planId);
    if (!plan) return;
    const preview = await fetchPlanPreview(planId);
    el.innerHTML = buildPlanPreviewHTML(plan, preview, _pmPreviewWeekIdx);
  }
}

async function pmPreviewWeek(planId, delta) {
  _pmPreviewWeekIdx += delta;
  const preview = _pmPreviewCache[planId];
  if (!preview) return;
  const plans = await fetchAllPlansForProfile(currentProfile?.id);
  const plan = plans.find(p => p.id === planId);
  if (!plan) return;
  const el = document.getElementById('pm-preview-' + planId);
  if (el) el.innerHTML = buildPlanPreviewHTML(plan, preview, _pmPreviewWeekIdx);
}

let _pmExpandedLegacyId = null;

async function toggleLegacyPreview(periodId) {
  const el = document.getElementById('pm-preview-legacy-' + periodId);
  if (!el) return;
  if (_pmExpandedLegacyId === periodId) {
    _pmExpandedLegacyId = null;
    el.classList.add('hidden');
    return;
  }
  document.querySelectorAll('.pm-preview-panel').forEach(p => p.classList.add('hidden'));
  _pmExpandedLegacyId = periodId;
  _pmExpandedPlanId = null;
  el.innerHTML = '<div class="pm-preview-loading"><span class="spinner-sm"></span></div>';
  el.classList.remove('hidden');

  const periods = await fetchPeriods();
  const period = periods.find(p => p.id === periodId);
  if (!period) return;
  const plans = await fetchPlans(periodId);
  const todayStr = isoDate(new Date());
  const allPlans = await fetchAllPlansForProfile(currentProfile?.id);
  const hasActivePlan = allPlans.some(p => p.status === 'active');
  const isActive = !hasActivePlan && todayStr >= period.start_date && todayStr <= period.end_date;
  el.innerHTML = buildLegacyPreviewHTML(period, plans, isActive);
}

function buildLegacyPreviewHTML(period, plans, isActive) {
  const DAY = ['Måndag', 'Tisdag', 'Onsdag', 'Torsdag', 'Fredag', 'Lördag', 'Söndag'];
  let rows = '';
  for (let d = 0; d < 7; d++) {
    const wo = plans.find(p => p.day_of_week === d);
    if (wo?.is_rest) {
      rows += `
        <div class="pm-day-row pm-day-rest">
          <div class="pm-day-col-name">${DAY[d]}</div>
          <div class="pm-day-col-content"><span class="pm-day-rest-pill">Vila</span></div>
        </div>`;
    } else if (wo) {
      const label = stripDayPrefix(wo.label || 'Pass');
      const desc = wo.description ? wo.description.replace(/</g, '&lt;') : '';
      rows += `
        <div class="pm-day-row">
          <div class="pm-day-col-name">${DAY[d]}</div>
          <div class="pm-day-col-content">
            <div class="pm-day-label">${label}</div>
            ${desc ? `<div class="pm-day-desc">${desc}</div>` : ''}
          </div>
        </div>`;
    } else {
      rows += `
        <div class="pm-day-row pm-day-empty">
          <div class="pm-day-col-name">${DAY[d]}</div>
          <div class="pm-day-col-content"><span class="pm-day-empty-pill">—</span></div>
        </div>`;
    }
  }

  const safeName = (period.name || 'Manuellt schema').replace(/'/g, "\\'");
  return `
    <div class="pm-preview-summary">
      <div class="pm-preview-phases">Manuellt veckoschema</div>
      <div class="pm-preview-weeks-label">${period.start_date} — ${period.end_date}</div>
    </div>
    <div class="pm-day-list">${rows}</div>
    <div class="pm-preview-actions">
      ${isActive
        ? `<button class="btn btn-outline btn-sm" onclick="event.stopPropagation();editLegacyPeriod('${period.id}')">Redigera</button>`
        : `<button class="btn btn-primary btn-sm" onclick="event.stopPropagation();activateLegacyPeriod('${period.id}')">Aktivera</button>`}
      <button class="btn btn-outline btn-sm" onclick="event.stopPropagation();renameLegacyPeriod('${period.id}','${safeName}')">Byt namn</button>
      <button class="btn btn-danger-text btn-sm" onclick="event.stopPropagation();deleteLegacyPeriod('${period.id}')">Ta bort</button>
    </div>`;
}

async function openPlanManager() {
  _pmPreviewCache = {};
  _pmExpandedPlanId = null;
  _pmExpandedLegacyId = null;
  const plans = await fetchAllPlansForProfile(currentProfile?.id);
  const listEl = document.getElementById('plan-manager-list');
  const topEl = document.getElementById('pm-top-actions');

  let topHtml = `<button class="pm-action-primary" onclick="closePlanManager();openPlanWizard();">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
    Skapa nytt AI-schema
  </button>`;
  topEl.innerHTML = topHtml;

  const periods = await fetchPeriods();
  const todayStr = isoDate(new Date());
  const hasActivePlan = plans.some(p => p.status === 'active');
  const isLegacyActive = !hasActivePlan;
  const legacyPeriods = periods.filter(p => todayStr <= p.end_date);

  let html = '';

  if (legacyPeriods.length > 0) {
    html += '<div class="pm-section-label">Manuella scheman</div>';
    legacyPeriods.forEach(p => {
      const active = isLegacyActive && todayStr >= p.start_date && todayStr <= p.end_date;
      html += `<div class="plan-manager-item${active ? ' active' : ''}" onclick="toggleLegacyPreview('${escapeHTML(p.id)}')">
        <span style="font-size:1.1rem;">📋</span>
        <div class="pm-info">
          <div class="pm-name">${escapeHTML(p.name || 'Manuellt schema')}</div>
          <div class="pm-meta">${escapeHTML(p.start_date)} — ${escapeHTML(p.end_date)}</div>
        </div>
        <span class="pm-status-badge ${active ? 'active' : 'archived'}">${active ? 'Aktiv' : 'Tillgänglig'}</span>
        <svg class="pm-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
      <div class="pm-preview-panel hidden" id="pm-preview-legacy-${escapeHTML(p.id)}"></div>`;
    });
  }

  if (plans.length > 0) {
    html += '<div class="pm-section-label">AI-genererade scheman</div>';
    html += plans.map(p => {
      const isActive = p.status === 'active';
      const name = p.name || p.goal_text || 'Träningsplan';
      const dateRange = `${p.start_date} — ${p.end_date}`;
      const goalIcon = GOAL_TYPES.find(g => g.id === p.goal_type)?.icon || '';
      return `<div class="plan-manager-item${isActive ? ' active' : ''}" onclick="togglePlanPreview('${p.id}')">
        ${goalIcon ? `<span style="font-size:1.1rem;">${goalIcon}</span>` : ''}
        <div class="pm-info">
          <div class="pm-name">${name}</div>
          <div class="pm-meta">${dateRange}</div>
        </div>
        <span class="pm-status-badge ${p.status}">${isActive ? 'Aktiv' : 'Arkiverad'}</span>
        <svg class="pm-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
      <div class="pm-preview-panel hidden" id="pm-preview-${p.id}"></div>`;
    }).join('');
  }

  if (html === '') {
    html = '<div class="sf-empty" style="padding:16px 0;">Inga sparade scheman.</div>';
  }

  listEl.innerHTML = html;
  document.getElementById('plan-manager').classList.remove('hidden');
}

async function switchToLegacy() {
  const ok = await showConfirmModal('Byt till manuellt schema', 'Vill du byta tillbaka till det manuella schemat? Det AI-genererade schemat arkiveras.', 'Byt');
  if (!ok) return;
  try {
    await sb.from('training_plans')
      .update({ status: 'archived' })
      .eq('profile_id', currentProfile.id)
      .eq('status', 'active');
    _activePlan = null;
    _activePlanWeeks = [];
    _activePlanWorkouts = [];
    closePlanManager();
    navigate('dashboard');
  } catch (e) {
    console.error('Switch to legacy error:', e);
    await showAlertModal('Fel', 'Kunde inte byta schema.');
  }
}

function closePlanManager() {
  document.getElementById('plan-manager').classList.add('hidden');
}

async function activatePlan(planId) {
  const ok = await showConfirmModal('Byt schema', 'Vill du aktivera detta schema? Det nuvarande schemat arkiveras.', 'Aktivera');
  if (!ok) return;
  try {
    await sb.from('training_plans')
      .update({ status: 'archived' })
      .eq('profile_id', currentProfile.id)
      .eq('status', 'active');

    await sb.from('training_plans')
      .update({ status: 'active' })
      .eq('id', planId);

    _activePlan = null;
    _activePlanWeeks = [];
    _activePlanWorkouts = [];
    closePlanManager();
    navigate('dashboard');
  } catch (e) {
    console.error('Activate plan error:', e);
    await showAlertModal('Fel', 'Kunde inte byta schema: ' + e.message);
  }
}

async function renamePlan(planId, currentName) {
  const newName = prompt('Nytt namn:', currentName);
  if (!newName || newName.trim() === currentName) return;
  try {
    await sb.from('training_plans')
      .update({ name: newName.trim() })
      .eq('id', planId);

    if (_activePlan && _activePlan.id === planId) _activePlan.name = newName.trim();
    openPlanManager();
  } catch (e) {
    console.error('Rename plan error:', e);
  }
}

async function deletePlan(planId) {
  const ok = await showConfirmModal('Ta bort schema', 'Är du säker? All plandata raderas permanent.', 'Ta bort', true);
  if (!ok) return;
  try {
    await sb.from('training_plans').delete().eq('id', planId);
    if (_activePlan && _activePlan.id === planId) {
      _activePlan = null;
      _activePlanWeeks = [];
      _activePlanWorkouts = [];
    }
    openPlanManager();
  } catch (e) {
    console.error('Delete plan error:', e);
    await showAlertModal('Fel', 'Kunde inte ta bort schema: ' + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  LEGACY (MANUAL) PERIOD ACTIONS
// ═══════════════════════════════════════════════════════════════════

async function activateLegacyPeriod(periodId) {
  const ok = await showConfirmModal('Aktivera manuellt schema', 'Vill du aktivera detta manuella schema? Eventuellt aktivt AI-schema arkiveras.', 'Aktivera');
  if (!ok) return;
  try {
    await sb.from('training_plans')
      .update({ status: 'archived' })
      .eq('profile_id', currentProfile.id)
      .eq('status', 'active');
    _activePlan = null;
    _activePlanWeeks = [];
    _activePlanWorkouts = [];
    closePlanManager();
    navigate('dashboard');
  } catch (e) {
    console.error('Activate legacy error:', e);
    await showAlertModal('Fel', 'Kunde inte aktivera schema: ' + e.message);
  }
}

async function renameLegacyPeriod(periodId, currentName) {
  const newName = prompt('Nytt namn:', currentName);
  if (!newName || newName.trim() === currentName) return;
  try {
    await sb.from('periods').update({ name: newName.trim() }).eq('id', periodId);
    openPlanManager();
  } catch (e) {
    console.error('Rename period error:', e);
    await showAlertModal('Fel', 'Kunde inte byta namn: ' + e.message);
  }
}

async function deleteLegacyPeriod(periodId) {
  const ok = await showConfirmModal('Ta bort manuellt schema', 'Är du säker? Period och tillhörande dagsplan raderas permanent. Loggade pass påverkas inte.', 'Ta bort', true);
  if (!ok) return;
  try {
    await sb.from('period_plans').delete().eq('period_id', periodId);
    await sb.from('periods').delete().eq('id', periodId);
    openPlanManager();
  } catch (e) {
    console.error('Delete period error:', e);
    await showAlertModal('Fel', 'Kunde inte ta bort schema: ' + e.message);
  }
}

let _lpeCurrentPeriodId = null;

async function editLegacyPeriod(periodId) {
  const periods = await fetchPeriods();
  const period = periods.find(p => p.id === periodId);
  if (!period) return;
  const plans = await fetchPlans(periodId);
  _lpeCurrentPeriodId = periodId;

  let modal = document.getElementById('legacy-period-editor');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'legacy-period-editor';
    modal.className = 'modal-overlay modal-overlay-scroll hidden';
    document.body.appendChild(modal);
  }
  modal.innerHTML = `
    <div class="modal-box lpe-modal">
      <div class="modal-header">
        <h3>Redigera ${escapeHTML(period.name || 'manuellt schema')}</h3>
        <button class="btn-close" onclick="closeLegacyPeriodEditor()">×</button>
      </div>

      <div class="lpe-ai-section">
        <label class="lpe-section-label">Beskriv vad du vill ändra (AI hjälper dig)</label>
        <textarea id="lpe-ai-prompt" class="lpe-ai-prompt" rows="3" placeholder="T.ex. 'Lägg till ett tröskelpass på onsdag och flytta långpasset till söndag' eller 'Bygg ett 5-dagarsschema med fokus på halvmaraton'"></textarea>
        <div class="lpe-ai-row">
          <button class="btn btn-outline btn-sm" onclick="lpeGenerateWithAI()" id="lpe-ai-btn">
            <span id="lpe-ai-btn-text">✨ Föreslå med AI</span>
          </button>
          <span id="lpe-ai-status" class="lpe-ai-status"></span>
        </div>
      </div>

      <div class="lpe-divider"></div>

      <label class="lpe-section-label">Eller redigera dag för dag</label>
      <div class="lpe-body" id="lpe-day-list"></div>

      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeLegacyPeriodEditor()">Avbryt</button>
        <button class="btn btn-primary" onclick="saveLegacyPeriodEditor('${periodId}')">Spara</button>
      </div>
    </div>`;
  _lpeRenderDayList(plans);
  modal.classList.remove('hidden');
}

function _lpeRenderDayList(plans) {
  const DAY = ['Måndag', 'Tisdag', 'Onsdag', 'Torsdag', 'Fredag', 'Lördag', 'Söndag'];
  const byDay = {};
  plans.forEach(p => { byDay[p.day_of_week] = p; });
  let rows = '';
  for (let d = 0; d < 7; d++) {
    const wo = byDay[d] || {};
    const isRest = !!wo.is_rest;
    rows += `
      <div class="lpe-day" data-day="${d}">
        <div class="lpe-day-head">
          <span class="lpe-day-name">${DAY[d]}</span>
          <label class="lpe-rest-toggle">
            <input type="checkbox" class="lpe-rest" ${isRest ? 'checked' : ''} onchange="_lpeToggleRest(${d}, this.checked)"/>
            <span>Vila</span>
          </label>
        </div>
        <input type="text" class="lpe-label" placeholder="Pass-namn (t.ex. Distans Z2)" value="${(wo.label || '').replace(/"/g, '&quot;')}" ${isRest ? 'disabled' : ''}/>
        <textarea class="lpe-desc" rows="2" placeholder="Beskrivning (km, tempo, struktur)" ${isRest ? 'disabled' : ''}>${(wo.description || '').replace(/</g, '&lt;')}</textarea>
      </div>`;
  }
  const el = document.getElementById('lpe-day-list');
  if (el) el.innerHTML = rows;
}

function _lpeToggleRest(day, isRest) {
  const row = document.querySelector(`#legacy-period-editor .lpe-day[data-day="${day}"]`);
  if (!row) return;
  const lbl = row.querySelector('.lpe-label');
  const desc = row.querySelector('.lpe-desc');
  if (lbl) lbl.disabled = isRest;
  if (desc) desc.disabled = isRest;
  if (isRest) {
    if (lbl) lbl.value = '';
    if (desc) desc.value = '';
  }
}

function closeLegacyPeriodEditor() {
  const modal = document.getElementById('legacy-period-editor');
  if (modal) modal.classList.add('hidden');
  _lpeCurrentPeriodId = null;
}

async function lpeGenerateWithAI() {
  const promptEl = document.getElementById('lpe-ai-prompt');
  const statusEl = document.getElementById('lpe-ai-status');
  const btnEl = document.getElementById('lpe-ai-btn');
  const btnTextEl = document.getElementById('lpe-ai-btn-text');
  const userPrompt = (promptEl?.value || '').trim();
  if (!userPrompt) {
    statusEl.textContent = 'Skriv vad du vill ändra först';
    statusEl.className = 'lpe-ai-status lpe-ai-error';
    return;
  }

  // Collect current state from form
  const currentDays = [];
  document.querySelectorAll('#legacy-period-editor .lpe-day').forEach(row => {
    const d = parseInt(row.dataset.day, 10);
    const isRest = row.querySelector('.lpe-rest').checked;
    currentDays.push({
      day_of_week: d,
      is_rest: isRest,
      label: isRest ? null : (row.querySelector('.lpe-label').value.trim() || null),
      description: isRest ? null : (row.querySelector('.lpe-desc').value.trim() || null),
    });
  });

  btnEl.disabled = true;
  btnTextEl.textContent = '⏳ Genererar...';
  statusEl.textContent = '';
  statusEl.className = 'lpe-ai-status';

  try {
    const session = await sb.auth.getSession();
    const token = session.data.session?.access_token;
    const res = await fetch(`${SUPABASE_URL}/functions/v1/weekly-template-ai`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        prompt: userPrompt,
        current_template: currentDays,
        max_hr: currentProfile?.user_max_hr || null,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'AI-fel');
    if (!Array.isArray(data.days) || data.days.length !== 7) {
      throw new Error('AI returnerade ogiltigt format');
    }
    _lpeRenderDayList(data.days);
    statusEl.textContent = '✓ Förslag inläst i formuläret. Granska och tryck Spara.';
    statusEl.className = 'lpe-ai-status lpe-ai-ok';
  } catch (e) {
    console.error('AI suggest error:', e);
    statusEl.textContent = 'Fel: ' + e.message;
    statusEl.className = 'lpe-ai-status lpe-ai-error';
  } finally {
    btnEl.disabled = false;
    btnTextEl.textContent = '✨ Föreslå med AI';
  }
}

async function saveLegacyPeriodEditor(periodId) {
  const rows = document.querySelectorAll('#legacy-period-editor .lpe-day');
  const upserts = [];
  rows.forEach(row => {
    const d = parseInt(row.dataset.day, 10);
    const isRest = row.querySelector('.lpe-rest').checked;
    const label = row.querySelector('.lpe-label').value.trim();
    const description = row.querySelector('.lpe-desc').value.trim();
    if (isRest) {
      upserts.push({
        period_id: periodId,
        day_of_week: d,
        is_rest: true,
        label: 'Vila',
        description: null,
      });
    } else if (label || description) {
      upserts.push({
        period_id: periodId,
        day_of_week: d,
        is_rest: false,
        label: label || 'Pass',
        description: description || null,
      });
    }
  });

  // Safeguard: block saving a completely empty schedule (no passes, no rest)
  if (upserts.length === 0) {
    await showAlertModal('Tomt schema', 'Du har inte fyllt i några pass eller vilodagar. Lägg till minst ett pass eller markera minst en dag som Vila innan du sparar.');
    return;
  }

  // Extra safeguard: if all rows are rest → confirm
  const nonRest = upserts.filter(u => !u.is_rest);
  if (nonRest.length === 0) {
    const ok = await showConfirmModal('Endast vilodagar', 'Alla dagar är markerade som Vila. Vill du spara ändå?', 'Spara', false);
    if (!ok) return;
  }

  try {
    await sb.from('period_plans').delete().eq('period_id', periodId);
    const { error } = await sb.from('period_plans').insert(upserts);
    if (error) throw error;
    closeLegacyPeriodEditor();
    openPlanManager();
  } catch (e) {
    console.error('Save legacy period error:', e);
    await showAlertModal('Fel', 'Kunde inte spara: ' + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  RECOVERY: restore Niklas' original Period 1 base schedule
// ═══════════════════════════════════════════════════════════════════
async function restoreNiklasBaseSchedule(periodId) {
  const ok = await showConfirmModal(
    'Återställ basschema',
    'Detta återställer veckoschemat till: Vila/Distans Z2/Cykel Z2/Tröskelpass/Lätt+strides/Långpass/Vila. Befintligt schema för perioden ersätts.',
    'Återställ'
  );
  if (!ok) return;
  const rows = [
    { day_of_week: 0, is_rest: true,  label: 'Vila',           description: null },
    { day_of_week: 1, is_rest: false, label: 'Distans Z2',     description: '7–8 km lugn löpning Z2 (5:45–6:00/km). Konversationstempo hela vägen.' },
    { day_of_week: 2, is_rest: false, label: 'Cykel Z2',       description: '45–60 min cykel Z2, jämn watt. Som aktiv återhämtning mellan löppass.' },
    { day_of_week: 3, is_rest: false, label: 'Tröskelpass',    description: '15 min uppvärm Z2 → 4×5 min i tröskel Z4 (1 min jogg mellan) → 10 min nedjogg.' },
    { day_of_week: 4, is_rest: false, label: 'Lätt + strides', description: '5–6 km mycket lugn Z1 (6:00–6:15/km) + 6×20 sek strides med full återhämtning.' },
    { day_of_week: 5, is_rest: false, label: 'Långpass Z2',    description: '12–14 km lugn Z2 (5:45–6:15/km). Veckans viktigaste pass.' },
    { day_of_week: 6, is_rest: true,  label: 'Vila',           description: null },
  ].map(r => ({ ...r, period_id: periodId }));
  try {
    await sb.from('period_plans').delete().eq('period_id', periodId);
    const { error } = await sb.from('period_plans').insert(rows);
    if (error) throw error;
    await showAlertModal('Klart', 'Basschemat är återställt. Öppna Hantera schema för att se det.');
    openPlanManager();
  } catch (e) {
    console.error('Restore schedule error:', e);
    await showAlertModal('Fel', 'Kunde inte återställa: ' + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  PLAN AI EDIT CHAT
// ═══════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════
//  PLAN WORKOUT EDIT (individual workout form + AI)
// ═══════════════════════════════════════════════════════════════════

let _pweWorkout = null; // the plan_workouts row being edited
let _pweZone = '';

function openPlanWorkoutEdit(wo) {
  _pweWorkout = wo;
  _pweZone = wo.intensity_zone || '';
  document.getElementById('pwe-title').textContent = `Redigera: ${DAY_NAMES_FULL[wo.day_of_week] || ''}`;

  const actSel = document.getElementById('pwe-activity');
  if (actSel.options.length <= 1) {
    actSel.innerHTML = '';
    ACTIVITY_TYPES.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t; opt.textContent = t;
      actSel.appendChild(opt);
    });
  }
  actSel.value = wo.activity_type || 'Löpning';
  document.getElementById('pwe-label').value = wo.label || '';
  document.getElementById('pwe-duration').value = wo.target_duration_minutes || '';
  document.getElementById('pwe-distance').value = wo.target_distance_km || '';
  document.getElementById('pwe-desc').value = wo.description || '';
  document.getElementById('pwe-rest').checked = !!wo.is_rest;
  document.getElementById('pwe-zone').value = _pweZone;

  document.querySelectorAll('#pwe-zone-pills .intensity-pill').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.value === _pweZone);
    btn.onclick = () => {
      const val = btn.dataset.value;
      _pweZone = _pweZone === val ? '' : val;
      document.getElementById('pwe-zone').value = _pweZone;
      document.querySelectorAll('#pwe-zone-pills .intensity-pill').forEach(b => b.classList.toggle('active', b.dataset.value === _pweZone));
    };
  });

  document.getElementById('pwe-ai-input').value = '';
  document.getElementById('pwe-ai-status').classList.add('hidden');
  document.getElementById('pwe-modal').classList.remove('hidden');
}

function closePlanWorkoutEdit() {
  document.getElementById('pwe-modal').classList.add('hidden');
  _pweWorkout = null;
}

async function savePlanWorkoutEdit() {
  if (!_pweWorkout) return;
  const isRest = document.getElementById('pwe-rest').checked;
  const updates = {
    activity_type: isRest ? 'Vila' : document.getElementById('pwe-activity').value,
    label: isRest ? 'Vila' : document.getElementById('pwe-label').value.trim() || null,
    target_duration_minutes: isRest ? 0 : (parseInt(document.getElementById('pwe-duration').value) || 0),
    target_distance_km: isRest ? null : (parseFloat(document.getElementById('pwe-distance').value) || null),
    intensity_zone: isRest ? null : (_pweZone || null),
    description: isRest ? null : (document.getElementById('pwe-desc').value.trim() || null),
    is_rest: isRest,
  };

  try {
    const { error } = await sb.from('plan_workouts').update(updates).eq('id', _pweWorkout.id);
    if (error) throw error;
    closePlanWorkoutEdit();
    _activePlan = null;
    _activePlanWeeks = [];
    _activePlanWorkouts = [];
    loadSchema();
  } catch (e) {
    console.error('Save plan workout error:', e);
    await showAlertModal('Fel', 'Kunde inte spara: ' + e.message);
  }
}

async function submitPlanWorkoutAI() {
  const input = document.getElementById('pwe-ai-input');
  const instruction = input.value.trim();
  if (!instruction || !_pweWorkout || !_activePlan) return;

  const statusEl = document.getElementById('pwe-ai-status');
  const sendBtn = document.getElementById('pwe-ai-send');
  statusEl.innerHTML = '<span class="spinner-sm"></span> Genererar...';
  statusEl.classList.remove('hidden');
  sendBtn.disabled = true;

  try {
    const session = (await sb.auth.getSession()).data.session;
    const res = await fetch(SUPABASE_FUNCTIONS_URL + '/generate-plan', {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + session.access_token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        profile_id: currentProfile.id,
        mode: 'edit_single',
        plan_id: _activePlan.id,
        workout_id: _pweWorkout.id,
        instruction: instruction,
        current_workout: {
          day_of_week: _pweWorkout.day_of_week,
          activity_type: _pweWorkout.activity_type,
          label: _pweWorkout.label,
          description: _pweWorkout.description,
          target_duration_minutes: _pweWorkout.target_duration_minutes,
          target_distance_km: _pweWorkout.target_distance_km,
          intensity_zone: _pweWorkout.intensity_zone,
          is_rest: _pweWorkout.is_rest,
        },
      }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'AI edit failed');

    // Fill form with AI result
    if (result.workout) {
      const w = result.workout;
      document.getElementById('pwe-activity').value = w.activity_type || _pweWorkout.activity_type;
      document.getElementById('pwe-label').value = w.label || '';
      document.getElementById('pwe-duration').value = w.target_duration_minutes || '';
      document.getElementById('pwe-distance').value = w.target_distance_km || '';
      document.getElementById('pwe-desc').value = w.description || '';
      document.getElementById('pwe-rest').checked = !!w.is_rest;
      _pweZone = w.intensity_zone || '';
      document.getElementById('pwe-zone').value = _pweZone;
      document.querySelectorAll('#pwe-zone-pills .intensity-pill').forEach(b => b.classList.toggle('active', b.dataset.value === _pweZone));
      statusEl.innerHTML = 'AI-förslag ifyllt. Granska och tryck Spara.';
      statusEl.style.color = 'var(--green)';
    }
  } catch (e) {
    statusEl.innerHTML = 'Fel: ' + e.message;
    statusEl.style.color = 'var(--red)';
  }
  sendBtn.disabled = false;
  input.value = '';
}

let _planEditHistory = [];
let _planEditProposal = null;
let _planEditCurrentPlan = null;
let _planEditPreviewWeek = 0;
let _planEditChangedOnly = false;

function openPlanEditModal() {
  if (!_activePlan) return;
  _planEditHistory = [];
  _planEditProposal = null;
  _planEditCurrentPlan = null;
  _planEditPreviewWeek = 0;
  _planEditChangedOnly = false;
  const chatEl = document.getElementById('plan-edit-chat');
  chatEl.innerHTML = `<div class="plan-edit-msg bot">Beskriv vilka ändringar du vill göra i schemat, t.ex. "byt torsdagens pass mot tempo" eller "lägg långpasset på lördagar". Du får granska förslaget innan det sparas.</div>`;
  document.getElementById('plan-edit-input').value = '';
  document.getElementById('plan-edit-modal').classList.remove('hidden');
}

function closePlanEditModal() {
  document.getElementById('plan-edit-modal').classList.add('hidden');
  _planEditProposal = null;
}

function _findWorkout(week, dayOfWeek) {
  return (week?.workouts || []).find(w => w.day_of_week === dayOfWeek) || null;
}

function _workoutsDiffer(a, b) {
  if (!a && !b) return false;
  if (!a || !b) return true;
  if ((a.is_rest ? 1 : 0) !== (b.is_rest ? 1 : 0)) return true;
  if ((a.activity_type || '') !== (b.activity_type || '')) return true;
  if ((a.label || '') !== (b.label || '')) return true;
  if ((a.description || '') !== (b.description || '')) return true;
  if ((a.target_duration_minutes || 0) !== (b.target_duration_minutes || 0)) return true;
  if ((a.target_distance_km ?? null) !== (b.target_distance_km ?? null)) return true;
  if ((a.intensity_zone || null) !== (b.intensity_zone || null)) return true;
  return false;
}

function _countChangedWeeks(oldPlan, newPlan) {
  const weeks = newPlan?.weeks || [];
  let total = 0;
  for (let wi = 0; wi < weeks.length; wi++) {
    const ow = oldPlan?.weeks?.[wi];
    const nw = weeks[wi];
    for (let d = 0; d < 7; d++) {
      if (_workoutsDiffer(_findWorkout(ow, d), _findWorkout(nw, d))) { total++; break; }
    }
  }
  return total;
}

function _countChangedWorkouts(oldPlan, newPlan) {
  const weeks = newPlan?.weeks || [];
  let total = 0;
  for (let wi = 0; wi < weeks.length; wi++) {
    const ow = oldPlan?.weeks?.[wi];
    const nw = weeks[wi];
    for (let d = 0; d < 7; d++) {
      if (_workoutsDiffer(_findWorkout(ow, d), _findWorkout(nw, d))) total++;
    }
  }
  return total;
}

function _peFormatWorkoutSummary(wo) {
  if (!wo) return '(tom)';
  if (wo.is_rest) return 'Vila';
  const parts = [wo.label || wo.activity_type || 'Pass'];
  if (wo.target_duration_minutes) parts.push(`${wo.target_duration_minutes} min`);
  if (wo.intensity_zone) parts.push(wo.intensity_zone);
  return parts.join(' · ');
}

function renderProposalPreview() {
  const container = document.getElementById('pe-preview');
  if (!container || !_planEditProposal || !_planEditCurrentPlan) return;
  const DAY = ['Mån', 'Tis', 'Ons', 'Tors', 'Fre', 'Lör', 'Sön'];
  const newWeeks = _planEditProposal.weeks || [];
  const oldWeeks = _planEditCurrentPlan.weeks || [];
  if (!newWeeks.length) {
    container.innerHTML = `<div class="pe-preview-empty">Inga veckor i förslaget.</div>`;
    return;
  }

  const weekIdx = Math.max(0, Math.min(_planEditPreviewWeek, newWeeks.length - 1));
  _planEditPreviewWeek = weekIdx;
  const newWeek = newWeeks[weekIdx];
  const oldWeek = oldWeeks[weekIdx] || null;
  const changedWeeks = _countChangedWeeks(_planEditCurrentPlan, _planEditProposal);
  const changedTotal = _countChangedWorkouts(_planEditCurrentPlan, _planEditProposal);

  const isAssessmentWeek = newWeek?.phase === 'assessment';

  let cards = '';
  for (let d = 0; d < 7; d++) {
    const oldWo = _findWorkout(oldWeek, d);
    const newWo = _findWorkout(newWeek, d);
    const changed = _workoutsDiffer(oldWo, newWo);
    if (_planEditChangedOnly && !changed) continue;
    const isAssessmentWorkout = !!newWo && !newWo.is_rest && typeof newWo.label === 'string' && /^Bedömning/i.test(newWo.label);
    const zoneBadge = newWo?.intensity_zone
      ? `<span class="zone-badge zone-${escapeHTML(newWo.intensity_zone.toLowerCase())}" style="font-size:0.55rem;padding:1px 4px;">${escapeHTML(newWo.intensity_zone)}</span>`
      : '';
    const testBadge = isAssessmentWorkout ? `<span class="day-badge--test">TEST</span>` : '';
    const dur = newWo?.target_duration_minutes ? `${newWo.target_duration_minutes}m` : '';
    const body = !newWo
      ? `<span class="pe-card-rest">—</span>`
      : newWo.is_rest
        ? `<span class="pe-card-rest">Vila</span>`
        : `<span class="pe-card-label">${escapeHTML(newWo.label || newWo.activity_type || 'Pass')}${testBadge}</span>
           <span class="pe-card-meta">${zoneBadge} ${dur}</span>`;
    const badge = changed ? `<span class="pe-card-badge">Ändrat</span>` : '';
    const compareBtn = changed
      ? `<button class="pe-card-compare" title="Jämför före/efter" onclick="togglePeCompare(${weekIdx}, ${d})">⇄</button>`
      : '';
    cards += `
      <div class="pe-card ${changed ? 'pe-card-changed' : ''}${isAssessmentWorkout ? ' pe-card--assess' : ''}" id="pe-card-${weekIdx}-${d}">
        <div class="pe-card-head">
          <span class="pe-card-day">${DAY[d]}</span>
          <div class="pe-card-head-actions">
            ${compareBtn}
            <button class="pe-card-edit-btn" title="Redigera pass manuellt" onclick="openManualWorkoutEdit(${weekIdx}, ${d})" aria-label="Redigera ${DAY[d]}">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
            </button>
          </div>
        </div>
        <div class="pe-card-body">${body}</div>
        ${badge}
      </div>`;
  }

  if (!cards && _planEditChangedOnly) {
    cards = `<div class="pe-preview-empty">Inga ändringar på denna vecka.</div>`;
  }

  const phaseLabel = (typeof PHASE_LABELS !== 'undefined' && PHASE_LABELS[newWeek.phase]) || newWeek.phase || '';
  const weekChangesCount = (() => {
    let c = 0;
    for (let d = 0; d < 7; d++) {
      if (_workoutsDiffer(_findWorkout(oldWeek, d), _findWorkout(newWeek, d))) c++;
    }
    return c;
  })();

  container.innerHTML = `
    <div class="pe-preview-header">
      <div class="pe-preview-title">Föreslaget schema</div>
      <div class="pe-preview-summary">
        ${changedTotal} ${changedTotal === 1 ? 'pass ändrat' : 'pass ändrade'} över ${changedWeeks} ${changedWeeks === 1 ? 'vecka' : 'veckor'}
        · Totalt ${newWeeks.length} ${newWeeks.length === 1 ? 'vecka' : 'veckor'}
      </div>
    </div>
    <div class="pe-filter-toggle">
      <button class="${_planEditChangedOnly ? '' : 'active'}" onclick="setPeChangedOnly(false)">Hela veckan</button>
      <button class="${_planEditChangedOnly ? 'active' : ''}" onclick="setPeChangedOnly(true)">Bara ändrade</button>
    </div>
    <div class="pe-week-nav">
      <button class="pe-nav-arrow" onclick="pePreviewWeek(-1)" ${weekIdx === 0 ? 'disabled' : ''} aria-label="Föregående vecka">‹</button>
      <span class="pe-week-label${isAssessmentWeek ? ' pe-week-label--assess' : ''}">Vecka ${newWeek.week_number}${phaseLabel ? ' · ' + escapeHTML(phaseLabel) : ''}${weekChangesCount > 0 ? ` · <span class="pe-week-changes">${weekChangesCount} ändr.</span>` : ''}</span>
      <button class="pe-nav-arrow" onclick="pePreviewWeek(1)" ${weekIdx >= newWeeks.length - 1 ? 'disabled' : ''} aria-label="Nästa vecka">›</button>
    </div>
    ${isAssessmentWeek ? `<div class="assessment-banner pe-assessment-banner">
      <span class="ab-icon" aria-hidden="true">⚑</span>
      <span class="ab-text"><strong>Bedömningsvecka.</strong> Tre testpass kalibrerar puls och tempo.</span>
    </div>` : ''}
    <div class="pe-preview-grid">${cards}</div>
    <div class="pe-preview-actions">
      <button class="btn btn-primary btn-sm" onclick="approvePlanEdit()">Godkänn ändringar</button>
      <button class="btn btn-outline btn-sm" onclick="continueAiAdjust()">Be AI justera vidare</button>
      <button class="btn btn-danger-text btn-sm" onclick="discardPlanEditProposal()">Kasta bort förslag</button>
    </div>
  `;
}

function pePreviewWeek(delta) {
  const total = (_planEditProposal?.weeks || []).length;
  if (!total) return;
  _planEditPreviewWeek = Math.max(0, Math.min(_planEditPreviewWeek + delta, total - 1));
  renderProposalPreview();
}

function setPeChangedOnly(onlyChanged) {
  _planEditChangedOnly = !!onlyChanged;
  renderProposalPreview();
}

function togglePeCompare(weekIdx, dayIdx) {
  const card = document.getElementById(`pe-card-${weekIdx}-${dayIdx}`);
  if (!card) return;
  const existing = card.querySelector('.pe-compare-popover');
  if (existing) { existing.remove(); return; }
  const oldWo = _findWorkout(_planEditCurrentPlan?.weeks?.[weekIdx], dayIdx);
  const newWo = _findWorkout(_planEditProposal?.weeks?.[weekIdx], dayIdx);
  const pop = document.createElement('div');
  pop.className = 'pe-compare-popover';
  pop.innerHTML = `
    <div class="pe-compare-row"><span class="pe-compare-label">Före</span><span>${escapeHTML(_peFormatWorkoutSummary(oldWo))}</span></div>
    <div class="pe-compare-row pe-compare-new"><span class="pe-compare-label">Efter</span><span>${escapeHTML(_peFormatWorkoutSummary(newWo))}</span></div>
    ${(oldWo?.description || newWo?.description) ? `
      <div class="pe-compare-desc"><span class="pe-compare-label">Beskrivning</span>
        <div class="pe-compare-desc-old">${escapeHTML(oldWo?.description || '(saknas)')}</div>
        <div class="pe-compare-desc-new">${escapeHTML(newWo?.description || '(saknas)')}</div>
      </div>` : ''}
  `;
  card.appendChild(pop);
}

function discardPlanEditProposal() {
  _planEditProposal = null;
  _planEditPreviewWeek = 0;
  _planEditChangedOnly = false;
  const wrap = document.getElementById('pe-preview-wrap');
  if (wrap) wrap.remove();
  const chatEl = document.getElementById('plan-edit-chat');
  chatEl.innerHTML += `<div class="plan-edit-msg bot">Förslaget kasserat. Beskriv vad du vill ändra — eller stäng rutan.</div>`;
  const input = document.getElementById('plan-edit-input');
  input?.focus();
  chatEl.scrollTop = chatEl.scrollHeight;
}

function continueAiAdjust() {
  const input = document.getElementById('plan-edit-input');
  input?.focus();
  // Keep the proposal visible so the user can see current state while typing.
}

// ── Manual per-workout edit (pen icon on each preview card) ─────────
let _peManualTarget = null; // { weekIdx, origDayIdx }

function openManualWorkoutEdit(weekIdx, dayIdx) {
  if (!_planEditProposal?.weeks?.[weekIdx]) return;
  const wo = _findWorkout(_planEditProposal.weeks[weekIdx], dayIdx);
  _peManualTarget = { weekIdx, origDayIdx: dayIdx };

  document.getElementById('pe-manual-title').textContent = `Redigera vecka ${_planEditProposal.weeks[weekIdx].week_number} · ${['Måndag','Tisdag','Onsdag','Torsdag','Fredag','Lördag','Söndag'][dayIdx]}`;
  document.getElementById('pe-manual-rest').checked = !!(wo?.is_rest);
  document.getElementById('pe-manual-day').value = String(dayIdx);
  document.getElementById('pe-manual-activity').value = wo?.activity_type || 'Löpning';
  document.getElementById('pe-manual-label').value = wo?.label || '';
  document.getElementById('pe-manual-description').value = wo?.description || '';
  document.getElementById('pe-manual-duration').value = wo?.target_duration_minutes ?? '';
  document.getElementById('pe-manual-distance').value = wo?.target_distance_km ?? '';
  document.getElementById('pe-manual-zone').value = wo?.intensity_zone || '';

  onPeManualRestToggle();
  document.getElementById('pe-manual-edit-modal').classList.remove('hidden');
}

function closeManualWorkoutEdit() {
  document.getElementById('pe-manual-edit-modal').classList.add('hidden');
  _peManualTarget = null;
}

function onPeManualRestToggle() {
  const isRest = document.getElementById('pe-manual-rest').checked;
  const disabled = isRest;
  ['pe-manual-activity', 'pe-manual-label', 'pe-manual-description',
   'pe-manual-duration', 'pe-manual-distance', 'pe-manual-zone'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = disabled;
  });
  if (isRest) {
    document.getElementById('pe-manual-activity').value = 'Vila';
    document.getElementById('pe-manual-label').value = 'Vila';
    document.getElementById('pe-manual-description').value = '';
    document.getElementById('pe-manual-duration').value = 0;
    document.getElementById('pe-manual-distance').value = '';
    document.getElementById('pe-manual-zone').value = '';
  }
}

function saveManualWorkoutEdit() {
  if (!_peManualTarget || !_planEditProposal) return;
  const { weekIdx, origDayIdx } = _peManualTarget;
  const week = _planEditProposal.weeks[weekIdx];
  if (!week) return;

  const isRest = document.getElementById('pe-manual-rest').checked;
  const newDay = parseInt(document.getElementById('pe-manual-day').value, 10);
  if (!(newDay >= 0 && newDay <= 6)) return;

  const duration = parseInt(document.getElementById('pe-manual-duration').value, 10) || 0;
  const distRaw = document.getElementById('pe-manual-distance').value;
  const distance = distRaw === '' ? null : (parseFloat(distRaw) || null);

  const updated = isRest ? {
    day_of_week: newDay,
    activity_type: 'Vila',
    label: 'Vila',
    description: null,
    target_duration_minutes: 0,
    target_distance_km: null,
    intensity_zone: null,
    is_rest: true,
  } : {
    day_of_week: newDay,
    activity_type: document.getElementById('pe-manual-activity').value,
    label: document.getElementById('pe-manual-label').value.trim() || document.getElementById('pe-manual-activity').value,
    description: document.getElementById('pe-manual-description').value.trim() || null,
    target_duration_minutes: Math.max(0, duration),
    target_distance_km: distance,
    intensity_zone: document.getElementById('pe-manual-zone').value || null,
    is_rest: false,
  };

  // If the day changed, swap with whatever workout occupied the target day.
  const origIdx = week.workouts.findIndex(w => w.day_of_week === origDayIdx);
  if (origIdx < 0) return;

  if (newDay !== origDayIdx) {
    const targetIdx = week.workouts.findIndex(w => w.day_of_week === newDay);
    if (targetIdx >= 0 && targetIdx !== origIdx) {
      // Move the existing target-day workout to the original day (swap).
      week.workouts[targetIdx] = { ...week.workouts[targetIdx], day_of_week: origDayIdx };
    }
  }
  week.workouts[origIdx] = updated;

  closeManualWorkoutEdit();
  renderProposalPreview();
}

async function _loadCurrentPlanForEdit() {
  if (_planEditCurrentPlan) return _planEditCurrentPlan;
  const planWeeks = await fetchPlanWeeks(_activePlan.id);
  const allWorkouts = [];
  for (const w of planWeeks) {
    const { data } = await sb.from('plan_workouts').select('*').eq('plan_week_id', w.id).order('day_of_week');
    allWorkouts.push(...(data || []));
  }
  _planEditCurrentPlan = {
    plan_name: _activePlan.name || _activePlan.goal_text,
    summary: '',
    weeks: planWeeks.map(pw => ({
      week_number: pw.week_number,
      phase: pw.phase,
      target_hours: pw.target_hours,
      target_sessions: pw.target_sessions,
      notes: pw.notes,
      workouts: allWorkouts.filter(wo => wo.plan_week_id === pw.id).map(wo => ({
        day_of_week: wo.day_of_week,
        activity_type: wo.activity_type,
        label: wo.label,
        description: wo.description,
        target_duration_minutes: wo.target_duration_minutes,
        target_distance_km: wo.target_distance_km,
        intensity_zone: wo.intensity_zone,
        is_rest: wo.is_rest,
      }))
    }))
  };
  return _planEditCurrentPlan;
}

async function submitPlanEdit() {
  const input = document.getElementById('plan-edit-input');
  const instruction = input.value.trim();
  if (!instruction || !_activePlan) return;

  const chatEl = document.getElementById('plan-edit-chat');
  const sendBtn = document.getElementById('plan-edit-send');

  // Remove any previous proposal preview so the new one replaces it in place.
  const prevWrap = document.getElementById('pe-preview-wrap');
  if (prevWrap) prevWrap.remove();

  chatEl.innerHTML += `<div class="plan-edit-msg user">${escapeHTML(instruction)}</div>`;
  chatEl.innerHTML += `<div class="plan-edit-msg bot" id="plan-edit-loading"><span class="spinner-sm"></span> Genererar förslag...</div>`;
  input.value = '';
  sendBtn.disabled = true;
  chatEl.scrollTop = chatEl.scrollHeight;

  _planEditHistory.push({ role: 'user', content: instruction });

  try {
    // When iterating on an existing proposal, let the AI refine from there
    // instead of the original DB plan.
    const basePlan = _planEditProposal || await _loadCurrentPlanForEdit();
    const currentPlan = await _loadCurrentPlanForEdit();
    const session = (await sb.auth.getSession()).data.session;
    const res = await fetch(SUPABASE_FUNCTIONS_URL + '/generate-plan', {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + session.access_token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        profile_id: currentProfile.id,
        mode: 'edit_preview',
        plan_id: _activePlan.id,
        instruction: instruction,
        current_plan: basePlan,
        conversation_history: _planEditHistory.slice(0, -1),
      }),
    });

    const result = await res.json();
    const loadingEl = document.getElementById('plan-edit-loading');
    if (loadingEl) loadingEl.remove();

    if (!res.ok) throw new Error(result.error || 'Preview failed');

    _planEditProposal = result.proposed_plan;
    _planEditPreviewWeek = 0;
    _planEditChangedOnly = false;

    // Jump to the first changed week so the user sees the change immediately.
    const newWeeks = _planEditProposal.weeks || [];
    for (let wi = 0; wi < newWeeks.length; wi++) {
      const oldWeek = (currentPlan.weeks || [])[wi];
      const newWeek = newWeeks[wi];
      let changed = false;
      for (let d = 0; d < 7; d++) {
        if (_workoutsDiffer(_findWorkout(oldWeek, d), _findWorkout(newWeek, d))) { changed = true; break; }
      }
      if (changed) { _planEditPreviewWeek = wi; break; }
    }

    chatEl.innerHTML += `<div class="plan-edit-msg bot pe-preview-msg" id="pe-preview-wrap"><div id="pe-preview"></div></div>`;
    renderProposalPreview();

    const changedTotal = _countChangedWorkouts(currentPlan, _planEditProposal);
    _planEditHistory.push({ role: 'assistant', content: `Proposed plan updated (${changedTotal} workouts changed).` });
  } catch (e) {
    const loadingEl = document.getElementById('plan-edit-loading');
    if (loadingEl) loadingEl.remove();
    chatEl.innerHTML += `<div class="plan-edit-msg bot" style="color:var(--red);">Fel: ${escapeHTML(e.message)}</div>`;
  }
  sendBtn.disabled = false;
  chatEl.scrollTop = chatEl.scrollHeight;
}

async function approvePlanEdit() {
  if (!_planEditProposal || !_activePlan) return;
  const chatEl = document.getElementById('plan-edit-chat');
  const prevWrap = document.getElementById('pe-preview-wrap');
  if (prevWrap) prevWrap.remove();
  chatEl.innerHTML += `<div class="plan-edit-msg bot" id="plan-edit-applying"><span class="spinner-sm"></span> Sparar ändringar...</div>`;
  chatEl.scrollTop = chatEl.scrollHeight;

  try {
    const session = (await sb.auth.getSession()).data.session;
    const res = await fetch(SUPABASE_FUNCTIONS_URL + '/generate-plan', {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + session.access_token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        profile_id: currentProfile.id,
        mode: 'edit_apply',
        plan_id: _activePlan.id,
        proposed_plan: _planEditProposal,
      }),
    });

    const result = await res.json();
    const applyEl = document.getElementById('plan-edit-applying');
    if (applyEl) applyEl.remove();

    if (!res.ok) throw new Error(result.error || 'Apply failed');

    chatEl.innerHTML += `<div class="plan-edit-msg bot" style="color:var(--green);">Schemat har uppdaterats!</div>`;
    _planEditProposal = null;
    _planEditCurrentPlan = null;
    _activePlan = null;
    _activePlanWeeks = [];
    _activePlanWorkouts = [];
    loadSchema();
    setTimeout(() => { closePlanEditModal(); }, 900);
  } catch (e) {
    const applyEl = document.getElementById('plan-edit-applying');
    if (applyEl) applyEl.remove();
    chatEl.innerHTML += `<div class="plan-edit-msg bot" style="color:var(--red);">Fel: ${escapeHTML(e.message)}</div>`;
  }
  chatEl.scrollTop = chatEl.scrollHeight;
}

// ═══════════════════════════════════════════════════════════════════
//  SOCIAL — friends, feed, likes, comments
// ═══════════════════════════════════════════════════════════════════

let _socialFeedPage = 0;
const SOCIAL_FEED_PAGE_SIZE = 15;

async function loadSocial() {
  showViewLoading('view-social');
  try { await _loadSocial(); } catch (e) { console.error('Social error:', e); }
  hideViewLoading('view-social');
}

async function _loadSocial() {
  await renderFriendRequests();
  await renderFriendList();
  _socialFeedPage = 0;
  await renderSocialFeed(false);
}

// ── Topbar global user search ──

function toggleTopbarSearch() {
  const panel = document.getElementById('topbar-search-panel');
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) {
    document.getElementById('topbar-search-input').value = '';
    document.getElementById('topbar-search-results').innerHTML = '';
    document.getElementById('topbar-search-input').focus();
  }
}

async function refreshAllProfiles() {
  try {
    const token = (await sb.auth.getSession()).data.session?.access_token;
    if (token) allProfiles = await fetchProfilesDirect(token);
  } catch (e) { console.error('refreshAllProfiles error:', e); }
}

async function updateFriendRequestBadge() {
  if (!currentProfile) return;
  try {
    const { count } = await sb.from('friendships')
      .select('id', { count: 'exact', head: true })
      .eq('receiver_id', currentProfile.id)
      .eq('status', 'pending');
    // Drive UI through the store so any subscriber (e.g. a future
    // notifications panel) gets the same count.
    store.set('friendRequests', count || 0);
  } catch (e) { console.error('updateFriendRequestBadge error:', e); }
}

// Diff-by-key DOM update for the friend-request badge.
function _renderFriendRequestBadge(count) {
  const badge = document.getElementById('friend-request-badge');
  if (!badge) return;
  const next = !count ? '' : (count > 9 ? '9+' : String(count));
  if (badge.textContent !== next) badge.textContent = next;
  badge.classList.toggle('hidden', !count);
}
store.on('friendRequests', _renderFriendRequestBadge);

async function topbarSearchUsers() {
  const rawQ = document.getElementById('topbar-search-input').value.trim();
  const resultsEl = document.getElementById('topbar-search-results');
  if (rawQ.length < 2) { resultsEl.innerHTML = ''; return; }

  // RLS lockdown means allProfiles only contains self + friends + same group.
  // For discovery we need the SECURITY DEFINER RPC that returns minimal
  // (id, name, avatar, color) for any matching profile. See migration
  // 20260421_search_profiles_by_name.sql.
  const { data: rpcMatches, error: searchErr } = await sb.rpc('search_profiles_by_name', { p_query: rawQ });
  if (searchErr) {
    console.error('topbarSearchUsers RPC error:', searchErr);
    resultsEl.innerHTML = '<div style="padding:12px;color:var(--text-dim);font-size:0.82rem;text-align:center;">Sökningen misslyckades</div>';
    return;
  }
  const matches = (rpcMatches || []).filter((p) => p.id !== currentProfile.id);

  const { data: friendships } = await sb.from('friendships')
    .select('*')
    .or(`requester_id.eq.${currentProfile.id},receiver_id.eq.${currentProfile.id}`);

  const friendMap = {};
  (friendships || []).forEach(f => {
    const otherId = f.requester_id === currentProfile.id ? f.receiver_id : f.requester_id;
    friendMap[otherId] = f.status;
  });

  if (matches.length === 0) {
    resultsEl.innerHTML = '<div style="padding:12px;color:var(--text-dim);font-size:0.82rem;text-align:center;">Inga resultat</div>';
    return;
  }

  resultsEl.innerHTML = matches.slice(0, 10).map(p => {
    const avatar = p.avatar || p.name[0].toUpperCase();
    const color = p.color || '#2E86C1';
    const isEmoji = p.avatar && p.avatar.length <= 2;
    const status = friendMap[p.id];
    let actionHtml = '';
    if (status === 'accepted') {
      actionHtml = '<span style="font-size:0.72rem;color:var(--green);font-weight:600;">Vän</span>';
    } else if (status === 'pending') {
      actionHtml = '<span style="font-size:0.72rem;color:var(--text-dim);">Väntande</span>';
    } else {
      actionHtml = `<button class="btn btn-sm btn-primary" onclick="event.stopPropagation();topbarAddFriend('${escapeHTML(p.id)}',this)">Lägg till</button>`;
    }
    return `<div class="topbar-search-result" onclick="topbarViewProfile('${escapeHTML(p.id)}')">
      <div class="tsr-avatar" style="background:${isEmoji ? 'transparent' : color};font-size:${isEmoji ? '1.2rem' : '0.8rem'};">${escapeHTML(avatar)}</div>
      <div class="tsr-info">
        <div class="tsr-name">${escapeHTML(p.name)}</div>
        <div class="tsr-status">${status === 'accepted' ? 'Vän' : ''}</div>
      </div>
      ${actionHtml}
    </div>`;
  }).join('');
}

async function topbarAddFriend(profileId, btn) {
  try {
    await sb.from('friendships').insert({
      requester_id: currentProfile.id,
      receiver_id: profileId,
      status: 'pending',
    });
    btn.outerHTML = '<span style="font-size:0.72rem;color:var(--green);font-weight:600;">Skickad</span>';
  } catch (e) {
    console.error('Add friend error:', e);
    btn.textContent = 'Fel';
    btn.disabled = true;
  }
}

function topbarViewProfile(profileId) {
  toggleTopbarSearch();
  if (typeof openMemberProfile === 'function') {
    openMemberProfile(profileId);
  }
}

function toggleFriendSearch() {
  const row = document.getElementById('friend-search-row');
  row.classList.toggle('hidden');
  if (!row.classList.contains('hidden')) {
    document.getElementById('friend-search-input').value = '';
    document.getElementById('friend-search-results').innerHTML = '';
    document.getElementById('friend-search-input').focus();
  }
}

async function searchFriends() {
  const rawQ = document.getElementById('friend-search-input').value.trim();
  const resultsEl = document.getElementById('friend-search-results');
  if (rawQ.length < 2) { resultsEl.innerHTML = ''; return; }

  // Same rationale as topbarSearchUsers: RLS hides non-friend profiles, so
  // we go through the search_profiles_by_name RPC for discovery.
  const { data: rpcMatches, error: searchErr } = await sb.rpc('search_profiles_by_name', { p_query: rawQ });
  if (searchErr) {
    console.error('searchFriends RPC error:', searchErr);
    resultsEl.innerHTML = '<div style="padding:8px;color:var(--text-dim);font-size:0.82rem;">Sökningen misslyckades</div>';
    return;
  }
  const matches = (rpcMatches || []).filter((p) => p.id !== currentProfile.id);

  const { data: existing } = await sb.from('friendships')
    .select('*')
    .or(`requester_id.eq.${currentProfile.id},receiver_id.eq.${currentProfile.id}`);
  const existingIds = new Set();
  (existing || []).forEach(f => {
    if (f.status !== 'declined') {
      existingIds.add(f.requester_id === currentProfile.id ? f.receiver_id : f.requester_id);
    }
  });

  if (matches.length === 0) {
    resultsEl.innerHTML = '<div style="padding:8px;color:var(--text-dim);font-size:0.82rem;">Inga resultat</div>';
    return;
  }

  resultsEl.innerHTML = matches.slice(0, 8).map(p => {
    const isFriend = existingIds.has(p.id);
    return `<div class="friend-search-item">
      <span class="friend-search-item-name">${escapeHTML(p.name)}</span>
      ${isFriend
        ? '<span style="font-size:0.75rem;color:var(--text-dim);">Redan tillagd</span>'
        : `<button class="btn btn-sm btn-primary" onclick="sendFriendRequest('${escapeHTML(p.id)}')">Lägg till</button>`
      }
    </div>`;
  }).join('');
}

async function sendFriendRequest(receiverId) {
  try {
    await sb.from('friendships').insert({
      requester_id: currentProfile.id,
      receiver_id: receiverId,
      status: 'pending',
    });
    searchFriends();
    await showAlertModal('Skickat', 'Vänförfrågan skickad.');
  } catch (e) {
    console.error('Send friend request error:', e);
    await showAlertModal('Fel', 'Kunde inte skicka förfrågan. Du kanske redan har skickat en.');
  }
}

async function renderFriendRequests() {
  const el = document.getElementById('friend-requests');
  const { data } = await sb.from('friendships')
    .select('*')
    .eq('receiver_id', currentProfile.id)
    .eq('status', 'pending');

  if (!data || data.length === 0) { el.innerHTML = ''; return; }

  el.innerHTML = '<div style="font-size:0.75rem;font-weight:600;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.3px;margin-bottom:6px;">Väntande förfrågningar</div>' +
    data.map(f => {
      const sender = allProfiles.find(p => p.id === f.requester_id);
      const name = sender?.name || 'Okänd';
      return `<div class="friend-request-item">
        <span class="friend-request-name">${name}</span>
        <div class="friend-request-actions">
          <button class="invite-accept-btn" onclick="respondFriendRequest('${f.id}','accepted')">Acceptera</button>
          <button class="invite-decline-btn" onclick="respondFriendRequest('${f.id}','declined')">Avböj</button>
        </div>
      </div>`;
    }).join('');
}

async function respondFriendRequest(friendshipId, status) {
  try {
    await sb.from('friendships')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', friendshipId);
    await renderFriendRequests();
    await renderFriendList();
    updateFriendRequestBadge();
    if (status === 'accepted') await renderSocialFeed(false);
  } catch (e) {
    console.error('Respond friend request error:', e);
  }
}

async function getAcceptedFriends() {
  const { data } = await sb.from('friendships')
    .select('*')
    .eq('status', 'accepted')
    .or(`requester_id.eq.${currentProfile.id},receiver_id.eq.${currentProfile.id}`);

  if (!data) return [];
  return data.map(f =>
    f.requester_id === currentProfile.id ? f.receiver_id : f.requester_id
  );
}

async function renderFriendList() {
  const friendIds = await getAcceptedFriends();
  const countEl = document.getElementById('friends-count');
  if (countEl) countEl.textContent = String(friendIds.length);

  const modalListEl = document.getElementById('friend-list-modal');
  if (!modalListEl) return;

  if (friendIds.length === 0) {
    modalListEl.innerHTML = '<div style="padding:18px 0;color:var(--text-dim);font-size:0.85rem;text-align:center;">Inga vänner ännu. Stäng och välj &laquo;+ Lägg till&raquo; för att bjuda in.</div>';
    return;
  }

  modalListEl.innerHTML = friendIds.map(fid => {
    const p = allProfiles.find(pr => pr.id === fid);
    if (!p) return '';
    const avatar = p.avatar || p.name[0].toUpperCase();
    const color = p.color || '#2E86C1';
    const isEmoji = p.avatar && p.avatar.length <= 2;
    return `<div class="friend-item">
      <div class="friend-avatar" style="background:${isEmoji ? 'transparent' : color};font-size:${isEmoji ? '1.2rem' : '0.8rem'};">${escapeHTML(avatar)}</div>
      <span class="friend-name">${escapeHTML(p.name)}</span>
      <button class="friend-remove-btn" onclick="removeFriend('${escapeHTML(fid)}')">Ta bort</button>
    </div>`;
  }).join('');
}

function openFriendsModal() {
  const m = document.getElementById('friends-modal');
  if (!m) return;
  renderFriendList();
  m.classList.remove('hidden');
}

function closeFriendsModal() {
  const m = document.getElementById('friends-modal');
  if (m) m.classList.add('hidden');
}

async function removeFriend(friendId) {
  const ok = await showConfirmModal('Ta bort vän', 'Vill du ta bort denna vän?', 'Ta bort', true);
  if (!ok) return;
  try {
    await sb.from('friendships')
      .delete()
      .or(`and(requester_id.eq.${currentProfile.id},receiver_id.eq.${friendId}),and(requester_id.eq.${friendId},receiver_id.eq.${currentProfile.id})`);
    await renderFriendList();
    await renderSocialFeed(false);
  } catch (e) {
    console.error('Remove friend error:', e);
  }
}

function buildSocialStatsRow(w) {
  const parts = [];
  if (w.avg_hr) parts.push(`<span class="sf-stat">&#9829; ${w.avg_hr} bpm</span>`);
  if (w.elevation_gain_m) parts.push(`<span class="sf-stat">&#9650; ${Math.round(w.elevation_gain_m)} m</span>`);
  if (w.avg_speed_kmh && w.activity_type === 'Löpning') {
    const pace = 60 / w.avg_speed_kmh;
    const pMin = Math.floor(pace);
    const pSec = String(Math.round((pace - pMin) * 60)).padStart(2, '0');
    parts.push(`<span class="sf-stat">${pMin}:${pSec}/km</span>`);
  }
  if (w.calories) parts.push(`<span class="sf-stat">${w.calories} kcal</span>`);
  return parts.length ? `<div class="sf-stats-row">${parts.join('')}</div>` : '';
}

async function initSocialFeedMaps() {
  await initMapThumbnails();
}

async function renderSocialFeed(append) {
  const feedEl = document.getElementById('social-feed');
  const moreBtn = document.getElementById('social-feed-more');

  const friendIds = await getAcceptedFriends();
  const feedIds = [currentProfile.id, ...friendIds];

  if (feedIds.length === 0) {
    feedEl.innerHTML = `<div class="sf-empty">Lägg till vänner för att se deras aktiviteter i flödet.</div>
      <button type="button" class="btn btn-sm btn-primary" style="margin-top:12px;" onclick="toggleFriendSearch()">Bjud in vänner</button>`;
    moreBtn.classList.add('hidden');
    return;
  }

  const offset = _socialFeedPage * SOCIAL_FEED_PAGE_SIZE;
  const { data: workouts } = await sb.from('workouts')
    .select('*')
    .in('profile_id', feedIds)
    .order('workout_date', { ascending: false })
    .range(offset, offset + SOCIAL_FEED_PAGE_SIZE - 1);

  if (!workouts || workouts.length === 0) {
    if (!append) {
      feedEl.innerHTML = `<div class="sf-empty">Inga pass att visa ännu.</div>
        <button type="button" class="btn btn-sm btn-ghost" style="margin-top:12px;" onclick="toggleFriendSearch()">Bjud in fler vänner</button>`;
    }
    moreBtn.classList.add('hidden');
    return;
  }

  const workoutIds = workouts.map(w => w.id);
  const reactions = await fetchReactionsBulk(workoutIds);
  const comments = await fetchCommentsBulk(workoutIds);

  const reactionsByWorkout = {};
  (reactions || []).forEach(r => {
    if (!reactionsByWorkout[r.workout_id]) reactionsByWorkout[r.workout_id] = [];
    reactionsByWorkout[r.workout_id].push(r);
  });

  const commentsByWorkout = {};
  (comments || []).forEach(c => {
    if (!commentsByWorkout[c.workout_id]) commentsByWorkout[c.workout_id] = [];
    commentsByWorkout[c.workout_id].push(c);
  });

  const html = workouts.map(w => {
    const p = allProfiles.find(pr => pr.id === w.profile_id);
    const name = p?.name || 'Okänd';
    const avatar = p?.avatar || name[0].toUpperCase();
    const color = p?.color || '#2E86C1';
    const wReactions = reactionsByWorkout[w.id] || [];
    const wLikes = wReactions.filter(r => r.reaction === 'like');
    const wDislikes = wReactions.filter(r => r.reaction === 'dislike');
    const myReaction = wReactions.find(r => r.profile_id === currentProfile.id);
    const isOwnWorkout = w.profile_id === currentProfile.id;
    const wComments = commentsByWorkout[w.id] || [];

    // SECURITY (assessment H1): comment author name and body are DB-sourced;
    // always escape before interpolating into innerHTML.
    const commentsHtml = wComments.slice(-3).map(c => {
      const cp = allProfiles.find(pr => pr.id === c.profile_id);
      return `<div class="sf-comment">
        <span class="sf-comment-name">${escapeHTML(cp?.name || 'Okänd')}</span>
        <span class="sf-comment-text">${escapeHTML(c.text)}</span>
      </div>`;
    }).join('');

    // Reaction buttons: own workouts get a static read-only count, others
    // get clickable like/dislike. Comment toggle opens the comments panel.
    const likeActive = myReaction?.reaction === 'like' ? ' active' : '';
    const dislikeActive = myReaction?.reaction === 'dislike' ? ' active' : '';
    const reactBtns = isOwnWorkout
      ? `<span class="react-btn-sm react-btn-static" title="Du kan inte reagera p\u00e5 ditt eget pass">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>
          ${wLikes.length > 0 ? wLikes.length : ''}
        </span>
        <span class="react-btn-sm react-btn-static">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14"><path d="M10 15V19a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z"/><path d="M17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg>
          ${wDislikes.length > 0 ? wDislikes.length : ''}
        </span>`
      : `<button class="react-btn-sm${likeActive}" data-react-btn="like" onclick="event.stopPropagation();handleFeedReaction('${escapeHTML(w.id)}','like')" title="Bra pass">
          <svg viewBox="0 0 24 24" fill="${myReaction?.reaction === 'like' ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.5" width="14" height="14"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>
          <span class="react-count" data-react-count data-count="${wLikes.length}">${wLikes.length > 0 ? wLikes.length : ''}</span>
        </button>
        <button class="react-btn-sm${dislikeActive}" data-react-btn="dislike" onclick="event.stopPropagation();handleFeedReaction('${escapeHTML(w.id)}','dislike')" title="Hmm \u2026">
          <svg viewBox="0 0 24 24" fill="${myReaction?.reaction === 'dislike' ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.5" width="14" height="14"><path d="M10 15V19a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z"/><path d="M17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg>
          <span class="react-count" data-react-count data-count="${wDislikes.length}">${wDislikes.length > 0 ? wDislikes.length : ''}</span>
        </button>`;

    const actionsHtml = `<div class="feed-reactions" onclick="event.stopPropagation()">
      ${reactBtns}
      <button class="react-btn-sm" onclick="event.stopPropagation();toggleSocialComments('${escapeHTML(w.id)}')" aria-label="Kommentarer">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        ${wComments.length > 0 ? wComments.length : ''}
      </button>
    </div>
    <div class="sf-comments hidden" id="sf-comments-${escapeHTML(w.id)}" onclick="event.stopPropagation()">${commentsHtml}</div>
    <div class="sf-comment-form hidden" id="sf-comment-form-${escapeHTML(w.id)}" onclick="event.stopPropagation()">
      <input type="text" placeholder="Skriv en kommentar..." onkeydown="if(event.key==='Enter')submitSocialComment('${escapeHTML(w.id)}',this)">
      <button onclick="submitSocialComment('${escapeHTML(w.id)}',this.previousElementSibling)">Skicka</button>
    </div>`;

    const headerClickAttr = isOwnWorkout
      ? ''
      : `onclick="event.stopPropagation();openFriendProfile('${escapeHTML(w.profile_id)}')"`;

    return _buildFeedCardHtml(w, {
      ownerName: name,
      ownerAvatar: avatar,
      ownerColor: color,
      cardClickAttr: '',
      cardDataAttrs: `data-workout-open-id="${escapeHTML(w.id)}" data-workout-id="${escapeHTML(w.id)}"`,
      headerClickAttr,
      actionsHtml,
    });
  }).join('');

  // Wire workout-open clicks via delegation (set up once per feedEl). This
  // avoids stringifying DB rows into inline onclick attributes and avoids
  // double-binding when new items are appended.
  if (!feedEl._workoutOpenDelegated) {
    feedEl._workoutOpenDelegated = true;
    feedEl.addEventListener('click', (ev) => {
      const node = ev.target.closest && ev.target.closest('[data-workout-open-id]');
      if (!node) return;
      const wid = node.getAttribute('data-workout-open-id');
      const wObj = (window._socialFeedWorkouts || []).find(x => x.id === wid);
      if (wObj) openWorkoutModal(wObj);
    });
  }
  // Keep a lookup of the most recently rendered workouts for the delegated
  // handler above (appended loads extend this list).
  if (append) {
    window._socialFeedWorkouts = (window._socialFeedWorkouts || []).concat(workouts);
  } else {
    window._socialFeedWorkouts = workouts.slice();
  }

  if (append) {
    feedEl.innerHTML += html;
  } else {
    feedEl.innerHTML = html;
  }

  moreBtn.classList.toggle('hidden', workouts.length < SOCIAL_FEED_PAGE_SIZE);
  requestAnimationFrame(() => { initSocialFeedMaps(); });
}

async function loadMoreSocialFeed() {
  _socialFeedPage++;
  await renderSocialFeed(true);
}

// Kept as a thin wrapper so legacy callers still work; routes through the
// optimistic handler so the like is reflected on the same frame.
function toggleSocialReaction(workoutId, reactionType) {
  handleFeedReaction(workoutId, reactionType);
}

async function refreshSocialFeedReactionButtons(workoutId) {
  const reactions = await fetchReactions(workoutId);
  const likes = reactions.filter(r => r.reaction === 'like');
  const dislikes = reactions.filter(r => r.reaction === 'dislike');
  const myReaction = reactions.find(r => r.profile_id === currentProfile.id);

  // The social feed now renders Strava-style cards (.feed-card with the
  // workout id on data-workout-id) so the selector + button class differ
  // from the legacy .social-feed-item layout. We update both the active
  // class and the inline svg fill so it visually toggles like the rest
  // of the feed reactions across the app.
  const item = document.querySelector(`.feed-card[data-workout-id="${CSS.escape(workoutId)}"]`)
    || document.querySelector(`.social-feed-item[data-workout-id="${CSS.escape(workoutId)}"]`);
  if (!item) return;
  const actionBtns = item.querySelectorAll('.react-btn-sm, .sf-action-btn');
  actionBtns.forEach(btn => {
    const handler = btn.getAttribute('onclick') || '';
    if (handler.includes("'like'")) {
      btn.classList.toggle('active', myReaction?.reaction === 'like');
      btn.classList.toggle('liked', myReaction?.reaction === 'like');
      const svg = btn.querySelector('svg');
      if (svg) svg.setAttribute('fill', myReaction?.reaction === 'like' ? 'currentColor' : 'none');
      const countText = likes.length > 0 ? ' ' + likes.length : '';
      btn.innerHTML = '';
      if (svg) btn.appendChild(svg);
      if (countText) btn.append(countText);
    } else if (handler.includes("'dislike'")) {
      btn.classList.toggle('active', myReaction?.reaction === 'dislike');
      btn.classList.toggle('liked', myReaction?.reaction === 'dislike');
      const svg = btn.querySelector('svg');
      if (svg) svg.setAttribute('fill', myReaction?.reaction === 'dislike' ? 'currentColor' : 'none');
      const countText = dislikes.length > 0 ? ' ' + dislikes.length : '';
      btn.innerHTML = '';
      if (svg) btn.appendChild(svg);
      if (countText) btn.append(countText);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════
//  FRIEND PROFILE PAGE
// ═══════════════════════════════════════════════════════════════════

let _currentFriendProfileId = null;

function openFriendProfile(profileId) {
  if (!profileId) return;
  navigate('friend-profile', profileId);
}

async function loadFriendProfile(profileId) {
  _currentFriendProfileId = profileId;

  // Elements — reset to loading state.
  const titleEl = document.getElementById('fp-title');
  const avatarEl = document.getElementById('fp-avatar');
  const nameEl = document.getElementById('fp-name');
  const metaEl = document.getElementById('fp-meta');
  const actionsEl = document.getElementById('fp-identity-actions');
  const stats4wEl = document.getElementById('fp-stats-4w');
  const statsSeasonEl = document.getElementById('fp-stats-season');
  const recentEl = document.getElementById('fp-recent-workouts');
  const prsEl = document.getElementById('fp-prs');

  nameEl.textContent = 'Laddar...';
  metaEl.textContent = '';
  actionsEl.innerHTML = '';
  stats4wEl.innerHTML = '<div class="fp-loading">Hämtar...</div>';
  statsSeasonEl.innerHTML = '';
  recentEl.innerHTML = '';
  prsEl.innerHTML = '';

  // If this is the current user, just send them to their own dashboard.
  if (currentProfile && profileId === currentProfile.id) {
    navigate('dashboard');
    return;
  }

  try {
    // Make sure we have the profile in allProfiles; if not, refresh.
    let profile = allProfiles.find(p => p.id === profileId);
    if (!profile) {
      await refreshAllProfiles();
      profile = allProfiles.find(p => p.id === profileId);
    }
    if (!profile) {
      nameEl.textContent = 'Profilen är inte synlig';
      metaEl.textContent = 'Ni måste vara vänner eller i samma grupp.';
      return;
    }

    // Header.
    const isEmoji = profile.avatar && profile.avatar.length <= 2;
    avatarEl.textContent = profile.avatar || (profile.name || '?')[0].toUpperCase();
    avatarEl.style.background = isEmoji ? 'transparent' : (profile.color || '#2E86C1');
    avatarEl.style.fontSize = isEmoji ? '2rem' : '1.2rem';
    nameEl.textContent = profile.name || 'Okänd';
    titleEl.textContent = profile.name || 'Profil';

    // Friendship status + action.
    const { data: friendships } = await sb.from('friendships')
      .select('*')
      .or(`and(requester_id.eq.${currentProfile.id},receiver_id.eq.${profileId}),and(requester_id.eq.${profileId},receiver_id.eq.${currentProfile.id})`);
    const friendship = (friendships || [])[0];
    let friendStatusLabel = '';
    if (friendship?.status === 'accepted') {
      friendStatusLabel = 'Vän';
      actionsEl.innerHTML = `<button class="btn btn-sm btn-ghost" onclick="removeFriendFromProfile('${escapeHTML(profileId)}')">Ta bort vän</button>`;
    } else if (friendship?.status === 'pending') {
      friendStatusLabel = friendship.requester_id === currentProfile.id ? 'Förfrågan skickad' : 'Vill vara vän';
      if (friendship.receiver_id === currentProfile.id) {
        actionsEl.innerHTML = `<button class="btn btn-sm btn-primary" onclick="acceptFriendRequestFromProfile('${escapeHTML(friendship.id)}','${escapeHTML(profileId)}')">Acceptera</button>`;
      }
    } else {
      actionsEl.innerHTML = `<button class="btn btn-sm btn-primary" onclick="sendFriendRequestFromProfile('${escapeHTML(profileId)}')">Lägg till som vän</button>`;
    }

    const metaParts = [];
    if (friendStatusLabel) metaParts.push(friendStatusLabel);
    if (profile.group_id) {
      const { data: grp } = await sb.from('groups').select('name').eq('id', profile.group_id).maybeSingle();
      if (grp?.name) metaParts.push('Grupp: ' + grp.name);
    }
    metaEl.textContent = metaParts.join(' · ');

    // Fetch workouts (RLS will only return what this user is allowed to see).
    const today = new Date();
    const fourWeeksAgo = new Date(); fourWeeksAgo.setDate(today.getDate() - 28);
    const yearStart = new Date(today.getFullYear(), 0, 1);

    const [recentWorkouts, seasonWorkouts] = await Promise.all([
      fetchWorkouts(profileId, isoDate(fourWeeksAgo), isoDate(today)),
      fetchWorkouts(profileId, isoDate(yearStart), isoDate(today)),
    ]);

    // 4-week stats.
    stats4wEl.innerHTML = renderFpStats(recentWorkouts, 4);

    // Season stats.
    statsSeasonEl.innerHTML = renderFpStats(seasonWorkouts, null);

    // Recent workouts list (most recent 20).
    const recentSorted = [...seasonWorkouts].sort((a, b) => b.workout_date.localeCompare(a.workout_date)).slice(0, 20);
    if (recentSorted.length === 0) {
      recentEl.innerHTML = '<div class="empty-state"><p>Inga loggade pass att visa.</p></div>';
    } else {
      recentEl.innerHTML = recentSorted.map(w => {
        const wDate = new Date(w.workout_date).toLocaleDateString('sv-SE', { weekday: 'short', day: 'numeric', month: 'short' });
        const intBadge = w.intensity ? ` <span class="intensity-badge">${escapeHTML(w.intensity)}</span>` : '';
        return `<div class="fp-workout-row" data-workout-open-id="${escapeHTML(w.id)}" style="cursor:pointer;">
          <span class="fp-workout-icon">${activityEmoji(w.activity_type)}</span>
          <div class="fp-workout-body">
            <div class="fp-workout-title">${escapeHTML(w.activity_type)} · ${w.duration_minutes} min${w.distance_km ? ' · ' + w.distance_km + ' km' : ''}${intBadge}</div>
            <div class="fp-workout-date">${escapeHTML(wDate)}</div>
          </div>
        </div>`;
      }).join('');

      // Delegation for opening workout modal.
      recentEl.onclick = (ev) => {
        const node = ev.target.closest && ev.target.closest('[data-workout-open-id]');
        if (!node) return;
        const wid = node.getAttribute('data-workout-open-id');
        const wObj = recentSorted.find(x => x.id === wid);
        if (wObj) openWorkoutModal(wObj);
      };
    }

    // Personal records (best 5k, 10k, longest run).
    prsEl.innerHTML = renderFpPRs(seasonWorkouts);

  } catch (e) {
    console.error('loadFriendProfile error:', e);
    nameEl.textContent = 'Kunde inte ladda profilen';
    metaEl.textContent = '';
  }
}

function renderFpStats(workouts, weeks) {
  const totalSessions = workouts.length;
  const totalMin = workouts.reduce((s, w) => s + (w.duration_minutes || 0), 0);
  const totalKm = workouts.reduce((s, w) => s + (w.distance_km || 0), 0);
  const elevSum = workouts.reduce((s, w) => s + (w.elevation_gain_m || 0), 0);
  const hoursStr = (totalMin / 60).toFixed(1);
  const kmStr = totalKm > 0 ? totalKm.toFixed(1) : '—';
  const avgPerWeek = weeks ? (totalSessions / weeks).toFixed(1) : null;

  const items = [
    { label: 'Pass', value: totalSessions },
    { label: 'Timmar', value: hoursStr },
    { label: 'Kilometer', value: kmStr },
    { label: 'Höjdmeter', value: elevSum > 0 ? Math.round(elevSum) + ' m' : '—' },
  ];
  if (avgPerWeek !== null) items.unshift({ label: 'Pass/v', value: avgPerWeek });

  return items.map(it => `<div class="fp-stat">
    <div class="fp-stat-value">${escapeHTML(String(it.value))}</div>
    <div class="fp-stat-label">${escapeHTML(it.label)}</div>
  </div>`).join('');
}

function renderFpPRs(workouts) {
  const runs = workouts.filter(w => w.activity_type === 'Löpning' && w.duration_minutes > 0 && w.distance_km > 0);
  if (runs.length === 0) return '<div class="empty-state"><p>Inga löppass att räkna rekord från ännu.</p></div>';

  // Best paces for distances within tolerance.
  const byDist = (target, tol) => {
    const candidates = runs.filter(w => Math.abs(w.distance_km - target) <= tol);
    if (!candidates.length) return null;
    return candidates.reduce((best, w) => (w.duration_minutes < best.duration_minutes ? w : best));
  };

  const best5k = byDist(5, 0.5);
  const best10k = byDist(10, 0.8);
  const longest = runs.reduce((best, w) => (w.distance_km > (best?.distance_km || 0) ? w : best), null);

  const fmtTime = (minutes) => {
    const h = Math.floor(minutes / 60);
    const m = Math.floor(minutes % 60);
    const s = Math.round((minutes - Math.floor(minutes)) * 60);
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  };

  const rows = [];
  if (best5k) rows.push({ label: 'Bästa 5 km', value: fmtTime(best5k.duration_minutes), date: best5k.workout_date });
  if (best10k) rows.push({ label: 'Bästa 10 km', value: fmtTime(best10k.duration_minutes), date: best10k.workout_date });
  if (longest) rows.push({ label: 'Längsta löppass', value: longest.distance_km.toFixed(1) + ' km', date: longest.workout_date });

  if (!rows.length) return '<div class="empty-state"><p>Inga rekord att visa ännu.</p></div>';

  return rows.map(r => `<div class="fp-pr-row">
    <div class="fp-pr-label">${escapeHTML(r.label)}</div>
    <div class="fp-pr-value">${escapeHTML(r.value)}</div>
    <div class="fp-pr-date">${escapeHTML(formatDate(r.date))}</div>
  </div>`).join('');
}

async function sendFriendRequestFromProfile(profileId) {
  try {
    await sb.from('friendships').insert({
      requester_id: currentProfile.id,
      receiver_id: profileId,
      status: 'pending',
    });
    await loadFriendProfile(profileId);
  } catch (e) {
    console.error('sendFriendRequestFromProfile error:', e);
    await showAlertModal('Fel', 'Kunde inte skicka vänförfrågan.');
  }
}

async function acceptFriendRequestFromProfile(friendshipId, profileId) {
  try {
    await sb.from('friendships').update({ status: 'accepted' }).eq('id', friendshipId);
    await loadFriendProfile(profileId);
  } catch (e) {
    console.error('acceptFriendRequestFromProfile error:', e);
  }
}

async function removeFriendFromProfile(profileId) {
  const ok = await showConfirmModal('Ta bort vän', 'Vill du ta bort denna vän?', 'Ta bort', true);
  if (!ok) return;
  try {
    await sb.from('friendships')
      .delete()
      .or(`and(requester_id.eq.${currentProfile.id},receiver_id.eq.${profileId}),and(requester_id.eq.${profileId},receiver_id.eq.${currentProfile.id})`);
    await loadFriendProfile(profileId);
  } catch (e) {
    console.error('removeFriendFromProfile error:', e);
  }
}

function toggleSocialComments(workoutId) {
  const commentsEl = document.getElementById('sf-comments-' + workoutId);
  const formEl = document.getElementById('sf-comment-form-' + workoutId);
  const isHidden = commentsEl.classList.contains('hidden');
  commentsEl.classList.toggle('hidden', !isHidden);
  formEl.classList.toggle('hidden', !isHidden);
  if (!isHidden) return;
  formEl.querySelector('input').focus();
}

async function submitSocialComment(workoutId, input) {
  const text = input.value.trim();
  if (!text) return;
  try {
    await sb.from('workout_comments').insert({
      workout_id: workoutId,
      profile_id: currentProfile.id,
      text: text,
    });
    input.value = '';

    const { data: comments } = await sb.from('workout_comments')
      .select('*')
      .eq('workout_id', workoutId)
      .order('created_at', { ascending: true });

    const commentsEl = document.getElementById('sf-comments-' + workoutId);
    commentsEl.innerHTML = (comments || []).slice(-5).map(c => {
      const cp = allProfiles.find(pr => pr.id === c.profile_id);
      return `<div class="sf-comment">
        <span class="sf-comment-name">${escapeHTML(cp?.name || 'Okänd')}</span>
        <span class="sf-comment-text">${escapeHTML(c.text)}</span>
      </div>`;
    }).join('');

    // Social feed now wraps everything in `.feed-card`; fall back to the
    // legacy `.social-feed-item` so old screens (if any) still work.
    const card = commentsEl.closest('.feed-card') || commentsEl.closest('.social-feed-item');
    const commentBtn = card?.querySelector('.feed-reactions .react-btn-sm:last-of-type, .sf-actions .sf-action-btn:nth-child(2)');
    if (commentBtn) {
      const svg = commentBtn.querySelector('svg');
      commentBtn.innerHTML = '';
      if (svg) commentBtn.appendChild(svg);
      commentBtn.append(' ' + (comments || []).length);
    }
  } catch (e) {
    console.error('Submit comment error:', e);
  }
}

// MOD-02: Escape stänger översta överlägg; fokus åter till utlösare där det stöds (t.ex. workout-modal).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const sideMenu = document.getElementById('side-menu');
  if (sideMenu && sideMenu.classList.contains('open')) {
    closeSideMenu();
    e.preventDefault();
    return;
  }
  const confirmEl = document.getElementById('confirm-modal');
  if (confirmEl && !confirmEl.classList.contains('hidden')) {
    closeConfirmModal(false);
    e.preventDefault();
    return;
  }
  const chain = [
    ['workout-modal', closeWorkoutModal],
    ['member-profile-modal', closeMemberProfile],
    ['friends-modal', closeFriendsModal],
    ['coach-checkin-modal', closeCoachCheckin],
    ['plan-edit-modal', closePlanEditModal],
    ['plan-manager', closePlanManager],
    ['plan-wizard', closePlanWizard],
    ['invite-picker', closeInvitePicker],
    ['plan-modal', closePlanModal],
  ];
  for (const [id, fn] of chain) {
    const el = document.getElementById(id);
    if (el && !el.classList.contains('hidden')) {
      fn();
      e.preventDefault();
      return;
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  Weekly Coach Check-In
// ═══════════════════════════════════════════════════════════════════════════

const CC_STEP_IDS = [0, 1, 2, 3, 4];

let _ccState = null;        // active wizard state
let _ccCheckin = null;      // response from propose (checkin_id, changes, coach_note, ...)
let _ccBusy = false;

function _ccReviewMonday(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const dow = (d.getDay() + 6) % 7; // Mon=0..Sun=6
  if (dow === 6) {
    // Sunday — review the current ISO week (week_not_yet_closed on server)
    d.setDate(d.getDate() - 6);
    return d;
  }
  // Mon–Sat → previous Monday
  d.setDate(d.getDate() - dow - 7);
  return d;
}

async function updateCoachCheckinBanner() {
  const banner = document.getElementById('coach-checkin-banner');
  if (!banner) return;
  banner.classList.add('hidden');

  if (!currentProfile || !_activePlan) return;
  // Feature flag: when chat-based check-in is enabled, the Sunday wizard is
  // replaced by a proactive coach nudge, so the legacy banner/modal is hidden.
  if (currentProfile.coach_checkin_chat_enabled) return;

  const now = new Date();
  const dow = (now.getDay() + 6) % 7;
  // Sun (6), Mon (0), Tue (1)
  const inWindow = dow === 6 || dow === 0 || dow === 1;
  if (!inWindow) return;

  const reviewMon = _ccReviewMonday(now);
  const weekStartISO = isoDate(reviewMon);

  try {
    const { data } = await sb.from('weekly_checkins')
      .select('id, status')
      .eq('profile_id', currentProfile.id)
      .eq('week_start_date', weekStartISO)
      .maybeSingle();
    if (data && (data.status === 'applied' || data.status === 'declined')) {
      return; // already handled this week
    }
    // pending or null → show banner. If pending, user can resume to the diff.
    const titleEl = banner.querySelector('.cc-banner-title');
    if (data && data.status === 'pending') {
      titleEl.textContent = 'Fortsätt veckoavstämningen';
      banner.dataset.resume = data.id;
    } else {
      titleEl.textContent = 'Dags för veckoavstämning med coachen';
      delete banner.dataset.resume;
    }
    banner.classList.remove('hidden');
  } catch (_e) {
    // Fail silently — banner stays hidden.
  }
}

async function openCoachCheckin() {
  if (!_activePlan) {
    alert('Veckoavstämningen kräver en aktiv AI-plan. Skapa en plan först.');
    return;
  }
  // When the chat-based check-in is enabled, route the user into the coach
  // view instead of the legacy modal so they can answer conversationally.
  if (currentProfile?.coach_checkin_chat_enabled) {
    if (typeof navigate === 'function') navigate('coach');
    return;
  }

  const banner = document.getElementById('coach-checkin-banner');
  const resumeId = banner?.dataset?.resume;

  _ccState = {
    step: 0,
    overall_feel: null,
    injury_level: null,
    injury_note: '',
    injury_side: null,
    hardest_session_feel: null,
    long_run_feel: null,
    unavailable_days: [],
    next_week_context: '',
    free_text: '',
    hasQuality: false,
    hasLongRun: false,
  };
  _ccCheckin = null;
  _ccBusy = false;

  // Reset DOM state
  document.querySelectorAll('#coach-checkin-modal .cc-feel-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('#coach-checkin-modal .cc-injury-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('#coach-checkin-modal .cc-option-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('#coach-checkin-modal .intensity-pill').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('#cc-unavail-days .wiz-day-btn').forEach(b => b.classList.remove('active'));
  const noteEl = document.getElementById('cc-injury-note'); if (noteEl) noteEl.value = '';
  const ctxEl = document.getElementById('cc-next-context'); if (ctxEl) ctxEl.value = '';
  const ftEl = document.getElementById('cc-free-text'); if (ftEl) ftEl.value = '';
  document.getElementById('cc-injury-details').classList.add('hidden');
  document.getElementById('cc-step-loading').style.display = 'none';
  document.getElementById('cc-step-diff').style.display = 'none';
  document.getElementById('cc-step-done').style.display = 'none';

  _ccWireHandlers();

  // Precompute whether last week had a quality session / long run so we can skip steps.
  try {
    const reviewMon = _ccReviewMonday(new Date());
    const weekEnd = addDays(reviewMon, 6);
    const pws = await fetchPlanWorkoutsByDate(_activePlan.id, isoDate(reviewMon), isoDate(weekEnd));
    _ccState.hasQuality = pws.some(w => !w.is_rest && (
      ['Z4', 'Z5', 'mixed'].includes(w.intensity_zone) ||
      /tröskel|tempo|vo2|interval|fartlek|kvalitet/i.test(w.label || '')
    ));
    const runs = pws.filter(w => w.activity_type === 'Löpning' && !w.is_rest);
    const explicitLong = runs.find(w => /långpass|long run/i.test(w.label || ''));
    const longest = runs.sort((a, b) => (b.target_duration_minutes || 0) - (a.target_duration_minutes || 0))[0];
    _ccState.hasLongRun = !!explicitLong || (longest && (longest.target_duration_minutes || 0) >= 60);
  } catch (_e) { /* ignore */ }

  document.getElementById('coach-checkin-modal').classList.remove('hidden');

  if (resumeId) {
    // Jump straight to the diff using the stored pending row.
    await _ccResumePending(resumeId);
  } else {
    _ccGoToStep(0);
  }
}

function closeCoachCheckin() {
  document.getElementById('coach-checkin-modal').classList.add('hidden');
  _ccState = null;
  _ccCheckin = null;
}

function _ccWireHandlers() {
  document.querySelectorAll('#cc-feel-grid .cc-feel-btn').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('#cc-feel-grid .cc-feel-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _ccState.overall_feel = parseInt(btn.dataset.value);
    };
  });
  document.querySelectorAll('#cc-injury-grid .cc-injury-btn').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('#cc-injury-grid .cc-injury-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _ccState.injury_level = btn.dataset.value;
      const needDetail = (_ccState.injury_level === 'niggle' || _ccState.injury_level === 'pain');
      document.getElementById('cc-injury-details').classList.toggle('hidden', !needDetail);
    };
  });
  document.querySelectorAll('#cc-injury-side .intensity-pill').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('#cc-injury-side .intensity-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _ccState.injury_side = btn.dataset.value;
    };
  });
  document.querySelectorAll('#cc-hardest-grid .cc-option-btn').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('#cc-hardest-grid .cc-option-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _ccState.hardest_session_feel = btn.dataset.value;
    };
  });
  document.querySelectorAll('#cc-longrun-grid .cc-option-btn').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('#cc-longrun-grid .cc-option-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _ccState.long_run_feel = btn.dataset.value;
    };
  });
  document.querySelectorAll('#cc-unavail-days .wiz-day-btn').forEach(btn => {
    btn.onclick = () => {
      btn.classList.toggle('active');
      const d = parseInt(btn.dataset.day);
      const set = new Set(_ccState.unavailable_days);
      if (btn.classList.contains('active')) set.add(d); else set.delete(d);
      _ccState.unavailable_days = [...set].sort();
    };
  });
}

function _ccVisibleSteps() {
  // Injury=paused short-circuits: skip hardest + long run (no point, it's a recovery week).
  const skipDetail = _ccState.injury_level === 'paused';
  return CC_STEP_IDS.filter(s => {
    if (s === 2) return _ccState.hasQuality && !skipDetail;
    if (s === 3) return _ccState.hasLongRun && !skipDetail;
    return true;
  });
}

function _ccGoToStep(target) {
  _ccState.step = target;
  const visible = _ccVisibleSteps();
  const idx = visible.indexOf(target);
  const total = visible.length;

  document.querySelectorAll('#coach-checkin-modal .cc-step').forEach(el => el.classList.remove('active'));
  const current = document.querySelector(`#coach-checkin-modal .cc-step[data-step="${target}"]`);
  if (current) current.classList.add('active');

  const banner = document.getElementById('cc-step-banner');
  banner.textContent = `Steg ${idx + 1} av ${total}`;

  const progress = document.getElementById('cc-progress');
  progress.innerHTML = visible.map((_s, i) => {
    const cls = i < idx ? 'wizard-step-dot done' : i === idx ? 'wizard-step-dot active' : 'wizard-step-dot';
    const dot = `<div class="${cls}"></div>`;
    if (i < visible.length - 1) return dot + '<div class="wizard-step-line"></div>';
    return dot;
  }).join('');

  const prev = document.getElementById('cc-prev');
  prev.style.visibility = idx === 0 ? 'hidden' : 'visible';
  const next = document.getElementById('cc-next');
  next.textContent = idx === total - 1 ? 'Skicka till coachen' : 'Nästa';
}

function ccStepPrev() {
  if (!_ccState) return;
  const visible = _ccVisibleSteps();
  const idx = visible.indexOf(_ccState.step);
  if (idx > 0) _ccGoToStep(visible[idx - 1]);
}

async function ccStepNext() {
  if (!_ccState || _ccBusy) return;
  // Validate current step
  const s = _ccState.step;
  if (s === 0 && _ccState.overall_feel == null) { alert('Välj hur veckan kändes.'); return; }
  if (s === 1 && !_ccState.injury_level) { alert('Välj skadeläge.'); return; }

  if (s === 4) {
    _ccState.next_week_context = (document.getElementById('cc-next-context').value || '').trim();
    _ccState.free_text = (document.getElementById('cc-free-text').value || '').trim();
    _ccState.injury_note = (document.getElementById('cc-injury-note').value || '').trim();
    await _ccSubmitCheckin();
    return;
  }

  const visible = _ccVisibleSteps();
  const idx = visible.indexOf(s);
  if (idx < visible.length - 1) _ccGoToStep(visible[idx + 1]);
}

async function _ccSubmitCheckin() {
  _ccBusy = true;
  document.querySelectorAll('#coach-checkin-modal .cc-step').forEach(el => {
    if (el.id !== 'cc-step-loading') el.classList.remove('active');
    el.style.display = el.id === 'cc-step-loading' ? 'block' : '';
  });
  document.getElementById('cc-step-loading').style.display = 'block';
  document.getElementById('cc-nav').style.display = 'none';
  document.getElementById('cc-progress').innerHTML = '';
  document.getElementById('cc-step-banner').textContent = 'Coachen tittar på veckan...';

  try {
    const session = (await sb.auth.getSession()).data.session;
    const res = await fetch(SUPABASE_FUNCTIONS_URL + '/weekly-checkin', {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + session.access_token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        mode: 'propose',
        responses: {
          overall_feel: _ccState.overall_feel,
          injury_level: _ccState.injury_level,
          injury_note: _ccState.injury_note || undefined,
          injury_side: _ccState.injury_side || undefined,
          hardest_session_feel: _ccState.hardest_session_feel || undefined,
          long_run_feel: _ccState.long_run_feel || undefined,
          unavailable_days: _ccState.unavailable_days,
          next_week_context: _ccState.next_week_context || undefined,
          free_text: _ccState.free_text || undefined,
        },
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Check-in misslyckades');

    _ccCheckin = data;
    _ccRenderDiff();
  } catch (e) {
    document.getElementById('cc-step-loading').style.display = 'none';
    document.getElementById('cc-nav').style.display = '';
    document.getElementById('cc-step-banner').textContent = 'Något gick fel';
    alert('Kunde inte hämta coachens förslag: ' + e.message);
  } finally {
    _ccBusy = false;
  }
}

async function _ccResumePending(checkinId) {
  document.getElementById('cc-step-loading').style.display = 'block';
  document.getElementById('cc-nav').style.display = 'none';
  document.getElementById('cc-progress').innerHTML = '';
  document.getElementById('cc-step-banner').textContent = 'Hämtar din avstämning...';
  try {
    const { data, error } = await sb.from('weekly_checkins')
      .select('id, proposed_changes, coach_note, objective_summary')
      .eq('id', checkinId)
      .single();
    if (error || !data) throw new Error('Hittade inte avstämningen');
    _ccCheckin = {
      checkin_id: data.id,
      changes: data.proposed_changes || [],
      coach_note: data.coach_note || '',
      summary: {
        next_week_phase: data.objective_summary?.next_week_phase || null,
        acwr: data.objective_summary?.acwr,
        acwr_band: data.objective_summary?.acwr_band,
      },
    };
    _ccRenderDiff();
  } catch (e) {
    alert('Kunde inte återuppta avstämningen: ' + e.message);
    closeCoachCheckin();
  }
}

function _ccRenderDiff() {
  document.getElementById('cc-step-loading').style.display = 'none';
  document.getElementById('cc-step-banner').textContent = 'Coachens förslag';
  document.getElementById('cc-progress').innerHTML = '';

  const diffEl = document.getElementById('cc-step-diff');
  diffEl.style.display = 'block';
  document.getElementById('cc-coach-note').textContent = _ccCheckin.coach_note || '';

  _ccRenderHorizonPanel(_ccCheckin);

  const listEl = document.getElementById('cc-diff-list');
  const emptyEl = document.getElementById('cc-diff-empty');
  const changes = _ccCheckin.changes || [];

  if (changes.length === 0) {
    listEl.innerHTML = '';
    emptyEl.classList.remove('hidden');
  } else {
    emptyEl.classList.add('hidden');
    const dayNames = ['Mån', 'Tis', 'Ons', 'Tors', 'Fre', 'Lör', 'Sön'];
    listEl.innerHTML = changes.map(c => {
      const cur = c.current_workout || {};
      const prop = c.proposed_workout || {};
      const isMove = c.action === 'move_session';
      const dayLabel = isMove
        ? `${dayNames[c.from_day] || ''} → ${dayNames[c.to_day] || ''}`
        : (dayNames[c.day_of_week] || '');
      const curLabel = cur.is_rest ? 'Vila' : `${cur.label || cur.activity_type || ''} ${cur.target_duration_minutes ? cur.target_duration_minutes + ' min' : ''}`.trim();
      const curZone = cur.intensity_zone ? `<span class="zone-badge zone-${escapeHTML(cur.intensity_zone)}">${escapeHTML(cur.intensity_zone)}</span>` : '';
      const propLabel = prop.is_rest ? 'Vila' : `${prop.label || prop.activity_type || ''} ${prop.target_duration_minutes ? prop.target_duration_minutes + ' min' : ''}`.trim();
      const propZone = prop.intensity_zone ? `<span class="zone-badge zone-${escapeHTML(prop.intensity_zone)}">${escapeHTML(prop.intensity_zone)}</span>` : '';
      return `
        <label class="cc-diff-card" data-change-id="${escapeHTML(c.id)}">
          <input type="checkbox" class="cc-diff-check" checked>
          <div class="cc-diff-body">
            <div class="cc-diff-day">${escapeHTML(dayLabel)}</div>
            <div class="cc-diff-flow">
              <div class="cc-diff-current"><span class="cc-diff-label">${escapeHTML(curLabel)}</span>${curZone}</div>
              <div class="cc-diff-arrow" aria-hidden="true">↓</div>
              <div class="cc-diff-proposed"><span class="cc-diff-label">${escapeHTML(propLabel)}</span>${propZone}</div>
            </div>
            <div class="cc-diff-reason">${escapeHTML(c.reason_sv || '')}</div>
          </div>
        </label>`;
    }).join('');
  }

  const navEl = document.getElementById('cc-nav');
  navEl.style.display = '';
  navEl.innerHTML = changes.length === 0
    ? `<button class="btn btn-primary btn-sm" onclick="_ccDeclineAll()">Klart</button>`
    : `<button class="btn btn-ghost btn-sm" onclick="_ccDeclineAll()">Neka allt</button>
       <button class="btn btn-primary btn-sm" onclick="_ccAcceptSelected()">Acceptera markerade</button>`;
}

// Render the horizon-regen panel above the per-day diff list. The check-in
// edge function returns horizon information when a *hard* trigger fired
// (assessment week completed, new baseline) or a *soft* trigger upgraded
// to "regenerate the next 2-4 weeks". Shape (best-effort):
//   _ccCheckin.horizon = {
//     reason: 'assessment_completed' | 'soft_trigger' | ...,
//     headline: 'Tröskelpuls upp 4 bpm — Z3/Z4-zoner kalibreras',
//     bullets: ['Långpasset upp till 90 min', 'Z4 nu 168 bpm (var 164)', ...],
//     baseline?: { fiveK?: ..., thresholdHr?: ... },
//     weeks_replanned?: 3,
//   }
function _ccRenderHorizonPanel(checkin) {
  const panel = document.getElementById('cc-horizon-panel');
  if (!panel) return;
  const horizon = checkin?.horizon;
  if (!horizon || (typeof horizon !== 'object')) {
    panel.classList.add('hidden');
    return;
  }
  const titleEl = document.getElementById('cc-horizon-title');
  const subEl = document.getElementById('cc-horizon-sub');
  const bulletsEl = document.getElementById('cc-horizon-bullets');

  const reasonLabel = horizon.reason === 'assessment_completed'
    ? 'Bedömningsvecka klar — coachen har räknat om kommande veckor'
    : (horizon.reason === 'soft_trigger'
        ? 'Mycket har förändrats — coachen har räknat om horisonten'
        : 'Coachen har räknat om kommande veckor');
  if (titleEl) titleEl.textContent = horizon.headline ? reasonLabel : reasonLabel;

  const subBits = [];
  if (horizon.headline) subBits.push(horizon.headline);
  if (horizon.weeks_replanned) subBits.push(`${horizon.weeks_replanned} v omplanerade`);
  if (subEl) subEl.textContent = subBits.join(' · ');

  if (bulletsEl) {
    const bullets = Array.isArray(horizon.bullets) ? horizon.bullets : [];
    bulletsEl.innerHTML = bullets.length
      ? bullets.map(b => `<li>${escapeHTML(String(b))}</li>`).join('')
      : '';
  }
  panel.classList.remove('hidden');
}

async function _ccAcceptSelected() {
  if (!_ccCheckin) return;
  const ids = [...document.querySelectorAll('#cc-diff-list .cc-diff-card')]
    .filter(el => el.querySelector('.cc-diff-check')?.checked)
    .map(el => el.dataset.changeId);

  if (ids.length === 0) {
    if (!confirm('Inga ändringar markerade — vill du neka allt?')) return;
    return _ccDeclineAll();
  }

  await _ccPostAction('apply', { checkin_id: _ccCheckin.checkin_id, accepted_change_ids: ids },
    ids.length === (_ccCheckin.changes?.length || 0)
      ? 'Schemat uppdaterat — lycka till nästa vecka!'
      : `${ids.length} av ${_ccCheckin.changes.length} ändringar sparade.`);
}

async function _ccDeclineAll() {
  if (!_ccCheckin) return;
  const hadChanges = (_ccCheckin.changes || []).length > 0;
  await _ccPostAction('decline', { checkin_id: _ccCheckin.checkin_id },
    hadChanges ? 'Inga ändringar — kör på originalschemat.' : 'Klart — tack för avstämningen.');
}

async function _ccPostAction(mode, body, doneMsg) {
  const navEl = document.getElementById('cc-nav');
  navEl.querySelectorAll('button').forEach(b => b.disabled = true);
  try {
    const session = (await sb.auth.getSession()).data.session;
    const res = await fetch(SUPABASE_FUNCTIONS_URL + '/weekly-checkin', {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + session.access_token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ mode, ...body }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Misslyckades');

    document.getElementById('cc-step-diff').style.display = 'none';
    document.getElementById('cc-step-done').style.display = 'block';
    document.getElementById('cc-done-text').textContent = doneMsg;
    document.getElementById('cc-step-banner').textContent = 'Klart';
    navEl.innerHTML = `<button class="btn btn-primary btn-sm" onclick="closeCoachCheckin()">Stäng</button>`;

    // Refresh schema to show updates.
    if (mode === 'apply') {
      try { await loadSchema(); } catch (_e) { /* ignore */ }
    } else {
      try { await updateCoachCheckinBanner(); } catch (_e) { /* ignore */ }
    }
  } catch (e) {
    alert('Något gick fel: ' + e.message);
    navEl.querySelectorAll('button').forEach(b => b.disabled = false);
  }
}

// ── Trends view: weekly check-in history strip ──────────────────────────────

async function renderWeeklyCheckinHistory(containerEl) {
  if (!containerEl || !currentProfile) return;
  try {
    const { data } = await sb.from('weekly_checkins')
      .select('id, week_start_date, status, responses, coach_note, proposed_changes, applied_changes')
      .eq('profile_id', currentProfile.id)
      .order('week_start_date', { ascending: false })
      .limit(8);
    const rows = data || [];
    if (rows.length === 0) { containerEl.innerHTML = ''; return; }

    const feelLabel = { 1: 'Helt slut', 2: 'Tungt', 3: 'OK', 4: 'Bra', 5: 'Superkänsla' };
    const injuryLabel = { none: 'Inga skador', niggle: 'Småkänning', pain: 'Värk', paused: 'Pausar' };

    const items = rows.map(r => {
      const feel = r.responses?.overall_feel;
      const inj = r.responses?.injury_level || 'none';
      const feelTxt = feelLabel[feel] || '—';
      const injTxt = injuryLabel[inj] || inj;
      const applied = Array.isArray(r.applied_changes) ? r.applied_changes.length : 0;
      const proposed = Array.isArray(r.proposed_changes) ? r.proposed_changes.length : 0;
      const statusPill = r.status === 'applied'
        ? `<span class="cc-hist-pill cc-hist-pill--applied">${applied}/${proposed} sparade</span>`
        : r.status === 'declined'
          ? `<span class="cc-hist-pill cc-hist-pill--declined">Nekade</span>`
          : `<span class="cc-hist-pill">Väntar</span>`;
      const weekLabel = new Date(r.week_start_date).toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' });
      const note = escapeHTML(r.coach_note || '');
      return `<details class="cc-hist-item">
        <summary>
          <span class="cc-hist-week">V. ${weekLabel}</span>
          <span class="cc-hist-meta">${escapeHTML(feelTxt)} · ${escapeHTML(injTxt)}</span>
          ${statusPill}
        </summary>
        ${note ? `<div class="cc-hist-note">${note}</div>` : ''}
      </details>`;
    }).join('');

    containerEl.innerHTML = `
      <details class="cc-hist-group">
        <summary class="cc-hist-group-summary">Veckoavstämningar (${rows.length})</summary>
        <div class="cc-hist-list">${items}</div>
      </details>`;
  } catch (_e) {
    containerEl.innerHTML = '';
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  COACH (chat)
//  Sprint 1: open/send via coach-chat edge function. No tool-calling yet.
// ═══════════════════════════════════════════════════════════════════════════

const _coach = {
  thread: null,
  messages: [],
  sending: false,
  loading: false,
  inputBound: false,
  abortController: null,
  readOnly: false,
  activeThreadCache: null, // { thread, messages } for restore after viewing archived
};

function _coachEndpoint() {
  return SUPABASE_URL + '/functions/v1/coach-chat';
}

async function _coachFetch(payload, opts = {}) {
  const session = await sb.auth.getSession();
  const token = session.data.session?.access_token;
  if (!token) throw new Error('not_authenticated');
  const res = await fetch(_coachEndpoint(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token,
      'apikey': SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(payload),
    signal: opts.signal,
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* ignore */ }
  if (!res.ok) {
    const msg = data?.error || ('http_' + res.status);
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data || {};
}

function _coachFormatTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
  } catch (_) {
    return '';
  }
}

function _coachFormatDateLabel(iso) {
  try {
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return 'Idag';
    const y = new Date(now); y.setDate(y.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return 'Igår';
    const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
    if (diffDays < 7) {
      return d.toLocaleDateString('sv-SE', { weekday: 'long' });
    }
    if (d.getFullYear() === now.getFullYear()) {
      return d.toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' });
    }
    return d.toLocaleDateString('sv-SE', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch (_) {
    return '';
  }
}

function _coachRelativeTime(iso) {
  try {
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 0) return 'nu';
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return 'nu';
    const min = Math.floor(sec / 60);
    if (min < 60) return min + ' min sedan';
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + ' tim sedan';
    const day = Math.floor(hr / 24);
    if (day < 7) return day + ' d sedan';
    const d = new Date(iso);
    return d.toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' });
  } catch (_) {
    return '';
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Markdown renderer for assistant copy. Safe-by-default: HTML-escape the
// raw string first, then apply a small token pass for **bold**, *italic*,
// `code`, autolinks, headers, and lists. If anything throws we fall back to
// plain escaped text with line breaks.
// ─────────────────────────────────────────────────────────────────────────
function _coachRenderMarkdown(raw) {
  if (!raw) return '';
  try {
    const escaped = escapeHTML(String(raw));
    const lines = escaped.split(/\r?\n/);
    const out = [];
    let i = 0;

    const inline = (s) => {
      let t = s;
      // Inline code first so its contents aren't touched by other rules.
      t = t.replace(/`([^`\n]+)`/g, (_, code) => `<code>${code}</code>`);
      // Bold
      t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
      // Italic (skip leading whitespace handling)
      t = t.replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s.,!?:;)])/g, '$1<em>$2</em>');
      t = t.replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s.,!?:;)])/g, '$1<em>$2</em>');
      // Autolinks for http(s) URLs not already inside an href.
      t = t.replace(/(^|[\s(])(https?:\/\/[^\s)]+)/g, (_, pre, url) => {
        return `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
      });
      return t;
    };

    while (i < lines.length) {
      const line = lines[i];

      // Skip blank lines (paragraph breaks handled by paragraph buffer below)
      if (!line.trim()) { i++; continue; }

      // Headers
      const h = line.match(/^(#{1,3})\s+(.+)$/);
      if (h) {
        const level = h[1].length;
        out.push(`<h${level}>${inline(h[2])}</h${level}>`);
        i++; continue;
      }

      // Horizontal rule
      if (/^---+\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

      // Unordered list block
      if (/^\s*[-*]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          items.push('<li>' + inline(lines[i].replace(/^\s*[-*]\s+/, '')) + '</li>');
          i++;
        }
        out.push('<ul>' + items.join('') + '</ul>');
        continue;
      }

      // Ordered list block
      if (/^\s*\d+\.\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          items.push('<li>' + inline(lines[i].replace(/^\s*\d+\.\s+/, '')) + '</li>');
          i++;
        }
        out.push('<ol>' + items.join('') + '</ol>');
        continue;
      }

      // Paragraph: collect adjacent non-special lines.
      const para = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^(#{1,3})\s+/.test(lines[i]) &&
        !/^\s*[-*]\s+/.test(lines[i]) &&
        !/^\s*\d+\.\s+/.test(lines[i]) &&
        !/^---+\s*$/.test(lines[i])
      ) {
        para.push(inline(lines[i]));
        i++;
      }
      if (para.length) out.push('<p>' + para.join('<br>') + '</p>');
    }

    return out.join('');
  } catch (_) {
    // Defensive fallback: escape + line-breaks only.
    return escapeHTML(String(raw)).replace(/\n/g, '<br>');
  }
}

const _coachAvatarSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M9 13v2"/><path d="M15 13v2"/></svg>`;

const _coachToolStatusLabels = {
  get_workout: 'Hämtar passet…',
  get_week_summary: 'Tittar på veckan…',
  propose_plan_changes: 'Förbereder förslag…',
  apply_plan_changes: 'Sparar ändringar…',
  log_workout: 'Loggar passet…',
  update_memory: 'Uppdaterar minnet…',
  predict_race_time: 'Räknar prognos…',
  start_return_to_training: 'Bygger comeback-plan…',
};

function _coachToolStatusText(toolCalls) {
  if (!Array.isArray(toolCalls) || !toolCalls.length) return null;
  const names = toolCalls
    .map(c => c && (c.name || c.tool_name))
    .filter(Boolean);
  if (!names.length) return null;
  // Prefer the most user-relevant call (proposal > write > read).
  const priority = [
    'propose_plan_changes', 'apply_plan_changes', 'start_return_to_training',
    'predict_race_time', 'log_workout', 'update_memory',
    'get_week_summary', 'get_workout',
  ];
  const pick = priority.find(p => names.includes(p)) || names[0];
  return _coachToolStatusLabels[pick] || 'Använder verktyg…';
}

// Local decisions for plan-diff cards that arrived via tool-calls. Keyed by
// diff_id so a single proposal can't be accepted twice.
const _coachDiffDecisions = new Map();

function _coachExtractDiff(m) {
  if (m.role !== 'assistant') return null;
  if (!m.tool_result || !Array.isArray(m.tool_result.calls)) return null;
  const call = m.tool_result.calls.find(c => c && c.name === 'propose_plan_changes' && c.ok && c.data && c.data.diff_id);
  return call ? call.data : null;
}

function _coachDayLabel(dow, isMove, fromDay, toDay) {
  const dayNames = ['Mån', 'Tis', 'Ons', 'Tors', 'Fre', 'Lör', 'Sön'];
  if (isMove) return `${dayNames[fromDay] || ''} → ${dayNames[toDay] || ''}`;
  return dayNames[dow] || '';
}

function _coachRenderDiffCard(diff, decisionState) {
  const changes = Array.isArray(diff.changes) ? diff.changes : [];
  if (!changes.length) {
    return `<div class="coach-diff coach-diff--empty">Inga plan-ändringar att föreslå just nu.</div>`;
  }
  const locked = decisionState === 'applied' || decisionState === 'declined';
  const items = changes.map(c => {
    const cur = c.current || {};
    const prop = c.proposed || {};
    const isMove = c.action === 'move_session';
    const dayLabel = _coachDayLabel(c.day_of_week, isMove, c.from_day, c.to_day);
    const curLabel = cur.is_rest ? 'Vila' : `${cur.label || cur.activity_type || ''}${cur.target_duration_minutes ? ' ' + cur.target_duration_minutes + ' min' : ''}`.trim();
    const propLabel = prop.is_rest ? 'Vila' : `${prop.label || prop.activity_type || ''}${prop.target_duration_minutes ? ' ' + prop.target_duration_minutes + ' min' : ''}`.trim();
    const curZone = cur.intensity_zone ? `<span class="zone-badge zone-${escapeHTML(cur.intensity_zone)}">${escapeHTML(cur.intensity_zone)}</span>` : '';
    const propZone = prop.intensity_zone ? `<span class="zone-badge zone-${escapeHTML(prop.intensity_zone)}">${escapeHTML(prop.intensity_zone)}</span>` : '';
    const disabled = locked ? 'disabled' : '';
    const checked = locked ? (decisionState === 'applied' ? 'checked' : '') : 'checked';
    return `
      <label class="cc-diff-card" data-change-id="${escapeHTML(c.id)}">
        <input type="checkbox" class="cc-diff-check" ${checked} ${disabled}>
        <div class="cc-diff-body">
          <div class="cc-diff-day">${escapeHTML(dayLabel)}</div>
          <div class="cc-diff-flow">
            <div class="cc-diff-current"><span class="cc-diff-label">${escapeHTML(curLabel)}</span>${curZone}</div>
            <div class="cc-diff-arrow" aria-hidden="true">↓</div>
            <div class="cc-diff-proposed"><span class="cc-diff-label">${escapeHTML(propLabel)}</span>${propZone}</div>
          </div>
          <div class="cc-diff-reason">${escapeHTML(c.reason_sv || '')}</div>
        </div>
      </label>`;
  }).join('');

  const headerIcon = `<span class="coach-diff-header-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg></span>`;
  const countLabel = `${changes.length} ${changes.length === 1 ? 'förslag' : 'förslag'}`;

  let footer = '';
  if (decisionState === 'applied') {
    footer = `<div class="coach-diff-status coach-diff-status--applied">Ändringarna är sparade i nästa vecka.</div>`;
  } else if (decisionState === 'declined') {
    footer = `<div class="coach-diff-status coach-diff-status--declined">Ignorerat.</div>`;
  } else if (_coach.readOnly) {
    footer = `<div class="coach-diff-status coach-diff-status--declined">Arkiverat samtal — kan inte spara.</div>`;
  } else {
    footer = `
      <div class="coach-diff-actions">
        <button type="button" class="btn btn-ghost btn-sm" onclick="declineCoachDiff('${escapeHTML(diff.diff_id)}')">Ignorera</button>
        <button type="button" class="btn btn-primary btn-sm" onclick="applyCoachDiff('${escapeHTML(diff.diff_id)}')">Spara ändringar</button>
      </div>`;
  }

  return `
    <div class="coach-diff" data-coach-diff="${escapeHTML(diff.diff_id)}">
      <div class="coach-diff-header">
        ${headerIcon}
        <span class="coach-diff-title">Förslag på ändringar i nästa vecka</span>
        <span class="coach-diff-count">${escapeHTML(countLabel)}</span>
      </div>
      <div class="coach-diff-body">
        <div class="cc-diff-list">${items}</div>
      </div>
      ${footer}
    </div>`;
}

function _coachWelcomeStarters() {
  return [
    {
      label: 'Veckosammanfattning',
      sub: 'Hur kändes veckan som gick?',
      message: 'Hur kändes min senaste vecka? Ge mig en kort sammanfattning.',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
    },
    {
      label: 'Justera nästa vecka',
      sub: 'Föreslå ändringar i schemat',
      message: 'Kan du föreslå justeringar för nästa veckas träning?',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
    },
    {
      label: 'Race-prognos',
      sub: 'Vad ligger jag på just nu?',
      message: 'Vad är min predikterade tid på 10 km baserat på mina senaste pass?',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    },
    {
      label: 'Smärta eller skada',
      sub: 'Få hjälp att backa rätt',
      message: 'Jag har lite ont och behöver hjälp att lägga upp en återgångsplan.',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>',
    },
  ];
}

function _coachRenderWelcomeHTML() {
  const starters = _coachWelcomeStarters();
  const cards = starters.map((s, idx) => `
    <button type="button" class="coach-starter" data-starter-idx="${idx}">
      <span class="coach-starter-icon" aria-hidden="true">${s.icon}</span>
      <span class="coach-starter-label">${escapeHTML(s.label)}</span>
      <span class="coach-starter-sub">${escapeHTML(s.sub)}</span>
    </button>
  `).join('');

  return `
    <div class="coach-welcome" id="coach-welcome">
      <div class="coach-welcome-header">
        <span class="coach-avatar coach-avatar--header" aria-hidden="true">${_coachAvatarSvg}</span>
        <h3>Hej! Jag är din coach.</h3>
      </div>
      <p class="coach-welcome-intro">Jag följer din träning, föreslår justeringar och hjälper dig svara på frågor om form, race och återhämtning. Välj något att börja med — eller skriv vad du har på hjärtat.</p>
      <div class="coach-starter-grid">${cards}</div>
    </div>
  `;
}

function _coachAttachWelcomeHandlers(root) {
  if (!root) return;
  const starters = _coachWelcomeStarters();
  root.querySelectorAll('.coach-starter').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.starterIdx || '-1', 10);
      const s = starters[idx];
      if (s) startCoachConversation(s.message);
    });
  });
}

function _coachShouldShowWelcome() {
  if (_coach.readOnly) return false;
  if (!_coach.messages.length) return true;
  // If only an opener nudge sits in the thread, still hide welcome — opener
  // already greets. Welcome is a true blank-slate experience.
  return false;
}

function _coachRenderMessages() {
  const wrap = document.getElementById('coach-messages');
  if (!wrap) return;

  if (_coachShouldShowWelcome()) {
    wrap.innerHTML = _coachRenderWelcomeHTML();
    _coachAttachWelcomeHandlers(wrap);
    return;
  }

  if (!_coach.messages.length) {
    wrap.innerHTML = `<div class="coach-loading"><p>Inga meddelanden i denna tråd.</p></div>`;
    return;
  }

  let html = '';
  let lastDateKey = null;
  let lastRole = null;

  for (const m of _coach.messages) {
    if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'system') continue;

    // Date divider
    if (m.created_at) {
      const d = new Date(m.created_at);
      const key = d.toDateString();
      if (key !== lastDateKey) {
        html += `<div class="coach-date-divider"><span>${escapeHTML(_coachFormatDateLabel(m.created_at))}</span></div>`;
        lastDateKey = key;
        lastRole = null;
      }
    }

    // Tool-status used to render here for every historical assistant message,
    // which made past replies look noisy ("Förbereder förslag…" repeated under
    // every old answer). Tool progress is now only shown live inside the
    // typing indicator while the coach is working — see _coachShowTyping().

    const isFirst = m.role !== lastRole;
    const rowClasses = [
      'coach-msg-row',
      'coach-msg-row--' + m.role,
      isFirst ? 'coach-msg-row--first' : 'coach-msg-row--continuation',
    ].join(' ');
    const bubbleClasses = [
      'coach-msg',
      'coach-msg--' + m.role,
      m.role === 'user' || m.role === 'system' ? 'coach-msg--plain' : '',
    ].filter(Boolean).join(' ');

    const bodyHtml = m.role === 'assistant'
      ? `<div class="coach-msg-md">${_coachRenderMarkdown(m.content || '')}</div>`
      : escapeHTML(m.content || '');

    const time = (m.created_at && m.role !== 'system')
      ? `<span class="coach-msg-time">${_coachFormatTime(m.created_at)}</span>` : '';

    const diff = _coachExtractDiff(m);
    const diffHtml = diff
      ? _coachRenderDiffCard(diff, _coachDiffDecisions.get(diff.diff_id) || 'pending')
      : '';

    const avatar = m.role === 'assistant'
      ? `<span class="coach-avatar coach-avatar--msg" aria-hidden="true">${_coachAvatarSvg}</span>`
      : '';

    html += `
      <div class="${rowClasses}">
        ${avatar}
        <div class="${bubbleClasses}">
          ${bodyHtml}
          ${diffHtml}
          ${time}
        </div>
      </div>`;

    lastRole = m.role;
  }

  wrap.innerHTML = html;
  // Scroll to bottom on next frame so layout settles.
  requestAnimationFrame(() => { wrap.scrollTop = wrap.scrollHeight; });
}

function _coachUpdateStatus() {
  const wrap = document.getElementById('coach-status');
  const text = document.getElementById('coach-status-text');
  if (!wrap || !text) return;

  if (_coach.readOnly) {
    wrap.classList.remove('coach-status--online');
    text.textContent = 'Arkiverat samtal';
    return;
  }

  // Find the most recent assistant message to derive freshness.
  let lastAssistantAt = null;
  for (let i = _coach.messages.length - 1; i >= 0; i--) {
    if (_coach.messages[i].role === 'assistant') {
      lastAssistantAt = _coach.messages[i].created_at;
      break;
    }
  }

  if (!lastAssistantAt) {
    wrap.classList.add('coach-status--online');
    text.textContent = 'Aktiv nu';
    return;
  }

  const ageMin = (Date.now() - new Date(lastAssistantAt).getTime()) / 60000;
  if (ageMin < 5) {
    wrap.classList.add('coach-status--online');
    text.textContent = 'Aktiv nu';
  } else {
    wrap.classList.remove('coach-status--online');
    text.textContent = 'Senast aktiv ' + _coachRelativeTime(lastAssistantAt);
  }
}

async function applyCoachDiff(diffId) {
  if (_coachDiffDecisions.get(diffId) === 'applied' || _coachDiffDecisions.get(diffId) === 'declined') return;
  const wrap = document.getElementById('coach-messages');
  const card = wrap?.querySelector(`[data-coach-diff="${CSS.escape(diffId)}"]`);
  const acceptedIds = card
    ? [...card.querySelectorAll('.cc-diff-card')]
        .filter(el => el.querySelector('.cc-diff-check')?.checked)
        .map(el => el.dataset.changeId)
    : [];
  if (acceptedIds.length === 0) {
    const ok = await showConfirmModal('Ingen ändring vald', 'Inga ändringar är markerade. Vill du ignorera förslaget?', 'Ignorera');
    if (!ok) return;
    return declineCoachDiff(diffId);
  }
  _coachShowTyping(true);
  try {
    const data = await _coachFetch({
      mode: 'tool',
      tool_name: 'apply_plan_changes',
      arguments: { diff_id: diffId, accepted_change_ids: acceptedIds },
    });
    _coachDiffDecisions.set(diffId, data?.ok ? 'applied' : 'pending');
    if (data?.assistant_message) _coach.messages.push(data.assistant_message);
    if (data && !data.ok) {
      showToast('Kunde inte spara ändringar: ' + (data?.result?.error || 'okänt fel'));
    }
    // Refresh upcoming week in the background so Ditt schema reflects updates.
    if (data?.ok && typeof loadDashboard === 'function') { try { loadDashboard(); } catch (_) {} }
  } catch (e) {
    console.error('coach apply failed', e);
    showToast(e.status === 429 ? 'Bromsa — försök igen om en stund.' : 'Kunde inte spara ändringarna.');
  } finally {
    _coachShowTyping(false);
    _coachRenderMessages();
    _coachRenderChips();
  }
}

function declineCoachDiff(diffId) {
  if (_coachDiffDecisions.get(diffId) === 'applied') return;
  _coachDiffDecisions.set(diffId, 'declined');
  _coachRenderMessages();
}

function _coachRenderChips() {
  const el = document.getElementById('coach-chips');
  if (!el) return;
  // Pull chips from the most recent assistant message.
  let chips = [];
  for (let i = _coach.messages.length - 1; i >= 0; i--) {
    const m = _coach.messages[i];
    if (m.role === 'assistant') {
      if (Array.isArray(m.chips)) chips = m.chips.slice(0, 6);
      break;
    }
  }
  if (!chips.length) { el.innerHTML = ''; return; }
  el.innerHTML = chips.map((c) =>
    `<button type="button" class="coach-chip" onclick="sendCoachChip(${JSON.stringify(c).replace(/"/g, '&quot;')})">${escapeHTML(c)}</button>`
  ).join('');
}

function _coachShowTyping(on, statusLabel) {
  const wrap = document.getElementById('coach-messages');
  if (!wrap) return;
  let typing = wrap.querySelector('.coach-typing');
  if (on) {
    if (!typing) {
      typing = document.createElement('div');
      typing.className = 'coach-typing';
      typing.innerHTML = `
        <span class="coach-typing-dots"><span></span><span></span><span></span></span>
        <span class="coach-typing-label" hidden></span>`;
      wrap.appendChild(typing);
      wrap.scrollTop = wrap.scrollHeight;
    }
    const label = typing.querySelector('.coach-typing-label');
    if (label) {
      if (statusLabel) {
        label.textContent = statusLabel;
        label.hidden = false;
      } else {
        label.textContent = '';
        label.hidden = true;
      }
    }
  } else if (typing) {
    typing.remove();
  }
}

function _coachUpdateThreadTitle() {
  const el = document.getElementById('coach-thread-title');
  if (!el) return;
  el.textContent = _coach.thread?.title || 'Coach';
}

function _coachUpdateCharCount() {
  const input = document.getElementById('coach-input');
  const counter = document.getElementById('coach-char-count');
  if (!input || !counter) return;
  const len = (input.value || '').length;
  if (len < 3500) {
    counter.hidden = true;
    counter.classList.remove('coach-char-count--warn');
    return;
  }
  counter.hidden = false;
  counter.textContent = `${len} / 4000`;
  counter.classList.toggle('coach-char-count--warn', len >= 3950);
}

function _coachSetSendButtonState() {
  const btn = document.getElementById('coach-send-btn');
  if (!btn) return;
  if (_coach.sending) {
    btn.classList.add('coach-send-btn--stop');
    btn.disabled = false;
    btn.setAttribute('aria-label', 'Avbryt');
    btn.setAttribute('title', 'Avbryt');
  } else {
    btn.classList.remove('coach-send-btn--stop');
    btn.disabled = _coach.readOnly;
    btn.setAttribute('aria-label', 'Skicka');
    btn.setAttribute('title', 'Skicka');
  }
}

function _coachSetReadOnly(readOnly) {
  _coach.readOnly = !!readOnly;
  const composer = document.getElementById('coach-composer');
  const input = document.getElementById('coach-input');
  const banner = document.getElementById('coach-archived-banner');
  if (composer) composer.style.opacity = readOnly ? '0.55' : '';
  if (input) {
    input.disabled = !!readOnly;
    if (readOnly) input.placeholder = 'Arkiverat samtal — endast läsläge.';
    else input.placeholder = 'Skriv ett meddelande…';
  }
  if (banner) banner.hidden = !readOnly;
  _coachSetSendButtonState();
  _coachUpdateStatus();
}

function _coachBindComposer() {
  if (_coach.inputBound) return;
  const input = document.getElementById('coach-input');
  const sendBtn = document.getElementById('coach-send-btn');
  if (!input) return;
  _coach.inputBound = true;
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
    _coachUpdateCharCount();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (_coach.sending) cancelCoachSend();
      else sendCoachMessage(e);
    }
  });
  if (sendBtn) {
    // Click is wired via form submit; we only need to intercept when sending.
    sendBtn.addEventListener('click', (e) => {
      if (_coach.sending) {
        e.preventDefault();
        cancelCoachSend();
      }
    });
  }
  // Global ESC to close history drawer.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const drawer = document.getElementById('coach-history-drawer');
      if (drawer && !drawer.hidden) closeCoachHistory();
    }
  });
}

// Set to true once per page-load when the user resolves the resume prompt
// (continue or start new). Prevents nagging on every tab switch.
let _coachResumeResolved = false;

function _coachThreadHasUserMessages() {
  return _coach.messages.some((m) => m.role === 'user');
}

function _coachShowResumePrompt() {
  const wrap = document.getElementById('coach-messages');
  if (!wrap) return;
  // Find the most recent user/assistant message for a preview line.
  let lastMsg = null;
  for (let i = _coach.messages.length - 1; i >= 0; i--) {
    const m = _coach.messages[i];
    if (m.role === 'user' || m.role === 'assistant') { lastMsg = m; break; }
  }
  const previewRaw = (lastMsg?.content || '').replace(/\s+/g, ' ').trim();
  const preview = previewRaw.length > 140 ? previewRaw.slice(0, 137) + '…' : previewRaw;
  const when = lastMsg?.created_at ? _coachRelativeTime(lastMsg.created_at) : '';

  wrap.innerHTML = `
    <div class="coach-resume" id="coach-resume" role="dialog" aria-labelledby="coach-resume-title">
      <div class="coach-resume-header">
        <span class="coach-avatar coach-avatar--header" aria-hidden="true">${_coachAvatarSvg}</span>
        <div>
          <h3 id="coach-resume-title">Du har en pågående dialog</h3>
          <p class="coach-resume-meta">${when ? 'Senast aktiv ' + escapeHTML(when) : 'Redan startad'}</p>
        </div>
      </div>
      ${preview ? `<blockquote class="coach-resume-preview">${escapeHTML(preview)}</blockquote>` : ''}
      <div class="coach-resume-actions">
        <button type="button" class="btn btn-ghost" id="coach-resume-new">Starta ny avstämning</button>
        <button type="button" class="btn btn-primary" id="coach-resume-continue">Fortsätt dialogen</button>
      </div>
    </div>`;

  const continueBtn = wrap.querySelector('#coach-resume-continue');
  const newBtn = wrap.querySelector('#coach-resume-new');
  if (continueBtn) continueBtn.addEventListener('click', () => {
    _coachResumeResolved = true;
    _coachRenderMessages();
    _coachRenderChips();
  });
  if (newBtn) newBtn.addEventListener('click', async () => {
    _coachResumeResolved = true;
    try {
      await _coachFetch({ mode: 'archive' });
    } catch (e) {
      console.error('coach archive failed', e);
      showToast('Kunde inte arkivera samtalet');
      return;
    }
    _coach.thread = null;
    _coach.messages = [];
    _coach.activeThreadCache = null;
    // Re-open will create a fresh thread (and possibly an opener).
    await loadCoach();
  });
}

async function loadCoach() {
  if (!currentProfile) return;
  if (_coach.loading) return;
  _coach.loading = true;
  _coachBindComposer();
  _coachSetReadOnly(false);
  const wrap = document.getElementById('coach-messages');
  if (wrap && !_coach.messages.length) {
    wrap.innerHTML = `<div class="coach-loading"><div class="coach-loading-dots"><span></span><span></span><span></span></div><p>Laddar samtal…</p></div>`;
  }
  try {
    const data = await _coachFetch({ mode: 'open' });
    _coach.thread = data.thread || null;
    _coach.messages = Array.isArray(data.messages) ? data.messages : [];
    _coachUpdateThreadTitle();
    _coachUpdateStatus();
    if (!_coachResumeResolved && _coachThreadHasUserMessages()) {
      _coachShowResumePrompt();
      _coachRenderChips();
      return;
    }
    _coachRenderMessages();
    _coachRenderChips();
  } catch (e) {
    console.error('coach open failed', e);
    if (wrap) {
      wrap.innerHTML = `<div class="coach-loading"><p>Kunde inte ladda coachen. ${escapeHTML(e.message || '')}</p></div>`;
    }
  } finally {
    _coach.loading = false;
  }
}

async function sendCoachMessage(ev) {
  if (ev) ev.preventDefault();
  if (_coach.sending) return;
  if (_coach.readOnly) {
    showToast('Detta är ett arkiverat samtal. Återgå till nuvarande för att skriva.');
    return;
  }
  const input = document.getElementById('coach-input');
  if (!input) return;
  const content = (input.value || '').trim();
  if (!content) return;

  _coach.sending = true;
  _coach.abortController = new AbortController();
  _coachSetSendButtonState();

  // Optimistic user turn so the UI feels snappy.
  const optimistic = {
    id: 'optimistic-' + Date.now(),
    role: 'user',
    content,
    created_at: new Date().toISOString(),
  };
  _coach.messages.push(optimistic);
  _coachRenderMessages();
  _coachRenderChips();
  input.value = '';
  input.style.height = 'auto';
  _coachUpdateCharCount();
  _coachShowTyping(true, 'Coachen tänker…');

  try {
    const data = await _coachFetch({ mode: 'send', content }, { signal: _coach.abortController.signal });
    // Replace optimistic with persisted, append assistant.
    _coach.messages = _coach.messages.filter((m) => m.id !== optimistic.id);
    if (data.user_message) _coach.messages.push(data.user_message);
    if (data.assistant_message) _coach.messages.push(data.assistant_message);
    if (data.thread) _coach.thread = data.thread;
    _coachUpdateThreadTitle();
    _coachUpdateStatus();
  } catch (e) {
    if (e.name === 'AbortError') {
      _coach.messages = _coach.messages.filter((m) => m.id !== optimistic.id);
      _coach.messages.push({
        id: 'sys-' + Date.now(),
        role: 'system',
        content: 'Avbrutet — börja om igen när du vill.',
        created_at: new Date().toISOString(),
      });
    } else {
      console.error('coach send failed', e);
      _coach.messages.push({
        id: 'err-' + Date.now(),
        role: 'system',
        content: e.status === 429
          ? 'Du skickar lite för många meddelanden. Försök igen om en stund.'
          : 'Kunde inte skicka. Försök igen.',
        created_at: new Date().toISOString(),
      });
    }
  } finally {
    _coachShowTyping(false);
    _coachRenderMessages();
    _coachRenderChips();
    _coach.sending = false;
    _coach.abortController = null;
    _coachSetSendButtonState();
  }
}

function cancelCoachSend() {
  if (_coach.abortController) {
    try { _coach.abortController.abort(); } catch (_) { /* ignore */ }
  }
}

function sendCoachChip(text) {
  if (_coach.readOnly) return;
  const input = document.getElementById('coach-input');
  if (!input) return;
  input.value = text;
  _coachUpdateCharCount();
  sendCoachMessage();
}

function startCoachConversation(text) {
  if (_coach.readOnly) return;
  const input = document.getElementById('coach-input');
  if (!input) return;
  input.value = text;
  _coachUpdateCharCount();
  sendCoachMessage();
}

async function archiveCoachThread() {
  if (_coach.readOnly) {
    // From an archived view "Nytt samtal" should just bring the user back to
    // the active thread.
    return returnToActiveCoachThread();
  }
  const ok = await showConfirmModal('Nytt samtal', 'Vill du börja ett nytt samtal? Det aktuella sparas i historiken.', 'Starta nytt');
  if (!ok) return;
  try {
    await _coachFetch({ mode: 'archive' });
    _coach.thread = null;
    _coach.messages = [];
    _coach.activeThreadCache = null;
    _coachRenderMessages();
    _coachRenderChips();
    await loadCoach();
  } catch (e) {
    console.error('coach archive failed', e);
    showToast('Kunde inte starta nytt samtal');
  }
}

// ─────────────────────── History drawer ───────────────────────
async function openCoachHistory() {
  const drawer = document.getElementById('coach-history-drawer');
  const backdrop = document.getElementById('coach-history-backdrop');
  const list = document.getElementById('coach-history-list');
  if (!drawer || !backdrop || !list) return;
  drawer.hidden = false;
  backdrop.hidden = false;
  // Wire focus trap + Escape via the standard Dialog helper.
  openDialog('coach-history-drawer');
  list.innerHTML = `<div class="coach-loading"><div class="coach-loading-dots"><span></span><span></span><span></span></div></div>`;
  // Sprint 2: weekly check-in history moved from Progress to here.
  // Render it in parallel with the threads fetch so the drawer never
  // looks empty during the network round-trip.
  (async () => {
    try {
      const ciSection = document.getElementById('coach-checkin-history-section');
      const ciBody = document.getElementById('coach-checkin-history-body');
      if (!ciSection || !ciBody) return;
      await renderWeeklyCheckinHistory(ciBody);
      ciSection.hidden = !ciBody.innerHTML.trim();
    } catch (_e) { /* non-fatal */ }
  })();
  try {
    const data = await _coachFetch({ mode: 'history' });
    const threads = Array.isArray(data.threads) ? data.threads : [];
    if (!threads.length) {
      list.innerHTML = `<div class="coach-history-empty">Inga arkiverade samtal ännu. Tryck på pennan för att börja ett nytt — det förra hamnar här.</div>`;
      return;
    }
    list.innerHTML = threads.map((t) => {
      const title = t.title || 'Samtal';
      const when = t.archived_at || t.last_message_at || t.created_at;
      const meta = when ? _coachFormatDateLabel(when) + ' · ' + _coachFormatTime(when) : '';
      return `
        <button type="button" class="coach-history-item" data-thread-id="${escapeHTML(t.id)}">
          <span class="coach-history-item-title">${escapeHTML(title)}</span>
          <span class="coach-history-item-meta">${escapeHTML(meta)}</span>
        </button>`;
    }).join('');
    list.querySelectorAll('.coach-history-item').forEach((el) => {
      el.addEventListener('click', () => loadCoachThread(el.dataset.threadId));
    });
  } catch (e) {
    console.error('coach history failed', e);
    list.innerHTML = `<div class="coach-history-empty">Kunde inte hämta historiken. ${escapeHTML(e.message || '')}</div>`;
  }
}

function closeCoachHistory() {
  const drawer = document.getElementById('coach-history-drawer');
  const backdrop = document.getElementById('coach-history-backdrop');
  if (drawer) drawer.hidden = true;
  if (backdrop) backdrop.hidden = true;
  closeDialog('coach-history-drawer');
}

async function loadCoachThread(threadId) {
  if (!threadId) return;
  closeCoachHistory();
  // Cache the active thread so we can restore it.
  if (!_coach.readOnly) {
    _coach.activeThreadCache = {
      thread: _coach.thread,
      messages: _coach.messages.slice(),
    };
  }
  const wrap = document.getElementById('coach-messages');
  if (wrap) wrap.innerHTML = `<div class="coach-loading"><div class="coach-loading-dots"><span></span><span></span><span></span></div><p>Hämtar samtal…</p></div>`;
  try {
    const data = await _coachFetch({ mode: 'history', thread_id: threadId });
    _coach.thread = data.thread || null;
    _coach.messages = Array.isArray(data.messages) ? data.messages : [];
    _coachSetReadOnly(true);
    _coachUpdateThreadTitle();
    _coachRenderMessages();
    _coachRenderChips();
  } catch (e) {
    console.error('coach load thread failed', e);
    if (wrap) wrap.innerHTML = `<div class="coach-loading"><p>Kunde inte hämta samtalet. ${escapeHTML(e.message || '')}</p></div>`;
  }
}

function returnToActiveCoachThread() {
  _coachSetReadOnly(false);
  if (_coach.activeThreadCache) {
    _coach.thread = _coach.activeThreadCache.thread;
    _coach.messages = _coach.activeThreadCache.messages;
    _coach.activeThreadCache = null;
    _coachUpdateThreadTitle();
    _coachUpdateStatus();
    _coachRenderMessages();
    _coachRenderChips();
  } else {
    loadCoach();
  }
}

window.loadCoach = loadCoach;
window.sendCoachMessage = sendCoachMessage;
window.sendCoachChip = sendCoachChip;
window.startCoachConversation = startCoachConversation;
window.archiveCoachThread = archiveCoachThread;
window.applyCoachDiff = applyCoachDiff;
window.declineCoachDiff = declineCoachDiff;
window.cancelCoachSend = cancelCoachSend;
window.openCoachHistory = openCoachHistory;
window.closeCoachHistory = closeCoachHistory;
window.loadCoachThread = loadCoachThread;
window.returnToActiveCoachThread = returnToActiveCoachThread;
