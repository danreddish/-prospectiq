'use client'

import { useState, useEffect } from 'react'
import PhoneDemo, { PHONE_DEMO_START_TOUR_EVENT } from '@/components/demo/PhoneDemo'

/* ============================================================================
   Main page
   ============================================================================ */

export default function DemoPage() {
  // Waitlist form state
  const [waitlistCount, setWaitlistCount] = useState<number | null>(null)
  const [showRecentSignups, setShowRecentSignups] = useState(false)

  // Fetch waitlist count once on mount
  useEffect(() => {
    fetch('/api/waitlist')
      .then((r) => r.json())
      .then((d) => {
        if (typeof d?.count === 'number') setWaitlistCount(d.count)
      })
      .catch(() => {
        // Silently fall through — UI shows count of 0 if API isn't reachable
      })
  }, [])

  // The guided tour state lives inside PhoneDemo. This button sits outside the
  // phone, so it asks the phone to start the tour.
  const handleStartTour = () => {
    window.dispatchEvent(new Event(PHONE_DEMO_START_TOUR_EVENT))
  }

  const scrollToWaitlist = () => {
    const el = document.getElementById('waitlist')
    if (el) el.scrollIntoView({ behavior: 'smooth' })
  }

  return (
    <main className="min-h-screen bg-[#0a0a0a] text-[#fbf9f4] antialiased">
      {/* Top bar */}
      <header className="sticky top-0 z-40 backdrop-blur-md bg-[#0a0a0a]/75 border-b border-[#c49f8c]/10">
        <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between">
          <img
            src="/prospectiq-monogram.png"
            alt="ProspectIQ"
            className="h-12 w-auto"
          />
          <button
            onClick={scrollToWaitlist}
            className="text-sm px-4 py-2 rounded-full border border-[#c49f8c]/40 text-[#c49f8c] hover:bg-[#c49f8c] hover:text-[#0a0a0a] transition-colors"
          >
            Get early access
          </button>
        </div>
      </header>

      {/* Hero with full lockup */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 pointer-events-none opacity-25">
          <div className="absolute top-20 -left-20 w-[440px] h-[440px] bg-[#c49f8c] rounded-full blur-[140px]" />
          <div className="absolute bottom-0 right-0 w-[400px] h-[400px] bg-[#a18d89] rounded-full blur-[150px]" />
        </div>

        <div className="relative max-w-6xl mx-auto px-6 pt-16 pb-12 text-center">
          <img
            src="/prospectiq-logo.png"
            alt="ProspectIQ. HNW Prospect Intelligence. For advisors who'd rather have less, but better."
            className="w-full max-w-[680px] h-auto mx-auto"
          />
          <p className="text-base md:text-lg text-[#fbf9f4]/70 leading-relaxed max-w-xl mx-auto mt-10 mb-8">
            A live demo of the prospect intelligence platform built for wealth managers,
            IFAs, planners and brokers.
          </p>
          <div className="flex flex-wrap gap-3 justify-center">
            <button
              onClick={handleStartTour}
              className="px-6 py-3 rounded-full bg-[#c49f8c] text-[#0a0a0a] font-semibold text-sm hover:bg-[#d4b09d] transition-colors tracking-wide"
            >
              Take the guided tour
            </button>
            <button
              onClick={scrollToWaitlist}
              className="px-6 py-3 rounded-full border border-[#c49f8c]/40 text-[#c49f8c] text-sm hover:bg-[#c49f8c]/10 transition-colors tracking-wide"
            >
              Skip to waitlist
            </button>
          </div>
          <div className="mt-8 text-xs tracking-wider text-[#fbf9f4]/40 uppercase">
            No login required &middot; Mock data &middot; Two minutes
          </div>
        </div>

        {/* Phone, centred */}
        <div className="relative max-w-6xl mx-auto px-6 pb-20 flex justify-center">
          <PhoneDemo />
        </div>
      </section>

      {/* Waitlist */}
      <section id="waitlist" className="relative py-20 px-6">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-[#c49f8c]/8 rounded-full blur-[140px]" />
        </div>
        <div className="relative max-w-xl mx-auto">
          <WaitlistForm initialCount={waitlistCount} />
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-[#c49f8c]/8 py-6 px-6 text-center text-xs tracking-wider text-[#fbf9f4]/30">
        ProspectIQ &middot; Built by AI Wealth Partners
      </footer>
    </main>
  )
}

/* ============================================================================
   Waitlist form
   ============================================================================ */

const FOUNDER_LIMIT = 100

interface WaitlistFormProps {
  initialCount: number | null
}

function WaitlistForm({ initialCount }: WaitlistFormProps) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('')
  const [roleOther, setRoleOther] = useState('')
  const [consent, setConsent] = useState(false)

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [position, setPosition] = useState<number | null>(null)

  const count = initialCount ?? 0
  const remaining = Math.max(0, FOUNDER_LIMIT - count)
  const isFull = remaining === 0

  const reset = () => {
    setName('')
    setEmail('')
    setRole('')
    setRoleOther('')
    setConsent(false)
    setSuccess(false)
    setPosition(null)
    setError(null)
  }

  const handleSubmit = async () => {
    setError(null)
    if (!name.trim()) return setError('Please add your name.')
    if (!email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return setError('Please add a valid email.')
    if (!role) return setError('Please select your role.')
    if (role === 'other' && !roleOther.trim())
      return setError('Please tell us your role.')
    if (!consent) return setError('Please tick the consent box.')

    setSubmitting(true)
    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim().toLowerCase(),
          role,
          role_other: roleOther.trim() || null,
          consent: true,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data?.error || 'Something went wrong. Please try again.')
        setSubmitting(false)
        return
      }
      setPosition(data?.position ?? null)
      setSuccess(true)
    } catch (e) {
      setError('Network error. Please check your connection and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (success) {
    const isFounder = position != null && position <= FOUNDER_LIMIT
    return (
      <div className="rounded-2xl bg-[#171515] border border-[#c49f8c]/30 p-9 text-center animate-[piqFade_0.5s_ease-out]">
        <div className="w-14 h-14 mx-auto mb-5 rounded-full bg-gradient-to-br from-[#c49f8c] to-[#a18d89] flex items-center justify-center">
          <svg width="28" height="28" fill="none" viewBox="0 0 24 24" stroke="#0a0a0a" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <p className="text-[11px] tracking-[0.3em] uppercase text-[#c49f8c] mb-3">
          {isFounder ? "You're a founding member" : "You're on the waitlist"}
        </p>
        <h2 className="font-serif text-3xl leading-tight mb-3.5">
          {isFounder ? (
            <>Welcome, <span className="italic text-[#c49f8c]">founder #{position}</span></>
          ) : (
            'Thanks for signing up'
          )}
        </h2>
        <p className="text-[#fbf9f4]/70 leading-relaxed max-w-[400px] mx-auto text-sm">
          {isFounder
            ? 'You have locked in lifetime founding member pricing. We will email you the moment ProspectIQ opens for access.'
            : `Founding spots are full, but you are on the waitlist. We will email you the moment access opens.${position ? ` You are number ${position} in line.` : ''}`}
        </p>
        <button
          onClick={reset}
          className="mt-6 bg-transparent border border-[#c49f8c]/40 text-[#c49f8c] px-5 py-2 rounded-full text-xs"
        >
          Reset
        </button>
      </div>
    )
  }

  return (
    <div className="rounded-2xl bg-[#171515] border border-[#c49f8c]/20 p-8 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.5)]">
      <div className="text-center mb-6">
        <p className="text-[11px] tracking-[0.3em] uppercase text-[#c49f8c] mb-3">
          Founding members
        </p>
        <h2 className="font-serif text-3xl leading-tight mb-2.5">
          First 100 get a <span className="italic text-[#c49f8c]">lifetime discount</span>
        </h2>
        <p className="text-[#fbf9f4]/70 leading-relaxed text-sm">
          Be one of the first 100 to join ProspectIQ and lock in founding member pricing.
          No card needed now. We will email you the moment access opens.
        </p>
        <div className="mt-4 inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-[#0a0a0a] border border-[#c49f8c]/20">
          <span
            className={`w-1.5 h-1.5 rounded-full bg-[#c49f8c] ${
              !isFull ? 'animate-pulse' : ''
            }`}
            style={isFull ? { background: '#a18d89' } : undefined}
          />
          <span className="text-xs text-[#fbf9f4]/85">
            {isFull
              ? 'Founding spots gone'
              : `${remaining} of ${FOUNDER_LIMIT} founding spots left`}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-3.5">
        <div>
          <label className="block text-[10px] tracking-[0.1em] uppercase text-[#fbf9f4]/60 mb-1.5">
            Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your full name"
            className="w-full px-3.5 py-2.5 text-sm rounded-lg bg-[#171515] border border-[#c49f8c]/20 text-[#fbf9f4] outline-none focus:border-[#c49f8c]/60"
          />
        </div>
        <div>
          <label className="block text-[10px] tracking-[0.1em] uppercase text-[#fbf9f4]/60 mb-1.5">
            Work email
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@firm.co.uk"
            className="w-full px-3.5 py-2.5 text-sm rounded-lg bg-[#171515] border border-[#c49f8c]/20 text-[#fbf9f4] outline-none focus:border-[#c49f8c]/60"
          />
        </div>
        <div>
          <label className="block text-[10px] tracking-[0.1em] uppercase text-[#fbf9f4]/60 mb-1.5">
            Your role
          </label>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="w-full px-3.5 py-2.5 text-sm rounded-lg bg-[#171515] border border-[#c49f8c]/20 text-[#fbf9f4] outline-none focus:border-[#c49f8c]/60 appearance-none"
          >
            <option value="">Select your role</option>
            <option value="wealth_manager_ifa">Wealth manager / IFA</option>
            <option value="financial_planner">Financial planner</option>
            <option value="mortgage_broker">Mortgage broker</option>
            <option value="other">Other</option>
          </select>
        </div>
        {role === 'other' && (
          <div>
            <label className="block text-[10px] tracking-[0.1em] uppercase text-[#fbf9f4]/60 mb-1.5">
              Tell us your role
            </label>
            <input
              type="text"
              value={roleOther}
              onChange={(e) => setRoleOther(e.target.value)}
              placeholder="e.g. Accountant"
              className="w-full px-3.5 py-2.5 text-sm rounded-lg bg-[#171515] border border-[#c49f8c]/20 text-[#fbf9f4] outline-none focus:border-[#c49f8c]/60"
            />
          </div>
        )}
        <label className="flex items-start gap-2.5 cursor-pointer pt-0.5">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            className="mt-0.5 accent-[#c49f8c]"
          />
          <span className="text-xs text-[#fbf9f4]/60 leading-relaxed">
            I am happy for ProspectIQ to email me about launch and product updates.
            We do not share your details. You can unsubscribe any time.
          </span>
        </label>
        {error && (
          <div className="text-xs text-[#e89c9c] bg-[#3a2020] border border-[#a04040]/40 rounded-lg px-3 py-2">
            {error}
          </div>
        )}
        <button
          onClick={handleSubmit}
          disabled={submitting}
          className={`w-full py-3.5 rounded-xl bg-[#c49f8c] text-[#0a0a0a] font-semibold text-xs border-none tracking-wide ${
            submitting ? 'opacity-60' : ''
          }`}
        >
          {submitting
            ? 'Joining...'
            : isFull
            ? 'Join the waitlist'
            : 'Claim my founding spot'}
        </button>
      </div>
    </div>
  )
}

/* ============================================================================
   Animation styles (injected via styled-jsx for piqFade keyframe)
   ============================================================================ */

// Note: piqFade and piq-spin animations are in globals.css. If not, use Tailwind animate-pulse / animate-spin.
