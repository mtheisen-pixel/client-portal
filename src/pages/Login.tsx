import { useState } from 'react'
import type { FormEvent } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../context/AuthContext'
import { Logo } from '../components/Logo'

const RESET_REDIRECT_URL = 'https://brandaifyclientportal.netlify.app/reset-password'

export function Login() {
  const { session, loading } = useAuth()
  const location = useLocation()
  const [mode, setMode] = useState<'signin' | 'reset'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [resetSent, setResetSent] = useState(false)

  if (!loading && session) return <Navigate to="/documents" replace />

  const confirmation = (location.state as { message?: string } | null)?.message ?? null

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)

    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password })

    setSubmitting(false)
    if (signInError) setError('Incorrect email or password.')
  }

  async function handleResetRequest(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)

    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: RESET_REDIRECT_URL,
    })

    setSubmitting(false)
    if (resetError) setError(resetError.message)
    else setResetSent(true)
  }

  function backToSignIn() {
    setMode('signin')
    setError(null)
    setResetSent(false)
  }

  if (mode === 'reset') {
    return (
      <div className="page-center">
        <Logo large />
        <form className="card" onSubmit={handleResetRequest}>
          <span className="eyebrow">Client Portal</span>
          <h1>Reset password</h1>

          {resetSent ? (
            <>
              <p className="success">
                If an account exists for that email, a reset link is on its way. Check your inbox.
              </p>
              <button type="button" className="secondary" onClick={backToSignIn}>
                Back to sign in
              </button>
            </>
          ) : (
            <>
              <p className="muted">Enter your email and we'll send you a reset link.</p>

              <label htmlFor="reset-email">Email</label>
              <input
                id="reset-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                autoFocus
                required
              />

              {error && <p className="error">{error}</p>}

              <button type="submit" disabled={submitting}>
                {submitting ? 'Sending…' : 'Send reset link'}
              </button>
              <button type="button" className="link-button" style={{ marginTop: 14 }} onClick={backToSignIn}>
                Back to sign in
              </button>
            </>
          )}
        </form>
      </div>
    )
  }

  return (
    <div className="page-center">
      <Logo large />
      <form className="card" onSubmit={handleSubmit}>
        <span className="eyebrow">Client Portal</span>
        <h1>Sign in</h1>
        <p className="muted">Enter your details to view your documents.</p>

        {confirmation && <p className="success">{confirmation}</p>}

        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          required
        />

        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />

        {error && <p className="error">{error}</p>}

        <button type="submit" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
        <button
          type="button"
          className="link-button"
          style={{ marginTop: 14 }}
          onClick={() => setMode('reset')}
        >
          Forgot password?
        </button>
      </form>
    </div>
  )
}
