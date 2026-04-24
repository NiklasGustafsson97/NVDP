/**
 * Fill in your Supabase project URL and anon (public) key below.
 * Find them in Supabase Dashboard → Project Settings → API.
 */

const SUPABASE_URL = 'https://enqfhumeachdgupthnci.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_fohZwQUQNBkpMDk4B5QxCg_KyfQroRM';

const ACTIVITY_TYPES = [
  'Löpning',
  'Cykel',
  'Gym',
  'Annat',
  'Hyrox',
  'Stakmaskin',
  'Längdskidor',
  'Vila',
];

const ACTIVITY_COLORS = {
  Löpning: '#3498DB',
  Cykel: '#2ECC71',
  Gym: '#9B59B6',
  Annat: '#E67E22',
  Hyrox: '#E74C3C',
  Stakmaskin: '#1ABC9C',
  Längdskidor: '#F39C12',
  Vila: '#555555',
};

const PERSON_COLORS = {
  Niklas: '#2E86C1',
  Love: '#E74C3C',
};

// Original training-group profiles for whom the legacy `period_plans`
// weekly template is still shown as a default schedule. Everyone else
// gets an empty state + "Skapa ditt första schema" CTA instead.
const LEGACY_PLAN_USERS = ['Niklas', 'Love'];

const PRINCIPLES = [
  '80–90% lugnt (Z1–Z2), max 1 "riktigt hårt" pass/vecka tills Juni',
  '3 veckor upp + 1 vecka ner (deload): var 4:e vecka sänker vi konditionsvolymen 25–35%',
  'Öka bara EN variabel åt gången',
  'Ingen "gråzon": undvik Z3. Antingen lugnt eller tydligt kvalitet.',
  'Öka MAX 10% i tid per vecka',
  'Öka längden på långpasset med MAX 10% per vecka',
  'Panga 4 gympass per vecka – MAX 1 med ben',
];

const P1_START = '2026-03-02';
const P1_END = '2026-05-31';
const P2_START = '2026-06-02';
const P2_END = '2026-08-31';

const CARDIO_TYPES = [
  'Löpning',
  'Cykel',
  'Annat',
  'Hyrox',
  'Stakmaskin',
  'Längdskidor',
];

/**
 * Skalar rå effort (min × MET × höjd × intensitet) till visningsenheter ~samma storleksordning som timmar.
 * 600 ≈ 60 min × MET 10 som referens för en "typisk" träningstimme.
 */
const EFFORT_DISPLAY_DIVISOR = 600;

/** Vikt för "konditionstimmar" i absolut läge (≤1 → summa överstiger aldrig faktisk träningstid). */
const ACTIVITY_HOUR_WEIGHT = {
  Löpning: 1,
  Cykel: 0.55,
  Annat: 1,
  Hyrox: 1,
  Stakmaskin: 1,
  'Längdskidor': 1,
  Gym: 1,
};

// ── Plan Generation ──
const PLAN_GENERATION_ENABLED = true;

const GOAL_TYPES = [
  { id: 'race', label: 'Lopp / Tävling', icon: '🏁' },
  { id: 'fitness', label: 'Allmän fitness', icon: '💪' },
  { id: 'weight_loss', label: 'Gå ner i vikt', icon: '⚖️' },
  { id: 'sport_specific', label: 'Sportspecifikt', icon: '🎯' },
  { id: 'custom', label: 'Eget mål', icon: '✏️' },
];

const FITNESS_LEVELS = [
  { id: 'beginner', label: 'Nybörjare' },
  { id: 'intermediate', label: 'Medel' },
  { id: 'advanced', label: 'Erfaren' },
];

const INTENSITY_ZONE_COLORS = {
  Z1: '#3498DB',
  Z2: '#2ECC71',
  Z3: '#F39C12',
  Z4: '#E67E22',
  Z5: '#E74C3C',
  mixed: '#9B59B6',
};

const PHASE_LABELS = {
  base: 'Bas',
  build: 'Bygg',
  peak: 'Topp',
  taper: 'Nedtrappning',
  deload: 'Deload',
  recovery: 'Återhämtning',
  assessment: 'Bedömning',
};

// ── Strava Integration ──
const STRAVA_CLIENT_ID = '217664';
const SUPABASE_FUNCTIONS_URL = SUPABASE_URL + '/functions/v1';
const STRAVA_REDIRECT_URI = SUPABASE_FUNCTIONS_URL + '/strava-auth';

// ── Garmin Integration ──
const GARMIN_CLIENT_ID = ''; // Set after Garmin Developer Program approval
const GARMIN_REDIRECT_URI = SUPABASE_FUNCTIONS_URL + '/garmin-auth';
const GARMIN_AUTH_URL = 'https://connect.garmin.com/oauthConfirm';
