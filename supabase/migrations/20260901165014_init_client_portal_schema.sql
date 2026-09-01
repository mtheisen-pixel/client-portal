-- Client Document Portal schema.
--
-- Kept as its own set of portal_* tables, separate from the pre-existing
-- clients/studio_intakes/studio_reports tables in this project (a different
-- app), so this migration never touches their data or foreign keys.
--
-- Model: one login per client company (clients.id IS their auth.users id).
-- See the note at the bottom of the original design doc if this ever needs
-- to grow into multiple people per client company.

-- One row per portal client company. The row's id IS their auth.users id --
-- this keeps the "which client is this" check as simple as possible.
create table public.portal_clients (
  id uuid primary key references auth.users(id) on delete cascade,
  company_name text not null,
  created_at timestamptz not null default now()
);

-- One row per document. client_id ties it to exactly one portal client.
create table public.portal_documents (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.portal_clients(id) on delete cascade,
  title text not null,
  description text,
  category text,               -- e.g. 'Brand Guide', 'Report', 'Contract'
  file_path text not null,     -- path inside the storage bucket, see below
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

alter table public.portal_clients enable row level security;
alter table public.portal_documents enable row level security;

-- A client can see only their own client row.
create policy "portal_clients_select_own"
  on public.portal_clients for select
  using (auth.uid() = id);

-- A client can see only documents where client_id matches their own id.
create policy "portal_documents_select_own"
  on public.portal_documents for select
  using (auth.uid() = client_id);

-- Nobody gets insert/update/delete policies here on purpose -- clients are
-- read-only. All document management happens through the admin Netlify
-- function using the service_role key (bypasses RLS), which must only
-- ever be used server-side, never shipped to the browser.

-- Private bucket for the actual files. Convention: every uploaded file's
-- path starts with the client's own id, e.g. {client_id}/brand-guide-2026.pdf
insert into storage.buckets (id, name, public)
values ('client-documents', 'client-documents', false);

-- A client can only read objects inside their own folder.
create policy "portal_storage_select_own_folder"
  on storage.objects for select
  using (
    bucket_id = 'client-documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
