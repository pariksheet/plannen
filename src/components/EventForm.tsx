import { useState, useEffect, useRef } from 'react'
import { Event, EventFormData, EventStatus, SharedWithFriends } from '../types/event'
import { createEvent, updateEvent, getEventSharedWithUserIds, getEventSharedWithGroupIds } from '../services/eventService'
import { createRecurringTask } from '../services/agentTaskService'
import { getMyFriends, type FriendUser } from '../services/relationshipService'
import { getMyGroups } from '../services/groupService'
import { getMyRsvp, setPreferredVisitDate } from '../services/rsvpService'
import { uploadEventCover } from '../services/eventCoverService'
import { useAgent } from '../hooks/useAgent'
import { X, Loader, Upload, ChevronLeft, ChevronRight } from 'lucide-react'

const WIZARD_STEPS = 4

/** Format a date string for <input type="datetime-local">: yyyy-MM-ddThh:mm (local time, no Z) */
function toDateTimeLocal(value: string): string {
  if (!value || !value.trim()) return ''
  const s = value.trim()
  let d: Date
  if (s.length <= 10) {
    const [y, m, day] = s.split(/[-/]/).map(Number)
    if (y == null || m == null || day == null) return ''
    d = new Date(y, (m ?? 1) - 1, day ?? 1, 0, 0, 0, 0)
  } else {
    d = new Date(s)
  }
  if (isNaN(d.getTime())) return ''
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${y}-${mo}-${day}T${h}:${min}`
}

function FriendPicker({ selectedIds, onChange }: { selectedIds: string[]; onChange: (ids: string[]) => void }) {
  const [friends, setFriends] = useState<FriendUser[]>([])
  useEffect(() => {
    getMyFriends().then(({ data }) => setFriends(data ?? []))
  }, [])
  const toggle = (id: string) => {
    if (selectedIds.includes(id)) onChange(selectedIds.filter((x) => x !== id))
    else onChange([...selectedIds, id])
  }
  if (friends.length === 0) return <p className="text-xs text-gray-500 mt-1">No friends added yet. Add friends in your network to select them.</p>
  return (
    <div className="mt-2 max-h-40 overflow-y-auto border border-gray-200 rounded p-2 space-y-1">
      {friends.map((f) => (
        <label key={f.id} className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={selectedIds.includes(f.id)} onChange={() => toggle(f.id)} className="h-4 w-4 rounded border-gray-300 text-indigo-600" />
          <span className="text-sm text-gray-700">{f.full_name || f.email || f.id}</span>
        </label>
      ))}
    </div>
  )
}

function GroupPicker({ selectedIds, onChange }: { selectedIds: string[]; onChange: (ids: string[]) => void }) {
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([])
  useEffect(() => {
    getMyGroups().then(({ data }) => setGroups(data ?? []))
  }, [])
  const toggle = (id: string) => {
    if (selectedIds.includes(id)) onChange(selectedIds.filter((x) => x !== id))
    else onChange([...selectedIds, id])
  }
  if (groups.length === 0) return <p className="text-xs text-gray-500 mt-1">No groups yet. Create groups in Manage friends to share events with a subset of friends.</p>
  return (
    <div className="mt-2 max-h-40 overflow-y-auto border border-gray-200 rounded p-2 space-y-1">
      {groups.map((g) => (
        <label key={g.id} className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={selectedIds.includes(g.id)} onChange={() => toggle(g.id)} className="h-4 w-4 rounded border-gray-300 text-indigo-600" />
          <span className="text-sm text-gray-700">{g.name}</span>
        </label>
      ))}
    </div>
  )
}

interface EventFormProps {
  event?: Event
  onClose: () => void
  onSuccess: () => void
  initialData?: Partial<EventFormData>
}

export function EventForm({ event, onClose, onSuccess, initialData }: EventFormProps) {
  const [step, setStep] = useState(1)
  const [loading, setLoading] = useState(false)
  const [scraping, setScraping] = useState(false)
  const [coverUploading, setCoverUploading] = useState(false)
  const [coverError, setCoverError] = useState('')
  const coverFileInputRef = useRef<HTMLInputElement>(null)
  const modalContentRef = useRef<HTMLDivElement>(null)
  const submitButtonRef = useRef<HTMLButtonElement>(null)
  const createReminderButtonRef = useRef<HTMLButtonElement>(null)
  const [error, setError] = useState('')
  const [watchForNextOccurrence, setWatchForNextOccurrence] = useState(false)
  const [missedEvent, setMissedEvent] = useState(false)
  const [convertFromWatching, setConvertFromWatching] = useState(false)
  const [visitDateTime, setVisitDateTime] = useState('')
  const [hashtagsInput, setHashtagsInput] = useState<string>(() => {
    const raw = (initialData as Partial<EventFormData> | undefined)?.hashtags ?? []
    return raw && raw.length ? raw.map((tag) => `#${tag}`).join(' ') : ''
  })
  const [formData, setFormData] = useState<EventFormData>(() => {
    const base: EventFormData = {
      title: '',
      description: '',
      start_date: '',
      end_date: '',
      enrollment_url: '',
      enrollment_deadline: '',
      enrollment_start_date: '',
      image_url: '',
      location: '',
      hashtags: [],
      event_kind: 'event',
      event_type: 'personal',
      shared_with_family: false,
      shared_with_friends: 'none',
      shared_with_user_ids: [],
      shared_with_group_ids: [],
    }
    const raw = initialData ?? {}
    return {
      ...base,
      ...raw,
      start_date: raw.start_date ? toDateTimeLocal(raw.start_date) : base.start_date,
      end_date: raw.end_date ? toDateTimeLocal(raw.end_date) : base.end_date,
      enrollment_deadline: raw.enrollment_deadline ? toDateTimeLocal(raw.enrollment_deadline) : base.enrollment_deadline,
      enrollment_start_date: raw.enrollment_start_date ? toDateTimeLocal(raw.enrollment_start_date) : base.enrollment_start_date,
    }
  })
  const { scrapeUrl, extractFromImage } = useAgent()
  const [extractingFromImage, setExtractingFromImage] = useState(false)
  const extractPhotoFileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (event) {
      setFormData((prev) => ({
        ...prev,
        title: event.title,
        description: event.description || '',
        start_date: event.start_date ? toDateTimeLocal(event.start_date) : '',
        end_date: event.end_date ? toDateTimeLocal(event.end_date) : '',
        enrollment_url: event.enrollment_url || '',
        enrollment_deadline: event.enrollment_deadline ? toDateTimeLocal(event.enrollment_deadline) : '',
        enrollment_start_date: event.enrollment_start_date ? toDateTimeLocal(event.enrollment_start_date) : '',
        image_url: event.image_url || '',
        location: event.location || '',
        hashtags: event.hashtags ?? [],
        event_kind: event.event_kind ?? 'event',
        event_type: event.event_type,
        shared_with_family: event.shared_with_family ?? false,
        shared_with_friends: (event.shared_with_friends as SharedWithFriends) ?? 'none',
      }))
      setHashtagsInput(event.hashtags && event.hashtags.length ? event.hashtags.map((tag) => `#${tag}`).join(' ') : '')
      getEventSharedWithUserIds(event.id).then(({ data: ids }) => {
        setFormData((prev) => ({ ...prev, shared_with_user_ids: ids ?? [] }))
      })
      getEventSharedWithGroupIds(event.id).then(({ data: groupIds }) => {
        setFormData((prev) => ({ ...prev, shared_with_group_ids: groupIds ?? [] }))
      })
      getMyRsvp(event.id).then(({ data }) => {
        setVisitDateTime(data?.preferred_visit_date ? toDateTimeLocal(data.preferred_visit_date) : '')
      })
      setWatchForNextOccurrence(event.event_status === 'watching' || event.event_status === 'missed')
    }
  }, [event])

  useEffect(() => {
    modalContentRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }, [step])

  const hasValidRange = Boolean(
    formData.event_kind === 'event' &&
    formData.start_date &&
    formData.end_date &&
    new Date(formData.start_date).getTime() < new Date(formData.end_date).getTime()
  )

  const effectiveSteps = formData.event_kind === 'reminder' ? 2 : WIZARD_STEPS
  const canProceedStep1 = () => (formData.title ?? '').trim() !== ''
  const canProceedStep2 = () => (formData.start_date ?? '').trim() !== ''
  const canSubmitReminderFromStep1 = () => canProceedStep1() && canProceedStep2()

  const goNext = () => {
    if (step === 1 && !canProceedStep1()) {
      setError('Please enter a title.')
      return
    }
    if (step === 2 && !canProceedStep2()) {
      setError('Please enter a start date and time.')
      return
    }
    setError('')
    setStep((s) => Math.min(s + 1, effectiveSteps))
  }
  const goBack = () => setStep((s) => Math.max(s - 1, 1))

  const handleUrlChange = async (url: string) => {
    setFormData((prev) => ({ ...prev, enrollment_url: url }))
    if (!event && url && url.startsWith('http')) {
      setScraping(true)
      setError('')
      try {
        const { data } = await scrapeUrl(url)
        if (data?.extracted) {
          const ex = data.extracted
          const updates: Partial<EventFormData> = {}
          if (ex.title) updates.title = ex.title
          if (ex.image_url) updates.image_url = ex.image_url
          if (ex.start_date) {
            const v = toDateTimeLocal(ex.start_date)
            if (v) updates.start_date = v
          }
          if (ex.end_date) {
            const v = toDateTimeLocal(ex.end_date)
            if (v) updates.end_date = v
          }
          if (ex.enrollment_deadline) {
            const v = toDateTimeLocal(ex.enrollment_deadline)
            if (v) updates.enrollment_deadline = v
          }
          if (ex.location) updates.location = ex.location
          setFormData((prev) => ({ ...prev, ...updates }))
          if (ex.description) setFormData((prev) => ({ ...prev, description: ex.description ?? '' }))
        }
      } catch (err) {
        console.warn('Scrape failed', err)
      } finally {
        setScraping(false)
      }
    }
  }

  const applyExtractedToForm = (ex: { title?: string | null; description?: string | null; image_url?: string | null; start_date?: string | null; end_date?: string | null; enrollment_deadline?: string | null; location?: string | null }) => {
    const updates: Partial<EventFormData> = {}
    if (ex.title) updates.title = ex.title
    if (ex.image_url) updates.image_url = ex.image_url
    if (ex.start_date) {
      const v = toDateTimeLocal(ex.start_date)
      if (v) updates.start_date = v
    }
    if (ex.end_date) {
      const v = toDateTimeLocal(ex.end_date)
      if (v) updates.end_date = v
    }
    if (ex.enrollment_deadline) {
      const v = toDateTimeLocal(ex.enrollment_deadline)
      if (v) updates.enrollment_deadline = v
    }
    if (ex.location) updates.location = ex.location
    setFormData((prev) => ({ ...prev, ...updates }))
    if (ex.description != null) setFormData((prev) => ({ ...prev, description: ex.description ?? '' }))
  }

  const handleExtractFromPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !file.type.startsWith('image/')) return
    if (extractPhotoFileInputRef.current) extractPhotoFileInputRef.current.value = ''
    setCoverError('')
    setExtractingFromImage(true)
    setError('')
    try {
      const { data: url, error: uploadErr } = await uploadEventCover(file)
      if (uploadErr) {
        setCoverError(uploadErr.message)
        return
      }
      if (!url) return
      setFormData((prev) => ({ ...prev, image_url: url }))
      const { data, error: extractErr } = await extractFromImage(url)
      if (extractErr) {
        setError('Could not extract details from this image.')
        return
      }
      if (data?.extracted) applyExtractedToForm(data.extracted)
    } catch {
      setError('Could not extract details from this image.')
    } finally {
      setExtractingFromImage(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (formData.event_kind === 'event' && step < WIZARD_STEPS) {
      goNext()
      return
    }
    const native = e.nativeEvent as SubmitEvent
    if (native.submitter != null && native.submitter !== submitButtonRef.current && native.submitter !== createReminderButtonRef.current) return
    setLoading(true)
    setError('')
    try {
      const dataToSubmit: EventFormData = {
        ...formData,
        start_date: new Date(formData.start_date).toISOString(),
        end_date: formData.end_date ? new Date(formData.end_date).toISOString() : '',
        enrollment_url: formData.event_kind === 'reminder' ? '' : formData.enrollment_url,
        enrollment_deadline: formData.event_kind === 'reminder' ? '' : (formData.enrollment_deadline ? new Date(formData.enrollment_deadline).toISOString() : ''),
        enrollment_start_date: formData.event_kind === 'reminder' ? '' : (formData.enrollment_start_date ? new Date(formData.enrollment_start_date).toISOString() : ''),
        image_url: formData.image_url?.trim() || '',
        shared_with_family: formData.shared_with_family,
        shared_with_friends: formData.shared_with_friends,
        shared_with_user_ids: formData.shared_with_user_ids ?? [],
        shared_with_group_ids: formData.shared_with_group_ids ?? [],
      }
      let statusOption: { newStatus: EventStatus } | undefined
      if (event) {
        if (
          (event.event_status === 'watching' || event.event_status === 'missed') &&
          convertFromWatching
        ) {
          const start = new Date(dataToSubmit.start_date)
          const now = new Date()
          statusOption = { newStatus: start < now ? 'past' : 'going' }
        } else if (watchForNextOccurrence) {
          statusOption = { newStatus: 'watching' }
        }
      }
      if (event) {
        const { data: updatedEvent, error: err } = await updateEvent(event.id, dataToSubmit, statusOption)
        if (err) throw err
        if (updatedEvent && watchForNextOccurrence && (dataToSubmit.enrollment_url || event.enrollment_url)) {
          await createRecurringTask(updatedEvent.id, (dataToSubmit.enrollment_url || event.enrollment_url)!.trim())
        }
        if (updatedEvent && hasValidRange) {
          const preferredVisitIso = visitDateTime ? new Date(visitDateTime).toISOString() : null
          const { error: visitErr } = await setPreferredVisitDate(updatedEvent.id, preferredVisitIso)
          if (visitErr) throw visitErr
        }
      } else {
        const { data: createdEvent, error: err } = await createEvent(dataToSubmit, watchForNextOccurrence, missedEvent)
        if (err) throw err
        if (createdEvent && hasValidRange && visitDateTime) {
          const preferredVisitIso = new Date(visitDateTime).toISOString()
          const { error: visitErr } = await setPreferredVisitDate(createdEvent.id, preferredVisitIso)
          if (visitErr) throw visitErr
        }
      }
      onSuccess()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-2 sm:p-4">
      <div ref={modalContentRef} className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-w-[min(100vw-1rem,42rem)] max-h-[90vh] overflow-y-auto overflow-x-hidden min-w-0">
        <div className="sticky top-0 bg-white border-b border-gray-200 px-4 sm:px-6 py-4 z-10">
          <div className="flex justify-between items-center gap-2">
            <h2 className="text-xl sm:text-2xl font-bold text-gray-900 truncate">
              {event ? (formData.event_kind === 'reminder' ? 'Edit Reminder' : 'Edit Event') : (formData.event_kind === 'reminder' ? 'Create Reminder' : 'Create Event')}
            </h2>
            <button
              type="button"
              onClick={onClose}
              className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 flex-shrink-0"
              aria-label="Close"
            >
              <X className="h-6 w-6" />
            </button>
          </div>
          <p className="text-xs text-gray-500 mt-1">Step {step} of {effectiveSteps}</p>
          <div className="mt-2 h-1.5 bg-gray-200 rounded-full overflow-hidden">
            <div className="h-full bg-indigo-600 rounded-full transition-all duration-200" style={{ width: `${(step / effectiveSteps) * 100}%` }} />
          </div>
        </div>
        <form onSubmit={handleSubmit} className="p-4 sm:p-6 min-w-0 flex flex-col min-h-0">
          {error && (
            <div className="rounded-md bg-red-50 p-4 mb-4">
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}
          {step === 1 && (
          <div className="space-y-6">
          <div>
            <span className="block text-sm font-medium text-gray-700 mb-2">What is this?</span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setFormData((prev) => ({ ...prev, event_kind: 'event' }))}
                className={`min-h-[44px] flex-1 px-4 py-2.5 rounded-md text-sm font-medium border-2 transition-colors ${
                  formData.event_kind === 'event'
                    ? 'border-indigo-600 bg-indigo-50 text-indigo-700'
                    : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                }`}
              >
                Event
              </button>
              <button
                type="button"
                onClick={() => { setFormData((prev) => ({ ...prev, event_kind: 'reminder' })); setStep(1) }}
                className={`min-h-[44px] flex-1 px-4 py-2.5 rounded-md text-sm font-medium border-2 transition-colors ${
                  formData.event_kind === 'reminder'
                    ? 'border-indigo-600 bg-indigo-50 text-indigo-700'
                    : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                }`}
              >
                Reminder
              </button>
            </div>
            <p className="text-xs text-gray-500 mt-1">
              {formData.event_kind === 'reminder'
                ? 'Simple appointment or thing to remember (no URL or RSVP). Reminders stay private.'
                : 'Event with optional link, RSVP, and sharing. Use Next to set date, sharing, and options.'}
            </p>
          </div>
          {formData.event_kind === 'reminder' ? (
          <>
          <div>
            <label htmlFor="title" className="block text-sm font-medium text-gray-700 mb-1">Title *</label>
            <input
              type="text"
              id="title"
              required
              value={formData.title}
              onChange={(e) => setFormData({ ...formData, title: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
            />
          </div>
          <div>
            <label htmlFor="description" className="block text-sm font-medium text-gray-700 mb-1">Note (optional)</label>
            <textarea
              id="description"
              rows={2}
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              placeholder="e.g. Bring insurance card"
              className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label htmlFor="start_date" className="block text-sm font-medium text-gray-700 mb-1">Start Date & Time *</label>
              <input
                type="datetime-local"
                id="start_date"
                required
                value={formData.start_date}
                onChange={(e) => setFormData({ ...formData, start_date: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
              />
            </div>
            <div>
              <label htmlFor="end_date" className="block text-sm font-medium text-gray-700 mb-1">End Date & Time</label>
              <input
                type="datetime-local"
                id="end_date"
                value={formData.end_date}
                onChange={(e) => setFormData({ ...formData, end_date: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
              />
            </div>
          </div>
          <div>
            <label htmlFor="hashtags" className="block text-sm font-medium text-gray-700 mb-1">Hashtags</label>
            <input
              type="text"
              id="hashtags"
              value={hashtagsInput}
              onChange={(e) => {
                const raw = e.target.value || ''
                setHashtagsInput(raw)
                const parts = raw
                  .split(/[\s,]+/)
                  .map((p) => p.trim().replace(/^#/, ''))
                  .filter(Boolean)
                const unique = Array.from(new Set(parts)).slice(0, 5)
                setFormData((prev) => ({ ...prev, hashtags: unique }))
              }}
              placeholder="#summer #kids #camp (max 5)"
              className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
            />
            <p className="text-xs text-gray-500 mt-1">Add up to 5 short tags without spaces.</p>
          </div>
          </>
          ) : (
          <>
          <div>
            <label htmlFor="enrollment_url" className="block text-sm font-medium text-gray-700 mb-1">Event or registration URL</label>
            <div className="relative">
              <input
                type="url"
                id="enrollment_url"
                value={formData.enrollment_url}
                onChange={(e) => handleUrlChange(e.target.value)}
                placeholder="https://www.example.com/event"
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                disabled={scraping || extractingFromImage}
              />
              {(scraping || extractingFromImage) && (
                <div className="absolute right-3 top-1/2 -translate-y-1/2">
                  <Loader className="h-5 w-5 animate-spin text-indigo-600" />
                </div>
              )}
            </div>
            <p className="text-xs text-gray-500 mt-1">
              {scraping ? 'Fetching event information...' : extractingFromImage ? 'Extracting event details…' : "Optional. Add a link to sign up or get tickets. Leave blank for walk-in / first-come-first-serve events."}
            </p>
            <div className="mt-2 flex items-center gap-2">
              <input
                ref={extractPhotoFileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleExtractFromPhoto}
              />
              <button
                type="button"
                onClick={() => extractPhotoFileInputRef.current?.click()}
                disabled={scraping || extractingFromImage}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-md border border-indigo-200 bg-indigo-50 text-sm font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-50"
              >
                {extractingFromImage ? (
                  <>
                    <Loader className="h-4 w-4 animate-spin" />
                    Extracting…
                  </>
                ) : (
                  <>
                    <Upload className="h-4 w-4" />
                    Upload photo to extract
                  </>
                )}
              </button>
              <span className="text-xs text-gray-500">Or upload a flyer or poster to auto-fill details.</span>
            </div>
          </div>
          <div>
            <label htmlFor="title" className="block text-sm font-medium text-gray-700 mb-1">Title *</label>
            <input
              type="text"
              id="title"
              required
              value={formData.title}
              onChange={(e) => setFormData({ ...formData, title: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Cover image</label>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <input
                  ref={coverFileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={async (e) => {
                    const file = e.target.files?.[0]
                    if (!file) return
                    setCoverError('')
                    setCoverUploading(true)
                    const { data: url, error: uploadErr } = await uploadEventCover(file)
                    setCoverUploading(false)
                    if (coverFileInputRef.current) coverFileInputRef.current.value = ''
                    if (uploadErr) {
                      setCoverError(uploadErr.message)
                      return
                    }
                    if (url) setFormData((prev) => ({ ...prev, image_url: url }))
                  }}
                />
                <button
                  type="button"
                  onClick={() => coverFileInputRef.current?.click()}
                  disabled={coverUploading}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-md border border-gray-300 bg-white text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  <Upload className="h-4 w-4" />
                  {coverUploading ? 'Uploading…' : 'Upload from device'}
                </button>
                <span className="text-xs text-gray-500">max 500KB, compressed automatically</span>
              </div>
              <p className="text-xs text-gray-500">Or paste image URL:</p>
              <input
                type="url"
                id="image_url"
                value={formData.image_url}
                onChange={(e) => { setCoverError(''); setFormData({ ...formData, image_url: e.target.value }) }}
                placeholder="https://example.com/event-image.jpg"
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
              />
              {coverError && <p className="text-xs text-red-600">{coverError}</p>}
              {formData.image_url && (
                <div className="mt-1">
                  <img src={formData.image_url} alt="" className="h-24 w-auto rounded border border-gray-200 object-cover" onError={() => setFormData((prev) => ({ ...prev, image_url: '' }))} />
                </div>
              )}
            </div>
            <p className="text-xs text-gray-500 mt-1">Optional. Shows a photo on the card.</p>
          </div>
          <div>
            <label htmlFor="description" className="block text-sm font-medium text-gray-700 mb-1">Description</label>
            <textarea
              id="description"
              rows={4}
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
            />
          </div>
          <div>
            <label htmlFor="hashtags" className="block text-sm font-medium text-gray-700 mb-1">Hashtags</label>
            <input
              type="text"
              id="hashtags"
              value={hashtagsInput}
              onChange={(e) => {
                const raw = e.target.value || ''
                setHashtagsInput(raw)
                const parts = raw
                  .split(/[\s,]+/)
                  .map((p) => p.trim().replace(/^#/, ''))
                  .filter(Boolean)
                const unique = Array.from(new Set(parts)).slice(0, 5)
                setFormData((prev) => ({ ...prev, hashtags: unique }))
              }}
              placeholder="#summer #kids #camp (max 5)"
              className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
            />
            <p className="text-xs text-gray-500 mt-1">
              Add up to 5 short tags without spaces. They help you group and scan events later.
            </p>
          </div>
          </>
          )}
          </div>
          )}
          {step === 2 && (
          <div className="space-y-6">
          {formData.event_kind === 'reminder' ? (
            <div className="p-4 bg-gray-50 border border-gray-200 rounded-md">
              <p className="text-sm font-medium text-gray-700">You’re all set.</p>
              <p className="text-xs text-gray-500 mt-1">Click Create to add your reminder.</p>
            </div>
          ) : (
          <>
          <div>
            <label htmlFor="location" className="block text-sm font-medium text-gray-700 mb-1">Location</label>
            <input
              type="text"
              id="location"
              value={formData.location}
              onChange={(e) => setFormData({ ...formData, location: e.target.value })}
              placeholder="e.g. City Park, Brussels or Paris, France"
              className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
            />
            <p className="text-xs text-gray-500 mt-1">Venue, city, or address. Filled automatically when you paste a URL above.</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label htmlFor="start_date" className="block text-sm font-medium text-gray-700 mb-1">Start Date & Time *</label>
              <input
                type="datetime-local"
                id="start_date"
                required
                value={formData.start_date}
                onChange={(e) => setFormData({ ...formData, start_date: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
              />
            </div>
            <div>
              <label htmlFor="end_date" className="block text-sm font-medium text-gray-700 mb-1">End Date & Time</label>
              <input
                type="datetime-local"
                id="end_date"
                value={formData.end_date}
                onChange={(e) => setFormData({ ...formData, end_date: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
              />
            </div>
          </div>
          {formData.event_kind === 'event' && (
            <div>
              <label htmlFor="visit_date_time" className="block text-sm font-medium text-gray-700 mb-1">
                Visit date &amp; time (optional)
              </label>
              <input
                type="datetime-local"
                id="visit_date_time"
                value={visitDateTime}
                min={formData.start_date || undefined}
                max={formData.end_date || undefined}
                onChange={(e) => setVisitDateTime(e.target.value)}
                disabled={!hasValidRange}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
              />
              <p className="text-xs text-gray-500 mt-1">
                {hasValidRange
                  ? 'Choose when you plan to attend. You can set this now while creating the event.'
                  : 'Set both start and end date/time (with end after start) to enable visit date.'}
              </p>
            </div>
          )}
          {formData.event_kind === 'event' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label htmlFor="enrollment_start_date" className="block text-sm font-medium text-gray-700 mb-1">Registration opens</label>
              <input
                type="datetime-local"
                id="enrollment_start_date"
                value={formData.enrollment_start_date}
                onChange={(e) => setFormData({ ...formData, enrollment_start_date: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
              />
            </div>
            <div>
              <label htmlFor="enrollment_deadline" className="block text-sm font-medium text-gray-700 mb-1">Registration deadline</label>
              <input
                type="datetime-local"
                id="enrollment_deadline"
                value={formData.enrollment_deadline}
                onChange={(e) => setFormData({ ...formData, enrollment_deadline: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
              />
            </div>
          </div>
          )}
          {formData.event_kind === 'event' && (
          <p className="text-xs text-gray-500 -mt-2 mb-2">Optional. Leave both blank for walk-in events.</p>
          )}
          </>
          )}
          </div>
          )}
          {step === 3 && (
          <div className="space-y-6">
          {formData.event_kind === 'reminder' ? (
            <div className="p-4 bg-gray-50 border border-gray-200 rounded-md">
              <p className="text-sm font-medium text-gray-700">Reminders stay private</p>
              <p className="text-xs text-gray-500 mt-1">They are only visible to you. No sharing options.</p>
            </div>
          ) : (
          <div className="space-y-3 p-3 bg-gray-50 border border-gray-200 rounded-md">
            <p className="text-sm font-medium text-gray-700">Sharing</p>
            <p className="text-xs text-gray-500">By default this is private. You can share it so it appears in others’ My Family or My Friends — they’ll see it once they’re in your network.</p>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={formData.shared_with_family}
                onChange={(e) => setFormData({ ...formData, shared_with_family: e.target.checked })}
                className="h-4 w-4 rounded border-gray-300 text-indigo-600"
              />
              <span className="text-sm text-gray-700">Share with family</span>
            </label>
            <div>
              <span className="block text-sm font-medium text-gray-700 mb-2">Share with friends</span>
              <div className="flex flex-col gap-2">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="shared_with_friends"
                    checked={formData.shared_with_friends === 'none'}
                    onChange={() => setFormData({ ...formData, shared_with_friends: 'none', shared_with_user_ids: [] })}
                    className="h-4 w-4 border-gray-300 text-indigo-600"
                  />
                  <span className="text-sm text-gray-700">None</span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="shared_with_friends"
                    checked={formData.shared_with_friends === 'all'}
                    onChange={() => setFormData({ ...formData, shared_with_friends: 'all', shared_with_user_ids: [] })}
                    className="h-4 w-4 border-gray-300 text-indigo-600"
                  />
                  <span className="text-sm text-gray-700">All my friends</span>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="shared_with_friends"
                    checked={formData.shared_with_friends === 'selected'}
                    onChange={() => setFormData({ ...formData, shared_with_friends: 'selected' })}
                    className="h-4 w-4 border-gray-300 text-indigo-600"
                  />
                  <span className="text-sm text-gray-700">Selected friends</span>
                </label>
              </div>
              {formData.shared_with_friends === 'selected' && (
                <FriendPicker
                  selectedIds={formData.shared_with_user_ids}
                  onChange={(ids) => setFormData((prev) => ({ ...prev, shared_with_user_ids: ids }))}
                />
              )}
            </div>
            <div>
              <span className="block text-sm font-medium text-gray-700 mb-2">Share with groups</span>
              <p className="text-xs text-gray-500 mb-1">Events shared with a group are visible to everyone in that group.</p>
              <GroupPicker
                selectedIds={formData.shared_with_group_ids}
                onChange={(ids) => setFormData((prev) => ({ ...prev, shared_with_group_ids: ids }))}
              />
            </div>
          </div>
          )}
          </div>
          )}
          {step === 4 && (
          <div className="space-y-6">
          <p className="text-sm font-medium text-gray-700">Options</p>
          {formData.event_kind === 'reminder' && (
            <div className="p-4 bg-gray-50 border border-gray-200 rounded-md">
              <p className="text-sm text-gray-700">You’re all set. Use the button below to save.</p>
            </div>
          )}
          {formData.event_kind === 'event' && (
            <div className="space-y-3">
              <label className="flex items-start gap-2 p-3 bg-blue-50 border border-blue-200 rounded-md cursor-pointer">
                <input
                  type="checkbox"
                  checked={watchForNextOccurrence}
                  onChange={(e) => setWatchForNextOccurrence(e.target.checked)}
                  className="mt-1 h-4 w-4 text-indigo-600 rounded"
                />
                <span className="text-sm font-medium text-gray-700">Watch for next occurrence</span>
              </label>
              {!(formData.enrollment_url?.trim() || (event?.enrollment_url?.trim())) && (
                <p className="text-xs text-gray-500 px-3">Add an event or registration URL in Step 1 (Basics) for this to take effect.</p>
              )}
              {!event && formData.start_date && new Date(formData.start_date) < new Date() && (
                <label className="flex items-start gap-2 p-3 bg-gray-50 border border-gray-200 rounded-md cursor-pointer">
                  <input
                    type="checkbox"
                    checked={missedEvent}
                    onChange={(e) => setMissedEvent(e.target.checked)}
                    className="mt-1 h-4 w-4 text-gray-600 rounded"
                  />
                  <span className="text-sm font-medium text-gray-700">I missed this event</span>
                </label>
              )}
            </div>
          )}
          {event && event.event_kind === 'event' && (event.event_status === 'watching' || event.event_status === 'missed') && (
            <div className="space-y-2 p-3 bg-yellow-50 border border-yellow-200 rounded-md">
              <p className="text-sm font-medium text-yellow-800">This event is currently in your Watching list.</p>
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={convertFromWatching}
                  onChange={(e) => setConvertFromWatching(e.target.checked)}
                  className="mt-1 h-4 w-4 text-indigo-600 rounded"
                />
                <span className="text-sm text-gray-800">
                  Use the dates above as the actual event dates and move this out of Watching.
                </span>
              </label>
              <p className="text-xs text-gray-600">
                When checked, Plannen will treat this as a normal event (upcoming or past) instead of watching it for the next occurrence.
              </p>
            </div>
          )}
          </div>
          )}
          <div className="flex flex-wrap justify-end gap-2 sm:gap-3 pt-4 mt-auto border-t border-gray-200">
            {step > 1 ? (
              <button
                type="button"
                onClick={goBack}
                className="min-h-[44px] px-4 py-2.5 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 inline-flex items-center gap-1.5"
              >
                <ChevronLeft className="h-4 w-4" />
                Back
              </button>
            ) : (
              <button
                type="button"
                onClick={onClose}
                className="min-h-[44px] px-4 py-2.5 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
            )}
            {step < effectiveSteps ? (
              <>
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    goNext()
                  }}
                  className="min-h-[44px] px-4 py-2.5 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 inline-flex items-center gap-1.5"
                >
                  Next
                  <ChevronRight className="h-4 w-4" />
                </button>
                {formData.event_kind === 'reminder' && step === 1 && !event && (
                  <button
                    ref={createReminderButtonRef}
                    type="submit"
                    disabled={loading || !canSubmitReminderFromStep1()}
                    className="min-h-[44px] px-4 py-2.5 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50"
                  >
                    {loading ? 'Creating...' : 'Create'}
                  </button>
                )}
              </>
            ) : (
              <button
                ref={submitButtonRef}
                type="submit"
                disabled={loading}
                className="min-h-[44px] px-4 py-2.5 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50"
              >
                {loading ? 'Saving...' : event ? 'Update' : 'Create'}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  )
}
