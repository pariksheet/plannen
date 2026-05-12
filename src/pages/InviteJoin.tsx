import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { getInviteByToken, joinEventByInvite } from '../services/inviteService'
import { Loader } from 'lucide-react'

export function InviteJoin() {
  const { token } = useParams<{ token: string }>()
  const navigate = useNavigate()
  const { user, loading: authLoading } = useAuth()
  const [status, setStatus] = useState<'loading' | 'invalid' | 'joining' | 'done' | 'error'>('loading')
  const [message, setMessage] = useState('')

  const safeToken = token?.trim() ?? ''

  useEffect(() => {
    if (!safeToken) {
      setStatus('invalid')
      return
    }
    if (authLoading) return
    if (!user) {
      navigate(`/login?redirect=${encodeURIComponent(`/invite/${safeToken}`)}`, { replace: true })
      return
    }
    (async () => {
      const { data: invite, error: fetchErr } = await getInviteByToken(safeToken)
      if (fetchErr || !invite) {
        setStatus('invalid')
        return
      }
      setStatus('joining')
      const { error: joinErr } = await joinEventByInvite(safeToken)
      if (joinErr) {
        setStatus('error')
        setMessage(joinErr.message)
        return
      }
      setStatus('done')
      setTimeout(() => navigate('/dashboard', { replace: true }), 1500)
    })()
  }, [safeToken, user, authLoading, navigate])

  if (status === 'invalid') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
        <div className="text-center">
          <h1 className="text-lg font-semibold text-gray-900">Invalid or expired link</h1>
          <p className="mt-2 text-sm text-gray-600">This invite link is invalid or has expired. Ask the person who invited you for a new link.</p>
          <button
            type="button"
            onClick={() => navigate('/dashboard')}
            className="mt-4 px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700"
          >
            Go to dashboard
          </button>
        </div>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
        <div className="text-center">
          <h1 className="text-lg font-semibold text-gray-900">Couldn’t join event</h1>
          <p className="mt-2 text-sm text-gray-600">{message}</p>
          <button
            type="button"
            onClick={() => navigate('/dashboard')}
            className="mt-4 px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700"
          >
            Go to dashboard
          </button>
        </div>
      </div>
    )
  }

  if (status === 'done') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
        <div className="text-center">
          <h1 className="text-lg font-semibold text-gray-900">You’ve joined the event</h1>
          <p className="mt-2 text-sm text-gray-600">Taking you to your dashboard…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <div className="flex items-center gap-2 text-gray-600">
        <Loader className="h-5 w-5 animate-spin" />
        <span className="text-sm">{status === 'joining' ? 'Joining event…' : 'Loading…'}</span>
      </div>
    </div>
  )
}
