'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'

// v75.6: messages for the ?error= values the auth routes redirect here with.
const LINK_ERRORS: Record<string, string> = {
  link_expired:
    'That link has expired or has already been used. If you have just confirmed your email, sign in below. If not, sign in and we will offer to send a new link.',
  auth_callback_failed:
    'We could not complete that sign-in link. If you have just confirmed your email, sign in below.',
}

// v75.6: only follow same-site relative paths after sign-in, so a crafted
// ?redirect= link cannot send someone to another site.
function safeRedirect(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/dashboard'
  return raw
}

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [unconfirmed, setUnconfirmed] = useState(false)
  const [resending, setResending] = useState(false)
  const [resent, setResent] = useState(false)
  const router = useRouter()
  const searchParams = useSearchParams()
  const redirect = safeRedirect(searchParams.get('redirect'))
  const errorKey = searchParams.get('error') || ''
  // hasOwnProperty, so ?error=__proto__ cannot pull an object out of LINK_ERRORS
  const linkError = Object.prototype.hasOwnProperty.call(LINK_ERRORS, errorKey) ? LINK_ERRORS[errorKey] : null

  const supabase = createClient()

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setUnconfirmed(false)

    const { error } = await supabase.auth.signInWithPassword({ email, password })

    if (error) {
      // v75.6: the account exists but the confirmation link has not been clicked.
      // Offer to resend rather than leaving them stuck.
      if (error.code === 'email_not_confirmed' || /not confirmed/i.test(error.message)) {
        setUnconfirmed(true)
        setResent(false)
      } else {
        toast.error(error.message)
      }
      setLoading(false)
      return
    }

    router.push(redirect)
    router.refresh()
  }

  async function handleResend() {
    setResending(true)
    const { error } = await supabase.auth.resend({
      type: 'signup',
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback?next=/dashboard`,
      },
    })
    setResending(false)

    if (error) {
      toast.error(error.message)
      return
    }

    setResent(true)
    toast.success('Confirmation email sent. Check your inbox and spam folder.')
  }

  async function handleGoogleLogin() {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/callback?next=${redirect}`,
      },
    })
    if (error) toast.error(error.message)
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-brand-dark">
      <div className="w-full max-w-md">
        {/* Brand */}
        <div className="text-center mb-8">
          <p className="text-brand-rose-gold text-[10px] font-bold tracking-[2px] uppercase">
            AI Wealth Partners
          </p>
          <h1 className="text-brand-cream text-3xl font-display mt-1">ProspectIQ</h1>
          <p className="text-brand-beige text-sm mt-2">Sign in to your account</p>
        </div>

        {/* Card */}
        <div className="bg-brand-charcoal-deep rounded-2xl border border-brand-charcoal p-8">
          {linkError && !unconfirmed && (
            <div className="bg-brand-rose-gold/10 border border-brand-rose-gold/30 rounded-lg p-4 mb-6">
              <p className="text-brand-cream text-sm">{linkError}</p>
            </div>
          )}

          {unconfirmed && (
            <div className="bg-brand-rose-gold/10 border border-brand-rose-gold/30 rounded-lg p-4 mb-6">
              <p className="text-brand-cream text-sm font-semibold">Please confirm your email first</p>
              <p className="text-brand-beige text-sm mt-1">
                {resent
                  ? <>We sent a new link to <strong className="text-brand-cream">{email}</strong>. It can take a minute or two, so check your spam folder too.</>
                  : <>We sent a confirmation link to <strong className="text-brand-cream">{email}</strong> when you signed up. Click it, then sign in here.</>}
              </p>
              {!resent && (
                <button
                  type="button"
                  onClick={handleResend}
                  disabled={resending}
                  className="btn-secondary w-full mt-3"
                >
                  {resending ? 'Sending...' : 'Send the link again'}
                </button>
              )}
            </div>
          )}

          {/* Google OAuth */}
          <button
            onClick={handleGoogleLogin}
            className="w-full btn-secondary flex items-center justify-center gap-3 mb-6"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            Continue with Google
          </button>

          {/* Divider */}
          <div className="flex items-center gap-4 mb-6">
            <div className="flex-1 h-px bg-brand-charcoal" />
            <span className="text-brand-beige text-xs uppercase tracking-wide">or</span>
            <div className="flex-1 h-px bg-brand-charcoal" />
          </div>

          {/* Email form */}
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-brand-cream text-sm font-medium mb-1.5">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                className="w-full"
                required
              />
            </div>
            <div>
              <label className="block text-brand-cream text-sm font-medium mb-1.5">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Your password"
                className="w-full"
                required
                minLength={8}
              />
            </div>
            <button type="submit" className="btn-primary w-full" disabled={loading}>
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>

          <p className="text-brand-beige text-sm text-center mt-4">
            <Link href="/auth/forgot-password" className="text-brand-rose-gold hover:underline">
              Forgot password?
            </Link>
          </p>

          <p className="text-brand-beige text-sm text-center mt-6">
            No account?{' '}
            <Link href="/auth/signup" className="text-brand-rose-gold hover:underline">
              Start free trial
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}
