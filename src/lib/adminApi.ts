const ENDPOINT = '/.netlify/functions/admin'
const WEBSITE_AUDIT_ENDPOINT = '/.netlify/functions/website-audit'
const PERFORMANCE_CHECK_BACKGROUND_ENDPOINT = '/.netlify/functions/website-audit-performance-background'
const AI_SEARCH_VISIBILITY_ENDPOINT = '/.netlify/functions/ai-search-visibility'

async function call<T>(password: string, action: string, payload: Record<string, unknown> = {}) {
  // password/action are spread last so a payload field can never shadow them
  // (this previously broke createClient, whose payload also carries a
  // "password" field for the new client's own login password).
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, password, action }),
  })

  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`)
  return data as T
}

export interface AdminClient {
  id: string
  company_name: string
  created_at: string
  logo_path: string | null
  logo_url: string | null
  category: string | null
  site_url: string | null
  /** Only present on the archived-clients list. */
  archived_at?: string | null
}

export interface AdminContact {
  id: string
  user_id: string
  name: string | null
  role: string | null
  email: string | null
  created_at: string
}

export interface AdminDocument {
  id: string
  client_id: string
  title: string
  description: string | null
  category: string | null
  file_path: string
  sort_order: number
  created_at: string
  admin_only: boolean
}

export interface AiSearchVisibilityEstimate {
  promptCount: number
  platforms: string[]
  plannedCalls: number
  lowUsd: number
  highUsd: number
}

/** Readiness check before an AI Search Visibility Audit run — see the Audit app's src/lib/ai-search-visibility/server.ts. */
export interface AiSearchVisibilityPreflight {
  ready: boolean
  reason?: 'not_linked' | 'no_prompt_set' | 'already_running'
  message?: string
  setupUrl?: string
  clientName?: string
  activeBatchId?: string
  /** false when the running batch belongs to the legacy AI Visibility tool (nothing to track here). */
  activeBatchIsSearchVisibility?: boolean
  estimate?: AiSearchVisibilityEstimate
}

export interface AiSearchVisibilityStatus {
  batchId: string
  status: 'queued' | 'running' | 'completed' | 'completed-with-errors' | 'failed'
  plannedCalls: number
  doneCalls: number
  errorCount: number
  estimatedCostUsd: number
  startedAt: string
  completedAt: string | null
  error: string | null
  reportId: string | null
  reviewUrl: string | null
}

async function callAiSearchVisibility<T>(password: string, payload: Record<string, unknown>): Promise<T> {
  const res = await fetch(AI_SEARCH_VISIBILITY_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, password }),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`)
  return data as T
}

export const adminApi = {
  // Active clients only (archived ones are excluded server-side) — see
  // listArchivedClients for the archive view.
  listClients: (password: string) => call<{ clients: AdminClient[] }>(password, 'list_clients'),

  listArchivedClients: (password: string) =>
    call<{ clients: AdminClient[] }>(password, 'list_archived_clients'),

  // Hide-only: the client keeps their documents and can still log in — see
  // README's "Archiving a client" section. Fully reversible via unarchiveClient.
  archiveClient: (password: string, clientId: string) =>
    call<{ ok: true }>(password, 'archive_client', { clientId }),

  unarchiveClient: (password: string, clientId: string) =>
    call<{ ok: true }>(password, 'unarchive_client', { clientId }),

  // Records where an already-uploaded logo file landed (upload it first via
  // createUploadUrl + Supabase Storage's uploadToSignedUrl, same two-step
  // pattern as a document). Pass logoPath: null to clear a client's logo.
  setClientLogo: (password: string, clientId: string, logoPath: string | null) =>
    call<{ ok: true }>(password, 'set_client_logo', { clientId, logoPath }),

  createClient: (
    password: string,
    email: string,
    clientPassword: string,
    companyName: string,
    args: {
      contactName?: string
      contactRole?: string
      category?: string
      siteUrl?: string
    } = {},
  ) =>
    call<{ client: AdminClient }>(password, 'create_client', {
      email,
      clientPassword,
      companyName,
      ...args,
    }),

  // See admin.ts's update_client_details — the only other place category/
  // site_url are set is createClient, so this is what lets a client created
  // before these fields existed get them filled in after the fact.
  updateClientDetails: (password: string, clientId: string, category: string | null, siteUrl: string | null) =>
    call<{ ok: true }>(password, 'update_client_details', { clientId, category, siteUrl }),

  listContacts: (password: string, clientId: string) =>
    call<{ contacts: AdminContact[] }>(password, 'list_contacts', { clientId }),

  addContact: (
    password: string,
    clientId: string,
    email: string,
    contactPassword: string,
    name?: string,
    role?: string,
  ) =>
    call<{ ok: true }>(password, 'add_contact', {
      clientId,
      email,
      contactPassword,
      name,
      role,
    }),

  removeContact: (password: string, contactId: string) =>
    call<{ ok: true }>(password, 'remove_contact', { contactId }),

  listDocuments: (password: string, clientId: string) =>
    call<{ documents: AdminDocument[] }>(password, 'list_documents', { clientId }),

  createUploadUrl: (password: string, clientId: string, filename: string) =>
    call<{ path: string; token: string }>(password, 'create_upload_url', { clientId, filename }),

  createDocument: (
    password: string,
    args: {
      clientId: string
      title: string
      description?: string
      category?: string
      filePath: string
      sortOrder?: number
      adminOnly?: boolean
    },
  ) => call<{ document: AdminDocument }>(password, 'create_document', args),

  deleteDocument: (password: string, documentId: string, filePath: string) =>
    call<{ ok: true }>(password, 'delete_document', { documentId, filePath }),

  getDownloadUrl: (password: string, filePath: string) =>
    call<{ url: string }>(password, 'get_download_url', { filePath }),

  // Separate endpoint, not the action-dispatched `call` above — a crawl can
  // run much longer than admin.ts's other near-instant operations, see
  // netlify/functions/website-audit.ts. A non-empty competitorName runs the
  // identical crawl against a named competitor's site instead of the
  // client's own — same document category/storage pattern, just tagged
  // "Competitor Audit — {name}" instead of "Website Audit" so Findings can
  // tell the two apart. auditType/step select which crawl runs — see the
  // doc comment at the top of website-audit.ts for the three shapes. depth
  // only matters for auditType 'technical' ("SEO Audit" in the UI) — see
  // technical-audit.ts. reviewUrl/handoffError are only present for the
  // Light tier; Comprehensive's review link arrives later via the
  // performance doc — see pollForReviewUrl below.
  runWebsiteAudit: async (
    password: string,
    clientId: string,
    url: string,
    competitorName?: string,
    auditType?: 'creative' | 'technical',
    step?: 'fast',
    depth?: 'light' | 'comprehensive',
  ) => {
    const res = await fetch(WEBSITE_AUDIT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, clientId, url, competitorName, auditType, step, depth }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`)
    return data as {
      documents: AdminDocument[]
      pagesCrawled: number
      reviewUrl?: string
      handoffError?: string
    }
  },

  aiSearchVisibilityPreflight: (password: string, clientId: string) =>
    callAiSearchVisibility<AiSearchVisibilityPreflight>(password, { action: 'preflight', clientId }),

  startAiSearchVisibility: (password: string, clientId: string, tier: 'light' | 'comprehensive') =>
    callAiSearchVisibility<{ batchId: string; estimate: AiSearchVisibilityEstimate }>(password, {
      action: 'start',
      clientId,
      tier,
    }),

  aiSearchVisibilityStatus: (password: string, clientId: string, batchId: string) =>
    callAiSearchVisibility<AiSearchVisibilityStatus>(password, { action: 'status', clientId, batchId }),

  // Fire-and-forget: this hits a Netlify Background Function, which returns
  // a 202 immediately and keeps running for up to 15 minutes — there is no
  // meaningful response body to parse, and no way to learn success/failure
  // from this call. The result (or an error) shows up later as a document;
  // see pollForDocument in Admin.tsx, which is how the caller actually finds
  // out what happened. See website-audit-performance-background.ts for why
  // this couldn't stay a normal synchronous request like runWebsiteAudit.
  // technicalDocumentId is the id of the doc runWebsiteAudit already saved —
  // passed through so the background function can attach it (alongside its
  // own performance doc) to the Audit app review-report handoff.
  startPerformanceCheck: async (
    password: string,
    clientId: string,
    url: string,
    technicalDocumentId: string,
    competitorName?: string,
  ): Promise<void> => {
    await fetch(PERFORMANCE_CHECK_BACKGROUND_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, clientId, url, competitorName, technicalDocumentId }),
    })
  },
}
