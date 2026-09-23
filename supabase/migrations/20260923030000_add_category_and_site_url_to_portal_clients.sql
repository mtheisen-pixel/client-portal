-- category matches the sibling Audit app's clients.category enum values
-- exactly (see that app's 0011_client_category.sql) -- this is the field
-- the seo_studio handoff route already accepts and uses to set the
-- Audit-app client's own category (which drives its "Confirm Before
-- Scoping" Findings behavior). Keeping the same six values here means an
-- SEO-Audit-only client's category is meaningful the moment they're set up
-- in client-portal, rather than silently landing as null in the Audit app.
--
-- site_url is unrelated to the Audit app's own same-named clients.site_url
-- column (that one feeds a separate legacy SEO ingestion tool and is
-- untouched here) -- this is purely a client-portal convenience, to
-- prefill the "Run a website audit" form instead of retyping the URL
-- every time.
alter table public.portal_clients
  add column category text,
  add column site_url text;

alter table public.portal_clients add constraint portal_clients_category_check
  check (category is null or category = any (array[
    'general_business',
    'specialty_medical_dental',
    'legal',
    'b2b_professional_services',
    'ecommerce_retail',
    'other'
  ]));
