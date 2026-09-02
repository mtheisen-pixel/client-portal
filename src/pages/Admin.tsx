import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { supabase } from '../lib/supabaseClient'
import { adminApi } from '../lib/adminApi'
import type { AdminClient, AdminDocument } from '../lib/adminApi'
import { Logo } from '../components/Logo'
import { SiteHeader } from '../components/SiteHeader'
import { DOCUMENT_CATEGORIES } from '../lib/categories'

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
      await adminApi.createClient(
        password,
        String(fd.get('email')),
        String(fd.get('clientPassword')),
        String(fd.get('companyName')),
      )
      form.reset()
      await refreshClients()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create client.')
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
      </SiteHeader>

      <div className="page">
        {error && <p className="error">{error}</p>}

        <section className="card">
          <h2>Add a client</h2>
          <form onSubmit={handleCreateClient} className="stacked-form">
            <label htmlFor="companyName">Company name</label>
            <input id="companyName" name="companyName" required />

            <label htmlFor="email">Login email</label>
            <input id="email" name="email" type="email" required />

            <label htmlFor="clientPassword">Temporary password</label>
            <input id="clientPassword" name="clientPassword" type="text" required minLength={8} />

            <button type="submit" disabled={busy}>
              Create client
            </button>
          </form>
        </section>

        <section className="card">
          <h2>Documents</h2>
          <label htmlFor="clientSelect">Client</label>
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
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => handleDelete(doc)}
                      disabled={busy}
                    >
                      Delete
                    </button>
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
            </>
          )}
        </section>
      </div>
    </>
  )
}
