-- Tracks failed /admin password attempts by IP for basic brute-force
-- protection. Only ever touched by the admin Netlify function via the
-- service_role key, so RLS is enabled with no policies (deny-all to
-- anon/authenticated).
create table public.admin_lockouts (
  ip text primary key,
  failed_count int not null default 0,
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.admin_lockouts enable row level security;
