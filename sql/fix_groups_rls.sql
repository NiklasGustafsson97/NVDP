-- ============================================================================
-- Migration: Enable RLS on groups table
-- Run this ONCE in Supabase SQL Editor
-- ============================================================================

-- Enable RLS
alter table public.groups enable row level security;

-- All authenticated users can read groups (needed for join-by-code)
create policy "groups_select_authenticated"
  on public.groups
  for select
  to authenticated
  using (true);

-- Any authenticated user can create a group
create policy "groups_insert_authenticated"
  on public.groups
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.profiles p
      where p.id = created_by
        and p.user_id = auth.uid()
    )
  );

-- Only the creator can update a group
create policy "groups_update_creator"
  on public.groups
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.profiles p
      where p.id = created_by
        and p.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
      from public.profiles p
      where p.id = created_by
        and p.user_id = auth.uid()
    )
  );

-- Only the creator can delete a group
create policy "groups_delete_creator"
  on public.groups
  for delete
  to authenticated
  using (
    exists (
      select 1
      from public.profiles p
      where p.id = created_by
        and p.user_id = auth.uid()
    )
  );

select 'Groups RLS enabled with policies' as status;
