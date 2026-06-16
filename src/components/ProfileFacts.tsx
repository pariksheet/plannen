import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, Trash2, EyeOff, Pencil, Plus, Check, X } from 'lucide-react'
import { dbClient } from '../lib/dbClient'
import type { FactRow } from '../lib/dbClient/types'

/**
 * Surfaces the passively-extracted profile_facts the plugin writes on every
 * conversational turn. The user can read what Claude has inferred, mark
 * facts as historical (no longer true), or delete them outright. Closes the
 * audit's 03 RISKY-3 gap.
 */
export function ProfileFacts() {
  const [open, setOpen] = useState(false)
  const [facts, setFacts] = useState<FactRow[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [addForm, setAddForm] = useState({ subject: 'user', predicate: '', value: '' })
  const [saving, setSaving] = useState(false)
  const [correctingId, setCorrectingId] = useState<string | null>(null)
  const [correctValue, setCorrectValue] = useState('')

  useEffect(() => {
    if (!open || loaded) return
    setLoading(true)
    setError(null)
    dbClient.profile.listFacts({ limit: 200 })
      .then((rows) => { setFacts(rows); setLoaded(true) })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load facts'))
      .finally(() => setLoading(false))
  }, [open, loaded])

  const handleMarkHistorical = async (fact: FactRow) => {
    setPendingId(fact.id)
    setError(null)
    try {
      await dbClient.profile.upsertFact({
        subject: fact.subject,
        predicate: fact.predicate,
        value: fact.value,
        is_historical: true,
      })
      setFacts((prev) => prev.map((f) => f.id === fact.id ? { ...f, is_historical: true } : f))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to mark fact historical')
    } finally {
      setPendingId(null)
    }
  }

  const handleDelete = async (fact: FactRow) => {
    if (!window.confirm(`Forget that you ${fact.predicate.replace(/_/g, ' ')} ${fact.value}?`)) return
    setPendingId(fact.id)
    setError(null)
    try {
      await dbClient.profile.deleteFact(fact.id)
      setFacts((prev) => prev.filter((f) => f.id !== fact.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete fact')
    } finally {
      setPendingId(null)
    }
  }

  const handleAdd = async () => {
    const predicate = addForm.predicate.trim().replace(/\s+/g, '_')
    const value = addForm.value.trim()
    if (!predicate || !value) return
    setSaving(true)
    setError(null)
    try {
      const row = await dbClient.profile.upsertFact({
        subject: addForm.subject.trim() || 'user',
        predicate,
        value,
        confidence: 1,
        source: 'user',
      })
      setFacts((prev) => [...prev, row])
      setShowAdd(false)
      setAddForm({ subject: 'user', predicate: '', value: '' })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add fact')
    } finally {
      setSaving(false)
    }
  }

  const startCorrect = (fact: FactRow) => {
    setCorrectingId(fact.id)
    setCorrectValue(fact.value)
  }

  // Correct = replace: insert the corrected value, then forget the old row.
  // (profile_facts has no UPDATE route in Tier 0, so we compose from the
  // primitives that exist in every tier.)
  const handleCorrect = async (fact: FactRow) => {
    const value = correctValue.trim()
    if (!value || value === fact.value) { setCorrectingId(null); return }
    setPendingId(fact.id)
    setError(null)
    try {
      const row = await dbClient.profile.upsertFact({
        subject: fact.subject,
        predicate: fact.predicate,
        value,
        confidence: 1,
        source: 'user',
      })
      await dbClient.profile.deleteFact(fact.id)
      setFacts((prev) => prev.filter((f) => f.id !== fact.id).concat(row))
      setCorrectingId(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to correct fact')
    } finally {
      setPendingId(null)
    }
  }

  const grouped = facts.reduce<Record<string, FactRow[]>>((acc, f) => {
    const key = f.subject || 'user'
    if (!acc[key]) acc[key] = []
    acc[key].push(f)
    return acc
  }, {})

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-5 py-4 min-h-[56px] text-left"
      >
        <span className="font-semibold text-gray-900">
          Facts Claude knows about you
        </span>
        {open ? <ChevronUp className="h-4 w-4 text-gray-400" /> : <ChevronDown className="h-4 w-4 text-gray-400" />}
      </button>

      {open && (
        <div className="px-5 pb-5 border-t border-gray-100 pt-4 space-y-3">
          <p className="text-xs text-gray-500">
            Claude saves durable facts from your conversations (e.g.
            &quot;likes hiking&quot;, &quot;goes to school at …&quot;) so future
            suggestions are personalized. Mark a fact <em>historical</em> if it
            used to be true but no longer is, or delete it outright. Facts are
            stored locally in your Plannen database.
          </p>

          {loading && <p className="text-sm text-gray-500">Loading facts…</p>}
          {error && <p className="text-sm text-red-600">{error}</p>}
          {loaded && !loading && facts.length === 0 && (
            <p className="text-sm text-gray-500">
              Nothing yet — Claude will start saving facts as you have
              conversations about events, interests, or family.
            </p>
          )}

          {Object.entries(grouped).map(([subject, items]) => (
            <div key={subject} className="space-y-1">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                {subject === 'user' ? 'About you' : `About ${subject.slice(0, 8)}…`}
              </p>
              <ul className="space-y-1">
                {items.map((fact) => (
                  <li
                    key={fact.id}
                    className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${
                      fact.is_historical
                        ? 'border-gray-200 bg-gray-50 text-gray-500 line-through'
                        : 'border-gray-200 bg-white text-gray-800'
                    }`}
                  >
                    {correctingId === fact.id ? (
                      <span className="flex-1 flex items-center gap-2">
                        <span className="font-medium whitespace-nowrap">{fact.predicate.replace(/_/g, ' ')}</span>
                        <input
                          type="text"
                          aria-label="Corrected value"
                          value={correctValue}
                          onChange={(e) => setCorrectValue(e.target.value)}
                          className="flex-1 min-w-0 px-2 py-1 border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-indigo-500"
                        />
                        <button
                          type="button"
                          onClick={() => handleCorrect(fact)}
                          disabled={pendingId === fact.id}
                          className="p-1.5 min-h-[40px] min-w-[40px] flex items-center justify-center text-green-600 hover:bg-green-50 rounded disabled:opacity-50 flex-shrink-0"
                          aria-label="Save correction"
                        >
                          <Check className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setCorrectingId(null)}
                          className="p-1.5 min-h-[40px] min-w-[40px] flex items-center justify-center text-gray-400 hover:bg-gray-100 rounded flex-shrink-0"
                          aria-label="Cancel correction"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </span>
                    ) : (
                      <>
                        <span className="flex-1">
                          <span className="font-medium">{fact.predicate.replace(/_/g, ' ')}</span>
                          {' '}
                          <span>{fact.value}</span>
                          <span className="ml-2 text-xs text-gray-400">
                            ({Math.round(fact.confidence * 100)}%)
                          </span>
                        </span>
                        {!fact.is_historical && (
                          <button
                            type="button"
                            onClick={() => startCorrect(fact)}
                            disabled={pendingId === fact.id}
                            className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-gray-400 hover:text-indigo-600 disabled:opacity-50 flex-shrink-0"
                            title="Correct this fact"
                            aria-label="Correct fact"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                        )}
                        {!fact.is_historical && (
                          <button
                            type="button"
                            onClick={() => handleMarkHistorical(fact)}
                            disabled={pendingId === fact.id}
                            className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-gray-400 hover:text-amber-600 disabled:opacity-50 flex-shrink-0"
                            title="Mark as no longer true"
                            aria-label="Mark fact as historical"
                          >
                            <EyeOff className="h-4 w-4" />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleDelete(fact)}
                          disabled={pendingId === fact.id}
                          className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-gray-400 hover:text-red-600 disabled:opacity-50 flex-shrink-0"
                          title="Forget this fact"
                          aria-label="Delete fact"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}

          {loaded && !loading && (
            showAdd ? (
              <div className="border border-indigo-200 rounded-lg p-3 bg-indigo-50 space-y-2">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <input
                    type="text"
                    aria-label="Fact subject"
                    placeholder="Who (e.g. you)"
                    value={addForm.subject}
                    onChange={(e) => setAddForm((f) => ({ ...f, subject: e.target.value }))}
                    className="px-2 py-2 min-h-[40px] text-sm border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                  <input
                    type="text"
                    aria-label="Fact predicate"
                    placeholder="relation (e.g. likes)"
                    value={addForm.predicate}
                    onChange={(e) => setAddForm((f) => ({ ...f, predicate: e.target.value }))}
                    className="px-2 py-2 min-h-[40px] text-sm border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                  <input
                    type="text"
                    aria-label="Fact value"
                    placeholder="value (e.g. hiking)"
                    value={addForm.value}
                    onChange={(e) => setAddForm((f) => ({ ...f, value: e.target.value }))}
                    className="px-2 py-2 min-h-[40px] text-sm border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => { setShowAdd(false); setAddForm({ subject: 'user', predicate: '', value: '' }) }}
                    className="min-h-[40px] px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleAdd}
                    disabled={saving || !addForm.predicate.trim() || !addForm.value.trim()}
                    className="min-h-[40px] px-3 py-1.5 text-sm font-medium text-white bg-indigo-600 rounded hover:bg-indigo-700 disabled:opacity-50"
                  >
                    {saving ? 'Saving…' : 'Add fact'}
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowAdd(true)}
                className="inline-flex items-center gap-1 min-h-[40px] px-2 py-1.5 text-sm text-indigo-600 hover:text-indigo-700 font-medium"
              >
                <Plus className="h-4 w-4" />
                Add a fact
              </button>
            )
          )}
        </div>
      )}
    </div>
  )
}
