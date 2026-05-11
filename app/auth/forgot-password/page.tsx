'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import Link from 'next/link'
import { toast } from 'sonner'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)

  const supabase = createClient()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/reset-password`,
    })

    setLoading(false)

    if (error) {
      toast.error(error.message)
      return
    }

    setSent(true)
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-brand-dark">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <p className="text-brand-rose-gold text-[10px] font-bold tracking-[2px] uppercase">
            AI Wealth Partners
          </p>
          <h1 className="text-brand-cream text-3xl font-display mt-1">ProspectIQ</h1>
          <p className="text-brand-beige text-sm mt-2">Reset your password</p>
        </div>

        <div className="bg-brand-charcoal-deep rounded-2xl border border-brand-charcoal p-8">
          {sent ? (
            <div className="text-center">
              <div className="w-12 h-12 rounded-full bg-brand-rose-gold/20 flex items-center justify-center mx-auto mb-4">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-brand-rose-gold">
                  <path d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h2 className="text-brand-cream text-lg font-medium mb-2">Check your email</h2>
              <p className="text-brand-beige text-sm">
                If an account exists for <span className="text-brand-cream">{email}</span>, you will receive a password reset link shortly.
              </p>
              <p className="text-brand-beige text-xs mt-4">
                Check your spam folder if you do not see it within a couple of minutes.
              </p>
              <Link href="/auth/login" className="inline-block mt-6 text-brand-rose-gold text-sm hover:underline">
                Back to sign in
              </Link>
            </div>
          ) : (
            <>
              <p className="text-brand-beige text-sm mb-6">
                Enter the email associated with your account and we will send you a link to reset your password.
              </p>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-brand-cream text-sm font-medium mb-1.5">Email</label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@company.com"
                    className="w-full"
                    required
                    autoFocus
                  />
                </div>
                <button type="submit" className="btn-primary w-full" disabled={loading}>
                  {loading ? 'Sending...' : 'Send reset link'}
                </button>
              </form>

              <p className="text-brand-beige text-sm text-center mt-6">
                <Link href="/auth/login" className="text-brand-rose-gold hover:underline">
                  Back to sign in
                </Link>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
