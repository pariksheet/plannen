import { useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

/**
 * Receives shared payloads from Android's share-sheet (manifest share_target).
 * Hands the title/text/url off to the feed view via query params so MyFeed
 * opens EventForm pre-filled.
 */
export function ShareTarget() {
  const [params] = useSearchParams()
  const navigate = useNavigate()

  useEffect(() => {
    const title = params.get('title') ?? ''
    const text = params.get('text') ?? ''
    const url = params.get('url') ?? ''

    const next = new URLSearchParams()
    next.set('create', '1')
    if (title) next.set('prefill_title', title)
    // Android often delivers the shared link inside `text` rather than `url`.
    const candidate = url || text
    if (candidate) next.set('prefill_url', candidate)
    if (text && text !== candidate) next.set('prefill_text', text)

    navigate(`/dashboard?${next.toString()}`, { replace: true })
  }, [params, navigate])

  return (
    <div className="min-h-screen flex items-center justify-center text-gray-500 text-sm">
      Opening Plannen…
    </div>
  )
}
