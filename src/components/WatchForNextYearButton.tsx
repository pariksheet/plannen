import { useEffect, useState } from 'react'
import { Loader } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { Event } from '../types/event'
import { createRecurringTask, getEventWatchTask, WatchTask } from '../services/agentTaskService'

export function WatchForNextYearButton({ event }: { event: Event }) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [task, setTask] = useState<WatchTask | null>(null)

  useEffect(() => {
    if (!event.enrollment_url) { setLoading(false); return }

    let isMounted = true

    getEventWatchTask(event.id)
      .then((t) => {
        if (isMounted) {
          setTask(t)
          setLoading(false)
        }
      })
      .catch((err) => {
        if (isMounted) {
          console.error('Failed to fetch watch task:', err)
          setLoading(false)
        }
      })

    return () => { isMounted = false }
  }, [event.id, event.enrollment_url])

  if (!event.enrollment_url) return null
  if (loading) return <span className="text-xs text-gray-400">Loading…</span>

  if (task) {
    if (task.status === 'failed') {
      return (
        <span className="text-xs text-red-600 font-medium">
          Watch failed — check manually
        </span>
      )
    }
    if (task.status === 'pending') {
      return (
        <span className="text-xs text-gray-500 font-medium">
          Scheduling first check…
        </span>
      )
    }
    const lastChecked = task.last_checked_at
      ? `Last checked ${formatDistanceToNow(new Date(task.last_checked_at), { addSuffix: true })}`
      : 'Not yet checked'
    return (
      <span className="text-xs text-indigo-600 font-medium">
        Watching · {lastChecked}
      </span>
    )
  }

  const handleClick = async () => {
    setSaving(true)
    try {
      await createRecurringTask(event.id, event.enrollment_url!, {
        recurrenceMonths: 12,
        lastOccurrenceDate: event.start_date?.slice(0, 10) ?? undefined,
      })
      const t = await getEventWatchTask(event.id)
      setTask(t)
    } catch (err) {
      console.error('Failed to create watch task:', err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <button
      type="button"
      disabled={saving}
      onClick={handleClick}
      className="inline-flex items-center min-h-[36px] px-3 py-1.5 bg-indigo-600 text-white text-xs font-medium rounded-md hover:bg-indigo-700 disabled:opacity-50"
    >
      {saving ? <Loader className="h-4 w-4 animate-spin mr-2" /> : null}
      Watch for Next Occurrence
    </button>
  )
}
