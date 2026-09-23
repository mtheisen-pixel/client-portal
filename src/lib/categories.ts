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

// Must match the CHECK constraint on public.portal_clients.category exactly
// (see supabase/migrations), which in turn matches the Audit app's own
// clients.category enum verbatim (0011_client_category.sql there) — this is
// the value passed through the seo_studio handoff's category field, so a
// mismatch here would silently drift the two apps' taxonomies for the same
// concept. Hardcoded once rather than imported cross-repo.
export const CLIENT_CATEGORIES = [
  { value: 'general_business', label: 'General business' },
  { value: 'specialty_medical_dental', label: 'Specialty medical / dental' },
  { value: 'legal', label: 'Legal' },
  { value: 'b2b_professional_services', label: 'B2B professional services' },
  { value: 'ecommerce_retail', label: 'Ecommerce / retail' },
  { value: 'other', label: 'Other' },
] as const
