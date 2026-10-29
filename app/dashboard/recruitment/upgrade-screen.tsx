'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { RECRUITMENT_PLAN } from '@/types'

// Upgrade screen for users without an active Recruitment subscription.
// No self-serve trial in this version. Beta users are enabled from the admin panel.

export default function RecruitmentUpgrade({ status }: { status: string }) {
  const [loading, setLoading] = useState<'monthly' | 'annual' | null>(null)

  async function startCheckout(period: 'monthly' | 'annual') {
    setLoading(period)
    try {
      const res = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier: 'recruitment', period }),
      })
      const data = await res.json()
      if (data.url) {
        window.location.href = data.url
      } else {
        toast.error(data.error || 'Could not start checkout')
        setLoading(null)
      }
    } catch {
      toast.error('Something went wrong')
      setLoading(null)
    }
  }

  const statusNote = status === 'past_due'
    ? 'Your last Recruitment payment failed, so access is paused. Restart the plan below with a card that works. The failed subscription is cancelled for you, so you are never billed twice.'
    : status === 'cancelled'
    ? 'Your Recruitment subscription was cancelled. Restart it below to pick up where you left off.'
    : status === 'expired'
    ? 'Your Recruitment beta access has ended. Start a plan below to carry on.'
    : null

  return (
    <div className="max-w-3xl">
      <p className="text-brand-rose-gold text-[10px] font-bold tracking-[2px] uppercase mb-2">Recruitment</p>
      <h1 className="text-2xl font-display text-brand-cream mb-2">Hire advisers before they move</h1>
      <p className="text-brand-beige text-sm mb-8 max-w-2xl">
        Recruitment mode finds FCA approved advisers who look likely to move. It scores them on quality, move likelihood, accessibility and fit. It watches them and their firms for register changes. And it writes LINK Method outreach in your voice. By the time a network hears an adviser is unhappy, the adviser has usually gone. This is how you hear first.
      </p>

      {statusNote && (
        <div className="mb-6 rounded-lg border border-orange-700/40 bg-orange-950/20 p-4">
          <p className="text-orange-200 text-sm">{statusNote}</p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-5 gap-6">
        <div className="md:col-span-3 rounded-xl border border-brand-rose-gold bg-brand-rose-gold/5 p-6">
          <div className="flex items-baseline justify-between">
            <h2 className="text-brand-cream font-display text-xl">{RECRUITMENT_PLAN.name}</h2>
            <span className="text-[10px] px-2 py-0.5 rounded bg-purple-900/40 text-purple-300 uppercase tracking-wide font-bold">Separate plan</span>
          </div>
          <p className="text-brand-cream text-3xl font-display mt-2">
            &pound;{RECRUITMENT_PLAN.monthlyPrice}
            <span className="text-brand-beige text-sm font-body">/mo inc. VAT</span>
          </p>
          <p className="text-brand-beige text-xs mt-1">
            or &pound;{RECRUITMENT_PLAN.annualPrice.toLocaleString('en-GB')} a year inc. VAT (two months free)
          </p>
          <ul className="mt-5 space-y-2">
            {RECRUITMENT_PLAN.features.map((f) => (
              <li key={f} className="text-brand-beige text-sm flex items-start gap-2">
                <span className="text-brand-rose-gold mt-0.5">&#10003;</span>
                {f}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-3 mt-6">
            <button
              onClick={() => startCheckout('monthly')}
              disabled={loading !== null}
              className="btn-primary text-sm"
            >
              {loading === 'monthly' ? 'Opening checkout...' : `Start monthly, £${RECRUITMENT_PLAN.monthlyPrice}/mo`}
            </button>
            <button
              onClick={() => startCheckout('annual')}
              disabled={loading !== null}
              className="btn-secondary text-sm"
            >
              {loading === 'annual' ? 'Opening checkout...' : `Start annual, £${RECRUITMENT_PLAN.annualPrice.toLocaleString('en-GB')}/yr`}
            </button>
          </div>
          <p className="text-brand-charcoal text-[10px] mt-3">
            Billed separately from your client prospecting plan. You can hold both.
          </p>
        </div>

        <div className="md:col-span-2 space-y-4">
          {[
            { title: 'Find', body: 'Describe who you want to hire. Firm-led briefs search the FCA Register by network, principal or appointed representative. Role-led briefs search a global database of professionals.' },
            { title: 'Score', body: 'Each adviser is scored on adviser quality, move likelihood, accessibility and fit against your hiring profile, with talking points and risk flags.' },
            { title: 'Watch', body: 'Add advisers and firms to a watchlist. Register changes such as a move, a status change or a firm losing advisers raise an alert.' },
            { title: 'Reach out', body: 'Three step LINK Method outreach written peer to peer in the voice of the hiring principal. Nothing in it reads as surveillance.' },
          ].map((item) => (
            <div key={item.title} className="rounded-xl border border-brand-charcoal bg-brand-charcoal-deep p-4">
              <p className="text-brand-rose-gold text-[10px] uppercase tracking-wider font-bold mb-1">{item.title}</p>
              <p className="text-brand-beige text-xs leading-relaxed">{item.body}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
