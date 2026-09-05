import type { Handler } from '@netlify/functions'
import { createClient } from '@supabase/supabase-js'
import { authorizeAdminRequest } from './lib/auth'
import { runPageSpeedInsights, buildPageSpeedMarkdown } from './lib/pagespeed'

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

  const { error: insertError } = await supabaseAdmin.from('portal_documents').insert({
    client_id: clientId,
    title,
    description,
    category: 'Research',
    file_path: path,
    sort_order: 0,
    admin_only: adminOnly,
  })
  if (insertError) throw insertError
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

  const { clientId, url, competitorName } = body as {
    clientId?: string
    url?: string
    competitorName?: string
  }
  if (!clientId || !url) return { statusCode: 400, body: '' }

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

  try {
    const authError = await authorizeAdminRequest(supabaseAdmin, event, body.password)
    if (authError) throw new Error(authError.error)

    const result = await runPageSpeedInsights(url)
    const markdown = buildPageSpeedMarkdown(fullLabel, result)
    await saveDocument(
      clientId,
      title,
      `PageSpeed Insights (mobile) performance check for ${hostname}.`,
      `website-audit-technical-perf-${hostname}.md`,
      markdown,
      false,
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Performance check failed.'
    await saveDocument(
      clientId,
      title,
      message,
      `website-audit-technical-perf-${hostname}-error.md`,
      `# Performance check failed\n\n${message}`,
      true,
    ).catch(() => {
      // Nothing left to do if even the error marker fails to save — the
      // caller's poll will eventually give up with its own "still running,
      // check back" message rather than hang forever.
    })
  }

  return { statusCode: 202, body: '' }
}
