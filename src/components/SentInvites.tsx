import { useState, useEffect } from 'react'
import { listSentInvites, cancelInvite, type SentInvite } from '../services/relationshipService'
import { Loader, X, MailX } from 'lucide-react'

interface SentInvitesProps {
  /** Bumped by the parent after an invite is sent so the list refreshes. */
  refreshKey?: number
}

export function SentInvites({ refreshKey = 0 }: SentInvitesProps) {
  const [invites, setInvites] = useState<SentInvite[]>([])
  const [loading, setLoading] = useState(true)
  const [actingId, setActingId] = useState<string | null>(null)

  const load = () => {
    setLoading(true)
    listSentInvites().then(({ data }) => {
      setInvites(data ?? [])
      setLoading(false)
    })
  }

  useEffect(() => {
    load()
  }, [refreshKey])

  const handleCancel = async (id: string) => {
    setActingId(id)
    const { error } = await cancelInvite(id)
    setActingId(null)
    if (!error) load()
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-gray-500 text-sm">
        <Loader className="h-4 w-4 animate-spin" />
        <span>Loading invites…</span>
      </div>
    )
  }

  if (invites.length === 0) {
    return (
      <div>
        <h4 className="text-sm font-semibold text-gray-700">Invites sent</h4>
        <p className="text-sm text-gray-500 mt-1">No pending invites.</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <h4 className="text-sm font-semibold text-gray-700">Invites sent</h4>
      <ul className="space-y-2">
        {invites.map((inv) => (
          <li
            key={inv.id}
            className="flex flex-wrap items-center justify-between gap-2 py-2 px-3 bg-gray-50 rounded-md border border-gray-200"
          >
            <div className="min-w-0 flex items-center gap-2">
              <MailX className="h-4 w-4 text-gray-400 flex-shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">{inv.invitee_email}</p>
                <p className="text-xs text-gray-500">Not on Plannen yet — joins as your friend automatically</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => handleCancel(inv.id)}
              disabled={actingId !== null}
              className="inline-flex items-center gap-1 px-3 py-1.5 border border-gray-300 rounded text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-50 flex-shrink-0"
            >
              {actingId === inv.id ? <Loader className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
              Cancel
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
