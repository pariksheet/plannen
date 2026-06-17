import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, CheckCircle } from 'lucide-react'
import { STORY_LANGUAGES, labelFor } from '../utils/storyLanguages'
import { getStoryLanguages, setStoryLanguages } from '../services/profileService'

export function ProfileStoryLanguages() {
  const [open, setOpen] = useState(false)
  const [storyLangs, setStoryLangsState] = useState<string[]>(['en'])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void getStoryLanguages().then(({ data }) => {
      if (!cancelled) setStoryLangsState(data)
    })
    return () => { cancelled = true }
  }, [])

  const toggleLang = (code: string) => {
    setSaved(false)
    setError(null)
    setStoryLangsState((prev) => {
      if (prev.includes(code)) return prev.filter((c) => c !== code)
      if (prev.length >= 3) return prev
      return [...prev, code]
    })
  }

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    setSaved(false)
    const { error: err } = await setStoryLanguages(storyLangs)
    setSaving(false)
    if (err) setError(err.message)
    else { setSaved(true); setTimeout(() => setSaved(false), 2000) }
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-5 py-4 min-h-[56px] text-left"
      >
        <span className="font-semibold text-gray-900 flex items-center gap-2">
          Story languages
          {saved && <span className="text-xs font-normal text-green-600 inline-flex items-center gap-1"><CheckCircle className="h-3.5 w-3.5" />Saved</span>}
        </span>
        {open ? <ChevronUp className="h-4 w-4 text-gray-400" /> : <ChevronDown className="h-4 w-4 text-gray-400" />}
      </button>

      {open && (
        <div className="px-5 pb-5 border-t border-gray-100 pt-4 space-y-3">
          <p className="text-xs text-gray-500">
            Stories are generated in your selected languages (max 3). The first
            selected language is canonical — translations are made from it.
          </p>

          <div className="flex flex-wrap gap-2">
            {STORY_LANGUAGES.map(({ code, label }) => {
              const active = storyLangs.includes(code)
              const idx = storyLangs.indexOf(code)
              const disabled = !active && storyLangs.length >= 3
              return (
                <button
                  key={code}
                  type="button"
                  onClick={() => toggleLang(code)}
                  disabled={disabled}
                  className={
                    active
                      ? 'min-h-[44px] px-4 py-2 rounded-full text-sm border border-indigo-500 bg-indigo-50 text-indigo-700'
                      : 'min-h-[44px] px-4 py-2 rounded-full text-sm border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-40'
                  }
                >
                  {active && <span className="mr-1 text-xs font-mono">{idx + 1}</span>}
                  {label}
                </button>
              )
            })}
          </div>

          <p className="text-xs text-gray-500">
            Selected order: {storyLangs.map(labelFor).join(', ')}
          </p>

          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="min-h-[44px] px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save languages'}
            </button>
          </div>

          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>
      )}
    </div>
  )
}
