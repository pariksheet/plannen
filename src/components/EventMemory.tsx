import { useState, useEffect } from 'react'
import { X, Trash2, ChevronLeft, ChevronRight } from 'lucide-react'
import { getEventMemories, uploadMemory, deleteMemory, addMemoryFromGoogle, shouldWarnLargeFile } from '../services/memoryService'
import type { EventMemory } from '../services/memoryService'
import { useAuth } from '../context/AuthContext'
import { ConfirmModal } from './Modal'
import { MemoryImage } from './MemoryImage'
import { getGoogleAuthUrl, getGoogleAccessToken } from '../services/googleOAuthService'
import { openGoogleDrivePicker } from '../utils/googlePicker'
import { createPhotoPickerSession, pollPhotoPickerSession } from '../services/photoPickerService'

export function EventMemoryComponent({ eventId }: { eventId: string }) {
  const { user } = useAuth()
  const [memories, setMemories] = useState<EventMemory[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [caption, setCaption] = useState('')
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [googleConnected, setGoogleConnected] = useState<boolean | null>(null)
  const [googleError, setGoogleError] = useState<string | null>(null)
  const [pickerLoading, setPickerLoading] = useState(false)
  const [photoPickerSession, setPhotoPickerSession] = useState<{ id: string; pickerUri: string } | null>(null)
  const [photoPickerStatus, setPhotoPickerStatus] = useState<string | null>(null)
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const lightboxMemory = lightboxIndex !== null ? memories[lightboxIndex] ?? null : null

  const load = () => {
    getEventMemories(eventId).then(({ data }) => {
      setMemories(data ?? [])
      setLoading(false)
    })
  }
  useEffect(() => { load() }, [eventId])

  useEffect(() => {
    getGoogleAccessToken()
      .then(() => setGoogleConnected(true))
      .catch(() => setGoogleConnected(false))
  }, [])

  useEffect(() => {
    if (lightboxIndex === null) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightboxIndex(null)
      else if (e.key === 'ArrowLeft') setLightboxIndex((i) => (i === null || memories.length === 0 ? i : (i - 1 + memories.length) % memories.length))
      else if (e.key === 'ArrowRight') setLightboxIndex((i) => (i === null || memories.length === 0 ? i : (i + 1) % memories.length))
    }
    document.addEventListener('keydown', handleKey)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handleKey)
      document.body.style.overflow = previousOverflow
    }
  }, [lightboxIndex, memories.length])

  useEffect(() => {
    if (!photoPickerSession) return
    let cancelled = false
    const tick = async () => {
      try {
        const result = await pollPhotoPickerSession(photoPickerSession.id, eventId)
        if (cancelled) return
        if (result.status === 'complete') {
          const summary = result.skipped.length
            ? `Attached ${result.attached.length}, skipped ${result.skipped.length}.`
            : `Attached ${result.attached.length} memory${result.attached.length === 1 ? '' : 'ies'}.`
          setPhotoPickerStatus(summary)
          setPhotoPickerSession(null)
          load()
          window.setTimeout(() => {
            if (!cancelled) setPhotoPickerStatus(null)
          }, 4000)
        }
      } catch (e) {
        if (cancelled) return
        setGoogleError(e instanceof Error ? e.message : 'Failed to poll Photos picker')
        setPhotoPickerSession(null)
        setPhotoPickerStatus(null)
      }
    }
    const interval = window.setInterval(tick, 3000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [photoPickerSession, eventId])

  const handleUpload = async () => {
    if (!file) return
    const warning = shouldWarnLargeFile(file)
    if (warning && !confirm(warning)) return
    setUploading(true)
    setGoogleError(null)
    const { error } = await uploadMemory(eventId, file, caption || undefined)
    if (!error) {
      setFile(null)
      setCaption('')
      load()
    }
    setUploading(false)
  }

  const handleConnectGoogle = async () => {
    setGoogleError(null)
    try {
      const { url } = await getGoogleAuthUrl()
      window.location.href = url
    } catch (e) {
      setGoogleError(e instanceof Error ? e.message : 'Failed to connect')
    }
  }

  const handlePickFromDrive = async () => {
    setGoogleError(null)
    setPickerLoading(true)
    try {
      const token = await getGoogleAccessToken()
      await openGoogleDrivePicker(token, async (items) => {
        setPickerLoading(false)
        if (!items.length) return
        for (const item of items) {
          await addMemoryFromGoogle(eventId, 'google_drive', item.id, undefined, item.mimeType)
        }
        load()
      })
    } catch (e) {
      setPickerLoading(false)
      setGoogleError(e instanceof Error ? e.message : 'Failed to open Drive picker')
    }
  }

  const handlePickFromPhotos = async () => {
    setGoogleError(null)
    setPickerLoading(true)
    try {
      const session = await createPhotoPickerSession()
      window.open(session.pickerUri, '_blank', 'noopener,noreferrer')
      setPhotoPickerSession({ id: session.id, pickerUri: session.pickerUri })
    } catch (e) {
      setGoogleError(e instanceof Error ? e.message : 'Failed to open Photos picker')
    } finally {
      setPickerLoading(false)
    }
  }

  const handleCancelPhotoPicker = () => {
    setPhotoPickerSession(null)
    setPhotoPickerStatus(null)
  }

  const handleDeleteConfirm = async () => {
    if (!deleteId) return
    await deleteMemory(deleteId)
    setDeleteId(null)
    load()
  }

  return (
    <div>
      <h4 className="text-sm font-medium text-gray-700 mb-2">Event Memories</h4>
      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex items-center min-h-[44px] px-4 py-2 bg-gray-100 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-200 cursor-pointer">
          <input
            type="file"
            accept="image/*,video/*,audio/*"
            className="hidden"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          Upload
        </label>
        {googleConnected === false && (
          <button
            type="button"
            onClick={handleConnectGoogle}
            className="inline-flex items-center min-h-[44px] px-4 py-2 bg-white border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Connect Google
          </button>
        )}
        {googleConnected === true && (
          <>
            <button
              type="button"
              disabled={pickerLoading}
              onClick={handlePickFromDrive}
              className="inline-flex items-center min-h-[44px] px-4 py-2 bg-white border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {pickerLoading ? 'Opening…' : 'From Google Drive'}
            </button>
            <button
              type="button"
              disabled={pickerLoading || !!photoPickerSession}
              onClick={handlePickFromPhotos}
              className="inline-flex items-center min-h-[44px] px-4 py-2 bg-white border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {pickerLoading ? 'Opening…' : 'From Google Photos'}
            </button>
          </>
        )}
      </div>
      {photoPickerSession && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-gray-700">
          <span>Waiting for picks…</span>
          <a
            href={photoPickerSession.pickerUri}
            target="_blank"
            rel="noopener noreferrer"
            className="text-indigo-600 hover:underline"
          >
            Reopen Photos picker
          </a>
          <button
            type="button"
            onClick={handleCancelPhotoPicker}
            className="text-gray-500 hover:underline"
          >
            Cancel
          </button>
        </div>
      )}
      {photoPickerStatus && !photoPickerSession && (
        <p className="text-sm text-gray-700 mt-2">{photoPickerStatus}</p>
      )}
      {googleError && (
        <p className="text-sm text-red-600 mt-2">{googleError}</p>
      )}
      {file && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            type="text"
            placeholder="Caption (optional)"
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            className="flex-1 min-w-[120px] px-2 py-1 border rounded text-sm"
          />
          <button
            type="button"
            disabled={uploading}
            onClick={handleUpload}
            className="px-3 py-1 bg-indigo-600 text-white rounded text-sm disabled:opacity-50"
          >
            {uploading ? 'Uploading...' : 'Upload'}
          </button>
          <button type="button" onClick={() => setFile(null)} className="text-gray-500 text-sm">Cancel</button>
        </div>
      )}
      {loading ? (
        <p className="text-sm text-gray-500 mt-2">Loading...</p>
      ) : (
        <div className="mt-3 grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2">
          {memories.map((m, idx) => (
            <div key={m.id} className="relative group">
              <div
                role="button"
                tabIndex={0}
                onClick={() => setLightboxIndex(idx)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setLightboxIndex(idx)
                  }
                }}
                className="cursor-pointer focus:outline-none focus:ring-2 focus:ring-indigo-500 rounded-lg"
              >
                <MemoryImage memory={m} className="w-full h-24 object-cover rounded-lg" />
              </div>
              {m.caption && <p className="text-xs text-gray-600 mt-1 line-clamp-2">{m.caption}</p>}
              {user && m.user_id === user.id && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    setDeleteId(m.id)
                  }}
                  aria-label="Delete memory"
                  className="absolute top-1 right-1 p-1.5 bg-black/50 text-white rounded-md opacity-70 hover:opacity-100 hover:bg-black/70 transition-opacity"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {lightboxMemory && lightboxIndex !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-90 p-4"
          onClick={() => setLightboxIndex(null)}
        >
          <div className="absolute top-4 right-4 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
            {user && lightboxMemory.user_id === user.id && (
              <button
                type="button"
                onClick={() => {
                  setDeleteId(lightboxMemory.id)
                  setLightboxIndex(null)
                }}
                className="text-white p-2 rounded-full hover:bg-white/20"
                aria-label="Delete memory"
              >
                <Trash2 className="w-6 h-6" />
              </button>
            )}
            <button
              type="button"
              onClick={() => setLightboxIndex(null)}
              className="text-white p-2 rounded-full hover:bg-white/20"
              aria-label="Close"
            >
              <X className="w-6 h-6" />
            </button>
          </div>
          {memories.length > 1 && (
            <>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  setLightboxIndex((i) => (i === null ? i : (i - 1 + memories.length) % memories.length))
                }}
                className="absolute left-2 sm:left-4 top-1/2 -translate-y-1/2 text-white p-2 rounded-full hover:bg-white/20"
                aria-label="Previous memory"
              >
                <ChevronLeft className="w-7 h-7" />
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  setLightboxIndex((i) => (i === null ? i : (i + 1) % memories.length))
                }}
                className="absolute right-2 sm:right-4 top-1/2 -translate-y-1/2 text-white p-2 rounded-full hover:bg-white/20"
                aria-label="Next memory"
              >
                <ChevronRight className="w-7 h-7" />
              </button>
            </>
          )}
          <div className="flex flex-col items-center max-w-full max-h-full" onClick={(e) => e.stopPropagation()}>
            <MemoryImage
              memory={lightboxMemory}
              className="max-w-[90vw] max-h-[85vh] object-contain rounded"
              lightbox
            />
            {lightboxMemory.caption && (
              <p className="text-white text-sm mt-3 text-center max-w-[90vw]">{lightboxMemory.caption}</p>
            )}
            {memories.length > 1 && (
              <p className="text-white/60 text-xs mt-2">
                {lightboxIndex + 1} / {memories.length}
              </p>
            )}
          </div>
        </div>
      )}
      <ConfirmModal
        isOpen={!!deleteId}
        onClose={() => setDeleteId(null)}
        title="Delete memory?"
        message="This memory will be removed from the event."
        confirmText="Delete"
        cancelText="Cancel"
        variant="danger"
        onConfirm={handleDeleteConfirm}
      />
    </div>
  )
}
