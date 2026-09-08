import type { Handler } from '@netlify/functions'
import { createClient } from '@supabase/supabase-js'
import { marked } from 'marked'
import { authorizeAdminRequest } from './lib/auth'

// This function is the only place the service_role key is used. It bypasses
// Row Level Security entirely, so every request must present the shared
// admin password below before touching Supabase. Never ship this key to
// the browser.
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
)

const BUCKET = 'client-documents'

function sanitizeFilename(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_')
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' }
  }

  let body: Record<string, unknown>
  try {
    body = JSON.parse(event.body ?? '{}')
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' }
  }

  const authError = await authorizeAdminRequest(supabaseAdmin, event, body.password)
  if (authError) return json(authError.statusCode, { error: authError.error })

  const action = body.action

  try {
    switch (action) {
      case 'list_clients': {
        const { data, error } = await supabaseAdmin
          .from('portal_clients')
          .select('id, company_name, created_at')
          .order('company_name')
        if (error) throw error
        return json(200, { clients: data })
      }

      case 'create_client': {
        const { email, clientPassword, companyName } = body as {
          email?: string
          clientPassword?: string
          companyName?: string
        }
        if (!email || !clientPassword || !companyName) {
          return json(400, { error: 'email, clientPassword, and companyName are required.' })
        }

        const { data: userData, error: userError } = await supabaseAdmin.auth.admin.createUser({
          email,
          password: clientPassword,
          email_confirm: true,
        })
        if (userError) throw userError

        const { error: clientError } = await supabaseAdmin
          .from('portal_clients')
          .insert({ id: userData.user.id, company_name: companyName })
        if (clientError) throw clientError

        return json(200, { client: { id: userData.user.id, company_name: companyName } })
      }

      case 'list_documents': {
        const { clientId } = body as { clientId?: string }
        if (!clientId) return json(400, { error: 'clientId is required.' })

        const { data, error } = await supabaseAdmin
          .from('portal_documents')
          .select('*')
          .eq('client_id', clientId)
          .order('sort_order')
        if (error) throw error
        return json(200, { documents: data })
      }

      case 'create_upload_url': {
        const { clientId, filename } = body as { clientId?: string; filename?: string }
        if (!clientId || !filename) {
          return json(400, { error: 'clientId and filename are required.' })
        }

        const path = `${clientId}/${Date.now()}-${sanitizeFilename(filename)}`
        const { data, error } = await supabaseAdmin.storage
          .from(BUCKET)
          .createSignedUploadUrl(path)
        if (error) throw error

        return json(200, { path, token: data.token })
      }

      case 'create_document': {
        const { clientId, title, description, category, filePath, sortOrder, adminOnly } = body as {
          clientId?: string
          title?: string
          description?: string | null
          category?: string | null
          filePath?: string
          sortOrder?: number
          adminOnly?: boolean
        }
        if (!clientId || !title || !filePath) {
          return json(400, { error: 'clientId, title, and filePath are required.' })
        }

        const { data, error } = await supabaseAdmin
          .from('portal_documents')
          .insert({
            client_id: clientId,
            title,
            description: description ?? null,
            category: category ?? null,
            file_path: filePath,
            sort_order: sortOrder ?? 0,
            admin_only: adminOnly ?? false,
          })
          .select()
          .single()
        if (error) throw error
        return json(200, { document: data })
      }

      case 'get_download_url': {
        const { filePath } = body as { filePath?: string }
        if (!filePath) return json(400, { error: 'filePath is required.' })

        // Short-lived (documents live in a private bucket, so there's no
        // public URL to just click) — long enough to open in a new tab,
        // short enough that the URL isn't worth persisting anywhere.
        const { data, error } = await supabaseAdmin.storage
          .from(BUCKET)
          .createSignedUrl(filePath, 300)
        if (error) throw error

        return json(200, { url: data.signedUrl })
      }

      case 'get_document_pdf': {
        // Converts a stored Research document to a downloadable PDF instead
        // of only being viewable as raw text via get_download_url above —
        // these documents (competitor/website audit creative and technical
        // crawls) are always stored as plain Markdown (see
        // website-audit.ts's `.md` uploads), so this only ever makes sense
        // for that file type; Admin.tsx gates the button on file_path
        // ending in .md for the same reason. Reuses the audit app's own
        // DocRaptor pattern (see its api/reports/[id]/pdf/route.tsx) rather
        // than an in-process PDF library, for the same reason that file
        // documents: native/WASM PDF-rendering dependencies inside a
        // Netlify Function bundle have caused real problems before.
        const { filePath, title } = body as { filePath?: string; title?: string }
        if (!filePath) return json(400, { error: 'filePath is required.' })

        const { data: fileData, error: downloadError } = await supabaseAdmin.storage
          .from(BUCKET)
          .download(filePath)
        if (downloadError) throw downloadError

        const markdown = await fileData.text()
        const bodyHtml = marked.parse(markdown, { async: false })
        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
          body { font-family: -apple-system, Helvetica, Arial, sans-serif; line-height: 1.5; padding: 40px; color: #1a1a1a; max-width: 720px; margin: 0 auto; }
          h1, h2, h3 { color: #0f172a; }
          pre, code { background: #f1f5f9; padding: 2px 4px; border-radius: 4px; font-size: 0.9em; }
          table { border-collapse: collapse; width: 100%; }
          th, td { border: 1px solid #e2e8f0; padding: 6px 10px; text-align: left; }
        </style></head><body>${bodyHtml}</body></html>`

        const apiKey = process.env.DOCRAPTOR_API_KEY || 'YOUR_API_KEY_HERE'
        const isTestMode = !process.env.DOCRAPTOR_API_KEY
        const filenameStem = sanitizeFilename(title ?? 'document').replace(/\s+/g, '-').toLowerCase()

        const docraptorResponse = await fetch('https://api.docraptor.com/docs', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Basic ' + Buffer.from(`${apiKey}:`).toString('base64'),
          },
          body: JSON.stringify({
            type: 'pdf',
            document_content: html,
            test: isTestMode,
            name: `${filenameStem}.pdf`,
          }),
        })

        if (!docraptorResponse.ok) {
          const errorText = await docraptorResponse.text()
          throw new Error(`PDF generation failed: ${errorText}`)
        }

        const pdfArrayBuffer = await docraptorResponse.arrayBuffer()
        const pdfBase64 = Buffer.from(pdfArrayBuffer).toString('base64')

        return json(200, { pdfBase64, filename: `${filenameStem}.pdf` })
      }

      case 'delete_document': {
        const { documentId, filePath } = body as { documentId?: string; filePath?: string }
        if (!documentId || !filePath) {
          return json(400, { error: 'documentId and filePath are required.' })
        }

        const { error: storageError } = await supabaseAdmin.storage.from(BUCKET).remove([filePath])
        if (storageError) throw storageError

        const { error: dbError } = await supabaseAdmin
          .from('portal_documents')
          .delete()
          .eq('id', documentId)
        if (dbError) throw dbError

        return json(200, { ok: true })
      }

      default:
        return json(400, { error: `Unknown action: ${String(action)}` })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unexpected error'
    return json(500, { error: message })
  }
}

function json(statusCode: number, payload: unknown) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }
}
