'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { PLANS, RECRUITMENT_PLAN, ADVISER_TYPES, PERMISSION_OPTIONS, PLAN_LIMITS } from '@/types'
import { recruitmentAccess } from '@/lib/recruitment/access-rules'

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

  // v76: Recruitment profile (account level)
  const [recFirmName, setRecFirmName] = useState('')
  const [recProposition, setRecProposition] = useState('')
  const [recRoles, setRecRoles] = useState('')
  const [recAdviserTypes, setRecAdviserTypes] = useState<string[]>([])
  const [recLocations, setRecLocations] = useState('')
  const [recMinYears, setRecMinYears] = useState('')
  const [recPermissions, setRecPermissions] = useState<string[]>([])
  const [recNotes, setRecNotes] = useState('')
  const [savingRecruitment, setSavingRecruitment] = useState(false)
  const [recruitmentCheckout, setRecruitmentCheckout] = useState<'monthly' | 'annual' | null>(null)

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
      const rp = data.recruitment_profile || {}
      setRecFirmName(rp.firm_name || '')
      setRecProposition(rp.proposition || '')
      setRecRoles(Array.isArray(rp.roles_needed) ? rp.roles_needed.join(', ') : '')
      setRecAdviserTypes(Array.isArray(rp.adviser_types) ? rp.adviser_types : [])
      setRecLocations(Array.isArray(rp.target_locations) ? rp.target_locations.join(', ') : '')
      setRecMinYears(typeof rp.min_years_approved === 'number' ? String(rp.min_years_approved) : '')
      setRecPermissions(Array.isArray(rp.permissions_required) ? rp.permissions_required : [])
      setRecNotes(rp.notes || '')
    }
    setLoading(false)
  }

  function toggleIn(list: string[], value: string, setter: (v: string[]) => void) {
    setter(list.includes(value) ? list.filter((x) => x !== value) : [...list, value])
  }

  async function handleSaveRecruitment(e: React.FormEvent) {
    e.preventDefault()
    setSavingRecruitment(true)
    const split = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean)
    const { error } = await supabase
      .from('profiles')
      .update({
        recruitment_profile: {
          firm_name: recFirmName.trim() || null,
          proposition: recProposition.trim() || null,
          roles_needed: split(recRoles),
          adviser_types: recAdviserTypes,
          target_locations: split(recLocations),
          min_years_approved: recMinYears.trim() ? Number(recMinYears) : null,
          permissions_required: recPermissions,
          notes: recNotes.trim() || null,
        },
        updated_at: new Date().toISOString(),
      })
      .eq('id', profile.id)
    if (error) toast.error('Failed to save recruitment profile')
    else toast.success('Recruitment profile saved')
    setSavingRecruitment(false)
  }

  async function handleRecruitmentCheckout(period: 'monthly' | 'annual') {
    setRecruitmentCheckout(period)
    try {
      const res = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier: 'recruitment', period }),
      })
      const data = await res.json()
      if (data.url) {
        window.location.href = data.url
        return
      }
      toast.error(data.error || 'Failed to start checkout')
    } catch {
      toast.error('Something went wrong')
    }
    setRecruitmentCheckout(null)
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
      {/* v76: Recruitment profile (account level) */}
      <div id="recruitment" className="bg-brand-charcoal-deep rounded-xl border border-brand-charcoal p-6 mb-8 scroll-mt-8">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-brand-cream font-display text-lg">Recruitment Profile</h2>
          <span className="text-[10px] px-2 py-0.5 rounded bg-purple-900/40 text-purple-300 uppercase tracking-wide font-bold">Recruitment</span>
        </div>
        <p className="text-brand-beige text-sm mb-5">
          Used when you hire advisers. Tells the AI what your firm offers and who you want, for scoring fit and writing outreach in your voice. Each recruitment campaign can override it.
        </p>
        <form onSubmit={handleSaveRecruitment} className="space-y-4">
          <div>
            <label className="block text-brand-cream text-sm font-medium mb-1.5">Hiring firm</label>
            <input type="text" value={recFirmName} onChange={(e) => setRecFirmName(e.target.value)} placeholder="e.g. Northgate Mortgages" className="w-full" />
          </div>
          <div>
            <label className="block text-brand-cream text-sm font-medium mb-1.5">What you offer advisers</label>
            <textarea value={recProposition} onChange={(e) => setRecProposition(e.target.value)} placeholder="e.g. Directly authorised, full admin and case management, lead flow from three estate agency partners, flexible working" className="w-full h-20 resize-none" />
            <p className="text-brand-beige text-xs mt-1">Only what you write here is used in outreach. Figures such as payout rates are only quoted if you include them.</p>
          </div>
          <div>
            <label className="block text-brand-cream text-sm font-medium mb-1.5">Roles needed <span className="text-brand-beige text-xs font-normal">(comma separated)</span></label>
            <input type="text" value={recRoles} onChange={(e) => setRecRoles(e.target.value)} placeholder="e.g. Mortgage adviser, Protection adviser" className="w-full" />
          </div>
          <div>
            <label className="block text-brand-cream text-sm font-medium mb-1.5">Adviser types</label>
            <div className="flex flex-wrap gap-2">
              {ADVISER_TYPES.map((t) => (
                <button key={t} type="button" onClick={() => toggleIn(recAdviserTypes, t, setRecAdviserTypes)} className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${recAdviserTypes.includes(t) ? 'border-brand-rose-gold text-brand-rose-gold bg-brand-rose-gold/10' : 'border-brand-charcoal text-brand-beige hover:border-brand-rose-gold'}`}>
                  {t}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-brand-cream text-sm font-medium mb-1.5">Target locations <span className="text-brand-beige text-xs font-normal">(comma separated)</span></label>
              <input type="text" value={recLocations} onChange={(e) => setRecLocations(e.target.value)} placeholder="e.g. Leeds, Sheffield, York" className="w-full" />
            </div>
            <div>
              <label className="block text-brand-cream text-sm font-medium mb-1.5">Minimum years approved</label>
              <input type="number" min={0} max={40} value={recMinYears} onChange={(e) => setRecMinYears(e.target.value)} placeholder="e.g. 2" className="w-full" />
            </div>
          </div>
          <div>
            <label className="block text-brand-cream text-sm font-medium mb-1.5">Permissions required</label>
            <div className="flex flex-wrap gap-2">
              {PERMISSION_OPTIONS.map((perm) => (
                <button key={perm} type="button" onClick={() => toggleIn(recPermissions, perm, setRecPermissions)} className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${recPermissions.includes(perm) ? 'border-brand-rose-gold text-brand-rose-gold bg-brand-rose-gold/10' : 'border-brand-charcoal text-brand-beige hover:border-brand-rose-gold'}`}>
                  {perm}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-brand-cream text-sm font-medium mb-1.5">Notes</label>
            <textarea value={recNotes} onChange={(e) => setRecNotes(e.target.value)} placeholder="Anything else the AI should know about your firm or the hire" className="w-full h-16 resize-none" />
          </div>
          <button type="submit" className="btn-primary text-sm" disabled={savingRecruitment}>
            {savingRecruitment ? 'Saving...' : 'Save Recruitment Profile'}
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
                  <span className="text-brand-beige text-sm font-body">/mo inc. VAT</span>
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

        {/* v76: Recruitment is a separate subscription */}
        {(() => {
          const rs = profile?.recruitment_status || 'inactive'
          const access = recruitmentAccess(profile)
          const isActive = access === 'ok'
          const periodEnd = profile?.recruitment_current_period_end
            ? new Date(profile.recruitment_current_period_end).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
            : null
          const statusLabel = isActive ? 'Active' : access === 'recruitment_expired' ? 'Beta ended' : rs === 'past_due' ? 'Payment failed' : rs === 'cancelled' ? 'Cancelled' : 'Not active'
          return (
            <div className={`mt-6 rounded-xl border p-5 ${isActive ? 'border-purple-700 bg-purple-950/10' : 'border-brand-charcoal'}`}>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-brand-cream font-display text-lg">{RECRUITMENT_PLAN.name}</h3>
                    <span className={`text-[10px] px-2 py-0.5 rounded uppercase tracking-wide font-bold ${isActive ? 'bg-purple-900/50 text-purple-300' : rs === 'past_due' ? 'bg-orange-900/40 text-orange-400' : 'bg-brand-charcoal text-brand-beige'}`}>
                      {statusLabel}
                    </span>
                  </div>
                  <p className="text-brand-cream text-2xl font-display mt-1">
                    &pound;{RECRUITMENT_PLAN.monthlyPrice}
                    <span className="text-brand-beige text-sm font-body">/mo inc. VAT</span>
                    <span className="text-brand-beige text-xs font-body ml-2">or &pound;{RECRUITMENT_PLAN.annualPrice.toLocaleString('en-GB')}/yr</span>
                  </p>
                  <p className="text-brand-beige text-xs mt-1">
                    For hiring advisers. Billed separately from the plans above.
                    {isActive && profile?.recruitment_period ? ` Billed ${profile.recruitment_period}.` : ''}
                    {isActive && periodEnd ? ` Current period ends ${periodEnd}.` : ''}
                  </p>
                  {isActive && (
                    <p className="text-brand-beige text-xs mt-1">
                      {profile?.recruitment_usage_reset_at && new Date(profile.recruitment_usage_reset_at).getTime() > Date.now() ? profile?.recruitment_advisers_used || 0 : 0} of {PLAN_LIMITS.recruitment.advisers_per_cycle} adviser researches used this cycle.
                    </p>
                  )}
                </div>
                {!isActive && (
                  <div className="flex flex-col gap-2 flex-shrink-0">
                    <button onClick={() => handleRecruitmentCheckout('monthly')} disabled={recruitmentCheckout !== null} className="btn-secondary text-xs whitespace-nowrap">
                      {recruitmentCheckout === 'monthly' ? 'Opening...' : 'Start monthly'}
                    </button>
                    <button onClick={() => handleRecruitmentCheckout('annual')} disabled={recruitmentCheckout !== null} className="btn-secondary text-xs whitespace-nowrap">
                      {recruitmentCheckout === 'annual' ? 'Opening...' : 'Start annual'}
                    </button>
                  </div>
                )}
              </div>
              <ul className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1.5">
                {RECRUITMENT_PLAN.features.map((f) => (
                  <li key={f} className="text-brand-beige text-xs flex items-start gap-2">
                    <span className="text-brand-rose-gold mt-0.5">&#10003;</span>
                    {f}
                  </li>
                ))}
              </ul>
            </div>
          )
        })()}
      </div>
    </div>
  )
}
