import type { Handler, HandlerEvent } from '@netlify/functions'
import { createClient } from '@supabase/supabase-js'
import { timingSafeEqual } from 'node:crypto'

// This function is the only place the service_role key is used. It bypasses
// Row Level Security entirely, so every request must present the shared
// admin password below before touching Supabase. Never ship this key to
// the browser.
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
)

const BUCKET = 'client-documents'
const MAX_FAILED_ATTEMPTS = 5
const LOCKOUT_MS = 15 * 60 * 1000

function checkPassword(candidate: unknown): candidate is string {
  // .trim() guards against a trailing newline/space in the env var value,
  // a common artifact of pasting into Netlify's env var UI, which would
  // otherwise make a correct-looking password fail with no visible cause.
  const expected = (process.env.ADMIN_PASSWORD ?? '').trim()
  if (typeof candidate !== 'string' || !expected) return false

  const a = Buffer.from(candidate)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function sanitizeFilename(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_')
}

function getClientIp(event: HandlerEvent): string {
  const headers = event.headers ?? {}
  const direct = headers['x-nf-client-connection-ip'] ?? headers['client-ip']
  if (direct) return direct
  const forwarded = headers['x-forwarded-for']
  if (forwarded) return forwarded.split(',')[0].trim()
  return 'unknown'
}

interface Lockout {
  failed_count: number
  locked_until: string | null
}

async function getLockout(ip: string): Promise<Lockout | null> {
  const { data } = await supabaseAdmin
    .from('admin_lockouts')
    .select('failed_count, locked_until')
    .eq('ip', ip)
    .maybeSingle()
  return data
}

async function recordFailedAttempt(ip: string, existing: Lockout | null) {
  const lockoutExpired = existing?.locked_until && new Date(existing.locked_until) <= new Date()
  const failedCount = !existing || lockoutExpired ? 1 : existing.failed_count + 1
  const lockedUntil =
    failedCount >= MAX_FAILED_ATTEMPTS ? new Date(Date.now() + LOCKOUT_MS).toISOString() : null

  await supabaseAdmin.from('admin_lockouts').upsert({
    ip,
    failed_count: failedCount,
    locked_until: lockedUntil,
    updated_at: new Date().toISOString(),
  })
}

async function clearLockout(ip: string) {
  await supabaseAdmin.from('admin_lockouts').delete().eq('ip', ip)
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

  const ip = getClientIp(event)
  const lockout = await getLockout(ip)

  if (lockout?.locked_until && new Date(lockout.locked_until) > new Date()) {
    const minutesLeft = Math.ceil((new Date(lockout.locked_until).getTime() - Date.now()) / 60000)
    return json(429, {
      error: `Too many failed attempts. Try again in ${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}.`,
    })
  }

  if (!checkPassword(body.password)) {
    await recordFailedAttempt(ip, lockout)
    return json(401, { error: 'Incorrect admin password.' })
  }

  await clearLockout(ip)

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
