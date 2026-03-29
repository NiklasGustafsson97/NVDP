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

const PRINCIPLES = [
  '80–90% lugnt (Z1–Z2), max 1 "riktigt hårt" pass/vecka tills Juni',
  '3 veckor upp + 1 vecka ner (deload): var 4:e vecka sänker vi konditionsvolymen 25–35%',
  'Öka bara EN variabel åt gången',
  'Ingen "gråzon": undvik Z3. Antingen lugnt eller tydligt kvalitet.',
  'Öka MAX 10% i tid per vecka',
  'Öka längden på långpasset med MAX 10% per vecka',
  'Panga 4 gympass per vecka – MAX 1 med ben',
];

const P1_START = '2026-03-03';
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

// ── Strava Integration ──
const STRAVA_CLIENT_ID = '217664';
const SUPABASE_FUNCTIONS_URL = SUPABASE_URL + '/functions/v1';
const STRAVA_REDIRECT_URI = SUPABASE_FUNCTIONS_URL + '/strava-auth';
