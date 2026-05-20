'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { useRouter, useSearchParams } from 'next/navigation'

interface FoundProspect {
  name: string
  role: string
  company: string
  location: string
  linkedin_url: string
  firmFRN?: string
  companyNumber?: string
  individualIRN?: string
  regulatoryStatus?: string
  occupation?: string
  estimatedAge?: number | null
  source?: string
  email?: string | null
  phone?: string | null
  headline?: string | null
  confidence: number
  selected: boolean
}

interface ProspectRow {
  name: string
  role: string
  company: string
  location: string
  linkedin_url: string
}

const emptyRow = (): ProspectRow => ({
  name: '',
  role: '',
  company: '',
  location: '',
  linkedin_url: '',
})

type Step = 'create' | 'find' | 'review' | 'add-manual' | 'researching'

export default function CampaignsPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const supabase = createClient()

  const [step, setStep] = useState<Step>('create')
  const [campaignId, setCampaignId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // Campaign form
  const [campaignName, setCampaignName] = useState('')
  const [niche, setNiche] = useState('')
  const [senderName, setSenderName] = useState('')
  const [prospectSource, setProspectSource] = useState<'hnw_clients' | 'financial_professionals' | 'global_prospects'>('hnw_clients')

  // Service profile (campaign-level override of account defaults)
  const [serviceWhat, setServiceWhat] = useState('')
  const [serviceWho, setServiceWho] = useState('')
  const [serviceOutcomes, setServiceOutcomes] = useState('')
  const [serviceThreshold, setServiceThreshold] = useState('')
  const [serviceGeo, setServiceGeo] = useState('')
  const [showServiceProfile, setShowServiceProfile] = useState(false)

  // v75: audience mode + custom instructions
  const [audienceMode, setAudienceMode] = useState<'match_profile' | 'different_audience' | null>(null)
  const [customInstructions, setCustomInstructions] = useState('')

  const [debugLog, setDebugLog] = useState<string[]>([])

  // Check for existing campaign ID in URL (for "Find More" from campaign dashboard)
  useEffect(() => {
    const existingCampaignId = searchParams.get('campaign')
    if (existingCampaignId) {
      setCampaignId(existingCampaignId)
      setStep('find')
    }
  }, [searchParams])

  // Load account defaults
  useEffect(() => {
    async function loadDefaults() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      const { data } = await supabase.from('profiles').select('niche, sender_name, service_profile').eq('id', user.id).single()
      if (data) {
        if (data.niche && !niche) setNiche(data.niche)
        if (data.sender_name && !senderName) setSenderName(data.sender_name)
        const sp = data.service_profile || {}
        if (sp.what_you_do) setServiceWhat(sp.what_you_do)
        if (sp.who_you_help) setServiceWho(sp.who_you_help)
        if (sp.key_outcomes) setServiceOutcomes(sp.key_outcomes)
        if (sp.minimum_threshold) setServiceThreshold(sp.minimum_threshold)
        if (sp.geographic_focus) setServiceGeo(sp.geographic_focus)
        if (sp.what_you_do || sp.who_you_help) setShowServiceProfile(true)
      }
    }
    loadDefaults()
  }, [])

  // ICP finding
  const [icpDescription, setIcpDescription] = useState('')
  const [finding, setFinding] = useState(false)
  const [findingStatus, setFindingStatus] = useState('')
  const [findMeta, setFindMeta] = useState<{
    firmsSearched: number
    individualsFound: number
    searchTermsUsed: string[]
    timeTakenMs: number
  } | null>(null)

  // Found prospects
  const [foundProspects, setFoundProspects] = useState<FoundProspect[]>([])

  // Manual prospects
  const [manualProspects, setManualProspects] = useState<ProspectRow[]>([emptyRow()])

  // Research progress
  const [researchProgress, setResearchProgress] = useState({ completed: 0, total: 0 })

  // ── Step 1: Create Campaign ────────────────

  async function handleCreateCampaign(e: React.FormEvent) {
    e.preventDefault()
    if (!campaignName.trim()) return toast.error('Campaign name is required')
    if (!audienceMode) return toast.error('Please choose an audience mode')

    setLoading(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error('Not authenticated')

      const { data, error } = await supabase
        .from('campaigns')
        .insert({
          user_id: user.id,
          name: campaignName.trim(),
          niche: niche.trim() || null,
          sender_name: senderName.trim() || null,
          service_profile: {
            what_you_do: serviceWhat.trim() || null,
            who_you_help: serviceWho.trim() || null,
            key_outcomes: serviceOutcomes.trim() || null,
            minimum_threshold: serviceThreshold.trim() || null,
            geographic_focus: serviceGeo.trim() || null,
          },
          audience_mode: audienceMode,
          custom_instructions: customInstructions.trim() || null,
        })
        .select()
        .single()

      if (error) throw error
      setCampaignId(data.id)
      // Pre-fill the ICP description from the service profile's "who you help"
      // only when match_profile is selected. Otherwise leave it blank so the
      // user genuinely describes a different audience.
      if (!icpDescription.trim() && audienceMode === 'match_profile' && serviceWho.trim()) {
        setIcpDescription(serviceWho.trim())
      }
      setStep('find')
      toast.success('Campaign created')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to create campaign'
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }

  // ── Step 2: Find Prospects ─────────────────

  async function handleFindProspects() {
    if (!icpDescription.trim() || icpDescription.length < 10) {
      return toast.error('Describe your ideal client in at least a sentence or two')
    }
    if (!campaignId) return

    setFinding(true)
    setFindMeta(null)
    setDebugLog([])
    const log = (msg: string) => setDebugLog(prev => [...prev, msg])
    const isFCA = prospectSource === 'financial_professionals'
    const isGlobal = prospectSource === 'global_prospects'
    setFindingStatus(isGlobal ? 'Analysing your prospect criteria...' : isFCA ? 'Analysing your target financial professionals...' : 'Analysing your ideal client profile...')

    try {
      // STEP 1: Claude generates search parameters
      log('Step 1: Asking AI to generate search params...')
      const findRes = await fetch('/api/prospects/find', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          campaign_id: campaignId,
          icp_description: icpDescription.trim(),
          max_prospects: 30,
          source: prospectSource,
          custom_instructions: customInstructions.trim() || undefined,
          audience_mode: audienceMode || undefined,
        }),
      })

      const findData = await findRes.json()
      if (!findRes.ok) throw new Error(findData.error || 'Search failed')

      const searchParams = findData.searchParams || {}
      log(`Step 1 result: q_keywords="${searchParams.q_keywords || 'NONE'}"`)
      log(`  person_seniorities: ${JSON.stringify(searchParams.person_seniorities || 'NONE')}`)
      log(`  person_titles: ${JSON.stringify(searchParams.person_titles || 'NONE')}`)
      log(`  person_locations: ${JSON.stringify(searchParams.person_locations || 'NONE')}`)
      log(`  org_keyword_tags: ${JSON.stringify(searchParams.q_organization_keyword_tags || 'NONE')}`)
      log(`  employee_ranges: ${JSON.stringify(searchParams.organization_num_employees_ranges || 'NONE')}`)

      const searchTerms: string[] = searchParams.searchTerms || searchParams.firmSearchTerms || []
      const targetLocations: string[] = searchParams.targetLocations || searchParams.locations || []
      const targetRoles: string[] = searchParams.targetRoles || searchParams.roleKeywords || ['director']

      // STEP 2: For each search term, find real people
      const allProspects: FoundProspect[] = []
      const seenNames: Record<string, boolean> = {}
      let termsProcessed = 0
      const dataSource = isFCA ? 'FCA Register' : isGlobal ? 'Apollo' : 'Companies House'

      if (isGlobal) {
        // Global: loop through pages, 5 prospects per call (Netlify timeout limit)
        const maxPages = 6 // 6 pages × 5 = 30 max prospects

        for (let page = 1; page <= maxPages; page++) {
          if (allProspects.length >= 30) break
          setFindingStatus(`Searching Apollo's global database (page ${page})...`)
          termsProcessed = page

          try {
            const indRes = await fetch('/api/prospects/find-individuals', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                search_term: icpDescription.trim(),
                target_locations: targetLocations,
                target_roles: targetRoles,
                max_individuals: 5,
                source: 'global_prospects',
                apollo_params: { ...searchParams, page },
              }),
            })
            const indData = await indRes.json()
            log(`Page ${page}: status=${indRes.status}, individuals=${indData.individuals?.length || 0}, total=${indData.totalInDatabase || '?'}, fallback=${indData.usedFallback || false}${indData.enrichmentsFailed ? ' ⚠️ ENRICHMENT FAILED (Apollo credits exhausted?)' : ''}`)
            if (indData.error) log(`  Error: ${indData.error}`)
            const newProspects = indData.individuals || []
            if (newProspects.length === 0) break // no more results

            for (const p of newProspects) {
              const key = `${p.name}|${p.company}`.toLowerCase()
              if (!seenNames[key]) {
                seenNames[key] = true
                allProspects.push({ ...p, selected: true })
              }
            }
          } catch (fetchErr) {
            log(`Page ${page} FETCH ERROR: ${fetchErr}`)
            break
          }
        }
      } else {
        // UK: loop through search terms
        if (searchTerms.length === 0) throw new Error('Could not generate search terms. Try a more specific description.')

        for (const term of searchTerms) {
          if (allProspects.length >= 30) break
          termsProcessed++
          setFindingStatus(`Searching ${dataSource}: "${term}" (${termsProcessed}/${searchTerms.length})...`)

        try {
          const indRes = await fetch('/api/prospects/find-individuals', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              search_term: term,
              target_locations: targetLocations,
              target_roles: targetRoles,
              max_individuals: 10,
              source: prospectSource,
            }),
          })

          const indData = await indRes.json()
          for (const p of indData.individuals || []) {
            const key = `${p.name}|${p.company}`.toLowerCase()
            if (!seenNames[key]) {
              seenNames[key] = true
              allProspects.push({ ...p, selected: true })
            }
          }
        } catch {
          continue
        }
      }
      } // close else (UK sources)

      setFoundProspects(allProspects)
      setFindMeta({
        firmsSearched: termsProcessed,
        individualsFound: allProspects.length,
        searchTermsUsed: searchTerms.slice(0, 5),
        timeTakenMs: findData.meta?.timeTakenMs || 0,
      })

      // Save found prospects to DB as 'pending' so they persist across page navigations
      if (allProspects.length > 0 && campaignId) {
        const { data: { user } } = await supabase.auth.getUser()
        if (user) {
          // Get existing prospect names to avoid duplicates
          const { data: existing } = await supabase
            .from('prospects')
            .select('name, company')
            .eq('campaign_id', campaignId)
          const existingKeys = new Set((existing || []).map(e => `${e.name}|${e.company}`.toLowerCase()))

          const newProspects = allProspects
            .filter(p => !existingKeys.has(`${p.name}|${p.company}`.toLowerCase()))
            .map(p => ({
              campaign_id: campaignId,
              user_id: user.id,
              name: p.name,
              role: p.role || null,
              company: p.company || null,
              location: p.location || null,
              linkedin_url: p.linkedin_url || null,
              email: p.email || null,
              phone: p.phone || null,
              headline: p.headline || null,
              company_number: p.companyNumber || null,
              status: 'pending' as const,
            }))

          if (newProspects.length > 0) {
            await supabase.from('prospects').insert(newProspects)
          }
        }
      }

      setStep('review')

      if (allProspects.length > 0) {
        toast.success(
          isGlobal
            ? `Found ${allProspects.length} prospects from Apollo's global database`
            : isFCA
            ? `Found ${allProspects.length} FCA-registered professionals`
            : `Found ${allProspects.length} real company directors from Companies House`
        )
      } else {
        toast.success('No matches found. Try a broader description or add prospects manually.')
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Finding failed'
      toast.error(message)
    } finally {
      setFinding(false)
      setFindingStatus('')
    }
  }

  // ── Step 3: Research Selected ──────────────

  async function handleResearch() {
    const selected = foundProspects.filter((p) => p.selected)
    if (selected.length === 0) return toast.error('Select at least one prospect')
    if (!campaignId) return

    setStep('researching')
    const total = selected.length
    let completed = 0
    let failed = 0
    let lastError = ''
    setResearchProgress({ completed: 0, total })

    // Process in batches of 5 (Netlify function timeout limit)
    const BATCH_SIZE = 1
    for (let i = 0; i < selected.length; i += BATCH_SIZE) {
      const batch = selected.slice(i, i + BATCH_SIZE)
      try {
        const res = await fetch('/api/prospects/research', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            campaign_id: campaignId,
            prospects: batch.map((p) => ({
              name: p.name,
              role: p.role,
              company: p.company,
              location: p.location,
              linkedin_url: p.linkedin_url || '',
              company_number: p.companyNumber || undefined,
            })),
          }),
        })

        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'Research failed')

        completed += data.completed || 0
        failed += data.failed || 0
        setResearchProgress({ completed, total })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Batch failed'
        console.error(`Batch ${i / BATCH_SIZE + 1} failed:`, message)
        lastError = message
        failed += batch.length
        setResearchProgress({ completed, total })
      }
    }

    if (completed > 0) {
      toast.success(
        `Researched ${completed} prospects${failed > 0 ? ` (${failed} failed)` : ''}`
      )
      router.push(`/dashboard/campaigns/${campaignId}`)
    } else {
      toast.error(`All research requests failed: ${lastError || 'Unknown error'}. Try again or check Netlify logs.`)
      setStep('review')
    }
  }

  // ── Manual Research ────────────────────────

  async function handleManualResearch() {
    const valid = manualProspects.filter((p) => p.name.trim())
    if (valid.length === 0) return toast.error('Add at least one prospect name')
    if (!campaignId) return

    setStep('researching')
    const total = valid.length
    let completed = 0
    let failed = 0
    setResearchProgress({ completed: 0, total })

    const BATCH_SIZE = 1
    for (let i = 0; i < valid.length; i += BATCH_SIZE) {
      const batch = valid.slice(i, i + BATCH_SIZE)
      try {
        const res = await fetch('/api/prospects/research', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            campaign_id: campaignId,
            prospects: batch,
          }),
        })

        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'Research failed')

        completed += data.completed || 0
        failed += data.failed || 0
        setResearchProgress({ completed, total })
      } catch {
        failed += batch.length
        setResearchProgress({ completed, total })
      }
    }

    if (completed > 0) {
      toast.success(`Researched ${completed} prospects${failed > 0 ? ` (${failed} failed)` : ''}`)
      router.push(`/dashboard/campaigns/${campaignId}`)
    } else {
      toast.error('Research failed. Please try again.')
      setStep('add-manual')
    }
  }

  // ── Manual prospect helpers ────────────────

  function updateManual(i: number, field: keyof ProspectRow, value: string) {
    const updated = [...manualProspects]
    updated[i] = { ...updated[i], [field]: value }
    setManualProspects(updated)
  }

  function addManualRow() {
    if (manualProspects.length >= 50) return toast.error('Maximum 50 per batch')
    setManualProspects([...manualProspects, emptyRow()])
  }

  function removeManualRow(i: number) {
    if (manualProspects.length <= 1) return
    setManualProspects(manualProspects.filter((_, idx) => idx !== i))
  }

  async function handleCSVUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const text = await file.text()
    const lines = text.split('\n').filter((l) => l.trim())
    const header = lines[0].toLowerCase()
    const cols = header.split(',').map((c) => c.trim())
    const ni = cols.findIndex((c) => c.includes('name'))
    const ri = cols.findIndex((c) => c.includes('role') || c.includes('title'))
    const ci = cols.findIndex((c) => c.includes('company') || c.includes('firm'))
    const li = cols.findIndex((c) => c.includes('location') || c.includes('city'))
    const ui = cols.findIndex((c) => c.includes('linkedin') || c.includes('url'))
    if (ni === -1) return toast.error('CSV must contain a "name" column')
    const rows = lines.slice(1).map((line) => {
      const v = line.split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''))
      return { name: v[ni] || '', role: ri >= 0 ? v[ri] || '' : '', company: ci >= 0 ? v[ci] || '' : '', location: li >= 0 ? v[li] || '' : '', linkedin_url: ui >= 0 ? v[ui] || '' : '' }
    }).filter((r) => r.name.trim())
    setManualProspects(rows.slice(0, 50))
    toast.success(`Loaded ${Math.min(rows.length, 50)} prospects`)
    e.target.value = ''
  }

  // ── Toggle helpers ─────────────────────────

  function toggleProspect(i: number) {
    const updated = [...foundProspects]
    updated[i] = { ...updated[i], selected: !updated[i].selected }
    setFoundProspects(updated)
  }

  function selectAll() {
    setFoundProspects(foundProspects.map((p) => ({ ...p, selected: true })))
  }

  function deselectAll() {
    setFoundProspects(foundProspects.map((p) => ({ ...p, selected: false })))
  }

  const selectedCount = foundProspects.filter((p) => p.selected).length

  // ── Render ─────────────────────────────────

  return (
    <div>
      {/* Step indicator */}
      <div className="flex items-center gap-3 mb-8">
        {[
          { key: 'create', label: '1. Campaign' },
          { key: 'find', label: '2. Find' },
          { key: 'review', label: '3. Review' },
          { key: 'researching', label: '4. Research' },
        ].map((s, i) => {
          const steps: Step[] = ['create', 'find', 'review', 'researching']
          const currentIdx = steps.indexOf(step === 'add-manual' ? 'find' : step)
          const isActive = i <= currentIdx
          return (
            <div key={s.key} className="flex items-center gap-3">
              <div className={`flex items-center gap-2 ${isActive ? 'text-brand-cream' : 'text-brand-charcoal'}`}>
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${isActive ? 'bg-brand-rose-gold text-brand-dark' : 'bg-brand-charcoal-deep text-brand-charcoal'}`}>
                  {i + 1}
                </div>
                <span className="text-sm font-medium">{s.label}</span>
              </div>
              {i < 3 && (
                <div className={`w-8 h-px ${isActive ? 'bg-brand-rose-gold' : 'bg-brand-charcoal-deep'}`} />
              )}
            </div>
          )
        })}
      </div>

      {/* ════════════════════════════════════════ */}
      {/* STEP 1: CREATE CAMPAIGN                 */}
      {/* ════════════════════════════════════════ */}
      {step === 'create' && (
        <div>
          <h1 className="text-2xl font-display text-brand-cream mb-2">New Campaign</h1>
          <p className="text-brand-beige text-sm mb-8">
            Set up your campaign, then we will find prospects matching your ideal client profile.
          </p>

          <form onSubmit={handleCreateCampaign} className="max-w-lg space-y-5">
            <div>
              <label className="block text-brand-cream text-sm font-medium mb-1.5">Campaign Name *</label>
              <input type="text" value={campaignName} onChange={(e) => setCampaignName(e.target.value)} placeholder="e.g. Surrey Property Directors Q2 2026" className="w-full" required />
            </div>
            <div>
              <label className="block text-brand-cream text-sm font-medium mb-1.5">Target Niche</label>
              <input type="text" value={niche} onChange={(e) => setNiche(e.target.value)} placeholder="e.g. Property investors, Business owners approaching retirement, Tech founders with exits" className="w-full" />
              <p className="text-brand-beige text-xs mt-1">Helps the AI tailor research and outreach to your market.</p>
            </div>
            <div>
              <label className="block text-brand-cream text-sm font-medium mb-1.5">Outreach Sender Name</label>
              <input type="text" value={senderName} onChange={(e) => setSenderName(e.target.value)} placeholder="The name that signs your outreach messages" className="w-full" />
            </div>

            {/* v75: Audience mode (required, no default) */}
            <div>
              <label className="block text-brand-cream text-sm font-medium mb-2.5">
                Who are you looking for? <span className="text-brand-rose-gold">*</span>
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setAudienceMode('different_audience')}
                  className={`p-3 rounded-lg border text-left transition-colors ${audienceMode === 'different_audience' ? 'border-brand-rose-gold bg-brand-rose-gold/10' : 'border-brand-charcoal hover:border-brand-charcoal-dark'}`}
                >
                  <p className={`text-sm font-semibold ${audienceMode === 'different_audience' ? 'text-brand-rose-gold' : 'text-brand-cream'}`}>A different audience</p>
                  <p className="text-brand-beige text-xs mt-0.5">
                    Find prospects who are NOT in your industry. Your service profile will be used only for writing outreach, not for search.
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => setAudienceMode('match_profile')}
                  className={`p-3 rounded-lg border text-left transition-colors ${audienceMode === 'match_profile' ? 'border-brand-rose-gold bg-brand-rose-gold/10' : 'border-brand-charcoal hover:border-brand-charcoal-dark'}`}
                >
                  <p className={`text-sm font-semibold ${audienceMode === 'match_profile' ? 'text-brand-rose-gold' : 'text-brand-cream'}`}>People like my existing clients</p>
                  <p className="text-brand-beige text-xs mt-0.5">
                    Find prospects matching your service profile. Use this if your client base IS the target.
                  </p>
                </button>
              </div>
              {!audienceMode && (
                <p className="text-brand-beige text-xs mt-2">
                  Choose one to continue. This is the most common cause of off-target results.
                </p>
              )}
            </div>

            {/* v75: Custom instructions */}
            <div>
              <label className="block text-brand-cream text-sm font-medium mb-1.5">
                Anything specific about this batch? <span className="text-brand-beige text-xs font-normal">(optional)</span>
              </label>
              <textarea
                value={customInstructions}
                onChange={(e) => setCustomInstructions(e.target.value)}
                placeholder="e.g. exclude London, focus on second-time founders, avoid anyone in financial services, prefer companies older than 10 years..."
                className="w-full h-20 resize-none text-sm"
              />
              <p className="text-brand-beige text-xs mt-1">
                These instructions guide both prospect search and scoring. Hard constraints work best.
              </p>
            </div>

            <div>
              <label className="block text-brand-cream text-sm font-medium mb-2.5">Data source</label>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setProspectSource('hnw_clients')}
                  className={`flex-1 p-3 rounded-lg border text-left transition-colors ${prospectSource === 'hnw_clients' ? 'border-brand-rose-gold bg-brand-rose-gold/10' : 'border-brand-charcoal hover:border-brand-charcoal-dark'}`}
                >
                  <p className={`text-sm font-semibold ${prospectSource === 'hnw_clients' ? 'text-brand-rose-gold' : 'text-brand-cream'}`}>HNW Clients (UK)</p>
                  <p className="text-brand-beige text-xs mt-0.5">Company directors from Companies House</p>
                </button>
                <button
                  type="button"
                  onClick={() => setProspectSource('financial_professionals')}
                  className={`flex-1 p-3 rounded-lg border text-left transition-colors ${prospectSource === 'financial_professionals' ? 'border-brand-rose-gold bg-brand-rose-gold/10' : 'border-brand-charcoal hover:border-brand-charcoal-dark'}`}
                >
                  <p className={`text-sm font-semibold ${prospectSource === 'financial_professionals' ? 'text-brand-rose-gold' : 'text-brand-cream'}`}>Financial Pros (UK)</p>
                  <p className="text-brand-beige text-xs mt-0.5">IFAs, wealth managers from FCA Register</p>
                </button>
                <button
                  type="button"
                  onClick={() => setProspectSource('global_prospects')}
                  className={`flex-1 p-3 rounded-lg border text-left transition-colors ${prospectSource === 'global_prospects' ? 'border-brand-rose-gold bg-brand-rose-gold/10' : 'border-brand-charcoal hover:border-brand-charcoal-dark'}`}
                >
                  <p className={`text-sm font-semibold ${prospectSource === 'global_prospects' ? 'text-brand-rose-gold' : 'text-brand-cream'}`}>Global Prospects</p>
                  <p className="text-brand-beige text-xs mt-0.5">Directors and executives worldwide via Apollo</p>
                </button>
              </div>
            </div>

            {/* Service Profile (collapsible) */}
            <div className="border border-brand-charcoal rounded-lg overflow-hidden">
              <button
                type="button"
                onClick={() => setShowServiceProfile(!showServiceProfile)}
                className="w-full flex items-center justify-between p-3 text-left hover:bg-brand-charcoal-deep/30 transition-colors"
              >
                <div>
                  <p className="text-brand-cream text-sm font-semibold">Your Service Offering</p>
                  <p className="text-brand-beige text-xs mt-0.5">
                    {serviceWhat ? 'Configured' : 'Tell the AI about your service for better prospect matching and outreach'}
                  </p>
                </div>
                <span className="text-brand-beige text-xs">{showServiceProfile ? '▲ Hide' : '▼ Show'}</span>
              </button>

              {showServiceProfile && (
                <div className="p-3 pt-0 space-y-3 border-t border-brand-charcoal">
                  <div className="mt-3">
                    <label className="block text-brand-cream text-xs font-medium mb-1">What you do</label>
                    <input
                      type="text"
                      value={serviceWhat}
                      onChange={(e) => setServiceWhat(e.target.value)}
                      placeholder="e.g. Independent financial planning for business owners approaching exit"
                      className="w-full text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-brand-cream text-xs font-medium mb-1">Who you help</label>
                    <textarea
                      value={serviceWho}
                      onChange={(e) => setServiceWho(e.target.value)}
                      placeholder="e.g. Business owners aged 50-65 with £2M+ net worth planning succession or retirement"
                      className="w-full h-16 resize-none text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-brand-cream text-xs font-medium mb-1">Key outcomes you deliver</label>
                    <textarea
                      value={serviceOutcomes}
                      onChange={(e) => setServiceOutcomes(e.target.value)}
                      placeholder="e.g. Tax-efficient exit strategy, retirement income plan, CGT mitigation"
                      className="w-full h-16 resize-none text-sm"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-brand-cream text-xs font-medium mb-1">Minimum threshold</label>
                      <input
                        type="text"
                        value={serviceThreshold}
                        onChange={(e) => setServiceThreshold(e.target.value)}
                        placeholder="e.g. £500K investable assets"
                        className="w-full text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-brand-cream text-xs font-medium mb-1">Geographic focus</label>
                      <input
                        type="text"
                        value={serviceGeo}
                        onChange={(e) => setServiceGeo(e.target.value)}
                        placeholder="e.g. South East England"
                        className="w-full text-sm"
                      />
                    </div>
                  </div>
                  <p className="text-brand-charcoal text-[10px]">
                    Defaults loaded from Settings. Changes here only apply to this campaign.
                  </p>
                </div>
              )}
            </div>

            <button type="submit" className="btn-primary" disabled={loading || !audienceMode}>
              {loading ? 'Creating...' : 'Create Campaign'}
            </button>
          </form>
        </div>
      )}

      {/* ════════════════════════════════════════ */}
      {/* STEP 2: FIND PROSPECTS                  */}
      {/* ════════════════════════════════════════ */}
      {step === 'find' && (
        <div>
          <h1 className="text-2xl font-display text-brand-cream mb-2">Find Prospects</h1>
          <p className="text-brand-beige text-sm mb-6">
            {prospectSource === 'hnw_clients'
              ? 'Describe your ideal HNW client and we will search Companies House to find real company directors, business owners, and high-net-worth individuals matching your criteria. Or add contacts manually if you already have names.'
              : prospectSource === 'financial_professionals'
              ? 'Describe the financial professionals you want to reach and we will search the FCA Register to find real approved persons at authorised firms. Or add contacts manually if you already have names.'
              : 'Describe the type of prospect you want to find globally. We will search Apollo\'s database of 270M+ professionals worldwide to find matching directors, executives, and business owners. Or add contacts manually.'}
          </p>

          {/* Data source selector */}
          <div className="max-w-2xl mb-6">
            <label className="block text-brand-cream text-sm font-medium mb-2">Data source</label>
            <div className="flex gap-2">
              {([
                { key: 'hnw_clients' as const, label: 'HNW Clients (UK)', sub: 'Companies House' },
                { key: 'financial_professionals' as const, label: 'Financial Pros (UK)', sub: 'FCA Register' },
                { key: 'global_prospects' as const, label: 'Global Prospects', sub: 'Apollo 270M+' },
              ]).map((src) => (
                <button
                  key={src.key}
                  type="button"
                  onClick={() => setProspectSource(src.key)}
                  disabled={finding}
                  className={`flex-1 p-2.5 rounded-lg border text-left transition-colors ${prospectSource === src.key ? 'border-brand-rose-gold bg-brand-rose-gold/10' : 'border-brand-charcoal hover:border-brand-charcoal-dark'}`}
                >
                  <p className={`text-xs font-semibold ${prospectSource === src.key ? 'text-brand-rose-gold' : 'text-brand-cream'}`}>{src.label}</p>
                  <p className="text-brand-beige text-[10px] mt-0.5">{src.sub}</p>
                </button>
              ))}
            </div>
          </div>

          {/* ICP input */}
          <div className="max-w-2xl">
            <div className="bg-brand-charcoal-deep rounded-xl border border-brand-charcoal p-6 mb-6">
              <label className="block text-brand-cream text-sm font-medium mb-3">
                {prospectSource === 'hnw_clients'
                  ? 'Describe your ideal HNW client profile'
                  : prospectSource === 'financial_professionals'
                  ? 'Describe the financial professionals you want to reach'
                  : 'Describe the type of prospect you want to find globally'}
              </label>
              <textarea
                value={icpDescription}
                onChange={(e) => setIcpDescription(e.target.value)}
                placeholder={prospectSource === 'hnw_clients'
                  ? "e.g. Company directors in Surrey running property development or investment businesses, likely aged 45-65 with established wealth.\n\nOr: Tech company founders in London with businesses turning over £2M+, likely approaching a liquidity event.\n\nOr: Business owners in Manchester and Leeds running manufacturing or engineering firms, established 10+ years, potential retirement planning needs."
                  : prospectSource === 'financial_professionals'
                  ? "e.g. Independent financial advisers in Yorkshire, ideally directors or principals at boutique firms managing retirement planning.\n\nOr: Mortgage brokers in London and the South East handling £500K+ cases, complex income, portfolio landlords.\n\nOr: Wealth managers in the Home Counties focused on HNW private clients, managing £50M+ AUM at independent firms."
                  : "e.g. Property development company CEOs and directors in Dubai and Abu Dhabi.\n\nOr: Fintech founders and CTOs in Singapore with companies of 50-200 employees.\n\nOr: Managing directors of private equity firms in Zurich and Geneva with 10+ years experience."}
                className="w-full h-32 resize-none"
                disabled={finding}
              />
              <p className="text-brand-beige text-xs mt-2">
                Be specific about roles, locations, firm types, and any preferences. The more detail you give, the better the results.
              </p>

              <div className="flex items-center gap-4 mt-4">
                <button
                  onClick={handleFindProspects}
                  className="btn-primary"
                  disabled={finding || icpDescription.length < 10}
                >
                  {finding ? (
                    <span className="flex items-center gap-2">
                      <span className="w-4 h-4 border-2 border-brand-dark border-t-transparent rounded-full animate-spin" />
                      Finding prospects...
                    </span>
                  ) : (
                    prospectSource === 'hnw_clients'
                      ? 'Find HNW Prospects'
                      : prospectSource === 'financial_professionals'
                      ? 'Find Financial Professionals'
                      : 'Find Global Prospects'
                  )}
                </button>

                {finding && findingStatus && (
                  <p className="text-brand-beige text-sm">{findingStatus}</p>
                )}
              </div>
            </div>

            {/* Divider */}
            <div className="flex items-center gap-4 mb-6">
              <div className="flex-1 h-px bg-brand-charcoal" />
              <span className="text-brand-beige text-xs uppercase tracking-wide">or</span>
              <div className="flex-1 h-px bg-brand-charcoal" />
            </div>

            {/* Manual option */}
            <button
              onClick={() => setStep('add-manual')}
              className="btn-secondary text-sm"
            >
              I already have names — add contacts manually
            </button>
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════ */}
      {/* STEP 2b: ADD MANUAL PROSPECTS            */}
      {/* ════════════════════════════════════════ */}
      {step === 'add-manual' && (
        <div>
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-2xl font-display text-brand-cream mb-2">Add Prospects Manually</h1>
              <p className="text-brand-beige text-sm">Enter contacts or upload a CSV.</p>
            </div>
            <button onClick={() => setStep('find')} className="text-brand-rose-gold text-sm hover:underline">
              &larr; Back to ICP search
            </button>
          </div>

          <div className="mb-4">
            <label className="btn-secondary text-sm cursor-pointer">
              Upload CSV
              <input type="file" accept=".csv" onChange={handleCSVUpload} className="hidden" />
            </label>
            <span className="text-brand-beige text-xs ml-3">Columns: name, role, company, location, linkedin_url</span>
          </div>

          <div className="bg-brand-charcoal-deep rounded-xl border border-brand-charcoal overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-brand-charcoal-deeper">
                    {['#', 'Name *', 'Role', 'Company', 'Location', 'LinkedIn URL', ''].map((h) => (
                      <th key={h} className="text-left p-3 text-brand-beige font-medium text-xs uppercase tracking-wide">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-brand-charcoal">
                  {manualProspects.map((p, i) => (
                    <tr key={i} className="hover:bg-brand-charcoal-deeper/30">
                      <td className="p-3 text-brand-beige">{i + 1}</td>
                      <td className="p-2"><input type="text" value={p.name} onChange={(e) => updateManual(i, 'name', e.target.value)} placeholder="Full name" className="w-full text-sm py-2" /></td>
                      <td className="p-2"><input type="text" value={p.role} onChange={(e) => updateManual(i, 'role', e.target.value)} placeholder="Job title" className="w-full text-sm py-2" /></td>
                      <td className="p-2"><input type="text" value={p.company} onChange={(e) => updateManual(i, 'company', e.target.value)} placeholder="Company" className="w-full text-sm py-2" /></td>
                      <td className="p-2"><input type="text" value={p.location} onChange={(e) => updateManual(i, 'location', e.target.value)} placeholder="City" className="w-full text-sm py-2" /></td>
                      <td className="p-2"><input type="text" value={p.linkedin_url} onChange={(e) => updateManual(i, 'linkedin_url', e.target.value)} placeholder="URL" className="w-full text-sm py-2" /></td>
                      <td className="p-2">
                        {manualProspects.length > 1 && (
                          <button onClick={() => removeManualRow(i)} className="text-brand-beige hover:text-red-400 text-lg">&times;</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="p-4 border-t border-brand-charcoal flex items-center justify-between">
              <button onClick={addManualRow} className="text-brand-rose-gold text-sm font-medium hover:underline">+ Add row</button>
              <span className="text-brand-beige text-xs">{manualProspects.filter((p) => p.name.trim()).length} ready</span>
            </div>
          </div>

          <div className="mt-6">
            <button onClick={handleManualResearch} className="btn-primary" disabled={manualProspects.filter((p) => p.name.trim()).length === 0}>
              Research {manualProspects.filter((p) => p.name.trim()).length} Prospects
            </button>
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════ */}
      {/* STEP 3: REVIEW FOUND PROSPECTS           */}
      {/* ════════════════════════════════════════ */}
      {step === 'review' && (
        <div>
          <h1 className="text-2xl font-display text-brand-cream mb-2">Review Found Prospects</h1>
          <p className="text-brand-beige text-sm mb-4">
            We found {foundProspects.length} prospects matching your ICP. These are real, verified individuals from public records. Select the ones you want to research and score.
          </p>

          {/* Debug log — temporary */}
          {debugLog.length > 0 && (
            <div className="mb-6 rounded-lg border border-yellow-600/30 bg-yellow-900/10 p-4 max-h-48 overflow-y-auto">
              <p className="text-yellow-500 text-xs font-bold mb-2 uppercase tracking-wide">Search Debug Log</p>
              {debugLog.map((line, i) => (
                <p key={i} className="text-yellow-400/80 text-xs font-mono leading-relaxed">{line}</p>
              ))}
            </div>
          )}

          {/* Meta stats */}
          {findMeta && (
            <div className="grid grid-cols-4 gap-3 mb-6">
              {[
                { label: 'Search Terms Used', value: findMeta.firmsSearched },
                { label: 'Directors Found', value: findMeta.individualsFound },
                { label: 'Top Searches', value: findMeta.searchTermsUsed.slice(0, 3).join(', ') },
                { label: 'Time Taken', value: `${(findMeta.timeTakenMs / 1000).toFixed(1)}s` },
              ].map((s) => (
                <div key={s.label} className="bg-brand-charcoal-deep rounded-lg p-3 border border-brand-charcoal">
                  <p className="text-brand-beige text-[10px] uppercase tracking-wide">{s.label}</p>
                  <p className="text-brand-cream text-sm font-semibold mt-0.5">{s.value}</p>
                </div>
              ))}
            </div>
          )}

          {/* Select controls */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <button onClick={selectAll} className="text-brand-rose-gold text-sm hover:underline">Select all</button>
              <span className="text-brand-charcoal">|</span>
              <button onClick={deselectAll} className="text-brand-beige text-sm hover:underline">Deselect all</button>
              <span className="text-brand-beige text-sm ml-2">
                {selectedCount} of {foundProspects.length} selected
              </span>
            </div>
            <button onClick={() => setStep('find')} className="text-brand-rose-gold text-sm hover:underline">
              &larr; Search again
            </button>
          </div>

          {/* Prospect list */}
          <div className="bg-brand-charcoal-deep rounded-xl border border-brand-charcoal overflow-hidden mb-6">
            <div className="divide-y divide-brand-charcoal">
              {foundProspects.map((p, i) => (
                <button
                  key={i}
                  onClick={() => toggleProspect(i)}
                  className={`w-full text-left p-4 flex items-center gap-4 transition-colors ${p.selected ? 'bg-brand-rose-gold/5' : 'hover:bg-brand-charcoal-deeper/30'}`}
                >
                  {/* Checkbox */}
                  <div className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors ${p.selected ? 'bg-brand-rose-gold border-brand-rose-gold' : 'border-brand-charcoal'}`}>
                    {p.selected && <span className="text-brand-dark text-xs font-bold">&#10003;</span>}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-brand-cream text-sm font-semibold truncate">{p.name}</p>
                      {p.companyNumber && (
                        <span className="text-[10px] bg-blue-900/40 text-blue-400 px-1.5 py-0.5 rounded font-medium flex-shrink-0">
                          CH Verified
                        </span>
                      )}
                      {p.firmFRN && (
                        <span className="text-[10px] bg-green-900/40 text-green-400 px-1.5 py-0.5 rounded font-medium flex-shrink-0">
                          FCA Registered
                        </span>
                      )}
                      {!p.companyNumber && !p.firmFRN && p.source === 'apollo' && (
                        <span className="text-[10px] bg-purple-900/40 text-purple-400 px-1.5 py-0.5 rounded font-medium flex-shrink-0">
                          Apollo Verified
                        </span>
                      )}
                      {!p.companyNumber && !p.firmFRN && p.source !== 'apollo' && p.regulatoryStatus && (
                        <span className="text-[10px] bg-brand-charcoal text-brand-beige px-1.5 py-0.5 rounded font-medium flex-shrink-0">
                          {p.regulatoryStatus}
                        </span>
                      )}
                    </div>
                    <p className="text-brand-beige text-xs truncate mt-0.5">
                      {p.role}{p.company ? ` at ${p.company}` : ''}{p.location ? ` — ${p.location}` : ''}
                      {p.occupation ? ` (${p.occupation})` : ''}
                    </p>
                  </div>

                  {/* LinkedIn link */}
                  {p.linkedin_url && (
                    <a
                      href={p.linkedin_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="flex-shrink-0 text-[#0A66C2] hover:text-[#004182] transition-colors"
                      title="Find on LinkedIn"
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
                    </a>
                  )}

                  {/* Confidence */}
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <div className="w-16 h-1.5 bg-brand-charcoal-dark rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{
                          width: `${p.confidence * 10}%`,
                          background: p.confidence >= 7 ? '#c49f8c' : p.confidence >= 5 ? '#a18d89' : '#5d5d5d',
                        }}
                      />
                    </div>
                    <span className="text-brand-beige text-xs w-6 text-right">{p.confidence}/10</span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-4">
            <button
              onClick={handleResearch}
              className="btn-primary"
              disabled={selectedCount === 0}
            >
              Research &amp; Score {selectedCount} Prospects
            </button>
            <p className="text-brand-beige text-sm">
              ~{selectedCount * 20}-{selectedCount * 30} seconds total
            </p>
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════ */}
      {/* STEP 4: RESEARCHING                      */}
      {/* ════════════════════════════════════════ */}
      {step === 'researching' && (
        <div className="text-center py-20">
          <div className="w-16 h-16 border-4 border-brand-rose-gold border-t-transparent rounded-full animate-spin mx-auto mb-6" />
          <h2 className="text-brand-cream text-xl font-display mb-2">
            Researching {researchProgress.total} Prospects
          </h2>
          <p className="text-brand-beige text-sm mb-4">
            Generating intelligence dossiers, scoring, and writing personalised outreach sequences.
          </p>
          <p className="text-brand-beige text-sm">
            This takes 15-30 seconds per prospect. Please keep this tab open.
          </p>

          {/* Progress bar */}
          <div className="max-w-md mx-auto mt-8">
            <div className="h-2 bg-brand-charcoal-deep rounded-full overflow-hidden">
              <div
                className="h-full bg-brand-rose-gold rounded-full transition-all duration-1000"
                style={{ width: researchProgress.total > 0 ? `${(researchProgress.completed / researchProgress.total) * 100}%` : '10%' }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
