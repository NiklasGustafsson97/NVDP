/* ══════════════════════════════════════════
   NVDP — Main Application Logic
   ══════════════════════════════════════════ */

// ── Supabase Client ──
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── App State ──
let currentUser = null;
let currentProfile = null;
let allProfiles = [];
let currentView = 'dashboard';
let schemaPersonIdx = 0;
let schemaWeekOffset = 0;
let trendMode = 'cardio';
let chartWeekly = null;
let selectedWorkout = null;
let editingWorkoutId = null;

// ── Day Names ──
const DAY_NAMES = ['Mån', 'Tis', 'Ons', 'Tors', 'Fre', 'Lör', 'Sön'];
const DAY_NAMES_FULL = ['Måndag', 'Tisdag', 'Onsdag', 'Torsdag', 'Fredag', 'Lördag', 'Söndag'];

// ── Init ──
let _initDone = false;

function gateOpen() {
  return sessionStorage.getItem('gate_passed') === '1';
}

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
        showAuth();
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
    if (error) { errEl.style.color = 'var(--red)'; errEl.textContent = error.message; errEl.classList.remove('hidden'); return; }
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
        errEl.textContent = error.message;
        errEl.classList.remove('hidden');
        return;
      }
      btn.textContent = 'Laddar...';
      // If onAuthStateChange doesn't fire within 3s, manually init
      setTimeout(async () => {
        if (!_initDone && signInData?.session) {
          console.warn('Auth state change did not fire, manually initializing');
          await initApp(signInData.session.user, signInData.session.access_token);
        }
      }, 3000);
    } catch (ex) {
      btn.disabled = false;
      btn.textContent = 'Logga in';
      errEl.style.color = 'var(--red)';
      errEl.textContent = ex.message || 'Något gick fel. Försök igen.';
      errEl.classList.remove('hidden');
    }
  }
});

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
  document.getElementById('side-menu').classList.add('open');
  document.getElementById('side-menu-overlay').classList.remove('hidden');
  updateSideMenuContent();
}

function closeSideMenu() {
  document.getElementById('side-menu').classList.remove('open');
  document.getElementById('side-menu-overlay').classList.add('hidden');
}

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('nvdp-theme', theme);
  const toggle = document.querySelector('#theme-toggle input');
  if (toggle) toggle.checked = theme === 'light';
  if (window._chartSeasonPie) { window._chartSeasonPie.update(); }
  if (window.chartWeekly) { window.chartWeekly.update(); }
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
    navigate(currentView);

    updateNudgeBadge();
    registerPushSubscription();
    checkStravaConnection();
    handleStravaRedirect();
    checkGarminConnection();
    handleGarminRedirect();
  } catch (err) {
    console.error('initApp error:', err);
    document.getElementById('app').classList.add('active');
  }
}

// ═══════════════════════
//  NAVIGATION
// ═══════════════════════
function navigate(view) {
  currentView = view;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const viewEl = document.getElementById('view-' + view);
  if (viewEl) viewEl.classList.add('active');
  const navEl = document.querySelector(`.nav-item[data-view="${view}"]`);
  if (navEl) navEl.classList.add('active');

  if (view === 'dashboard' || view === 'schema' || view === 'trends') {
    _activePlan = null;
    _activePlanWeeks = [];
    _activePlanWorkouts = [];
  }
  if (view === 'dashboard') loadDashboard();
  else if (view === 'log') resetLogForm();
  else if (view === 'schema') loadSchema();
  else if (view === 'trends') loadTrends();
  else if (view === 'group') loadGroup();
  else if (view === 'social') loadSocial();
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
  const p1Start = new Date(P1_START);
  const p2Start = new Date(P2_START);
  let weeksSinceStart;
  const md = new Date(mondayDate);
  if (md >= p2Start) {
    weeksSinceStart = Math.floor((md - p2Start) / (7 * 86400000));
  } else {
    weeksSinceStart = Math.floor((md - p1Start) / (7 * 86400000));
  }
  return weeksSinceStart >= 0 && (weeksSinceStart + 1) % 4 === 0;
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
  try { await _loadDashboard(); } catch (e) { console.error('Dashboard error:', e); }
  hideViewLoading('view-dashboard');
}
async function _loadDashboard() {
  const now = new Date();
  const dayOfWeek = (now.getDay() + 6) % 7; // 0=Mon
  const name = currentProfile?.name || 'du';
  const firstName = name.split(' ')[0];

  document.getElementById('dash-greeting').textContent = `Hej ${firstName}!`;
  document.getElementById('dash-date').textContent = now.toLocaleDateString('sv-SE', { weekday: 'long', day: 'numeric', month: 'long' });

  const todayEl = document.getElementById('today-content');
  const tomorrowEl = document.getElementById('tomorrow-content');
  const todayStr = isoDate(now);
  const tomorrowDate = addDays(now, 1);
  const tomorrowStr = isoDate(tomorrowDate);
  const tomorrowDow = (dayOfWeek + 1) % 7;

  // Check for AI plan first
  let useAiPlan = false;
  let todayPlan = null;
  let tomorrowPlan = null;
  let allPlans = [];

  if (PLAN_GENERATION_ENABLED) {
    if (!_activePlan) {
      _activePlan = await fetchActivePlan(currentProfile?.id);
      if (_activePlan) _activePlanWeeks = await fetchPlanWeeks(_activePlan.id);
    }
    if (_activePlan && todayStr >= _activePlan.start_date && todayStr <= _activePlan.end_date) {
      useAiPlan = true;
      const monday = mondayOfWeek(now);
      const sunday = addDays(monday, 6);
      const planWorkouts = await fetchPlanWorkoutsByDate(_activePlan.id, isoDate(monday), isoDate(sunday));
      todayPlan = planWorkouts.find(pw => pw.workout_date === todayStr);
      tomorrowPlan = planWorkouts.find(pw => pw.workout_date === tomorrowStr);
    }
  }

  if (!useAiPlan) {
    const periods = await fetchPeriods();
    const period = periods.find(p => todayStr >= p.start_date && todayStr <= p.end_date);
    if (period) allPlans = await fetchPlans(period.id);
    todayPlan = allPlans.find(p => p.day_of_week === dayOfWeek);
    tomorrowPlan = allPlans.find(p => p.day_of_week === tomorrowDow);
  }

  const hasPlan = useAiPlan || allPlans.length > 0;

  if (hasPlan) {
    if (todayPlan && todayPlan.is_rest) {
      todayEl.innerHTML = `<div class="today-rest">Vilodag</div>`;
    } else if (todayPlan) {
      const label = useAiPlan ? (todayPlan.label || todayPlan.activity_type) : stripDayPrefix(todayPlan.label);
      const desc = todayPlan.description || '';
      const zoneBadge = (useAiPlan && todayPlan.intensity_zone)
        ? ` <span class="zone-badge zone-${todayPlan.intensity_zone.toLowerCase()}">${todayPlan.intensity_zone}</span>`
        : '';
      todayEl.innerHTML = `<div class="today-workout">${label}${zoneBadge}</div>
        <div class="today-desc">${desc}</div>`;
    } else {
      todayEl.innerHTML = `<div class="today-rest">Ingen planerad träning</div>`;
    }

    if (tomorrowPlan && tomorrowPlan.is_rest) {
      tomorrowEl.innerHTML = `<div class="tomorrow-rest">Vila</div>`;
    } else if (tomorrowPlan) {
      const label = useAiPlan ? (tomorrowPlan.label || tomorrowPlan.activity_type) : stripDayPrefix(tomorrowPlan.label);
      tomorrowEl.innerHTML = `<div class="tomorrow-workout">${label}</div>
        <div class="tomorrow-desc">${tomorrowPlan.description || ''}</div>`;
    } else {
      tomorrowEl.innerHTML = `<div class="tomorrow-rest">—</div>`;
    }
  } else {
    todayEl.innerHTML = `<div class="today-rest">Utanför aktiv period</div>`;
    tomorrowEl.innerHTML = '';
  }

  // Combined weekly plan + compliance card
  const monday = mondayOfWeek(now);
  const sunday = addDays(monday, 6);
  const weekWorkouts = await fetchWorkouts(currentProfile?.id, isoDate(monday), isoDate(sunday));

  // Get plan data for weekly schedule (AI plan or legacy)
  let weekPlanItems = [];
  if (useAiPlan) {
    const pw = await fetchPlanWorkoutsByDate(_activePlan.id, isoDate(monday), isoDate(sunday));
    weekPlanItems = pw.map(p => ({
      day_of_week: p.day_of_week,
      label: p.label || p.activity_type,
      description: p.description,
      is_rest: p.is_rest,
    }));
  } else {
    weekPlanItems = allPlans.map(p => ({
      day_of_week: p.day_of_week,
      label: stripDayPrefix(p.label),
      description: p.description,
      is_rest: p.is_rest,
    }));
  }

  const schedEl = document.getElementById('dash-week-schedule');
  let schedHTML = '<div class="dash-schedule">';
  for (let i = 0; i < 7; i++) {
    const plan = weekPlanItems.find(p => p.day_of_week === i);
    const dayDate = addDays(monday, i);
    const dayStr = isoDate(dayDate);
    const isTodayRow = dayStr === todayStr;
    const dayWorkouts = weekWorkouts.filter(w => w.workout_date === dayStr);
    const isFuture = dayDate > now;
    const mins = dayWorkouts.reduce((s, w) => s + w.duration_minutes, 0);

    let statusClass = 'future';
    if (dayWorkouts.length > 0) { statusClass = 'done'; }
    else if (plan?.is_rest && !isFuture) { statusClass = 'rest'; }
    else if (!isFuture && !plan?.is_rest) { statusClass = 'missed'; }

    if (plan?.is_rest) {
      schedHTML += `<div class="dash-sched-row${isTodayRow ? ' is-today' : ''} sched-${statusClass}">
        <span class="sched-day">${DAY_NAMES[i]}</span>
        <span class="sched-label rest">Vila</span>
        <span class="sched-status rest-ok">—</span>
      </div>`;
    } else {
      const label = plan ? plan.label : '—';
      const actMatch = plan?.description?.match(/\b(löpning|cykel|stakmaskin|längdskidor|gym|hyrox)\b/i);
      const activity = actMatch ? actMatch[1] : (plan?.label?.match(/cykel/i) ? 'Cykel' : 'Löpning');
      const zoneMatch = plan?.description?.match(/\b(Z[1-5]|VO2max|tröskel|tempo|fartlek)/i);
      const passType = zoneMatch ? zoneMatch[1] : '';
      const kmMatch = plan?.description?.match(/(\d+(?:[–\-]\d+)?)\s*km/);
      const kmStr = kmMatch ? kmMatch[1] + ' km' : '';
      const minMatch = plan?.description?.match(/(\d+(?:[–\-]\d+)?)\s*min/);
      const durStr = minMatch ? minMatch[1] + "'" : '';

      let statusHTML = '';
      if (statusClass === 'done') statusHTML = `<span class="sched-status done">${mins}'</span>`;
      else if (statusClass === 'missed') statusHTML = `<span class="sched-status missed">Missat</span>`;

      schedHTML += `<div class="dash-sched-row${isTodayRow ? ' is-today' : ''} sched-${statusClass}">
        <span class="sched-day">${DAY_NAMES[i]}</span>
        <span class="sched-label">${label}</span>
        <span class="sched-meta">${kmStr}</span>
        ${statusHTML}
      </div>`;
    }
  }
  schedHTML += '</div>';
  schedEl.innerHTML = schedHTML;

  const phaseText = useAiPlan
    ? (() => {
        const cw = _activePlanWeeks.find(w => {
          const ws = new Date(_activePlan.start_date);
          ws.setDate(ws.getDate() + (w.week_number - 1) * 7);
          const we = addDays(ws, 6);
          return todayStr >= isoDate(ws) && todayStr <= isoDate(we);
        });
        return cw ? PHASE_LABELS[cw.phase] || '' : '';
      })()
    : (isDeloadWeek(monday) ? 'Deload-vecka' : '');
  document.getElementById('compliance-target').textContent = phaseText;

}

let _recentWorkouts = [];
let _recentShown = 0;
const RECENT_PAGE = 10;

function showMoreRecent() {
  const el = document.getElementById('recent-workouts');
  if (!el || !_recentWorkouts.length) return;
  const batch = _recentWorkouts.slice(_recentShown, _recentShown + RECENT_PAGE);
  const html = batch.map(w => {
    const distStr = w.distance_km ? ` | ${w.distance_km} km` : '';
    const intBadge = w.intensity ? `<span class="intensity-badge">${w.intensity}</span>` : '';
    return `
    <div class="workout-item clickable" onclick='openWorkoutModal(${JSON.stringify(w).replace(/'/g, "&#39;")})'>
      <div class="workout-icon" style="background:${ACTIVITY_COLORS[w.activity_type] || '#555'}22;">
        ${activityEmoji(w.activity_type)}
      </div>
      <div class="workout-info">
        <div class="name">${w.activity_type}${intBadge}</div>
        <div class="meta">${formatDate(w.workout_date)}${w.notes && w.notes !== 'Importerad' && !w.notes?.startsWith('[Strava]') ? ' — ' + w.notes : ''}</div>
      </div>
      <div class="workout-info duration">${w.duration_minutes} min${distStr}</div>
    </div>`;
  }).join('');
  _recentShown += batch.length;

  // Remove old "show more" button if present
  const oldBtn = el.querySelector('.recent-more-btn');
  if (oldBtn) oldBtn.remove();

  el.insertAdjacentHTML('beforeend', html);

  if (_recentShown < _recentWorkouts.length) {
    const remaining = _recentWorkouts.length - _recentShown;
    el.insertAdjacentHTML('beforeend',
      `<button class="recent-more-btn btn-show-more" onclick="showMoreRecent()">Visa fler (${remaining} kvar)</button>`
    );
  }
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
  const prevSunday = addDays(prevMonday, 6);
  const { data: prevWorkouts } = await sb.from('workouts').select('*')
    .eq('profile_id', profile?.id)
    .gte('workout_date', isoDate(prevMonday))
    .lte('workout_date', isoDate(prevSunday));
  const prevMins = (prevWorkouts || []).reduce((s, w) => s + w.duration_minutes, 0);
  const prevSessions = (prevWorkouts || []).length;
  const prevDist = (prevWorkouts || []).reduce((s, w) => s + (w.distance_km || 0), 0);

  function deltaHTML(cur, prev, unit) {
    if (prev === 0) return '';
    const diff = cur - prev;
    const pct = Math.round((diff / prev) * 100);
    const sign = diff > 0 ? '+' : '';
    const cls = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat';
    return `<span class="ws-delta ${cls}">${sign}${pct}%</span>`;
  }

  let items = [];
  items.push(`<div class="ws-stat"><span class="ws-val">${totalHours}h</span><span class="ws-label">total tid</span>${deltaHTML(totalMins, prevMins, 'h')}</div>`);
  items.push(`<div class="ws-stat"><span class="ws-val">${sessionCount}</span><span class="ws-label">pass</span>${deltaHTML(sessionCount, prevSessions, '')}</div>`);
  items.push(`<div class="ws-stat"><span class="ws-val">${totalDist > 0 ? totalDist.toFixed(1) : '0'}km</span><span class="ws-label">distans</span>${deltaHTML(totalDist, prevDist, 'km')}</div>`);
  items.push(`<div class="ws-stat"><span class="ws-val">${longest ? longest.duration_minutes + "'" : '—'}</span><span class="ws-label">längsta</span></div>`);

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
  selectedWorkout = w;
  const isOwn = w.profile_id === currentProfile.id;
  const ownerProfile = allProfiles.find(p => p.id === w.profile_id);
  const ownerName = ownerProfile ? ownerProfile.name : '';

  const titlePrefix = isOwn ? '' : ownerName + ' — ';
  document.getElementById('wm-title').textContent = titlePrefix + w.activity_type + ' — ' + formatDate(w.workout_date);

  const intBadge = w.intensity ? `<span class="intensity-badge">${w.intensity}</span>` : '';
  let body = '';
  body += `<div class="modal-detail-row"><span class="mdr-label">Aktivitet</span><span class="mdr-value">${w.activity_type} ${intBadge}${sourceBadge(w)}</span></div>`;
  body += `<div class="modal-detail-row"><span class="mdr-label">Datum</span><span class="mdr-value">${w.workout_date}</span></div>`;
  body += `<div class="modal-detail-row"><span class="mdr-label">Tid</span><span class="mdr-value">${w.duration_minutes} min</span></div>`;
  if (w.distance_km) body += `<div class="modal-detail-row"><span class="mdr-label">Distans</span><span class="mdr-value">${w.distance_km} km</span></div>`;
  if (w.workout_time) body += `<div class="modal-detail-row"><span class="mdr-label">Klockslag</span><span class="mdr-value">${w.workout_time}</span></div>`;
  if (w.notes && w.notes !== 'Importerad' && !w.notes?.startsWith('[Strava]')) body += `<div class="modal-detail-row"><span class="mdr-label">Anteckning</span><span class="mdr-value">${w.notes}</span></div>`;
  if (w.source === 'strava') {
    const stravaLink = w.strava_activity_id
      ? `<a href="https://www.strava.com/activities/${w.strava_activity_id}" target="_blank" rel="noopener" class="strava-view-link">View on Strava</a>`
      : '';
    body += `<div class="modal-detail-row"><span class="mdr-label">Källa</span><span class="mdr-value" style="color:#FC4C02;">Strava auto-import ${stravaLink}</span></div>`;
  }
  if (w.source === 'garmin') {
    const garminLink = w.garmin_activity_id
      ? `<a href="https://connect.garmin.com/modern/activity/${w.garmin_activity_id}" target="_blank" rel="noopener" class="garmin-view-link">View on Garmin</a>`
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

  if (w.map_polyline && typeof L !== 'undefined') {
    body += `<div id="wm-map" style="height:200px;border-radius:8px;margin:12px 0;"></div>`;
  }

  body += `<div id="wm-reactions" class="wm-reactions"><span class="text-dim">Laddar...</span></div>`;
  body += `<div id="wm-comments" class="wm-comments"><span class="text-dim">Laddar...</span></div>`;

  document.getElementById('wm-body').innerHTML = body;

  if (w.map_polyline && typeof L !== 'undefined') {
    setTimeout(() => {
      const mapEl = document.getElementById('wm-map');
      if (!mapEl) return;
      const coords = decodePolyline(w.map_polyline);
      if (coords.length === 0) return;
      const map = L.map(mapEl, { zoomControl: false, attributionControl: false });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(map);
      const line = L.polyline(coords, { color: '#2E86C1', weight: 3, opacity: 0.8 }).addTo(map);
      map.fitBounds(line.getBounds(), { padding: [20, 20] });
    }, 100);
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

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
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
  document.getElementById('log-form').querySelector('[type="submit"]').textContent = 'Spara pass';
}

// ═══════════════════════
//  SCHEMA
// ═══════════════════════
async function loadSchema() {
  showViewLoading('view-schema');
  try { await _loadSchema(); } catch (e) { console.error('Schema error:', e); }
  hideViewLoading('view-schema');
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
  const todayBtn = document.getElementById('cal-strip-today-btn');
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

  await renderCalendarStrip(profile, targetMonday);

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
    renderSchemaPlan(workouts, planWorkouts, targetMonday, invitations, isOwnSchema, profile, phase);
  } else {
    // Legacy mode (period_plans)
    const deload = isDeloadWeek(targetMonday);
    document.getElementById('schema-week-label').textContent =
      `V${wk}${deload ? ' (Deload)' : ''} — ${formatDate(targetMonday)} till ${formatDate(targetSunday)}`;

    if (isOwnSchema) {
      updatePlanInfoBar(null, []);
    }
    renderGenerateButton();

    const periods = await fetchPeriods();
    const mondayStr = isoDate(targetMonday);
    const period = periods.find(p => mondayStr >= p.start_date && mondayStr <= p.end_date);
    let plans = [];
    if (period) plans = await fetchPlans(period.id);

    renderSchema(workouts, plans, targetMonday, deload, invitations, isOwnSchema, profile);
  }
}

// ── Calendar Strip ──
const CAL_DAY_LETTERS = ['M', 'T', 'O', 'T', 'F', 'L', 'S'];

async function renderCalendarStrip(profile, selectedMonday) {
  const track = document.getElementById('cal-strip-track');
  const monthLabel = document.getElementById('cal-strip-month');
  if (!track) return;

  const now = new Date();
  const todayStr = isoDate(now);
  const currentMonday = mondayOfWeek(now);
  const stripStart = addDays(selectedMonday, -14);
  const stripEnd = addDays(selectedMonday, 27);
  const stripStartStr = isoDate(stripStart);
  const stripEndStr = isoDate(stripEnd);

  if (!_calStripWorkouts || !_calStripRange ||
      _calStripRange.start !== stripStartStr || _calStripRange.end !== stripEndStr) {
    _calStripWorkouts = await fetchWorkouts(profile?.id, stripStartStr, stripEndStr);
    _calStripRange = { start: stripStartStr, end: stripEndStr };
  }

  const workoutDates = new Set(_calStripWorkouts.map(w => w.workout_date));

  let planDates = new Set();
  if (_activePlan) {
    try {
      const pw = await fetchPlanWorkoutsByDate(_activePlan.id, stripStartStr, stripEndStr);
      pw.forEach(p => { if (!p.is_rest) planDates.add(p.workout_date); });
    } catch (e) { /* ignore */ }
  }

  const selectedMondayStr = isoDate(selectedMonday);
  const selectedSundayStr = isoDate(addDays(selectedMonday, 6));

  const midDate = addDays(selectedMonday, 3);
  if (monthLabel) {
    monthLabel.textContent = midDate.toLocaleDateString('sv-SE', { month: 'long', year: 'numeric' });
  }

  let html = '';
  let weekDay = new Date(stripStart);

  while (isoDate(weekDay) <= stripEndStr) {
    const weekMonday = mondayOfWeek(weekDay);
    const weekMondayStr = isoDate(weekMonday);
    const isSelectedWeek = weekMondayStr === selectedMondayStr;
    html += `<div class="cal-week-group${isSelectedWeek ? ' cal-week-selected' : ''}">`;

    for (let d = 0; d < 7; d++) {
      const cellDate = addDays(weekMonday, d);
      const cellStr = isoDate(cellDate);
      if (cellStr < stripStartStr || cellStr > stripEndStr) {
        html += `<div class="cal-cell" style="opacity:0;pointer-events:none"><div class="cal-cell-day">&nbsp;</div><div class="cal-cell-num">&nbsp;</div><div class="cal-cell-dot cal-dot-none"></div></div>`;
        continue;
      }

      const isToday = cellStr === todayStr;
      const isPast = cellDate < now && !isToday;
      const hasDone = workoutDates.has(cellStr);
      const hasPlanned = planDates.has(cellStr);

      let dotClass = 'cal-dot-none';
      if (hasDone) dotClass = 'cal-dot-done';
      else if (isPast && hasPlanned) dotClass = 'cal-dot-missed';
      else if (hasPlanned) dotClass = 'cal-dot-planned';

      const classes = ['cal-cell'];
      if (isToday) classes.push('cal-today');

      html += `<div class="${classes.join(' ')}" onclick="calCellTap('${cellStr}')">
        <div class="cal-cell-day">${CAL_DAY_LETTERS[d]}</div>
        <div class="cal-cell-num">${cellDate.getDate()}</div>
        <div class="cal-cell-dot ${dotClass}"></div>
      </div>`;
    }

    html += '</div>';
    weekDay = addDays(weekMonday, 7);
  }

  track.innerHTML = html;

  requestAnimationFrame(() => {
    const selectedGroup = track.querySelector('.cal-week-selected');
    if (selectedGroup) {
      selectedGroup.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'instant' });
    }
  });
}

function calCellTap(dateStr) {
  const cellDate = new Date(dateStr + 'T12:00:00');
  const cellMonday = mondayOfWeek(cellDate);
  const now = new Date();
  const currentMonday = mondayOfWeek(now);
  const diffMs = cellMonday.getTime() - currentMonday.getTime();
  const diffWeeks = Math.round(diffMs / (7 * 86400000));
  if (diffWeeks !== schemaWeekOffset) {
    schemaWeekOffset = diffWeeks;
    _calStripWorkouts = null;
    loadSchema();
  }
}

function calStripScrollLeft() {
  const track = document.getElementById('cal-strip-track');
  if (track) track.scrollBy({ left: -200, behavior: 'smooth' });
}
function calStripScrollRight() {
  const track = document.getElementById('cal-strip-track');
  if (track) track.scrollBy({ left: 200, behavior: 'smooth' });
}

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

function buildWorkoutStatsRow(w) {
  const parts = [];
  if (w.duration_minutes) parts.push(`<span class="sr-stat"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="11" height="11"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg><span class="sr-stat-val">${w.duration_minutes}'</span></span>`);
  if (w.distance_km) parts.push(`<span class="sr-stat"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="11" height="11"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/></svg><span class="sr-stat-val">${w.distance_km} km</span></span>`);
  if (w.avg_hr) parts.push(`<span class="sr-stat"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="11" height="11"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg><span class="sr-stat-val">${w.avg_hr} bpm</span></span>`);
  if (w.elevation_gain_m) parts.push(`<span class="sr-stat"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="11" height="11"><path d="M22 21L14.5 6 9 16 2 8"/></svg><span class="sr-stat-val">${Math.round(w.elevation_gain_m)} m</span></span>`);
  if (w.avg_speed_kmh && w.activity_type === 'Löpning') {
    const pace = 60 / w.avg_speed_kmh;
    const pMin = Math.floor(pace);
    const pSec = String(Math.round((pace - pMin) * 60)).padStart(2, '0');
    parts.push(`<span class="sr-stat"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="11" height="11"><polygon points="5 3 19 12 5 21 5 3"/></svg><span class="sr-stat-val">${pMin}:${pSec}/km</span></span>`);
  }
  if (w.calories) parts.push(`<span class="sr-stat"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="11" height="11"><path d="M12 22c-4.97 0-9-2.69-9-6s4.03-6 9-11c4.97 5 9 2.69 9 11s-4.03 6-9 6z"/></svg><span class="sr-stat-val">${w.calories} kcal</span></span>`);
  return parts.length ? `<div class="sr-stats-row">${parts.join('')}</div>` : '';
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
        const intB = w.intensity ? ` <span class="intensity-badge">${w.intensity}</span>` : '';
        const distB = w.distance_km ? ` <span class="sr-km-badge">${w.distance_km} km</span>` : '';
        const stats = buildWorkoutStatsRow(w);
        return `<div class="clickable-workout" onclick='openWorkoutModal(${JSON.stringify(w).replace(/'/g, "&#39;")})'>
          <div class="sr-plan-label">${activityIcon(w.activity_type)} ${w.activity_type}${distB}${intB}</div>
          ${stats}
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
      const durStr = planWo.target_duration_minutes > 0 ? `${planWo.target_duration_minutes} min` : '';
      const meta = (planWo.target_duration_minutes > 0 || planWo.target_distance_km)
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
        const intB = w.intensity ? ` <span class="intensity-badge">${w.intensity}</span>` : '';
        const distB = w.distance_km ? ` <span class="sr-km-badge">${w.distance_km} km</span>` : '';
        const stats = buildWorkoutStatsRow(w);
        return `<div class="clickable-workout" onclick='openWorkoutModal(${JSON.stringify(w).replace(/'/g, "&#39;")})'>
          <div class="sr-plan-label">${activityIcon(w.activity_type)} ${w.activity_type}${distB}${intB}</div>
          ${stats}
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
    const canClick = isOwnSchema && (isFuture || isToday) && !planWo?.is_rest && dayWorkouts.length === 0;
    const clickAttr = canClick ? ` onclick="openPlanModal('${dayStr}', ${JSON.stringify(fakePlan).replace(/"/g, '&quot;')}, '${DAY_NAMES_FULL[i]}')" style="cursor:pointer;"` : '';

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
    body += `<div class="modal-detail-row"><span class="mdr-label">Aktivitet</span><span class="mdr-value">${stripDayPrefix(plan.label)}</span></div>`;
  }
  if (plan && plan.description) {
    body += `<div class="modal-detail-row"><span class="mdr-label">Beskrivning</span><span class="mdr-value">${plan.description}</span></div>`;
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
    return `<div class="invite-user-row" onclick="selectInviteUser('${p.id}')">
      <div class="invite-user-avatar">${initials}</div>
      <div class="invite-user-name">${p.name}</div>
    </div>`;
  }).join('');
}

function selectInviteUser(userId) {
  _inviteSelectedUser = allProfiles.find(p => p.id === userId);
  if (!_inviteSelectedUser) return;

  document.getElementById('invite-user-list').innerHTML =
    `<div class="invite-user-row selected">
      <div class="invite-user-avatar">${_inviteSelectedUser.name.split(' ').map(n => n[0]).join('').toUpperCase()}</div>
      <div class="invite-user-name">${_inviteSelectedUser.name}</div>
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
    if (currentView === 'schema') loadSchema();
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

function setTrendMode(mode) {
  trendMode = mode;
  const toggle = document.querySelector('#trend-mode-toggle input');
  if (toggle) toggle.checked = mode === 'total';
  loadTrends();
}

function setEffortMode(mode) {
  effortMode = mode;
  const toggle = document.querySelector('#effort-mode-toggle input');
  if (toggle) toggle.checked = mode === 'normalized';
  loadTrends();
}

async function loadTrends() {
  if (!currentProfile) return;
  showViewLoading('view-trends');
  try { await _loadTrends(); } catch (e) { console.error('Trends error:', e); }
  hideViewLoading('view-trends');
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
    const mon = new Date(w);
    const wn = weekNumber(mon);
    return isDeloadWeek(mon) ? `V${wn} (D)` : `V${wn}`;
  });
  const isNorm = effortMode === 'normalized';
  const yUnit = isNorm ? '' : 'h';
  const myData = weeks.map(w => {
    const types = trendMode === 'cardio' ? CARDIO_TYPES : [...CARDIO_TYPES, 'Gym'];
    if (isNorm) {
      return weekWorkouts[w].filter(wo => types.includes(wo.activity_type)).reduce((s, wo) => s + calcWorkoutEffort(wo), 0);
    }
    const d = weekData[w];
    return types.reduce((s, t) => s + (d[t] || 0), 0) / 60;
  });

  const wowDeltas = myData.map((val, i) => {
    if (i === 0) return null;
    const prev = myData[i - 1];
    return prev > 0 ? ((val - prev) / prev) * 100 : null;
  });

  if (chartWeekly) chartWeekly.destroy();
  const ctx = document.getElementById('chart-weekly').getContext('2d');
  const color = PERSON_COLORS[currentProfile.name.split(' ')[0]] || '#2E86C1';
  chartWeekly = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: currentProfile.name, data: myData,
        borderColor: color,
        backgroundColor: color + '22',
        tension: 0.3, fill: true, pointRadius: 5, pointHoverRadius: 7
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      layout: { padding: { top: 24 } },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => {
          const d = wowDeltas[c.dataIndex];
          const pct = d !== null ? ` (${d >= 0 ? '+' : ''}${Math.round(d)}%)` : '';
          return `${c.parsed.y.toFixed(1)} ${yUnit}${pct}`;
        }}},
      },
      scales: {
        y: { beginAtZero: true, grid: { color: () => getComputedStyle(document.body).getPropertyValue('--border').trim() }, ticks: { color: () => getComputedStyle(document.body).getPropertyValue('--text-muted').trim(), callback: v => v.toFixed(1) + yUnit } },
        x: { grid: { display: false }, ticks: { color: () => getComputedStyle(document.body).getPropertyValue('--text-muted').trim() } }
      }
    },
    plugins: [{
      id: 'wowLabels',
      afterDatasetsDraw(chart) {
        const meta = chart.getDatasetMeta(0);
        const ctxC = chart.ctx;
        ctxC.font = '600 11px ' + getComputedStyle(document.body).fontFamily;
        ctxC.textAlign = 'center';
        meta.data.forEach((pt, i) => {
          const d = wowDeltas[i];
          if (d === null) return;
          const txt = (d >= 0 ? '+' : '') + Math.round(d) + '%';
          const weekMon = weeks[i];
          const dl = isDeloadWeek(new Date(weekMon));
          if (dl) {
            ctxC.fillStyle = d <= -20 ? '#2ECC71' : '#F39C12';
          } else {
            ctxC.fillStyle = d > 10 ? '#E74C3C' : d >= 0 ? '#2ECC71' : '#F39C12';
          }
          ctxC.fillText(txt, pt.x, pt.y - 12);
        });
      }
    }]
  });

  // Week-over-week volume delta (same-day comparison)
  const deltaEl = document.getElementById('volume-delta');
  if (deltaEl && weeks.length >= 2) {
    const now = new Date();
    const todayDow = (now.getDay() + 6) % 7; // 0=Mon
    const thisMonday = weeks[weeks.length - 1];
    const prevMonday = weeks[weeks.length - 2];
    const types = trendMode === 'cardio' ? CARDIO_TYPES : [...CARDIO_TYPES, 'Gym'];

    const accumTo = (mondayStr, maxDow) => {
      const filtered = myWorkouts.filter(w => {
        const wMon = isoDate(mondayOfWeek(new Date(w.workout_date)));
        if (wMon !== mondayStr) return false;
        if (!types.includes(w.activity_type)) return false;
        const wDow = (new Date(w.workout_date).getDay() + 6) % 7;
        return wDow <= maxDow;
      });
      return isNorm
        ? filtered.reduce((s, w) => s + calcWorkoutEffort(w), 0)
        : filtered.reduce((s, w) => s + w.duration_minutes, 0) / 60;
    };

    const curr = accumTo(thisMonday, todayDow);
    const prev = accumTo(prevMonday, todayDow);
    const pctChange = prev > 0 ? ((curr - prev) / prev) * 100 : 0;
    const sign = pctChange >= 0 ? '+' : '';
    const deload = isDeloadWeek(mondayOfWeek(now));
    const dayLabel = DAY_NAMES[todayDow].toLowerCase();

    let colorClass = 'delta-neutral';
    let msg = '';
    if (deload) {
      colorClass = pctChange <= -20 ? 'delta-good' : 'delta-warn';
      msg = pctChange <= -20 ? 'Bra deload' : 'Sänk mer';
    } else if (pctChange > 10) {
      colorClass = 'delta-high';
      msg = 'Hög ökning';
    } else if (pctChange >= 0) {
      colorClass = 'delta-good';
      msg = 'Bra progression';
    } else {
      colorClass = 'delta-warn';
      msg = 'Minskad volym';
    }

    deltaEl.innerHTML = `
      <div class="vd-compact ${colorClass}">
        <span class="vd-pct">${sign}${Math.round(pctChange)}%</span>
        <span class="vd-detail">vs ${labels[labels.length - 2]} (mån–${dayLabel})</span>
        <span class="vd-val">${curr.toFixed(1)}${yUnit} / ${prev.toFixed(1)}${yUnit}</span>
        <span class="vd-msg">${msg}</span>
      </div>`;
  } else if (deltaEl) {
    deltaEl.innerHTML = '';
  }

  // Activity mix stacked bar
  const mixCanvas = document.getElementById('chart-mix-personal');
  if (mixCanvas) {
    if (chartMixPersonal) chartMixPersonal.destroy();
    const types = ['Löpning', 'Cykel', 'Gym', 'Annat', 'Hyrox', 'Stakmaskin', 'Längdskidor'];

    const weekEffortByType = {};
    if (isNorm) {
      weeks.forEach(w => {
        weekEffortByType[w] = {};
        (weekWorkouts[w] || []).forEach(wo => {
          weekEffortByType[w][wo.activity_type] = (weekEffortByType[w][wo.activity_type] || 0) + calcWorkoutEffort(wo);
        });
      });
    }

    const datasets = types.filter(t => weeks.some(w => isNorm ? (weekEffortByType[w]?.[t] || 0) > 0 : (weekData[w][t] || 0) > 0)).map(t => ({
      label: t,
      data: weeks.map(w => isNorm ? +(weekEffortByType[w]?.[t] || 0).toFixed(2) : (weekData[w][t] || 0) / 60),
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
          tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.parsed.y.toFixed(1)} ${yUnit}` } }
        },
        scales: {
          y: { stacked: true, beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#888', callback: v => v.toFixed(1) + yUnit } },
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

// ── Effort normalization ──
// Based on training stress science: combines activity load factor and intensity multiplier.
// Running carries higher musculoskeletal load than cycling per unit time.
// Higher intensity zones generate disproportionately more physiological stress (exponential relationship).
const EFFORT_ACTIVITY_FACTOR = {
  'Löpning': 1.0,
  'Hyrox': 1.05,
  'Längdskidor': 0.90,
  'Annat': 0.75,
  'Stakmaskin': 0.70,
  'Cykel': 0.65,
  'Gym': 0.60,
  'Vila': 0,
};
const EFFORT_INTENSITY_MULT = {
  'Z1': 0.65,
  'Z2': 1.00,
  'mixed': 1.25,
  'Z3': 1.30,
  'Kvalitet': 1.50,
  'Z4': 1.60,
  'Z5': 1.85,
};

function calcWorkoutEffort(w) {
  const actFactor = EFFORT_ACTIVITY_FACTOR[w.activity_type] ?? 0.75;
  const intMult = w.intensity ? (EFFORT_INTENSITY_MULT[w.intensity] ?? 1.0) : 0.85;
  return (w.duration_minutes / 60) * actFactor * intMult;
}

let _seasonBarMode = 'hours';
function setSeasonBarMode(mode) {
  _seasonBarMode = mode;
  const toggle = document.querySelector('#season-bar-toggle input');
  if (toggle) toggle.checked = mode === 'km';
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
  const effortData = weeks.map(w => +weekMap[w].effort.toFixed(2));
  const hoursData = weeks.map(w => +weekMap[w].hours.toFixed(1));
  const labels = weeks.map(w => {
    const d = new Date(w);
    return `${d.getDate()}/${d.getMonth() + 1}`;
  });

  const textColor = getComputedStyle(document.body).getPropertyValue('--text-dim').trim() || '#888';

  window._chartEffort = new Chart(effortCanvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Effort (normaliserat)',
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
            label: c => c.dataset.label === 'Effort (normaliserat)'
              ? `Effort: ${c.parsed.y.toFixed(1)}`
              : `Timmar: ${c.parsed.y.toFixed(1)}h`
          }
        }
      },
      scales: {
        y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: textColor }, title: { display: true, text: 'Effort', color: textColor } },
        y1: { beginAtZero: true, position: 'right', grid: { display: false }, ticks: { color: textColor, callback: v => v + 'h' }, title: { display: true, text: 'Timmar', color: textColor } },
        x: { grid: { display: false }, ticks: { color: textColor } }
      }
    }
  });

  const legendEl = document.getElementById('effort-legend');
  if (legendEl) {
    legendEl.innerHTML = `
      <div class="effort-legend-item"><span class="effort-legend-dot" style="background:rgba(214,99,158,0.8)"></span> Effort = timmar × aktivitet (löpn 1.0, cykel 0.65, gym 0.60) × intensitet (Z2 1.0, Z4 1.6, Z5 1.85)</div>
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
let grpChartMode = 'cardio';
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
    <div class="lb-row clickable" onclick="openMemberProfile('${m.id}')">
      <div class="lb-rank ${rankClasses[i] || ''}">${i + 1}</div>
      <div class="lb-name">${m.name}</div>
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

  // Season totals bars
  const maxTotal = Math.max(...members.map(m => allWorkouts.filter(w => w.profile_id === m.id).reduce((s, w) => s + w.duration_minutes, 0) / 60), 1);
  const barsEl = document.getElementById('group-totals-bars');
  barsEl.innerHTML = members.map((m, i) => {
    const total = allWorkouts.filter(w => w.profile_id === m.id).reduce((s, w) => s + w.duration_minutes, 0) / 60;
    return `<div class="compare-bar-row">
      <div class="compare-bar-label">${m.name.split(' ')[0]}</div>
      <div class="compare-bar-track"><div class="compare-bar-fill" style="width:${(total/maxTotal)*100}%;background:${colors[i % colors.length]};">${total.toFixed(1)}h</div></div>
    </div>`;
  }).join('');
}

function setGrpChartMode(mode) {
  grpChartMode = mode;
  const toggle = document.querySelector('#grp-chart-toggle input');
  if (toggle) toggle.checked = mode === 'total';
  if (_cachedGroupWorkouts.length > 0 && _cachedGroupMembers.length > 0) {
    renderGroupChart(_cachedGroupWorkouts, _cachedGroupMembers);
  } else {
    loadGroup();
  }
}

function setGrpEffortMode(mode) {
  grpEffortMode = mode;
  const toggle = document.querySelector('#grp-effort-toggle input');
  if (toggle) toggle.checked = mode === 'normalized';
  if (_cachedGroupWorkouts.length > 0 && _cachedGroupMembers.length > 0) {
    renderGroupChart(_cachedGroupWorkouts, _cachedGroupMembers);
  } else {
    loadGroup();
  }
}

function renderGroupChart(allWorkouts, members) {
  const colors = ['#2E86C1', '#E74C3C', '#2ECC71', '#9B59B6', '#F39C12', '#1ABC9C'];
  const isGrpNorm = grpEffortMode === 'normalized';
  const gUnit = isGrpNorm ? '' : 'h';
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
  const labels = weeks.map(w => `V${weekNumber(new Date(w))}`);

  if (chartGroupWeekly) chartGroupWeekly.destroy();
  const canvas = document.getElementById('chart-group-weekly');
  if (!canvas) return;

  const titleEl = document.getElementById('grp-chart-title');
  if (titleEl) titleEl.textContent = isGrpNorm ? 'Effort per vecka' : 'Timmar per vecka';

  const datasets = members.map((m, i) => ({
    label: m.name.split(' ')[0],
    data: weeks.map(w => isGrpNorm ? +(weekData[w]?.[m.id] || 0).toFixed(2) : (weekData[w]?.[m.id] || 0) / 60),
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
        tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.parsed.y.toFixed(1)} ${gUnit}` } }
      },
      scales: {
        y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#888', callback: v => v.toFixed(1) + gUnit } },
        x: { grid: { display: false }, ticks: { color: '#888' } }
      }
    }
  });
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
  const memberList = memberEls.map(m => {
    const isMe = m.id === currentProfile.id;
    const removeBtn = isAdmin && !isMe
      ? `<button class="btn btn-sm btn-danger-text" onclick="removeGroupMember('${m.id}','${m.name}')" style="margin-left:auto;padding:2px 8px;font-size:0.75rem;">Ta bort</button>`
      : '';
    return `<div class="sm-member" style="display:flex;align-items:center;gap:8px;">${m.name}${isMe ? ' (du)' : ''}${isAdmin && !isMe ? '<span style="font-size:0.7rem;color:var(--text-muted);margin-left:4px;"></span>' : ''}${removeBtn}</div>`;
  }).join('');
  info.innerHTML = `
    <div class="sm-code-row">
      <span class="sm-code">${code}</span>
      <button class="btn btn-sm btn-ghost" onclick="copyGroupCode()">Kopiera</button>
    </div>
    <div class="sm-members">${memberList}</div>
    <button class="sm-item sm-leave" onclick="leaveGroup()" style="margin-top:12px;">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
      Lämna grupp
    </button>`;
}

async function removeGroupMember(profileId, memberName) {
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
    const nudgeHTML = canNudge
      ? `<button class="nudge-btn${alreadySent ? ' sent' : ''}" id="${nudgeId}" onclick="sendNudge('${m.id}', '${m.name}', this)" ${alreadySent ? 'disabled' : ''}>
           ${alreadySent ? '✓ Puff skickad' : '👊 Ge en puff'}
         </button>`
      : '';

    return `<div class="grp-member-week">
      <div class="grp-mw-header clickable" onclick="openMemberProfile('${m.id}')">
        <div class="grp-mw-avatar" style="background:${colors[mi % colors.length]}">${m.name[0].toUpperCase()}</div>
        <div class="grp-mw-name">${m.name}${isMe ? ' (du)' : ''}</div>
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

    const intBadge = w.intensity ? `<span class="intensity-badge">${w.intensity}</span>` : '';
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
        <div class="feed-avatar" style="background:${color}">${(member.name || '?')[0].toUpperCase()}</div>
        <div class="feed-info">
          <div class="feed-name">${member.name || '?'}</div>
          <div class="feed-date">${formatDate(w.workout_date)}</div>
        </div>
        <div class="feed-type">${activityEmoji(w.activity_type)} ${w.duration_minutes}'${intBadge}</div>
      </div>
      ${notesSnip}
      <div class="feed-reactions" onclick="event.stopPropagation()">
        <button class="react-btn-sm${myReaction?.reaction === 'like' ? ' active' : ''}" onclick="event.stopPropagation();handleFeedReaction('${w.id}','like')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg> ${likes.length || ''}
        </button>
        <button class="react-btn-sm${myReaction?.reaction === 'dislike' ? ' active' : ''}" onclick="event.stopPropagation();handleFeedReaction('${w.id}','dislike')">
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

async function sendNudge(receiverId, receiverName, btnEl) {
  if (_sentNudges.has(receiverId)) return;

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
          'Authorization': 'Bearer ' + session.access_token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          receiver_id: receiverId,
          sender_name: currentProfile.name,
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
            <button class="btn btn-sm invite-accept-btn" onclick="event.stopPropagation();acceptInviteFromNudge('${n.sender_id}', '${n.id}')">Acceptera</button>
            <button class="btn btn-sm invite-decline-btn" onclick="event.stopPropagation();declineInviteFromNudge('${n.sender_id}', '${n.id}')">Avböj</button>
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
          <div class="nudge-sender">${senderName}</div>
          <div class="nudge-msg">${n.message}</div>
          ${actions}
          <div class="nudge-time">${ago}</div>
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
            Synka nu
          </button>
          <button class="strava-sync-btn" id="strava-resync-btn" onclick="fullResyncStrava()" style="background:var(--accent2,#f59e0b)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            Hämta all data
          </button>
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

function connectStrava() {
  if (!STRAVA_CLIENT_ID || !currentProfile) return;
  const scope = 'activity:read_all';
  const state = currentProfile.id;
  const url = `https://www.strava.com/oauth/authorize?client_id=${STRAVA_CLIENT_ID}&redirect_uri=${encodeURIComponent(STRAVA_REDIRECT_URI)}&response_type=code&scope=${scope}&state=${state}&approval_prompt=auto`;
  window.location.href = url;
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

async function syncStrava() {
  if (!_stravaConnection || !currentProfile) return;
  const btn = document.getElementById('strava-sync-btn');
  if (btn) { btn.classList.add('syncing'); btn.textContent = 'Synkar...'; }

  try {
    const { data: { session } } = await sb.auth.getSession();
    const res = await fetch(SUPABASE_FUNCTIONS_URL + '/strava-sync', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + session.access_token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ profile_id: currentProfile.id }),
    });

    const result = await res.json();
    if (res.ok) {
      _stravaConnection.last_sync_at = result.last_sync_at;
      updateStravaUI();
      const errInfo = result.debug?.firstError ? `\nFel: ${result.debug.firstError}` : '';
      const debugInfo = result.debug ? `\nHämtade ${result.totalFetched}, importerade ${result.imported}, skippade ${result.skipped}${errInfo}` : '';
      await showAlertModal('Synk klar', `${result.imported} pass importerade.${debugInfo}`);
      navigate(currentView);
    } else {
      await showAlertModal('Synk-fel', result.error || 'Okänt fel');
    }
  } catch (e) {
    console.error('Strava sync error:', e);
    await showAlertModal('Synk-fel', 'Nätverksfel vid synkning');
  }

  if (btn) { btn.classList.remove('syncing'); btn.textContent = 'Synka nu'; }
}

async function fullResyncStrava() {
  if (!_stravaConnection || !currentProfile) return;
  const btn = document.getElementById('strava-resync-btn');
  if (btn) { btn.classList.add('syncing'); btn.textContent = 'Hämtar...'; }

  try {
    const { data: { session } } = await sb.auth.getSession();
    const res = await fetch(SUPABASE_FUNCTIONS_URL + '/strava-sync', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + session.access_token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ profile_id: currentProfile.id, since: '2026-03-02' }),
    });

    const result = await res.json();
    if (res.ok) {
      _stravaConnection.last_sync_at = result.last_sync_at;
      updateStravaUI();
      const errInfo = result.debug?.firstError ? `\nFel: ${result.debug.firstError}` : '';
      const debugInfo = result.debug ? `\nHämtade ${result.totalFetched}, importerade ${result.imported}, skippade ${result.skipped}${errInfo}` : '';
      await showAlertModal('Full synk klar', `${result.imported} pass uppdaterade.${debugInfo}`);
      navigate(currentView);
    } else {
      await showAlertModal('Synk-fel', result.error || 'Okänt fel');
    }
  } catch (e) {
    console.error('Strava full resync error:', e);
    await showAlertModal('Synk-fel', 'Nätverksfel vid synkning');
  }

  if (btn) { btn.classList.remove('syncing'); btn.textContent = 'Hämta all data'; }
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

function connectGarmin() {
  if (!GARMIN_CLIENT_ID || !currentProfile) return;
  const state = currentProfile.id;
  const url = `${GARMIN_AUTH_URL}?client_id=${GARMIN_CLIENT_ID}&redirect_uri=${encodeURIComponent(GARMIN_REDIRECT_URI)}&response_type=code&scope=activity:read&state=${state}`;
  window.location.href = url;
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
        'Authorization': 'Bearer ' + session.access_token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ profile_id: currentProfile.id }),
    });

    const result = await res.json();
    if (res.ok) {
      _garminConnection.last_sync_at = result.last_sync_at;
      updateGarminUI();
      const errInfo = result.debug?.firstError ? `\nFel: ${result.debug.firstError}` : '';
      const debugInfo = result.debug ? `\nHämtade ${result.totalFetched}, importerade ${result.imported}, skippade ${result.skipped}${errInfo}` : '';
      await showAlertModal('Synk klar', `${result.imported} pass importerade.${debugInfo}`);
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

  const member = allProfiles.find(p => p.id === memberId);
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
        <span class="mp-type-label">${activityEmoji(type)} ${type}</span>
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
    recentSlice.forEach(w => {
      const distStr = w.distance_km ? ` | ${w.distance_km} km` : '';
      const intBadge = w.intensity ? `<span class="intensity-badge">${w.intensity}</span>` : '';
      html += `<div class="workout-item clickable" onclick='openWorkoutModal(${JSON.stringify(w).replace(/'/g, "&#39;")})'>
        <div class="workout-icon" style="background:${ACTIVITY_COLORS[w.activity_type] || '#555'}22;">${activityEmoji(w.activity_type)}</div>
        <div class="workout-info">
          <div class="name">${w.activity_type}${intBadge}</div>
          <div class="meta">${formatDate(w.workout_date)}</div>
        </div>
        <div class="workout-info duration">${w.duration_minutes} min${distStr}</div>
      </div>`;
    });
    html += '</div>';
  }

  bodyEl.innerHTML = html;
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
let _wizardStep = 0;
let _wizardGoalType = null;
let _wizardIncludeGym = true;

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

// ── Generate button ──

function renderGenerateButton() {
  const container = document.getElementById('schema-generate-btn-container');
  if (!container) return;
  if (!PLAN_GENERATION_ENABLED) { container.innerHTML = ''; return; }

  if (!currentProfile) { container.innerHTML = ''; return; }

  if (_activePlan) {
    const planName = _activePlan.name || _activePlan.goal_text || 'Träningsplan';
    const genModel = _activePlan.generation_model ? `<span style="font-size:0.65rem;color:var(--text-dim);margin-left:6px;">AI</span>` : '';
    container.innerHTML = `
      <div style="display:flex;gap:8px;margin-bottom:16px;">
        <button class="schema-generate-btn" onclick="openPlanManager()" style="flex:1;border-style:solid;border-color:var(--border);background:var(--bg-card);margin-bottom:0;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
          ${planName}${genModel}
        </button>
        <button class="schema-generate-btn" onclick="openPlanEditModal()" style="flex:0 0 auto;border-style:solid;border-color:var(--border);background:var(--bg-card);margin-bottom:0;padding:14px 16px;" title="Redigera med AI">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
        </button>
        <button class="schema-generate-btn" onclick="openPlanWizard()" style="flex:0 0 auto;border-style:solid;border-color:var(--border);background:var(--bg-card);margin-bottom:0;padding:14px 16px;" title="Nytt schema">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
      </div>`;
  } else {
    container.innerHTML = `
      <div style="display:flex;gap:8px;margin-bottom:16px;">
        <button class="schema-generate-btn" onclick="openPlanWizard()" style="flex:1;margin-bottom:0;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
          Skapa AI-träningsschema
        </button>
        <button class="schema-generate-btn" onclick="openPlanManager()" style="flex:0 0 auto;border-style:solid;border-color:var(--border);background:var(--bg-card);margin-bottom:0;padding:14px 16px;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
        </button>
      </div>`;
  }
}

// ═══════════════════════
//  PLAN WIZARD
// ═══════════════════════

function openPlanWizard() {
  _wizardStep = 0;
  _wizardGoalType = null;
  _wizardIncludeGym = true;

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

function setWizGym(val) {
  _wizardIncludeGym = val;
  document.getElementById('wiz-gym-yes').classList.toggle('active', val);
  document.getElementById('wiz-gym-no').classList.toggle('active', !val);
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
  for (let i = 0; i <= 3; i++) {
    const stepEl = document.getElementById(`wizard-step-${i}`);
    if (stepEl) stepEl.classList.toggle('active', i === _wizardStep);
  }

  document.querySelectorAll('.wizard-step-dot').forEach(dot => {
    const s = parseInt(dot.dataset.step);
    dot.classList.toggle('active', s === _wizardStep);
    dot.classList.toggle('done', s < _wizardStep);
  });

  const prevBtn = document.getElementById('wiz-prev');
  prevBtn.style.visibility = _wizardStep === 0 ? 'hidden' : 'visible';

  const nextBtn = document.getElementById('wiz-next');
  nextBtn.textContent = _wizardStep === 3 ? 'Generera schema' : 'Nästa';

  // Init day button toggles
  document.querySelectorAll('.wiz-day-btn').forEach(btn => {
    btn.onclick = () => btn.classList.toggle('active');
  });

  // Init fitness level pills
  document.querySelectorAll('#wiz-fitness-level .intensity-pill').forEach(pill => {
    pill.onclick = () => {
      document.querySelectorAll('#wiz-fitness-level .intensity-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
    };
  });
}

function wizardPrev() {
  if (_wizardStep > 0) { _wizardStep--; updateWizardUI(); }
}

async function wizardNext() {
  if (_wizardStep < 3) {
    if (_wizardStep === 0 && !_wizardGoalType) {
      await showAlertModal('Välj mål', 'Du måste välja en måltyp för att fortsätta.');
      return;
    }
    _wizardStep++;
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
    },
    preferences: {
      activity_types: activityTypes,
      include_gym: _wizardIncludeGym,
      preferred_rest_days: restDays,
    },
    start_date: startDate,
  };

  // Show loading
  document.querySelectorAll('.wizard-step').forEach(s => s.classList.remove('active'));
  document.getElementById('wizard-step-loading').style.display = 'block';
  document.getElementById('wizard-nav').style.display = 'none';

  try {
    const session = (await sb.auth.getSession()).data.session;
    const res = await fetch(SUPABASE_FUNCTIONS_URL + '/generate-plan', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + session.access_token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const result = await res.json();

    if (!res.ok) {
      throw new Error(result.error || 'Generation failed');
    }

    closePlanWizard();
    document.getElementById('wizard-step-loading').style.display = 'none';
    document.getElementById('wizard-nav').style.display = '';

    await showAlertModal('Schema skapat!', `${result.plan_name}\n${result.weeks} veckor: ${result.start_date} till ${result.end_date}`);

    _activePlan = null;
    _activePlanWeeks = [];
    _activePlanWorkouts = [];
    navigate('schema');

  } catch (e) {
    console.error('Plan generation error:', e);
    document.getElementById('wizard-step-loading').style.display = 'none';
    document.getElementById('wizard-nav').style.display = '';
    _wizardStep = 3;
    updateWizardUI();
    await showAlertModal('Fel', 'Kunde inte generera schema: ' + e.message);
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

async function openPlanManager() {
  const plans = await fetchAllPlansForProfile(currentProfile?.id);
  const listEl = document.getElementById('plan-manager-list');

  if (plans.length === 0) {
    listEl.innerHTML = '<div class="sf-empty">Inga sparade scheman. Skapa ett nytt.</div>';
  } else {
    listEl.innerHTML = plans.map(p => {
      const isActive = p.status === 'active';
      const name = p.name || p.goal_text || 'Träningsplan';
      const dateRange = `${p.start_date} — ${p.end_date}`;
      const goalIcon = GOAL_TYPES.find(g => g.id === p.goal_type)?.icon || '📋';
      return `<div class="plan-manager-item${isActive ? ' active' : ''}" onclick="${isActive ? '' : `activatePlan('${p.id}')`}">
        <span style="font-size:1.2rem;">${goalIcon}</span>
        <div class="pm-info">
          <div class="pm-name">${name}</div>
          <div class="pm-meta">${dateRange}</div>
        </div>
        <span class="pm-status-badge ${p.status}">${isActive ? 'Aktiv' : 'Arkiverad'}</span>
        <div class="pm-actions">
          <button class="pm-action-btn" onclick="event.stopPropagation();renamePlan('${p.id}','${name.replace(/'/g, "\\'")}')" title="Byt namn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
          </button>
          <button class="pm-action-btn danger" onclick="event.stopPropagation();deletePlan('${p.id}')" title="Ta bort">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </div>`;
    }).join('');
  }

  document.getElementById('plan-manager').classList.remove('hidden');
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
    navigate('schema');
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
//  PLAN AI EDIT CHAT
// ═══════════════════════════════════════════════════════════════════

function openPlanEditModal() {
  if (!_activePlan) return;
  const chatEl = document.getElementById('plan-edit-chat');
  chatEl.innerHTML = `<div class="plan-edit-msg bot">Hej! Beskriv vilka ändringar du vill göra i schemat, t.ex. "byt torsdagens pass mot tempo" eller "minska volymen vecka 3".</div>`;
  document.getElementById('plan-edit-input').value = '';
  document.getElementById('plan-edit-modal').classList.remove('hidden');
}

function closePlanEditModal() {
  document.getElementById('plan-edit-modal').classList.add('hidden');
}

async function submitPlanEdit() {
  const input = document.getElementById('plan-edit-input');
  const instruction = input.value.trim();
  if (!instruction || !_activePlan) return;

  const chatEl = document.getElementById('plan-edit-chat');
  const sendBtn = document.getElementById('plan-edit-send');
  chatEl.innerHTML += `<div class="plan-edit-msg user">${escapeHTML(instruction)}</div>`;
  chatEl.innerHTML += `<div class="plan-edit-msg bot" id="plan-edit-loading"><span class="spinner-sm"></span> Uppdaterar schemat...</div>`;
  input.value = '';
  sendBtn.disabled = true;
  chatEl.scrollTop = chatEl.scrollHeight;

  try {
    const planWeeks = await fetchPlanWeeks(_activePlan.id);
    const allWorkouts = [];
    for (const w of planWeeks) {
      const { data } = await sb.from('plan_workouts').select('*').eq('plan_week_id', w.id).order('day_of_week');
      allWorkouts.push(...(data || []));
    }

    const currentPlan = {
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

    const session = (await sb.auth.getSession()).data.session;
    const res = await fetch(SUPABASE_FUNCTIONS_URL + '/generate-plan', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + session.access_token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        profile_id: currentProfile.id,
        mode: 'edit',
        plan_id: _activePlan.id,
        instruction: instruction,
        current_plan: currentPlan,
      }),
    });

    const result = await res.json();
    const loadingEl = document.getElementById('plan-edit-loading');
    if (loadingEl) loadingEl.remove();

    if (!res.ok) throw new Error(result.error || 'Edit failed');

    chatEl.innerHTML += `<div class="plan-edit-msg bot">Schemat har uppdaterats! ${result.plan_name || ''}</div>`;
    _activePlan = null;
    _activePlanWeeks = [];
    _activePlanWorkouts = [];
    loadSchema();
  } catch (e) {
    const loadingEl = document.getElementById('plan-edit-loading');
    if (loadingEl) loadingEl.remove();
    chatEl.innerHTML += `<div class="plan-edit-msg bot" style="color:var(--red);">Fel: ${e.message}</div>`;
  }
  sendBtn.disabled = false;
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

async function topbarSearchUsers() {
  const q = document.getElementById('topbar-search-input').value.trim().toLowerCase();
  const resultsEl = document.getElementById('topbar-search-results');
  if (q.length < 2) { resultsEl.innerHTML = ''; return; }

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
      actionHtml = `<button class="btn btn-sm btn-primary" onclick="event.stopPropagation();topbarAddFriend('${p.id}',this)">Lägg till</button>`;
    }
    return `<div class="topbar-search-result" onclick="topbarViewProfile('${p.id}')">
      <div class="tsr-avatar" style="background:${isEmoji ? 'transparent' : color};font-size:${isEmoji ? '1.2rem' : '0.8rem'};">${avatar}</div>
      <div class="tsr-info">
        <div class="tsr-name">${p.name}</div>
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
      <span class="friend-search-item-name">${p.name}</span>
      ${isFriend
        ? '<span style="font-size:0.75rem;color:var(--text-dim);">Redan tillagd</span>'
        : `<button class="btn btn-sm btn-primary" onclick="sendFriendRequest('${p.id}')">Lägg till</button>`
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
  const el = document.getElementById('friend-list');
  const friendIds = await getAcceptedFriends();

  if (friendIds.length === 0) {
    el.innerHTML = '<div style="padding:12px 0;color:var(--text-dim);font-size:0.82rem;text-align:center;">Inga vänner ännu. Lägg till vänner ovan.</div>';
    return;
  }

  el.innerHTML = friendIds.map(fid => {
    const p = allProfiles.find(pr => pr.id === fid);
    if (!p) return '';
    const avatar = p.avatar || p.name[0].toUpperCase();
    const color = p.color || '#2E86C1';
    const isEmoji = p.avatar && p.avatar.length <= 2;
    return `<div class="friend-item">
      <div class="friend-avatar" style="background:${isEmoji ? 'transparent' : color};font-size:${isEmoji ? '1.2rem' : '0.8rem'};">${avatar}</div>
      <span class="friend-name">${p.name}</span>
      <button class="friend-remove-btn" onclick="removeFriend('${fid}')">Ta bort</button>
    </div>`;
  }).join('');
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

async function renderSocialFeed(append) {
  const feedEl = document.getElementById('social-feed');
  const moreBtn = document.getElementById('social-feed-more');

  const friendIds = await getAcceptedFriends();
  const feedIds = [currentProfile.id, ...friendIds];

  if (feedIds.length === 0) {
    feedEl.innerHTML = '<div class="sf-empty">Lägg till vänner för att se deras aktiviteter i flödet.</div>';
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
    if (!append) feedEl.innerHTML = '<div class="sf-empty">Inga pass att visa. Dina vänner har inte loggat något ännu.</div>';
    moreBtn.classList.add('hidden');
    return;
  }

  const workoutIds = workouts.map(w => w.id);
  const { data: likes } = await sb.from('workout_likes').select('*').in('workout_id', workoutIds);
  const comments = await fetchCommentsBulk(workoutIds);

  const likesByWorkout = {};
  (likes || []).forEach(l => {
    if (!likesByWorkout[l.workout_id]) likesByWorkout[l.workout_id] = [];
    likesByWorkout[l.workout_id].push(l);
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
    const intBadge = w.intensity ? ` <span class="intensity-badge">${w.intensity}</span>` : '';
    const distText = w.distance_km ? ` · ${w.distance_km} km` : '';
    const wLikes = likesByWorkout[w.id] || [];
    const myLike = wLikes.find(l => l.profile_id === currentProfile.id);
    const wComments = commentsByWorkout[w.id] || [];

    const commentsHtml = wComments.slice(-3).map(c => {
      const cp = allProfiles.find(pr => pr.id === c.profile_id);
      return `<div class="sf-comment">
        <span class="sf-comment-name">${cp?.name || 'Okänd'}</span>
        <span class="sf-comment-text">${c.text}</span>
      </div>`;
    }).join('');

    return `<div class="social-feed-item" data-workout-id="${w.id}">
      <div class="sf-header">
        <div class="sf-avatar" style="background:${isEmoji ? 'transparent' : color};font-size:${isEmoji ? '1rem' : '0.75rem'};">${avatar}</div>
        <span class="sf-name">${name}</span>
        <span class="sf-date">${wDate}</span>
      </div>
      <div class="sf-body">
        <div class="sf-workout-label">${w.activity_type}${intBadge}</div>
        <div class="sf-workout-meta">${w.duration_minutes} min${distText}</div>
        ${w.notes ? `<div class="sf-workout-notes">${w.notes}</div>` : ''}
      </div>
      <div class="sf-actions">
        <button class="sf-action-btn${myLike ? ' liked' : ''}" onclick="toggleSocialLike('${w.id}', this)">
          <svg viewBox="0 0 24 24" fill="${myLike ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
          ${wLikes.length > 0 ? wLikes.length : ''}
        </button>
        <button class="sf-action-btn" onclick="toggleSocialComments('${w.id}')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          ${wComments.length > 0 ? wComments.length : ''}
        </button>
      </div>
      <div class="sf-comments hidden" id="sf-comments-${w.id}">${commentsHtml}</div>
      <div class="sf-comment-form hidden" id="sf-comment-form-${w.id}">
        <input type="text" placeholder="Skriv en kommentar..." onkeydown="if(event.key==='Enter')submitSocialComment('${w.id}',this)">
        <button onclick="submitSocialComment('${w.id}',this.previousElementSibling)">Skicka</button>
      </div>
    </div>`;
  }).join('');

  if (append) {
    feedEl.innerHTML += html;
  } else {
    feedEl.innerHTML = html;
  }

  moreBtn.classList.toggle('hidden', workouts.length < SOCIAL_FEED_PAGE_SIZE);
}

async function loadMoreSocialFeed() {
  _socialFeedPage++;
  await renderSocialFeed(true);
}

async function toggleSocialLike(workoutId, btn) {
  try {
    const { data: existing } = await sb.from('workout_likes')
      .select('*')
      .eq('workout_id', workoutId)
      .eq('profile_id', currentProfile.id)
      .maybeSingle();

    if (existing) {
      await sb.from('workout_likes').delete().eq('id', existing.id);
    } else {
      await sb.from('workout_likes').insert({
        workout_id: workoutId,
        profile_id: currentProfile.id,
      });
    }

    const { data: allLikes } = await sb.from('workout_likes')
      .select('*')
      .eq('workout_id', workoutId);
    const myLikeNow = (allLikes || []).find(l => l.profile_id === currentProfile.id);
    const count = (allLikes || []).length;

    btn.classList.toggle('liked', !!myLikeNow);
    const svg = btn.querySelector('svg');
    svg.setAttribute('fill', myLikeNow ? 'currentColor' : 'none');
    btn.innerHTML = '';
    btn.appendChild(svg);
    if (count > 0) btn.append(' ' + count);
  } catch (e) {
    console.error('Toggle like error:', e);
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
        <span class="sf-comment-name">${cp?.name || 'Okänd'}</span>
        <span class="sf-comment-text">${c.text}</span>
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
