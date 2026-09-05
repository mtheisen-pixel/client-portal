const ENDPOINT = '/.netlify/functions/admin'
const WEBSITE_AUDIT_ENDPOINT = '/.netlify/functions/website-audit'
const PERFORMANCE_CHECK_BACKGROUND_ENDPOINT = '/.netlify/functions/website-audit-performance-background'

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

export const adminApi = {
  listClients: (password: string) => call<{ clients: AdminClient[] }>(password, 'list_clients'),

  createClient: (password: string, email: string, clientPassword: string, companyName: string) =>
    call<{ client: AdminClient }>(password, 'create_client', {
      email,
      clientPassword,
      companyName,
    }),

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
  // doc comment at the top of website-audit.ts for the three shapes.
  runWebsiteAudit: async (
    password: string,
    clientId: string,
    url: string,
    competitorName?: string,
    auditType?: 'creative' | 'technical',
    step?: 'fast',
  ) => {
    const res = await fetch(WEBSITE_AUDIT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, clientId, url, competitorName, auditType, step }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`)
    return data as { documents: AdminDocument[]; pagesCrawled: number }
  },

  // Fire-and-forget: this hits a Netlify Background Function, which returns
  // a 202 immediately and keeps running for up to 15 minutes — there is no
  // meaningful response body to parse, and no way to learn success/failure
  // from this call. The result (or an error) shows up later as a document;
  // see pollForDocument in Admin.tsx, which is how the caller actually finds
  // out what happened. See website-audit-performance-background.ts for why
  // this couldn't stay a normal synchronous request like runWebsiteAudit.
  startPerformanceCheck: async (
    password: string,
    clientId: string,
    url: string,
    competitorName?: string,
  ): Promise<void> => {
    await fetch(PERFORMANCE_CHECK_BACKGROUND_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, clientId, url, competitorName }),
    })
  },
}
