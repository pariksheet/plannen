import { useState, useEffect } from 'react'
import {
  getRelationshipRequests,
  acceptRelationshipRequest,
  declineRelationshipRequest,
  type RelationshipRequest,
} from '../services/relationshipService'
import { Loader, Check, X } from 'lucide-react'

type RelFilter = 'family' | 'friend'

interface PendingRequestsProps {
  /** Show only requests of this type (and 'both') */
  filter: RelFilter
  onAcceptOrDecline: () => void
}

function typeLabel(relType: string, direction: 'sent' | 'received'): string {
  if (relType === 'both') return direction === 'sent' ? 'Family & friend request' : 'Wants to be family & friend'
  if (relType === 'family') return direction === 'sent' ? 'Family request' : 'Wants to be family'
  return direction === 'sent' ? 'Friend request' : 'Wants to be your friend'
}

export function PendingRequests({ filter, onAcceptOrDecline }: PendingRequestsProps) {
  const [requests, setRequests] = useState<RelationshipRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [actingId, setActingId] = useState<string | null>(null)

  const load = () => {
    setLoading(true)
    getRelationshipRequests().then(({ data }) => {
      setRequests(data ?? [])
      setLoading(false)
    })
  }

  useEffect(() => {
    load()
  }, [])

  const filtered = requests.filter((r) => r.relationship_type === filter || r.relationship_type === 'both')
  const showEmpty = filtered.length === 0 && !loading

  const handleAccept = async (id: string) => {
    setActingId(id)
    const { error } = await acceptRelationshipRequest(id)
    setActingId(null)
    if (!error) {
      load()
      onAcceptOrDecline()
    }
  }

  const handleDecline = async (id: string) => {
    setActingId(id)
    const { error } = await declineRelationshipRequest(id)
    setActingId(null)
    if (!error) {
      load()
      onAcceptOrDecline()
    }
  }

  const displayName = (r: RelationshipRequest) => r.other_name || r.other_email || r.other_user_id

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-gray-500 text-sm">
        <Loader className="h-4 w-4 animate-spin" />
        <span>Loading requests…</span>
      </div>
    )
  }

  if (showEmpty) {
    return (
      <div>
        <h4 className="text-sm font-semibold text-gray-700">Pending requests</h4>
        <p className="text-sm text-gray-500 mt-1">No pending requests.</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <h4 className="text-sm font-semibold text-gray-700">Pending requests</h4>
      <ul className="space-y-2">
        {filtered.map((r) => (
          <li
            key={r.id}
            className="flex flex-wrap items-center justify-between gap-2 py-2 px-3 bg-gray-50 rounded-md border border-gray-200"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-900 truncate">{displayName(r)}</p>
              <p className="text-xs text-gray-500">{typeLabel(r.relationship_type, r.direction)}</p>
            </div>
            <div className="flex gap-2 flex-shrink-0">
              {r.direction === 'received' ? (
                <>
                  <button
                    type="button"
                    onClick={() => handleAccept(r.id)}
                    disabled={actingId !== null}
                    className="inline-flex items-center gap-1 px-3 py-1.5 bg-green-600 text-white rounded text-sm hover:bg-green-700 disabled:opacity-50"
                  >
                    {actingId === r.id ? <Loader className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                    Accept
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDecline(r.id)}
                    disabled={actingId !== null}
                    className="inline-flex items-center gap-1 px-3 py-1.5 border border-gray-300 rounded text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-50"
                  >
                    <X className="h-3.5 w-3.5" />
                    Decline
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => handleDecline(r.id)}
                  disabled={actingId !== null}
                  className="inline-flex items-center gap-1 px-3 py-1.5 border border-gray-300 rounded text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-50"
                >
                  {actingId === r.id ? <Loader className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                  Cancel request
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
