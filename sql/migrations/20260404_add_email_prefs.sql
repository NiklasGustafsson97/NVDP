-- Add email notification preference to profiles
alter table public.profiles add column if not exists email_notifications boolean not null default true;

select 'email_notifications column added to profiles' as status;
