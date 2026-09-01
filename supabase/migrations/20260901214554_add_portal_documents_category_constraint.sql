-- Restricts portal_documents.category to the fixed set of categories used
-- by the admin upload form's dropdown and the client-facing grouped view.
alter table public.portal_documents
  add constraint portal_documents_category_check
  check (category = any (array[
    'Process Overview',
    'Deliverable',
    'Audit / Assessment',
    '90-Day Plan',
    'Brand Guide',
    'Report',
    'Contract',
    'Other'
  ]));
