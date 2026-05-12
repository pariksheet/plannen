import { useState } from 'react'
import { inviteEmailToApp, sendInviteEmail } from '../services/appAccessService'
import { Send, Loader } from 'lucide-react'
import { useAuth } from '../context/AuthContext'

export function InviteToApp() {
  const { profile } = useAuth()
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [whatsAppUrl, setWhatsAppUrl] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setMessage('')
    setWhatsAppUrl(null)
    const trimmed = email.trim()
    if (!trimmed) {
      setError('Please enter an email address.')
      return
    }
    setLoading(true)
    const { error: saveErr } = await inviteEmailToApp(trimmed)
    if (saveErr) {
      setLoading(false)
      setError(saveErr.message)
      return
    }
    const { error: emailErr } = await sendInviteEmail(trimmed)
    setLoading(false)
    const appUrl =
      (import.meta.env.VITE_APP_URL as string | undefined) ||
      'http://localhost:4321'
    const loginUrl = `${appUrl.replace(/\/+$/, '')}/login`
    const inviterName = profile?.full_name || profile?.email || 'a friend'
    const shareText = `You're invited to join Plannen by ${inviterName}. Click here to sign in: ${loginUrl}`
    const waUrl = `https://wa.me/?text=${encodeURIComponent(shareText)}`
    setWhatsAppUrl(waUrl)

    if (emailErr) {
      setMessage(
        `Invite saved, but we couldn't send the email. You can share the link on WhatsApp or ask them to visit ${loginUrl} and log in with ${trimmed}.`
      )
    } else {
      setMessage(`Invite email sent to ${trimmed}. You can also share the link on WhatsApp.`)
    }
    setEmail('')
    setName('')
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="friend@example.com"
            className="flex-1 min-w-0 px-3 py-2 border border-gray-300 rounded-md text-sm"
            disabled={loading}
          />
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Their name (optional)"
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
            disabled={loading}
          />
        </div>
        <div>
          <button
            type="submit"
            disabled={loading}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50 text-sm"
          >
            {loading ? <Loader className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Invite to Plannen
          </button>
        </div>
        {whatsAppUrl && (
          <div>
            <button
              type="button"
              onClick={() => {
                if (!whatsAppUrl) return
                window.open(whatsAppUrl, '_blank', 'noopener,noreferrer')
              }}
              className="inline-flex items-center justify-center px-3 py-1.5 rounded-md border border-green-600 text-green-700 text-xs font-medium hover:bg-green-50"
            >
              Share invite on WhatsApp
            </button>
          </div>
        )}
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {message && <p className="text-sm text-green-600">{message}</p>}
    </form>
  )
}

