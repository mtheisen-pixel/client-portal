-- Lets the admin upload a document that stays hidden from the client
-- (e.g. internal working files). Defaults to false so existing rows and
-- the normal upload path are unaffected.
alter table public.portal_documents
  add column admin_only boolean not null default false;

-- Clients may only see their own documents that aren't admin_only.
create policy "documents_select_own"
  on public.portal_documents for select
  using (auth.uid() = client_id and admin_only = false);
