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
    const name = document.getElementById('auth-name').value.trim() || email.split('@')[0];
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
      const { error } = await sb.auth.signInWithPassword({ email, password });
      btn.disabled = false;
      btn.textContent = 'Logga in';
      if (error) {
        errEl.style.color = 'var(--red)';
        errEl.textContent = error.message;
        errEl.classList.remove('hidden');
        return;
      }
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
  document.querySelectorAll('#theme-toggle .sm-toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.val === theme));
}

function setUnit(unit) {
  localStorage.setItem('nvdp-unit', unit);
  document.querySelectorAll('#unit-toggle .sm-toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.val === unit));
}

function setWeekStart(ws) {
  localStorage.setItem('nvdp-weekstart', ws);
  document.querySelectorAll('#weekstart-toggle .sm-toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.val === ws));
}

function restoreSettings() {
  const theme = localStorage.getItem('nvdp-theme') || 'dark';
  const unit = localStorage.getItem('nvdp-unit') || 'km';
  const ws = localStorage.getItem('nvdp-weekstart') || 'mon';
  if (theme !== 'dark') document.documentElement.setAttribute('data-theme', theme);
  document.querySelectorAll('#theme-toggle .sm-toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.val === theme));
  document.querySelectorAll('#unit-toggle .sm-toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.val === unit));
  document.querySelectorAll('#weekstart-toggle .sm-toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.val === ws));
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

  const groupSection = document.getElementById('sm-group-section');
  const groupInfo = document.getElementById('sm-group-info');
  if (currentProfile?.group_id) {
    groupSection.style.display = '';
    const code = _cachedGroupCode || '------';
    const memberEls = _cachedGroupMembers || [];
    const memberList = memberEls.map(m => {
      const isMe = m.id === currentProfile.id;
      return `<div class="sm-member">${m.name}${isMe ? ' (du)' : ''}</div>`;
    }).join('');
    groupInfo.innerHTML = `
      <div class="sm-code-row">
        <span class="sm-code">${code}</span>
        <button class="btn btn-sm btn-ghost" onclick="copyGroupCode()">Kopiera</button>
      </div>
      <div class="sm-members">${memberList}</div>
      <button class="sm-item sm-leave" onclick="closeSideMenu();leaveGroup()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        Lämna grupp
      </button>`;
  } else {
    groupSection.style.display = 'none';
  }

  updateStravaUI();
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

  if (view === 'dashboard') loadDashboard();
  else if (view === 'log') resetLogForm();
  else if (view === 'schema') loadSchema();
  else if (view === 'trends') loadTrends();
  else if (view === 'group') loadGroup();
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

  const periods = await fetchPeriods();
  const todayStr = isoDate(now);
  const period = periods.find(p => todayStr >= p.start_date && todayStr <= p.end_date);
  let allPlans = [];
  if (period) allPlans = await fetchPlans(period.id);

  const todayEl = document.getElementById('today-content');
  const tomorrowEl = document.getElementById('tomorrow-content');
  const todayPlan = allPlans.find(p => p.day_of_week === dayOfWeek);
  const tomorrowDow = (dayOfWeek + 1) % 7;
  const tomorrowPlan = allPlans.find(p => p.day_of_week === tomorrowDow);

  if (period) {
    if (todayPlan && todayPlan.is_rest) {
      todayEl.innerHTML = `<div class="today-rest">Vilodag</div>`;
    } else if (todayPlan) {
      todayEl.innerHTML = `<div class="today-workout">${stripDayPrefix(todayPlan.label)}</div>
        <div class="today-desc">${todayPlan.description || ''}</div>`;
    } else {
      todayEl.innerHTML = `<div class="today-rest">Ingen planerad träning</div>`;
    }

    if (tomorrowPlan && tomorrowPlan.is_rest) {
      tomorrowEl.innerHTML = `<div class="tomorrow-rest">Vila</div>`;
    } else if (tomorrowPlan) {
      tomorrowEl.innerHTML = `<div class="tomorrow-workout">${stripDayPrefix(tomorrowPlan.label)}</div>
        <div class="tomorrow-desc">${tomorrowPlan.description || ''}</div>`;
    } else {
      tomorrowEl.innerHTML = `<div class="tomorrow-rest">—</div>`;
    }
  } else {
    todayEl.innerHTML = `<div class="today-rest">Utanför aktiv period</div>`;
    tomorrowEl.innerHTML = '';
  }

  // Weekly schedule card
  if (period) {
    const schedEl = document.getElementById('dash-week-schedule');
    let schedHTML = '<div class="dash-schedule">';
    for (let i = 0; i < 7; i++) {
      const plan = allPlans.find(p => p.day_of_week === i);
      const isTodayRow = i === dayOfWeek;
      const restClass = plan?.is_rest ? ' rest' : '';
      const shortLabel = plan ? (plan.is_rest ? 'Vila' : stripDayPrefix(plan.label)) : '—';
      const desc = plan?.description ? ` — ${plan.description}` : '';
      const indicatorColor = plan?.is_rest ? 'var(--text-dim)' : 'var(--accent)';
      schedHTML += `<div class="dash-sched-row${isTodayRow ? ' is-today' : ''}">
        <span class="sched-day">${DAY_NAMES[i]}</span>
        <span class="sched-indicator" style="background:${isTodayRow ? 'var(--accent)' : indicatorColor};"></span>
        <span class="sched-label${restClass}">${shortLabel}<span class="sched-desc">${desc}</span></span>
      </div>`;
    }
    schedHTML += '</div>';
    schedEl.innerHTML = schedHTML;
  }

  // This week
  const monday = mondayOfWeek(now);
  const sunday = addDays(monday, 6);
  const weekWorkouts = await fetchWorkouts(currentProfile?.id, isoDate(monday), isoDate(sunday));

  const dotsContainer = document.getElementById('week-dots-container');
  let dotsHTML = '';
  let doneCount = 0;
  const trainingDays = [1, 2, 3, 4, 5]; // Tue-Sat by default (but depends on plan)

  for (let i = 0; i < 7; i++) {
    const dayDate = addDays(monday, i);
    const dayStr = isoDate(dayDate);
    const isToday = dayStr === todayStr;
    const dayWorkouts = weekWorkouts.filter(w => w.workout_date === dayStr);
    const isFuture = dayDate > now;

    let dotClass = 'future';
    if (dayWorkouts.length > 0) { dotClass = 'done'; doneCount++; }
    else if (isRestDay(i, allPlans) && !isFuture) { dotClass = 'rest'; }
    else if (!isFuture) { dotClass = 'missed'; }

    const todayClass = isToday ? ' today' : '';
    const mins = dayWorkouts.reduce((s, w) => s + w.duration_minutes, 0);
    dotsHTML += `
      <div class="week-dot">
        <div class="dot ${dotClass}${todayClass}">${mins > 0 ? mins + "'" : (dotClass === 'rest' ? 'R' : '—')}</div>
        <span class="day-label">${DAY_NAMES[i]}</span>
      </div>`;
  }
  dotsContainer.innerHTML = dotsHTML;

  const targetDays = allPlans.length > 0 ? allPlans.filter(p => !p.is_rest).length : 5;
  const pct = Math.round((doneCount / targetDays) * 100);
  document.getElementById('compliance-fill').style.width = Math.min(pct, 100) + '%';
  document.getElementById('compliance-fill').style.background = pct >= 80 ? 'var(--green)' : pct >= 50 ? 'var(--amber)' : 'var(--red)';
  document.getElementById('compliance-pct').textContent = pct + '%';
  document.getElementById('compliance-text').textContent = `${doneCount} av ${targetDays} träningsdagar`;
  document.getElementById('compliance-target').textContent = isDeloadWeek(monday) ? 'Deload-vecka' : '';

  // Weekly summary (shows for completed weeks or on Sunday)
  renderWeeklySummary(weekWorkouts, allPlans, monday, currentProfile);

  // Recent workouts
  const { data: recent } = await sb.from('workouts').select('*')
    .eq('profile_id', currentProfile?.id)
    .order('workout_date', { ascending: false }).limit(5);

  const recentEl = document.getElementById('recent-workouts');
  if (!recent || recent.length === 0) {
    recentEl.innerHTML = '<div class="empty-state"><div class="icon">&#127939;</div><p>Inga pass loggade ännu</p></div>';
  } else {
    recentEl.innerHTML = recent.map(w => {
      const distStr = w.distance_km ? ` | ${w.distance_km} km` : '';
      const intBadge = w.intensity ? `<span class="intensity-badge">${w.intensity}</span>` : '';
      return `
      <div class="workout-item clickable" onclick='openWorkoutModal(${JSON.stringify(w).replace(/'/g, "&#39;")})'>
        <div class="workout-icon" style="background:${ACTIVITY_COLORS[w.activity_type] || '#555'}22;">
          ${activityEmoji(w.activity_type)}
        </div>
        <div class="workout-info">
          <div class="name">${w.activity_type}${intBadge}${stravaSourceBadge(w)}</div>
          <div class="meta">${formatDate(w.workout_date)}${w.notes && w.notes !== 'Importerad' && !w.notes?.startsWith('[Strava]') ? ' — ' + w.notes : ''}</div>
        </div>
        <div class="workout-info duration">${w.duration_minutes} min${distStr}</div>
      </div>`;
    }).join('');
  }
}

function isRestDay(dayIdx, plans) {
  if (!plans || plans.length === 0) return dayIdx === 0 || dayIdx === 6;
  const plan = plans.find(p => p.day_of_week === dayIdx);
  if (!plan) return false;
  return plan.is_rest;
}

function renderWeeklySummary(weekWorkouts, plans, monday, profile) {
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
  const types = {};
  weekWorkouts.forEach(w => { types[w.activity_type] = (types[w.activity_type] || 0) + 1; });
  const topType = Object.entries(types).sort((a, b) => b[1] - a[1])[0];

  const longest = weekWorkouts.reduce((max, w) => w.duration_minutes > (max?.duration_minutes || 0) ? w : max, null);
  const totalDist = weekWorkouts.reduce((s, w) => s + (w.distance_km || 0), 0);

  let plannedSessions = 0;
  if (plans) plans.forEach(p => { if (!p.is_rest) plannedSessions++; });
  const compliance = plannedSessions > 0 ? Math.round((sessionCount / plannedSessions) * 100) : 0;

  const prevMonday = addDays(monday, -7);
  const prevSunday = addDays(prevMonday, 6);

  let items = [];
  items.push(`<div class="ws-stat"><span class="ws-val">${totalHours}h</span><span class="ws-label">total tid</span></div>`);
  items.push(`<div class="ws-stat"><span class="ws-val">${sessionCount}</span><span class="ws-label">pass</span></div>`);
  if (topType) items.push(`<div class="ws-stat"><span class="ws-val">${topType[0]}</span><span class="ws-label">mest ${topType[1]}x</span></div>`);
  if (totalDist > 0) items.push(`<div class="ws-stat"><span class="ws-val">${totalDist.toFixed(1)}km</span><span class="ws-label">distans</span></div>`);
  if (longest) items.push(`<div class="ws-stat"><span class="ws-val">${longest.duration_minutes}'</span><span class="ws-label">längsta</span></div>`);
  if (plannedSessions > 0) items.push(`<div class="ws-stat"><span class="ws-val">${compliance}%</span><span class="ws-label">efterlevnad</span></div>`);

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
  body += `<div class="modal-detail-row"><span class="mdr-label">Aktivitet</span><span class="mdr-value">${w.activity_type} ${intBadge}${stravaSourceBadge(w)}</span></div>`;
  body += `<div class="modal-detail-row"><span class="mdr-label">Datum</span><span class="mdr-value">${w.workout_date}</span></div>`;
  body += `<div class="modal-detail-row"><span class="mdr-label">Tid</span><span class="mdr-value">${w.duration_minutes} min</span></div>`;
  if (w.distance_km) body += `<div class="modal-detail-row"><span class="mdr-label">Distans</span><span class="mdr-value">${w.distance_km} km</span></div>`;
  if (w.workout_time) body += `<div class="modal-detail-row"><span class="mdr-label">Klockslag</span><span class="mdr-value">${w.workout_time}</span></div>`;
  if (w.notes && w.notes !== 'Importerad' && !w.notes?.startsWith('[Strava]')) body += `<div class="modal-detail-row"><span class="mdr-label">Anteckning</span><span class="mdr-value">${w.notes}</span></div>`;
  if (w.source === 'strava') body += `<div class="modal-detail-row"><span class="mdr-label">Källa</span><span class="mdr-value" style="color:#FC4C02;">Strava auto-import</span></div>`;

  body += `<div id="wm-reactions" class="wm-reactions"><span class="text-dim">Laddar...</span></div>`;
  body += `<div id="wm-comments" class="wm-comments"><span class="text-dim">Laddar...</span></div>`;

  document.getElementById('wm-body').innerHTML = body;

  const actionsEl = document.getElementById('wm-edit-actions');
  if (actionsEl) actionsEl.style.display = isOwn ? 'flex' : 'none';

  document.getElementById('workout-modal').classList.remove('hidden');

  loadModalSocial(w.id);
}

async function loadModalSocial(workoutId) {
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

  const commEl = document.getElementById('wm-comments');
  if (commEl) {
    let html = '<div class="comments-section">';
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
    }
    html += `<div class="comment-input-row">
      <input type="text" id="wm-comment-input" class="comment-input" placeholder="Skriv en kommentar..." onkeydown="if(event.key==='Enter')handleAddComment('${workoutId}')">
      <button class="btn btn-sm btn-primary comment-send" onclick="handleAddComment('${workoutId}')">Skicka</button>
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
async function _loadSchema() {
  const tabsEl = document.getElementById('schema-person-tabs');
  tabsEl.innerHTML = '';
  if (allProfiles.length > 0) {
    if (schemaPersonIdx >= allProfiles.length) schemaPersonIdx = 0;
    allProfiles.forEach((p, i) => {
      const btn = document.createElement('button');
      btn.className = 'schema-tab' + (i === schemaPersonIdx ? ' active' : '');
      btn.textContent = p.name;
      btn.onclick = () => { schemaPersonIdx = i; loadSchema(); };
      tabsEl.appendChild(btn);
    });
  }

  const profile = allProfiles[schemaPersonIdx] || currentProfile;
  const now = new Date();
  const currentMonday = mondayOfWeek(now);
  const targetMonday = addDays(currentMonday, schemaWeekOffset * 7);
  const targetSunday = addDays(targetMonday, 6);
  const wk = weekNumber(targetMonday);
  const deload = isDeloadWeek(targetMonday);

  document.getElementById('schema-week-label').textContent =
    `V${wk}${deload ? ' (Deload)' : ''} — ${formatDate(targetMonday)} till ${formatDate(targetSunday)}`;
  const todayBtn = document.getElementById('schema-today-btn');
  if (todayBtn) todayBtn.classList.toggle('hidden', schemaWeekOffset === 0);

  const workouts = await fetchWorkouts(profile?.id, isoDate(targetMonday), isoDate(targetSunday));

  // Fetch plans
  const periods = await fetchPeriods();
  const mondayStr = isoDate(targetMonday);
  const period = periods.find(p => mondayStr >= p.start_date && mondayStr <= p.end_date);
  let plans = [];
  if (period) plans = await fetchPlans(period.id);

  renderSchema(workouts, plans, targetMonday, deload);
}

function schemaWeekPrev() {
  const now = new Date();
  const currentMonday = mondayOfWeek(now);
  const targetMonday = addDays(currentMonday, (schemaWeekOffset - 1) * 7);
  const minMonday = new Date(P1_START);
  if (targetMonday < minMonday) return;
  schemaWeekOffset--;
  loadSchema();
}
function schemaWeekNext() { schemaWeekOffset++; loadSchema(); }
function schemaWeekToday() { schemaWeekOffset = 0; loadSchema(); }

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

function scaleDuration(desc, factor) {
  if (!desc) return desc;
  return desc.replace(/(\d+)([–\-])(\d+)(\s*min)/g, (_, lo, dash, hi, suffix) => {
    return Math.round(parseInt(lo) * factor) + dash + Math.round(parseInt(hi) * factor) + suffix;
  }).replace(/(?<!\d[–\-])(\d+)(\s*min)(?![^(]*\))/g, (_, num, suffix) => {
    return Math.round(parseInt(num) * factor) + suffix;
  });
}

function projectPlan(plan, weekIdx, isDeload) {
  if (!plan || plan.is_rest) return plan;
  const buildIdx = getBuildWeekIndex(weekIdx);
  const factor = isDeload ? 0.7 : Math.pow(1.08, buildIdx);
  const projected = { ...plan };
  projected.label = stripDayPrefix(plan.label);
  projected.description = scaleDuration(plan.description, factor);

  if (!isDeload && buildIdx >= 4 && plan.day_of_week === 4) {
    projected.label = 'Kvalitet';
    const baseDesc = plan.description || '';
    projected.description = scaleDuration(
      baseDesc.replace(/lugn[a]?\s*/i, '').replace(/Z1[–\-]?Z2|Z2/i, 'inkl intervaller'),
      factor
    );
  }
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

function renderSchema(workouts, plans, monday, isDeload) {
  const container = document.getElementById('schema-content');
  const todayStr = isoDate(new Date());
  const weekIdx = getWeekIndexInPeriod(monday);

  let html = '';
  for (let i = 0; i < 7; i++) {
    const dayDate = addDays(monday, i);
    const dayStr = isoDate(dayDate);
    const basePlan = plans.find(p => p.day_of_week === i);
    const plan = projectPlan(basePlan, weekIdx, isDeload);
    const dayWorkouts = workouts.filter(w => w.workout_date === dayStr);
    const isToday = dayStr === todayStr;
    const isFuture = dayDate > new Date();
    const totalMins = dayWorkouts.reduce((s, w) => s + w.duration_minutes, 0);

    let statusClass = 'future';
    if (dayWorkouts.length > 0) statusClass = 'done';
    else if (plan?.is_rest) statusClass = 'rest';
    else if (!isFuture) statusClass = 'missed';

    let planText = '';
    if (plan?.is_rest) {
      planText = '<span class="sr-rest-label">Vila</span>';
    } else if (plan) {
      const dd = dedupPlanText(plan.label, plan.description);
      if (dd.desc) {
        planText = dd.desc;
      } else if (dd.label) {
        planText = dd.label;
      }
    }

    let rightContent = '';
    if (dayWorkouts.length > 0) {
      const wList = dayWorkouts.map(w => {
        const intB = w.intensity ? ` <span class="intensity-badge">${w.intensity}</span>` : '';
        return `<span class="clickable-workout" onclick='openWorkoutModal(${JSON.stringify(w).replace(/'/g, "&#39;")})'>${w.duration_minutes}'${intB}${stravaSourceBadge(w)}</span>`;
      }).join(' ');
      rightContent = `<div class="sr-done-info">${wList}</div>`;
    } else if (statusClass === 'missed') {
      rightContent = '<div class="sr-missed-mark">Missat</div>';
    }

    html += `<div class="sr-card${isToday ? ' sr-today' : ''} sr-${statusClass}">
      <div class="sr-left">
        <div class="sr-day">${DAY_NAMES[i]}</div>
        <div class="sr-date">${dayDate.getDate()}/${dayDate.getMonth() + 1}</div>
      </div>
      <div class="sr-main">
        <div class="sr-plan-text">${planText}</div>
      </div>
      <div class="sr-right-status">${rightContent}</div>
    </div>`;
  }

  container.innerHTML = html;
}

// ═══════════════════════
//  TRENDS (Personal)
// ═══════════════════════
let chartMixPersonal = null;

function setTrendMode(mode) {
  trendMode = mode;
  document.getElementById('toggle-cardio').classList.toggle('active', mode === 'cardio');
  document.getElementById('toggle-total').classList.toggle('active', mode === 'total');
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
  myWorkouts.forEach(w => {
    const mon = mondayOfWeek(new Date(w.workout_date));
    const key = isoDate(mon);
    if (!weekData[key]) weekData[key] = {};
    weekData[key][w.activity_type] = (weekData[key][w.activity_type] || 0) + w.duration_minutes;
  });

  const weeks = Object.keys(weekData).sort();
  const labels = weeks.map(w => {
    const mon = new Date(w);
    const wn = weekNumber(mon);
    return isDeloadWeek(mon) ? `V${wn} (D)` : `V${wn}`;
  });
  const myData = weeks.map(w => {
    const d = weekData[w];
    const types = trendMode === 'cardio' ? CARDIO_TYPES : [...CARDIO_TYPES, 'Gym'];
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
          return `${c.parsed.y.toFixed(1)} h${pct}`;
        }}},
      },
      scales: {
        y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#888', callback: v => v.toFixed(1) + 'h' } },
        x: { grid: { display: false }, ticks: { color: '#888' } }
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
      return myWorkouts.filter(w => {
        const wMon = isoDate(mondayOfWeek(new Date(w.workout_date)));
        if (wMon !== mondayStr) return false;
        if (!types.includes(w.activity_type)) return false;
        const wDow = (new Date(w.workout_date).getDay() + 6) % 7;
        return wDow <= maxDow;
      }).reduce((s, w) => s + w.duration_minutes, 0) / 60;
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
        <span class="vd-val">${curr.toFixed(1)}h / ${prev.toFixed(1)}h</span>
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
    const datasets = types.filter(t => weeks.some(w => (weekData[w][t] || 0) > 0)).map(t => ({
      label: t,
      data: weeks.map(w => (weekData[w][t] || 0) / 60),
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
          tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.parsed.y.toFixed(1)} h` } }
        },
        scales: {
          y: { stacked: true, beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#888', callback: v => v.toFixed(1) + 'h' } },
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

  // Season totals pie chart
  const pieCanvas = document.getElementById('chart-season-pie');
  if (pieCanvas) {
    if (window._chartSeasonPie) window._chartSeasonPie.destroy();
    const byType = {};
    myWorkouts.forEach(w => { byType[w.activity_type] = (byType[w.activity_type] || 0) + w.duration_minutes; });
    const totalAll = myWorkouts.reduce((s, w) => s + w.duration_minutes, 0);
    const types = Object.keys(byType).sort();
    window._chartSeasonPie = new Chart(pieCanvas.getContext('2d'), {
      type: 'doughnut',
      data: {
        labels: types,
        datasets: [{ data: types.map(t => +(byType[t] / 60).toFixed(1)), backgroundColor: types.map(t => ACTIVITY_COLORS[t] || '#555'), borderWidth: 0 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        cutout: '55%',
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              color: getComputedStyle(document.body).getPropertyValue('--text-muted').trim() || '#aaa',
              padding: 12, usePointStyle: true, pointStyle: 'circle', font: { size: 11 },
              generateLabels: (chart) => {
                const ds = chart.data.datasets[0];
                return chart.data.labels.map((l, i) => ({
                  text: `${l}  ${ds.data[i]}h`,
                  fillStyle: ds.backgroundColor[i],
                  pointStyle: 'circle',
                  hidden: false, index: i
                }));
              }
            }
          },
          tooltip: {
            z: 9999,
            callbacks: { label: c => {
              const pct = totalAll > 0 ? Math.round((byType[c.label] / totalAll) * 100) : 0;
              return ` ${c.label}: ${c.parsed}h (${pct}%)`;
            }}
          }
        }
      },
      plugins: [{
        id: 'centerTotal',
        afterDraw(chart) {
          const { ctx, width, height } = chart;
          const x = chart.chartArea.left + (chart.chartArea.right - chart.chartArea.left) / 2;
          const y = chart.chartArea.top + (chart.chartArea.bottom - chart.chartArea.top) / 2;
          ctx.save();
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.font = '700 1.1rem ' + getComputedStyle(document.body).fontFamily;
          ctx.fillStyle = '#fff';
          ctx.fillText((totalAll / 60).toFixed(1) + 'h', x, y);
          ctx.restore();
        }
      }]
    });
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
let chartGroupWeekly = null;
let _cachedGroupWorkouts = [];
let _cachedGroupMembers = [];
let _cachedGroupCode = '';

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

  const weekHours = members.map(m => {
    const mw = allWorkouts.filter(w => w.profile_id === m.id && w.workout_date >= isoDate(monday) && w.workout_date <= isoDate(sunday));
    return { name: m.name, hours: mw.reduce((s, w) => s + w.duration_minutes, 0) / 60, id: m.id };
  }).sort((a, b) => b.hours - a.hours);

  const lbEl = document.getElementById('group-leaderboard');
  const rankClasses = ['gold', 'silver', 'bronze'];
  lbEl.innerHTML = weekHours.map((m, i) => `
    <div class="lb-row">
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
  renderChallenges(allWorkouts, members);
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
  document.getElementById('grp-toggle-cardio').classList.toggle('active', mode === 'cardio');
  document.getElementById('grp-toggle-total').classList.toggle('active', mode === 'total');
  if (_cachedGroupWorkouts.length > 0 && _cachedGroupMembers.length > 0) {
    renderGroupChart(_cachedGroupWorkouts, _cachedGroupMembers);
  } else {
    loadGroup();
  }
}

function renderGroupChart(allWorkouts, members) {
  const colors = ['#2E86C1', '#E74C3C', '#2ECC71', '#9B59B6', '#F39C12', '#1ABC9C'];
  const weekData = {};
  allWorkouts.forEach(w => {
    const mon = mondayOfWeek(new Date(w.workout_date));
    const key = isoDate(mon);
    if (!weekData[key]) weekData[key] = {};
    const types = grpChartMode === 'cardio' ? CARDIO_TYPES : [...CARDIO_TYPES, 'Gym'];
    if (!types.includes(w.activity_type)) return;
    weekData[key][w.profile_id] = (weekData[key][w.profile_id] || 0) + w.duration_minutes;
  });

  const weeks = Object.keys(weekData).sort();
  const labels = weeks.map(w => `V${weekNumber(new Date(w))}`);

  if (chartGroupWeekly) chartGroupWeekly.destroy();
  const canvas = document.getElementById('chart-group-weekly');
  if (!canvas) return;

  const datasets = members.map((m, i) => ({
    label: m.name.split(' ')[0],
    data: weeks.map(w => (weekData[w]?.[m.id] || 0) / 60),
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
        tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.parsed.y.toFixed(1)} h` } }
      },
      scales: {
        y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#888', callback: v => v.toFixed(1) + 'h' } },
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
    const btn = document.querySelector('.sm-code-row .btn');
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = 'Kopierad!';
    setTimeout(() => btn.textContent = orig, 1500);
  });
}

// ═══════════════════════
//  CHALLENGES
// ═══════════════════════
async function renderChallenges(allWorkouts, members) {
  const el = document.getElementById('group-challenges');
  if (!el || !currentProfile?.group_id) return;

  let challenges = [];
  try {
    const { data } = await sb.from('challenges').select('*')
      .eq('group_id', currentProfile.group_id)
      .order('end_date', { ascending: false });
    challenges = data || [];
  } catch (e) { console.error('Challenges fetch error:', e); }

  if (challenges.length === 0) {
    el.innerHTML = '<div class="empty-state" style="padding:12px 0;"><p style="font-size:0.85rem;">Inga utmaningar ännu</p></div>';
    return;
  }

  const now = new Date();
  const todayStr = isoDate(now);
  const colors = ['#2E86C1', '#E74C3C', '#2ECC71', '#9B59B6', '#F39C12', '#1ABC9C'];

  el.innerHTML = challenges.slice(0, 5).map(ch => {
    const isActive = todayStr >= ch.start_date && todayStr <= ch.end_date;
    const isPast = todayStr > ch.end_date;
    const statusClass = isActive ? 'ch-active' : isPast ? 'ch-past' : 'ch-future';

    const scores = members.map(m => {
      const mw = allWorkouts.filter(w => {
        if (w.profile_id !== m.id) return false;
        if (w.workout_date < ch.start_date || w.workout_date > ch.end_date) return false;
        if (ch.activity_filter && w.activity_type !== ch.activity_filter) return false;
        return true;
      });
      let val = 0;
      if (ch.metric === 'hours') val = mw.reduce((s, w) => s + w.duration_minutes, 0) / 60;
      else if (ch.metric === 'sessions') val = mw.length;
      else if (ch.metric === 'km') val = mw.reduce((s, w) => s + (w.distance_km || 0), 0);
      return { name: m.name.split(' ')[0], val, avatar: m.avatar || m.name[0].toUpperCase(), color: colors[members.indexOf(m) % colors.length] };
    }).sort((a, b) => b.val - a.val);

    const unit = ch.metric === 'hours' ? 'h' : ch.metric === 'km' ? 'km' : 'st';
    const maxVal = Math.max(...scores.map(s => s.val), 1);

    const barsHTML = scores.map((s, i) => `
      <div class="ch-score-row">
        <span class="ch-rank">${i === 0 && s.val > 0 ? '👑' : (i + 1)}</span>
        <span class="ch-score-name">${s.avatar} ${s.name}</span>
        <div class="ch-score-bar"><div class="ch-score-fill" style="width:${(s.val/maxVal)*100}%;background:${s.color};"></div></div>
        <span class="ch-score-val">${s.val.toFixed(ch.metric === 'sessions' ? 0 : 1)}${unit}</span>
      </div>`).join('');

    const daysLeft = isActive ? Math.ceil((new Date(ch.end_date) - now) / 86400000) : 0;
    const statusText = isActive ? `${daysLeft}d kvar` : isPast ? 'Avslutad' : `Startar ${ch.start_date}`;

    return `<div class="challenge-card ${statusClass}">
      <div class="ch-header">
        <span class="ch-title">${ch.title}</span>
        <span class="ch-status">${statusText}</span>
      </div>
      <div class="ch-scores">${barsHTML}</div>
    </div>`;
  }).join('');
}

async function openCreateChallenge() {
  const title = prompt('Namn på utmaningen:');
  if (!title) return;

  const metricMap = { '1': 'hours', '2': 'sessions', '3': 'km' };
  const metricChoice = prompt('Mätvärde:\n1. Timmar\n2. Antal pass\n3. Kilometer');
  const metric = metricMap[metricChoice];
  if (!metric) { await showAlertModal('Fel', 'Ogiltigt val'); return; }

  const daysStr = prompt('Antal dagar (t.ex. 7 för en vecka, 30 för en månad):', '7');
  const days = parseInt(daysStr);
  if (!days || days < 1) return;

  const startDate = isoDate(new Date());
  const endDate = isoDate(addDays(new Date(), days - 1));

  const { error } = await sb.from('challenges').insert({
    group_id: currentProfile.group_id,
    created_by: currentProfile.id,
    title,
    metric,
    start_date: startDate,
    end_date: endDate
  });

  if (error) { await showAlertModal('Fel', error.message); return; }
  loadGroup();
}

// ═══════════════════════
//  GROUP WEEKLY DETAIL + NUDGE
// ═══════════════════════
let _sentNudges = new Set();

function renderGroupWeekDetail(allWorkouts, members, plans) {
  const el = document.getElementById('group-week-detail');
  if (!el) return;

  const now = new Date();
  const monday = mondayOfWeek(now);
  const todayStr = isoDate(now);
  const todayDow = (now.getDay() + 6) % 7;
  const colors = ['#2E86C1', '#E74C3C', '#2ECC71', '#9B59B6', '#F39C12', '#1ABC9C'];

  el.innerHTML = members.map((m, mi) => {
    const isMe = m.id === currentProfile.id;
    let totalMins = 0;
    let missedCount = 0;

    const daysHTML = Array.from({ length: 7 }, (_, di) => {
      const dayDate = addDays(monday, di);
      const dayStr = isoDate(dayDate);
      const dayW = allWorkouts.filter(w => w.profile_id === m.id && w.workout_date === dayStr);
      const mins = dayW.reduce((s, w) => s + w.duration_minutes, 0);
      totalMins += mins;
      const isFuture = dayDate > now;
      const isRest = isRestDay(di, plans);

      let cls = 'future';
      if (mins > 0) cls = 'done';
      else if (isRest) cls = 'rest';
      else if (!isFuture) { cls = 'missed'; missedCount++; }

      const label = mins > 0 ? mins + "'" : (cls === 'rest' ? '—' : (cls === 'missed' ? '✗' : '·'));
      return `<div class="grp-day-cell ${cls}"><div class="day-lbl">${DAY_NAMES[di]}</div>${label}</div>`;
    }).join('');

    const nudgeId = `nudge-${m.id}`;
    const canNudge = !isMe && missedCount > 0;
    const alreadySent = _sentNudges.has(m.id);
    const nudgeHTML = canNudge
      ? `<button class="nudge-btn${alreadySent ? ' sent' : ''}" id="${nudgeId}" onclick="sendNudge('${m.id}', '${m.name}', this)" ${alreadySent ? 'disabled' : ''}>
           ${alreadySent ? '✓ Puff skickad' : '👊 Ge en puff'}
         </button>`
      : '';

    return `<div class="grp-member-week">
      <div class="grp-mw-header">
        <div class="grp-mw-avatar" style="background:${colors[mi % colors.length]}">${m.name[0].toUpperCase()}</div>
        <div class="grp-mw-name">${m.name}${isMe ? ' (du)' : ''}</div>
        <div class="grp-mw-total">${(totalMins / 60).toFixed(1)}h</div>
      </div>
      <div class="grp-mw-days">${daysHTML}</div>
      ${nudgeHTML}
    </div>`;
  }).join('');
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
  const reactions = await fetchReactionsBulk(workoutIds);
  _feedReactionsCache = { recent: _feedAllItems, members, reactions };

  feedEl.innerHTML = renderFeedItems(visible, members, reactions);
  if (moreBtn) moreBtn.classList.toggle('hidden', _feedShown >= _feedAllItems.length);
}

async function showMoreFeed() {
  if (!_feedReactionsCache) return;
  const { members, reactions: prevReactions } = _feedReactionsCache;
  const nextBatch = _feedAllItems.slice(_feedShown, _feedShown + FEED_PAGE);
  if (nextBatch.length === 0) return;

  const newIds = nextBatch.map(w => w.id);
  const newReactions = await fetchReactionsBulk(newIds);
  const allReactions = [...prevReactions, ...newReactions];
  _feedReactionsCache.reactions = allReactions;

  const feedEl = document.getElementById('group-feed');
  feedEl.innerHTML += renderFeedItems(nextBatch, members, allReactions);
  _feedShown += nextBatch.length;

  const moreBtn = document.getElementById('feed-more-btn');
  if (moreBtn) moreBtn.classList.toggle('hidden', _feedShown >= _feedAllItems.length);
}

function renderFeedItems(items, members, reactions) {
  const colors = ['#2E86C1', '#E74C3C', '#2ECC71', '#9B59B6', '#F39C12', '#1ABC9C'];
  return items.map(w => {
    const globalIdx = _feedAllItems.indexOf(w);
    const mi = members.findIndex(m => m.id === w.profile_id);
    const member = members[mi] || {};
    const color = colors[mi % colors.length] || '#2E86C1';
    const likes = reactions.filter(r => r.workout_id === w.id && r.reaction === 'like');
    const dislikes = reactions.filter(r => r.workout_id === w.id && r.reaction === 'dislike');
    const myReaction = reactions.find(r => r.workout_id === w.id && r.profile_id === currentProfile.id);

    const intBadge = w.intensity ? `<span class="intensity-badge">${w.intensity}</span>` : '';
    const notesSnip = w.notes && w.notes !== 'Importerad' ? `<div class="feed-notes">${escapeHTML(w.notes)}</div>` : '';

    return `<div class="feed-item" onclick="openFeedWorkout(${globalIdx})">
      <div class="feed-header">
        <div class="feed-avatar" style="background:${color}">${(member.name || '?')[0].toUpperCase()}</div>
        <div class="feed-info">
          <div class="feed-name">${member.name || '?'}</div>
          <div class="feed-date">${formatDate(w.workout_date)}</div>
        </div>
        <div class="feed-type">${activityEmoji(w.activity_type)} ${w.duration_minutes}'${intBadge}${stravaSourceBadge(w)}</div>
      </div>
      ${notesSnip}
      <div class="feed-reactions" onclick="event.stopPropagation()">
        <button class="react-btn-sm${myReaction?.reaction === 'like' ? ' active' : ''}" onclick="event.stopPropagation();handleFeedReaction('${w.id}','like')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg> ${likes.length || ''}
        </button>
        <button class="react-btn-sm${myReaction?.reaction === 'dislike' ? ' active' : ''}" onclick="event.stopPropagation();handleFeedReaction('${w.id}','dislike')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14"><path d="M10 15V19a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z"/><path d="M17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg> ${dislikes.length || ''}
        </button>
      </div>
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

    // Trigger push notification if possible
    sendPushToUser(receiverId);
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
      .limit(20);

    const listEl = document.getElementById('nudge-list');
    if (!nudges || nudges.length === 0) {
      listEl.innerHTML = '<div class="empty-state"><p>Inga notiser</p></div>';
      return;
    }

    const senderIds = [...new Set(nudges.map(n => n.sender_id))];
    const senderProfiles = {};
    for (const p of allProfiles) { senderProfiles[p.id] = p; }

    listEl.innerHTML = nudges.map(n => {
      const sender = senderProfiles[n.sender_id];
      const senderName = sender ? sender.name : 'Någon';
      const timeAgo = formatTimeAgo(new Date(n.created_at));
      return `<div class="nudge-item${n.seen ? '' : ' unread'}">
        <div class="nudge-icon">👊</div>
        <div class="nudge-content">
          <div class="nudge-sender">${senderName}</div>
          <div class="nudge-msg">${n.message}</div>
          <div class="nudge-time">${timeAgo}</div>
        </div>
      </div>`;
    }).join('');

    // Mark unseen as seen
    const unseenIds = nudges.filter(n => !n.seen).map(n => n.id);
    if (unseenIds.length > 0) {
      await sb.from('nudges').update({ seen: true }).in('id', unseenIds);
      updateNudgeBadge();
    }
  } catch (e) {
    console.error('Load nudges error:', e);
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
          <button class="strava-disconnect-btn" onclick="disconnectStrava()">Koppla från</button>
        </div>
      </div>`;
  } else {
    el.innerHTML = `
      <button class="strava-connect-btn" onclick="connectStrava()">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M15.387 17.944l-2.089-4.116h-3.065L15.387 24l5.15-10.172h-3.066m-7.008-5.599l2.836 5.599h4.172L10.463 0l-7 13.828h4.169"/></svg>
        Koppla Strava
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
