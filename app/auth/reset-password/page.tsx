'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'

export default function ResetPasswordPage() {
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [hasSession, setHasSession] = useState<boolean | null>(null)
  const router = useRouter()

  const supabase = createClient()

  useEffect(() => {
    // The user should arrive here with an active recovery session
    // (Supabase exchanges the recovery token automatically when the page loads
    // because we configured detectSessionInUrl on the browser client)
    let cancelled = false

    async function check() {
      // Give Supabase a moment to process any URL hash params
      await new Promise((r) => setTimeout(r, 100))
      const { data } = await supabase.auth.getSession()
      if (cancelled) return
      setHasSession(!!data.session)
    }

    check()

    // Also listen for the PASSWORD_RECOVERY event
    const { data: listener } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN') {
        setHasSession(true)
      }
    })

    return () => {
      cancelled = true
      listener.subscription.unsubscribe()
    }
  }, [supabase])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    if (password !== confirmPassword) {
      toast.error('Passwords do not match')
      return
    }

    if (password.length < 8) {
      toast.error('Password must be at least 8 characters')
      return
    }

    setLoading(true)

    const { error } = await supabase.auth.updateUser({ password })

    setLoading(false)

    if (error) {
      toast.error(error.message)
      return
    }

    toast.success('Password updated. Signing you in...')
    setTimeout(() => {
      router.push('/dashboard')
      router.refresh()
    }, 500)
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-brand-dark">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <p className="text-brand-rose-gold text-[10px] font-bold tracking-[2px] uppercase">
            AI Wealth Partners
          </p>
          <h1 className="text-brand-cream text-3xl font-display mt-1">ProspectIQ</h1>
          <p className="text-brand-beige text-sm mt-2">Set a new password</p>
        </div>

        <div className="bg-brand-charcoal-deep rounded-2xl border border-brand-charcoal p-8">
          {hasSession === false ? (
            <div className="text-center">
              <h2 className="text-brand-cream text-lg font-medium mb-2">Link expired or invalid</h2>
              <p className="text-brand-beige text-sm mb-6">
                This password reset link is no longer valid. Please request a new one.
              </p>
              <Link href="/auth/forgot-password" className="btn-primary inline-block">
                Request new reset link
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-brand-cream text-sm font-medium mb-1.5">New password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  className="w-full"
                  required
                  minLength={8}
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-brand-cream text-sm font-medium mb-1.5">Confirm password</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Repeat the password"
                  className="w-full"
                  required
                  minLength={8}
                />
              </div>
              <button type="submit" className="btn-primary w-full" disabled={loading || hasSession === null}>
                {loading ? 'Updating...' : hasSession === null ? 'Verifying...' : 'Update password'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
