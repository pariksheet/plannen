import { useState, useEffect } from 'react'
import { Event } from '../types/event'
import { getOrCreateEventInvite } from '../services/inviteService'
import { Modal } from './Modal'
import { Loader, Copy, Check } from 'lucide-react'

interface EventInviteModalProps {
  event: Event
  onClose: () => void
}

export function EventInviteModal({ event, onClose }: EventInviteModalProps) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [token, setToken] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    getOrCreateEventInvite(event.id).then(({ data, error: err }) => {
      setLoading(false)
      if (err) {
        setError(err.message)
        return
      }
      if (data?.token) setToken(data.token)
    })
  }, [event.id])

  const inviteUrl = token ? `${typeof window !== 'undefined' ? window.location.origin : ''}/invite/${token}` : ''

  const handleCopy = async () => {
    if (!inviteUrl) return
    try {
      await navigator.clipboard.writeText(inviteUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('Could not copy to clipboard')
    }
  }

  return (
    <Modal isOpen onClose={onClose} title="Invite to event">
      <div className="space-y-4">
        <p className="text-sm text-gray-600">
          Only people with this link can join. Don’t share it publicly (e.g. on social media) so that only intended people can join the event.
        </p>
        {loading && (
          <div className="flex items-center gap-2 text-gray-500">
            <Loader className="h-4 w-4 animate-spin" />
            <span className="text-sm">Generating link…</span>
          </div>
        )}
        {error && <p className="text-sm text-red-600">{error}</p>}
        {!loading && inviteUrl && (
          <div className="flex gap-2">
            <input
              type="text"
              readOnly
              value={inviteUrl}
              className="flex-1 min-w-0 px-3 py-2 border border-gray-300 rounded-md text-sm bg-gray-50"
            />
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700"
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        )}
      </div>
    </Modal>
  )
}
