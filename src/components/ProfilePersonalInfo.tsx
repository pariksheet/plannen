// src/components/ProfilePersonalInfo.tsx
import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { getProfile, upsertProfile } from '../services/profileService'

// Full IANA timezone list from the platform when available, with a small
// curated fallback for older runtimes. Saved values not in the list are still
// offered (see the leading <option> in the select) so nothing is ever dropped.
const TIMEZONES: string[] = (() => {
  try {
    const supported = (Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf
    const list = supported?.('timeZone')
    if (list && list.length) return list
  } catch { /* fall through to the curated list */ }
  return [
    'UTC', 'Europe/Brussels', 'Europe/London', 'Europe/Amsterdam', 'Europe/Paris',
    'America/New_York', 'America/Chicago', 'America/Los_Angeles',
    'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney',
  ]
})()

export function ProfilePersonalInfo() {
  const { profile: authProfile, refreshProfile } = useAuth()
  const fullName = authProfile?.full_name ?? ''

  const [open, setOpen] = useState(true)
  const [editName, setEditName] = useState(fullName)
  const [editDob, setEditDob] = useState('')
  const [editTz, setEditTz] = useState('UTC')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const { data, error } = await getProfile()
      if (cancelled) return
      if (error) setError(error.message)
      setEditDob(data?.dob ?? '')
      setEditTz(data?.timezone ?? 'UTC')
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [])

  // Resync name when AuthContext updates (e.g. Claude session writes via
  // update_profile while the page is open). Audit RISKY-1.
  useEffect(() => { setEditName(fullName) }, [fullName])

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      const trimmedName = editName.trim()
      const namePatch = trimmedName && trimmedName !== fullName ? { full_name: trimmedName } : {}
      const { error } = await upsertProfile({
        ...namePatch,
        dob: editDob || null,
        timezone: editTz.trim() || 'UTC',
      })
      if (error) { setError(error.message); return }
      // full_name lives on plannen.users; refresh AuthContext so the header
      // avatar / name update.
      if ('full_name' in namePatch) await refreshProfile()
    } finally {
      setSaving(false)
    }
  }

  const todayIso = new Date().toISOString().slice(0, 10)

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-5 py-4 min-h-[56px] text-left"
      >
        <span className="font-semibold text-gray-900">Personal Info</span>
        {open ? <ChevronUp className="h-4 w-4 text-gray-400" /> : <ChevronDown className="h-4 w-4 text-gray-400" />}
      </button>

      {open && (
        <div className="px-5 pb-5 grid grid-cols-1 sm:grid-cols-2 gap-4 border-t border-gray-100">
          {error && (
            <div className="sm:col-span-2 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">{error}</div>
          )}
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
              Full name
            </label>
            <input
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              className="w-full px-3 py-2 min-h-[44px] text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
              Date of birth
            </label>
            {loading ? (
              <div className="h-[44px] bg-gray-100 rounded-lg animate-pulse" aria-busy="true" />
            ) : (
              <input
                type="date"
                value={editDob}
                max={todayIso}
                onChange={(e) => setEditDob(e.target.value)}
                className="w-full px-3 py-2 min-h-[44px] text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            )}
          </div>
          <div className="sm:col-span-2">
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
              Timezone
            </label>
            {loading ? (
              <div className="h-[44px] bg-gray-100 rounded-lg animate-pulse" aria-busy="true" />
            ) : (
              <select
                value={editTz}
                onChange={(e) => setEditTz(e.target.value)}
                aria-label="Timezone"
                className="w-full px-3 py-2 min-h-[44px] text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                {!TIMEZONES.includes(editTz) && <option value={editTz}>{editTz}</option>}
                {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
              </select>
            )}
            <p className="mt-1 text-xs text-gray-400">
              IANA timezone — used for Google Calendar sync and time display.
              Claude can set this automatically — just tell Plannen your city.
            </p>
          </div>
          <div className="sm:col-span-2 flex justify-end">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || loading}
              className="min-h-[44px] px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
