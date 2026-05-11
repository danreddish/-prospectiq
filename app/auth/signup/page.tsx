'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'

export default function SignupPage() {
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const router = useRouter()
  const supabase = createClient()

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: fullName },
        emailRedirectTo: `${window.location.origin}/auth/callback?next=/dashboard`,
      },
    })

    if (error) {
      toast.error(error.message)
      setLoading(false)
      return
    }

    setSent(true)
  }

  if (sent) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-brand-dark">
        <div className="w-full max-w-md text-center">
          <div className="bg-brand-charcoal-deep rounded-2xl border border-brand-charcoal p-8">
            <div className="w-16 h-16 bg-brand-rose-gold/20 rounded-full flex items-center justify-center mx-auto mb-4">
              <span className="text-brand-rose-gold text-2xl">&#9993;</span>
            </div>
            <h2 className="text-brand-cream text-xl font-display mb-2">Check your email</h2>
            <p className="text-brand-beige text-sm">
              We sent a confirmation link to <strong className="text-brand-cream">{email}</strong>.
              Click the link to activate your account and start your free trial.
            </p>
          </div>
        </div>
      </div>
    )
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
          <p className="text-brand-beige text-sm mt-2">Start your 7-day free trial</p>
        </div>

        {/* Card */}
        <div className="bg-brand-charcoal-deep rounded-2xl border border-brand-charcoal p-8">
          {/* Trial badge */}
          <div className="bg-brand-rose-gold/10 border border-brand-rose-gold/30 rounded-lg p-4 mb-6 text-center">
            <p className="text-brand-rose-gold text-sm font-semibold">
              7-day free trial &middot; 5 prospect researches &middot; No card required
            </p>
          </div>

          <form onSubmit={handleSignup} className="space-y-4">
            <div>
              <label className="block text-brand-cream text-sm font-medium mb-1.5">Full Name</label>
              <input
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Your full name"
                className="w-full"
                required
              />
            </div>
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
                placeholder="Minimum 8 characters"
                className="w-full"
                required
                minLength={8}
              />
            </div>
            <button type="submit" className="btn-primary w-full" disabled={loading}>
              {loading ? 'Creating account...' : 'Start Free Trial'}
            </button>
          </form>

          <p className="text-brand-beige text-xs text-center mt-4">
            By signing up you agree to our{' '}
            <a href="/terms" className="text-brand-rose-gold hover:underline">Terms</a> and{' '}
            <a href="/privacy" className="text-brand-rose-gold hover:underline">Privacy Policy</a>.
          </p>

          <p className="text-brand-beige text-sm text-center mt-6">
            Already have an account?{' '}
            <Link href="/auth/login" className="text-brand-rose-gold hover:underline">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}
