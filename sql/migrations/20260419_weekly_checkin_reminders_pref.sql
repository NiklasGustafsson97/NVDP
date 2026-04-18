-- Add opt-out preference for Sunday weekly-checkin reminder emails.
-- Default ON for existing users (they can opt out in Inställningar).

alter table public.profiles
  add column if not exists weekly_checkin_reminders boolean not null default true;

comment on column public.profiles.weekly_checkin_reminders is
  'Whether this user receives the Sunday weekly coach check-in reminder email.';
