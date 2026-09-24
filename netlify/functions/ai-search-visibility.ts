import type { Handler } from '@netlify/functions'
import { createClient } from '@supabase/supabase-js'
import { authorizeAdminRequest } from './lib/auth'

// AI Search Visibility Audit — the Admin page's one-click entry point.
// Unlike the SEO Audit (crawled here, then handed off), the work runs in
// the Audit app's AI Visibility Query Runner (a GitHub Actions job), so
// this function only proxies three small calls to the Audit app's
// /api/ai-search-visibility/* routes, behind the same admin password as
// every other admin function and the same shared secret as the SEO Audit
// handoff (see lib/seo-studio-handoff.ts):
//
//   preflight → readiness + rough cost estimate, shown for confirmation
//   start     → queue the batch and start the job (only after confirming)
//   status    → progress poll, and the review link once the report exists

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
)

const TIMEOUT_MS = 15000

function json(statusCode: number, payload: unknown) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }
}

async function callAuditApp(path: 'preflight' | 'start' | 'status', body: Record<string, unknown>) {
  const baseUrl = process.env.AUDIT_APP_BASE_URL
  const secret = process.env.SEO_STUDIO_HANDOFF_SECRET
  if (!baseUrl || !secret) {
    throw new Error('AUDIT_APP_BASE_URL / SEO_STUDIO_HANDOFF_SECRET are not configured on this Netlify site.')
  }
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/ai-search-visibility/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const text = await res.text()
  let data: unknown = null
  try {
    data = JSON.parse(text)
  } catch {
    // Not JSON — e.g. a platform error page, or AUDIT_APP_BASE_URL pointing
    // at a deploy without these routes (its login redirect answers instead).
    // Say which host answered and what it said, so that's visible at once.
    data = {
      error: `Audit app at ${new URL(baseUrl).host} returned HTTP ${res.status} (not JSON): ${text
        .replace(/\s+/g, ' ')
        .slice(0, 200)}`,
    }
  }
  return { status: res.status, data }
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

  const { action, clientId, tier, batchId } = body as {
    action?: string
    clientId?: string
    tier?: string
    batchId?: string
  }
  if (!clientId) return json(400, { error: 'clientId is required.' })

  try {
    let result: { status: number; data: unknown }
    if (action === 'preflight') {
      // The estimate depends on the tier (Light runs a capped, search-on-only
      // subset). Older callers without a tier get Comprehensive, the larger one.
      const preflightTier = tier === 'light' ? 'light' : 'comprehensive'
      result = await callAuditApp('preflight', { portal_client_id: clientId, tier: preflightTier })
    } else if (action === 'start') {
      if (tier !== 'light' && tier !== 'comprehensive') return json(400, { error: "tier must be 'light' or 'comprehensive'." })
      result = await callAuditApp('start', { portal_client_id: clientId, tier, requested_by: 'client-portal Admin' })
    } else if (action === 'status') {
      if (!batchId) return json(400, { error: 'batchId is required.' })
      result = await callAuditApp('status', { portal_client_id: clientId, batch_id: batchId })
    } else {
      return json(400, { error: 'Unknown action.' })
    }
    return json(result.status, result.data ?? { error: `Audit app returned HTTP ${result.status}.` })
  } catch (err) {
    return json(502, { error: `Could not reach the Audit app: ${err instanceof Error ? err.message : 'request failed'}.` })
  }
}
