import type { Handler } from '@netlify/functions'
import { createClient } from '@supabase/supabase-js'
import { authorizeAdminRequest } from './lib/auth'
import { runPageSpeedInsights, buildPageSpeedMarkdown } from './lib/pagespeed'
import { createSeoStudioReport } from './lib/seo-studio-handoff'

// Background Function — Netlify's naming convention is a filename ending in
// "-background", which is all that's needed to get this treated specially:
// Netlify returns a 202 the instant it's invoked, then lets this code run
// for up to 15 minutes, completely decoupled from the ~30s ceiling every
// other function in this repo is bound by. Built specifically for the PSI/
// performance step — see pagespeed.ts's top-of-file comment for why pure
// timeout/scope tuning on a normal synchronous function never fully solved
// this (PSI's own response time has a real right tail that's outside this
// app's control).
//
// The trade-off: since the 202 fires before this handler even starts, there
// is no way to return a result — success, failure, or a validation error —
// to the original HTTP caller. Everything gets communicated the only way a
// background job in this app can: as a portal_documents row, exactly like
// the synchronous version always produced on success, PLUS a new failure
// path that didn't need to exist before (a synchronous function could just
// return a 4xx/5xx). On failure, this saves an admin_only marker document
// under the *same* title the success path would have used, with the error
// message in its description. Admin.tsx polls list_documents for that exact
// title and distinguishes "still running" (nothing yet) / "failed"
// (admin_only doc) / "succeeded" (normal doc) — see pollForDocument there.
//
// Deliberately NOT shared with website-audit.ts's own supabaseAdmin/BUCKET/
// sanitizeFilename/saveDocument — every function in this repo already
// duplicates these few lines rather than importing them from a sibling
// function file (see admin.ts), since each is bundled independently by
// esbuild. Consistent with that, not a DRY gap.

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
)

const BUCKET = 'client-documents'

function sanitizeFilename(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_')
}

async function saveDocument(
  clientId: string,
  title: string,
  description: string,
  filename: string,
  content: string,
  adminOnly: boolean,
) {
  const path = `${clientId}/${Date.now()}-${sanitizeFilename(filename)}`
  const { error: uploadError } = await supabaseAdmin.storage
    .from(BUCKET)
    // Explicit charset — without it, a browser/tool viewing the raw file has
    // to guess the encoding, and content with non-ASCII punctuation (an em
    // dash in an error message, for instance) can come back double-decoded
    // as mojibake (e.g. "—" showing as "â€”") even though the bytes uploaded
    // here are correctly UTF-8.
    .upload(path, Buffer.from(content, 'utf-8'), { contentType: 'text/markdown; charset=utf-8' })
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
      admin_only: adminOnly,
    })
    .select()
    .single()
  if (insertError) throw insertError
  return data
}

/**
 * Appends a line to an already-saved document's description — used to
 * attach the Audit app's review-report link once the handoff completes,
 * since that can only happen after the document (and its id) already
 * exist. Best-effort: Admin.tsx's poll already found the document by the
 * time this typically lands, and its own short secondary poll (see
 * Admin.tsx's pollForReviewUrl) tolerates the update arriving a few
 * seconds after the document itself does.
 */
async function appendToDescription(documentId: string, extraLine: string) {
  const { data } = await supabaseAdmin.from('portal_documents').select('description').eq('id', documentId).single()
  const current = (data?.description as string | undefined) ?? ''
  await supabaseAdmin
    .from('portal_documents')
    .update({ description: `${current}\n\n${extraLine}` })
    .eq('id', documentId)
}

export const handler: Handler = async (event) => {
  // Netlify has already sent its 202 by the time this runs, so nothing
  // returned from here reaches the original caller — these early returns
  // just stop execution cleanly for a malformed/non-POST request that
  // shouldn't occur from the Admin.tsx UI, which always sends a full body.
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '' }

  let body: Record<string, unknown>
  try {
    body = JSON.parse(event.body ?? '{}')
  } catch {
    return { statusCode: 400, body: '' }
  }

  const { clientId, url, competitorName, technicalDocumentId } = body as {
    clientId?: string
    url?: string
    competitorName?: string
    technicalDocumentId?: string
  }
  if (!clientId || !url) return { statusCode: 400, body: '' }
  const resolvedClientId: string = clientId

  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    return { statusCode: 400, body: '' }
  }

  // Mirrors the label computation in website-audit.ts (small and stable
  // enough that duplicating it here is simpler than sharing it, matching
  // this repo's per-function self-containment convention).
  const trimmedCompetitorName = typeof competitorName === 'string' ? competitorName.trim() : ''
  const auditKindLabel = trimmedCompetitorName ? `Competitor Audit — ${trimmedCompetitorName}` : 'Website Audit'
  const fullLabel = `${auditKindLabel} (Technical)`
  const today = new Date().toISOString().slice(0, 10)
  const title = `${fullLabel} — ${hostname} — Performance — ${today}`

  // This function only ever runs for the Comprehensive SEO Audit tier —
  // Admin.tsx only calls startPerformanceCheck when depth === 'comprehensive'
  // — so the handoff below always reports audit_depth: 'comprehensive'.
  async function handOffToAuditApp(researchDocumentIds: string[], performanceData: 'included' | 'missing') {
    if (researchDocumentIds.length === 0) return null
    const { data: portalClient } = await supabaseAdmin
      .from('portal_clients')
      .select('company_name')
      .eq('id', resolvedClientId)
      .single()
    return createSeoStudioReport({
      portalClientId: resolvedClientId,
      clientName: (portalClient?.company_name as string | undefined) ?? hostname,
      auditDepth: 'comprehensive',
      performanceData,
      researchDocumentIds,
    })
  }

  try {
    const authError = await authorizeAdminRequest(supabaseAdmin, event, body.password)
    if (authError) throw new Error(authError.error)

    const result = await runPageSpeedInsights(url)
    const markdown = buildPageSpeedMarkdown(fullLabel, result)
    const perfDoc = await saveDocument(
      clientId,
      title,
      `PageSpeed Insights (mobile) performance check for ${hostname}.`,
      `website-audit-technical-perf-${hostname}.md`,
      markdown,
      false,
    )

    const docIds = [technicalDocumentId, perfDoc?.id as string | undefined].filter(
      (id): id is string => Boolean(id),
    )
    try {
      const handoff = await handOffToAuditApp(docIds, 'included')
      if (handoff && perfDoc?.id) {
        await appendToDescription(perfDoc.id as string, `Review & approve: ${handoff.reviewUrl}`)
      }
    } catch (handoffErr) {
      // The crawl + performance data is already saved either way — a
      // failed handoff shouldn't look like a failed performance check. Flag
      // it as its own, separately-titled marker doc so staff can notice and
      // retry without it interfering with Admin.tsx's exact-title poll for
      // the performance doc itself.
      const handoffMessage = handoffErr instanceof Error ? handoffErr.message : 'Failed to create a review report in the Audit app.'
      await saveDocument(
        clientId,
        `${title} — Review Handoff Failed`,
        handoffMessage,
        `website-audit-technical-perf-${hostname}-handoff-error.md`,
        `# Could not create a review report\n\n${handoffMessage}`,
        true,
      ).catch(() => {})
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Performance check failed.'

    // Per design: don't let a PSI failure block the review workflow — hand
    // off with just the technical document, flagging performance data as
    // missing, so the SEO studio's report still gets drafted instead of
    // nothing at all. The PSI failure itself is still recorded below as the
    // usual admin_only error-marker document.
    let handoffNote = ''
    if (technicalDocumentId) {
      try {
        const handoff = await handOffToAuditApp([technicalDocumentId], 'missing')
        if (handoff) {
          handoffNote = `\n\nA review report was still created without performance data: ${handoff.reviewUrl}`
        }
      } catch (handoffErr) {
        const handoffMessage = handoffErr instanceof Error ? handoffErr.message : 'unknown error'
        handoffNote = `\n\nAdditionally, a review report could not be created: ${handoffMessage}`
      }
    }

    await saveDocument(
      clientId,
      title,
      `${message}${handoffNote}`,
      `website-audit-technical-perf-${hostname}-error.md`,
      `# Performance check failed\n\n${message}${handoffNote}`,
      true,
    ).catch(() => {
      // Nothing left to do if even the error marker fails to save — the
      // caller's poll will eventually give up with its own "still running,
      // check back" message rather than hang forever.
    })
  }

  return { statusCode: 202, body: '' }
}
