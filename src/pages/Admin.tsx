import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { supabase } from '../lib/supabaseClient'
import { adminApi } from '../lib/adminApi'
import type { AdminClient, AdminDocument } from '../lib/adminApi'
import { Logo } from '../components/Logo'
import { SiteHeader } from '../components/SiteHeader'
import { DOCUMENT_CATEGORIES } from '../lib/categories'

// Mirrors the title format website-audit-performance-background.ts computes
// server-side — kept in sync manually (small, stable string formatting;
// see that file's own comment on why this isn't shared code) so the client
// knows what to poll for immediately after firing the background check,
// without waiting on a response body that background functions don't give.
function computeExpectedPerformanceTitle(url: string, competitorName: string): string {
  const hostname = new URL(url).hostname
  const auditKindLabel = competitorName ? `Competitor Audit — ${competitorName}` : 'Website Audit'
  const fullLabel = `${auditKindLabel} (Technical)`
  const today = new Date().toISOString().slice(0, 10)
  return `${fullLabel} — ${hostname} — Performance — ${today}`
}

/**
 * Polls list_documents until a document with the given exact title shows
 * up — the only way to learn a Background Function's result, since it has
 * no synchronous response (see adminApi.startPerformanceCheck). A returned
 * document with admin_only true is the error-marker path (its description
 * is the error message); false is the real, successful result.
 */
async function pollForDocument(
  password: string,
  clientId: string,
  title: string,
  timeoutMs = 4 * 60 * 1000,
  intervalMs = 4000,
): Promise<AdminDocument> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { documents } = await adminApi.listDocuments(password, clientId)
    const match = documents.find((d) => d.title === title)
    if (match) return match
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(
    'The performance check is taking longer than expected. It may still finish in the background — check the document list again in a minute or two.'
  )
}

const REVIEW_URL_PATTERN = /Review & approve: (\S+)/

/**
 * Short, best-effort secondary poll for the Audit app review-report link
 * on a Comprehensive SEO Audit's performance document. The link can only
 * be attached after that document already exists (see
 * website-audit-performance-background.ts's appendToDescription), so
 * there's a brief window right after pollForDocument finds the document
 * where the link isn't there yet. Never throws — a caller that doesn't get
 * a link back just shows plain success text instead of a review CTA.
 */
async function pollForReviewUrl(
  password: string,
  clientId: string,
  documentId: string,
  timeoutMs = 15000,
  intervalMs = 3000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { documents } = await adminApi.listDocuments(password, clientId)
    const match = documents.find((d) => d.id === documentId)
    const found = match?.description?.match(REVIEW_URL_PATTERN)?.[1]
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return null
}

export function Admin() {
  const [password, setPassword] = useState('')
  const [unlocked, setUnlocked] = useState(false)
  const [passwordInput, setPasswordInput] = useState('')
  const [authError, setAuthError] = useState<string | null>(null)
  const [checkingPassword, setCheckingPassword] = useState(false)

  const [clients, setClients] = useState<AdminClient[]>([])
  const [selectedClientId, setSelectedClientId] = useState<string>('')
  const [docs, setDocs] = useState<AdminDocument[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<'clients' | 'archive'>('clients')
  const [archivedClients, setArchivedClients] = useState<AdminClient[]>([])
  const [archiveLoading, setArchiveLoading] = useState(false)
  const [auditBusy, setAuditBusy] = useState(false)
  const [auditStatus, setAuditStatus] = useState<string | null>(null)
  const [auditReviewUrl, setAuditReviewUrl] = useState<string | null>(null)
  const [selectedAuditType, setSelectedAuditType] = useState<'creative' | 'technical'>('creative')

  async function tryUnlock(candidate: string) {
    setAuthError(null)
    setCheckingPassword(true)
    try {
      const { clients } = await adminApi.listClients(candidate)
      setClients(clients)
      setPassword(candidate)
      setUnlocked(true)
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Could not unlock admin.')
    } finally {
      setCheckingPassword(false)
    }
  }

  async function refreshClients() {
    const { clients } = await adminApi.listClients(password)
    setClients(clients)
  }

  async function refreshDocs(clientId: string) {
    if (!clientId) {
      setDocs([])
      return
    }
    const { documents } = await adminApi.listDocuments(password, clientId)
    setDocs(documents)
  }

  useEffect(() => {
    if (unlocked) refreshDocs(selectedClientId).catch((err) => setError(err.message))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedClientId, unlocked])

  async function handlePasswordSubmit(e: FormEvent) {
    e.preventDefault()
    await tryUnlock(passwordInput)
  }

  async function handleCreateClient(e: FormEvent) {
    const form = e.currentTarget as HTMLFormElement
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const fd = new FormData(form)
      const { client } = await adminApi.createClient(
        password,
        String(fd.get('email')),
        String(fd.get('clientPassword')),
        String(fd.get('companyName')),
      )

      // Logo is optional and uploaded as a second step, same shape as a
      // document upload — it needs the new client's id as the storage path
      // prefix, which doesn't exist until createClient above returns.
      const logo = fd.get('logo') as File | null
      if (logo && logo.size > 0) {
        const { path, token } = await adminApi.createUploadUrl(password, client.id, logo.name)
        const { error: uploadError } = await supabase.storage
          .from('client-documents')
          .uploadToSignedUrl(path, token, logo)
        if (uploadError) throw uploadError
        await adminApi.setClientLogo(password, client.id, path)
      }

      form.reset()
      await refreshClients()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create client.')
    } finally {
      setBusy(false)
    }
  }

  async function refreshArchivedClients() {
    setArchiveLoading(true)
    try {
      const { clients } = await adminApi.listArchivedClients(password)
      setArchivedClients(clients)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load archived clients.')
    } finally {
      setArchiveLoading(false)
    }
  }

  async function handleShowArchive() {
    setView('archive')
    await refreshArchivedClients()
  }

  async function handleArchiveClient(client: AdminClient) {
    if (!confirm(`Archive "${client.company_name}"? They'll disappear from the active client list, but keep their documents and can still log in. You can unarchive them later.`)) {
      return
    }
    setError(null)
    setBusy(true)
    try {
      await adminApi.archiveClient(password, client.id)
      if (selectedClientId === client.id) setSelectedClientId('')
      await refreshClients()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not archive client.')
    } finally {
      setBusy(false)
    }
  }

  async function handleUnarchiveClient(client: AdminClient) {
    setError(null)
    setBusy(true)
    try {
      await adminApi.unarchiveClient(password, client.id)
      await refreshArchivedClients()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not unarchive client.')
    } finally {
      setBusy(false)
    }
  }

  async function handleUpload(e: FormEvent) {
    const form = e.currentTarget as HTMLFormElement
    e.preventDefault()
    if (!selectedClientId) return
    setError(null)
    setBusy(true)

    try {
      const fd = new FormData(form)
      const file = fd.get('file') as File
      if (!file || file.size === 0) throw new Error('Choose a file to upload.')

      const { path, token } = await adminApi.createUploadUrl(password, selectedClientId, file.name)

      const { error: uploadError } = await supabase.storage
        .from('client-documents')
        .uploadToSignedUrl(path, token, file)
      if (uploadError) throw uploadError

      await adminApi.createDocument(password, {
        clientId: selectedClientId,
        title: String(fd.get('title')),
        description: String(fd.get('description') ?? ''),
        category: String(fd.get('category') ?? ''),
        filePath: path,
        sortOrder: Number(fd.get('sortOrder') ?? 0),
        adminOnly: fd.get('adminOnly') === 'on',
      })

      form.reset()
      await refreshDocs(selectedClientId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.')
    } finally {
      setBusy(false)
    }
  }

  async function handleRunWebsiteAudit(e: FormEvent) {
    const form = e.currentTarget as HTMLFormElement
    e.preventDefault()
    if (!selectedClientId) return
    setError(null)
    setAuditStatus(null)
    setAuditReviewUrl(null)
    setAuditBusy(true)

    try {
      const fd = new FormData(form)
      const url = String(fd.get('websiteUrl') ?? '').trim()
      if (!url) throw new Error('Enter a URL to audit.')
      const competitorName = String(fd.get('competitorName') ?? '').trim()
      const auditType = (String(fd.get('auditType') ?? 'creative') === 'technical' ? 'technical' : 'creative') as
        | 'creative'
        | 'technical'
      const depth = (String(fd.get('auditDepth') ?? 'light') === 'comprehensive' ? 'comprehensive' : 'light') as
        | 'light'
        | 'comprehensive'
      const label = competitorName ? `Competitor Audit for "${competitorName}"` : 'Website Audit'

      if (auditType === 'creative') {
        const { pagesCrawled } = await adminApi.runWebsiteAudit(password, selectedClientId, url, competitorName || undefined, 'creative')
        setAuditStatus(`Done — crawled ${pagesCrawled} page(s) and saved as a Creative ${label}.`)
      } else if (depth === 'light') {
        // Light tier is a single synchronous request — the crawl, the
        // checks, and (server-side) the handoff that creates a draft
        // review report in the Audit app all happen within this one call.
        setAuditStatus('Running Light SEO checks…')
        const result = await adminApi.runWebsiteAudit(
          password,
          selectedClientId,
          url,
          competitorName || undefined,
          'technical',
          'fast',
          'light',
        )
        if (result.reviewUrl) {
          setAuditReviewUrl(result.reviewUrl)
          setAuditStatus(`Done — saved a Light SEO Audit for ${label}. A draft review report is ready.`)
        } else {
          setAuditStatus(
            `Done — saved a Light SEO Audit for ${label}, but couldn't create a review report${
              result.handoffError ? `: ${result.handoffError}` : '.'
            } The crawl data is saved either way — retry from the Audit app if needed.`,
          )
        }
      } else {
        // Comprehensive: the fast checks are a normal request/response. The
        // performance check (PageSpeed Insights) is not — it runs in a
        // Background Function with no synchronous response, since PSI's own
        // response time kept exceeding what a normal ~30s request can
        // survive (see website-audit-performance-background.ts). So this
        // fires it, then polls list_documents for the document it'll
        // eventually produce — the review-report handoff (covering both
        // documents) happens server-side as part of that background run.
        setAuditStatus('Running Comprehensive SEO checks…')
        const fastResult = await adminApi.runWebsiteAudit(
          password,
          selectedClientId,
          url,
          competitorName || undefined,
          'technical',
          'fast',
          'comprehensive',
        )
        setAuditStatus(`SEO checks done (${fastResult.pagesCrawled} page(s)) — running performance check in the background…`)
        // Refresh here too, not just at the end — the fast-checks document is
        // already saved server-side at this point, and the performance step
        // can take a while longer, so leaving the list stale makes it look
        // like nothing happened yet.
        await refreshDocs(selectedClientId)

        const technicalDocumentId = fastResult.documents[0]?.id
        await adminApi.startPerformanceCheck(password, selectedClientId, url, technicalDocumentId ?? '', competitorName || undefined)
        const expectedTitle = computeExpectedPerformanceTitle(url, competitorName)
        const perfDoc = await pollForDocument(password, selectedClientId, expectedTitle)
        if (perfDoc.admin_only) {
          throw new Error(perfDoc.description ?? 'Performance check failed.')
        }
        setAuditStatus(`Done — saved a Comprehensive SEO Audit for ${label}, including a performance check.`)
        // Best-effort: the review link is attached to this same document a
        // little after it's first saved (see appendToDescription in
        // website-audit-performance-background.ts) — a short extra poll,
        // not a hard requirement for reporting success.
        const reviewUrl = await pollForReviewUrl(password, selectedClientId, perfDoc.id)
        if (reviewUrl) setAuditReviewUrl(reviewUrl)
      }
      form.reset()
      setSelectedAuditType('creative')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Website audit failed.')
    } finally {
      // In finally rather than only on the success path — a failed
      // performance check still leaves a new (error-marker) document behind
      // that the list should show, not just a successful one.
      await refreshDocs(selectedClientId).catch(() => {})
      setAuditBusy(false)
    }
  }

  function handleLogout() {
    setUnlocked(false)
    setPassword('')
    setPasswordInput('')
    setClients([])
    setSelectedClientId('')
    setDocs([])
    setError(null)
    setAuthError(null)
    setView('clients')
    setArchivedClients([])
  }

  async function handleDelete(doc: AdminDocument) {
    if (!confirm(`Delete "${doc.title}"? This cannot be undone.`)) return
    setError(null)
    setBusy(true)
    try {
      await adminApi.deleteDocument(password, doc.id, doc.file_path)
      await refreshDocs(selectedClientId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete document.')
    } finally {
      setBusy(false)
    }
  }

  async function handleView(doc: AdminDocument) {
    setError(null)
    try {
      const { url } = await adminApi.getDownloadUrl(password, doc.file_path)
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open document.')
    }
  }

  if (!unlocked) {
    return (
      <div className="page-center">
        <Logo large />
        <form className="card" onSubmit={handlePasswordSubmit}>
          <span className="eyebrow">Admin</span>
          <h1>Enter password</h1>
          <label htmlFor="admin-password">Admin password</label>
          <input
            id="admin-password"
            type="password"
            value={passwordInput}
            onChange={(e) => setPasswordInput(e.target.value)}
            autoFocus
            required
          />
          {authError && <p className="error">{authError}</p>}
          <button type="submit" disabled={checkingPassword}>
            {checkingPassword ? 'Checking…' : 'Unlock'}
          </button>
        </form>
      </div>
    )
  }

  return (
    <>
      <SiteHeader>
        <span className="eyebrow" style={{ margin: 0 }}>
          Admin
        </span>
        {view === 'clients' ? (
          <button type="button" className="secondary" onClick={handleShowArchive}>
            View archived clients
          </button>
        ) : (
          <button type="button" className="secondary" onClick={() => setView('clients')}>
            Back to active clients
          </button>
        )}
        <button type="button" className="secondary" onClick={handleLogout}>
          Log out
        </button>
      </SiteHeader>

      <div className="page">
        {error && <p className="error">{error}</p>}

        {view === 'archive' ? (
          <section className="card">
            <h2>Archived clients</h2>
            <p className="muted" style={{ marginTop: 4 }}>
              Archiving only hides a client from the active list above — their documents and
              portal login are untouched, and unarchiving brings them right back.
            </p>
            {archiveLoading ? (
              <p className="muted">Loading…</p>
            ) : archivedClients.length === 0 ? (
              <p className="muted">No archived clients.</p>
            ) : (
              <ul className="doc-list">
                {archivedClients.map((c) => (
                  <li key={c.id} className="doc-row">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {c.logo_url && (
                        <img
                          src={c.logo_url}
                          alt=""
                          style={{ width: 28, height: 28, objectFit: 'contain', borderRadius: 4 }}
                        />
                      )}
                      <div>
                        <div className="doc-title">{c.company_name}</div>
                        {c.archived_at && (
                          <span className="muted">
                            Archived {new Date(c.archived_at).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="doc-row-actions">
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => handleUnarchiveClient(c)}
                        disabled={busy}
                      >
                        Unarchive
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : (
          <>
        <section className="card">
          <h2>Add a client</h2>
          <form onSubmit={handleCreateClient} className="stacked-form">
            <label htmlFor="companyName">Company name</label>
            <input id="companyName" name="companyName" required />

            <label htmlFor="email">Login email</label>
            <input id="email" name="email" type="email" required />

            <label htmlFor="clientPassword">Temporary password</label>
            <input id="clientPassword" name="clientPassword" type="text" required minLength={8} />

            <label htmlFor="logo">Logo (optional)</label>
            <input id="logo" name="logo" type="file" accept="image/*" />
            <p className="muted" style={{ marginTop: 4 }}>
              Shown next to their name in the client picker below — for staff reference only,
              never shown to the client.
            </p>

            <button type="submit" disabled={busy}>
              Create client
            </button>
          </form>
        </section>

        <section className="card">
          <h2>Documents</h2>
          <label htmlFor="clientSelect">Client</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <select
              id="clientSelect"
              value={selectedClientId}
              onChange={(e) => setSelectedClientId(e.target.value)}
            >
              <option value="">Select a client…</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.company_name}
                </option>
              ))}
            </select>
            {selectedClientId && clients.find((c) => c.id === selectedClientId)?.logo_url && (
              <img
                src={clients.find((c) => c.id === selectedClientId)?.logo_url ?? undefined}
                alt=""
                style={{ width: 28, height: 28, objectFit: 'contain', borderRadius: 4 }}
              />
            )}
            {selectedClientId && (
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  const client = clients.find((c) => c.id === selectedClientId)
                  if (client) handleArchiveClient(client)
                }}
                disabled={busy}
              >
                Archive this client
              </button>
            )}
          </div>

          {selectedClientId && (
            <>
              <ul className="doc-list">
                {docs.map((doc) => (
                  <li key={doc.id} className="doc-row">
                    <div>
                      <div className="doc-title">{doc.title}</div>
                      {doc.category && <span className="badge">{doc.category}</span>}
                      {doc.admin_only && <span className="badge badge-hidden">Hidden</span>}
                    </div>
                    <div className="doc-row-actions">
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => handleView(doc)}
                      >
                        View
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => handleDelete(doc)}
                        disabled={busy}
                      >
                        Delete
                      </button>
                    </div>
                  </li>
                ))}
                {docs.length === 0 && <p className="muted">No documents yet.</p>}
              </ul>

              <h3>Upload a document</h3>
              <form onSubmit={handleUpload} className="stacked-form">
                <label htmlFor="title">Title</label>
                <input id="title" name="title" required />

                <label htmlFor="description">Description</label>
                <input id="description" name="description" />

                <label htmlFor="category">Category</label>
                <select id="category" name="category" defaultValue="" required>
                  <option value="" disabled>
                    Select a category…
                  </option>
                  {DOCUMENT_CATEGORIES.map((category) => (
                    <option key={category} value={category}>
                      {category}
                    </option>
                  ))}
                </select>
                <p className="muted" style={{ marginTop: 4 }}>
                  Research documents are always internal-only — the client never sees them,
                  regardless of the &quot;Admin only&quot; checkbox below.
                </p>

                <label htmlFor="sortOrder">Sort order</label>
                <input id="sortOrder" name="sortOrder" type="number" defaultValue={0} />

                <label htmlFor="file">File</label>
                <input id="file" name="file" type="file" required />

                <label className="checkbox-field">
                  <input id="adminOnly" name="adminOnly" type="checkbox" />
                  Admin only (hidden from client)
                </label>

                <button type="submit" disabled={busy}>
                  {busy ? 'Uploading…' : 'Upload'}
                </button>
              </form>

              <h3>Run a website audit</h3>
              <p className="muted" style={{ marginTop: 4 }}>
                Crawls a small set of pages on the site and saves the result as Research
                documents — same as uploading them by hand, just automated. Leave
                &quot;Competitor name&quot; blank to audit the client&apos;s own site, or fill it in
                to audit a named competitor&apos;s site instead — run it once per competitor.
              </p>
              <form onSubmit={handleRunWebsiteAudit} className="stacked-form">
                <label htmlFor="websiteUrl">Website URL</label>
                <input
                  id="websiteUrl"
                  name="websiteUrl"
                  type="url"
                  placeholder="https://example.com"
                  required
                />

                <label htmlFor="competitorName">Competitor name (optional)</label>
                <input
                  id="competitorName"
                  name="competitorName"
                  placeholder="Leave blank for the client's own site — or name a competitor, e.g. Parachute"
                />

                <label>Audit type</label>
                <label className="checkbox-field">
                  <input
                    type="radio"
                    name="auditType"
                    value="creative"
                    checked={selectedAuditType === 'creative'}
                    onChange={() => setSelectedAuditType('creative')}
                  />
                  Creative Audit — page copy, color/font summary, screenshots, perceived tone
                </label>
                <label className="checkbox-field">
                  <input
                    type="radio"
                    name="auditType"
                    value="technical"
                    checked={selectedAuditType === 'technical'}
                    onChange={() => setSelectedAuditType('technical')}
                  />
                  SEO Audit — SEO/technical health, structured data, Core Web Vitals
                </label>

                {selectedAuditType === 'technical' && (
                  <>
                    <label>SEO Audit depth</label>
                    <label className="checkbox-field">
                      <input type="radio" name="auditDepth" value="light" defaultChecked />
                      Light — fast checks only (meta, structure, schema, hygiene, analytics)
                    </label>
                    <label className="checkbox-field">
                      <input type="radio" name="auditDepth" value="comprehensive" />
                      Comprehensive — adds Local SEO, redirect health, AI Visibility/GEO, and a
                      Core Web Vitals performance check
                    </label>
                    <p className="muted" style={{ marginTop: 4 }}>
                      Either depth drafts a review report in the Audit app — a consultant edits
                      and approves it there before anything reaches the client.
                    </p>
                  </>
                )}

                <button type="submit" disabled={auditBusy}>
                  {auditBusy ? 'Running audit…' : 'Run Website Audit'}
                </button>
              </form>
              {auditStatus && <p className="muted">{auditStatus}</p>}
              {auditReviewUrl && (
                <p>
                  <a href={auditReviewUrl} target="_blank" rel="noreferrer">
                    Review &amp; finalize this SEO Audit in the Audit app ↗
                  </a>
                </p>
              )}
            </>
          )}
        </section>
          </>
        )}
      </div>
    </>
  )
}
