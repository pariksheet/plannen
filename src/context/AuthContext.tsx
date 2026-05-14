import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from 'react'
import { User } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { dbClient } from '../lib/dbClient'

const TIER = (import.meta.env.VITE_PLANNEN_TIER ?? '1') as '0' | '1'

type UserProfile = {
  id: string
  email: string | null
  full_name: string | null
  avatar_sticker: string | null
}

type AuthContextType = {
  user: User | null
  loading: boolean
  profile: UserProfile | null
  refreshProfile: () => Promise<void>
  signIn: (email: string, redirectTo?: string) => Promise<{ error: Error | null }>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextType | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)

  const loadProfile = useCallback(
    async (u: User | null) => {
      if (!u) {
        setProfile(null)
        return
      }
      const { data, error } = await supabase
        .from('users')
        .select('id, email, full_name, avatar_url')
        .eq('id', u.id)
        .maybeSingle()
      if (error || !data) {
        setProfile(null)
        return
      }
      const { id, email, full_name, avatar_url } = data as {
        id: string
        email: string | null
        full_name: string | null
        avatar_url: string | null
      }
      setProfile({
        id,
        email,
        full_name,
        avatar_sticker: avatar_url,
      })
    },
    []
  )

  useEffect(() => {
    let isMounted = true

    if (TIER === '0') {
      // Tier 0: no Supabase Auth. The backend resolves the single user at boot
      // from PLANNEN_USER_EMAIL and exposes them via GET /api/me. No login UI;
      // no auth-state subscription. Synthesise a User-shaped object so existing
      // consumers (which type-check against @supabase/supabase-js's User) work.
      // Skip loadProfile entirely — it calls supabase.from('users') against the
      // non-existent 54321; the profile fields we'd fetch are populated below
      // from /api/me directly.
      ;(async () => {
        try {
          const me = await dbClient.me.get()
          if (!isMounted) return
          const u = {
            id: me.userId,
            email: me.email,
            app_metadata: {},
            user_metadata: {},
            aud: 'authenticated',
            created_at: new Date(0).toISOString(),
          } as User
          setUser(u)
          setProfile({
            id: me.userId,
            email: me.email,
            full_name: null,
            avatar_sticker: null,
          })
        } catch {
          if (isMounted) setUser(null)
        } finally {
          if (isMounted) setLoading(false)
        }
      })()
      return () => { isMounted = false }
    }

    ;(async () => {
      const { data: { user: u } } = await supabase.auth.getUser()
      if (!isMounted) return
      setUser(u ?? null)
      await loadProfile(u ?? null)
      if (isMounted) setLoading(false)
    })()
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      const nextUser = session?.user ?? null
      setUser(nextUser)
      loadProfile(nextUser)
    })
    return () => {
      isMounted = false
      subscription.unsubscribe()
    }
  }, [loadProfile])

  const refreshProfile = useCallback(async () => {
    await loadProfile(user)
  }, [loadProfile, user])

  const signIn = async (email: string, redirectTo?: string) => {
    if (TIER === '0') {
      // Tier 0 doesn't have login — the user is resolved at backend boot.
      return { error: new Error('Sign-in is not available in Tier 0 (single-user, no auth UI)') }
    }
    const options: { email: string; options?: { emailRedirectTo?: string } } = { email }
    if (typeof window !== 'undefined') {
      const isProd = import.meta.env.PROD
      const baseUrl = isProd
        ? import.meta.env.VITE_APP_URL
        : import.meta.env.VITE_APP_URL_DEV || window.location.origin
      const path = redirectTo ? (redirectTo.startsWith('/') ? redirectTo : `/${redirectTo}`) : '/dashboard'
      options.options = { emailRedirectTo: `${baseUrl}${path}` }
    }
    const { error } = await supabase.auth.signInWithOtp(options)
    return { error: error ? new Error(error.message) : null }
  }

  const signOut = async () => {
    if (TIER === '0') return  // no-op in single-user Tier 0
    await supabase.auth.signOut()
  }

  return (
    <AuthContext.Provider value={{ user, loading, profile, refreshProfile, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
