import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'

type ConsentDetails = { clientName: string; scope: string }

// OAuth 2.1 consent screen. Supabase Auth redirects here (the project's
// oauth_server_authorization_path) during the authorize flow — e.g. when a
// user connects the Plannen MCP as a claude.ai custom connector. Approve /
// deny hand control back to Supabase, which redirects to the OAuth client.
export function OAuthConsent() {
  const { user, loading } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const authorizationId = searchParams.get('authorization_id')
  const [details, setDetails] = useState<ConsentDetails | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (loading) return
    if (!user) {
      // Login.tsx honors ?redirect= and signIn threads it into
      // emailRedirectTo, so both passkey and OTP logins land back here.
      const next = `/oauth/consent?authorization_id=${encodeURIComponent(authorizationId ?? '')}`
      navigate(`/login?redirect=${encodeURIComponent(next)}`, { replace: true })
      return
    }
    if (!authorizationId) {
      setError('Missing authorization request. Start again from the app you are connecting.')
      return
    }

    let active = true
    supabase.auth.oauth.getAuthorizationDetails(authorizationId).then(({ data, error: err }) => {
      if (!active) return
      if (err || !data) {
        setError(err?.message ?? 'Could not load the authorization request.')
        return
      }
      if ('redirect_url' in data) {
        // Already consented — bounce straight back to the client.
        window.location.href = data.redirect_url
        return
      }
      setDetails({ clientName: data.client.name, scope: data.scope })
    })

    return () => { active = false }
  }, [user, loading, authorizationId, navigate])

  const decide = async (action: 'approve' | 'deny') => {
    if (!authorizationId) return
    setBusy(true)
    // Default options auto-redirect the browser via the returned redirect_url.
    const { error: err } = action === 'approve'
      ? await supabase.auth.oauth.approveAuthorization(authorizationId)
      : await supabase.auth.oauth.denyAuthorization(authorizationId)
    if (err) {
      setBusy(false)
      setError(err.message)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="max-w-md w-full bg-white shadow-sm rounded-lg p-6 border border-gray-200 space-y-4">
        {error ? (
          <p className="text-sm text-red-600">{error}</p>
        ) : !details ? (
          <p className="text-sm text-gray-600">Loading authorization request…</p>
        ) : (
          <>
            <h1 className="text-lg font-semibold text-gray-900">
              Allow {details.clientName} to access your Plannen account?
            </h1>
            <p className="text-sm text-gray-600">
              {details.clientName} will be able to act as you in Plannen
              (events, watches, stories, profile). Requested scopes:{' '}
              <span className="font-mono">{details.scope}</span>
            </p>
            <div className="flex gap-3 pt-2">
              <button
                type="button"
                disabled={busy}
                className="flex-1 inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50"
                onClick={() => decide('approve')}
              >
                Approve
              </button>
              <button
                type="button"
                disabled={busy}
                className="flex-1 inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200 disabled:opacity-50"
                onClick={() => decide('deny')}
              >
                Deny
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
