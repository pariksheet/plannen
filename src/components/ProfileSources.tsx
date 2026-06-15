// src/components/ProfileSources.tsx
import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, Pencil, Check, X, ExternalLink, Search } from 'lucide-react'
import { dbClient } from '../lib/dbClient'
import type { SourceRow } from '../lib/dbClient/types'

/**
 * Read + tag surface for saved event sources (event_sources). These are
 * auto-captured on every event-with-URL create but were previously invisible
 * in the UI — only the agent could see or tag them. dbClient.sources exposes
 * list + update (no delete/search in the v0 contract), so search is
 * client-side and tags are editable inline.
 */
export function ProfileSources() {
  const [open, setOpen] = useState(false)
  const [sources, setSources] = useState<SourceRow[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [tagsInput, setTagsInput] = useState('')
  const [pendingId, setPendingId] = useState<string | null>(null)

  useEffect(() => {
    if (!open || loaded) return
    setLoading(true)
    setError(null)
    dbClient.sources.list({ limit: 200 })
      .then((rows) => { setSources(rows); setLoaded(true) })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load sources'))
      .finally(() => setLoading(false))
  }, [open, loaded])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return sources
    return sources.filter((s) => {
      const hay = [s.name, s.domain, s.source_type, ...(s.tags ?? [])]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
  }, [sources, query])

  const startEdit = (s: SourceRow) => {
    setEditingId(s.id)
    setTagsInput((s.tags ?? []).join(', '))
  }

  const handleSaveTags = async (s: SourceRow) => {
    const tags = Array.from(new Set(
      tagsInput.split(/[,\n]/).map((t) => t.trim().replace(/^#/, '')).filter(Boolean),
    ))
    setPendingId(s.id)
    setError(null)
    try {
      const updated = await dbClient.sources.update(s.id, { tags })
      setSources((prev) => prev.map((row) => (row.id === s.id ? updated : row)))
      setEditingId(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update tags')
    } finally {
      setPendingId(null)
    }
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-5 py-4 min-h-[56px] text-left"
      >
        <span className="font-semibold text-gray-900">My Sources</span>
        {open ? <ChevronUp className="h-4 w-4 text-gray-400" /> : <ChevronDown className="h-4 w-4 text-gray-400" />}
      </button>

      {open && (
        <div className="px-5 pb-5 border-t border-gray-100 pt-4 space-y-3">
          <p className="text-xs text-gray-500">Websites Plannen saved from event links. Tag them so discovery can find them again.</p>

          {loaded && sources.length > 0 && (
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="text"
                aria-label="Search sources"
                placeholder="Search by name, site, or tag"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-full pl-8 pr-3 py-2 min-h-[40px] text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          )}

          {loading && <p className="text-sm text-gray-500">Loading…</p>}
          {error && <p className="text-sm text-red-600">{error}</p>}
          {loaded && !loading && sources.length === 0 && (
            <p className="text-sm text-gray-500">No sources yet — they&apos;re saved automatically when you add an event with a link.</p>
          )}
          {loaded && !loading && sources.length > 0 && filtered.length === 0 && (
            <p className="text-sm text-gray-500">No sources match “{query}”.</p>
          )}

          <ul className="space-y-2">
            {filtered.map((s) => (
              <li key={s.id} className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-gray-900 truncate">{s.name || s.domain}</p>
                    <a
                      href={s.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline truncate max-w-full"
                    >
                      {s.domain}
                      <ExternalLink className="h-3 w-3 flex-shrink-0" />
                    </a>
                    {s.source_type && <span className="ml-2 text-xs text-gray-400">{s.source_type}</span>}
                  </div>
                  {editingId !== s.id && (
                    <button
                      type="button"
                      onClick={() => startEdit(s)}
                      className="p-2 min-h-[40px] min-w-[40px] flex items-center justify-center text-gray-400 hover:text-indigo-600 flex-shrink-0"
                      aria-label={`Edit tags for ${s.name || s.domain}`}
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                  )}
                </div>

                {editingId === s.id ? (
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      type="text"
                      aria-label="Tags"
                      value={tagsInput}
                      onChange={(e) => setTagsInput(e.target.value)}
                      placeholder="comma-separated tags"
                      className="flex-1 min-w-0 px-2 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    />
                    <button
                      type="button"
                      onClick={() => handleSaveTags(s)}
                      disabled={pendingId === s.id}
                      className="p-1.5 min-h-[40px] min-w-[40px] flex items-center justify-center text-green-600 hover:bg-green-50 rounded disabled:opacity-50"
                      aria-label="Save tags"
                    >
                      <Check className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      className="p-1.5 min-h-[40px] min-w-[40px] flex items-center justify-center text-gray-400 hover:bg-gray-100 rounded"
                      aria-label="Cancel"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ) : (
                  (s.tags?.length ?? 0) > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {s.tags!.map((t) => (
                        <span key={t} className="text-xs bg-indigo-50 text-indigo-700 rounded px-1.5 py-0.5">#{t}</span>
                      ))}
                    </div>
                  )
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
