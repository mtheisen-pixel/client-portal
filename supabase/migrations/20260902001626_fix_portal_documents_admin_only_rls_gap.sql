-- The admin_only migration above added a new, correctly-scoped select
-- policy (documents_select_own) but left the original policy from the
-- initial schema (portal_documents_select_own, no admin_only check) in
-- place. Postgres OR's multiple RLS policies for the same command
-- together, so the old policy alone let a client see admin_only rows
-- regardless of the new one. Drop it so admin_only is actually enforced.
drop policy "portal_documents_select_own" on public.portal_documents;
