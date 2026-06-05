import { useEffect, useRef, useState } from 'react'
import { Mic, Square } from 'lucide-react'

interface AudioRecorderProps {
  /** Called with the recorded audio wrapped as a File. Parent owns upload. */
  onRecorded: (file: File) => void
  disabled?: boolean
}

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
]

function pickMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null
  for (const m of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported?.(m)) return m
  }
  return ''  // empty string = let the browser choose
}

function extFor(mime: string): string {
  if (mime.startsWith('audio/webm')) return 'webm'
  if (mime.startsWith('audio/mp4')) return 'm4a'
  if (mime.startsWith('audio/ogg')) return 'ogg'
  return 'webm'
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000)
  const mm = String(Math.floor(total / 60)).padStart(2, '0')
  const ss = String(total % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

/**
 * In-browser voice memo capture. Renders nothing if MediaRecorder /
 * getUserMedia aren't available (older Safari, restricted contexts).
 */
export function AudioRecorder({ onRecorded, disabled }: AudioRecorderProps) {
  const supported = typeof navigator !== 'undefined'
    && !!navigator.mediaDevices?.getUserMedia
    && typeof MediaRecorder !== 'undefined'

  const [recording, setRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)

  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const startedAtRef = useRef<number>(0)
  const tickRef = useRef<number | null>(null)

  useEffect(() => () => {
    if (tickRef.current) window.clearInterval(tickRef.current)
    streamRef.current?.getTracks().forEach((t) => t.stop())
  }, [])

  if (!supported) return null

  const start = async () => {
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const mime = pickMimeType()
      const recorder = mime
        ? new MediaRecorder(stream, { mimeType: mime })
        : new MediaRecorder(stream)
      chunksRef.current = []
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data)
      }
      recorder.onstop = () => {
        const effectiveMime = recorder.mimeType || mime || 'audio/webm'
        const blob = new Blob(chunksRef.current, { type: effectiveMime })
        const ext = extFor(effectiveMime)
        const file = new File([blob], `recording-${Date.now()}.${ext}`, { type: effectiveMime })
        streamRef.current?.getTracks().forEach((t) => t.stop())
        streamRef.current = null
        recorderRef.current = null
        setRecording(false)
        if (tickRef.current) {
          window.clearInterval(tickRef.current)
          tickRef.current = null
        }
        setElapsed(0)
        if (blob.size > 0) onRecorded(file)
      }
      recorderRef.current = recorder
      startedAtRef.current = Date.now()
      setElapsed(0)
      tickRef.current = window.setInterval(() => {
        setElapsed(Date.now() - startedAtRef.current)
      }, 250)
      recorder.start()
      setRecording(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start recording')
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
  }

  const stop = () => {
    const r = recorderRef.current
    if (r && r.state !== 'inactive') r.stop()
  }

  return (
    <div className="inline-flex flex-col gap-1">
      <button
        type="button"
        onClick={recording ? stop : start}
        disabled={disabled}
        aria-label={recording ? `Stop recording (${formatElapsed(elapsed)})` : 'Record audio'}
        className={`inline-flex items-center gap-2 min-h-[44px] px-4 py-2 rounded-md text-sm font-medium border transition-colors ${
          recording
            ? 'bg-red-600 text-white border-red-600 hover:bg-red-700'
            : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
        } disabled:opacity-50`}
      >
        {recording ? (
          <>
            <Square className="h-4 w-4 fill-current" aria-hidden />
            <span className="inline-flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-white animate-pulse" aria-hidden />
              <span className="tabular-nums">{formatElapsed(elapsed)}</span>
            </span>
          </>
        ) : (
          <>
            <Mic className="h-4 w-4" aria-hidden />
            Record
          </>
        )}
      </button>
      {error && <p className="text-xs text-red-600 max-w-[200px]">{error}</p>}
    </div>
  )
}
