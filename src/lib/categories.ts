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
//
// 'Research' is deliberately absent from this list. Research documents are
// always internal-only in the client-facing portal, regardless of the
// separate admin_only flag — the studio intake app reads them directly
// (category = 'Research') to source Findings/Executive Summary content for
// reports, but their raw content must never reach Documents.tsx. See the
// category filter in Documents.tsx, which enforces this independently of
// this list too.
export const CATEGORY_SECTION_ORDER = [
  'Process Overview',
  'Audit / Assessment',
  '90-Day Plan',
  'Deliverable',
  'Brand Guide',
  'Report',
  'Contract',
  'Other',
] as const
