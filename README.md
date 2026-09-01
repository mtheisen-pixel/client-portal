# Client Portal

A password-protected portal where clients log in to see only their own
documents. Built on Supabase (Auth + Postgres + Storage) with a React
frontend, deployed on Netlify.

## How it works

- **Login** — clients sign in with email/password (`src/pages/Login.tsx`),
  using Supabase Auth.
- **Documents** (`src/pages/Documents.tsx`) — after login, the page queries
  `portal_documents` with the anon key. Row Level Security filters the
  results to that client's own rows automatically — the query is identical
  for every client. Downloads go through `supabase.storage...download()`,
  which is also enforced by a storage RLS policy scoped to the client's own
  folder.
- **Admin** (`src/pages/Admin.tsx`) — an internal page (gated by a shared
  `ADMIN_PASSWORD`, not tied to client logins) for creating client accounts
  and uploading/removing their documents. All the actual database and
  storage writes happen in `netlify/functions/admin.ts`, the only place the
  Supabase **service_role key** is used. That key bypasses Row Level
  Security, so it must never be shipped to the browser — it lives only in
  Netlify's server-side environment variables.

Data model: one login = one client company (`portal_clients.id` **is** the
`auth.users` id). If you ever need multiple people per client company to
log in separately, see the note at the bottom of the original schema
design — swap to a `client_users` join table and update the two RLS
policies that check `auth.uid() = client_id` accordingly. Not needed to
start.

The existing `clients` / `studio_intakes` / `studio_reports` tables in this
Supabase project belong to a separate, unrelated app and are untouched by
this schema — the portal uses its own `portal_clients` / `portal_documents`
tables and a private `client-documents` storage bucket.

## Local setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in `VITE_SUPABASE_URL` /
   `VITE_SUPABASE_ANON_KEY` (from the Supabase dashboard → Project Settings
   → API).
3. `npm run dev`

The admin page (`/admin`) calls a Netlify Function, so to exercise it
locally you need the Netlify CLI:

```
npm install -g netlify-cli
netlify env:set SUPABASE_URL <your-project-url>
netlify env:set SUPABASE_SERVICE_ROLE_KEY <your-service-role-key>
netlify env:set ADMIN_PASSWORD <choose-a-password>
netlify dev
```

(`netlify dev` runs both the Vite dev server and the functions together, so
`/admin` works end to end.)

## Deploying (Netlify)

1. Connect this repo in Netlify. Build command `npm run build`, publish
   directory `dist` (already set in `netlify.toml`).
2. In Site settings → Environment variables, set:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - `SUPABASE_URL` (same URL, no `VITE_` prefix — used server-side only)
   - `SUPABASE_SERVICE_ROLE_KEY` (Project Settings → API → service_role —
     **secret**, never the anon key)
   - `ADMIN_PASSWORD` (a password only you know; this gates `/admin`)
3. Deploy.

## Adding a client (day to day)

Once deployed, go to `/admin`, enter the admin password, and:

1. "Add a client" — enter their company name, a login email, and a
   temporary password. Share those login credentials with the client
   however you'd share any password (they can't reset it themselves yet —
   there's no forgot-password flow wired up).
2. Select the client from the dropdown, fill in title/category/description,
   choose a file, and upload. It appears in their document list
   immediately.

## Database

The schema lives in `supabase/migrations/`. It has already been applied to
the connected Supabase project; the file is kept in the repo so the schema
is version-controlled and reproducible (e.g. `supabase db push` against a
new project).
