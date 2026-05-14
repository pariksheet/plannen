import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import { dbClient } from '../lib/dbClient'

const TIER = (import.meta.env.VITE_PLANNEN_TIER ?? '1') as '0' | '1'
import { useAuth } from './AuthContext'

export type Provider = 'anthropic' | 'claude-code-cli'

export interface ProviderSettings {
  provider: Provider
  apiKey: string
  defaultModel: string | null
  baseUrl: string | null
  lastUsedAt: string | null
  lastErrorAt: string | null
  lastErrorCode: string | null
}

export interface SystemInfo {
  tier: number
  cliAvailable: boolean
  cliVersion: string | null
}

interface SettingsContextValue {
  settings: ProviderSettings | null
  system: SystemInfo | null
  loading: boolean
  hasAiKey: boolean
  saveProvider: (input: { provider: Provider; apiKey: string; defaultModel: string | null }) => Promise<void>
  clearProvider: () => Promise<void>
  testProvider: () => Promise<{ ok: true } | { ok: false; code: string; message: string }>
  refresh: () => Promise<void>
}

const SettingsContext = createContext<SettingsContextValue>({
  settings: null,
  system: null,
  loading: true,
  hasAiKey: false,
  saveProvider: async () => {},
  clearProvider: async () => {},
  testProvider: async () => ({ ok: false, code: 'no_provider_configured', message: 'Not initialised' }),
  refresh: async () => {},
})

const ROW_TO_SETTINGS = (row: {
  provider: string
  api_key: string | null
  default_model: string | null
  base_url: string | null
  last_used_at: string | null
  last_error_at: string | null
  last_error_code: string | null
}): ProviderSettings => ({
  provider: row.provider as Provider,
  apiKey: row.api_key ?? '',
  defaultModel: row.default_model,
  baseUrl: row.base_url,
  lastUsedAt: row.last_used_at,
  lastErrorAt: row.last_error_at,
  lastErrorCode: row.last_error_code,
})

export function SettingsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const [settings, setSettings] = useState<ProviderSettings | null>(null)
  const [system, setSystem] = useState<SystemInfo | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    dbClient.settings.system()
      .then(setSystem)
      .catch(() => setSystem({ tier: TIER === '0' ? 0 : 1, cliAvailable: false, cliVersion: null }))
  }, [])

  const refresh = useCallback(async () => {
    if (!user) {
      setSettings(null)
      setLoading(false)
      return
    }
    setLoading(true)
    if (TIER === '0') {
      // Tier 0 backend redacts api_key on GET. Settings panel is mainly used
      // for the BYOK key — in Tier 0 the Claude path doesn't need it; we just
      // surface presence/provider/model so the UI can show "configured" state.
      try {
        const data = await dbClient.settings.get() as {
          provider?: string
          has_api_key?: boolean
          default_model?: string | null
          base_url?: string | null
          last_used_at?: string | null
          last_error_at?: string | null
          last_error_code?: string | null
        } | null
        // CLI rows are configured even though has_api_key is false (no key needed).
        const configured = !!data && (data.has_api_key || data.provider === 'claude-code-cli')
        if (!configured) {
          setSettings(null)
        } else {
          setSettings(ROW_TO_SETTINGS({
            provider: data!.provider as never,
            api_key: '',  // backend doesn't expose; UI shows configured/not
            default_model: data!.default_model ?? null,
            base_url: data!.base_url ?? null,
            last_used_at: data!.last_used_at ?? null,
            last_error_at: data!.last_error_at ?? null,
            last_error_code: data!.last_error_code ?? null,
          }))
        }
      } catch (e) {
        console.warn('Failed to load user_settings:', (e as Error).message)
        setSettings(null)
      }
      setLoading(false)
      return
    }
    const { data, error } = await supabase
      .from('user_settings')
      .select('provider, api_key, default_model, base_url, last_used_at, last_error_at, last_error_code')
      .eq('is_default', true)
      .maybeSingle()
    if (error) {
      console.warn('Failed to load user_settings:', error.message)
      setSettings(null)
    } else if (!data) {
      setSettings(null)
    } else {
      setSettings(ROW_TO_SETTINGS(data))
    }
    setLoading(false)
  }, [user])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const saveProvider = useCallback(
    async ({ provider, apiKey, defaultModel }: { provider: Provider; apiKey: string; defaultModel: string | null }) => {
      if (!user) throw new Error('Not authenticated')
      const isCli = provider === 'claude-code-cli'
      const apiKeyForBackend = isCli ? null : apiKey
      const modelForBackend = isCli ? null : defaultModel
      if (TIER === '0') {
        await dbClient.settings.update({
          provider,
          api_key: apiKeyForBackend,
          default_model: modelForBackend,
          base_url: null,
          is_default: true,
        })
        await refresh()
        return
      }
      const { error } = await supabase
        .from('user_settings')
        .upsert(
          {
            user_id: user.id,
            provider,
            api_key: apiKeyForBackend,
            default_model: modelForBackend,
            base_url: null,
            is_default: true,
          },
          { onConflict: 'user_id,provider' },
        )
      if (error) throw new Error(error.message)
      await refresh()
    },
    [user, refresh],
  )

  const clearProvider = useCallback(async () => {
    if (!user || !settings) return
    if (TIER === '0') {
      // Tier 0: no DELETE route on /api/settings. Patch with null api_key to disable.
      await dbClient.settings.update({ provider: settings.provider, api_key: null })
      await refresh()
      return
    }
    const { error } = await supabase
      .from('user_settings')
      .delete()
      .eq('user_id', user.id)
      .eq('provider', settings.provider)
    if (error) throw new Error(error.message)
    await refresh()
  }, [user, settings, refresh])

  const testProvider = useCallback(async (): Promise<{ ok: true } | { ok: false; code: string; message: string }> => {
    if (!settings) return { ok: false, code: 'no_provider_configured', message: 'No provider saved.' }
    if (TIER === '0') {
      try {
        const data = await dbClient.functions.invoke<{ success?: boolean; error?: string; message?: string }>('agent-test', {})
        if (data?.success) { await refresh(); return { ok: true } }
        await refresh()
        return { ok: false, code: data?.error ?? 'unknown_error', message: data?.message ?? 'Test call failed' }
      } catch (e) {
        return { ok: false, code: 'unknown_error', message: (e as Error).message }
      }
    }
    const { data, error } = await supabase.functions.invoke('agent-test', { body: {} })
    if (error) return { ok: false, code: 'unknown_error', message: error.message ?? 'Test call failed' }
    if (data?.success) {
      await refresh()
      return { ok: true }
    }
    await refresh()
    return {
      ok: false,
      code: data?.error ?? 'unknown_error',
      message: data?.message ?? 'Test call failed',
    }
  }, [settings, refresh])

  return (
    <SettingsContext.Provider
      value={{
        settings,
        system,
        loading,
        hasAiKey: !!(settings && (settings.provider === 'claude-code-cli' || settings.apiKey)),
        saveProvider,
        clearProvider,
        testProvider,
        refresh,
      }}
    >
      {children}
    </SettingsContext.Provider>
  )
}

export function useSettings() {
  return useContext(SettingsContext)
}
