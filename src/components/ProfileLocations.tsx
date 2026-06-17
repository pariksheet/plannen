// src/components/ProfileLocations.tsx
import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, Pencil, Trash2, MapPin } from 'lucide-react'
import {
  UserLocation,
  getLocations,
  addLocation,
  updateLocation,
  deleteLocation,
} from '../services/profileService'

const EMPTY_FORM = { label: '', address: '', city: '', country: '', is_default: false }

export function ProfileLocations() {
  const [open, setOpen] = useState(false)
  const [locations, setLocations] = useState<UserLocation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const { data, error } = await getLocations()
      if (cancelled) return
      if (error) setError(error.message)
      setLocations(data)
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [])

  function startAdd() {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setShowForm(true)
  }

  function startEdit(loc: UserLocation) {
    setEditingId(loc.id)
    setForm({ label: loc.label, address: loc.address, city: loc.city, country: loc.country, is_default: loc.is_default })
    setShowForm(true)
  }

  async function handleSubmit() {
    if (!form.label.trim()) return
    setSaving(true)
    setError(null)
    try {
      if (editingId) {
        const id = editingId
        const { error } = await updateLocation(id, form)
        if (error) { setError(error.message); return }
        setLocations((prev) => prev.map((l) =>
          l.id === id
            ? { ...l, ...form }
            : (form.is_default ? { ...l, is_default: false } : l),
        ))
      } else {
        const { data, error } = await addLocation(form)
        if (error) { setError(error.message); return }
        if (data) {
          setLocations((prev) => [
            ...(form.is_default ? prev.map((l) => ({ ...l, is_default: false })) : prev),
            data,
          ])
        }
      }
      setShowForm(false)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    setError(null)
    const { error } = await deleteLocation(id)
    if (error) { setError(error.message); return }
    setLocations((prev) => prev.filter((l) => l.id !== id))
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-5 py-4 text-left"
      >
        <span className="font-semibold text-gray-900">My Locations</span>
        {open ? <ChevronUp className="h-4 w-4 text-gray-400" /> : <ChevronDown className="h-4 w-4 text-gray-400" />}
      </button>

      {open && (
        <div className="px-5 pb-5 border-t border-gray-100 space-y-3 pt-4">
          {error && (
            <div className="p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">{error}</div>
          )}
          {loading ? (
            <div className="space-y-2" aria-busy="true">
              <div className="h-14 bg-gray-100 rounded-lg animate-pulse" />
              <div className="h-14 bg-gray-100 rounded-lg animate-pulse" />
            </div>
          ) : (
            <>
              {locations.map((loc) => (
                <div
                  key={loc.id}
                  className={`flex items-start gap-3 rounded-lg p-3 border ${loc.is_default ? 'border-green-300 bg-green-50' : 'border-gray-200 bg-gray-50'}`}
                >
                  <MapPin className={`h-4 w-4 mt-0.5 flex-shrink-0 ${loc.is_default ? 'text-green-600' : 'text-gray-400'}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-gray-900">{loc.label}</span>
                      {loc.is_default && (
                        <span className="text-xs bg-green-600 text-white rounded px-1.5 py-0.5">default</span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 truncate">{[loc.city, loc.country].filter(Boolean).join(', ') || loc.address}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => startEdit(loc)}
                    className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-gray-400 hover:text-gray-600 flex-shrink-0"
                    aria-label={`Edit ${loc.label}`}
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(loc.id)}
                    className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-gray-400 hover:text-red-500 flex-shrink-0"
                    aria-label={`Delete ${loc.label}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}

              {showForm && (
                <div className="border border-indigo-200 rounded-lg p-4 bg-indigo-50 space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Label *</label>
                      <input
                        type="text"
                        placeholder="Home"
                        value={form.label}
                        onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
                        className="w-full px-3 py-2 min-h-[44px] text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">City</label>
                      <input
                        type="text"
                        placeholder="Antwerp"
                        value={form.city}
                        onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))}
                        className="w-full px-3 py-2 min-h-[44px] text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Country</label>
                      <input
                        type="text"
                        placeholder="Belgium"
                        value={form.country}
                        onChange={(e) => setForm((f) => ({ ...f, country: e.target.value }))}
                        className="w-full px-3 py-2 min-h-[44px] text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Full address</label>
                      <input
                        type="text"
                        placeholder="Optional"
                        value={form.address}
                        onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
                        className="w-full px-3 py-2 min-h-[44px] text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.is_default}
                      onChange={(e) => setForm((f) => ({ ...f, is_default: e.target.checked }))}
                      className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                    />
                    Set as default for searches
                  </label>
                  <div className="flex flex-wrap gap-2 justify-end">
                    <button
                      type="button"
                      onClick={() => { setShowForm(false); setForm(EMPTY_FORM); setEditingId(null) }}
                      className="min-h-[44px] px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleSubmit}
                      disabled={saving || !form.label.trim()}
                      className="min-h-[44px] px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                    >
                      {saving ? 'Saving…' : editingId ? 'Update' : 'Add'}
                    </button>
                  </div>
                </div>
              )}

              {!showForm && (
                <button
                  type="button"
                  onClick={startAdd}
                  className="min-h-[44px] px-3 py-2 text-sm text-indigo-600 hover:text-indigo-700 font-medium inline-flex items-center"
                >
                  + Add location
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
