import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { Logo } from '../components/Logo'

type Status = 'checking' | 'ready' | 'invalid'

export function ResetPassword() {
  const navigate = useNavigate()
  const [status, setStatus] = useState<Status>('checking')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    let cancelled = false

    // Supabase parses the recovery link's URL fragment/code on load and
    // emits this event once the recovery session is established.
    const { data: listener } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY' && !cancelled) setStatus('ready')
    })

    supabase.auth.getSession().then(({ data }) => {
      if (!cancelled && data.session) setStatus('ready')
    })

    // If neither fires quickly, the link is missing, malformed, or expired.
    const timeout = setTimeout(() => {
      if (!cancelled) setStatus((current) => (current === 'checking' ? 'invalid' : current))
    }, 3000)

    return () => {
      cancelled = true
      listener.subscription.unsubscribe()
      clearTimeout(timeout)
    }
  }, [])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (status !== 'ready') return
    setError(null)

    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    setSubmitting(true)
    const { error: updateError } = await supabase.auth.updateUser({ password: newPassword })

    if (updateError) {
      setSubmitting(false)
      setError(updateError.message)
      return
    }

    await supabase.auth.signOut()
    navigate('/login', {
      replace: true,
      state: { message: 'Password updated. Sign in with your new password.' },
    })
  }

  return (
    <div className="page-center">
      <Logo large />
      <form className="card" onSubmit={handleSubmit}>
        <span className="eyebrow">Client Portal</span>
        <h1>Set a new password</h1>

        {status === 'checking' && <p className="muted">Verifying your reset link…</p>}

        {status === 'invalid' && (
          <>
            <p className="error">
              This password reset link is invalid or has expired. Request a new one from the sign-in
              page.
            </p>
            <button type="button" onClick={() => navigate('/login')}>
              Back to sign in
            </button>
          </>
        )}

        {status === 'ready' && (
          <>
            <label htmlFor="newPassword">New password</label>
            <input
              id="newPassword"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
            />

            <label htmlFor="confirmPassword">Confirm password</label>
            <input
              id="confirmPassword"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
            />

            {error && <p className="error">{error}</p>}

            <button type="submit" disabled={submitting}>
              {submitting ? 'Updating…' : 'Update password'}
            </button>
          </>
        )}
      </form>
    </div>
  )
}
