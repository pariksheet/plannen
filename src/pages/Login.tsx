import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth, passkeysSupported } from '../context/AuthContext'
import { Mail, AlertTriangle, KeyRound, Fingerprint } from 'lucide-react'
import { Modal } from '../components/Modal'
import { TIER } from '../lib/tier'

export function Login() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const redirectTo = searchParams.get('redirect') ?? undefined
  const { signIn, verifyEmailOtp, signInWithPasskey, registerPasskey, profile, passkeysEnabled } = useAuth()
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [pendingSwitchEmail, setPendingSwitchEmail] = useState<string | null>(null)
  const [otpSentEmail, setOtpSentEmail] = useState<string | null>(null)
  const [otp, setOtp] = useState('')
  const [otpLoading, setOtpLoading] = useState(false)
  const [passkeyLoading, setPasskeyLoading] = useState(false)
  const [offerEnrol, setOfferEnrol] = useState(false)
  const [enrolling, setEnrolling] = useState(false)
  const showPasskeyOption = passkeysEnabled && passkeysSupported()

  const PASSKEY_ENROL_OPT_OUT_KEY = 'plannen.passkey_enrol_opt_out'

  const navigateAfterLogin = () => {
    const target = redirectTo
      ? (redirectTo.startsWith('/') ? redirectTo : `/${redirectTo}`)
      : '/dashboard'
    navigate(target, { replace: true })
  }

  const handleEnrolNow = async () => {
    setEnrolling(true)
    setError('')
    const { error: err } = await registerPasskey()
    setEnrolling(false)
    if (err) {
      setError(err.message)
      return
    }
    navigateAfterLogin()
  }

  const handleEnrolDismiss = (forever: boolean) => {
    if (forever) {
      try { window.localStorage.setItem(PASSKEY_ENROL_OPT_OUT_KEY, '1') } catch { /* ignore */ }
    }
    navigateAfterLogin()
  }

  const performPasskeySignIn = async () => {
    setPasskeyLoading(true)
    setError('')
    setMessage('')
    const { error: err } = await signInWithPasskey()
    if (err) {
      setError(err.message)
      setPasskeyLoading(false)
      return
    }
    const target = redirectTo
      ? (redirectTo.startsWith('/') ? redirectTo : `/${redirectTo}`)
      : '/dashboard'
    navigate(target, { replace: true })
  }

  // Tier 0: AuthContext auto-resolves the user at boot. Prefill the field
  // with the current identity so the user can either continue as themselves
  // or type a different email to switch.
  useEffect(() => {
    if (TIER === '0' && profile?.email && !email) setEmail(profile.email)
  }, [profile, email])

  const performSignIn = async (targetEmail: string) => {
    setLoading(true)
    setError('')
    setMessage('')
    const { error: err } = await signIn(targetEmail, redirectTo)
    if (err) {
      setError(err.message)
      setLoading(false)
      return
    }
    if (TIER === '0') {
      const target = redirectTo
        ? (redirectTo.startsWith('/') ? redirectTo : `/${redirectTo}`)
        : '/'
      navigate(target, { replace: true })
      return
    }
    setMessage('We sent you an email with both a magic link and a 6-digit code.')
    setOtpSentEmail(targetEmail.trim().toLowerCase())
    setOtp('')
    setLoading(false)
  }

  const performVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!otpSentEmail) return
    const code = otp.trim()
    if (code.length < 6) {
      setError('Enter the code from the email (6–10 digits).')
      return
    }
    setOtpLoading(true)
    setError('')
    const { error: err } = await verifyEmailOtp(otpSentEmail, code)
    if (err) {
      setError(err.message)
      setOtpLoading(false)
      return
    }
    let optedOut = false
    try { optedOut = window.localStorage.getItem(PASSKEY_ENROL_OPT_OUT_KEY) === '1' } catch { /* ignore */ }
    if (showPasskeyOption && !optedOut) {
      setOtpLoading(false)
      setOfferEnrol(true)
      return
    }
    navigateAfterLogin()
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = email.trim().toLowerCase()
    // Tier 0: if the user types a different email, that creates/switches to a
    // new local identity. Previous data stays in the DB but becomes invisible.
    // Confirm before doing anything irreversible.
    if (
      TIER === '0' &&
      profile?.email &&
      trimmed &&
      trimmed !== profile.email.trim().toLowerCase()
    ) {
      setPendingSwitchEmail(trimmed)
      return
    }
    await performSignIn(email)
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="max-w-md w-full space-y-8 p-4 sm:p-8">
        <div>
          <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900">Welcome to Plannen</h2>
          <p className="mt-2 text-center text-sm text-gray-600">Social planning with your circle</p>
        </div>
        {showPasskeyOption && (
          <div className="mt-6 space-y-3">
            <button
              type="button"
              onClick={performPasskeySignIn}
              disabled={passkeyLoading}
              className="w-full flex items-center justify-center gap-2 py-3 px-4 min-h-[44px] border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-800 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
            >
              <Fingerprint className="h-5 w-5 text-indigo-600" />
              {passkeyLoading ? 'Waiting for your passkey…' : 'Sign in with a passkey'}
            </button>
            <div className="flex items-center gap-3 text-xs text-gray-400">
              <div className="flex-1 h-px bg-gray-200" />
              <span>or</span>
              <div className="flex-1 h-px bg-gray-200" />
            </div>
          </div>
        )}
        <form className={showPasskeyOption ? 'mt-2 space-y-6' : 'mt-8 space-y-6'} onSubmit={handleSubmit}>
          <div>
            <label htmlFor="email" className="sr-only">Email address</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Mail className="h-5 w-5 text-gray-400" />
              </div>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="appearance-none rounded-md relative block w-full pl-10 px-3 py-2 min-h-[44px] border border-gray-300 placeholder-gray-500 text-gray-900 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                placeholder="Email address"
              />
            </div>
          </div>
          {error && (
            <div className="rounded-md bg-red-50 p-4">
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}
          {message && (
            <div className="rounded-md bg-green-50 p-4">
              <p className="text-sm text-green-800">{message}</p>
            </div>
          )}
          <div>
            <button
              type="submit"
              disabled={loading}
              className="w-full flex justify-center py-3 px-4 min-h-[44px] border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
            >
              {loading
                ? 'Sending...'
                : TIER === '0'
                  ? 'Sign in / switch identity'
                  : 'Sign in with Email'}
            </button>
          </div>
          <p className="text-center text-sm text-gray-600">
            {TIER === '0'
              ? 'Local single-user mode — sign in with this email or type a different one to switch identity'
              : 'We’ll send a magic link plus a 6-digit code — use either one'}
          </p>
        </form>

        {offerEnrol && (
          <div className="mt-4 rounded-lg border border-indigo-200 bg-indigo-50 p-4 space-y-3">
            <div className="flex items-start gap-3">
              <Fingerprint className="h-6 w-6 text-indigo-600 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-indigo-900">Set up a passkey for faster sign-in?</p>
                <p className="text-xs text-indigo-800 mt-1">Use your fingerprint, face, or device PIN to sign in next time — no email codes.</p>
              </div>
            </div>
            {error && (
              <p className="text-xs text-red-700">{error}</p>
            )}
            <div className="flex flex-wrap gap-2 justify-end">
              <button
                type="button"
                onClick={() => handleEnrolDismiss(true)}
                className="min-h-[36px] px-3 py-1.5 text-xs rounded-md text-indigo-700 hover:bg-indigo-100"
              >
                Don&apos;t ask again
              </button>
              <button
                type="button"
                onClick={() => handleEnrolDismiss(false)}
                className="min-h-[36px] px-3 py-1.5 text-xs rounded-md text-indigo-700 hover:bg-indigo-100"
              >
                Skip for now
              </button>
              <button
                type="button"
                onClick={handleEnrolNow}
                disabled={enrolling}
                className="min-h-[36px] px-3 py-1.5 text-xs rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {enrolling ? 'Setting up…' : 'Set up passkey'}
              </button>
            </div>
          </div>
        )}

        {otpSentEmail && !offerEnrol && TIER !== '0' && (
          <form onSubmit={performVerifyOtp} className="mt-2 space-y-3">
            <label htmlFor="otp" className="block text-sm font-medium text-gray-700">
              Enter the code from the email
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <KeyRound className="h-5 w-5 text-gray-400" />
              </div>
              <input
                id="otp"
                name="otp"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6,10}"
                maxLength={10}
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 10))}
                className="appearance-none rounded-md relative block w-full pl-10 px-3 py-2 min-h-[44px] tracking-widest text-center text-lg border border-gray-300 placeholder-gray-400 text-gray-900 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500"
                placeholder="123456"
              />
            </div>
            <button
              type="submit"
              disabled={otpLoading || otp.length < 6}
              className="w-full flex justify-center py-3 px-4 min-h-[44px] border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
            >
              {otpLoading ? 'Verifying…' : 'Verify code'}
            </button>
            <p className="text-xs text-gray-500 text-center">
              Or tap the magic link in the email — both work.
            </p>
          </form>
        )}
        <p className="mt-6 text-center">
          <Link to="/privacy" className="text-sm text-indigo-600 hover:text-indigo-700">
            Privacy &amp; data
          </Link>
        </p>
      </div>

      <Modal
        isOpen={pendingSwitchEmail !== null}
        onClose={() => setPendingSwitchEmail(null)}
        title="Switch local identity?"
      >
        <div className="space-y-4 text-sm text-gray-700">
          <div className="flex gap-3 rounded-md bg-amber-50 p-3 text-amber-900">
            <AlertTriangle className="h-5 w-5 flex-shrink-0" />
            <p>
              You are about to switch from <strong>{profile?.email}</strong> to{' '}
              <strong>{pendingSwitchEmail}</strong>. Your existing events,
              memories and stories stay in the database but won&apos;t be
              visible from this account — switch back by signing in with the
              previous email.
            </p>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={() => setPendingSwitchEmail(null)}
              className="min-h-[44px] px-4 py-2 text-sm rounded-md border border-gray-300 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={async () => {
                const target = pendingSwitchEmail
                setPendingSwitchEmail(null)
                if (target) await performSignIn(target)
              }}
              className="min-h-[44px] px-4 py-2 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700"
            >
              Switch identity
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
