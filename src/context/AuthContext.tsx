import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from 'react'
import { User } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'

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
