import type { Handler } from '@netlify/functions'
import { createClient } from '@supabase/supabase-js'
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
