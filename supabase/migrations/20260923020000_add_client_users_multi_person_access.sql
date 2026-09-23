-- Multi-person client access: today portal_clients.id IS the one auth user
-- allowed to log in for that company (structurally, not just by
-- convention). This adds a client_users membership table so more than one
-- person can log in per company, and rewrites the three RLS policies that
-- assumed the old 1:1 equality (auth.uid() = id / auth.uid() = client_id)
-- to instead check membership in client_users.
--
-- Everything below is one migration file on purpose -- DDL is transactional,
-- and splitting "create client_users + backfill" from "rewrite policies"
-- into separate files risks a partial-apply state (new tables but old
-- policies, or vice versa) that could lock every existing client out of
-- their own documents until the next file lands.

create table public.client_users (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.portal_clients(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text,
  role text,
  created_at timestamptz not null default now(),
  -- Each login belongs to exactly one client company -- load-bearing, not
  -- just a nice-to-have: Documents.tsx's `.select('company_name').single()`
  -- call on portal_clients has no .eq() filter at all and relies entirely
  -- on RLS narrowing to exactly one row per authenticated user.
  unique (user_id)
);

-- Postgres doesn't auto-index a foreign key's referencing column, and every
-- portal_documents/storage read below now does an EXISTS lookup against
-- this column.
create index client_users_client_id_idx on public.client_users (client_id);

alter table public.client_users enable row level security;

-- Not deny-all, despite nothing needing to read this table directly from
-- the browser (all contact management goes through admin.ts's service-role
-- actions). RLS is enforced inside subqueries too, not just direct
-- queries -- the EXISTS checks in portal_clients_select_own,
-- documents_select_own, and portal_storage_select_own_folder below all
-- query this table, and run under the requesting session's own RLS
-- context. A deny-all policy set here (verified live, via a transaction
-- rolled back against production) makes every one of those EXISTS checks
-- evaluate false unconditionally, which locks every client out of their
-- own company row and documents the instant this migration lands. This
-- self-select policy is the minimum that unblocks them: a user can see
-- only their own membership row(s), never another contact's.
create policy "client_users_select_own"
  on public.client_users for select
  using (user_id = auth.uid());

-- Backfill: today portal_clients.id IS the primary contact's auth id, so
-- this maps every existing client 1:1 with zero data loss.
insert into public.client_users (client_id, user_id, role)
select id, id, 'Primary Contact' from public.portal_clients
on conflict (user_id) do nothing;

drop policy "portal_clients_select_own" on public.portal_clients;
create policy "portal_clients_select_own"
  on public.portal_clients for select
  using (
    exists (
      select 1 from public.client_users cu
      where cu.client_id = portal_clients.id and cu.user_id = auth.uid()
    )
  );

-- The LIVE policy here is documents_select_own, not
-- portal_documents_select_own -- that one was already dropped in
-- 20260902001626_fix_portal_documents_admin_only_rls_gap.sql. Its
-- `admin_only = false` condition MUST be preserved, or every admin-only
-- document (internal working files, failed-audit error markers) becomes
-- visible to clients the moment this migration lands.
drop policy "documents_select_own" on public.portal_documents;
create policy "documents_select_own"
  on public.portal_documents for select
  using (
    admin_only = false
    and exists (
      select 1 from public.client_users cu
      where cu.client_id = portal_documents.client_id and cu.user_id = auth.uid()
    )
  );

drop policy "portal_storage_select_own_folder" on storage.objects;
create policy "portal_storage_select_own_folder"
  on storage.objects for select
  using (
    bucket_id = 'client-documents'
    and exists (
      select 1 from public.client_users cu
      where cu.user_id = auth.uid()
        and cu.client_id::text = (storage.foldername(name))[1]
    )
  );

-- Drop the id->auth.users FK (and its ON DELETE CASCADE) now that access is
-- membership-based rather than identity-based. Keeping it would mean: once
-- remove_contact lets an admin delete an individual teammate's auth user,
-- deleting the ORIGINAL signup's auth user (who happens to still equal
-- portal_clients.id) would cascade and silently delete the entire company
-- row and every one of its documents -- with nothing distinguishing "the
-- original contact" from any other teammate at that point. client_users.
-- user_id's own FK (on delete cascade) correctly limits a deleted auth
-- user's blast radius to just their own membership row.
alter table public.portal_clients drop constraint portal_clients_id_fkey;
-- New companies no longer need to borrow an id from a specific auth
-- user -- create_client still does today (no reason to change working
-- code), but this default means the column no longer requires it.
alter table public.portal_clients alter column id set default gen_random_uuid();
