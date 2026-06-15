import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useSettings } from '../context/SettingsContext'
import { KeyRound, CheckCircle, AlertCircle, Eye, EyeOff, Loader, Bell } from 'lucide-react'
import { pushSupported, getPushSubscription, enablePush, disablePush, sendTestPush } from '../lib/push'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { SettingsTokens } from './SettingsTokens'
import { IgnoreRulesManager } from './IgnoreRulesManager'

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL ?? '') as string

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
  const { settings, system, loading, hasAiKey, saveProvider, clearProvider, testProvider } = useSettings()
  const { user } = useAuth()
  const [sessionJwt, setSessionJwt] = useState<string | null>(null)
  const [provider, setProvider] = useState<'anthropic' | 'claude-code-cli'>(settings?.provider ?? 'anthropic')
  const [key, setKey] = useState('')
  const [model, setModel] = useState(DEFAULT_MODEL)
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const cliAvailable = system?.tier === 0 && system.cliAvailable

  const [pushOn, setPushOn] = useState(false)
  const [pushBusy, setPushBusy] = useState(false)
  const [pushMsg, setPushMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const pushAvailable = pushSupported()

  useEffect(() => {
    if (!pushAvailable) return
    getPushSubscription().then((sub) => setPushOn(!!sub))
  }, [pushAvailable])

  const handleTogglePush = async () => {
    setPushBusy(true)
    setPushMsg(null)
    if (pushOn) {
      await disablePush()
      setPushOn(false)
    } else {
      const { ok, reason } = await enablePush()
      if (ok) {
        setPushOn(true)
      } else {
        const map: Record<string, string> = {
          unsupported: "This browser doesn't support push notifications.",
          denied: 'Notification permission was denied. Enable it in your browser settings.',
          'server-not-configured': 'Server is missing VAPID keys — set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY in your profile env and restart.',
          'subscribe-failed': "Couldn't subscribe with the push service.",
          'server-error': "Subscription saved on this device but the server didn't accept it.",
        }
        setPushMsg({ ok: false, text: map[reason ?? ''] ?? 'Could not enable push notifications.' })
      }
    }
    setPushBusy(false)
  }

  const handleTestPush = async () => {
    setPushBusy(true)
    setPushMsg(null)
    const { ok, sent, attempted } = await sendTestPush()
    setPushMsg({
      ok,
      text: ok
        ? `Test notification sent (${sent}/${attempted}). Check your device.`
        : 'Test failed — see the backend logs.',
    })
    setPushBusy(false)
  }

  useEffect(() => {
    if (settings) {
      setProvider(settings.provider)
      setKey(settings.apiKey)
      setModel(settings.defaultModel ?? DEFAULT_MODEL)
    } else {
      setProvider('anthropic')
      setKey('')
      setModel(DEFAULT_MODEL)
    }
  }, [settings])

  useEffect(() => {
    if (!user) return
    void supabase.auth.getSession().then(({ data: { session } }) => {
      setSessionJwt(session?.access_token ?? null)
    })
  }, [user])

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (provider === 'anthropic' && !key.trim()) {
      setError('API key cannot be empty.')
      return
    }
    setSaving(true)
    setError(null)
    setSaved(false)
    setTestResult(null)
    try {
      if (provider === 'claude-code-cli') {
        await saveProvider({ provider: 'claude-code-cli', apiKey: '', defaultModel: null })
      } else {
        await saveProvider({ provider: 'anthropic', apiKey: key.trim(), defaultModel: model })
      }
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
      <p className="text-sm text-gray-500 mb-2">
        Plannen uses an AI model for discovery, story generation, and event extraction. Pick the Claude Code CLI to use your subscription, or paste an Anthropic API key — either way the choice stays on your machine.
      </p>
      <p className="text-xs text-gray-500 mb-6">
        This key powers AI features in the web UI only. If you use Plannen
        through Claude Code or Claude Desktop (via the MCP), that client
        provides its own key — you don&apos;t need to set one here.
      </p>

      <div className="bg-white rounded-lg border border-gray-200 p-5">
        <div className="flex items-center gap-2 mb-4">
          <KeyRound className="h-4 w-4 text-gray-400" />
          <span className="text-sm font-medium text-gray-700">
            {provider === 'claude-code-cli' ? 'Claude Code CLI' : 'Anthropic API key'}
          </span>
          {hasAiKey ? (
            <span className="ml-auto flex items-center gap-1 text-xs text-green-600">
              <CheckCircle className="h-3.5 w-3.5" /> {provider === 'claude-code-cli' ? 'Active' : 'Saved'}
            </span>
          ) : (
            <span className="ml-auto flex items-center gap-1 text-xs text-amber-600">
              <AlertCircle className="h-3.5 w-3.5" /> Not set — AI features disabled
            </span>
          )}
        </div>

        <form onSubmit={handleSave} className="space-y-3">
          <label className="block text-xs font-medium text-gray-600">Provider</label>
          <select
            value={provider}
            onChange={(e) => { setProvider(e.target.value as 'anthropic' | 'claude-code-cli'); setSaved(false); setTestResult(null) }}
            className="w-full px-3 py-2 min-h-[44px] border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <option value="anthropic">Anthropic (BYOK)</option>
            {cliAvailable && (
              <option value="claude-code-cli">
                Claude Code CLI (your subscription){system?.cliVersion ? ` — v${system.cliVersion}` : ''}
              </option>
            )}
          </select>

          {provider === 'anthropic' && (
            <>
              <label className="block text-xs font-medium text-gray-600 mt-3">API key</label>
              <div className="relative">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={key}
                  onChange={(e) => { setKey(e.target.value); setSaved(false); setTestResult(null) }}
                  placeholder="sk-ant-..."
                  className="w-full px-3 py-2 pr-12 min-h-[44px] border border-gray-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((s) => !s)}
                  className="absolute right-1 top-1/2 -translate-y-1/2 min-h-[44px] min-w-[44px] flex items-center justify-center text-gray-400 hover:text-gray-600"
                  aria-label={showKey ? 'Hide key' : 'Show key'}
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>

              <label className="block text-xs font-medium text-gray-600 mt-3">Model</label>
              <select
                value={model}
                onChange={(e) => { setModel(e.target.value); setSaved(false) }}
                className="w-full px-3 py-2 min-h-[44px] border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                {ANTHROPIC_MODELS.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </>
          )}

          {provider === 'claude-code-cli' && (
            <div className="rounded border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900 mt-3">
              Plannen will use your installed Claude CLI for AI calls. Anthropic bills your subscription —
              no API key needed here.
            </div>
          )}

          {system?.tier === 0 && !system.cliAvailable && (
            <p className="text-xs text-gray-500 mt-2">
              To use your Claude subscription instead of an API key, install Claude Code at{' '}
              <a href="https://claude.com/code" className="underline" target="_blank" rel="noopener noreferrer">claude.com/code</a>.
            </p>
          )}

          <div className="flex flex-wrap gap-2 pt-2">
            <button
              type="submit"
              disabled={saving}
              className="flex-1 min-h-[44px] px-4 py-2 bg-indigo-600 text-white text-sm rounded-md hover:bg-indigo-700 disabled:opacity-50"
            >
              {saving ? 'Saving…' : saved ? 'Saved' : 'Save'}
            </button>
            <button
              type="button"
              onClick={handleTest}
              disabled={testing || !hasAiKey}
              className="min-h-[44px] px-4 py-2 border border-gray-300 text-sm text-gray-700 rounded-md hover:bg-gray-50 disabled:opacity-50 flex items-center gap-1"
              title={hasAiKey ? 'Send a tiny request to verify the key' : 'Save a key first'}
            >
              {testing ? <Loader className="h-3.5 w-3.5 animate-spin" /> : null}
              Test
            </button>
            {hasAiKey && (
              <button
                type="button"
                onClick={handleClear}
                className="min-h-[44px] px-4 py-2 border border-gray-300 text-sm text-gray-700 rounded-md hover:bg-gray-50"
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

      <div className="mt-6 rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600">
        <p>
          Story languages have moved to{' '}
          <Link to="/profile" className="text-indigo-600 underline">
            My Profile
          </Link>
          .
        </p>
      </div>

      {pushAvailable && (
        <div className="mt-6 bg-white rounded-lg border border-gray-200 p-5">
          <div className="flex items-center gap-2 mb-2">
            <Bell className="h-4 w-4 text-gray-400" />
            <span className="text-sm font-medium text-gray-700">Push notifications</span>
            {pushOn && (
              <span className="ml-auto flex items-center gap-1 text-xs text-green-600">
                <CheckCircle className="h-3.5 w-3.5" /> Enabled
              </span>
            )}
          </div>
          <p className="text-xs text-gray-500 mb-3">
            Get notified when a watched event changes. On iOS, install Plannen to
            your home screen first (Share → Add to Home Screen), then enable push
            from inside the installed app.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleTogglePush}
              disabled={pushBusy}
              className="px-3 py-2 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
            >
              {pushBusy ? 'Working…' : pushOn ? 'Disable push' : 'Enable push'}
            </button>
            {pushOn && (
              <button
                type="button"
                onClick={handleTestPush}
                disabled={pushBusy}
                className="px-3 py-2 rounded-md border border-gray-300 text-gray-700 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
              >
                Send test notification
              </button>
            )}
          </div>
          {pushMsg && (
            <p className={`mt-2 text-xs ${pushMsg.ok ? 'text-green-600' : 'text-amber-600'}`}>
              {pushMsg.text}
            </p>
          )}
        </div>
      )}

      {typeof navigator !== 'undefined' && 'serviceWorker' in navigator && (
        <div className="mt-6 bg-white rounded-lg border border-gray-200 p-5">
          <h3 className="text-sm font-medium text-gray-700 mb-2">App cache</h3>
          <p className="text-xs text-gray-500 mb-3">
            If a tab is stuck loading or showing stale data after an update,
            clear the service-worker cache and reload.
          </p>
          <button
            type="button"
            onClick={async () => {
              try {
                const regs = await navigator.serviceWorker.getRegistrations()
                await Promise.all(regs.map((r) => r.unregister()))
                if ('caches' in window) {
                  const keys = await caches.keys()
                  await Promise.all(keys.map((k) => caches.delete(k)))
                }
              } finally {
                window.location.reload()
              }
            }}
            className="px-3 py-2 rounded-md border border-gray-300 text-gray-700 text-sm font-medium hover:bg-gray-50"
          >
            Clear app cache + reload
          </button>
        </div>
      )}

      {user && sessionJwt && (
        <div className="mt-6">
          <SettingsTokens jwt={sessionJwt} supabaseUrl={SUPABASE_URL} />
        </div>
      )}

      <div className="mt-6">
        <IgnoreRulesManager />
      </div>
    </div>
  )
}
