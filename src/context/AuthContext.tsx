import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from 'react'
import { User, PasskeyListItem } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { dbClient } from '../lib/dbClient'
import { TIER } from '../lib/tier'

type UserProfile = {
  id: string
  email: string | null
  full_name: string | null
  avatar_sticker: string | null
  primary_group_id: string | null
}

const TIER_ZERO_PASSKEY_ERR = new Error('Passkeys are not available in single-user local mode.')
const PASSKEYS_DISABLED_ERR = new Error('Passkeys are not enabled on this deployment.')

// VITE_PASSKEYS_ENABLED gates the UI + AuthContext methods so the prod UI
// stays clean while we wait for Supabase to allow the passkey config write
// on this project. Flip to "true" on Vercel (production env) and redeploy
// once `npx plannen cloud passkeys enable --profile sb_prod` returns OK.
export const passkeysFeatureFlag = (): boolean =>
  String(import.meta.env.VITE_PASSKEYS_ENABLED ?? '').toLowerCase() === 'true'

export const passkeysSupported = (): boolean =>
  TIER !== '0' &&
  passkeysFeatureFlag() &&
  typeof window !== 'undefined' &&
  typeof window.PublicKeyCredential !== 'undefined'

type AuthContextType = {
  user: User | null
  loading: boolean
  profile: UserProfile | null
  refreshProfile: () => Promise<void>
  signIn: (email: string, redirectTo?: string) => Promise<{ error: Error | null }>
  verifyEmailOtp: (email: string, token: string) => Promise<{ error: Error | null }>
  signOut: () => Promise<void>
  passkeysEnabled: boolean
  signInWithPasskey: () => Promise<{ error: Error | null }>
  registerPasskey: () => Promise<{ error: Error | null }>
  listPasskeys: () => Promise<{ data: PasskeyListItem[] | null; error: Error | null }>
  renamePasskey: (passkeyId: string, friendlyName: string) => Promise<{ error: Error | null }>
  deletePasskey: (passkeyId: string) => Promise<{ error: Error | null }>
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
      if (TIER === '0') {
        // Tier 0: /api/me returns the auth-linked row including full_name +
        // avatar_url; no Supabase round-trip.
        try {
          const me = await dbClient.me.get() as {
            userId: string
            email: string
            full_name?: string | null
            avatar_url?: string | null
          }
          setProfile({
            id: me.userId,
            email: me.email,
            full_name: me.full_name ?? null,
            avatar_sticker: me.avatar_url ?? null,
            primary_group_id: null,
          })
        } catch {
          setProfile(null)
        }
        return
      }
      const { data, error } = await supabase
        .from('users')
        .select('id, email, full_name, avatar_url, primary_group_id')
        .eq('id', u.id)
        .maybeSingle()
      if (error || !data) {
        setProfile(null)
        return
      }
      const { id, email, full_name, avatar_url, primary_group_id } = data as {
        id: string
        email: string | null
        full_name: string | null
        avatar_url: string | null
        primary_group_id: string | null
      }
      setProfile({
        id,
        email,
        full_name,
        avatar_sticker: avatar_url,
        primary_group_id,
      })
    },
    []
  )

  useEffect(() => {
    let isMounted = true

    if (TIER === '0') {
      // Tier 0: no Supabase Auth. The backend resolves the single user at boot
      // from PLANNEN_USER_EMAIL and exposes them via GET /api/me, which also
      // includes full_name + avatar_url. No login UI; no auth-state subscription.
      // Synthesise a User-shaped object so existing consumers (which type-check
      // against @supabase/supabase-js's User) work.
      ;(async () => {
        try {
          const me = await dbClient.me.get() as {
            userId: string
            email: string
            full_name?: string | null
            avatar_url?: string | null
          }
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
            full_name: me.full_name ?? null,
            avatar_sticker: me.avatar_url ?? null,
            primary_group_id: null,
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
      // Tier 0 web-UI signup: POST /api/me creates the auth.users +
      // plannen.users rows (or resolves them if the email already exists),
      // rewrites PLANNEN_USER_EMAIL in .env, and mutates the backend's
      // in-memory identity. We then mirror the new user into AuthContext so
      // ProtectedRoute lets the caller through.
      try {
        const me = await dbClient.me.signup(email)
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
          full_name: me.full_name ?? null,
          avatar_sticker: me.avatar_url ?? null,
          primary_group_id: null,
        })
        return { error: null }
      } catch (e) {
        return { error: e instanceof Error ? e : new Error(String(e)) }
      }
    }
    const options: { email: string; options?: { emailRedirectTo?: string } } = { email }
    if (typeof window !== 'undefined') {
      const baseUrl = window.location.origin
      const path = redirectTo ? (redirectTo.startsWith('/') ? redirectTo : `/${redirectTo}`) : '/dashboard'
      options.options = { emailRedirectTo: `${baseUrl}${path}` }
    }
    const { error } = await supabase.auth.signInWithOtp(options)
    return { error: error ? new Error(error.message) : null }
  }

  const verifyEmailOtp = async (email: string, token: string) => {
    if (TIER === '0') {
      return { error: new Error('OTP not used in Tier 0 — sign-in is identity-switch only.') }
    }
    const cleanEmail = email.trim().toLowerCase()
    const cleanToken = token.trim()
    // signInWithOtp sends a magic-link-flavoured token; some Supabase versions
    // verify it under type='email', others under type='magiclink'. Try the
    // documented one first, fall back to the legacy one so we're not at the
    // mercy of GoTrue's exact build.
    const first = await supabase.auth.verifyOtp({ email: cleanEmail, token: cleanToken, type: 'email' })
    if (!first.error) return { error: null }
    const second = await supabase.auth.verifyOtp({ email: cleanEmail, token: cleanToken, type: 'magiclink' })
    if (!second.error) return { error: null }
    return { error: new Error(first.error.message) }
  }

  const signOut = async () => {
    if (TIER === '0') return  // no-op in single-user Tier 0
    await supabase.auth.signOut()
  }

  const passkeyGate = (): Error | null => {
    if (TIER === '0') return TIER_ZERO_PASSKEY_ERR
    if (!passkeysFeatureFlag()) return PASSKEYS_DISABLED_ERR
    return null
  }

  const signInWithPasskey = async () => {
    const gate = passkeyGate()
    if (gate) return { error: gate }
    const { error } = await supabase.auth.signInWithPasskey()
    return { error: error ? new Error(error.message) : null }
  }

  const registerPasskey = async () => {
    const gate = passkeyGate()
    if (gate) return { error: gate }
    const { error } = await supabase.auth.registerPasskey()
    return { error: error ? new Error(error.message) : null }
  }

  const listPasskeys = async () => {
    const gate = passkeyGate()
    if (gate) return { data: null, error: gate }
    const { data, error } = await supabase.auth.passkey.list()
    return { data: data ?? null, error: error ? new Error(error.message) : null }
  }

  const renamePasskey = async (passkeyId: string, friendlyName: string) => {
    const gate = passkeyGate()
    if (gate) return { error: gate }
    const { error } = await supabase.auth.passkey.update({ passkeyId, friendlyName })
    return { error: error ? new Error(error.message) : null }
  }

  const deletePasskey = async (passkeyId: string) => {
    const gate = passkeyGate()
    if (gate) return { error: gate }
    const { error } = await supabase.auth.passkey.delete({ passkeyId })
    return { error: error ? new Error(error.message) : null }
  }

  return (
    <AuthContext.Provider value={{
      user,
      loading,
      profile,
      refreshProfile,
      signIn,
      verifyEmailOtp,
      signOut,
      passkeysEnabled: TIER !== '0' && passkeysFeatureFlag(),
      signInWithPasskey,
      registerPasskey,
      listPasskeys,
      renamePasskey,
      deletePasskey,
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
