// src/components/ProfileInterestsGoals.tsx
import { useState, KeyboardEvent } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'

interface Props {
  interests: string[]
  goals: string[]
  onSave: (goals: string[], interests: string[]) => Promise<void>
}

export function ProfileInterestsGoals({ interests, goals, onSave }: Props) {
  const [open, setOpen] = useState(true)
  const [editInterests, setEditInterests] = useState<string[]>(interests)
  const [editGoals, setEditGoals] = useState<string[]>(goals)
  const [interestInput, setInterestInput] = useState('')
  const [goalInput, setGoalInput] = useState('')
  const [saving, setSaving] = useState(false)

  function addInterest() {
    const val = interestInput.trim()
    if (val && !editInterests.includes(val)) {
      setEditInterests((prev) => [...prev, val])
    }
    setInterestInput('')
  }

  function removeInterest(tag: string) {
    setEditInterests((prev) => prev.filter((t) => t !== tag))
  }

  function addGoal() {
    const val = goalInput.trim()
    if (val && !editGoals.includes(val)) setEditGoals((prev) => [...prev, val])
    setGoalInput('')
  }

  function removeGoal(idx: number) {
    setEditGoals((prev) => prev.filter((_, i) => i !== idx))
  }

  function handleInterestKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addInterest() }
  }

  function handleGoalKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') { e.preventDefault(); addGoal() }
  }

  async function handleSave() {
    setSaving(true)
    try {
      await onSave(editGoals, editInterests)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-5 py-4 text-left"
      >
        <span className="font-semibold text-gray-900">Interests &amp; Goals</span>
        {open ? <ChevronUp className="h-4 w-4 text-gray-400" /> : <ChevronDown className="h-4 w-4 text-gray-400" />}
      </button>

      {open && (
        <div className="px-5 pb-5 border-t border-gray-100 space-y-5 pt-4">
          {/* Interests */}
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
              Interests
            </label>
            <div className="flex flex-wrap gap-2 mb-2">
              {editInterests.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 bg-violet-100 text-violet-700 rounded-full px-3 py-1 text-sm"
                >
                  {tag}
                  <button type="button" onClick={() => removeInterest(tag)} className="hover:text-violet-900">
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
            <input
              type="text"
              placeholder="Type an interest and press Enter"
              value={interestInput}
              onChange={(e) => setInterestInput(e.target.value)}
              onKeyDown={handleInterestKey}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          {/* Goals */}
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
              Goals
            </label>
            <div className="space-y-2 mb-2">
              {editGoals.map((goal, idx) => (
                <div key={goal} className="flex items-center gap-2 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                  <span className="flex-1 text-sm text-gray-800">{goal}</span>
                  <button type="button" onClick={() => removeGoal(idx)} className="text-gray-400 hover:text-red-500">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
            <input
              type="text"
              placeholder="Type a goal and press Enter"
              value={goalInput}
              onChange={(e) => setGoalInput(e.target.value)}
              onKeyDown={handleGoalKey}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
