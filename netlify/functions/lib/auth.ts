import type { HandlerEvent } from '@netlify/functions'
import type { SupabaseClient } from '@supabase/supabase-js'
import { timingSafeEqual } from 'node:crypto'

// Shared by every admin-only Netlify function (admin.ts, website-audit.ts).
// Extracted so the password check and IP lockout bookkeeping can't drift
// between them — this is the only gate standing between the public internet
// and the service_role key, so it lives in exactly one place.

const MAX_FAILED_ATTEMPTS = 5
const LOCKOUT_MS = 15 * 60 * 1000

export function checkPassword(candidate: unknown): candidate is string {
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

export function getClientIp(event: HandlerEvent): string {
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

async function getLockout(supabaseAdmin: SupabaseClient, ip: string): Promise<Lockout | null> {
  const { data } = await supabaseAdmin
    .from('admin_lockouts')
    .select('failed_count, locked_until')
    .eq('ip', ip)
    .maybeSingle()
  return data
}

async function recordFailedAttempt(supabaseAdmin: SupabaseClient, ip: string, existing: Lockout | null) {
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

async function clearLockout(supabaseAdmin: SupabaseClient, ip: string) {
  await supabaseAdmin.from('admin_lockouts').delete().eq('ip', ip)
}

/**
 * Runs the full lockout-check -> password-check -> lockout-clear sequence
 * shared by every admin function. Returns an error string to send back to
 * the caller (with the right semantics: 429 while locked out, 401 on a bad
 * password) or null if the request is authorized to proceed.
 */
export async function authorizeAdminRequest(
  supabaseAdmin: SupabaseClient,
  event: HandlerEvent,
  password: unknown
): Promise<{ error: string; statusCode: number } | null> {
  const ip = getClientIp(event)
  const lockout = await getLockout(supabaseAdmin, ip)

  if (lockout?.locked_until && new Date(lockout.locked_until) > new Date()) {
    const minutesLeft = Math.ceil((new Date(lockout.locked_until).getTime() - Date.now()) / 60000)
    return {
      statusCode: 429,
      error: `Too many failed attempts. Try again in ${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}.`,
    }
  }

  if (!checkPassword(password)) {
    await recordFailedAttempt(supabaseAdmin, ip, lockout)
    return { statusCode: 401, error: 'Incorrect admin password.' }
  }

  await clearLockout(supabaseAdmin, ip)
  return null
}
