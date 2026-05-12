import { useEffect, useState } from 'react'
import { useSettings } from '../context/SettingsContext'
import { KeyRound, CheckCircle, AlertCircle, Eye, EyeOff, Loader } from 'lucide-react'
import { getStoryLanguages, setStoryLanguages } from '../services/profileService'
import { STORY_LANGUAGES, labelFor } from '../utils/storyLanguages'

const ANTHROPIC_MODELS = [
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (recommended)' },
  { value: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
  { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (no vision)' },
]

const DEFAULT_MODEL = 'claude-sonnet-4-6'

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const sec = Math.round(diffMs / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`
  const day = Math.round(hr / 24)
  return `${day} day${day === 1 ? '' : 's'} ago`
}

export function Settings() {
  const { settings, loading, hasAiKey, saveProvider, clearProvider, testProvider } = useSettings()
  const [key, setKey] = useState('')
  const [model, setModel] = useState(DEFAULT_MODEL)
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (settings) {
      setKey(settings.apiKey)
      setModel(settings.defaultModel ?? DEFAULT_MODEL)
    } else {
      setKey('')
      setModel(DEFAULT_MODEL)
    }
  }, [settings])

  const [storyLangs, setStoryLangs] = useState<string[]>(['en'])
  const [langSaving, setLangSaving] = useState(false)
  const [langSaved, setLangSaved] = useState(false)
  const [langError, setLangError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void getStoryLanguages().then(({ data }) => {
      if (!cancelled) setStoryLangs(data)
    })
    return () => { cancelled = true }
  }, [])

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!key.trim()) {
      setError('API key cannot be empty.')
      return
    }
    setSaving(true)
    setError(null)
    setSaved(false)
    setTestResult(null)
    try {
      await saveProvider({ provider: 'anthropic', apiKey: key.trim(), defaultModel: model })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const handleClear = async () => {
    setError(null)
    setTestResult(null)
    try {
      await clearProvider()
      setKey('')
      setModel(DEFAULT_MODEL)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear')
    }
  }

  const toggleLang = (code: string) => {
    setLangSaved(false)
    setLangError(null)
    setStoryLangs(prev => {
      if (prev.includes(code)) return prev.filter(c => c !== code)
      if (prev.length >= 3) return prev      // hard cap, silent
      return [...prev, code]
    })
  }

  const handleLangSave = async () => {
    setLangSaving(true)
    setLangError(null)
    setLangSaved(false)
    const { error } = await setStoryLanguages(storyLangs)
    setLangSaving(false)
    if (error) setLangError(error.message)
    else { setLangSaved(true); setTimeout(() => setLangSaved(false), 2000) }
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    const result = await testProvider()
    setTesting(false)
    if (result.ok) {
      setTestResult({ ok: true, message: 'Provider is working.' })
    } else {
      setTestResult({ ok: false, message: `${result.code}: ${result.message}` })
    }
  }

  if (loading) {
    return (
      <div className="max-w-xl mx-auto py-8 px-4 text-sm text-gray-500 flex items-center gap-2">
        <Loader className="h-4 w-4 animate-spin" /> Loading settings…
      </div>
    )
  }

  return (
    <div className="max-w-xl mx-auto py-8 px-4">
      <h2 className="text-xl font-semibold text-gray-900 mb-1">AI Settings</h2>
      <p className="text-sm text-gray-500 mb-6">
        Plannen uses an AI model for discovery, story generation, and event extraction. Bring your own key — it's stored in your local Plannen database (Tier 1) and never leaves your machine.
      </p>

      <div className="bg-white rounded-lg border border-gray-200 p-5">
        <div className="flex items-center gap-2 mb-4">
          <KeyRound className="h-4 w-4 text-gray-400" />
          <span className="text-sm font-medium text-gray-700">Anthropic API key</span>
          {hasAiKey ? (
            <span className="ml-auto flex items-center gap-1 text-xs text-green-600">
              <CheckCircle className="h-3.5 w-3.5" /> Saved
            </span>
          ) : (
            <span className="ml-auto flex items-center gap-1 text-xs text-amber-600">
              <AlertCircle className="h-3.5 w-3.5" /> Not set — AI features disabled
            </span>
          )}
        </div>

        <form onSubmit={handleSave} className="space-y-3">
          <label className="block text-xs font-medium text-gray-600">Provider</label>
          <div className="text-sm text-gray-700 px-3 py-2 border border-gray-200 rounded-md bg-gray-50">
            Anthropic <span className="text-xs text-gray-400 ml-2">(more providers coming soon)</span>
          </div>

          <label className="block text-xs font-medium text-gray-600 mt-3">API key</label>
          <div className="relative">
            <input
              type={showKey ? 'text' : 'password'}
              value={key}
              onChange={(e) => { setKey(e.target.value); setSaved(false); setTestResult(null) }}
              placeholder="sk-ant-..."
              className="w-full px-3 py-2 pr-10 border border-gray-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
              autoComplete="off"
            />
            <button
              type="button"
              onClick={() => setShowKey((s) => !s)}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600"
              aria-label={showKey ? 'Hide key' : 'Show key'}
            >
              {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>

          <label className="block text-xs font-medium text-gray-600 mt-3">Model</label>
          <select
            value={model}
            onChange={(e) => { setModel(e.target.value); setSaved(false) }}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            {ANTHROPIC_MODELS.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>

          <div className="flex gap-2 pt-2">
            <button
              type="submit"
              disabled={saving}
              className="flex-1 min-h-[40px] px-4 py-2 bg-indigo-600 text-white text-sm rounded-md hover:bg-indigo-700 disabled:opacity-50"
            >
              {saving ? 'Saving…' : saved ? 'Saved' : 'Save'}
            </button>
            <button
              type="button"
              onClick={handleTest}
              disabled={testing || !hasAiKey}
              className="px-4 py-2 border border-gray-300 text-sm text-gray-700 rounded-md hover:bg-gray-50 disabled:opacity-50 flex items-center gap-1"
              title={hasAiKey ? 'Send a tiny request to verify the key' : 'Save a key first'}
            >
              {testing ? <Loader className="h-3.5 w-3.5 animate-spin" /> : null}
              Test
            </button>
            {hasAiKey && (
              <button
                type="button"
                onClick={handleClear}
                className="px-4 py-2 border border-gray-300 text-sm text-gray-700 rounded-md hover:bg-gray-50"
              >
                Clear
              </button>
            )}
          </div>
        </form>

        {error && (
          <p className="mt-3 text-xs text-red-600">{error}</p>
        )}

        {testResult && (
          <p className={`mt-3 text-xs ${testResult.ok ? 'text-green-600' : 'text-red-600'}`}>
            {testResult.ok ? '✓' : '⚠'} {testResult.message}
          </p>
        )}

        {settings && (
          <div className="mt-4 pt-4 border-t border-gray-100 text-xs text-gray-500 space-y-1">
            {settings.lastUsedAt && (
              <p>Last successful call: {relativeTime(settings.lastUsedAt)}</p>
            )}
            {settings.lastErrorAt && settings.lastErrorCode && (
              <p className="text-red-500">
                Last error: {settings.lastErrorCode} ({relativeTime(settings.lastErrorAt)})
              </p>
            )}
          </div>
        )}

        <p className="mt-4 text-xs text-gray-400">
          Get a key at{' '}
          <a href="https://console.anthropic.com" target="_blank" rel="noopener noreferrer" className="text-indigo-500 hover:underline">
            console.anthropic.com
          </a>
          .
        </p>
      </div>

      <div className="mt-4 rounded-lg border border-gray-100 bg-gray-50 p-4 text-xs text-gray-500 space-y-1">
        <p className="font-medium text-gray-600">What your key enables</p>
        <p>Event discovery — natural-language search via Claude web search</p>
        <p>URL scraping — extract event details from any URL</p>
        <p>Image extraction — pull event info from photos and flyers</p>
      </div>

      <div className="mt-6 bg-white rounded-lg border border-gray-200 p-5">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-sm font-medium text-gray-700">Story languages</span>
          {langSaved && (
            <span className="ml-auto flex items-center gap-1 text-xs text-green-600">
              <CheckCircle className="h-3.5 w-3.5" /> Saved
            </span>
          )}
        </div>
        <p className="text-xs text-gray-500 mb-3">
          Stories are generated in your selected languages (max 3). The first selected language is the canonical one — translations are made from it.
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
                    ? 'px-3 py-1.5 rounded-full text-sm border border-indigo-500 bg-indigo-50 text-indigo-700'
                    : 'px-3 py-1.5 rounded-full text-sm border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-40'
                }
              >
                {active && <span className="mr-1 text-xs font-mono">{idx + 1}</span>}
                {label}
              </button>
            )
          })}
        </div>

        <p className="text-xs text-gray-500 mt-3">
          Selected order: {storyLangs.map(labelFor).join(', ')}
        </p>

        <div className="flex gap-2 pt-3">
          <button
            type="button"
            onClick={handleLangSave}
            disabled={langSaving}
            className="px-4 py-2 bg-indigo-600 text-white text-sm rounded-md hover:bg-indigo-700 disabled:opacity-50"
          >
            {langSaving ? 'Saving…' : 'Save languages'}
          </button>
        </div>

        {langError && <p className="mt-3 text-xs text-red-600">{langError}</p>}
      </div>
    </div>
  )
}
