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
          <div class="name">${w.activity_type}${intBadge}</div>
          <div class="meta">${formatDate(w.workout_date)}${w.notes && w.notes !== 'Importerad' ? ' — ' + w.notes : ''}</div>
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

function activityEmoji(type) {
  const map = { 'Löpning': '&#127939;', 'Cykel': '&#128690;', 'Gym': '&#127947;', 'Annat': '&#9889;', 'Hyrox': '&#128293;', 'Stakmaskin': '&#129494;', 'Längdskidor': '&#9924;', 'Vila': '&#128164;' };
  return map[type] || '&#9889;';
}

// ═══════════════════════
//  WORKOUT MODAL (Edit / Delete)
// ═══════════════════════
function openWorkoutModal(w) {
  selectedWorkout = w;
  document.getElementById('wm-title').textContent = w.activity_type + ' — ' + formatDate(w.workout_date);
  const intBadge = w.intensity ? `<span class="intensity-badge">${w.intensity}</span>` : '';
  let body = '';
  body += `<div class="modal-detail-row"><span class="mdr-label">Aktivitet</span><span class="mdr-value">${w.activity_type} ${intBadge}</span></div>`;
  body += `<div class="modal-detail-row"><span class="mdr-label">Datum</span><span class="mdr-value">${w.workout_date}</span></div>`;
  body += `<div class="modal-detail-row"><span class="mdr-label">Tid</span><span class="mdr-value">${w.duration_minutes} min</span></div>`;
  if (w.distance_km) body += `<div class="modal-detail-row"><span class="mdr-label">Distans</span><span class="mdr-value">${w.distance_km} km</span></div>`;
  if (w.workout_time) body += `<div class="modal-detail-row"><span class="mdr-label">Klockslag</span><span class="mdr-value">${w.workout_time}</span></div>`;
  if (w.notes && w.notes !== 'Importerad') body += `<div class="modal-detail-row"><span class="mdr-label">Anteckning</span><span class="mdr-value">${w.notes}</span></div>`;
  document.getElementById('wm-body').innerHTML = body;
  document.getElementById('workout-modal').classList.remove('hidden');
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
  if (!confirm('Ta bort detta pass?')) return;
  const { error } = await sb.from('workouts').delete().eq('id', selectedWorkout.id);
  if (error) { alert('Kunde inte ta bort: ' + error.message); return; }
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
    alert('Kunde inte spara: ' + error.message);
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
        return `<span class="clickable-workout" onclick='openWorkoutModal(${JSON.stringify(w).replace(/'/g, "&#39;")})'>${w.duration_minutes}'${intB}</span>`;
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
  const labels = weeks.map(w => `V${weekNumber(new Date(w))}`);
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
    streakEl.innerHTML = `<div class="text-center mt-8"><span class="streak-badge">${streak} veckor i rad</span></div>`;
  }

  // Season totals
  const totalsEl = document.getElementById('personal-totals');
  if (totalsEl) {
    const byType = {};
    myWorkouts.forEach(w => { byType[w.activity_type] = (byType[w.activity_type] || 0) + w.duration_minutes; });
    const totalAll = myWorkouts.reduce((s, w) => s + w.duration_minutes, 0);
    let html = '';
    Object.keys(byType).sort().forEach(t => {
      const pct = Math.round((byType[t] / totalAll) * 100);
      html += `<div class="summary-row"><span class="label">${t}</span><span class="value">${(byType[t]/60).toFixed(1)}h (${pct}%)</span></div>`;
    });
    html += `<div class="summary-row total"><span class="label">Totalt</span><span class="value">${(totalAll/60).toFixed(1)}h</span></div>`;
    totalsEl.innerHTML = html;
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

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

async function loadGroup() {
  if (!currentProfile) return;

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
    document.getElementById('group-code-value').textContent = group.code;
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

  // Render members
  const membersEl = document.getElementById('group-members');
  const colors = ['#2E86C1', '#E74C3C', '#2ECC71', '#9B59B6', '#F39C12', '#1ABC9C'];
  membersEl.innerHTML = members.map((m, i) => {
    const isMe = m.id === currentProfile.id;
    return `<div class="group-member">
      <div class="member-avatar" style="background:${colors[i % colors.length]};">${m.name[0].toUpperCase()}</div>
      <div class="member-info">
        <div class="member-name">${m.name}${isMe ? ' (du)' : ''}</div>
      </div>
    </div>`;
  }).join('');

  // Leaderboard: hours this week
  const now = new Date();
  const monday = mondayOfWeek(now);
  const sunday = addDays(monday, 6);
  const allWorkouts = await fetchAllWorkouts();

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
  loadGroup();
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
  const code = document.getElementById('group-code-value').textContent;
  navigator.clipboard.writeText(code).then(() => {
    const btn = document.querySelector('.group-code-actions .btn');
    const orig = btn.textContent;
    btn.textContent = 'Kopierad!';
    setTimeout(() => btn.textContent = orig, 1500);
  });
}
