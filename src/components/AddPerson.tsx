import { useState } from 'react'
import { inviteOrRequest } from '../services/relationshipService'
import { sendInviteEmail } from '../services/appAccessService'
import { UserPlus, Loader } from 'lucide-react'

interface AddPersonProps {
  onSuccess: () => void
}

export function AddPerson({ onSuccess }: AddPersonProps) {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setMessage('')
    const trimmed = email.trim()
    if (!trimmed) return
    setLoading(true)
    const { data, error: err } = await inviteOrRequest(trimmed)
    if (err || !data) {
      setLoading(false)
      setError(err?.message ?? 'Something went wrong.')
      return
    }
    if (data.kind === 'request') {
      setLoading(false)
      setMessage('Request sent. They’ll see it in their pending requests and can accept.')
    } else {
      // Not on Plannen yet — email them a join link. The friendship is queued
      // and auto-created when they sign up, so a send failure isn't fatal.
      await sendInviteEmail(trimmed)
      setLoading(false)
      setMessage('Invite sent — they’ll be added to your people automatically when they join.')
    }
    setEmail('')
    onSuccess()
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-2">
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Their email"
        className="flex-1 min-w-0 px-3 py-2 min-h-[44px] border border-gray-300 rounded-md text-sm"
        disabled={loading}
      />
      <button
        type="submit"
        disabled={loading}
        className="inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[44px] bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50 text-sm"
      >
        {loading ? <Loader className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
        Add person
      </button>
      {error && <p className="text-sm text-red-600 sm:col-span-2">{error}</p>}
      {message && <p className="text-sm text-green-600 sm:col-span-2">{message}</p>}
    </form>
  )
}
