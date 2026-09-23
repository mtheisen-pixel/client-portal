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

interface ClientRow {
  id: string
  company_name: string
  created_at: string
  logo_path: string | null
  archived_at?: string | null
}

// Batch-signs every client's logo_path in one storage call rather than one
// round-trip per row — logos live in the same private bucket as documents,
// so (like a document's own download URL) there's no public URL to just
// return as-is. Short-lived, same as get_download_url: long enough for an
// admin list to render, not worth persisting.
async function withLogoUrls<T extends ClientRow>(clients: T[]): Promise<(T & { logo_url: string | null })[]> {
  const paths = clients.map((c) => c.logo_path).filter((p): p is string => Boolean(p))
  if (paths.length === 0) {
    return clients.map((c) => ({ ...c, logo_url: null }))
  }

  const { data, error } = await supabaseAdmin.storage.from(BUCKET).createSignedUrls(paths, 300)
  if (error) throw error

  const urlByPath = new Map((data ?? []).map((d) => [d.path, d.signedUrl] as const))
  return clients.map((c) => ({
    ...c,
    logo_url: c.logo_path ? (urlByPath.get(c.logo_path) ?? null) : null,
  }))
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
          .select('id, company_name, created_at, logo_path, category, site_url')
          .is('archived_at', null)
          .order('company_name')
        if (error) throw error
        return json(200, { clients: await withLogoUrls(data ?? []) })
      }

      case 'list_archived_clients': {
        const { data, error } = await supabaseAdmin
          .from('portal_clients')
          .select('id, company_name, created_at, logo_path, archived_at, category, site_url')
          .not('archived_at', 'is', null)
          .order('archived_at', { ascending: false })
        if (error) throw error
        return json(200, { clients: await withLogoUrls(data ?? []) })
      }

      // Updates category/site_url on an existing client — the only other
      // place these get set is create_client, so this is what lets a
      // client created before these fields existed (or one where they
      // just weren't known yet) get them filled in later.
      case 'update_client_details': {
        const { clientId, category, siteUrl } = body as {
          clientId?: string
          category?: string | null
          siteUrl?: string | null
        }
        if (!clientId) return json(400, { error: 'clientId is required.' })

        const { error } = await supabaseAdmin
          .from('portal_clients')
          .update({ category: category || null, site_url: siteUrl || null })
          .eq('id', clientId)
        if (error) throw error
        return json(200, { ok: true })
      }

      // Lists the people who can log in for a client. auth.users isn't
      // exposed via PostgREST (not even to the service-role key), so each
      // row's email comes from a separate Admin Auth API call rather than
      // a join — fine at this scale, same "N+1 is acceptable here" posture
      // this codebase already takes elsewhere.
      case 'list_contacts': {
        const { clientId } = body as { clientId?: string }
        if (!clientId) return json(400, { error: 'clientId is required.' })

        const { data, error } = await supabaseAdmin
          .from('client_users')
          .select('id, user_id, name, role, created_at')
          .eq('client_id', clientId)
          .order('created_at')
        if (error) throw error

        const contacts = await Promise.all(
          (data ?? []).map(async (row) => {
            const { data: userData } = await supabaseAdmin.auth.admin.getUserById(row.user_id)
            return { ...row, email: userData.user?.email ?? null }
          }),
        )
        return json(200, { contacts })
      }

      // Adds an additional person who can log in for an EXISTING client.
      // Same two-piece shape as create_client's own user+row creation, just
      // without also creating the company row. If the client_users insert
      // fails (most likely: this email is already a contact somewhere
      // else, tripping the unique(user_id) constraint), the just-created
      // auth user is cleaned up rather than left as an orphaned account.
      case 'add_contact': {
        // contactPassword, not password -- call()'s wrapper always overwrites
        // a payload's own `password` field with the admin gate password (see
        // its doc comment), same reason create_client uses clientPassword.
        const { clientId, email, contactPassword, name, role } = body as {
          clientId?: string
          email?: string
          contactPassword?: string
          name?: string
          role?: string
        }
        if (!clientId || !email || !contactPassword) {
          return json(400, { error: 'clientId, email, and contactPassword are required.' })
        }

        const { data: userData, error: userError } = await supabaseAdmin.auth.admin.createUser({
          email,
          password: contactPassword,
          email_confirm: true,
        })
        if (userError) throw userError

        const { error: linkError } = await supabaseAdmin
          .from('client_users')
          .insert({ client_id: clientId, user_id: userData.user.id, name: name || null, role: role || null })
        if (linkError) {
          await supabaseAdmin.auth.admin.deleteUser(userData.user.id).catch(() => {
            // Best-effort — nothing left to do if cleanup itself fails.
          })
          throw linkError
        }

        return json(200, { ok: true })
      }

      // Revokes one person's access to a client — deletes only their
      // client_users membership row, never their underlying auth account
      // (they simply stop being anyone's contact; their login just no
      // longer resolves to a client under RLS).
      case 'remove_contact': {
        const { contactId } = body as { contactId?: string }
        if (!contactId) return json(400, { error: 'contactId is required.' })

        const { error } = await supabaseAdmin.from('client_users').delete().eq('id', contactId)
        if (error) throw error
        return json(200, { ok: true })
      }

      case 'archive_client': {
        const { clientId } = body as { clientId?: string }
        if (!clientId) return json(400, { error: 'clientId is required.' })

        const { error } = await supabaseAdmin
          .from('portal_clients')
          .update({ archived_at: new Date().toISOString() })
          .eq('id', clientId)
        if (error) throw error
        return json(200, { ok: true })
      }

      case 'unarchive_client': {
        const { clientId } = body as { clientId?: string }
        if (!clientId) return json(400, { error: 'clientId is required.' })

        const { error } = await supabaseAdmin
          .from('portal_clients')
          .update({ archived_at: null })
          .eq('id', clientId)
        if (error) throw error
        return json(200, { ok: true })
      }

      // Set (or clear, with logoPath: null) a client's logo. Two-step, like
      // document uploads: the browser already used create_upload_url +
      // uploadToSignedUrl to put the file in storage, and this just records
      // where it landed. Kept separate from create_client because the
      // client's id (used as the upload path prefix) doesn't exist until
      // create_client returns.
      case 'set_client_logo': {
        const { clientId, logoPath } = body as { clientId?: string; logoPath?: string | null }
        if (!clientId) return json(400, { error: 'clientId is required.' })

        const { error } = await supabaseAdmin
          .from('portal_clients')
          .update({ logo_path: logoPath ?? null })
          .eq('id', clientId)
        if (error) throw error
        return json(200, { ok: true })
      }

      case 'create_client': {
        const { email, clientPassword, companyName, contactName, contactRole, category, siteUrl } = body as {
          email?: string
          clientPassword?: string
          companyName?: string
          contactName?: string
          contactRole?: string
          category?: string | null
          siteUrl?: string | null
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
          .insert({
            id: userData.user.id,
            company_name: companyName,
            category: category || null,
            site_url: siteUrl || null,
          })
        if (clientError) throw clientError

        const { error: contactError } = await supabaseAdmin
          .from('client_users')
          .insert({
            client_id: userData.user.id,
            user_id: userData.user.id,
            name: contactName || null,
            role: contactRole || 'Primary Contact',
          })
        if (contactError) throw contactError

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
