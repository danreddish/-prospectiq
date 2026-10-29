'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { useRouter, useSearchParams } from 'next/navigation'
import { ADVISER_TYPES, PERMISSION_OPTIONS, PLAN_LIMITS } from '@/types'
import { researchAdvisersSequentially } from '@/lib/recruitment/research-client'
import { linkedInSearchUrl } from '@/lib/recruitment/links'

// Recruitment campaign wizard: create, find, review, research.
// Mirrors /dashboard/campaigns/new for the client flow.

interface Candidate {
  key: string
  name: string
  firm: string
  role: string
  location: string
  linkedin_url: string
  email: string | null
  phone: string | null
  headline: string | null
  irn: string | null
  frn: string | null
  principal_frn: string | null
  principal_name: string | null
  fca_status: string | null
  function: string | null
  function_from: string | null
  source: 'fca_register' | 'apollo'
  confidence: number
  selected: boolean
}

interface ResolvedFirm {
  query: string
  frn: string | null
  name: string | null
  status: string | null
  alternatives: { frn: string; name: string; status: string }[]
}

interface Intent {
  path: 'firm_led' | 'role_led'
  firms: string[]
  include_ars: boolean
  roles: string[]
  role_families: string[]
  locations: string[]
  adviser_types: string[]
  keywords: string | null
  summary: string
}

type Cursor = { page: number; offset: number } | null
type Step = 'create' | 'find' | 'review' | 'researching'

export default function RecruitmentCampaignsPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const supabase = createClient()

  const [step, setStep] = useState<Step>('create')
  const [campaignId, setCampaignId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // Campaign form
  const [campaignName, setCampaignName] = useState('')
  const [principalName, setPrincipalName] = useState('')
  const [customInstructions, setCustomInstructions] = useState('')

  // Recruitment profile (campaign-level override of account defaults)
  const [firmName, setFirmName] = useState('')
  const [proposition, setProposition] = useState('')
  const [rolesNeeded, setRolesNeeded] = useState('')
  const [adviserTypes, setAdviserTypes] = useState<string[]>([])
  const [targetLocations, setTargetLocations] = useState('')
  const [minYears, setMinYears] = useState('')
  const [permissions, setPermissions] = useState<string[]>([])
  const [notes, setNotes] = useState('')
  const [showProfile, setShowProfile] = useState(false)

  // Find
  const [description, setDescription] = useState('')
  const [finding, setFinding] = useState(false)
  const [findingStatus, setFindingStatus] = useState('')
  const [intent, setIntent] = useState<Intent | null>(null)
  const [resolvedFirms, setResolvedFirms] = useState<ResolvedFirm[]>([])
  const [includeArs, setIncludeArs] = useState(false)
  const [apolloParams, setApolloParams] = useState<Record<string, unknown> | null>(null)
  const [cursors, setCursors] = useState<Record<string, Cursor>>({})
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [loadingMore, setLoadingMore] = useState(false)

  // Research
  const [researchProgress, setResearchProgress] = useState({ completed: 0, total: 0 })

  // "Find more" from a campaign dashboard
  useEffect(() => {
    const existing = searchParams.get('campaign')
    if (existing) {
      setCampaignId(existing)
      setStep('find')
    }
  }, [searchParams])

  // Load account defaults
  useEffect(() => {
    async function loadDefaults() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      const { data } = await supabase.from('profiles').select('sender_name, full_name, company_name, recruitment_profile').eq('id', user.id).single()
      if (!data) return
      if (!principalName) setPrincipalName(data.sender_name || data.full_name || '')
      const rp = (data.recruitment_profile || {}) as Record<string, unknown>
      if (typeof rp.firm_name === 'string') setFirmName(rp.firm_name)
      else if (data.company_name) setFirmName(data.company_name)
      if (typeof rp.proposition === 'string') setProposition(rp.proposition)
      if (Array.isArray(rp.roles_needed)) setRolesNeeded(rp.roles_needed.join(', '))
      if (Array.isArray(rp.adviser_types)) setAdviserTypes(rp.adviser_types as string[])
      if (Array.isArray(rp.target_locations)) setTargetLocations(rp.target_locations.join(', '))
      if (typeof rp.min_years_approved === 'number') setMinYears(String(rp.min_years_approved))
      if (Array.isArray(rp.permissions_required)) setPermissions(rp.permissions_required as string[])
      if (typeof rp.notes === 'string') setNotes(rp.notes)
      if (rp.firm_name || rp.proposition) setShowProfile(true)
    }
    loadDefaults()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function toggleInList(list: string[], value: string, setter: (v: string[]) => void) {
    setter(list.includes(value) ? list.filter((x) => x !== value) : [...list, value])
  }

  const splitList = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean)

  // ── Step 1: Create campaign ────────────────

  async function handleCreateCampaign(e: React.FormEvent) {
    e.preventDefault()
    if (!campaignName.trim()) return toast.error('Campaign name is required')
    if (!principalName.trim()) return toast.error('Add the name of the hiring principal who signs the outreach')

    setLoading(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error('Not authenticated')

      const { count } = await supabase
        .from('campaigns')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .eq('purpose', 'advisers')
      if ((count || 0) >= PLAN_LIMITS.recruitment.campaigns) {
        throw new Error(`Recruitment campaign limit reached (${PLAN_LIMITS.recruitment.campaigns}). Delete or reuse an existing campaign.`)
      }

      const { data, error } = await supabase
        .from('campaigns')
        .insert({
          user_id: user.id,
          name: campaignName.trim(),
          sender_name: principalName.trim(),
          purpose: 'advisers',
          niche: 'Adviser recruitment',
          custom_instructions: customInstructions.trim() || null,
          recruitment_profile: {
            firm_name: firmName.trim() || null,
            proposition: proposition.trim() || null,
            roles_needed: splitList(rolesNeeded),
            adviser_types: adviserTypes,
            target_locations: splitList(targetLocations),
            min_years_approved: minYears.trim() ? Number(minYears) : null,
            permissions_required: permissions,
            notes: notes.trim() || null,
          },
        })
        .select()
        .single()

      if (error) throw error
      setCampaignId(data.id)
      setStep('find')
      toast.success('Recruitment campaign created')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to create campaign'
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }

  // ── Step 2: Find advisers ──────────────────

  async function handleFind() {
    if (!campaignId) return
    if (description.trim().length < 8) return toast.error('Describe who you want to hire in a sentence or two')

    setFinding(true)
    setCandidates([])
    setCursors({})
    setIntent(null)
    setResolvedFirms([])
    setApolloParams(null)
    setFindingStatus('Reading your brief...')

    try {
      const res = await fetch('/api/recruitment/find', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaign_id: campaignId, description: description.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Search failed')

      const parsedIntent = data.intent as Intent
      const firms = (data.resolved_firms || []) as ResolvedFirm[]
      setIntent(parsedIntent)
      setResolvedFirms(firms)
      setIncludeArs(!!parsedIntent.include_ars)
      setApolloParams(data.apollo_params || null)

      // Locations in the brief feed fit scoring. Save them to the campaign
      // when it has no target locations of its own.
      if (parsedIntent.locations.length > 0) {
        const { data: row } = await supabase.from('campaigns').select('recruitment_profile').eq('id', campaignId).single()
        const rp = (row?.recruitment_profile || {}) as Record<string, unknown>
        if (!Array.isArray(rp.target_locations) || rp.target_locations.length === 0) {
          await supabase.from('campaigns').update({ recruitment_profile: { ...rp, target_locations: parsedIntent.locations } }).eq('id', campaignId)
        }
      }

      if (parsedIntent.path === 'firm_led') {
        const usable = firms.filter((f) => f.frn)
        if (usable.length === 0) throw new Error('None of the firms named could be found on the register. Try the firm\'s registered legal name or its FRN.')
        await fetchFirmCandidates(usable, !!parsedIntent.include_ars, {}, [])
      } else {
        await fetchApolloCandidates(data.apollo_params || {})
      }
      setStep('review')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Finding failed'
      toast.error(message)
    } finally {
      setFinding(false)
      setFindingStatus('')
    }
  }

  async function fetchFirmCandidates(
    firms: ResolvedFirm[],
    withArs: boolean,
    startCursors: Record<string, Cursor>,
    existing: Candidate[]
  ) {
    const all = [...existing]
    const seen = new Set(all.map((c) => c.key))
    const nextCursors: Record<string, Cursor> = { ...startCursors }

    for (const firm of firms) {
      if (!firm.frn || !firm.name) continue
      if (firm.frn in nextCursors && nextCursors[firm.frn] === null) continue
      // Up to 25 new candidates per firm per click. The first register pages
      // are often senior managers, so keep reading (max 4 requests).
      const target = all.length + 25
      for (let attempt = 0; attempt < 4 && all.length < target; attempt++) {
      if (firm.frn in nextCursors && nextCursors[firm.frn] === null) break
      setFindingStatus(`Reading the register for ${firm.name}${withArs ? ' and its appointed representatives' : ''} (${all.length - existing.length} found)...`)
      const res = await fetch('/api/recruitment/find-advisers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          frn: firm.frn,
          firm_name: firm.name,
          include_ars: withArs,
          cursor: nextCursors[firm.frn] || undefined,
        }),
      })
      const data = await res.json()
      if (data.error) {
        toast.error(`${firm.name}: ${typeof data.error === 'string' ? data.error : 'Search failed'}`)
        nextCursors[firm.frn] = null
        break
      }
      for (const c of data.candidates || []) {
        const key = `irn:${c.irn}`
        if (seen.has(key)) continue
        seen.add(key)
        all.push({
          key,
          name: c.name,
          firm: c.firm,
          role: /mortgage/i.test(c.function || '') ? 'Mortgage adviser' : 'Adviser',
          location: '',
          linkedin_url: linkedInSearchUrl(c.name, c.firm),
          email: null,
          phone: null,
          headline: null,
          irn: c.irn,
          frn: c.frn,
          principal_frn: c.principal_frn,
          principal_name: c.principal_name,
          fca_status: c.status,
          function: c.function,
          function_from: c.function_from,
          source: 'fca_register',
          confidence: c.confidence || 8,
          selected: true,
        })
      }
      nextCursors[firm.frn] = data.done ? null : (data.next_cursor || null)
      }
    }

    setCandidates(all)
    setCursors(nextCursors)
    if (all.length === existing.length) {
      toast.success('No more customer-facing advisers found for this brief.')
    }
  }

  async function fetchApolloCandidates(params: Record<string, unknown>) {
    const all: Candidate[] = []
    const seen = new Set<string>()
    const maxPages = 6 // 6 pages x 5 = 30 max, the same as the client flow
    for (let page = 1; page <= maxPages; page++) {
      setFindingStatus(`Searching the global database (page ${page})...`)
      const res = await fetch('/api/recruitment/find-apollo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          campaign_id: campaignId,
          search_term: description.trim(),
          apollo_params: { ...params, page },
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        // Out of searches or plan problem: keep what was found so far.
        if (all.length > 0 && (res.status === 402 || res.status === 403)) {
          toast.error(data.error || 'Search stopped')
          break
        }
        throw new Error(data.error || 'Search failed')
      }
      const people = data.individuals || []
      if (people.length === 0) break
      for (const p of people) {
        const key = `apollo:${(p.name + '|' + p.company).toLowerCase()}`
        if (seen.has(key)) continue
        seen.add(key)
        all.push({
          key,
          name: p.name,
          firm: p.company || '',
          role: p.role || 'Adviser',
          location: p.location || '',
          linkedin_url: p.linkedin_url || '',
          email: p.email || null,
          phone: p.phone || null,
          headline: p.headline || null,
          irn: null,
          frn: null,
          principal_frn: null,
          principal_name: null,
          fca_status: null,
          function: null,
          function_from: null,
          source: 'apollo',
          confidence: p.confidence || 6,
          selected: true,
        })
      }
      if (all.length >= 30) break
    }
    setCandidates(all)
    if (all.length === 0) toast.success('No matches found. Try naming a firm or network, or a broader role.')
  }

  async function handleLoadMore() {
    const usable = resolvedFirms.filter((f) => f.frn)
    setLoadingMore(true)
    try {
      await fetchFirmCandidates(usable, includeArs, cursors, candidates)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Could not load more')
    } finally {
      setLoadingMore(false)
      setFindingStatus('')
    }
  }

  async function handleResearchWithIntent() {
    // Re-run the firm search with the current firm choices and AR toggle
    const usable = resolvedFirms.filter((f) => f.frn)
    if (usable.length === 0) return toast.error('Choose at least one firm')
    setLoadingMore(true)
    try {
      setCandidates([])
      await fetchFirmCandidates(usable, includeArs, {}, [])
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Search failed')
    } finally {
      setLoadingMore(false)
      setFindingStatus('')
    }
  }

  function chooseAlternative(index: number, frn: string) {
    setResolvedFirms((prev) => prev.map((f, i) => {
      if (i !== index) return f
      const alt = f.alternatives.find((a) => a.frn === frn)
      if (!alt) return f
      const others = f.alternatives.filter((a) => a.frn !== frn)
      const current = f.frn && f.name && f.status ? [{ frn: f.frn, name: f.name, status: f.status }] : []
      return { ...f, frn: alt.frn, name: alt.name, status: alt.status, alternatives: [...current, ...others] }
    }))
  }

  const hasMore = Object.values(cursors).some((c) => c !== null)

  // ── Step 3: Research selected ──────────────

  async function handleResearch() {
    const selected = candidates.filter((c) => c.selected)
    if (selected.length === 0) return toast.error('Select at least one adviser')
    if (!campaignId) return

    setStep('researching')
    setResearchProgress({ completed: 0, total: selected.length })

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    // Save as pending adviser prospects, skipping any already in the campaign
    const { data: existing } = await supabase
      .from('prospects')
      .select('id, name, company, fca_irn, status')
      .eq('campaign_id', campaignId)
    const byIrn = new Map((existing || []).filter((e) => e.fca_irn).map((e) => [e.fca_irn as string, e]))
    const byKey = new Map((existing || []).map((e) => [`${e.name}|${e.company}`.toLowerCase(), e]))

    const toInsert = []
    const ids: { id: string; frn: string | null }[] = []
    for (const c of selected) {
      const match = (c.irn && byIrn.get(c.irn)) || byKey.get(`${c.name}|${c.firm}`.toLowerCase())
      if (match) {
        ids.push({ id: match.id, frn: c.principal_frn || c.frn })
        continue
      }
      toInsert.push({
        campaign_id: campaignId,
        user_id: user.id,
        name: c.name,
        role: c.role || null,
        company: c.firm || null,
        location: c.location || null,
        linkedin_url: c.linkedin_url || null,
        email: c.email,
        phone: c.phone,
        headline: c.headline,
        prospect_type: 'adviser' as const,
        fca_irn: c.irn,
        fca_frn: c.principal_frn || c.frn,
        fca_firm_name: c.principal_name || c.firm || null,
        fca_status: c.fca_status,
        fca_data: c.function
          ? { candidate_source: c.source, candidate_function: c.function, candidate_function_from: c.function_from, workplace_frn: c.frn }
          : { candidate_source: c.source },
        status: 'pending' as const,
      })
    }
    if (toInsert.length > 0) {
      const { data: inserted, error } = await supabase.from('prospects').insert(toInsert).select('id, fca_frn')
      if (error) {
        toast.error(`Could not save advisers: ${error.message}`)
        setStep('review')
        return
      }
      for (const row of inserted || []) ids.push({ id: row.id, frn: row.fca_frn })
    }

    const { completed, failed, limitHit, lastError } = await researchAdvisersSequentially(
      campaignId,
      ids,
      (done, total) => setResearchProgress({ completed: done, total })
    )

    if (limitHit) {
      toast.error(completed > 0 ? `${lastError} ${completed} researched before that.` : lastError, { duration: 10000 })
    } else if (completed > 0) {
      toast.success(`Researched ${completed} adviser${completed === 1 ? '' : 's'}${failed > 0 ? ` (${failed} failed)` : ''}`)
    }
    if (completed > 0 || limitHit) {
      router.push(`/dashboard/recruitment/campaigns/${campaignId}`)
    } else {
      toast.error(`All research requests failed: ${lastError || 'Unknown error'}`)
      setStep('review')
    }
  }

  // ── Toggle helpers ─────────────────────────

  function toggleCandidate(i: number) {
    setCandidates((prev) => prev.map((c, idx) => (idx === i ? { ...c, selected: !c.selected } : c)))
  }
  const selectedCount = candidates.filter((c) => c.selected).length

  function getStepClickHandler(targetKey: string): (() => void) | undefined {
    if (step === 'researching') return undefined
    const order: Step[] = ['create', 'find', 'review', 'researching']
    const currentIdx = order.indexOf(step)
    const targetIdx = order.indexOf(targetKey as Step)
    if (targetIdx >= currentIdx) return undefined
    if (targetKey === 'create' && campaignId) return undefined
    return () => setStep(targetKey as Step)
  }

  // ── Render ─────────────────────────────────

  return (
    <div>
      <p className="text-brand-rose-gold text-[10px] font-bold tracking-[2px] uppercase mb-4">Recruitment</p>

      {/* Step indicator */}
      <div className="flex items-center gap-3 mb-8">
        {[
          { key: 'create', label: '1. Campaign' },
          { key: 'find', label: '2. Find' },
          { key: 'review', label: '3. Review' },
          { key: 'researching', label: '4. Research' },
        ].map((s, i) => {
          const steps: Step[] = ['create', 'find', 'review', 'researching']
          const currentIdx = steps.indexOf(step)
          const isActive = i <= currentIdx
          const clickHandler = getStepClickHandler(s.key)
          return (
            <div key={s.key} className="flex items-center gap-3">
              <div
                className={`flex items-center gap-2 ${isActive ? 'text-brand-cream' : 'text-brand-charcoal'} ${clickHandler ? 'cursor-pointer hover:opacity-75 transition-opacity' : ''}`}
                onClick={clickHandler}
              >
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${isActive ? 'bg-brand-rose-gold text-brand-dark' : 'bg-brand-charcoal-deep text-brand-charcoal'}`}>
                  {i + 1}
                </div>
                <span className="text-sm font-medium">{s.label}</span>
              </div>
              {i < 3 && <div className={`w-8 h-px ${isActive ? 'bg-brand-rose-gold' : 'bg-brand-charcoal-deep'}`} />}
            </div>
          )
        })}
      </div>

      {/* STEP 1: CREATE */}
      {step === 'create' && (
        <div>
          <h1 className="text-2xl font-display text-brand-cream mb-2">New Recruitment Campaign</h1>
          <p className="text-brand-beige text-sm mb-8">
            Set up the campaign, then describe who you want to hire and we will find them on the FCA Register.
          </p>

          <form onSubmit={handleCreateCampaign} className="max-w-lg space-y-5">
            <div>
              <label className="block text-brand-cream text-sm font-medium mb-1.5">Campaign Name *</label>
              <input type="text" value={campaignName} onChange={(e) => setCampaignName(e.target.value)} placeholder="e.g. Yorkshire mortgage advisers, Q4 2026" className="w-full" required />
            </div>
            <div>
              <label className="block text-brand-cream text-sm font-medium mb-1.5">Hiring principal *</label>
              <input type="text" value={principalName} onChange={(e) => setPrincipalName(e.target.value)} placeholder="The principal or BDM who signs the outreach" className="w-full" />
              <p className="text-brand-beige text-xs mt-1">Outreach is written peer to peer in this person&apos;s voice.</p>
            </div>
            <div>
              <label className="block text-brand-cream text-sm font-medium mb-1.5">
                Anything specific about this hire? <span className="text-brand-beige text-xs font-normal">(optional)</span>
              </label>
              <textarea
                value={customInstructions}
                onChange={(e) => setCustomInstructions(e.target.value)}
                placeholder="e.g. prefer advisers with their own client bank, avoid anyone under two years approved, we are opening a Leeds office in January..."
                className="w-full h-20 resize-none text-sm"
              />
            </div>

            {/* Recruitment profile (collapsible) */}
            <div className="border border-brand-charcoal rounded-lg overflow-hidden">
              <button
                type="button"
                onClick={() => setShowProfile(!showProfile)}
                className="w-full flex items-center justify-between p-3 text-left hover:bg-brand-charcoal-deep/30 transition-colors"
              >
                <div>
                  <p className="text-brand-cream text-sm font-semibold">Your Recruitment Profile</p>
                  <p className="text-brand-beige text-xs mt-0.5">
                    {firmName || proposition ? 'Configured' : 'Your firm, what you offer advisers, and who you want'}
                  </p>
                </div>
                <span className="text-brand-beige text-xs">{showProfile ? '▲ Hide' : '▼ Show'}</span>
              </button>

              {showProfile && (
                <div className="p-3 pt-0 space-y-3 border-t border-brand-charcoal">
                  <div className="mt-3">
                    <label className="block text-brand-cream text-xs font-medium mb-1">Hiring firm</label>
                    <input type="text" value={firmName} onChange={(e) => setFirmName(e.target.value)} placeholder="e.g. Northgate Mortgages" className="w-full text-sm" />
                  </div>
                  <div>
                    <label className="block text-brand-cream text-xs font-medium mb-1">What you offer advisers</label>
                    <textarea value={proposition} onChange={(e) => setProposition(e.target.value)} placeholder="e.g. Directly authorised, full admin and case management, lead flow from three estate agency partners, flexible working" className="w-full h-16 resize-none text-sm" />
                  </div>
                  <div>
                    <label className="block text-brand-cream text-xs font-medium mb-1">Roles needed <span className="text-brand-beige font-normal">(comma separated)</span></label>
                    <input type="text" value={rolesNeeded} onChange={(e) => setRolesNeeded(e.target.value)} placeholder="e.g. Mortgage adviser, Protection adviser" className="w-full text-sm" />
                  </div>
                  <div>
                    <label className="block text-brand-cream text-xs font-medium mb-1.5">Adviser types</label>
                    <div className="flex flex-wrap gap-2">
                      {ADVISER_TYPES.map((t) => (
                        <button key={t} type="button" onClick={() => toggleInList(adviserTypes, t, setAdviserTypes)} className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${adviserTypes.includes(t) ? 'border-brand-rose-gold text-brand-rose-gold bg-brand-rose-gold/10' : 'border-brand-charcoal text-brand-beige hover:border-brand-rose-gold'}`}>
                          {t}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-brand-cream text-xs font-medium mb-1">Target locations <span className="text-brand-beige font-normal">(comma separated)</span></label>
                      <input type="text" value={targetLocations} onChange={(e) => setTargetLocations(e.target.value)} placeholder="e.g. Leeds, Sheffield, York" className="w-full text-sm" />
                    </div>
                    <div>
                      <label className="block text-brand-cream text-xs font-medium mb-1">Minimum years approved</label>
                      <input type="number" min={0} max={40} value={minYears} onChange={(e) => setMinYears(e.target.value)} placeholder="e.g. 2" className="w-full text-sm" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-brand-cream text-xs font-medium mb-1.5">Permissions required</label>
                    <div className="flex flex-wrap gap-2">
                      {PERMISSION_OPTIONS.map((p) => (
                        <button key={p} type="button" onClick={() => toggleInList(permissions, p, setPermissions)} className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${permissions.includes(p) ? 'border-brand-rose-gold text-brand-rose-gold bg-brand-rose-gold/10' : 'border-brand-charcoal text-brand-beige hover:border-brand-rose-gold'}`}>
                          {p}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="block text-brand-cream text-xs font-medium mb-1">Notes</label>
                    <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything else the AI should know about the firm or the hire" className="w-full h-14 resize-none text-sm" />
                  </div>
                  <p className="text-brand-charcoal text-[10px]">Defaults loaded from Settings. Changes here only apply to this campaign.</p>
                </div>
              )}
            </div>

            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? 'Creating...' : 'Create Campaign'}
            </button>
          </form>
        </div>
      )}

      {/* STEP 2: FIND */}
      {step === 'find' && (
        <div>
          <h1 className="text-2xl font-display text-brand-cream mb-2">Find Advisers</h1>
          <p className="text-brand-beige text-sm mb-6 max-w-2xl">
            Describe who you want to hire in plain English. Name a network, principal or firm and we search the FCA Register for its customer-facing advisers. Describe a role and a place with no firm and we search a global database of professionals instead.
          </p>

          <div className="max-w-2xl">
            <div className="bg-brand-charcoal-deep rounded-xl border border-brand-charcoal p-6 mb-6">
              <label className="block text-brand-cream text-sm font-medium mb-3">Who do you want to hire?</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={"e.g. Mortgage advisers at PRIMIS appointed representatives in Yorkshire\n\nOr: Advisers at The Right Mortgage with two or more years approved\n\nOr: Self-employed mortgage and protection advisers in Leeds"}
                className="w-full h-32 resize-none"
                disabled={finding}
              />
              <p className="text-brand-beige text-xs mt-2">
                Firm names work best as the registered legal name or the FRN. Networks are recognised by trading name.
              </p>
              <div className="flex items-center gap-4 mt-4">
                <button onClick={handleFind} className="btn-primary" disabled={finding || description.trim().length < 8}>
                  {finding ? (
                    <span className="flex items-center gap-2">
                      <span className="w-4 h-4 border-2 border-brand-dark border-t-transparent rounded-full animate-spin" />
                      Finding advisers...
                    </span>
                  ) : 'Find Advisers'}
                </button>
                {finding && findingStatus && <p className="text-brand-beige text-sm">{findingStatus}</p>}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* STEP 3: REVIEW */}
      {step === 'review' && (
        <div>
          <h1 className="text-2xl font-display text-brand-cream mb-2">Review Advisers</h1>
          <p className="text-brand-beige text-sm mb-4">
            {candidates.length} candidate{candidates.length === 1 ? '' : 's'} found. Tick the ones to research and score.
          </p>

          {/* Parsed intent */}
          {intent && (
            <div className="mb-6 rounded-xl border border-brand-charcoal bg-brand-charcoal-deep p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-brand-rose-gold text-[10px] uppercase tracking-wider font-bold mb-1">
                    {intent.path === 'firm_led' ? 'Firm-led search, FCA Register' : 'Role-led search, global database'}
                  </p>
                  <p className="text-brand-cream text-sm">{intent.summary}</p>
                  <p className="text-brand-beige text-xs mt-1">
                    {intent.roles.length > 0 && <span>Roles: {intent.roles.join(', ')}. </span>}
                    {intent.locations.length > 0 && <span>Locations: {intent.locations.join(', ')}. </span>}
                    {intent.adviser_types.length > 0 && <span>Types: {intent.adviser_types.join(', ')}. </span>}
                    {intent.path === 'role_led' && apolloParams && <span>Titles: {((apolloParams.person_titles as string[]) || []).slice(0, 4).join(', ')}.</span>}
                  </p>
                </div>
                <button onClick={() => setStep('find')} className="text-brand-rose-gold text-sm hover:underline whitespace-nowrap">
                  &larr; Change brief
                </button>
              </div>

              {intent.path === 'firm_led' && (
                <div className="mt-3 pt-3 border-t border-brand-charcoal space-y-2">
                  {resolvedFirms.map((f, i) => (
                    <div key={f.query} className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="text-brand-beige">&ldquo;{f.query}&rdquo; matched:</span>
                      {f.frn ? (
                        <select
                          value={f.frn}
                          onChange={(e) => chooseAlternative(i, e.target.value)}
                          className="text-xs py-1 px-2"
                          disabled={loadingMore}
                        >
                          <option value={f.frn}>{f.name} ({f.frn}, {f.status})</option>
                          {f.alternatives.map((a) => (
                            <option key={a.frn} value={a.frn}>{a.name} ({a.frn}, {a.status})</option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-red-400">not found on the register</span>
                      )}
                    </div>
                  ))}
                  {intent.locations.length > 0 && (
                    <p className="text-brand-beige text-[11px]">
                      The register lists advisers by firm, not by town, so {intent.locations.join(', ')} is used to score fit rather than to filter this list. Deselect anyone clearly out of area before researching.
                    </p>
                  )}
                  <div className="flex items-center gap-4 pt-1">
                    <label className="flex items-center gap-2 text-xs text-brand-cream cursor-pointer">
                      <input type="checkbox" checked={includeArs} onChange={(e) => setIncludeArs(e.target.checked)} className="w-auto" disabled={loadingMore} />
                      Search the firm&apos;s appointed representatives (shows the AR as the adviser&apos;s firm)
                    </label>
                    <button onClick={handleResearchWithIntent} disabled={loadingMore} className="text-brand-rose-gold text-xs hover:underline">
                      {loadingMore ? 'Searching...' : 'Search again with these settings'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Select controls */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <button onClick={() => setCandidates((p) => p.map((c) => ({ ...c, selected: true })))} className="text-brand-rose-gold text-sm hover:underline">Select all</button>
              <span className="text-brand-charcoal">|</span>
              <button onClick={() => setCandidates((p) => p.map((c) => ({ ...c, selected: false })))} className="text-brand-beige text-sm hover:underline">Deselect all</button>
              <span className="text-brand-beige text-sm ml-2">{selectedCount} of {candidates.length} selected</span>
            </div>
            {loadingMore && findingStatus && <p className="text-brand-beige text-xs">{findingStatus}</p>}
          </div>

          {/* Candidate list */}
          <div className="bg-brand-charcoal-deep rounded-xl border border-brand-charcoal overflow-hidden mb-4">
            <div className="divide-y divide-brand-charcoal">
              {candidates.map((c, i) => (
                <button
                  key={c.key}
                  onClick={() => toggleCandidate(i)}
                  className={`w-full text-left p-4 flex items-center gap-4 transition-colors ${c.selected ? 'bg-brand-rose-gold/5' : 'hover:bg-brand-charcoal-deeper/30'}`}
                >
                  <div className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors ${c.selected ? 'bg-brand-rose-gold border-brand-rose-gold' : 'border-brand-charcoal'}`}>
                    {c.selected && <span className="text-brand-dark text-xs font-bold">&#10003;</span>}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-brand-cream text-sm font-semibold truncate">{c.name}</p>
                      {c.source === 'fca_register' ? (
                        <span className="text-[10px] bg-green-900/40 text-green-400 px-1.5 py-0.5 rounded font-medium flex-shrink-0">FCA Approved</span>
                      ) : (
                        <span className="text-[10px] bg-purple-900/40 text-purple-400 px-1.5 py-0.5 rounded font-medium flex-shrink-0">Apollo Verified</span>
                      )}
                      {c.principal_name && (
                        <span className="text-[10px] bg-brand-charcoal text-brand-beige px-1.5 py-0.5 rounded font-medium flex-shrink-0">AR of {c.principal_name}</span>
                      )}
                    </div>
                    <p className="text-brand-beige text-xs truncate mt-0.5">
                      {c.source === 'fca_register'
                        ? `${c.firm}${c.function ? ` · ${c.function}` : ''}${c.function_from ? ` since ${new Date(c.function_from).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}` : ''}`
                        : `${c.role}${c.firm ? ` at ${c.firm}` : ''}${c.location ? `, ${c.location}` : ''}`}
                    </p>
                  </div>
                  {c.linkedin_url && (
                    <a href={c.linkedin_url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="flex-shrink-0 text-[#0A66C2] hover:text-[#004182] transition-colors" title="Find on LinkedIn">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
                    </a>
                  )}
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <div className="w-16 h-1.5 bg-brand-charcoal-dark rounded-full overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${c.confidence * 10}%`, background: c.confidence >= 7 ? '#c49f8c' : c.confidence >= 5 ? '#a18d89' : '#5d5d5d' }} />
                    </div>
                    <span className="text-brand-beige text-xs w-6 text-right">{c.confidence}/10</span>
                  </div>
                </button>
              ))}
              {candidates.length === 0 && (
                <div className="p-8 text-center text-brand-beige text-sm">No candidates yet. Change the brief or the firm match above.</div>
              )}
            </div>
          </div>

          {intent?.path === 'firm_led' && hasMore && (
            <div className="mb-6">
              <button onClick={handleLoadMore} disabled={loadingMore} className="btn-secondary text-sm">
                {loadingMore ? 'Loading...' : 'Load 25 more'}
              </button>
            </div>
          )}

          <div className="flex items-center gap-4">
            <button onClick={handleResearch} className="btn-primary" disabled={selectedCount === 0 || loadingMore}>
              Research &amp; Score {selectedCount} Adviser{selectedCount === 1 ? '' : 's'}
            </button>
            <p className="text-brand-beige text-sm">~{selectedCount * 8}-{selectedCount * 12} seconds total. Counts against your {PLAN_LIMITS.recruitment.advisers_per_cycle} adviser monthly allowance.</p>
          </div>
        </div>
      )}

      {/* STEP 4: RESEARCHING */}
      {step === 'researching' && (
        <div className="text-center py-20">
          <div className="w-16 h-16 border-4 border-brand-rose-gold border-t-transparent rounded-full animate-spin mx-auto mb-6" />
          <h2 className="text-brand-cream text-xl font-display mb-2">
            Researching {researchProgress.total} Adviser{researchProgress.total === 1 ? '' : 's'}
          </h2>
          <p className="text-brand-beige text-sm mb-4">
            Pulling register history and firm signals, finding LinkedIn profiles, scoring, and writing outreach.
          </p>
          <p className="text-brand-beige text-sm">Please keep this tab open.</p>
          <div className="max-w-md mx-auto mt-8">
            <div className="h-2 bg-brand-charcoal-deep rounded-full overflow-hidden">
              <div className="h-full bg-brand-rose-gold rounded-full transition-all duration-1000" style={{ width: researchProgress.total > 0 ? `${(researchProgress.completed / researchProgress.total) * 100}%` : '10%' }} />
            </div>
            <p className="text-brand-beige text-xs mt-2">{researchProgress.completed} of {researchProgress.total}</p>
          </div>
        </div>
      )}
    </div>
  )
}
