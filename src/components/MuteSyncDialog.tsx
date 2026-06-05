import { useEffect, useState } from 'react'
import { Modal } from './Modal'
import type { EventProvenanceRow, IgnoreRuleKind } from '../lib/dbClient/types'

export interface MuteSyncConfirmSpec {
  kind: IgnoreRuleKind
  pattern: string
  subject_keyword: string | null
  alsoDeleteCurrent: boolean
}

interface Props {
  isOpen: boolean
  onClose: () => void
  onConfirm: (spec: MuteSyncConfirmSpec) => void
  eventId: string
  provenance: EventProvenanceRow | null
  /** Event description — used to extract Gmail-ID for legacy #mbsync events with no provenance row. */
  eventDescription?: string | null
}

function extractGmailId(description: string | null | undefined): string | null {
  if (!description) return null
  const m = description.match(/^Gmail-ID:\s*(\S+)/)
  return m ? m[1] : null
}

const GENERIC_WORDS = new Set([
  'policy', 'notice', 'reminder', 'update', 'alert', 'info', 'your', 'this',
  'from', 'with', 'about', 'dear', 'hello', 'please', 'thank', 'thanks',
])

function defaultSubjectKeyword(subject: string | null | undefined): string {
  if (!subject) return ''
  const words = subject.split(/\s+/)
  const word = words.find((w) => w.length > 3 && !/^[\d\-]+$/.test(w) && !GENERIC_WORDS.has(w.toLowerCase()))
  return word ?? ''
}

export function MuteSyncDialog({ isOpen, onClose, onConfirm, eventId: _eventId, provenance, eventDescription }: Props) {
  const legacyGmailId = extractGmailId(eventDescription)
  const hasProvenance = provenance !== null
  const defaultKind: IgnoreRuleKind = hasProvenance ? 'domain' : 'sender'
  const [kind, setKind] = useState<IgnoreRuleKind>(defaultKind)
  const [manualPattern, setManualPattern] = useState('')
  const [subjectKeyword, setSubjectKeyword] = useState(defaultSubjectKeyword(provenance?.subject))
  const [alsoDelete, setAlsoDelete] = useState(true)

  // If provenance arrives asynchronously after the dialog mounted, switch the
  // selected kind to the new default and prefill the subject. Without this,
  // the user sees the three-option radio but the (stale) sender option stays
  // checked — they confirm thinking they picked the spec's "domain" default.
  useEffect(() => {
    if (provenance) {
      setKind((current) => (current === 'sender' ? 'domain' : current))
      setSubjectKeyword((current) => (current === '' ? defaultSubjectKeyword(provenance.subject) : current))
    }
  }, [provenance])

  const senderPattern = provenance?.sender_email ?? ''
  const domainPattern = provenance?.sender_domain ?? ''

  function patternFor(k: IgnoreRuleKind): string {
    if (!hasProvenance) return manualPattern.trim()
    if (k === 'sender') return senderPattern
    return domainPattern
  }

  function handleSubmit() {
    const pattern = patternFor(kind)
    if (!pattern) return
    onConfirm({
      kind,
      pattern,
      subject_keyword: kind === 'domain_subject' ? subjectKeyword.trim() || null : null,
      alsoDeleteCurrent: alsoDelete,
    })
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Mute future events from this source">
      <div className="space-y-4">
        {hasProvenance ? (
          <fieldset className="space-y-2">
            <legend className="sr-only">What to mute</legend>
            <label className="flex items-start gap-2">
              <input type="radio" name="mute-kind" value="sender" checked={kind === 'sender'} onChange={() => setKind('sender')} className="mt-1" />
              <span><strong>Mute this sender</strong> — <code className="text-xs">{senderPattern}</code></span>
            </label>
            <label className="flex items-start gap-2">
              <input type="radio" name="mute-kind" value="domain" checked={kind === 'domain'} onChange={() => setKind('domain')} className="mt-1" aria-label="Mute this whole domain" />
              <span><strong>Mute this whole domain</strong> — <code className="text-xs">{domainPattern}</code></span>
            </label>
            <label className="flex items-start gap-2">
              <input type="radio" name="mute-kind" value="domain_subject" checked={kind === 'domain_subject'} onChange={() => setKind('domain_subject')} className="mt-1" />
              <span className="flex-1">
                <strong>Mute domain + subject keyword</strong> — <code className="text-xs">{domainPattern}</code> containing{' '}
                <input
                  type="text"
                  value={subjectKeyword}
                  onChange={(e) => setSubjectKeyword(e.target.value)}
                  disabled={kind !== 'domain_subject'}
                  className="ml-1 px-2 py-1 text-sm border border-gray-300 rounded-md disabled:opacity-50 w-32"
                  placeholder="renewal"
                />
              </span>
            </label>
          </fieldset>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-gray-600">This event has no recorded source (created before per-event provenance was added). Type the sender's email below, or open the original Gmail thread to find it:</p>
            {legacyGmailId && (
              <a
                href={`https://mail.google.com/mail/u/0/#inbox/${legacyGmailId}`}
                target="_blank"
                rel="noopener noreferrer"
                title="Open original email in Gmail to copy the sender address"
                aria-label="Open original email in Gmail"
                className="inline-flex items-center gap-2 min-h-[44px] px-3 py-2 rounded-md border border-gray-300 hover:bg-red-50 hover:border-red-300 text-red-600 text-sm"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden="true">
                  <path d="M22 6.5v11c0 .8-.7 1.5-1.5 1.5H18V8.6l-6 4.4-6-4.4V19H3.5C2.7 19 2 18.3 2 17.5v-11C2 5.7 2.7 5 3.5 5h.3l8.2 6 8.2-6h.3c.8 0 1.5.7 1.5 1.5z" />
                </svg>
                Open original to find sender
              </a>
            )}
            <input
              type="text"
              value={manualPattern}
              onChange={(e) => setManualPattern(e.target.value)}
              placeholder="email address (e.g. noreply@example.com)"
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md"
            />
          </div>
        )}

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={alsoDelete} onChange={(e) => setAlsoDelete(e.target.checked)} aria-label="Also delete this event" />
          Also delete this event
        </label>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="min-h-[44px] px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 rounded-md">Cancel</button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!patternFor(kind)}
            className="min-h-[44px] px-4 py-2 text-sm bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50"
          >
            Mute
          </button>
        </div>
      </div>
    </Modal>
  )
}
