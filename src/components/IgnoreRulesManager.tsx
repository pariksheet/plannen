import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, Trash2, BellOff } from 'lucide-react'
import { dbClient } from '../lib/dbClient'
import type { IgnoreRuleRow } from '../lib/dbClient/types'

/**
 * Lists and deletes the mailbox ignore rules ("muted senders") that
 * mailbox-sync respects. dbClient.ignoreRules has list/delete in both tiers;
 * previously these could only be added (via the mute dialog) or managed from
 * the /plannen-mailbox-rules command — never seen or removed from the UI.
 */
export function IgnoreRulesManager() {
  const [open, setOpen] = useState(false)
  const [rules, setRules] = useState<IgnoreRuleRow[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)

  useEffect(() => {
    if (!open || loaded) return
    setLoading(true)
    setError(null)
    dbClient.ignoreRules.list()
      .then((rows) => { setRules(rows); setLoaded(true) })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load rules'))
      .finally(() => setLoading(false))
  }, [open, loaded])

  const handleDelete = async (rule: IgnoreRuleRow) => {
    if (!window.confirm(`Stop muting "${rule.pattern}"? Future matching emails will sync again.`)) return
    setPendingId(rule.id)
    setError(null)
    try {
      await dbClient.ignoreRules.delete(rule.id)
      setRules((prev) => prev.filter((r) => r.id !== rule.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete rule')
    } finally {
      setPendingId(null)
    }
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-5 py-4 min-h-[56px] text-left"
      >
        <span className="inline-flex items-center gap-2 font-semibold text-gray-900">
          <BellOff className="h-4 w-4 text-gray-400" />
          Muted senders
          {loaded && rules.length > 0 && (
            <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-gray-100 text-gray-600 text-xs font-semibold">
              {rules.length}
            </span>
          )}
        </span>
        {open ? <ChevronUp className="h-4 w-4 text-gray-400" /> : <ChevronDown className="h-4 w-4 text-gray-400" />}
      </button>

      {open && (
        <div className="px-5 pb-5 border-t border-gray-100 pt-4 space-y-3">
          <p className="text-xs text-gray-500">
            Senders and subjects you&apos;ve muted from mailbox sync. Delete a rule to start
            syncing matching emails into Plannen again.
          </p>

          {loading && <p className="text-sm text-gray-500">Loading…</p>}
          {error && <p className="text-sm text-red-600">{error}</p>}
          {loaded && !loading && rules.length === 0 && (
            <p className="text-sm text-gray-500">No muted senders. You can mute one from an event created by mailbox sync.</p>
          )}

          <ul className="space-y-1">
            {rules.map((rule) => (
              <li
                key={rule.id}
                className="flex items-start gap-2 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm"
              >
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-gray-800 truncate">{rule.pattern}</p>
                  <p className="text-xs text-gray-500">
                    {rule.kind === 'domain' ? 'Domain' : rule.kind === 'domain_subject' ? 'Domain + subject' : 'Sender'}
                    {rule.subject_keyword ? ` · “${rule.subject_keyword}”` : ''}
                    {rule.hit_count > 0 && ` · muted ${rule.hit_count}×`}
                    {rule.reason ? ` · ${rule.reason}` : ''}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleDelete(rule)}
                  disabled={pendingId === rule.id}
                  className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-gray-400 hover:text-red-600 disabled:opacity-50 flex-shrink-0"
                  aria-label={`Delete mute rule for ${rule.pattern}`}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
