import { useState } from 'react'
import { sendRelationshipRequest } from '../services/relationshipService'
import { UserPlus, Loader } from 'lucide-react'

interface AddFriendProps {
  onSuccess: () => void
}

export function AddFriend({ onSuccess }: AddFriendProps) {
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
    const { error: err } = await sendRelationshipRequest(trimmed, 'friend')
    setLoading(false)
    if (err) {
      setError(err.message)
      return
    }
    setMessage('Request sent. They’ll see it when they accept.')
    setEmail('')
    onSuccess()
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-2">
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Their email (they must have an account)"
        className="flex-1 min-w-0 px-3 py-2 border border-gray-300 rounded-md text-sm"
        disabled={loading}
      />
      <button
        type="submit"
        disabled={loading}
        className="inline-flex items-center justify-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50 text-sm"
      >
        {loading ? <Loader className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
        Add friend
      </button>
      {error && <p className="text-sm text-red-600 sm:col-span-2">{error}</p>}
      {message && <p className="text-sm text-green-600 sm:col-span-2">{message}</p>}
    </form>
  )
}
