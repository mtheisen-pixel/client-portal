// Hands an SEO Audit crawl off to the Audit app's seo_studio review
// pipeline (POST /api/seo-studio/create-report there) once the crawl's
// Research document(s) are already saved to portal_documents. This is what
// gives the SEO Audit an AI-draft -> human-review -> approve workflow
// instead of the old straight-to-portal_documents, no-review behavior —
// see website-audit.ts (Light tier) and
// website-audit-performance-background.ts (Comprehensive tier, called
// after its own doc is saved or its PSI check fails).
//
// This call rides inside website-audit.ts's synchronous ~30s Netlify budget
// for the Light tier, so a slow/unreachable Audit app must still degrade to
// a thrown error (caller turns that into a non-fatal `handoffError`) rather
// than risk timing out the whole crawl request — hence a timeout at all,
// rather than just letting fetch wait indefinitely.
//
// 11s, not 5s: create-report's own work is 7-8 fully sequential Supabase
// PostgREST round trips (one more on a brand-new, not-yet-linked client —
// see its own comments), plus whatever a cold Next.js instance adds on top.
// 5s was too tight for that combination in practice (confirmed on a real
// client) even though nothing had actually gone wrong.
const HANDOFF_TIMEOUT_MS = 11000

export interface SeoStudioHandoffParams {
  portalClientId: string
  clientName: string
  auditDepth: 'light' | 'comprehensive'
  performanceData: 'included' | 'missing'
  researchDocumentIds: string[]
}

export interface SeoStudioHandoffResult {
  reportId: string
  reviewUrl: string
  clientCreated: boolean
}

function postCreateReport(baseUrl: string, secret: string, params: SeoStudioHandoffParams): Promise<Response> {
  return fetch(`${baseUrl.replace(/\/$/, '')}/api/seo-studio/create-report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
    body: JSON.stringify({
      portal_client_id: params.portalClientId,
      client_name: params.clientName,
      audit_depth: params.auditDepth,
      performance_data: params.performanceData,
      submitted_by: 'client-portal',
      research_document_ids: params.researchDocumentIds,
    }),
    signal: AbortSignal.timeout(HANDOFF_TIMEOUT_MS),
  })
}

export async function createSeoStudioReport(params: SeoStudioHandoffParams): Promise<SeoStudioHandoffResult> {
  const baseUrl = process.env.AUDIT_APP_BASE_URL
  const secret = process.env.SEO_STUDIO_HANDOFF_SECRET
  if (!baseUrl || !secret) {
    throw new Error('AUDIT_APP_BASE_URL / SEO_STUDIO_HANDOFF_SECRET are not configured on this Netlify site.')
  }

  let res: Response
  try {
    res = await postCreateReport(baseUrl, secret, params)
  } catch (err) {
    // One retry, only for our own AbortSignal.timeout firing (name
    // "TimeoutError") — not a generic network failure (DNS, connection
    // refused, TLS error), which won't resolve itself on an identical
    // second attempt. This is safe specifically because create-report is
    // idempotent per (client, research_document_ids) on the Audit app side:
    // aborting our fetch doesn't cancel ITS request, which keeps running
    // and, confirmed on a real client, can go on to succeed several seconds
    // after we stop waiting — so a retry here finds the already-created
    // report and returns it rather than creating a duplicate.
    if (err instanceof Error && err.name === 'TimeoutError') {
      try {
        res = await postCreateReport(baseUrl, secret, params)
      } catch (retryErr) {
        throw new Error(
          `Could not reach the Audit app: ${retryErr instanceof Error ? retryErr.message : 'request failed'}.`,
        )
      }
    } else {
      throw new Error(`Could not reach the Audit app: ${err instanceof Error ? err.message : 'request failed'}.`)
    }
  }

  const data = await res.json().catch(() => null)
  if (!res.ok) {
    throw new Error((data as { error?: string } | null)?.error ?? `Audit app handoff failed (HTTP ${res.status}).`)
  }

  return {
    reportId: data.reportId,
    reviewUrl: data.reviewUrl,
    clientCreated: Boolean(data.client_created),
  }
}
