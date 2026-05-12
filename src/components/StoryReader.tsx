import { useEffect, useState } from 'react'
import { useParams, useSearchParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, Expand, Image as ImageIcon, Pencil, Trash2, X } from 'lucide-react'
import { useStory } from '../hooks/useStory'
import { updateStory, deleteStory } from '../services/storyService'
import { formatStorySubtitle } from '../utils/storySubtitle'
import { labelFor } from '../utils/storyLanguages'
import { CoverPicker } from './CoverPicker'
import { StoryPhotoStrip, type StripPhoto } from './StoryPhotoStrip'

const PLACEHOLDER_GRADIENT = 'bg-gradient-to-br from-indigo-300 via-purple-300 to-pink-300'

function bodyToParagraphs(body: string): string[] {
  return body.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
}

export function StoryReader() {
  const { id } = useParams<{ id: string }>()
  const [params] = useSearchParams()
  const startInEdit = params.get('edit') === '1'
  const navigate = useNavigate()
  const { story, loading, error, refresh } = useStory(id)

  const [editing, setEditing] = useState(startInEdit)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftBody, setDraftBody] = useState('')
  const [saving, setSaving] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [activePhoto, setActivePhoto] = useState<StripPhoto | null>(null)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (!expanded) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setExpanded(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded])

  useEffect(() => {
    if (story && editing) {
      setDraftTitle(story.title)
      setDraftBody(story.body)
    }
  }, [story, editing])

  if (loading) return <div className="text-gray-500 py-12 text-center">Loading…</div>
  if (error) return <div className="text-red-600 py-12 text-center">{error.message}</div>
  if (!story) return <div className="text-gray-500 py-12 text-center">Story not found.</div>

  const subtitle = formatStorySubtitle(story)
  const linkedEventIds = story.events.map(e => e.id)

  const onSave = async () => {
    if (!draftTitle.trim() || !draftBody.trim()) {
      setSaveError('Title and body are required.')
      return
    }
    try {
      setSaving(true)
      setSaveError(null)
      await updateStory(story.id, { title: draftTitle, body: draftBody })
      setEditing(false)
      await refresh()
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const onCoverChosen = async (url: string) => {
    setPickerOpen(false)
    await updateStory(story.id, { cover_url: url })
    await refresh()
  }

  const onDelete = async () => {
    await deleteStory(story.id)
    navigate('/dashboard?view=stories')
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      <button type="button" onClick={() => navigate('/dashboard?view=stories')} className="text-sm text-gray-600 hover:text-gray-900 inline-flex items-center gap-1 mb-4">
        <ArrowLeft className="h-4 w-4" /> Back to My Stories
      </button>

      <div className="relative rounded-xl overflow-hidden mb-3 group">
        {(activePhoto?.url ?? story.cover_url) ? (
          <>
            <img
              src={activePhoto?.url ?? story.cover_url ?? ''}
              alt=""
              className="w-full max-h-[50vh] object-cover"
            />
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="absolute inset-0 flex items-end justify-end p-3 cursor-zoom-in focus:outline-none"
              aria-label="View full photo"
            >
              <span className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity inline-flex items-center gap-1 px-2 py-1 rounded-md bg-black/55 text-white text-xs">
                <Expand className="h-3.5 w-3.5" /> View full
              </span>
            </button>
          </>
        ) : (
          <div className={`w-full aspect-[21/9] ${PLACEHOLDER_GRADIENT}`} aria-hidden="true" />
        )}
      </div>
      {activePhoto?.caption && (
        <p className="text-sm text-gray-600 italic text-center mb-2">{activePhoto.caption}</p>
      )}

      <StoryPhotoStrip
        eventIds={linkedEventIds}
        coverUrl={story.cover_url}
        selectedUrl={activePhoto?.url ?? null}
        onSelect={setActivePhoto}
      />

      {story.siblings.length > 1 && (
        <div className="flex items-center gap-2 mt-3 flex-wrap" aria-label="Story translations">
          <span className="text-xs uppercase tracking-wide text-gray-500">Languages:</span>
          {story.siblings.map(s => {
            const active = s.id === story.id
            return active ? (
              <span
                key={s.id}
                className="px-2 py-0.5 rounded-full text-xs border border-indigo-500 bg-indigo-50 text-indigo-700"
                aria-current="page"
              >
                {labelFor(s.language)}
              </span>
            ) : (
              <Link
                key={s.id}
                to={`/stories/${s.id}`}
                className="px-2 py-0.5 rounded-full text-xs border border-gray-300 text-gray-700 hover:bg-gray-50"
              >
                {labelFor(s.language)}
              </Link>
            )
          })}
        </div>
      )}

      <div className="mt-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wide text-gray-500">{subtitle}</div>
          {!editing ? (
            <h1 className="text-3xl font-bold text-gray-900 mt-1">{story.title}</h1>
          ) : (
            <input
              value={draftTitle}
              onChange={e => setDraftTitle(e.target.value)}
              className="w-full text-3xl font-bold text-gray-900 mt-1 border-b border-gray-300 focus:border-indigo-500 outline-none"
              aria-label="Title"
            />
          )}
        </div>
        {!editing && (
          <div className="flex items-center gap-2 flex-shrink-0">
            <button type="button" onClick={() => setEditing(true)} className="text-sm text-gray-700 hover:bg-gray-100 px-2 py-1 rounded inline-flex items-center gap-1"><Pencil className="h-4 w-4" /> Edit</button>
            <button type="button" onClick={() => setPickerOpen(true)} className="text-sm text-gray-700 hover:bg-gray-100 px-2 py-1 rounded inline-flex items-center gap-1"><ImageIcon className="h-4 w-4" /> Cover</button>
            <button type="button" onClick={() => setConfirmDelete(true)} className="text-sm text-red-600 hover:bg-red-50 px-2 py-1 rounded inline-flex items-center gap-1"><Trash2 className="h-4 w-4" /> Delete</button>
          </div>
        )}
      </div>

      <div className="mt-6 prose prose-gray max-w-none">
        {!editing ? (
          bodyToParagraphs(story.body).map((p, i) => <p key={i}>{p}</p>)
        ) : (
          <textarea
            value={draftBody}
            onChange={e => setDraftBody(e.target.value)}
            rows={Math.max(8, draftBody.split('\n').length + 2)}
            className="w-full border border-gray-300 rounded p-3 font-serif text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            aria-label="Body"
          />
        )}
      </div>

      {editing && (
        <div className="mt-4 flex items-center justify-end gap-2">
          {saveError && <span className="text-sm text-red-600 mr-auto">{saveError}</span>}
          <button type="button" onClick={() => setEditing(false)} disabled={saving} className="px-3 py-1.5 text-sm rounded border border-gray-300 hover:bg-gray-50">Cancel</button>
          <button type="button" onClick={onSave} disabled={saving} className="px-3 py-1.5 text-sm rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">{saving ? 'Saving…' : 'Save'}</button>
        </div>
      )}

      {expanded && (activePhoto?.url ?? story.cover_url) && (
        <div
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4"
          onClick={() => setExpanded(false)}
          role="dialog"
          aria-modal="true"
        >
          <button
            type="button"
            onClick={() => setExpanded(false)}
            aria-label="Close"
            className="absolute top-4 right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white"
          >
            <X className="h-6 w-6" />
          </button>
          <figure
            className="max-w-5xl max-h-[90vh] flex flex-col items-center"
            onClick={e => e.stopPropagation()}
          >
            <img
              src={activePhoto?.url ?? story.cover_url ?? ''}
              alt=""
              className="max-w-full max-h-[80vh] object-contain rounded"
            />
            {activePhoto?.caption && (
              <figcaption className="mt-3 text-sm text-white/90 text-center max-w-2xl">
                {activePhoto.caption}
              </figcaption>
            )}
          </figure>
        </div>
      )}

      {pickerOpen && (
        <CoverPicker eventIds={linkedEventIds} currentUrl={story.cover_url} onSelect={onCoverChosen} onClose={() => setPickerOpen(false)} />
      )}

      {confirmDelete && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setConfirmDelete(false)}>
          <div className="bg-white rounded-xl max-w-sm w-full p-5" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold mb-2">Delete this story?</h3>
            <p className="text-sm text-gray-600">The cover and edits will be lost. The linked events stay.</p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirmDelete(false)} className="px-3 py-1.5 text-sm rounded border border-gray-300 hover:bg-gray-50">Cancel</button>
              <button type="button" onClick={onDelete} className="px-3 py-1.5 text-sm rounded bg-red-600 text-white hover:bg-red-700">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
