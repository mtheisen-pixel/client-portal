import type { Handler } from '@netlify/functions'
import { createClient } from '@supabase/supabase-js'
import { authorizeAdminRequest } from './lib/auth'
import { discoverPages, runWebsiteAudit } from './lib/site-audit'
import { runTechnicalAuditFast } from './lib/technical-audit'
import { runPageSpeedInsights, buildPageSpeedMarkdown } from './lib/pagespeed'

// Dedicated function rather than a new action on admin.ts: a crawl can take
// meaningfully longer than admin.ts's other operations (list/create/delete,
// all near-instant Supabase calls), so an audit that runs long or fails
// can't affect the reliability of those. Shares admin.ts's password/lockout
// gate via lib/auth.ts.
//
// Three request shapes, distinguished by auditType/step:
// - auditType 'creative' (default): the original crawl — page copy, colors/
//   fonts, screenshots, perceived-tone analysis. One document + screenshots.
// - auditType 'technical', step 'fast' (default for 'technical'): meta/
//   structure/schema/hygiene/AI-visibility checks, all plain-HTTP. One
//   document.
// - auditType 'technical', step 'performance': Core Web Vitals via Google
//   PageSpeed Insights. Deliberately its OWN request, not folded into the
//   'fast' step above — PSI commonly takes 15-30+ seconds on its own,
//   which risks the ~30s Netlify limit by itself. The Admin.tsx UI fires
//   these as two sequential calls from one "Run Website Audit" click.
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

async function saveDocument(clientId: string, title: string, description: string, filename: string, content: string) {
  const path = `${clientId}/${Date.now()}-${sanitizeFilename(filename)}`
  const { error: uploadError } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(path, Buffer.from(content, 'utf-8'), { contentType: 'text/markdown' })
  if (uploadError) throw uploadError

  const { data, error: insertError } = await supabaseAdmin
    .from('portal_documents')
    .insert({
      client_id: clientId,
      title,
      description,
      category: 'Research',
      file_path: path,
      sort_order: 0,
      admin_only: false,
    })
    .select()
    .single()
  if (insertError) throw insertError
  return data
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

  const { clientId, url, competitorName, auditType, step } = body as {
    clientId?: string
    url?: string
    competitorName?: string
    auditType?: 'creative' | 'technical'
    step?: 'fast' | 'performance'
  }
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

  // A non-empty competitorName is what distinguishes this from a client's
  // own site audit — same crawl, same document category and storage
  // pattern, just tagged and titled differently so Findings' citation
  // extraction can tell "your own site" apart from "a named competitor's
  // site" (source_type "website_audit"/"website_audit_technical" vs
  // "competitor_audit"/"competitor_audit_technical" — see
  // FINDINGS_EVIDENCE_SYSTEM_PROMPT in the audit repo).
  const trimmedCompetitorName = typeof competitorName === 'string' ? competitorName.trim() : ''
  const isCompetitor = trimmedCompetitorName.length > 0
  const auditKindLabel = isCompetitor ? `Competitor Audit — ${trimmedCompetitorName}` : 'Website Audit'
  const isTechnical = auditType === 'technical'
  const fullLabel = isTechnical ? `${auditKindLabel} (Technical)` : auditKindLabel
  const today = new Date().toISOString().slice(0, 10)

  try {
    if (isTechnical && step === 'performance') {
      const result = await runPageSpeedInsights(parsedUrl.toString())
      const markdown = buildPageSpeedMarkdown(fullLabel, result)
      const doc = await saveDocument(
        clientId,
        `${fullLabel} — ${parsedUrl.hostname} — Performance — ${today}`,
        `PageSpeed Insights performance/accessibility check for ${parsedUrl.hostname}.`,
        `website-audit-technical-perf-${parsedUrl.hostname}.md`,
        markdown
      )
      return json(200, { documents: [doc], pagesCrawled: 1 })
    }

    if (isTechnical) {
      const discovered = await discoverPages(parsedUrl.toString())
      const result = await runTechnicalAuditFast(parsedUrl.toString(), discovered)
      const doc = await saveDocument(
        clientId,
        `${fullLabel} — ${result.hostname} — ${today}`,
        isCompetitor
          ? `Automated technical check of ${result.pagesCrawled} page(s) on ${result.hostname}, added as competitor "${trimmedCompetitorName}".`
          : `Automated technical check of ${result.pagesCrawled} page(s) on ${result.hostname}.`,
        `website-audit-technical-${result.hostname}.md`,
        result.markdown
      )
      return json(200, { documents: [doc], pagesCrawled: result.pagesCrawled })
    }

    if (!process.env.BROWSERLESS_API_KEY) {
      return json(500, {
        error: 'BROWSERLESS_API_KEY is not set on this Netlify site — Creative Audits need it configured before they can run.',
      })
    }

    const result = await runWebsiteAudit(parsedUrl.toString(), `${fullLabel} — ${parsedUrl.hostname}`)
    const createdDocuments = []

    const mdDoc = await saveDocument(
      clientId,
      `${fullLabel} — ${result.hostname} — ${today}`,
      isCompetitor
        ? `Automated crawl of ${result.pagesCrawled} page(s) on ${result.hostname}, added as competitor "${trimmedCompetitorName}".`
        : `Automated crawl of ${result.pagesCrawled} page(s) on ${result.hostname}.`,
      `website-audit-${result.hostname}.md`,
      result.markdown
    )
    createdDocuments.push(mdDoc)

    // Uploaded in parallel rather than one at a time — with a tight overall
    // request budget (see the timeout note in site-audit.ts), a sequential
    // loop over even 2-3 screenshots was real, avoidable time on top of the
    // page renders that already ate most of the budget.
    const shotDocs = await Promise.all(
      result.screenshots.map(async (shot) => {
        const screenshotPath = `${clientId}/${Date.now()}-${sanitizeFilename(`website-audit-${result.hostname}-${shot.pageTitle}.png`)}`
        const { error: shotUploadError } = await supabaseAdmin.storage
          .from(BUCKET)
          .upload(screenshotPath, shot.png, { contentType: 'image/png' })
        if (shotUploadError) throw shotUploadError

        const { data: shotDoc, error: shotInsertError } = await supabaseAdmin
          .from('portal_documents')
          .insert({
            client_id: clientId,
            title: `${fullLabel} — ${result.hostname} — ${shot.pageTitle} screenshot`,
            description: `Screenshot captured from ${shot.pageUrl}.`,
            category: 'Research',
            file_path: screenshotPath,
            sort_order: 0,
            admin_only: false,
          })
          .select()
          .single()
        if (shotInsertError) throw shotInsertError
        return shotDoc
      })
    )
    createdDocuments.push(...shotDocs)

    return json(200, { documents: createdDocuments, pagesCrawled: result.pagesCrawled })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Website audit failed.'
    return json(502, { error: message })
  }
}
