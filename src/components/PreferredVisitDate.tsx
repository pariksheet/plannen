import { useState, useEffect } from 'react'
import { format, parseISO } from 'date-fns'
import { getMyRsvp, getPreferredVisitDateForUser, setPreferredVisitDate } from '../services/rsvpService'
import { useAuth } from '../context/AuthContext'
import { Calendar } from 'lucide-react'

interface PreferredVisitDateProps {
  eventId: string
  startDate: string
  endDate: string | null
  /** Event creator's user id – when set, we show organiser's visit date for everyone (same card for all) */
  createdBy?: string
  /** If true, show date picker; if false, only show "Visit" (compact for card) */
  showPicker?: boolean
  /** When true and showPicker false, render as inline span for use in a single compact line */
  inline?: boolean
  /** Increment to refetch (e.g. after organiser sets visit date in modal) */
  refreshTrigger?: number
  onUpdated?: () => void
}

function toDateTimeLocal(value: string): string {
  if (!value || !value.trim()) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${y}-${mo}-${day}T${h}:${min}`
}

export function PreferredVisitDate({
  eventId,
  startDate,
  endDate,
  createdBy,
  showPicker = true,
  inline = false,
  refreshTrigger,
  onUpdated,
}: PreferredVisitDateProps) {
  const { user } = useAuth()
  const [preferred, setPreferred] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const start = new Date(startDate)
  const end = endDate ? new Date(endDate) : null
  const isMultiDay = end && start.getTime() < end.getTime()
  const minDateTime = toDateTimeLocal(startDate)
  const maxDateTime = end && endDate ? toDateTimeLocal(endDate) : minDateTime
  const isCreator = Boolean(createdBy && user?.id === createdBy)
  const label = createdBy ? 'Visit' : 'Your visit'

  useEffect(() => {
    if (createdBy) {
      getPreferredVisitDateForUser(eventId, createdBy).then(({ data }) => {
        setPreferred(data ?? null)
        setLoading(false)
      })
    } else {
      getMyRsvp(eventId).then(({ data }) => {
        setPreferred(data?.preferred_visit_date ?? null)
        setLoading(false)
      })
    }
  }, [eventId, createdBy, refreshTrigger])

  if (!isMultiDay) return null

  const handleChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value
    const next = raw ? new Date(raw).toISOString() : null
    setSaving(true)
    const { error } = await setPreferredVisitDate(eventId, next)
    if (!error) {
      setPreferred(next)
      onUpdated?.()
    }
    setSaving(false)
  }

  const displayDate = preferred ? format(parseISO(preferred), 'MMM d, yyyy h:mm a') : null

  if (showPicker && (!createdBy || isCreator)) {
    return (
      <div className="space-y-2">
        <p className="text-sm font-medium text-gray-700">{createdBy ? 'Visit date & time' : 'Your visit date & time'}</p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="datetime-local"
            min={minDateTime || undefined}
            max={maxDateTime || undefined}
            value={preferred ? toDateTimeLocal(preferred) : ''}
            onChange={handleChange}
            disabled={saving}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
          {displayDate && (
            <span className="text-sm text-green-700 font-medium">
              {label}: {displayDate}
            </span>
          )}
        </div>
      </div>
    )
  }

  // Inline (card compact line): only show when a visit date is actually set
  if (inline) {
    if (loading || !displayDate) return null
    return <span className="text-green-700">{label}: {displayDate}</span>
  }

  if (!displayDate) return null
  return (
    <div className="flex items-center text-xs text-green-700">
      <Calendar className="h-3.5 w-3.5 mr-1.5 flex-shrink-0" />
      <span>{label}: {displayDate}</span>
    </div>
  )
}
