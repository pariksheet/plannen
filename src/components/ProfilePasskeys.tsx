// src/components/ProfilePasskeys.tsx
import { useEffect, useState, useCallback } from 'react'
import { ChevronDown, ChevronUp, Fingerprint, Plus, Trash2, Pencil, Check, X } from 'lucide-react'
import { PasskeyListItem } from '@supabase/supabase-js'
import { useAuth, passkeysSupported } from '../context/AuthContext'

function formatDate(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export function ProfilePasskeys() {
  const { passkeysEnabled, listPasskeys, registerPasskey, renamePasskey, deletePasskey } = useAuth()
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<PasskeyListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)

  const supported = passkeysSupported()

  const refresh = useCallback(async () => {
    if (!passkeysEnabled) {
      setLoading(false)
      return
    }
    setError(null)
    const { data, error: err } = await listPasskeys()
    if (err) {
      setError(err.message)
      setLoading(false)
      return
    }
    setItems(data ?? [])
    setLoading(false)
  }, [passkeysEnabled, listPasskeys])

  useEffect(() => {
    refresh()
  }, [refresh])

  if (!passkeysEnabled) return null

  async function handleAdd() {
    setAdding(true)
    setError(null)
    const { error: err } = await registerPasskey()
    setAdding(false)
    if (err) {
      setError(err.message)
      return
    }
    await refresh()
  }

  function startRename(item: PasskeyListItem) {
    setEditingId(item.id)
    setEditName(item.friendly_name ?? '')
  }

  async function commitRename(id: string) {
    const name = editName.trim()
    if (!name) {
      setEditingId(null)
      return
    }
    setBusyId(id)
    setError(null)
    const { error: err } = await renamePasskey(id, name)
    setBusyId(null)
    setEditingId(null)
    if (err) { setError(err.message); return }
    await refresh()
  }

  async function handleDelete(id: string) {
    if (!window.confirm('Delete this passkey? You\'ll need to sign in with email next time, then enrol again.')) return
    setBusyId(id)
    setError(null)
    const { error: err } = await deletePasskey(id)
    setBusyId(null)
    if (err) { setError(err.message); return }
    await refresh()
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-5 py-4 min-h-[56px] text-left"
      >
        <span className="font-semibold text-gray-900 flex items-center gap-2">
          <Fingerprint className="h-4 w-4 text-indigo-600" />
          Passkeys
          {!loading && items.length > 0 && (
            <span className="text-xs font-normal text-gray-500">({items.length})</span>
          )}
        </span>
        {open ? <ChevronUp className="h-4 w-4 text-gray-400" /> : <ChevronDown className="h-4 w-4 text-gray-400" />}
      </button>

      {open && (
        <div className="px-5 pb-5 border-t border-gray-100 space-y-3">
          {!supported && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2 mt-3">
              This browser doesn&apos;t expose WebAuthn — passkey management is read-only.
            </p>
          )}

          {error && (
            <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2 mt-3">{error}</p>
          )}

          {loading ? (
            <p className="text-sm text-gray-500 mt-3">Loading passkeys…</p>
          ) : items.length === 0 ? (
            <p className="text-sm text-gray-500 mt-3">No passkeys yet. Add one so you can skip the email code next time.</p>
          ) : (
            <ul className="mt-3 divide-y divide-gray-100">
              {items.map((item) => {
                const isEditing = editingId === item.id
                const busy = busyId === item.id
                return (
                  <li key={item.id} className="py-3 flex flex-wrap items-center gap-3">
                    <Fingerprint className="h-4 w-4 text-gray-400 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      {isEditing ? (
                        <input
                          type="text"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value.slice(0, 120))}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitRename(item.id)
                            if (e.key === 'Escape') setEditingId(null)
                          }}
                          autoFocus
                          className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-indigo-500"
                          placeholder="Device name"
                        />
                      ) : (
                        <p className="text-sm font-medium text-gray-900 truncate">
                          {item.friendly_name?.trim() || 'Unnamed passkey'}
                        </p>
                      )}
                      <p className="text-xs text-gray-500">
                        Added {formatDate(item.created_at)}
                        {item.last_used_at && ` · last used ${formatDate(item.last_used_at)}`}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      {isEditing ? (
                        <>
                          <button
                            type="button"
                            onClick={() => commitRename(item.id)}
                            disabled={busy}
                            aria-label="Save name"
                            className="p-2 min-h-[36px] rounded text-indigo-600 hover:bg-indigo-50 disabled:opacity-50"
                          >
                            <Check className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingId(null)}
                            aria-label="Cancel"
                            className="p-2 min-h-[36px] rounded text-gray-500 hover:bg-gray-100"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => startRename(item)}
                            disabled={busy}
                            aria-label="Rename passkey"
                            className="p-2 min-h-[36px] rounded text-gray-500 hover:bg-gray-100 disabled:opacity-50"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDelete(item.id)}
                            disabled={busy}
                            aria-label="Delete passkey"
                            className="p-2 min-h-[36px] rounded text-red-600 hover:bg-red-50 disabled:opacity-50"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}

          {supported && (
            <button
              type="button"
              onClick={handleAdd}
              disabled={adding}
              className="mt-3 w-full sm:w-auto flex items-center justify-center gap-2 px-4 py-2 min-h-[40px] text-sm font-medium rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />
              {adding ? 'Waiting for device…' : 'Add a passkey'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
