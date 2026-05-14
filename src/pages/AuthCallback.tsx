import { useEffect, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'

const TIER = (import.meta.env.VITE_PLANNEN_TIER ?? '1') as '0' | '1'

export function AuthCallback() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return
    ran.current = true

    if (TIER === '0') {
      // No magic-link flow in Tier 0; user is already signed in via /api/me.
      navigate('/dashboard', { replace: true })
      return
    }

    const tokenHash = searchParams.get('token_hash')
    const type = searchParams.get('type') as 'magiclink' | 'email' | null

    if (tokenHash && type) {
      supabase.auth.verifyOtp({ token_hash: tokenHash, type }).then(({ error }) => {
        if (error) {
          navigate('/login?error=invalid_link', { replace: true })
        } else {
          navigate('/dashboard', { replace: true })
        }
      })
    } else {
      navigate('/dashboard', { replace: true })
    }
  }, [navigate, searchParams])

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <p className="text-gray-600">Signing you in…</p>
    </div>
  )
}
