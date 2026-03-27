/**
 * One-time seed script: migrates existing Excel data into Supabase.
 * Run from the browser console while logged in, OR add a button.
 *
 * To use: open the app in your browser, open DevTools console, paste this
 * entire file, then call seedAll().  Both users must exist first (sign up).
 */

/* eslint-disable no-unused-vars */

const SEED_DATA = {
  'Niklas': [
    // Week 1: 2026-03-03
    { date: '2026-03-03', type: 'Vila', mins: 0 },
    { date: '2026-03-04', type: 'Cykel', mins: 105 },
    { date: '2026-03-05', type: 'Cykel', mins: 50 },
    { date: '2026-03-06', type: 'Vila', mins: 0 },
    { date: '2026-03-07', type: 'Löpning', mins: 26 },
    { date: '2026-03-08', type: 'Cykel', mins: 90 },
    { date: '2026-03-09', type: 'Löpning', mins: 15 },
    { date: '2026-03-08', type: 'Gym', mins: 90 },
    // Week 2: 2026-03-10
    { date: '2026-03-10', type: 'Vila', mins: 0 },
    { date: '2026-03-11', type: 'Löpning', mins: 57 },
    { date: '2026-03-12', type: 'Löpning', mins: 54 },
    { date: '2026-03-13', type: 'Längdskidor', mins: 48 },
    { date: '2026-03-14', type: 'Hyrox', mins: 50 },
    { date: '2026-03-15', type: 'Vila', mins: 0 },
    { date: '2026-03-16', type: 'Stakmaskin', mins: 83 },
    { date: '2026-03-14', type: 'Gym', mins: 105 },
    // Week 3: 2026-03-17
    { date: '2026-03-17', type: 'Vila', mins: 0 },
    { date: '2026-03-18', type: 'Cykel', mins: 88 },
    { date: '2026-03-19', type: 'Cykel', mins: 20 },
    { date: '2026-03-20', type: 'Cykel', mins: 120 },
    { date: '2026-03-21', type: 'Längdskidor', mins: 60 },
    { date: '2026-03-22', type: 'Vila', mins: 0 },
    { date: '2026-03-23', type: 'Cykel', mins: 60 },
    { date: '2026-03-20', type: 'Gym', mins: 78 },
    // Week 4 (deload): 2026-03-24
    { date: '2026-03-24', type: 'Vila', mins: 0 },
    { date: '2026-03-25', type: 'Vila', mins: 0 },
    { date: '2026-03-26', type: 'Cykel', mins: 50 },
    { date: '2026-03-27', type: 'Cykel', mins: 25 },
    { date: '2026-03-28', type: 'Löpning', mins: 30 },
    { date: '2026-03-28', type: 'Löpning', mins: 10 },
  ],
  'Love': [
    // Week 1: 2026-03-03
    { date: '2026-03-03', type: 'Vila', mins: 0 },
    { date: '2026-03-04', type: 'Vila', mins: 0 },
    { date: '2026-03-05', type: 'Löpning', mins: 42 },
    { date: '2026-03-06', type: 'Vila', mins: 0 },
    { date: '2026-03-07', type: 'Löpning', mins: 35 },
    { date: '2026-03-08', type: 'Vila', mins: 0 },
    { date: '2026-03-09', type: 'Löpning', mins: 50 },
    // Week 2: 2026-03-10
    { date: '2026-03-10', type: 'Löpning', mins: 38 },
    { date: '2026-03-11', type: 'Cykel', mins: 35 },
    { date: '2026-03-12', type: 'Vila', mins: 0 },
    { date: '2026-03-13', type: 'Löpning', mins: 25 },
    { date: '2026-03-14', type: 'Löpning', mins: 20 },
    { date: '2026-03-15', type: 'Löpning', mins: 60 },
    { date: '2026-03-16', type: 'Annat', mins: 60 },
    // Week 3: 2026-03-17
    { date: '2026-03-17', type: 'Vila', mins: 0 },
    { date: '2026-03-18', type: 'Löpning', mins: 33 },
    { date: '2026-03-19', type: 'Vila', mins: 0 },
    { date: '2026-03-20', type: 'Löpning', mins: 45 },
    { date: '2026-03-21', type: 'Vila', mins: 0 },
    { date: '2026-03-22', type: 'Annat', mins: 60 },
    { date: '2026-03-23', type: 'Löpning', mins: 73 },
    // Week 4 (deload): 2026-03-24
    { date: '2026-03-24', type: 'Löpning', mins: 28 },
    { date: '2026-03-25', type: 'Cykel', mins: 120 },
    { date: '2026-03-26', type: 'Annat', mins: 90 },
  ]
};

async function seedAll() {
  const { data: profiles } = await sb.from('profiles').select('*');

  for (const [personName, entries] of Object.entries(SEED_DATA)) {
    const profile = profiles.find(p => p.name.toLowerCase().includes(personName.toLowerCase()));
    if (!profile) {
      console.warn(`Profile not found for ${personName}. Make sure they have registered.`);
      continue;
    }

    const inserts = entries
      .filter(e => e.type !== 'Vila' && e.mins > 0)
      .map(e => ({
        profile_id: profile.id,
        workout_date: e.date,
        activity_type: e.type,
        duration_minutes: e.mins,
        notes: 'Migrerad från Excel'
      }));

    if (inserts.length === 0) continue;

    const { error } = await sb.from('workouts').insert(inserts);
    if (error) {
      console.error(`Seed error for ${personName}:`, error);
    } else {
      console.log(`Seeded ${inserts.length} workouts for ${personName}`);
    }
  }
  console.log('Seed complete.');
}
