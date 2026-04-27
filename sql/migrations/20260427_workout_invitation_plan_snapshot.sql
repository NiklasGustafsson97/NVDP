-- Make workout invitations point to a specific planned workout snapshot.
--
-- Older invitations only knew sender/receiver/date, which breaks down when a
-- day has multiple planned sessions. The snapshot columns keep the invite
-- stable even if the sender later edits the plan.

alter table public.workout_invitations
  add column if not exists sender_plan_workout_id uuid,
  add column if not exists label text,
  add column if not exists target_duration_minutes int,
  add column if not exists target_distance_km numeric,
  add column if not exists intensity_zone text;

update public.workout_invitations
set
  label = coalesce(label, activity_type),
  target_duration_minutes = coalesce(target_duration_minutes, duration_minutes),
  intensity_zone = coalesce(intensity_zone, intensity)
where label is null
  or target_duration_minutes is null
  or intensity_zone is null;

-- The original unique constraint prevented inviting the same person to two
-- different planned sessions on the same date. Replace it with pending-only
-- uniqueness that uses the plan workout id when present, and keeps legacy
-- date-level behavior for old/null rows.
alter table public.workout_invitations
  drop constraint if exists wi_unique_per_day;

drop index if exists public.wi_unique_per_day;

create unique index if not exists wi_unique_pending_plan_workout
  on public.workout_invitations (sender_id, receiver_id, sender_plan_workout_id)
  where sender_plan_workout_id is not null and status = 'pending';

create unique index if not exists wi_unique_pending_legacy_day
  on public.workout_invitations (sender_id, receiver_id, workout_date)
  where sender_plan_workout_id is null and status = 'pending';

create index if not exists wi_sender_plan_workout_idx
  on public.workout_invitations (sender_plan_workout_id)
  where sender_plan_workout_id is not null;

notify pgrst, 'reload schema';
