-- Adds client archiving (hide-only, fully reversible -- login and
-- documents stay untouched, see README's "Archiving a client" section)
-- and an optional logo, shown only in the admin UI next to a client's
-- name so staff can spot the right one visually. Neither column needs a
-- new RLS policy: portal_clients_select_own already scopes a client to
-- exactly their own row, and these are just two more columns on it.

alter table public.portal_clients
  add column archived_at timestamptz,
  add column logo_path text;
