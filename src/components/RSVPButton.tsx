import { useState, useEffect } from 'react'
import { format, isSameDay } from 'date-fns'
import { getMyRsvp, setRsvp, type RsvpStatus } from '../services/rsvpService'
import { getMyFeedEvents } from '../services/viewService'
import { Modal } from './Modal'

type ConflictEvent = {
  id: string
  title: string
  start_date: string
  end_date: string | null
}

export function RSVPButton({
  eventId,
  eventStartDate,
  layout = 'horizontal',
  onAfterSet,
}: {
  eventId: string
  eventStartDate?: string
  layout?: 'horizontal' | 'vertical'
  onAfterSet?: () => void
}) {
  const [status, setStatus] = useState<RsvpStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [updating, setUpdating] = useState(false)
  const [pendingStatus, setPendingStatus] = useState<RsvpStatus | null>(null)
  const [conflicts, setConflicts] = useState<ConflictEvent[]>([])
  const [showConflictModal, setShowConflictModal] = useState(false)
  const [error, setError] = useState('')

  const [preferredVisitDate, setPreferredVisitDate] = useState<string | null>(null)

  useEffect(() => {
    getMyRsvp(eventId).then(({ data }) => {
      setStatus(data?.status ?? null)
      setPreferredVisitDate(data?.preferred_visit_date ?? null)
      setLoading(false)
    })
  }, [eventId])

  const applyStatus = async (s: RsvpStatus) => {
    setUpdating(true)
    const { error } = await setRsvp(eventId, s, preferredVisitDate)
    if (!error) {
      setStatus(s)
      onAfterSet?.()
      setError('')
    } else {
      setError(error.message)
    }
    setUpdating(false)
  }

  const handleSet = async (s: RsvpStatus) => {
    if ((s === 'going' || s === 'maybe') && eventStartDate) {
      const targetDate = new Date(eventStartDate)
      if (!Number.isNaN(targetDate.getTime())) {
        const { data, error } = await getMyFeedEvents()
        if (error) {
          setError(error.message)
          return
        }
        const dayConflicts = (data ?? [])
          .filter((e) => e.id !== eventId)
          .filter((e) => isSameDay(new Date(e.start_date), targetDate))
          .map((e) => ({
            id: e.id,
            title: e.title,
            start_date: e.start_date,
            end_date: e.end_date,
          }))
          .sort((a, b) => new Date(a.start_date).getTime() - new Date(b.start_date).getTime())
        if (dayConflicts.length > 0) {
          setPendingStatus(s)
          setConflicts(dayConflicts)
          setShowConflictModal(true)
          return
        }
      }
    }
    await applyStatus(s)
  }

  if (loading) return <div className="text-xs text-gray-500">Loading…</div>

  return (
    <>
      <div className={layout === 'vertical' ? 'flex flex-col gap-1.5' : 'flex flex-wrap gap-1.5'}>
        {(['going', 'maybe', 'not_going'] as const).map((s) => (
          <button
            key={s}
            type="button"
            disabled={updating}
            onClick={() => handleSet(s)}
            className={`min-h-[36px] px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              layout === 'vertical' ? 'w-full text-left' : ''
            } ${
              status === s
                ? s === 'going'
                  ? 'bg-green-600 text-white'
                  : s === 'maybe'
                    ? 'bg-yellow-500 text-white'
                    : 'bg-red-600 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            {s === 'going' ? 'Going' : s === 'maybe' ? 'Maybe' : 'Not going'}
          </button>
        ))}
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      <Modal
        isOpen={showConflictModal}
        onClose={() => {
          setShowConflictModal(false)
          setPendingStatus(null)
        }}
        title="You already have plans on this day"
      >
        <div className="space-y-3">
          <p className="text-sm text-gray-700">
            These events are already planned on the same day. You can still continue with
            {' '}
            <span className="font-semibold">{pendingStatus === 'going' ? 'Going' : 'Maybe'}</span>
            .
          </p>
          <div className="space-y-2 max-h-56 overflow-y-auto">
            {conflicts.map((event) => (
              <div key={event.id} className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2">
                <p className="text-sm font-medium text-gray-900">{event.title}</p>
                <p className="text-xs text-gray-600">
                  {format(new Date(event.start_date), 'PPp')}
                  {event.end_date ? ` – ${format(new Date(event.end_date), 'PPp')}` : ''}
                </p>
              </div>
            ))}
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => {
                setShowConflictModal(false)
                setPendingStatus(null)
              }}
              className="min-h-[40px] px-3 py-2 rounded-md bg-gray-100 text-gray-700 text-sm font-medium hover:bg-gray-200"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={async () => {
                const next = pendingStatus
                setShowConflictModal(false)
                setPendingStatus(null)
                if (next) await applyStatus(next)
              }}
              className="min-h-[40px] px-3 py-2 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700"
            >
              Continue anyway
            </button>
          </div>
        </div>
      </Modal>
    </>
  )
}
