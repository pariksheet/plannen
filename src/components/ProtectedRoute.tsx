import { Navigate, useLocation } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { hasAppAccess } from '../services/appAccessService'
import { TIER, isTierZero } from '../lib/tier'

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading, profile } = useAuth()
  const location = useLocation()
  // Tier 0 short-circuits the access gate (single-user local install) so we
  // skip the round-trip entirely and avoid the "Checking access…" flicker.
  const [accessChecked, setAccessChecked] = useState(isTierZero())
  const [allowed, setAllowed] = useState<boolean | null>(isTierZero() ? true : null)

  useEffect(() => {
    if (!user) {
      setAccessChecked(isTierZero())
      setAllowed(isTierZero() ? true : null)
      return
    }
    if (isTierZero()) return
    hasAppAccess().then(({ allowed: ok }) => {
      setAllowed(ok)
      setAccessChecked(true)
    })
  }, [user])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-gray-600">
        Loading...
      </div>
    )
  }
  if (!user) {
    return <Navigate to="/login" replace />
  }
  if (user && !accessChecked) {
    return (
      <div className="min-h-screen flex items-center justify-center text-gray-600">
        Checking access…
      </div>
    )
  }
  if (allowed === false) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <div className="max-w-md w-full bg-white shadow-sm rounded-lg p-6 border border-gray-200 text-center space-y-3">
          <h1 className="text-lg font-semibold text-gray-900">Plannen is invite-only</h1>
          <p className="text-sm text-gray-600">
            You need an invitation from an existing Plannen user before you can use the app.
            Ask a friend or family member who already uses Plannen to invite you with your email address.
          </p>
          <button
            type="button"
            className="mt-2 inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200"
            onClick={() => {
              window.location.href = '/login'
            }}
          >
            Back to login
          </button>
        </div>
      </div>
    )
  }
  if (
    TIER === '1' &&
    profile &&
    !profile.full_name &&
    location.pathname !== '/onboarding'
  ) {
    return <Navigate to="/onboarding" replace />
  }
  return <>{children}</>
}
