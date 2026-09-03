// Must match the CHECK constraint on public.portal_documents.category exactly
// (see supabase/migrations) — any value outside this list is rejected by the
// database.
export const DOCUMENT_CATEGORIES = [
  'Process Overview',
  'Deliverable',
  'Audit / Assessment',
  '90-Day Plan',
  'Brand Guide',
  'Report',
  'Research',
  'Contract',
  'Other',
] as const

// Display order for grouping a client's documents by category.
export const CATEGORY_SECTION_ORDER = [
  'Process Overview',
  'Audit / Assessment',
  'Research',
  '90-Day Plan',
  'Deliverable',
  'Brand Guide',
  'Report',
  'Contract',
  'Other',
] as const
