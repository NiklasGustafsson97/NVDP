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
}

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
    try { navigate(currentView); } catch (e) { console.error('navigate error:', e); }
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
}

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
  let q = sb.from('workouts').select('*').order('workout_date', { ascending: true });
  if (profileId) q = q.eq('profile_id', profileId);
  if (from) q = q.gte('workout_date', from);
  if (to) q = q.lte('workout_date', to);
  const { data } = await q;
  return data || [];
}

async function fetchAllWorkouts() {
  const { data } = await sb.from('workouts').select('*').order('workout_date', { ascending: true });
  return data || [];
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

async function toggleReaction(workoutId, reactionType) {
  const existing = await fetchReactions(workoutId);
  const myReaction = existing.find(r => r.profile_id === currentProfile.id);

  if (myReaction && myReaction.reaction === reactionType) {
    await sb.from('workout_reactions').delete().eq('id', myReaction.id);
  } else if (myReaction) {
    await sb.from('workout_reactions').update({ reaction: reactionType }).eq('id', myReaction.id);
  } else {
    await sb.from('workout_reactions').insert({ workout_id: workoutId, profile_id: currentProfile.id, reaction: reactionType });
  }
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

  // Pre-fetch legacy plans for the visible window so day taps are instant
  _dashLegacyPlans = null;
  try {
    const periods = await fetchPeriods();
    const period = periods.find(p => dataStartStr >= p.start_date && dataEndStr <= p.end_date);
    if (period) _dashLegacyPlans = await fetchPlans(period.id);
  } catch (e) { /* ignore */ }

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

  const dayWorkouts = _dashWeekWorkouts.filter(w => w.workout_date === dateStr);
  const planWorkout = _dashPlanWorkouts.find(pw => pw.workout_date === dateStr);

  let useAiPlan = !!(_activePlan && dateStr >= _activePlan.start_date && dateStr <= _activePlan.end_date);
  let legacyPlan = null;
  if (!useAiPlan && _dashLegacyPlans) {
    legacyPlan = _dashLegacyPlans.find(p => p.day_of_week === dayOfWeek) || null;
  }

  const plan = planWorkout || legacyPlan;
  const isPast = date < now && !isToday;

  let html = `<div class="ddc-header"><span class="ddc-day-label">${dayLabel}</span>`;

  if (plan && !plan.is_rest) {
    const phase = useAiPlan ? _getPhaseForDate(dateStr) : null;
    if (phase) html += `<span class="ddc-phase">${PHASE_LABELS[phase] || phase}</span>`;
  }
  html += '</div>';

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

    html += '<div class="ddc-plan">';
    html += `<div class="ddc-plan-title">`;
    if (actType) html += `<span class="ddc-activity-icon">${activityEmoji(actType)}</span>`;
    html += `<span>${label}</span>`;
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
      html += `<div class="ddc-done-item clickable" onclick='openWorkoutModal(${JSON.stringify(w).replace(/'/g, "&#39;")})'>
        ${buildWorkoutBody(w)}
      </div>`;
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

function updateSchemaEmptyBanner() {
  const container = document.getElementById('schema-content');
  const banner = document.getElementById('dash-schema-empty');
  const planBtn = document.getElementById('dash-empty-plan-btn');
  if (!container || !banner) return;
  const hasWorkoutCards = container.querySelector('.clickable-workout');
  let hasPlanContent = false;
  container.querySelectorAll('.sr-card').forEach(card => {
    if (card.querySelector('.clickable-workout')) hasPlanContent = true;
    const t = card.querySelector('.sr-plan-text');
    if (t && t.textContent.replace(/\s+/g, ' ').trim().length > 0) hasPlanContent = true;
  });
  const empty = !hasWorkoutCards && !hasPlanContent;
  banner.classList.toggle('hidden', !empty);
  if (planBtn) planBtn.classList.toggle('hidden', !PLAN_GENERATION_ENABLED);
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
  const batch = _recentWorkouts.slice(_recentShown, _recentShown + RECENT_PAGE);
  // SECURITY (assessment H1): bind click handlers by id after render, rather
  // than serialising DB rows into inline onclick attributes.
  const html = batch.map(w => {
    const distStr = w.distance_km ? ` | ${w.distance_km} km` : '';
    const intBadge = w.intensity ? `<span class="intensity-badge">${escapeHTML(w.intensity)}</span>` : '';
    const mapThumb = w.map_polyline ? `<div class="wo-map wo-map-mini" data-polyline="${escapeHTML(w.map_polyline)}"></div>` : '';
    const secondary = [];
    if (w.avg_hr) secondary.push(`\u2665 ${w.avg_hr} bpm`);
    if (w.elevation_gain_m) secondary.push(`\u25B2 ${Math.round(w.elevation_gain_m)} m`);
    if (w.avg_speed_kmh && w.activity_type === 'Löpning') {
      const pace = 60 / w.avg_speed_kmh;
      const pMin = Math.floor(pace);
      const pSec = String(Math.round((pace - pMin) * 60)).padStart(2, '0');
      secondary.push(`${pMin}:${pSec}/km`);
    }
    const secondaryHtml = secondary.length ? `<div class="meta wo-secondary-meta">${secondary.join(' · ')}</div>` : '';
    return `
    <div class="workout-item clickable${w.map_polyline ? ' workout-item-with-map' : ''}" data-recent-wid="${escapeHTML(w.id)}">
      <div class="workout-icon" style="background:${ACTIVITY_COLORS[w.activity_type] || '#555'}22;">
        ${activityEmoji(w.activity_type)}
      </div>
      <div class="workout-info">
        <div class="name">${escapeHTML(w.activity_type)}${intBadge}</div>
        <div class="meta">${formatDate(w.workout_date)}${w.notes && w.notes !== 'Importerad' && !w.notes?.startsWith('[Strava]') ? ' — ' + escapeHTML(w.notes) : ''}</div>
        <div class="meta wo-primary-meta">${w.duration_minutes} min${distStr}</div>
        ${secondaryHtml}
      </div>
      ${mapThumb}
    </div>`;
  }).join('');
  _recentShown += batch.length;

  // Remove old "show more" button if present
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
  items.push(`<div class="ws-stat"><span class="ws-val">${totalHours}h</span><span class="ws-label">total tid</span>${deltaHTML(totalMins, prevMins, 'h')}</div>`);
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
async function openWorkoutModal(w) {
  _wmFocusBefore = document.activeElement;
  selectedWorkout = w;
  const isOwn = w.profile_id === currentProfile.id;
  const ownerProfile = allProfiles.find(p => p.id === w.profile_id);
  const ownerName = ownerProfile ? ownerProfile.name : '';

  const titlePrefix = isOwn ? '' : ownerName + ' — ';
  // textContent is already XSS-safe; no escape needed here.
  document.getElementById('wm-title').textContent = titlePrefix + w.activity_type + ' — ' + formatDate(w.workout_date);

  const intBadge = w.intensity ? `<span class="intensity-badge">${escapeHTML(w.intensity)}</span>` : '';
  let body = '';
  body += `<div class="modal-detail-row"><span class="mdr-label">Aktivitet</span><span class="mdr-value">${escapeHTML(w.activity_type)} ${intBadge}${sourceBadge(w)}</span></div>`;
  body += `<div class="modal-detail-row"><span class="mdr-label">Datum</span><span class="mdr-value">${escapeHTML(w.workout_date)}</span></div>`;
  body += `<div class="modal-detail-row"><span class="mdr-label">Tid</span><span class="mdr-value">${w.duration_minutes} min</span></div>`;
  if (w.distance_km) body += `<div class="modal-detail-row"><span class="mdr-label">Distans</span><span class="mdr-value">${w.distance_km} km</span></div>`;
  if (w.workout_time) body += `<div class="modal-detail-row"><span class="mdr-label">Klockslag</span><span class="mdr-value">${escapeHTML(w.workout_time)}</span></div>`;
  if (w.notes && w.notes !== 'Importerad' && !w.notes?.startsWith('[Strava]')) body += `<div class="modal-detail-row"><span class="mdr-label">Anteckning</span><span class="mdr-value">${escapeHTML(w.notes)}</span></div>`;
  if (w.source === 'strava') {
    const stravaLink = w.strava_activity_id
      ? `<a href="https://www.strava.com/activities/${encodeURIComponent(w.strava_activity_id)}" target="_blank" rel="noopener" class="strava-view-link">View on Strava</a>`
      : '';
    body += `<div class="modal-detail-row"><span class="mdr-label">Källa</span><span class="mdr-value" style="color:#FC4C02;">Strava auto-import ${stravaLink}</span></div>`;
  }
  if (w.source === 'garmin') {
    const garminLink = w.garmin_activity_id
      ? `<a href="https://connect.garmin.com/modern/activity/${encodeURIComponent(w.garmin_activity_id)}" target="_blank" rel="noopener" class="garmin-view-link">View on Garmin</a>`
      : '';
    body += `<div class="modal-detail-row"><span class="mdr-label">Källa</span><span class="mdr-value" style="color:#007CC3;">Garmin auto-import ${garminLink}</span></div>`;
  }

  if (w.avg_hr || w.max_hr) {
    const hrParts = [];
    if (w.avg_hr) hrParts.push(`Snitt ${w.avg_hr}`);
    if (w.max_hr) hrParts.push(`Max ${w.max_hr}`);
    body += `<div class="modal-detail-row"><span class="mdr-label">Puls</span><span class="mdr-value">${hrParts.join(' / ')} bpm</span></div>`;
  }
  if (w.elevation_gain_m) body += `<div class="modal-detail-row"><span class="mdr-label">Höjdmeter</span><span class="mdr-value">${Math.round(w.elevation_gain_m)} m</span></div>`;
  if (w.avg_speed_kmh) {
    const paceMin = 60 / w.avg_speed_kmh;
    const paceStr = `${Math.floor(paceMin)}:${String(Math.round((paceMin % 1) * 60)).padStart(2, '0')}/km`;
    body += `<div class="modal-detail-row"><span class="mdr-label">Tempo</span><span class="mdr-value">${w.avg_speed_kmh.toFixed(1)} km/h (${paceStr})</span></div>`;
  }
  if (w.calories) body += `<div class="modal-detail-row"><span class="mdr-label">Kalorier</span><span class="mdr-value">${w.calories} kcal</span></div>`;
  if (w.avg_cadence) body += `<div class="modal-detail-row"><span class="mdr-label">Kadens</span><span class="mdr-value">${Math.round(w.avg_cadence)} spm</span></div>`;

  // Splits (per-km) table
  const splits = w.splits_data ? (typeof w.splits_data === 'string' ? JSON.parse(w.splits_data) : w.splits_data) : null;
  if (splits && splits.length > 0) {
    let splitsHtml = `<div class="wm-section-title">Kilometersplits</div><div class="wm-table-scroll"><table class="wm-splits-table"><thead><tr><th>Km</th><th>Tid</th><th>Tempo</th><th>Puls</th><th>Höjd</th></tr></thead><tbody>`;
    splits.forEach(s => {
      const km = s.split || Math.round(s.distance / 1000);
      const mins = Math.floor(s.moving_time / 60);
      const secs = s.moving_time % 60;
      const pace = s.average_speed > 0 ? 1000 / s.average_speed / 60 : 0;
      const paceMin = Math.floor(pace);
      const paceSec = Math.round((pace - paceMin) * 60);
      const paceStr = pace > 0 ? `${paceMin}:${String(paceSec).padStart(2, '0')}/km` : '—';
      const hr = s.average_heartrate ? Math.round(s.average_heartrate) : '—';
      const elev = s.elevation_difference != null ? (s.elevation_difference > 0 ? '+' : '') + Math.round(s.elevation_difference) + 'm' : '—';
      splitsHtml += `<tr><td>${km}</td><td>${mins}:${String(secs).padStart(2, '0')}</td><td>${paceStr}</td><td>${hr}</td><td>${elev}</td></tr>`;
    });
    splitsHtml += '</tbody></table></div>';
    body += splitsHtml;
  }

  // Laps table
  const laps = w.laps_data ? (typeof w.laps_data === 'string' ? JSON.parse(w.laps_data) : w.laps_data) : null;
  if (laps && laps.length > 1) {
    let lapsHtml = `<div class="wm-section-title">Varv</div><div class="wm-table-scroll"><table class="wm-splits-table"><thead><tr><th>#</th><th>Distans</th><th>Tid</th><th>Tempo</th><th>Puls</th></tr></thead><tbody>`;
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
    lapsHtml += '</tbody></table></div>';
    body += lapsHtml;
  }

  if (w.map_polyline) {
    body += `<div id="wm-map" style="height:200px;border-radius:8px;margin:12px 0;"></div>`;
  }

  body += `<div id="wm-reactions" class="wm-reactions"><span class="text-dim">Laddar...</span></div>`;
  body += `<div id="wm-comments" class="wm-comments"><span class="text-dim">Laddar...</span></div>`;

  document.getElementById('wm-body').innerHTML = body;

  if (w.map_polyline) {
    if (_wmMapInstance) {
      try { _wmMapInstance.remove(); } catch (e) { /* ignore */ }
      _wmMapInstance = null;
    }
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
          map.fitBounds(bounds, { padding: [30, 30], animate: false });
          _wmMapInstance = map;
          setTimeout(() => { try { map.invalidateSize(); map.fitBounds(bounds, { padding: [30, 30], animate: false }); } catch (e) { /* ignore */ } }, 320);
        } catch (e) {
          console.error('Workout modal map init failed:', e);
        }
      }, 100);
    }).catch(() => {});
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

    if (isOwn) {
      const summary = [];
      if (likes.length) summary.push(`👍 ${likes.length}`);
      if (dislikes.length) summary.push(`👎 ${dislikes.length}`);
      reactEl.innerHTML = summary.length
        ? `<div class="reaction-bar"><span class="reaction-summary" title="${likeTooltip}">${summary.join('  ')}</span></div>`
        : '';
    } else {
      reactEl.innerHTML = `
        <div class="reaction-bar">
          <button class="react-btn${myReaction?.reaction === 'like' ? ' active' : ''}" onclick="handleReaction('${workoutId}', 'like')" title="${likeTooltip}">
            <span class="react-icon">👍</span><span class="react-count">${likes.length || ''}</span>
          </button>
          <button class="react-btn${myReaction?.reaction === 'dislike' ? ' active' : ''}" onclick="handleReaction('${workoutId}', 'dislike')" title="${dislikeTooltip}">
            <span class="react-icon">👎</span><span class="react-count">${dislikes.length || ''}</span>
          </button>
        </div>`;
    }
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

async function handleReaction(workoutId, type) {
  await toggleReaction(workoutId, type);
  await loadModalSocial(workoutId);
  if (_feedReactionsCache) refreshFeedReactions();
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
  if (_wmFocusBefore && typeof _wmFocusBefore.focus === 'function') {
    try { _wmFocusBefore.focus(); } catch (e) { /* ignore */ }
  }
  _wmFocusBefore = null;
}

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

    updatePlanInfoBar(_activePlan, _activePlanWeeks);
    renderGenerateButton();
    updateSchemaEditBar();
    renderSchemaPlan(workouts, planWorkouts, targetMonday, invitations, isOwnSchema, profile, phase);
  } else {
    // Legacy mode (period_plans)
    _schemaEditMode = false;
    const deload = isDeloadWeek(targetMonday);
    document.getElementById('schema-week-label').textContent =
      `V${wk}${deload ? ' (Deload)' : ''} — ${formatDate(targetMonday)} till ${formatDate(targetSunday)}`;

    if (isOwnSchema) {
      updatePlanInfoBar(null, []);
    }
    renderGenerateButton();
    updateSchemaEditBar();

    const periods = await fetchPeriods();
    const mondayStr = isoDate(targetMonday);
    const period = periods.find(p => mondayStr >= p.start_date && mondayStr <= p.end_date);
    let plans = [];
    if (period) plans = await fetchPlans(period.id);

    renderSchema(workouts, plans, targetMonday, deload, invitations, isOwnSchema, profile);
  }
  updateSchemaEmptyBanner();
  try { await updateCoachCheckinBanner(); } catch (_e) { /* non-blocking */ }
}

// ── Calendar Strip ──
const CAL_DAY_LETTERS = ['M', 'T', 'O', 'T', 'F', 'L', 'S'];

function schemaWeekPrev() {
  const now = new Date();
  const currentMonday = mondayOfWeek(now);
  const targetMonday = addDays(currentMonday, (schemaWeekOffset - 1) * 7);
  const minMonday = new Date(P1_START);
  if (targetMonday < minMonday) return;
  schemaWeekOffset--;
  _calStripWorkouts = null;
  loadSchema();
}
function schemaWeekNext() { schemaWeekOffset++; _calStripWorkouts = null; loadSchema(); }
function schemaWeekToday() { schemaWeekOffset = 0; _calStripWorkouts = null; loadSchema(); }

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

function buildWorkoutBody(w, opts = {}) {
  const { showMap = false } = opts;
  let text = '';

  text += `<div class="wo-label">${w.activity_type}`;
  if (w.intensity) text += ` <span class="intensity-badge">${w.intensity}</span>`;
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

// ── AI Plan Schema Renderer ──

function renderSchemaPlan(workouts, planWorkouts, monday, invitations, isOwnSchema, profile, phase) {
  invitations = invitations || [];
  const container = document.getElementById('schema-content');
  const todayStr = isoDate(new Date());
  const profileId = profile?.id || currentProfile?.id;

  let html = '';
  for (let i = 0; i < 7; i++) {
    const dayDate = addDays(monday, i);
    const dayStr = isoDate(dayDate);
    const dayWorkouts = workouts.filter(w => w.workout_date === dayStr);
    const planWo = planWorkouts.find(pw => pw.day_of_week === i);
    const isToday = dayStr === todayStr;
    const isFuture = dayDate > new Date();

    const dayInvs = invitations.filter(inv => inv.workout_date === dayStr);
    const acceptedInv = dayInvs.find(inv => inv.status === 'accepted');
    const pendingInv = dayInvs.find(inv => inv.status === 'pending');

    let statusClass = 'future';
    if (dayWorkouts.length > 0) statusClass = 'done';
    else if (planWo?.is_rest) statusClass = 'rest';
    else if (!isFuture) statusClass = 'missed';

    let planText = '';
    if (acceptedInv) {
      const partnerId = acceptedInv.sender_id === profileId ? acceptedInv.receiver_id : acceptedInv.sender_id;
      const partner = allProfiles.find(p => p.id === partnerId);
      const initials = partner ? partner.name.split(' ').map(n => n[0]).join('').toUpperCase() : '?';
      planText = `<span class="shared-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>${initials}</span> `;
      planText += acceptedInv.description || acceptedInv.activity_type;
    } else if (planWo?.is_rest) {
      planText = '<span class="sr-rest-label">Vila</span>';
    } else if (planWo) {
      const zoneBadge = planWo.intensity_zone
        ? ` <span class="zone-badge zone-${planWo.intensity_zone.toLowerCase()}">${planWo.intensity_zone}</span>`
        : '';
      const lbl = planWo.label || planWo.activity_type;
      const desc = stripProgressionText(planWo.description || '');
      const estMin = estimateDurationFromDescription(planWo.description, planWo.target_duration_minutes);
      const durStr = estMin > 0 ? `${estMin} min` : '';
      const meta = (estMin > 0 || planWo.target_distance_km)
        ? `<span class="sr-target">${durStr}${planWo.target_distance_km ? (durStr ? ' · ' : '') + planWo.target_distance_km + ' km' : ''}</span>`
        : '';
      planText = `<div class="sr-plan-label">${lbl}${zoneBadge} ${meta}</div>`;
      if (desc) planText += `<div class="sr-plan-desc">${desc}</div>`;
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

    const fakePlan = planWo ? { label: planWo.label, description: planWo.description, is_rest: planWo.is_rest, day_of_week: planWo.day_of_week } : {};

    let clickAttr = '';
    const editIcon = _schemaEditMode && planWo && dayWorkouts.length === 0 ? '<div class="sr-edit-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg></div>' : '';

    if (_schemaEditMode && planWo && dayWorkouts.length === 0) {
      clickAttr = ` onclick="openPlanWorkoutEdit(${escapeHTML(JSON.stringify(planWo)).replace(/"/g, '&quot;')})" style="cursor:pointer;"`;
    } else {
      const canClick = isOwnSchema && (isFuture || isToday) && !planWo?.is_rest && dayWorkouts.length === 0;
      clickAttr = canClick ? ` onclick="openPlanModal('${dayStr}', ${JSON.stringify(fakePlan).replace(/"/g, '&quot;')}, '${DAY_NAMES_FULL[i]}')" style="cursor:pointer;"` : '';
    }

    html += `<div class="sr-card${isToday ? ' sr-today' : ''}${_schemaEditMode ? ' sr-edit-mode' : ''} sr-${statusClass}"${clickAttr}>
      <div class="sr-left">
        <div class="sr-day">${DAY_NAMES[i]}</div>
        <div class="sr-date">${dayDate.getDate()}/${dayDate.getMonth() + 1}</div>
      </div>
      <div class="sr-main">
        ${mainContent}
      </div>
      <div class="sr-right-status">${rightContent}${editIcon}</div>
    </div>`;
  }

  container.innerHTML = html;
  requestAnimationFrame(() => initMapThumbnails());
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
let _mixUnit = 'hours';

function setTrendMode(mode) { trendMode = mode; loadTrends(); }
function setEffortMode(mode) { effortMode = mode; loadTrends(); }
function setMixUnit(unit) { _mixUnit = unit; loadTrends(); }

async function loadTrends() {
  if (!currentProfile) return;
  document.querySelectorAll('#view-trends .chart-skeleton').forEach(el => el.classList.add('active'));
  showViewLoading('view-trends');
  try { await _loadTrends(); } catch (e) { console.error('Trends error:', e); }
  finally {
    hideViewLoading('view-trends');
    document.querySelectorAll('#view-trends .chart-skeleton').forEach(el => el.classList.remove('active'));
  }
  // Weekly coach check-in history strip (collapsed by default, safe to fail).
  try {
    const body = document.getElementById('trends-coach-history-body');
    const card = document.getElementById('trends-coach-history');
    if (body && card) {
      await renderWeeklyCheckinHistory(body);
      card.classList.toggle('hidden', !body.innerHTML.trim());
    }
  } catch (_e) { /* ignore */ }
}
async function _loadTrends() {
  const myWorkouts = await fetchWorkouts(currentProfile.id);
  if (myWorkouts.length === 0) {
    document.querySelector('#view-trends .page-header p').textContent = 'Inga pass loggade ännu';
    return;
  }

  const weekData = {};
  const weekWorkouts = {};
  myWorkouts.forEach(w => {
    const mon = mondayOfWeek(new Date(w.workout_date));
    const key = isoDate(mon);
    if (!weekData[key]) weekData[key] = {};
    if (!weekWorkouts[key]) weekWorkouts[key] = [];
    weekData[key][w.activity_type] = (weekData[key][w.activity_type] || 0) + w.duration_minutes;
    weekWorkouts[key].push(w);
  });

  const weeks = Object.keys(weekData).sort();
  const labels = weeks.map(w => {
    const mon = parseISOWeekKeyLocal(w);
    const wn = weekNumber(mon);
    return isDeloadWeek(mon) ? `V${wn} (D)` : `V${wn}`;
  });
  const isNorm = effortMode === 'normalized';
  const yUnit = isNorm ? ' n·h' : 'h';

  const weeklyTitleEl = document.getElementById('trends-weekly-title');
  const mixTitleEl = document.getElementById('trends-mix-title');
  if (weeklyTitleEl) {
    weeklyTitleEl.textContent = isNorm ? 'Belastning per vecka (n·h)' : 'Timmar per vecka';
  }
  // mix title is set later when chart renders (respects _mixUnit toggle)

  const myData = weeks.map(w => {
    const types = trendMode === 'cardio' ? CARDIO_TYPES : [...CARDIO_TYPES, 'Gym'];
    const wos = weekWorkouts[w].filter(wo => types.includes(wo.activity_type));
    if (isNorm) {
      const raw = wos.reduce((s, wo) => s + calcWorkoutEffort(wo), 0);
      return effortRawToDisplay(raw);
    }
    return wos.reduce((s, wo) => s + durationWeightedHours(wo), 0);
  });

  const wowDeltas = myData.map((val, i) => {
    const bi = wowBaselineWeekIndex(weeks, i);
    if (bi === null) return null;
    const prev = myData[bi];
    return prev > 0 ? ((val - prev) / prev) * 100 : null;
  });

  // Week summary card moved to dashboard - clear here to avoid duplication
  const deltaEl = document.getElementById('volume-delta');
  if (deltaEl) deltaEl.innerHTML = '';
  const wsCard = document.getElementById('weekly-summary-card');
  if (wsCard) wsCard.classList.add('hidden');

  // Activity mix stacked bar
  const mixCanvas = document.getElementById('chart-mix-personal');
  if (mixCanvas) {
    if (chartMixPersonal) chartMixPersonal.destroy();
    const types = ['Löpning', 'Cykel', 'Gym', 'Annat', 'Hyrox', 'Stakmaskin', 'Längdskidor'];
    const mixIsKm = _mixUnit === 'km';
    const mixYUnit = mixIsKm ? ' km' : yUnit;

    if (mixTitleEl) mixTitleEl.textContent = mixIsKm ? 'Aktivitetsmix (km)' : (isNorm ? 'Aktivitetsmix (n·h)' : 'Aktivitetsmix (timmar)');

    const weekEffortByType = {};
    if (isNorm && !mixIsKm) {
      weeks.forEach(w => {
        weekEffortByType[w] = {};
        (weekWorkouts[w] || []).forEach(wo => {
          weekEffortByType[w][wo.activity_type] = (weekEffortByType[w][wo.activity_type] || 0) + calcWorkoutEffort(wo);
        });
      });
    }

    const datasets = types.filter(t => weeks.some(w => {
      const wos = (weekWorkouts[w] || []).filter(wo => wo.activity_type === t);
      if (mixIsKm) return wos.reduce((s, wo) => s + (wo.distance_km || 0), 0) > 0;
      if (isNorm) return (weekEffortByType[w]?.[t] || 0) > 0;
      return wos.reduce((s, wo) => s + durationWeightedHours(wo), 0) > 0;
    })).map(t => ({
      label: t,
      data: weeks.map(w => {
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
  }

  // Streak
  const streak = calcStreak(myWorkouts, currentProfile.id);
  const streakEl = document.getElementById('personal-streak');
  if (streakEl) {
    streakEl.innerHTML = `<span class="streak-badge">${streak} veckor i rad</span>`;
  }

  // Season totals: summary card + horizontal bar charts
  renderSeasonTotals(myWorkouts);

  // Effort per week chart
  renderEffortChart(myWorkouts);

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

function _elevationFactor(elevGainM, distKm) {
  if (!elevGainM || elevGainM <= 0 || !distKm || distKm <= 0) return 1.0;
  const gradient = elevGainM / (distKm * 1000);
  return Math.min(2.0, 1.0 + gradient * 10);
}

function _intensityMultiplier(w) {
  const LO = 0.8, HI = 1.2;
  // Level 1: Edwards HR zone distribution (best accuracy)
  const zs = w.hr_zone_seconds;
  if (zs && Array.isArray(zs) && zs.length >= 5) {
    const total = zs.reduce((a, b) => a + b, 0);
    if (total > 0) {
      const wi = zs.reduce((s, sec, i) => s + (sec / total) * (i + 1), 0);
      return Math.max(LO, Math.min(HI, LO + (wi - 1.0) * 0.1));
    }
  }
  // Level 2: average HR (use profile max HR if available, else workout max HR)
  const maxHr = (currentProfile?.user_max_hr && currentProfile.user_max_hr >= 100)
    ? currentProfile.user_max_hr : w.max_hr;
  if (w.avg_hr && w.avg_hr >= 30 && maxHr && maxHr >= 100) {
    const pctMax = w.avg_hr / maxHr;
    return Math.max(LO, Math.min(HI, LO + (pctMax - 0.5) * 0.8));
  }
  // Level 3: Strava perceived exertion (direct RPE 1-10)
  if (w.perceived_exertion && w.perceived_exertion >= 1) {
    const rpe = Math.min(10, w.perceived_exertion);
    return Math.max(LO, Math.min(HI, LO + (rpe - 1) * (0.4 / 9)));
  }
  // Text labels (Z2, Kvalitet) skipped -- too coarse to be reliable
  return 1.0;
}

function calcWorkoutEffort(w) {
  if (w.activity_type === 'Vila') return 0;
  const sport = SPORT_TYPE_MAP[w.activity_type] || 'Other';
  const speedMps = w.avg_speed_kmh ? w.avg_speed_kmh / 3.6 : null;
  const rpe = w.intensity ? (INTENSITY_TO_RPE[w.intensity] ?? null) : null;
  const met = _lookupMET(sport, speedMps, rpe);
  const elev = _elevationFactor(w.elevation_gain_m, w.distance_km);
  const im = _intensityMultiplier(w);
  return w.duration_minutes * met * elev * im;
}

/** Rå effort → visningsvärde (n·h) så veckosummor hamnar nära faktiska träningstimmar. */
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

function renderSeasonTotals(workouts) {
  window._lastSeasonWorkouts = workouts;
  const totalMins = workouts.reduce((s, w) => s + w.duration_minutes, 0);
  const totalHours = (totalMins / 60).toFixed(1);
  const totalSessions = workouts.length;
  const totalDist = workouts.reduce((s, w) => s + (w.distance_km || 0), 0);
  const totalEffort = workouts.reduce((s, w) => s + calcWorkoutEffort(w), 0);

  const now = new Date();
  const yearStart = new Date(now.getFullYear(), 0, 1);
  const dayOfYear = Math.floor((now - yearStart) / 86400000) + 1;
  const prevYearStart = new Date(now.getFullYear() - 1, 0, 1);
  const prevYearSameDay = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());

  function yoyDelta(cur, prev) {
    if (!prev || prev === 0) return '<span class="season-stat-delta flat">—</span>';
    const pct = Math.round(((cur - prev) / prev) * 100);
    const sign = pct > 0 ? '+' : '';
    const cls = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
    return `<span class="season-stat-delta ${cls}">${sign}${pct}% vs förra året</span>`;
  }

  const summaryEl = document.getElementById('season-totals-summary');
  if (summaryEl) {
    summaryEl.innerHTML = `<div class="season-totals-grid">
      <div class="season-stat"><span class="season-stat-val">${totalSessions}</span><span class="season-stat-label">Pass</span></div>
      <div class="season-stat"><span class="season-stat-val">${totalHours}h</span><span class="season-stat-label">Timmar</span></div>
      <div class="season-stat"><span class="season-stat-val">${totalDist.toFixed(0)}km</span><span class="season-stat-label">Distans</span></div>
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

function renderEffortChart(workouts) {
  const effortCanvas = document.getElementById('chart-effort');
  if (!effortCanvas) return;
  if (window._chartEffort) window._chartEffort.destroy();

  const weekMap = {};
  workouts.forEach(w => {
    const d = new Date(w.workout_date);
    const mon = mondayOfWeek(d);
    const key = isoDate(mon);
    if (!weekMap[key]) weekMap[key] = { effort: 0, hours: 0 };
    weekMap[key].effort += calcWorkoutEffort(w);
    weekMap[key].hours += w.duration_minutes / 60;
  });

  const weeks = Object.keys(weekMap).sort();
  const effortData = weeks.map(w => +effortRawToDisplay(weekMap[w].effort).toFixed(2));
  const hoursData = weeks.map(w => +weekMap[w].hours.toFixed(1));
  const labels = weeks.map(w => {
    const mon = parseISOWeekKeyLocal(w);
    const wn = weekNumber(mon);
    return isDeloadWeek(mon) ? `V${wn} (D)` : `V${wn}`;
  });

  const textColor = getComputedStyle(document.body).getPropertyValue('--text-dim').trim() || '#888';

  window._chartEffort = new Chart(effortCanvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Belastning (n·h)',
          data: effortData,
          backgroundColor: 'rgba(214,99,158,0.5)',
          borderColor: 'rgba(214,99,158,0.8)',
          borderWidth: 1,
          borderRadius: 3,
          order: 1,
        },
        {
          label: 'Timmar (rå)',
          data: hoursData,
          type: 'line',
          borderColor: 'rgba(46,134,193,0.7)',
          backgroundColor: 'rgba(46,134,193,0.1)',
          borderWidth: 2,
          pointRadius: 3,
          fill: false,
          order: 0,
          yAxisID: 'y1',
        }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { color: textColor, usePointStyle: true, boxWidth: 12 } },
        tooltip: {
          callbacks: {
            label: c => c.dataset.label === 'Belastning (n·h)'
              ? `Belastning: ${c.parsed.y.toFixed(1)} n·h`
              : `Timmar: ${c.parsed.y.toFixed(1)} h`,
            afterBody: (items) => {
              if (!items.length) return [];
              const i = items[0].dataIndex;
              const e = effortData[i];
              const h = hoursData[i];
              return [`Sammanhang: ${e.toFixed(1)} n·h  ·  ${h.toFixed(1)} h faktisk tid`];
            },
          }
        }
      },
      scales: {
        y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: textColor, callback: v => v + ' n·h' }, title: { display: true, text: 'n·h (skalad)', color: textColor } },
        y1: { beginAtZero: true, position: 'right', grid: { display: false }, ticks: { color: textColor, callback: v => v + 'h' }, title: { display: true, text: 'Timmar', color: textColor } },
        x: { grid: { display: false }, ticks: { color: textColor, maxRotation: 45, minRotation: 0 } }
      }
    }
  });

  const legendEl = document.getElementById('effort-legend');
  if (legendEl) {
    legendEl.innerHTML = `
      <div class="effort-legend-item"><span class="effort-legend-dot" style="background:rgba(214,99,158,0.8)"></span> n·h = normaliserade timmar: rå effort delat med ${EFFORT_DISPLAY_DIVISOR} (≈ 1 h @ MET 10), samma skala som graferna ovan. Timmar-linjen är faktisk tid.</div>
    `;
  }
}

function calcStreak(workouts, profileId) {
  if (!profileId) return 0;
  const pw = workouts.filter(w => w.profile_id === profileId);
  const now = new Date();
  const todayDow = (now.getDay() + 6) % 7;
  let checkMonday = mondayOfWeek(now);

  // If current week is incomplete (not Sunday yet), check if it qualifies so far;
  // if not, skip it and start counting from last week
  if (todayDow < 6) {
    const sun = addDays(checkMonday, 6);
    const weekW = pw.filter(w => w.workout_date >= isoDate(checkMonday) && w.workout_date <= isoDate(sun));
    const totalMins = weekW.reduce((s, w) => s + w.duration_minutes, 0);
    if (totalMins < 60) {
      checkMonday = addDays(checkMonday, -7);
    }
  }

  let streak = 0;
  while (true) {
    const sun = addDays(checkMonday, 6);
    const weekW = pw.filter(w => w.workout_date >= isoDate(checkMonday) && w.workout_date <= isoDate(sun));
    const totalMins = weekW.reduce((s, w) => s + w.duration_minutes, 0);
    if (totalMins >= 60) { streak++; checkMonday = addDays(checkMonday, -7); }
    else break;
  }
  return streak;
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
  renderGroupFeed(allWorkouts, members);

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
  const gUnit = isGrpNorm ? ' n·h' : 'h';
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

  const weeks = Object.keys(weekData).sort();
  const labels = weeks.map(w => {
    const mon = parseISOWeekKeyLocal(w);
    const wn = weekNumber(mon);
    return isDeloadWeek(mon) ? `V${wn} (D)` : `V${wn}`;
  });

  if (chartGroupWeekly) chartGroupWeekly.destroy();
  const canvas = document.getElementById('chart-group-weekly');
  if (!canvas) return;

  const titleEl = document.getElementById('grp-chart-title');
  if (titleEl) titleEl.textContent = isGrpNorm ? 'Belastning per vecka (n·h)' : 'Timmar per vecka';

  const datasets = members.map((m, i) => ({
    label: m.name.split(' ')[0],
    data: weeks.map(w => isGrpNorm ? +effortRawToDisplay(weekData[w]?.[m.id] || 0).toFixed(2) : (weekData[w]?.[m.id] || 0) / 60),
    borderColor: colors[i % colors.length],
    backgroundColor: colors[i % colors.length] + '18',
    tension: 0.35, fill: true, pointRadius: 5, pointHoverRadius: 7, borderWidth: 2.5
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

  const weeks = Object.keys(weekMap).sort();
  const labels = weeks.map(w => {
    const mon = parseISOWeekKeyLocal(w);
    const wn = weekNumber(mon);
    return isDeloadWeek(mon) ? `V${wn} (D)` : `V${wn}`;
  });
  const textColor = getComputedStyle(document.body).getPropertyValue('--text-dim').trim() || '#888';

  const datasets = members.map((m, i) => ({
    label: m.name.split(' ')[0],
    data: weeks.map(w => +effortRawToDisplay(weekMap[w]?.[m.id]?.effort || 0).toFixed(2)),
    backgroundColor: colors[i % colors.length] + '88',
    borderColor: colors[i % colors.length],
    borderWidth: 1,
    borderRadius: 3,
  }));

  window._chartGroupEffort = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: { position: 'bottom', labels: { color: textColor, usePointStyle: true, padding: 16 } },
        tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.parsed.y.toFixed(1)} n·h` } }
      },
      scales: {
        y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: textColor, callback: v => v + ' n·h' }, title: { display: true, text: 'n·h', color: textColor } },
        x: { grid: { display: false }, ticks: { color: textColor } }
      }
    }
  });

  const legendEl = document.getElementById('group-effort-legend');
  if (legendEl) {
    legendEl.innerHTML = `<div class="effort-legend-item"><span class="effort-legend-dot" style="background:rgba(214,99,158,0.8)"></span> n·h = skalad belastning (rå effort ÷ ${EFFORT_DISPLAY_DIVISOR}), samma som på Din progress.</div>`;
  }
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

  const token = (await sb.auth.getSession()).data.session.access_token;
  try {
    const resp = await fetch(SUPABASE_URL + '/rest/v1/groups?code=eq.' + code + '&select=id,name', {
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + token }
    });
    const groups = await resp.json();
    if (groups.length === 0) { errEl.textContent = 'Ingen grupp med den koden'; errEl.classList.remove('hidden'); return; }
    await fetch(SUPABASE_URL + '/rest/v1/profiles?id=eq.' + currentProfile.id, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ group_id: groups[0].id })
    });
    currentProfile.group_id = groups[0].id;
    showToast('Du gick med i gruppen!');
    loadGroup();
  } catch (e) { errEl.textContent = 'Något gick fel'; errEl.classList.remove('hidden'); }
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

function updateGroupSettingsCard() {
  const card = document.getElementById('group-settings-card');
  const info = document.getElementById('group-settings-info');
  if (!card || !info) return;
  if (!currentProfile?.group_id) {
    if (card) card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');
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

    return { m, mi, totalMins, missedCount, sessionCount, daysHTML };
  });

  memberStats.sort((a, b) => b.sessionCount - a.sessionCount || b.totalMins - a.totalMins);

  const cards = memberStats.map(({ m, mi, totalMins, missedCount, sessionCount, daysHTML }) => {
    const isMe = m.id === currentProfile.id;
    const nudgeId = `nudge-${m.id}`;
    const canNudge = !isMe && missedCount > 0;
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

function renderFeedItems(items, members, reactions, comments) {
  const colors = ['#2E86C1', '#E74C3C', '#2ECC71', '#9B59B6', '#F39C12', '#1ABC9C'];
  return items.map(w => {
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

    const intBadge = w.intensity ? `<span class="intensity-badge">${escapeHTML(w.intensity)}</span>` : '';
    const notesSnip = w.notes && w.notes !== 'Importerad' ? `<div class="feed-notes">${escapeHTML(w.notes)}</div>` : '';

    let lastCommentHtml = '';
    if (lastComment) {
      const commenter = members.find(m => m.id === lastComment.profile_id);
      const commenterName = commenter ? commenter.name : '?';
      const truncated = lastComment.text.length > 80 ? lastComment.text.slice(0, 80) + '...' : lastComment.text;
      lastCommentHtml = `<div class="feed-last-comment"><span class="feed-comment-author">${escapeHTML(commenterName)}</span> ${escapeHTML(truncated)}</div>`;
    }

    return `<div class="feed-item" onclick="openFeedWorkout(${globalIdx})">
      <div class="feed-header">
        <div class="feed-avatar" style="background:${color}">${escapeHTML((member.name || '?')[0].toUpperCase())}</div>
        <div class="feed-info">
          <div class="feed-name">${escapeHTML(member.name || '?')}</div>
          <div class="feed-date">${escapeHTML(formatDate(w.workout_date))}</div>
        </div>
        <div class="feed-type">${activityEmoji(w.activity_type)} ${w.duration_minutes}'${intBadge}</div>
      </div>
      ${notesSnip}
      <div class="feed-reactions" onclick="event.stopPropagation()">
        <button class="react-btn-sm${myReaction?.reaction === 'like' ? ' active' : ''}" onclick="event.stopPropagation();handleFeedReaction('${escapeHTML(w.id)}','like')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg> ${likes.length || ''}
        </button>
        <button class="react-btn-sm${myReaction?.reaction === 'dislike' ? ' active' : ''}" onclick="event.stopPropagation();handleFeedReaction('${escapeHTML(w.id)}','dislike')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14"><path d="M10 15V19a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z"/><path d="M17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg> ${dislikes.length || ''}
        </button>
        <span class="feed-comment-count">💬 ${commentCount || ''}</span>
      </div>
      ${lastCommentHtml}
    </div>`;
  }).join('');
}

function openFeedWorkout(idx) {
  if (!_feedReactionsCache) return;
  const w = _feedReactionsCache.recent[idx];
  if (w) openWorkoutModal(w);
}

async function handleFeedReaction(workoutId, type) {
  await toggleReaction(workoutId, type);
  if (_cachedGroupWorkouts.length && _cachedGroupMembers.length) {
    await renderGroupFeed(_cachedGroupWorkouts, _cachedGroupMembers);
  }
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
    const res = await fetch(SUPABASE_FUNCTIONS_URL + '/strava-sync', {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + session.access_token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ profile_id: currentProfile.id, since: _stravaConnection.last_sync_at || null }),
    });
    if (res.ok) {
      const result = await res.json();
      console.log(`Strava auto-sync: imported=${result.imported}, fetched=${result.totalFetched}, skipped=${result.skipped}`, result.debug);
      if (result.last_sync_at) _stravaConnection.last_sync_at = result.last_sync_at;
      updateStravaUI();
      if (result.imported > 0) navigate(currentView);
    }
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
    lines.push('• Aktiviteterna är äldre än sökperioden (synk tittar 14 dagar bakåt; använd "Synka allt" för längre).');
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
    const { data: { session } } = await sb.auth.getSession();
    const res = await fetch(SUPABASE_FUNCTIONS_URL + '/strava-sync', {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + session.access_token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ profile_id: currentProfile.id, since: _stravaConnection.last_sync_at || null }),
    });

    const result = await res.json();
    if (res.ok) {
      if (result.last_sync_at) _stravaConnection.last_sync_at = result.last_sync_at;
      updateStravaUI();
      console.log(`Strava sync: imported=${result.imported}, fetched=${result.totalFetched}, skipped=${result.skipped} (short=${result.skippedShort||0}, type=${result.skippedType||0}, error=${result.skippedError||0})`, result.debug);
      await showAlertModal('Synk klar', buildStravaSyncMessage(result));
      navigate(currentView);
    } else {
      await showAlertModal('Synk-fel', result.error || 'Okänt fel');
    }
  } catch (e) {
    console.error('Strava sync error:', e);
    await showAlertModal('Synk-fel', 'Nätverksfel vid synkning');
  }

  if (btn) { btn.classList.remove('syncing'); btn.textContent = 'Synka'; }
}

async function syncStravaAll() {
  if (!_stravaConnection || !currentProfile) return;
  const confirmed = await showConfirmModal(
    'Synka allt från Strava',
    'Detta hämtar alla aktiviteter från Strava, inte bara nya. Det tar längre tid och behövs normalt bara om data saknas.\n\nVanlig synk sker automatiskt varje timme.',
    'Synka allt ändå',
    false
  );
  if (!confirmed) return;
  const btn = document.querySelector('.strava-deep-sync-btn');
  if (btn) { btn.classList.add('syncing'); btn.textContent = 'Synkar...'; }

  try {
    const { data: { session } } = await sb.auth.getSession();
    const res = await fetch(SUPABASE_FUNCTIONS_URL + '/strava-sync', {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + session.access_token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ profile_id: currentProfile.id, since: null }),
    });

    const result = await res.json();
    if (res.ok) {
      if (result.last_sync_at) _stravaConnection.last_sync_at = result.last_sync_at;
      updateStravaUI();
      if (result.debug) console.log('Strava deep sync debug:', result.debug);
      await showAlertModal('Full synk klar', buildStravaSyncMessage(result, true));
      navigate(currentView);
    } else {
      await showAlertModal('Synk-fel', result.error || 'Okänt fel');
    }
  } catch (e) {
    console.error('Strava deep sync error:', e);
    await showAlertModal('Synk-fel', 'Nätverksfel vid synkning');
  }

  if (btn) { btn.classList.remove('syncing'); btn.textContent = 'Synka allt'; }
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

// ── Plan info bar ──

function updatePlanInfoBar(plan, planWeeks) {
  const bar = document.getElementById('plan-info-bar');
  if (!plan) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');

  const goalEl = document.getElementById('pib-goal');
  goalEl.textContent = plan.goal_text || GOAL_TYPES.find(g => g.id === plan.goal_type)?.label || plan.goal_type;

  const today = isoDate(new Date());
  const currentWeek = planWeeks.find(w => {
    const weekStart = new Date(plan.start_date);
    weekStart.setDate(weekStart.getDate() + (w.week_number - 1) * 7);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);
    return today >= isoDate(weekStart) && today <= isoDate(weekEnd);
  });

  const phaseEl = document.getElementById('pib-phase');
  if (currentWeek) {
    const phaseLabel = PHASE_LABELS[currentWeek.phase] || currentWeek.phase;
    phaseEl.textContent = `${phaseLabel} — V${currentWeek.week_number}`;
    phaseEl.className = `pib-phase phase-badge phase-${currentWeek.phase}`;
  } else {
    phaseEl.textContent = '';
  }

  const totalWeeks = planWeeks.length;
  const startD = new Date(plan.start_date);
  const todayD = new Date();
  const elapsedWeeks = Math.max(0, Math.floor((todayD - startD) / (7 * 86400000)));
  const pct = Math.min(100, Math.round((elapsedWeeks / totalWeeks) * 100));

  document.getElementById('pib-progress-fill').style.width = pct + '%';
  document.getElementById('pib-progress-label').textContent = `${elapsedWeeks}/${totalWeeks}v`;
}

// ── Edit mode toggle ──

function toggleSchemaEditMode() {
  _schemaEditMode = !_schemaEditMode;
  const label = document.getElementById('schema-edit-label');
  const toggle = document.getElementById('schema-edit-toggle');
  if (label) label.textContent = _schemaEditMode ? 'Avsluta redigering' : 'Redigera pass';
  if (toggle) toggle.classList.toggle('active', _schemaEditMode);
  loadSchema();
}

function updateSchemaEditBar() {
  const bar = document.getElementById('schema-edit-bar');
  if (!bar) return;
  bar.classList.toggle('hidden', !_activePlan);
}

// ── Generate button ──

function renderGenerateButton() {
  const container = document.getElementById('schema-generate-btn-container');
  if (!container) return;
  if (!PLAN_GENERATION_ENABLED) { container.innerHTML = ''; return; }
  if (!currentProfile) { container.innerHTML = ''; return; }

  const label = _activePlan
    ? (_activePlan.name || _activePlan.goal_text || 'Träningsplan')
    : 'Hantera schema';
  const aiBadge = _activePlan?.generation_model ? '<span class="schema-pill-ai">AI</span>' : '';

  container.innerHTML = `
    <div class="schema-pill-row">
      <button class="schema-plan-pill" onclick="openPlanManager()">
        <span class="schema-pill-label">${label}${aiBadge}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      <button class="schema-plan-pill schema-plan-pill--create" onclick="openPlanWizard()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        <span class="schema-pill-label">Skapa nytt schema</span>
      </button>
    </div>`;
}

// ═══════════════════════
//  PLAN WIZARD
// ═══════════════════════

function openPlanWizard() {
  _wizardStep = 0;
  _wizardShowIntro = true;
  _wizardGoalType = null;

  const grid = document.getElementById('wizard-goal-grid');
  grid.innerHTML = GOAL_TYPES.map(g =>
    `<div class="wizard-goal-card" data-goal="${g.id}" onclick="selectWizardGoal('${g.id}')">
      <span class="goal-icon">${g.icon}</span>
      <span>${g.label}</span>
    </div>`
  ).join('');

  document.getElementById('wizard-goal-fields').classList.add('hidden');
  document.getElementById('wiz-race-fields').style.display = 'none';

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
  document.getElementById('wiz-max-hr').value = '';
  document.getElementById('wiz-recent-5k').value = '';
  document.getElementById('wiz-recent-10k').value = '';
  document.getElementById('wiz-easy-pace').value = '';

  autoPopulateBaseline();
  updateWizardUI();
  document.getElementById('plan-wizard').classList.remove('hidden');
}

function closePlanWizard() {
  document.getElementById('plan-wizard').classList.add('hidden');
}

function selectWizardGoal(goalId) {
  _wizardGoalType = goalId;
  document.querySelectorAll('.wizard-goal-card').forEach(c => c.classList.toggle('selected', c.dataset.goal === goalId));
  document.getElementById('wizard-goal-fields').classList.remove('hidden');
  document.getElementById('wiz-race-fields').style.display = (goalId === 'race') ? '' : 'none';

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
  for (let i = 0; i <= 2; i++) {
    const introEl = document.getElementById(`wizard-intro-${i}`);
    const stepEl = document.getElementById(`wizard-step-${i}`);
    if (introEl) introEl.classList.toggle('active', _wizardShowIntro && i === _wizardStep);
    if (stepEl) stepEl.classList.toggle('active', !_wizardShowIntro && i === _wizardStep);
  }

  // Progress dots: current step is active; earlier steps are done. On intro,
  // the current step has not been completed yet, so use the same rule.
  document.querySelectorAll('.wizard-step-dot').forEach(dot => {
    const s = parseInt(dot.dataset.step);
    dot.classList.toggle('active', s === _wizardStep);
    dot.classList.toggle('done', s < _wizardStep);
  });

  // Back button is hidden only on the very first intro screen.
  const prevBtn = document.getElementById('wiz-prev');
  const atFirstScreen = _wizardStep === 0 && _wizardShowIntro;
  prevBtn.style.visibility = atFirstScreen ? 'hidden' : 'visible';

  // Next button label reflects where we're going.
  const nextBtn = document.getElementById('wiz-next');
  if (_wizardShowIntro) {
    nextBtn.textContent = 'Fortsätt';
  } else if (_wizardStep === 2) {
    nextBtn.textContent = 'Generera schema';
  } else {
    nextBtn.textContent = 'Nästa';
  }

  const stepBanner = document.getElementById('wizard-step-banner');
  if (stepBanner) stepBanner.textContent = `Steg ${_wizardStep + 1} av 3`;

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
  // Flow backwards through: intro 0 → form 0 → intro 1 → form 1 → intro 2 → form 2
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

  if (_wizardStep < 2) {
    _wizardStep++;
    _wizardShowIntro = true;
    updateWizardUI();
    return;
  }

  await submitPlanWizard();
}

async function submitPlanWizard() {
  const goalText = document.getElementById('wiz-goal-text').value.trim();
  const goalDate = document.getElementById('wiz-goal-date').value || null;
  const goalTime = document.getElementById('wiz-goal-time').value.trim();

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
    await showAlertModal('Saknar mål', 'Beskriv ditt mål innan du genererar.');
    return;
  }
  if (activityTypes.length === 0) {
    await showAlertModal('Saknar aktiviteter', 'Välj minst en aktivitetstyp.');
    return;
  }

  const activityMix = {};
  const pct = Math.round(100 / activityTypes.length);
  activityTypes.forEach((t, i) => {
    activityMix[t] = i === activityTypes.length - 1 ? 100 - pct * (activityTypes.length - 1) : pct;
  });

  const payload = {
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
    },
    start_date: startDate,
  };

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
    closePlanWizard();
    document.getElementById('wizard-step-loading').style.display = 'none';
    document.getElementById('wizard-nav').style.display = '';

    await showAlertModal('Schema skapat!', `${result.plan_name}\n${result.weeks} veckor: ${result.start_date} till ${result.end_date}`);

    _activePlan = null;
    _activePlanWeeks = [];
    _activePlanWorkouts = [];
    navigate('dashboard');

  } catch (e) {
    console.error('Plan generation error:', e);
    stopWizRunLoader();
    document.getElementById('wizard-step-loading').style.display = 'none';
    document.getElementById('wizard-nav').style.display = '';
    _wizardStep = 2;
    _wizardShowIntro = false;
    updateWizardUI();
    await showAlertModal('Fel', 'Kunde inte generera schema: ' + e.message);
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
  _wizRunFactTimer = setInterval(showNextWizRunFact, 3800);
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

  let grid = '';
  for (let d = 0; d < 7; d++) {
    const wo = weekWo.find(w => w.day_of_week === d);
    if (wo?.is_rest) {
      grid += `<div class="pm-prev-day"><span class="pm-prev-day-name">${DAY[d]}</span><span class="pm-prev-rest">Vila</span></div>`;
    } else if (wo) {
      const zone = wo.intensity_zone ? `<span class="zone-badge zone-${escapeHTML(wo.intensity_zone.toLowerCase())}" style="font-size:0.6rem;padding:1px 4px;">${escapeHTML(wo.intensity_zone)}</span>` : '';
      const dur = wo.target_duration_minutes ? `${wo.target_duration_minutes}m` : '';
      grid += `<div class="pm-prev-day"><span class="pm-prev-day-name">${DAY[d]}</span><span class="pm-prev-label">${escapeHTML(wo.label || wo.activity_type)}</span><span class="pm-prev-meta">${zone} ${dur}</span></div>`;
    } else {
      grid += `<div class="pm-prev-day"><span class="pm-prev-day-name">${DAY[d]}</span><span class="pm-prev-rest">—</span></div>`;
    }
  }

  const isActive = plan.status === 'active';
  const phaseLabel = PHASE_LABELS[week.phase] || week.phase || '';

  return `
    <div class="pm-preview-summary">
      <div class="pm-preview-phases">${phaseStr}</div>
      <div class="pm-preview-weeks-label">${weeks.length} veckor · ${plan.start_date} — ${plan.end_date}</div>
    </div>
    <div class="pm-preview-week-nav">
      <button class="pm-prev-arrow" onclick="event.stopPropagation();pmPreviewWeek('${plan.id}',-1)" ${clampedIdx === 0 ? 'disabled' : ''}>‹</button>
      <span class="pm-prev-week-label">Vecka ${week.week_number}${phaseLabel ? ' · ' + phaseLabel : ''}</span>
      <button class="pm-prev-arrow" onclick="event.stopPropagation();pmPreviewWeek('${plan.id}',1)" ${clampedIdx >= weeks.length - 1 ? 'disabled' : ''}>›</button>
    </div>
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

function openPlanEditModal() {
  if (!_activePlan) return;
  _planEditHistory = [];
  _planEditProposal = null;
  _planEditCurrentPlan = null;
  const chatEl = document.getElementById('plan-edit-chat');
  chatEl.innerHTML = `<div class="plan-edit-msg bot">Beskriv vilka ändringar du vill göra i schemat, t.ex. "byt torsdagens pass mot tempo" eller "minska volymen vecka 3". Du får granska förslaget innan det sparas.</div>`;
  document.getElementById('plan-edit-input').value = '';
  document.getElementById('plan-edit-modal').classList.remove('hidden');
}

function closePlanEditModal() {
  document.getElementById('plan-edit-modal').classList.add('hidden');
  _planEditProposal = null;
}

function _buildDiffSummary(oldPlan, newPlan) {
  const DAY = ['Man', 'Tis', 'Ons', 'Tors', 'Fre', 'Lor', 'Son'];
  const changes = [];
  const oldWeeks = oldPlan.weeks || [];
  const newWeeks = newPlan.weeks || [];
  const maxWeeks = Math.max(oldWeeks.length, newWeeks.length);

  for (let wi = 0; wi < maxWeeks; wi++) {
    const ow = oldWeeks[wi];
    const nw = newWeeks[wi];
    if (!nw) { changes.push(`Vecka ${wi + 1}: borttagen`); continue; }
    if (!ow) { changes.push(`Vecka ${nw.week_number}: ny (${nw.phase})`); continue; }
    const owWo = ow.workouts || [];
    const nwWo = nw.workouts || [];
    for (let d = 0; d < 7; d++) {
      const o = owWo.find(w => w.day_of_week === d);
      const n = nwWo.find(w => w.day_of_week === d);
      if (!o && !n) continue;
      const oLabel = o ? (o.is_rest ? 'Vila' : `${o.label || o.activity_type} ${o.target_duration_minutes || 0}min ${o.intensity_zone || ''}`.trim()) : '(tom)';
      const nLabel = n ? (n.is_rest ? 'Vila' : `${n.label || n.activity_type} ${n.target_duration_minutes || 0}min ${n.intensity_zone || ''}`.trim()) : '(tom)';
      if (oLabel !== nLabel) {
        changes.push(`v${nw.week_number} ${DAY[d]}: ${oLabel} → ${nLabel}`);
      }
    }
  }
  return changes.length > 0 ? changes : ['Inga synliga ändringar.'];
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
  chatEl.innerHTML += `<div class="plan-edit-msg user">${escapeHTML(instruction)}</div>`;
  chatEl.innerHTML += `<div class="plan-edit-msg bot" id="plan-edit-loading"><span class="spinner-sm"></span> Genererar förslag...</div>`;
  input.value = '';
  sendBtn.disabled = true;
  chatEl.scrollTop = chatEl.scrollHeight;

  _planEditHistory.push({ role: 'user', content: instruction });

  try {
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
        current_plan: currentPlan,
        conversation_history: _planEditHistory.slice(0, -1),
      }),
    });

    const result = await res.json();
    const loadingEl = document.getElementById('plan-edit-loading');
    if (loadingEl) loadingEl.remove();

    if (!res.ok) throw new Error(result.error || 'Preview failed');

    _planEditProposal = result.proposed_plan;
    const diff = _buildDiffSummary(currentPlan, _planEditProposal);
    const diffHtml = diff.map(d => `<div class="pe-diff-line">${escapeHTML(d)}</div>`).join('');

    chatEl.innerHTML += `<div class="plan-edit-msg bot">
      <div class="pe-diff-title">Föreslagna ändringar:</div>
      <div class="pe-diff-list">${diffHtml}</div>
      <div class="pe-diff-actions">
        <button class="btn btn-primary btn-sm" onclick="approvePlanEdit()">Godkann</button>
        <button class="btn btn-outline btn-sm" onclick="document.getElementById('plan-edit-input').focus();">Andra</button>
      </div>
    </div>`;

    _planEditHistory.push({ role: 'assistant', content: 'Proposed changes: ' + diff.join('; ') });
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
    const badge = document.getElementById('friend-request-badge');
    if (!badge) return;
    if (count > 0) {
      badge.textContent = count > 9 ? '9+' : count;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  } catch (e) { console.error('updateFriendRequestBadge error:', e); }
}

async function topbarSearchUsers() {
  const q = document.getElementById('topbar-search-input').value.trim().toLowerCase();
  const resultsEl = document.getElementById('topbar-search-results');
  if (q.length < 2) { resultsEl.innerHTML = ''; return; }

  await refreshAllProfiles();

  const matches = allProfiles.filter(p =>
    p.id !== currentProfile.id &&
    p.name.toLowerCase().includes(q)
  );

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
  const q = document.getElementById('friend-search-input').value.trim().toLowerCase();
  const resultsEl = document.getElementById('friend-search-results');
  if (q.length < 2) { resultsEl.innerHTML = ''; return; }

  await refreshAllProfiles();

  const matches = allProfiles.filter(p =>
    p.id !== currentProfile.id &&
    p.name.toLowerCase().includes(q)
  );

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
    const isEmoji = p?.avatar && p.avatar.length <= 2;
    const wDate = new Date(w.workout_date).toLocaleDateString('sv-SE', { weekday: 'short', day: 'numeric', month: 'short' });
    const intBadge = w.intensity ? ` <span class="intensity-badge">${escapeHTML(w.intensity)}</span>` : '';
    const distText = w.distance_km ? ` · ${w.distance_km} km` : '';
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

    const mapHtml = w.map_polyline ? `<div class="wo-map wo-map-side" id="sf-map-${escapeHTML(w.id)}" data-polyline="${escapeHTML(w.map_polyline)}"></div>` : '';

    // SECURITY: pass workout id via data-attribute and look up the full object
    // on click rather than serialising DB-sourced fields into an inline handler.
    const likeActive = myReaction?.reaction === 'like' ? ' liked' : '';
    const dislikeActive = myReaction?.reaction === 'dislike' ? ' liked' : '';
    const reactBtns = isOwnWorkout
      ? `<span class="sf-action-btn sf-action-static" title="Du kan inte reagera p\u00e5 ditt eget pass">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>
          ${wLikes.length > 0 ? wLikes.length : ''}
        </span>
        <span class="sf-action-btn sf-action-static">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M10 15V19a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z"/><path d="M17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg>
          ${wDislikes.length > 0 ? wDislikes.length : ''}
        </span>`
      : `<button class="sf-action-btn${likeActive}" onclick="toggleSocialReaction('${escapeHTML(w.id)}','like')" title="Bra pass">
          <svg viewBox="0 0 24 24" fill="${myReaction?.reaction === 'like' ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>
          ${wLikes.length > 0 ? wLikes.length : ''}
        </button>
        <button class="sf-action-btn${dislikeActive}" onclick="toggleSocialReaction('${escapeHTML(w.id)}','dislike')" title="Hmm \u2026">
          <svg viewBox="0 0 24 24" fill="${myReaction?.reaction === 'dislike' ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M10 15V19a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z"/><path d="M17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg>
          ${wDislikes.length > 0 ? wDislikes.length : ''}
        </button>`;
    const profileClick = isOwnWorkout ? '' : `onclick="event.stopPropagation();openFriendProfile('${escapeHTML(w.profile_id)}')"`;
    const profileCursor = isOwnWorkout ? '' : 'cursor:pointer;';
    return `<div class="social-feed-item" data-workout-id="${escapeHTML(w.id)}">
      <div class="sf-header">
        <div class="sf-avatar" style="background:${isEmoji ? 'transparent' : color};font-size:${isEmoji ? '1rem' : '0.75rem'};${profileCursor}" ${profileClick}>${escapeHTML(avatar)}</div>
        <span class="sf-name" style="${profileCursor}" ${profileClick}>${escapeHTML(name)}</span>
        <span class="sf-date">${escapeHTML(wDate)}</span>
      </div>
      <div class="sf-body sf-body-clickable${w.map_polyline ? ' sf-body-with-map' : ''}" data-workout-open-id="${escapeHTML(w.id)}">
        <div class="sf-body-text">
          ${buildWorkoutBody(w)}
          ${w.notes && w.notes !== 'Importerad' && !w.notes?.startsWith('[Strava]') ? `<div class="wo-notes">${escapeHTML(w.notes)}</div>` : ''}
        </div>
        ${mapHtml}
      </div>
      <div class="sf-actions">
        ${reactBtns}
        <button class="sf-action-btn" onclick="toggleSocialComments('${escapeHTML(w.id)}')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          ${wComments.length > 0 ? wComments.length : ''}
        </button>
      </div>
      <div class="sf-comments hidden" id="sf-comments-${escapeHTML(w.id)}">${commentsHtml}</div>
      <div class="sf-comment-form hidden" id="sf-comment-form-${escapeHTML(w.id)}">
        <input type="text" placeholder="Skriv en kommentar..." onkeydown="if(event.key==='Enter')submitSocialComment('${escapeHTML(w.id)}',this)">
        <button onclick="submitSocialComment('${escapeHTML(w.id)}',this.previousElementSibling)">Skicka</button>
      </div>
    </div>`;
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

async function toggleSocialReaction(workoutId, reactionType) {
  try {
    await toggleReaction(workoutId, reactionType);
    await refreshSocialFeedReactionButtons(workoutId);
  } catch (e) {
    console.error('Toggle reaction error:', e);
  }
}

async function refreshSocialFeedReactionButtons(workoutId) {
  const reactions = await fetchReactions(workoutId);
  const likes = reactions.filter(r => r.reaction === 'like');
  const dislikes = reactions.filter(r => r.reaction === 'dislike');
  const myReaction = reactions.find(r => r.profile_id === currentProfile.id);

  const item = document.querySelector(`.social-feed-item[data-workout-id="${CSS.escape(workoutId)}"]`);
  if (!item) return;
  const actionBtns = item.querySelectorAll('.sf-action-btn');
  actionBtns.forEach(btn => {
    const handler = btn.getAttribute('onclick') || '';
    if (handler.includes("'like'")) {
      btn.classList.toggle('liked', myReaction?.reaction === 'like');
      const svg = btn.querySelector('svg');
      if (svg) svg.setAttribute('fill', myReaction?.reaction === 'like' ? 'currentColor' : 'none');
      const countText = likes.length > 0 ? ' ' + likes.length : '';
      btn.innerHTML = '';
      if (svg) btn.appendChild(svg);
      if (countText) btn.append(countText);
    } else if (handler.includes("'dislike'")) {
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

    const commentBtn = commentsEl.closest('.social-feed-item').querySelector('.sf-action-btn:nth-child(2)');
    if (commentBtn) {
      const svg = commentBtn.querySelector('svg');
      commentBtn.innerHTML = '';
      commentBtn.appendChild(svg);
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
