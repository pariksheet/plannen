import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'

const STICKERS = ['🌟', '🎉', '🎈', '🌈', '🍀', '💫', '🎵', '🏖️']

export function Onboarding() {
  const { user, profile, refreshProfile } = useAuth()
  const navigate = useNavigate()
  const [name, setName] = useState(profile?.full_name ?? '')
  const [sticker, setSticker] = useState<string>(profile?.avatar_sticker ?? STICKERS[0])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (profile?.full_name) {
      navigate('/dashboard', { replace: true })
    }
  }, [profile, navigate])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!user) return
    const trimmedName = name.trim()
    if (!trimmedName) {
      setError('Please enter your name.')
      return
    }
    setError('')
    setSaving(true)
    const { error: dbError } = await supabase
      .from('users')
      .update({ full_name: trimmedName, avatar_url: sticker })
      .eq('id', user.id)
    setSaving(false)
    if (dbError) {
      setError(dbError.message)
      return
    }
    await refreshProfile()
    navigate('/dashboard', { replace: true })
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md bg-white rounded-lg shadow-sm border border-gray-200 p-6 space-y-6">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold text-gray-900">Welcome to Plannen</h1>
          <p className="text-sm text-gray-600">
            Let&apos;s set up how you appear to friends and family.
          </p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label htmlFor="name" className="block text-sm font-medium text-gray-700">
              Your name
            </label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              placeholder="e.g. Priya B."
              disabled={saving}
            />
          </div>

          <div>
            <p className="block text-sm font-medium text-gray-700 mb-2">
              Choose a profile sticker
            </p>
            <div className="grid grid-cols-4 gap-3">
              {STICKERS.map((s) => {
                const selected = s === sticker
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setSticker(s)}
                    className={`h-12 w-12 flex items-center justify-center rounded-full border text-xl transition ${
                      selected
                        ? 'border-indigo-600 bg-indigo-50 ring-2 ring-indigo-500'
                        : 'border-gray-200 bg-white hover:border-indigo-300'
                    }`}
                    aria-label={`Choose sticker ${s}`}
                  >
                    <span>{s}</span>
                  </button>
                )
              })}
            </div>
          </div>

          {error && (
            <div className="rounded-md bg-red-50 p-3">
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}

          <button
            type="submit"
            disabled={saving}
            className="w-full inline-flex justify-center items-center px-4 py-2.5 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-md shadow-sm disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Continue to dashboard'}
          </button>
        </form>
      </div>
    </div>
  )
}

