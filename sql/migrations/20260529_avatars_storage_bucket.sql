-- ============================================================================
-- Migration: avatars storage bucket + policies
--
-- Why: users can upload their own profile photo. Photos live in a public
--   bucket 'avatars' under a per-user folder: avatars/{auth.uid()}/<file>.
--   Public read (avatars are not sensitive); writes confined to the user's
--   own folder via storage.objects RLS.
--
-- Idempotent: bucket insert is on-conflict no-op; policies are dropped then
--   recreated so re-runs are safe.
-- ============================================================================

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do update set public = true;

-- Public read for any object in the avatars bucket.
drop policy if exists "avatars_public_read" on storage.objects;
create policy "avatars_public_read"
  on storage.objects for select
  using (bucket_id = 'avatars');

-- Authenticated users may write only inside their own user-id folder.
drop policy if exists "avatars_own_insert" on storage.objects;
create policy "avatars_own_insert"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "avatars_own_update" on storage.objects;
create policy "avatars_own_update"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "avatars_own_delete" on storage.objects;
create policy "avatars_own_delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

select 'avatars storage bucket + policies installed' as status;
