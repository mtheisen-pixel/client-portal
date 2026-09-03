-- Adds "Research" as a valid portal_documents category, for raw audit
-- material (screenshots, competitor comparisons, observation notes) that
-- feeds report generation in the separate Studio Audit app — as distinct
-- from finished deliverables or the client's own materials in the other
-- categories. Must stay in sync with DOCUMENT_CATEGORIES in
-- src/lib/categories.ts.
alter table public.portal_documents
  drop constraint portal_documents_category_check;

alter table public.portal_documents
  add constraint portal_documents_category_check
  check (category = any (array[
    'Process Overview',
    'Deliverable',
    'Audit / Assessment',
    '90-Day Plan',
    'Brand Guide',
    'Report',
    'Research',
    'Contract',
    'Other'
  ]));
