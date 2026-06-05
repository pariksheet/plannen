import { useCallback, useEffect, useState } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { ConfirmModal } from './Modal'
import {
  listEventNotes,
  createNote,
  updateNote,
  deleteNote,
  type EventNote,
} from '../services/noteService'

interface EventNotesProps {
  eventId: string
}

function relativeTime(iso: string): string {
  const now = Date.now()
  const then = new Date(iso).getTime()
  const seconds = Math.floor((now - then) / 1000)
  if (seconds < 45) return 'just now'
  if (seconds < 90) return '1 min ago'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 45) return `${minutes} min ago`
  if (minutes < 90) return '1 hour ago'
  const hours = Math.floor(minutes / 60)
  if (hours < 22) return `${hours} hours ago`
  if (hours < 36) return 'yesterday'
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} days ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function authorLabel(note: EventNote, currentUserId: string | undefined): string {
  if (currentUserId && note.user_id === currentUserId) return 'You'
  const a = note.author
  if (a?.full_name?.trim()) return a.full_name.trim()
  if (a?.email?.trim()) return a.email.trim()
  return `Member ${note.user_id.slice(0, 8)}`
}

export function EventNotes({ eventId }: EventNotesProps) {
  const { user } = useAuth()
  const currentUserId = user?.id
  const [notes, setNotes] = useState<EventNote[]>([])
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingBody, setEditingBody] = useState('')
  const [deleteId, setDeleteId] = useState<string | null>(null)

  const load = useCallback(async () => {
    const { data, error: err } = await listEventNotes(eventId)
    if (err) setError(err.message)
    else setError(null)
    setNotes(data)
    setLoading(false)
  }, [eventId])

  useEffect(() => { void load() }, [load])

  const handleAdd = async () => {
    const body = draft.trim()
    if (!body || submitting) return
    setSubmitting(true)
    setError(null)
    const { error: err } = await createNote(eventId, body)
    setSubmitting(false)
    if (err) {
      setError(err.message)
      return
    }
    setDraft('')
    void load()
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter submits, Shift+Enter inserts a newline.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleAdd()
    }
  }

  const startEdit = (note: EventNote) => {
    setEditingId(note.id)
    setEditingBody(note.body)
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditingBody('')
  }

  const saveEdit = async () => {
    if (!editingId) return
    const body = editingBody.trim()
    if (!body) return
    setError(null)
    const { error: err } = await updateNote(editingId, body)
    if (err) {
      setError(err.message)
      return
    }
    setEditingId(null)
    setEditingBody('')
    void load()
  }

  const confirmDelete = async () => {
    if (!deleteId) return
    setError(null)
    const { error: err } = await deleteNote(deleteId)
    setDeleteId(null)
    if (err) {
      setError(err.message)
      return
    }
    void load()
  }

  return (
    <div className="mt-6">
      <h4 className="text-sm font-medium text-gray-700 mb-2">
        Notes{notes.length > 0 ? ` (${notes.length})` : ''}
      </h4>

      <div className="rounded-md border border-gray-200 bg-white p-3">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={2}
          placeholder="add your thoughts"
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            disabled={!draft.trim() || submitting}
            onClick={handleAdd}
            className="inline-flex items-center min-h-[40px] px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 disabled:opacity-50"
          >
            {submitting ? 'Saving…' : 'Add note'}
          </button>
        </div>
      </div>

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      {loading ? (
        <p className="mt-3 text-sm text-gray-500">Loading notes…</p>
      ) : notes.length === 0 ? null : (
        <ul className="mt-3 space-y-2">
          {notes.map((note) => {
            const own = currentUserId === note.user_id
            const isEditing = editingId === note.id
            return (
              <li key={note.id} className="rounded-md border border-gray-200 bg-white p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs text-gray-500">
                    <span className="font-medium text-gray-700">{authorLabel(note, currentUserId)}</span>
                    <span aria-hidden> · </span>
                    <span title={new Date(note.created_at).toLocaleString()}>{relativeTime(note.created_at)}</span>
                    {note.updated_at && note.updated_at !== note.created_at && (
                      <span className="ml-1 italic">(edited)</span>
                    )}
                  </div>
                  {own && !isEditing && (
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => startEdit(note)}
                        className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded"
                        aria-label="Edit note"
                        title="Edit"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteId(note.id)}
                        className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-red-500 hover:text-red-700 hover:bg-red-50 rounded"
                        aria-label="Delete note"
                        title="Delete"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  )}
                </div>
                {isEditing ? (
                  <div className="mt-2">
                    <textarea
                      value={editingBody}
                      onChange={(e) => setEditingBody(e.target.value)}
                      rows={3}
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      autoFocus
                    />
                    <div className="mt-2 flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={cancelEdit}
                        className="min-h-[36px] px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={saveEdit}
                        disabled={!editingBody.trim()}
                        className="min-h-[36px] px-3 py-1.5 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 disabled:opacity-50"
                      >
                        Save
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="mt-1 text-sm text-gray-800 whitespace-pre-wrap break-words">{note.body}</p>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <ConfirmModal
        isOpen={!!deleteId}
        onClose={() => setDeleteId(null)}
        title="Delete this note?"
        message="The note will be permanently removed."
        confirmText="Delete"
        cancelText="Cancel"
        variant="danger"
        onConfirm={confirmDelete}
      />
    </div>
  )
}
