import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from './AuthContext'

export type Provider = 'anthropic' // V1.1 widens

export interface ProviderSettings {
  provider: Provider
  apiKey: string
  defaultModel: string | null
  baseUrl: string | null
  lastUsedAt: string | null
  lastErrorAt: string | null
  lastErrorCode: string | null
}

interface SettingsContextValue {
  settings: ProviderSettings | null
  loading: boolean
  hasAiKey: boolean
  saveProvider: (input: { provider: Provider; apiKey: string; defaultModel: string | null }) => Promise<void>
  clearProvider: () => Promise<void>
  testProvider: () => Promise<{ ok: true } | { ok: false; code: string; message: string }>
  refresh: () => Promise<void>
}

const SettingsContext = createContext<SettingsContextValue>({
  settings: null,
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
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    if (!user) {
      setSettings(null)
      setLoading(false)
      return
    }
    setLoading(true)
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
      const { error } = await supabase
        .from('user_settings')
        .upsert(
          {
            user_id: user.id,
            provider,
            api_key: apiKey,
            default_model: defaultModel,
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
        loading,
        hasAiKey: !!(settings && settings.apiKey),
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
