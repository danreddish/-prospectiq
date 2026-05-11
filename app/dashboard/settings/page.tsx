'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { PLANS } from '@/types'

export default function SettingsPage() {
  const [profile, setProfile] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [fullName, setFullName] = useState('')
  const [companyName, setCompanyName] = useState('')
  const [niche, setNiche] = useState('')
  const [senderName, setSenderName] = useState('')
  const [serviceWhat, setServiceWhat] = useState('')
  const [serviceWho, setServiceWho] = useState('')
  const [serviceOutcomes, setServiceOutcomes] = useState('')
  const [serviceThreshold, setServiceThreshold] = useState('')
  const [serviceGeo, setServiceGeo] = useState('')
  const [linkedinUrl, setLinkedinUrl] = useState('')
  const [aboutText, setAboutText] = useState('')
  const [importing, setImporting] = useState(false)
  const [importExpanded, setImportExpanded] = useState(false)

  const supabase = createClient()

  useEffect(() => {
    loadProfile()
  }, [])

  async function loadProfile() {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    const { data } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single()

    if (data) {
      setProfile(data)
      setFullName(data.full_name || '')
      setCompanyName(data.company_name || '')
      setNiche(data.niche || '')
      setSenderName(data.sender_name || '')
      const sp = data.service_profile || {}
      setServiceWhat(sp.what_you_do || '')
      setServiceWho(sp.who_you_help || '')
      setServiceOutcomes(sp.key_outcomes || '')
      setServiceThreshold(sp.minimum_threshold || '')
      setServiceGeo(sp.geographic_focus || '')
    }
    setLoading(false)
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)

    const { error } = await supabase
      .from('profiles')
      .update({
        full_name: fullName.trim() || null,
        company_name: companyName.trim() || null,
        niche: niche.trim() || null,
        sender_name: senderName.trim() || null,
        service_profile: {
          what_you_do: serviceWhat.trim() || null,
          who_you_help: serviceWho.trim() || null,
          key_outcomes: serviceOutcomes.trim() || null,
          minimum_threshold: serviceThreshold.trim() || null,
          geographic_focus: serviceGeo.trim() || null,
        },
        updated_at: new Date().toISOString(),
      })
      .eq('id', profile.id)

    if (error) {
      toast.error('Failed to save')
    } else {
      toast.success('Settings saved')
    }
    setSaving(false)
  }

  async function handleUpgrade(tier: string) {
    try {
      const res = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier, period: 'monthly' }),
      })
      const data = await res.json()
      if (data.url) {
        window.location.href = data.url
      } else {
        toast.error(data.error || 'Failed to start checkout')
      }
    } catch {
      toast.error('Something went wrong')
    }
  }

  async function handleLinkedInImport() {
    if (!linkedinUrl.trim() && !aboutText.trim()) {
      toast.error('Enter your LinkedIn URL or paste your About section')
      return
    }
    setImporting(true)
    try {
      const res = await fetch('/api/profile/import-linkedin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          linkedin_url: linkedinUrl.trim() || null,
          about_text: aboutText.trim() || null,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Import failed')
        setImporting(false)
        return
      }
      const sp = data.service_profile
      if (sp.what_you_do) setServiceWhat(sp.what_you_do)
      if (sp.who_you_help) setServiceWho(sp.who_you_help)
      if (sp.key_outcomes) setServiceOutcomes(sp.key_outcomes)
      if (sp.minimum_threshold) setServiceThreshold(sp.minimum_threshold)
      if (sp.geographic_focus) setServiceGeo(sp.geographic_focus)

      const source = data.apollo_found ? 'LinkedIn data' : 'your About section'
      toast.success(`Service profile generated from ${source}. Review and save below.`)
      setImportExpanded(false)
    } catch {
      toast.error('Something went wrong. Please try again.')
    }
    setImporting(false)
  }

  if (loading) {
    return <div className="text-brand-beige py-20 text-center">Loading settings...</div>
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-display text-brand-cream mb-2">Settings</h1>
      <p className="text-brand-beige text-sm mb-8">Manage your profile, niche, and billing.</p>

      {/* Profile settings */}
      <div className="bg-brand-charcoal-deep rounded-xl border border-brand-charcoal p-6 mb-8">
        <h2 className="text-brand-cream font-display text-lg mb-4">Profile</h2>
        <form onSubmit={handleSave} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-brand-cream text-sm font-medium mb-1.5">Full Name</label>
              <input
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="w-full"
              />
            </div>
            <div>
              <label className="block text-brand-cream text-sm font-medium mb-1.5">Company</label>
              <input
                type="text"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                className="w-full"
              />
            </div>
          </div>

          <div>
            <label className="block text-brand-cream text-sm font-medium mb-1.5">
              Default Niche
            </label>
            <input
              type="text"
              value={niche}
              onChange={(e) => setNiche(e.target.value)}
              placeholder="e.g. UK expat wealth management"
              className="w-full"
            />
            <p className="text-brand-beige text-xs mt-1">
              Used as the default for new campaigns. Tells the AI how to tailor research.
            </p>
          </div>

          <div>
            <label className="block text-brand-cream text-sm font-medium mb-1.5">
              Default Outreach Sender Name
            </label>
            <input
              type="text"
              value={senderName}
              onChange={(e) => setSenderName(e.target.value)}
              placeholder="The name that signs your outreach messages"
              className="w-full"
            />
          </div>

          <button type="submit" className="btn-primary text-sm" disabled={saving}>
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </form>
      </div>

      {/* Service Profile */}
      <div className="bg-brand-charcoal-deep rounded-xl border border-brand-charcoal p-6 mb-8">
        <h2 className="text-brand-cream font-display text-lg mb-2">Service Offering</h2>
        <p className="text-brand-beige text-sm mb-5">
          Tell ProspectIQ about your service. This helps the AI find better-matched prospects and write outreach that references your actual value proposition. These defaults apply to all new campaigns unless overridden.
        </p>

        {/* LinkedIn Import */}
        <div className="mb-6 rounded-lg border border-brand-rose-gold/30 bg-brand-rose-gold/5 p-4">
          <button
            type="button"
            onClick={() => setImportExpanded(!importExpanded)}
            className="flex items-center justify-between w-full text-left"
          >
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-8 h-8 rounded-full bg-brand-rose-gold/20">
                <svg className="w-4 h-4 text-brand-rose-gold" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                </svg>
              </div>
              <div>
                <span className="text-brand-cream text-sm font-semibold">Import from LinkedIn</span>
                <p className="text-brand-beige text-xs mt-0.5">Auto-fill your service profile from your LinkedIn data</p>
              </div>
            </div>
            <svg className={`w-5 h-5 text-brand-beige transition-transform ${importExpanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {importExpanded && (
            <div className="mt-4 space-y-3">
              <div>
                <label className="block text-brand-cream text-sm font-medium mb-1.5">LinkedIn profile URL</label>
                <input
                  type="text"
                  value={linkedinUrl}
                  onChange={(e) => setLinkedinUrl(e.target.value)}
                  placeholder="https://www.linkedin.com/in/your-profile"
                  className="w-full"
                />
                <p className="text-brand-beige text-xs mt-1">We look up your professional data to pre-fill the fields below.</p>
              </div>

              <div>
                <label className="block text-brand-cream text-sm font-medium mb-1.5">
                  LinkedIn About section <span className="text-brand-beige font-normal">(optional, improves accuracy)</span>
                </label>
                <textarea
                  value={aboutText}
                  onChange={(e) => setAboutText(e.target.value)}
                  placeholder="Go to your LinkedIn profile, click &quot;see more&quot; under your About section, copy the text, and paste it here."
                  className="w-full h-28 resize-none"
                />
                <p className="text-brand-beige text-xs mt-1">Your About section usually has the richest detail about what you do and who you help.</p>
              </div>

              <button
                type="button"
                onClick={handleLinkedInImport}
                disabled={importing || (!linkedinUrl.trim() && !aboutText.trim())}
                className="btn-primary text-sm flex items-center gap-2"
              >
                {importing ? (
                  <>
                    <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Analysing your profile...
                  </>
                ) : (
                  'Generate Service Profile'
                )}
              </button>
            </div>
          )}
        </div>

        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label className="block text-brand-cream text-sm font-medium mb-1.5">What you do</label>
            <input
              type="text"
              value={serviceWhat}
              onChange={(e) => setServiceWhat(e.target.value)}
              placeholder="e.g. Independent financial planning for business owners approaching exit"
              className="w-full"
            />
            <p className="text-brand-beige text-xs mt-1">Your core service in one sentence.</p>
          </div>

          <div>
            <label className="block text-brand-cream text-sm font-medium mb-1.5">Who you help</label>
            <textarea
              value={serviceWho}
              onChange={(e) => setServiceWho(e.target.value)}
              placeholder="e.g. Business owners aged 50-65 with £2M+ net worth planning succession or retirement. Also directors of property investment companies in the South East."
              className="w-full h-20 resize-none"
            />
            <p className="text-brand-beige text-xs mt-1">Describe your ideal client in detail. The more specific, the better the prospect matching.</p>
          </div>

          <div>
            <label className="block text-brand-cream text-sm font-medium mb-1.5">Key outcomes you deliver</label>
            <textarea
              value={serviceOutcomes}
              onChange={(e) => setServiceOutcomes(e.target.value)}
              placeholder="e.g. Tax-efficient exit strategy, retirement income plan, intergenerational wealth transfer, CGT mitigation on business sale"
              className="w-full h-20 resize-none"
            />
            <p className="text-brand-beige text-xs mt-1">What tangible results do your clients get? Used to make outreach specific and relevant.</p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-brand-cream text-sm font-medium mb-1.5">Minimum client threshold</label>
              <input
                type="text"
                value={serviceThreshold}
                onChange={(e) => setServiceThreshold(e.target.value)}
                placeholder="e.g. £500K investable assets"
                className="w-full"
              />
              <p className="text-brand-beige text-xs mt-1">Helps filter for prospects above your minimum.</p>
            </div>
            <div>
              <label className="block text-brand-cream text-sm font-medium mb-1.5">Geographic focus</label>
              <input
                type="text"
                value={serviceGeo}
                onChange={(e) => setServiceGeo(e.target.value)}
                placeholder="e.g. South East England, or Global"
                className="w-full"
              />
              <p className="text-brand-beige text-xs mt-1">Where your clients are based.</p>
            </div>
          </div>

          <button type="submit" className="btn-primary text-sm" disabled={saving}>
            {saving ? 'Saving...' : 'Save Service Profile'}
          </button>
        </form>
      </div>
      <div className="bg-brand-charcoal-deep rounded-xl border border-brand-charcoal p-6">
        <h2 className="text-brand-cream font-display text-lg mb-2">Billing</h2>
        <p className="text-brand-beige text-sm mb-6">
          Current plan: <strong className="text-brand-cream capitalize">{profile?.plan_tier || 'Free'}</strong>
          {profile?.plan_status === 'trialing' && (
            <span className="text-brand-rose-gold ml-2">(Trial)</span>
          )}
        </p>

        <div className="grid grid-cols-3 gap-4">
          {PLANS.map((plan) => {
            const isCurrent = profile?.plan_tier === plan.tier
            return (
              <div
                key={plan.tier}
                className={`rounded-xl border p-5 ${
                  isCurrent
                    ? 'border-brand-rose-gold bg-brand-rose-gold/5'
                    : 'border-brand-charcoal'
                }`}
              >
                <h3 className="text-brand-cream font-display text-lg">{plan.name}</h3>
                <p className="text-brand-cream text-2xl font-display mt-1">
                  &pound;{plan.monthlyPrice}
                  <span className="text-brand-beige text-sm font-body">/mo + VAT</span>
                </p>
                <ul className="mt-4 space-y-2">
                  {plan.features.map((f) => (
                    <li key={f} className="text-brand-beige text-xs flex items-start gap-2">
                      <span className="text-brand-rose-gold mt-0.5">&#10003;</span>
                      {f}
                    </li>
                  ))}
                </ul>
                {isCurrent ? (
                  <p className="mt-4 text-brand-rose-gold text-xs font-semibold text-center">
                    Current Plan
                  </p>
                ) : (
                  <button
                    onClick={() => handleUpgrade(plan.tier)}
                    className="btn-secondary w-full mt-4 text-xs"
                  >
                    Upgrade
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
