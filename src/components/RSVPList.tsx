import { useState, useEffect } from 'react'
import { getRsvpList } from '../services/rsvpService'

type RsvpUser = { id: string; full_name?: string; email?: string }

export function RSVPList({ eventId, createdBy, refreshTrigger }: { eventId: string; createdBy?: string; refreshTrigger?: number }) {
  const [data, setData] = useState<{ going: RsvpUser[]; maybe: RsvpUser[]; not_going: RsvpUser[] } | null>(null)

  useEffect(() => {
    getRsvpList(eventId).then(({ data: d }) => setData(d ?? null))
  }, [eventId, refreshTrigger])

  if (!data) return null
  const { going, maybe, not_going } = data
  const total = going.length + maybe.length + not_going.length
  if (total === 0) {
    return <p className="text-sm text-gray-500">No RSVPs yet.</p>
  }
  const displayName = (u: RsvpUser) => {
    const n = u.full_name || u.email || 'Someone'
    return createdBy && u.id === createdBy ? `${n} (organizer)` : n
  }
  return (
    <div className="text-sm space-y-2">
      {going.length > 0 && (
        <p><span className="font-medium text-green-700">Going ({going.length}):</span> {going.map(displayName).join(', ')}</p>
      )}
      {maybe.length > 0 && (
        <p><span className="font-medium text-yellow-700">Maybe ({maybe.length}):</span> {maybe.map(displayName).join(', ')}</p>
      )}
      {not_going.length > 0 && (
        <p><span className="font-medium text-red-700">Not going ({not_going.length}):</span> {not_going.map(displayName).join(', ')}</p>
      )}
    </div>
  )
}
