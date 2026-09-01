import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../context/AuthContext'
import { SiteHeader } from '../components/SiteHeader'
import { CATEGORY_SECTION_ORDER } from '../lib/categories'

interface DocumentRow {
  id: string
  title: string
  description: string | null
  category: string | null
  file_path: string
  sort_order: number
  created_at: string
}

export function Documents() {
  const { session } = useAuth()
  const [companyName, setCompanyName] = useState<string | null>(null)
  const [docs, setDocs] = useState<DocumentRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)

      const [clientResult, docsResult] = await Promise.all([
        supabase.from('portal_clients').select('company_name').single(),
        supabase.from('portal_documents').select('*').order('sort_order'),
      ])

      if (cancelled) return

      if (clientResult.error) setError(clientResult.error.message)
      else setCompanyName(clientResult.data?.company_name ?? null)

      if (docsResult.error) setError(docsResult.error.message)
      else setDocs(docsResult.data ?? [])

      setLoading(false)
    }

    load()
    return () => {
      cancelled = true
    }
  }, [])

  async function handleDownload(doc: DocumentRow) {
    setDownloadingId(doc.id)
    const { data, error: downloadError } = await supabase.storage
      .from('client-documents')
      .download(doc.file_path)

    setDownloadingId(null)

    if (downloadError || !data) {
      setError(`Could not download "${doc.title}".`)
      return
    }

    const url = URL.createObjectURL(data)
    const a = document.createElement('a')
    a.href = url
    a.download = doc.file_path.split('/').pop() ?? doc.title
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  async function handleSignOut() {
    await supabase.auth.signOut()
  }

  return (
    <>
      <SiteHeader>
        <button type="button" className="secondary" onClick={handleSignOut}>
          Sign out
        </button>
      </SiteHeader>

      <div className="page">
        <header className="topbar">
          <div>
            <span className="eyebrow">Client Portal</span>
            <h1>{companyName ?? 'Your Documents'}</h1>
            <p className="muted">{session?.user.email}</p>
          </div>
        </header>

        {error && <p className="error">{error}</p>}

        {loading ? (
          <p className="muted">Loading documents…</p>
        ) : docs.length === 0 ? (
          <p className="muted">No documents have been shared with you yet.</p>
        ) : (
          CATEGORY_SECTION_ORDER.map((category) => {
            const docsInCategory = docs
              .filter((doc) => doc.category === category)
              .sort((a, b) => a.sort_order - b.sort_order)

            if (docsInCategory.length === 0) return null

            return (
              <section key={category}>
                <h3>{category}</h3>
                <ul className="doc-list">
                  {docsInCategory.map((doc) => (
                    <li key={doc.id} className="doc-row">
                      <div>
                        <div className="doc-title">{doc.title}</div>
                        {doc.description && <p className="muted">{doc.description}</p>}
                      </div>
                      <button
                        type="button"
                        onClick={() => handleDownload(doc)}
                        disabled={downloadingId === doc.id}
                      >
                        {downloadingId === doc.id ? 'Downloading…' : 'Download'}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )
          })
        )}
      </div>
    </>
  )
}
