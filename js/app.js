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
let chartMixNiklas = null;
let chartMixLove = null;
let chartCompareWeekly = null;
let cmpChartMode = 'cardio';

// ── Day Names ──
const DAY_NAMES = ['Mån', 'Tis', 'Ons', 'Tors', 'Fre', 'Lör', 'Sön'];
const DAY_NAMES_FULL = ['Måndag', 'Tisdag', 'Onsdag', 'Torsdag', 'Fredag', 'Lördag', 'Söndag'];

// ── Init ──
let _initDone = false;

function gateOpen() {
  return sessionStorage.getItem('gate_passed') === '1';
}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    sb.auth.onAuthStateChange(async (event, session) => {
      try {
        if (event === 'SIGNED_IN' && session && !_initDone) {
          await initApp(session.user);
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
      if (gateOpen()) await initApp(session.user);
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
  await sb.auth.signOut();
  showAuth();
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
async function initApp(user) {
  if (_initDone) return;
  _initDone = true;
  try {
    currentUser = user;
    document.getElementById('auth-view').style.display = 'none';
    document.getElementById('app').classList.add('active');

    const profilesPromise = sb.from('profiles').select('*');
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Profiles query timed out')), 8000));
    let profiles = null, profErr = null;
    try {
      const result = await Promise.race([profilesPromise, timeoutPromise]);
      profiles = result.data;
      profErr = result.error;
    } catch (e) {
      profErr = e;
    }
    if (profErr) console.error('Profiles fetch error:', profErr);
    allProfiles = profiles || [];
    currentProfile = allProfiles.find(p => p.user_id === user.id) || allProfiles[0];

    if (!currentProfile && allProfiles.length === 0) {
      console.warn('[NVDP] No profiles found. Creating profile for current user...');
      const fallbackName = user.user_metadata?.name || user.email?.split('@')[0] || 'User';
      const { data: newProfile, error: insertErr } = await sb.from('profiles')
        .insert({ user_id: user.id, name: fallbackName })
        .select()
        .single();
      if (insertErr) {
        console.error('[NVDP] Profile insert failed (RLS may block this):', insertErr);
      } else if (newProfile) {
        allProfiles = [newProfile];
        currentProfile = newProfile;
        console.log('[NVDP] Created profile:', newProfile);
      }
    }

    document.getElementById('user-name').textContent = currentProfile?.name || user.email;
    document.getElementById('user-avatar').textContent = (currentProfile?.name || 'U')[0].toUpperCase();

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
  else if (view === 'compare') loadCompare();
}

// ═══════════════════════
//  HELPERS
// ═══════════════════════
function isoDate(d) { return d.toISOString().slice(0, 10); }

function mondayOfWeek(d) {
  const dt = new Date(d);
  const day = dt.getDay();
  const diff = (day === 0 ? -6 : 1) - day;
  dt.setDate(dt.getDate() + diff);
  dt.setHours(0, 0, 0, 0);
  return dt;
}

function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }

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
  try { await _loadDashboard(); } catch (e) { console.error('Dashboard error:', e); }
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

  // Today + Tomorrow recommendation
  const todayEl = document.getElementById('today-content');
  const todayPlan = allPlans.find(p => p.day_of_week === dayOfWeek);
  const tomorrowDow = (dayOfWeek + 1) % 7;
  const tomorrowPlan = allPlans.find(p => p.day_of_week === tomorrowDow);

  if (period) {
    let todayHTML = '<div class="today-row">';
    todayHTML += '<div class="today-main">';
    if (todayPlan && todayPlan.is_rest) {
      todayHTML += `<div class="today-rest">Vilodag</div>`;
    } else if (todayPlan) {
      todayHTML += `<div class="today-workout">${stripDayPrefix(todayPlan.label)}</div>
        <div class="today-desc">${todayPlan.description || ''}</div>`;
    } else {
      todayHTML += `<div class="today-rest">Ingen planerad träning</div>`;
    }
    todayHTML += '</div>';
    todayHTML += '<div class="tomorrow-box">';
    todayHTML += '<div class="tomorrow-label">Imorgon</div>';
    if (tomorrowPlan && tomorrowPlan.is_rest) {
      todayHTML += '<div class="tomorrow-value rest">Vila</div>';
    } else if (tomorrowPlan) {
      todayHTML += `<div class="tomorrow-value">${stripDayPrefix(tomorrowPlan.label)}</div>`;
    } else {
      todayHTML += '<div class="tomorrow-value">—</div>';
    }
    todayHTML += '</div></div>';
    todayEl.innerHTML = todayHTML;
  } else {
    todayEl.innerHTML = `<div class="today-rest">Utanför aktiv period</div>`;
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
    else if (isRestDay(i, period, periods) && !isFuture) { dotClass = 'rest'; }
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

  const targetDays = 5;
  const pct = Math.round((doneCount / targetDays) * 100);
  document.getElementById('compliance-fill').style.width = Math.min(pct, 100) + '%';
  document.getElementById('compliance-fill').style.background = pct >= 80 ? 'var(--green)' : pct >= 50 ? 'var(--amber)' : 'var(--red)';
  document.getElementById('compliance-pct').textContent = pct + '%';
  document.getElementById('compliance-text').textContent = `${doneCount} av ${targetDays} träningsdagar`;
  document.getElementById('compliance-target').textContent = isDeloadWeek(monday) ? 'Deload-vecka' : '';

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
      <div class="workout-item">
        <div class="workout-icon" style="background:${ACTIVITY_COLORS[w.activity_type] || '#555'}22;">
          ${activityEmoji(w.activity_type)}
        </div>
        <div class="workout-info">
          <div class="name">${w.activity_type}${intBadge}</div>
          <div class="meta">${formatDate(w.workout_date)}${w.notes && w.notes !== 'Importerad' ? ' — ' + w.notes : ''}</div>
        </div>
        <div class="workout-info duration">${w.duration_minutes} min${distStr}</div>
      </div>`;
    }).join('');
  }
}

function isRestDay(dayIdx, currentPeriod, periods) {
  if (!currentPeriod) return dayIdx === 0 || dayIdx === 6;
  // For now, rest = Mon (0) and Sun (6) per the plan
  return dayIdx === 0 || dayIdx === 6;
}

function activityEmoji(type) {
  const map = { 'Löpning': '&#127939;', 'Cykel': '&#128690;', 'Gym': '&#127947;', 'Annat': '&#9889;', 'Hyrox': '&#128293;', 'Stakmaskin': '&#129494;', 'Längdskidor': '&#9924;', 'Vila': '&#128164;' };
  return map[type] || '&#9889;';
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
  if (distance !== null) row.distance_km = distance;
  if (intensity) row.intensity = intensity;

  const { error } = await sb.from('workouts').insert(row);

  if (error) {
    alert('Kunde inte spara: ' + error.message);
    return;
  }

  document.getElementById('log-form-container').classList.add('hidden');
  document.getElementById('log-success').classList.remove('hidden');
  const intLabel = intensity ? ` (${intensity})` : '';
  document.getElementById('log-success-text').textContent = `${type}${intLabel} ${mins} min — ${formatDate(date)}`;
});

function resetLogForm() {
  document.getElementById('log-form-container').classList.remove('hidden');
  document.getElementById('log-success').classList.add('hidden');
  document.getElementById('log-form').reset();
  document.getElementById('log-date').value = isoDate(new Date());
  document.getElementById('log-intensity').value = '';
  document.querySelectorAll('.intensity-pill').forEach(p => p.classList.remove('active'));
}

// ═══════════════════════
//  SCHEMA
// ═══════════════════════
async function loadSchema() {
  const tabsEl = document.getElementById('schema-person-tabs');
  if (allProfiles.length > 0 && tabsEl.children.length === 0) {
    allProfiles.forEach((p, i) => {
      const btn = document.createElement('button');
      btn.className = 'schema-tab' + (i === schemaPersonIdx ? ' active' : '');
      btn.textContent = p.name;
      btn.onclick = () => { schemaPersonIdx = i; loadSchema(); };
      tabsEl.appendChild(btn);
    });
  }
  tabsEl.querySelectorAll('.schema-tab').forEach((t, i) => {
    t.classList.toggle('active', i === schemaPersonIdx);
  });

  const profile = allProfiles[schemaPersonIdx] || currentProfile;
  const now = new Date();
  const currentMonday = mondayOfWeek(now);
  const targetMonday = addDays(currentMonday, schemaWeekOffset * 7);
  const targetSunday = addDays(targetMonday, 6);
  const wk = weekNumber(targetMonday);
  const deload = isDeloadWeek(targetMonday);

  document.getElementById('schema-week-label').textContent =
    `Vecka ${wk}${deload ? ' (Deload)' : ''} — ${formatDate(targetMonday)} till ${formatDate(targetSunday)}`;

  const workouts = await fetchWorkouts(profile?.id, isoDate(targetMonday), isoDate(targetSunday));

  // Fetch plans
  const periods = await fetchPeriods();
  const mondayStr = isoDate(targetMonday);
  const period = periods.find(p => mondayStr >= p.start_date && mondayStr <= p.end_date);
  let plans = [];
  if (period) plans = await fetchPlans(period.id);

  // Previous week for delta
  const prevMonday = addDays(targetMonday, -7);
  const prevSunday = addDays(prevMonday, 6);
  const prevWorkouts = await fetchWorkouts(profile?.id, isoDate(prevMonday), isoDate(prevSunday));

  renderSchema(workouts, plans, prevWorkouts, targetMonday, deload);
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

function renderSchema(workouts, plans, prevWorkouts, monday, isDeload) {
  const container = document.getElementById('schema-content');
  const todayStr = isoDate(new Date());

  let html = '<div class="schema-table">';
  html += `<div class="schema-row header">
    <div class="schema-cell day">Dag</div>
    <div class="schema-cell plan">Planerat</div>
    <div class="schema-cell actual">Faktiskt</div>
    <div class="schema-cell mins">Min</div>
  </div>`;

  for (let i = 0; i < 7; i++) {
    const dayDate = addDays(monday, i);
    const dayStr = isoDate(dayDate);
    const plan = plans.find(p => p.day_of_week === i);
    const dayWorkouts = workouts.filter(w => w.workout_date === dayStr);
    const isToday = dayStr === todayStr;
    const isFuture = dayDate > new Date();
    const totalMins = dayWorkouts.reduce((s, w) => s + w.duration_minutes, 0);

    let statusClass = 'future';
    if (dayWorkouts.length > 0) statusClass = 'done';
    else if (plan?.is_rest) statusClass = 'rest';
    else if (!isFuture) statusClass = 'missed';

    const actualText = dayWorkouts.length > 0
      ? dayWorkouts.map(w => w.activity_type + (w.intensity ? ` <span class="intensity-badge">${w.intensity}</span>` : '')).join(', ')
      : (plan?.is_rest ? '<span class="vila">Vila</span>' : (isFuture ? '—' : '<span style="color:var(--red);">Missat</span>'));

    html += `<div class="schema-row" style="${isToday ? 'background:rgba(46,134,193,0.06);' : ''}">
      <div class="schema-cell day">${DAY_NAMES[i]}</div>
      <div class="schema-cell plan">${plan ? (plan.is_rest ? 'Vila' : plan.label) : '—'}</div>
      <div class="schema-cell actual"><span class="status-dot ${statusClass}"></span>${actualText}</div>
      <div class="schema-cell mins">${totalMins > 0 ? totalMins : ''}</div>
    </div>`;
  }
  html += '</div>';

  // Summaries
  const sumByType = {};
  workouts.forEach(w => { sumByType[w.activity_type] = (sumByType[w.activity_type] || 0) + w.duration_minutes; });
  const prevSumByType = {};
  prevWorkouts.forEach(w => { prevSumByType[w.activity_type] = (prevSumByType[w.activity_type] || 0) + w.duration_minutes; });

  const totalCardio = workouts.filter(w => CARDIO_TYPES.includes(w.activity_type)).reduce((s, w) => s + w.duration_minutes, 0);
  const prevCardio = prevWorkouts.filter(w => CARDIO_TYPES.includes(w.activity_type)).reduce((s, w) => s + w.duration_minutes, 0);
  const totalAll = workouts.reduce((s, w) => s + w.duration_minutes, 0);
  const prevAll = prevWorkouts.reduce((s, w) => s + w.duration_minutes, 0);

  html += '<div class="schema-summary">';
  const types = [...new Set([...Object.keys(sumByType), ...Object.keys(prevSumByType)])].sort();
  types.forEach(t => {
    const val = sumByType[t] || 0;
    const prev = prevSumByType[t] || 0;
    html += summaryRowHTML(t, val, prev, isDeload);
  });
  html += summaryRowHTML('Cardio totalt', totalCardio, prevCardio, isDeload, true);
  html += summaryRowHTML('Totalt', totalAll, prevAll, isDeload, true);
  html += '</div>';

  container.innerHTML = html;
}

function summaryRowHTML(label, value, prev, isDeload, isTotal) {
  const delta = prev > 0 ? (value - prev) / prev : 0;
  const deltaStr = prev > 0 ? ((delta >= 0 ? '+' : '') + Math.round(delta * 100) + '%') : '';
  let deltaClass = '';
  if (prev > 0 && deltaStr) {
    if (isDeload) {
      deltaClass = delta <= -0.2 ? 'delta-good' : 'delta-warn';
    } else {
      if (delta > 0.1) deltaClass = 'delta-warn';
      else if (delta > 0) deltaClass = 'delta-up';
      else deltaClass = 'delta-down';
    }
  }
  return `<div class="summary-row${isTotal ? ' total' : ''}">
    <span class="label">${label}</span>
    <span class="value">${value > 0 ? value + ' min' : '—'} <span class="delta ${deltaClass}">${deltaStr}</span></span>
  </div>`;
}

// ═══════════════════════
//  TRENDS
// ═══════════════════════
function setTrendMode(mode) {
  trendMode = mode;
  document.getElementById('toggle-cardio').classList.toggle('active', mode === 'cardio');
  document.getElementById('toggle-total').classList.toggle('active', mode === 'total');
  loadTrends();
}

async function loadTrends() {
  const allWorkouts = await fetchAllWorkouts();
  if (allWorkouts.length === 0) {
    document.querySelector('#view-trends .page-header p').textContent = 'Inga pass loggade ännu';
    return;
  }

  const niklasProfile = getProfileByName('Niklas');
  const loveProfile = getProfileByName('Love');

  // Group by week
  const weekData = {};
  allWorkouts.forEach(w => {
    const d = new Date(w.workout_date);
    const mon = mondayOfWeek(d);
    const key = isoDate(mon);
    if (!weekData[key]) weekData[key] = { niklas: {}, love: {} };
    const who = w.profile_id === niklasProfile?.id ? 'niklas' : 'love';
    weekData[key][who][w.activity_type] = (weekData[key][who][w.activity_type] || 0) + w.duration_minutes;
  });

  const weeks = Object.keys(weekData).sort();
  const labels = weeks.map(w => { const d = new Date(w); return `V${weekNumber(d)}`; });

  const niklasData = weeks.map(w => {
    const d = weekData[w].niklas;
    const types = trendMode === 'cardio' ? CARDIO_TYPES : [...CARDIO_TYPES, 'Gym'];
    return types.reduce((s, t) => s + (d[t] || 0), 0) / 60;
  });
  const loveData = weeks.map(w => {
    const d = weekData[w].love;
    const types = trendMode === 'cardio' ? CARDIO_TYPES : [...CARDIO_TYPES, 'Gym'];
    return types.reduce((s, t) => s + (d[t] || 0), 0) / 60;
  });

  // Deload markers
  const deloadWeeks = weeks.map(w => isDeloadWeek(new Date(w)));

  // Weekly line chart
  if (chartWeekly) chartWeekly.destroy();
  const ctx = document.getElementById('chart-weekly').getContext('2d');
  chartWeekly = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Niklas', data: niklasData, borderColor: PERSON_COLORS.Niklas, backgroundColor: PERSON_COLORS.Niklas + '22', tension: 0.3, fill: true, pointRadius: 4, pointHoverRadius: 6 },
        { label: 'Love', data: loveData, borderColor: PERSON_COLORS.Love, backgroundColor: PERSON_COLORS.Love + '22', tension: 0.3, fill: true, pointRadius: 4, pointHoverRadius: 6 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { color: '#aaa', usePointStyle: true } },
        tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)} h` } }
      },
      scales: {
        y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#888', callback: v => v.toFixed(1) + 'h' } },
        x: { grid: { display: false }, ticks: { color: '#888' } }
      }
    }
  });

  // Mix charts
  renderMixChart('chart-mix-niklas', weeks, weekData, 'niklas', PERSON_COLORS.Niklas, 'chartMixNiklas');
  renderMixChart('chart-mix-love', weeks, weekData, 'love', PERSON_COLORS.Love, 'chartMixLove');
}

function renderMixChart(canvasId, weeks, weekData, person, color, storeKey) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  if (window[storeKey]) window[storeKey].destroy();

  const labels = weeks.map(w => `V${weekNumber(new Date(w))}`);
  const types = ['Löpning', 'Cykel', 'Gym', 'Annat', 'Hyrox', 'Stakmaskin', 'Längdskidor'];
  const datasets = types.filter(t => {
    return weeks.some(w => (weekData[w][person][t] || 0) > 0);
  }).map(t => ({
    label: t,
    data: weeks.map(w => (weekData[w][person][t] || 0) / 60),
    backgroundColor: ACTIVITY_COLORS[t] || '#555',
    borderRadius: 4
  }));

  window[storeKey] = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { color: '#aaa', usePointStyle: true, boxWidth: 12 } },
        tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)} h` } }
      },
      scales: {
        y: { stacked: true, beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#888', callback: v => v.toFixed(1) + 'h' } },
        x: { stacked: true, grid: { display: false }, ticks: { color: '#888' } }
      }
    }
  });
}

// ═══════════════════════
//  COMPARE
// ═══════════════════════
async function loadCompare() {
  const niklasProfile = getProfileByName('Niklas');
  const loveProfile = getProfileByName('Love');
  const now = new Date();
  const monday = mondayOfWeek(now);
  const sunday = addDays(monday, 6);

  const niklasWeek = niklasProfile ? await fetchWorkouts(niklasProfile.id, isoDate(monday), isoDate(sunday)) : [];
  const loveWeek = loveProfile ? await fetchWorkouts(loveProfile.id, isoDate(monday), isoDate(sunday)) : [];

  const nMins = niklasWeek.reduce((s, w) => s + w.duration_minutes, 0);
  const lMins = loveWeek.reduce((s, w) => s + w.duration_minutes, 0);

  document.getElementById('cmp-niklas-hours').textContent = (nMins / 60).toFixed(1);
  document.getElementById('cmp-love-hours').textContent = (lMins / 60).toFixed(1);

  // Season totals
  const allWorkouts = await fetchAllWorkouts();
  const nTotal = allWorkouts.filter(w => w.profile_id === niklasProfile?.id).reduce((s, w) => s + w.duration_minutes, 0) / 60;
  const lTotal = allWorkouts.filter(w => w.profile_id === loveProfile?.id).reduce((s, w) => s + w.duration_minutes, 0) / 60;
  const maxTotal = Math.max(nTotal, lTotal, 1);

  const barsEl = document.getElementById('compare-bars');
  barsEl.innerHTML = `
    <div class="compare-bar-row">
      <div class="compare-bar-label">Niklas</div>
      <div class="compare-bar-track"><div class="compare-bar-fill" style="width:${(nTotal/maxTotal)*100}%;background:${PERSON_COLORS.Niklas};">${nTotal.toFixed(1)}h</div></div>
    </div>
    <div class="compare-bar-row">
      <div class="compare-bar-label">Love</div>
      <div class="compare-bar-track"><div class="compare-bar-fill" style="width:${(lTotal/maxTotal)*100}%;background:${PERSON_COLORS.Love};">${lTotal.toFixed(1)}h</div></div>
    </div>`;

  // Weekly mix comparison
  const mixEl = document.getElementById('compare-mix');
  const nMix = {};
  niklasWeek.forEach(w => { nMix[w.activity_type] = (nMix[w.activity_type] || 0) + w.duration_minutes; });
  const lMix = {};
  loveWeek.forEach(w => { lMix[w.activity_type] = (lMix[w.activity_type] || 0) + w.duration_minutes; });
  const allTypes = [...new Set([...Object.keys(nMix), ...Object.keys(lMix)])];
  const maxMix = Math.max(...allTypes.map(t => Math.max(nMix[t] || 0, lMix[t] || 0)), 1);

  if (allTypes.length === 0) {
    mixEl.innerHTML = '<div class="empty-state"><p>Inga pass denna vecka ännu</p></div>';
  } else {
    mixEl.innerHTML = allTypes.map(t => `
      <div class="compare-bar-row">
        <div class="compare-bar-label">${t}</div>
        <div class="compare-bar-track">
          <div class="compare-bar-fill" style="width:${((nMix[t]||0)/maxMix)*100}%;background:${PERSON_COLORS.Niklas};">${nMix[t]||0}</div>
          <div class="compare-bar-fill" style="width:${((lMix[t]||0)/maxMix)*100}%;background:${PERSON_COLORS.Love};">${lMix[t]||0}</div>
        </div>
      </div>`).join('');
  }

  // Streaks
  const streaksEl = document.getElementById('compare-streaks');
  const nStreak = calcStreak(allWorkouts, niklasProfile?.id);
  const lStreak = calcStreak(allWorkouts, loveProfile?.id);
  streaksEl.innerHTML = `
    <div class="flex-between mt-8">
      <div>
        <span style="color:${PERSON_COLORS.Niklas};font-weight:700;">Niklas</span>
        <span class="streak-badge ml-8">${nStreak} veckor</span>
      </div>
      <div>
        <span style="color:${PERSON_COLORS.Love};font-weight:700;">Love</span>
        <span class="streak-badge ml-8">${lStreak} veckor</span>
      </div>
    </div>`;

  // Weekly line chart
  renderCompareChart(allWorkouts, niklasProfile, loveProfile);
}

function setCmpChartMode(mode) {
  cmpChartMode = mode;
  document.getElementById('cmp-toggle-cardio').classList.toggle('active', mode === 'cardio');
  document.getElementById('cmp-toggle-total').classList.toggle('active', mode === 'total');
  loadCompare();
}

function renderCompareChart(allWorkouts, niklasProfile, loveProfile) {
  const weekData = {};
  allWorkouts.forEach(w => {
    const mon = mondayOfWeek(new Date(w.workout_date));
    const key = isoDate(mon);
    if (!weekData[key]) weekData[key] = { niklas: 0, love: 0 };
    const types = cmpChartMode === 'cardio' ? CARDIO_TYPES : [...CARDIO_TYPES, 'Gym'];
    if (!types.includes(w.activity_type)) return;
    if (w.profile_id === niklasProfile?.id) weekData[key].niklas += w.duration_minutes;
    else if (w.profile_id === loveProfile?.id) weekData[key].love += w.duration_minutes;
  });

  const weeks = Object.keys(weekData).sort();
  const labels = weeks.map(w => `V${weekNumber(new Date(w))}`);
  const nData = weeks.map(w => weekData[w].niklas / 60);
  const lData = weeks.map(w => weekData[w].love / 60);

  if (chartCompareWeekly) chartCompareWeekly.destroy();
  const canvas = document.getElementById('chart-compare-weekly');
  if (!canvas) return;

  chartCompareWeekly = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Niklas', data: nData,
          borderColor: PERSON_COLORS.Niklas, backgroundColor: PERSON_COLORS.Niklas + '18',
          tension: 0.35, fill: true, pointRadius: 5, pointHoverRadius: 7,
          borderWidth: 2.5
        },
        {
          label: 'Love', data: lData,
          borderColor: PERSON_COLORS.Love, backgroundColor: PERSON_COLORS.Love + '18',
          tension: 0.35, fill: true, pointRadius: 5, pointHoverRadius: 7,
          borderWidth: 2.5
        }
      ]
    },
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

function calcStreak(allWorkouts, profileId) {
  if (!profileId) return 0;
  const pw = allWorkouts.filter(w => w.profile_id === profileId);
  const now = new Date();
  let streak = 0;
  let checkMonday = mondayOfWeek(now);

  while (true) {
    const sun = addDays(checkMonday, 6);
    const weekW = pw.filter(w => w.workout_date >= isoDate(checkMonday) && w.workout_date <= isoDate(sun));
    const totalMins = weekW.reduce((s, w) => s + w.duration_minutes, 0);
    if (totalMins >= 60) {
      streak++;
      checkMonday = addDays(checkMonday, -7);
    } else {
      break;
    }
  }
  return streak;
}
