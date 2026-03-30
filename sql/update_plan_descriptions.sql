-- =============================================================================
-- Update period plan descriptions to van der Poel-inspired specificity
-- Replaces vague "inkl intervaller" with structured, actionable workouts
-- Safe to re-run: idempotent UPDATEs keyed on period name + day_of_week
-- =============================================================================

-- ═══════════════════════════════════════════════════════════════════════════
-- PERIOD 1 — Bygga bas och uthållighet (mars–maj)
--
-- Philosophy (van der Poel / polarized):
--   80-90% Z1-Z2 volume. ONE quality session/week. Volume > intensity.
--   Long session builds 1 km/week. Strides on easy day for neuromuscular.
--   Cross-training (cykel) counts as aerobic volume.
--   Base durations here are scaled by app.js projectPlan() (+8%/build week).
-- ═══════════════════════════════════════════════════════════════════════════

-- Tuesday: Distansträning Z2
UPDATE public.period_plans
SET label = 'Distans Z2',
    description = '7–8 km lugn löpning Z2 (5:45–6:15/km). Ska kännas enkelt hela vägen — du ska kunna prata obehindrat. Puls under 150.'
WHERE period_id = (SELECT id FROM public.periods WHERE name = 'Period 1 — Bygga bas och uthållighet')
  AND day_of_week = 1;

-- Wednesday: Cykel Z2 (cross-training)
UPDATE public.period_plans
SET label = 'Cykel Z2',
    description = '45–60 min cykel Z2, jämn watt, puls under 145. Alternativ: stakmaskin eller längdskidor. Fokus: aerob volym utan belastning på ben.'
WHERE period_id = (SELECT id FROM public.periods WHERE name = 'Period 1 — Bygga bas och uthållighet')
  AND day_of_week = 2;

-- Thursday: Tröskelpass (the ONE quality session per week)
UPDATE public.period_plans
SET label = 'Tröskelpass',
    description = '15 min uppvärm Z2 → 4×5 min i Z4 (puls 170–178, ~4:40–5:00/km), 3 min lugn jogg mellan → 10 min nedvarvning. Kontrollerad ansträngning — inte maxat.'
WHERE period_id = (SELECT id FROM public.periods WHERE name = 'Period 1 — Bygga bas och uthållighet')
  AND day_of_week = 3;

-- Friday: Lätt löpning + strides
UPDATE public.period_plans
SET label = 'Lätt + strides',
    description = '5–6 km mycket lugn Z1 (6:00–6:30/km) + 6×20 sek strides (snabbt men avslappnat, full vila mellan). Strides aktiverar snabbfibrerna utan att trötta.'
WHERE period_id = (SELECT id FROM public.periods WHERE name = 'Period 1 — Bygga bas och uthållighet')
  AND day_of_week = 4;

-- Saturday: Långpass Z2
UPDATE public.period_plans
SET label = 'Långpass Z2',
    description = '12–14 km lugn Z2 (5:45–6:15/km). Öka med ~1 km/vecka. Sista 2 km får ligga i övre Z2. Veckans viktigaste pass — bygg uthålligheten.'
WHERE period_id = (SELECT id FROM public.periods WHERE name = 'Period 1 — Bygga bas och uthållighet')
  AND day_of_week = 5;

-- ═══════════════════════════════════════════════════════════════════════════
-- PERIOD 2 — Bygga bas och intensitet (juni–aug)
--
-- Philosophy:
--   TWO quality sessions/week (VO2max + tempo). Maintain Z2 volume.
--   Long run gets progressive finish (Z3→Z4 sista km).
--   Cycling volume increases. Strides remain on easy day.
--   Never two hard days in rad. Pattern: Hard-Easy-Hard-Easy-Long-Rest-Rest.
-- ═══════════════════════════════════════════════════════════════════════════

-- Tuesday: VO2max-intervaller
UPDATE public.period_plans
SET label = 'VO2max-intervaller',
    description = '15 min uppvärm Z2 → 5×3 min i Z5 (puls 180+, ~3:50–4:15/km), 3 min lugn jogg mellan → 10 min nedvarvning. Ska kännas tungt rep 3–5.'
WHERE period_id = (SELECT id FROM public.periods WHERE name = 'Period 2 — Bygga bas och intensitet')
  AND day_of_week = 1;

-- Wednesday: Lång cykel Z2
UPDATE public.period_plans
SET label = 'Lång cykel Z2',
    description = '90–120 min cykel Z2, jämnt tempo, puls under 145. Bygg aerob kapacitet utan löpbelastning. Ta med vätska.'
WHERE period_id = (SELECT id FROM public.periods WHERE name = 'Period 2 — Bygga bas och intensitet')
  AND day_of_week = 2;

-- Thursday: Tempopass
UPDATE public.period_plans
SET label = 'Tempopass',
    description = '15 min uppvärm Z2 → 20–25 min sammanhängande tempo i Z4 (4:30–4:50/km, puls 170–178) → 10 min nedvarvning. Jämnt och kontrollerat — inte tävling.'
WHERE period_id = (SELECT id FROM public.periods WHERE name = 'Period 2 — Bygga bas och intensitet')
  AND day_of_week = 3;

-- Friday: Lätt löpning + strides
UPDATE public.period_plans
SET label = 'Lätt + strides',
    description = '6–7 km lugn Z1-Z2 (6:00–6:30/km) + 8×20 sek strides (snabbt, avslappnat, full vila). Återhämtning efter gårdagens tempo.'
WHERE period_id = (SELECT id FROM public.periods WHERE name = 'Period 2 — Bygga bas och intensitet')
  AND day_of_week = 4;

-- Saturday: Långpass med progressiv avslutning
UPDATE public.period_plans
SET label = 'Långpass progressivt',
    description = '16–18 km: första 13 km i Z2 (5:30–6:00/km), sista 3–5 km progressivt ner mot Z4 (4:50→4:30/km). Tränar att springa snabbt på trötta ben.'
WHERE period_id = (SELECT id FROM public.periods WHERE name = 'Period 2 — Bygga bas och intensitet')
  AND day_of_week = 5;
