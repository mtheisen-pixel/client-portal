import type { Handler } from '@netlify/functions'
import { createClient } from '@supabase/supabase-js'
import { authorizeAdminRequest } from './lib/auth'
import { runWebsiteAudit } from './lib/site-audit'

// Dedicated function rather than a new action on admin.ts: a crawl can take
// meaningfully longer than admin.ts's other operations (list/create/delete,
// all near-instant Supabase calls), so an audit that runs long or fails
// can't affect the reliability of those. Shares admin.ts's password/lockout
// gate via lib/auth.ts.
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
)

const BUCKET = 'client-documents'

function sanitizeFilename(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_')
}

function json(statusCode: number, payload: unknown) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' }
  }

  let body: Record<string, unknown>
  try {
    body = JSON.parse(event.body ?? '{}')
  } catch {
    return json(400, { error: 'Invalid JSON' })
  }

  const authError = await authorizeAdminRequest(supabaseAdmin, event, body.password)
  if (authError) return json(authError.statusCode, { error: authError.error })

  const { clientId, url } = body as { clientId?: string; url?: string }
  if (!clientId || !url) {
    return json(400, { error: 'clientId and url are required.' })
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') throw new Error('not http(s)')
  } catch {
    return json(400, { error: 'That doesn’t look like a valid http(s) URL.' })
  }

  try {
    if (!process.env.BROWSERLESS_API_KEY) {
      return json(500, {
        error: 'BROWSERLESS_API_KEY is not set on this Netlify site — website audits need it configured before they can run.',
      })
    }

    const result = await runWebsiteAudit(parsedUrl.toString(), parsedUrl.hostname)
    const today = new Date().toISOString().slice(0, 10)
    const createdDocuments = []

    const markdownPath = `${clientId}/${Date.now()}-${sanitizeFilename(`website-audit-${result.hostname}.md`)}`
    const { error: mdUploadError } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(markdownPath, Buffer.from(result.markdown, 'utf-8'), { contentType: 'text/markdown' })
    if (mdUploadError) throw mdUploadError

    const { data: mdDoc, error: mdInsertError } = await supabaseAdmin
      .from('portal_documents')
      .insert({
        client_id: clientId,
        title: `Website Audit — ${result.hostname} — ${today}`,
        description: `Automated crawl of ${result.pagesCrawled} page(s) on ${result.hostname}.`,
        category: 'Research',
        file_path: markdownPath,
        sort_order: 0,
        admin_only: false,
      })
      .select()
      .single()
    if (mdInsertError) throw mdInsertError
    createdDocuments.push(mdDoc)

    for (const shot of result.screenshots) {
      const screenshotPath = `${clientId}/${Date.now()}-${sanitizeFilename(`website-audit-${result.hostname}-${shot.pageTitle}.png`)}`
      const { error: shotUploadError } = await supabaseAdmin.storage
        .from(BUCKET)
        .upload(screenshotPath, shot.png, { contentType: 'image/png' })
      if (shotUploadError) throw shotUploadError

      const { data: shotDoc, error: shotInsertError } = await supabaseAdmin
        .from('portal_documents')
        .insert({
          client_id: clientId,
          title: `Website Audit — ${result.hostname} — ${shot.pageTitle} screenshot`,
          description: `Screenshot captured from ${shot.pageUrl}.`,
          category: 'Research',
          file_path: screenshotPath,
          sort_order: 0,
          admin_only: false,
        })
        .select()
        .single()
      if (shotInsertError) throw shotInsertError
      createdDocuments.push(shotDoc)
    }

    return json(200, { documents: createdDocuments, pagesCrawled: result.pagesCrawled })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Website audit failed.'
    return json(502, { error: message })
  }
}
