import { NextRequest, NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireRecruitmentAccess, consumeRecruitmentResearch, refundRecruitmentResearch } from '@/lib/recruitment/gate'
import { mergeRecruitmentProfiles } from '@/lib/recruitment/access'
import { researchAdviser } from '@/lib/recruitment/ai-engine'
import { enrichWithApollo, type ApolloEnrichResult } from '@/lib/data-sources/apollo'
import {
  getIndividualProfile,
  getIndividualFunctions,
  getIndividualDisciplinary,
  searchIndividuals,
  pickIndividualMatch,
  deriveCareerSignals,
  getFirmSignals,
  type FCAIndividualProfile,
  type FCAIndividualFunctions,
  type FCAFirmSignalsResult,
} from '@/lib/data-sources/fca-register'
import { AdviserFcaData } from '@/types'
import { z } from 'zod'

// One adviser per request. The client batches sequentially, the same
// pattern as /api/prospects/research. FCA lookups and the Apollo lookup run
// in parallel, then Claude. Must finish inside Netlify's 10 second limit.

const RESEARCH_DEADLINE_MS = 9000

const Schema = z.object({
  campaign_id: z.string().uuid(),
  prospect_id: z.string().uuid(),
  firm_signals: z.record(z.unknown()).optional(),
})

const ADVISER_KEYWORDS = /mortgage|advis|financ|wealth|protection|broker|planner|paraplanner|\bifa\b|insurance|pension|invest|equity release|later life/i
const GENERIC_TOKENS = new Set(['limited', 'ltd', 'llp', 'plc', 'the', 'and', 'financial', 'services', 'service', 'mortgage', 'mortgages', 'solutions', 'group', 'uk', 'advice', 'advisers', 'advisors', 'wealth', 'management', 'planning', 'partners', 'associates', 'company', 'consultants', 'consulting'])

function firmTokens(name: string | null | undefined): Set<string> {
  const out = new Set<string>()
  for (const t of (name || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)) {
    if (t.length >= 4 && !GENERIC_TOKENS.has(t)) out.add(t)
  }
  return out
}

// Apollo people/match by name and organisation returns the closest person
// it can find, not always the one we asked for. Only keep a match that is
// plausibly this adviser: the organisation shares a distinctive word with a
// known firm, or the title or headline reads like an adviser's.
function apolloMatchIsPlausible(match: ApolloEnrichResult, firmNames: string[]): boolean {
  const orgTokens = firmTokens(match.company)
  for (const firm of firmNames) {
    for (const t of Array.from(firmTokens(firm))) {
      if (orgTokens.has(t)) return true
    }
  }
  return ADVISER_KEYWORDS.test(`${match.title || ''} ${match.headline || ''} ${match.company || ''}`)
}

function splitName(fullName: string): { first: string; last: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean)
  return { first: parts[0] || '', last: parts.length > 1 ? parts[parts.length - 1] : '' }
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now()
  const gate = await requireRecruitmentAccess()
  if (!gate.ok) return gate.response

  const body = await req.json()
  const parsed = Schema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input' }, { status: 400 })
  }
  const { campaign_id, prospect_id } = parsed.data
  const providedSignals = (parsed.data.firm_signals || null) as unknown as FCAFirmSignalsResult | null

  const supabase = createClient()
  const admin = createAdminClient()

  const [campaignRes, prospectRes] = await Promise.all([
    supabase.from('campaigns')
      .select('id, name, purpose, sender_name, recruitment_profile, custom_instructions')
      .eq('id', campaign_id).eq('user_id', gate.user.id).single(),
    supabase.from('prospects')
      .select('id, name, role, company, location, linkedin_url, email, phone, headline, prospect_type, fca_irn, fca_frn, fca_firm_name, fca_status, fca_data, status')
      .eq('id', prospect_id).eq('campaign_id', campaign_id).eq('user_id', gate.user.id).single(),
  ])

  const campaign = campaignRes.data
  const prospect = prospectRes.data
  if (!campaign || campaign.purpose !== 'advisers') {
    return NextResponse.json({ error: 'Recruitment campaign not found' }, { status: 404 })
  }
  if (!prospect || prospect.prospect_type !== 'adviser') {
    return NextResponse.json({ error: 'Adviser not found' }, { status: 404 })
  }

  // Usage: the Recruitment allowance only, never the client plan. Reserved
  // up front in the database, so two tabs at once can't both slip under the
  // limit, and given back below if the research fails. Logged in
  // usage_events as adviser_research.
  const usageBlocked = await consumeRecruitmentResearch(gate)
  if (usageBlocked) return usageBlocked

  const recruitmentProfile = mergeRecruitmentProfiles(gate.profile.recruitment_profile, campaign.recruitment_profile)
  const principalName = campaign.sender_name || gate.profile.sender_name || gate.profile.full_name || 'The hiring principal'

  await admin.from('prospects').update({ status: 'processing', error_message: null }).eq('id', prospect.id)

  try {
    // Everything that can be slow sits inside a 9 second deadline, so a
    // slow register or model fails cleanly (and is refunded) instead of
    // Netlify killing the function at 10 seconds with the research counted
    // and the adviser stuck on processing. Saving happens after the race.
    const work = async () => {
      // Company first: for AR advisers it is the AR trading name, which is what
      // LinkedIn shows. fca_firm_name is the principal on the register.
      const knownFirmNames = [prospect.company, prospect.fca_firm_name].filter((s): s is string => !!s)
      const alreadyHasLinkedIn = !!(prospect.linkedin_url && prospect.linkedin_url.includes('/in/'))
      // Advisers found through Apollo were already enriched by Apollo ID when
      // they were found. A second, name-based lookup would spend an uncounted
      // Apollo credit and could attach someone else's details.
      const fromApollo = (prospect.fca_data as Record<string, unknown> | null)?.candidate_source === 'apollo'
      const { first, last } = splitName(prospect.name)

      // ── FCA and Apollo in parallel ──
      const [fcaBlock, apolloMatch] = await Promise.all([
        lookupRegister(prospect.fca_irn, prospect.name),
        alreadyHasLinkedIn || fromApollo || !last
          ? Promise.resolve<ApolloEnrichResult | null>(null)
          : enrichWithApollo(first, last, knownFirmNames[0] || '').catch((err) => {
              console.error('[Adviser research] Apollo failed:', err)
              return null
            }),
      ])

      // Workplace names help the Apollo plausibility check for AR advisers,
      // whose register firm is the principal, not the trading name on LinkedIn.
      const workplaceNames = fcaBlock.profile?.workplaces.map((w) => w.firm_name) || []
      const apollo = apolloMatch && apolloMatchIsPlausible(apolloMatch, [...knownFirmNames, ...workplaceNames]) ? apolloMatch : null
      if (apolloMatch && !apollo) {
        console.log(`[Adviser research] Apollo match rejected as implausible for ${prospect.name}: ${apolloMatch.name} at ${apolloMatch.company}`)
      }

      // ── Career signals and current firm ──
      const career = fcaBlock.functions ? deriveCareerSignals(fcaBlock.functions) : null
      const currentFrn = career?.current_frn || prospect.fca_frn || null
      const currentFirmName = career?.current_firm_name || prospect.fca_firm_name || prospect.company || null

      // ── Firm signals: use the batch's pre-fetched copy when it is for this firm ──
      let firmSignals: FCAFirmSignalsResult | null = null
      if (providedSignals && providedSignals.frn && providedSignals.frn === currentFrn) {
        firmSignals = providedSignals
      } else if (currentFrn && Date.now() - startedAt < 2500) {
        // Inline fallback only when the batch did not pre-fetch this firm.
        // Kept small so Claude always has at least 5 seconds.
        firmSignals = await getFirmSignals(currentFrn, { arSteps: 2, includePermissions: true }).catch(() => null)
      }

      const fcaData: AdviserFcaData = {
        candidate_source: fromApollo ? 'apollo' : 'fca_register',
        current_functions: fcaBlock.functions?.current || [],
        previous_functions: fcaBlock.functions?.previous || [],
        permissions: firmSignals?.permissions || [],
        tenure_months: career?.tenure_months ?? null,
        years_approved: career?.years_approved ?? null,
        first_approved: career?.first_approved ?? null,
        previous_firms: career?.previous_firms || [],
        moves_count: career?.moves_count || 0,
        firm_signals: firmSignals,
        disciplinary: fcaBlock.disciplinary.found,
        disciplinary_detail: fcaBlock.disciplinary.detail,
        workplaces: fcaBlock.profile?.workplaces || [],
        verified: !!fcaBlock.profile,
        match_note: fcaBlock.profile ? null : 'Not on register',
      }

      // Display firm: the AR trading name where the register records one.
      const workplaceFirm = fcaBlock.profile?.workplaces.find((w) => w.firm_name && w.firm_name !== currentFirmName)?.firm_name || null
      const displayFirm = prospect.company || workplaceFirm || currentFirmName
      const location = prospect.location || apollo?.location || fcaBlock.profile?.workplaces[0]?.location || null

      const linkedinSearchUrl = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(prospect.name + ' ' + (displayFirm || ''))}`
      const linkedinUrl = alreadyHasLinkedIn ? prospect.linkedin_url : (apollo?.linkedin_url || prospect.linkedin_url || linkedinSearchUrl)
      const email = prospect.email || apollo?.email || null
      const phone = prospect.phone || apollo?.phone || null
      const headline = prospect.headline || apollo?.headline || null
      // Saved role: LinkedIn title, else what the find step stored. Only the
      // LinkedIn title goes to the model as a role, so register functions and
      // placeholders never surface in outreach.
      const role = apollo?.title || prospect.role || 'Adviser'
      const linkedInTitle = apollo?.title || (!prospect.fca_irn ? prospect.role : null) || null

      const research = await researchAdviser(
        {
          name: prospect.name,
          firm: apollo?.company || displayFirm,
          firm_from_linkedin: !!apollo?.company || (!prospect.fca_irn && !!prospect.company),
          role: linkedInTitle,
          location_from_linkedin: !!apollo?.location || (!prospect.fca_irn && !!prospect.location),
          location,
          linkedin_url: linkedinUrl,
          headline,
          has_email: !!email,
          has_phone: !!phone,
          fca_status: fcaBlock.profile?.status || prospect.fca_status || null,
          fca: fcaData,
        },
        {
          principalName,
          recruitmentProfile,
          customInstructions: campaign.custom_instructions || null,
          // Finish inside the deadline, leaving room to save the result
          timeoutMs: Math.max(2500, RESEARCH_DEADLINE_MS - 300 - (Date.now() - startedAt)),
        }
      )
      return { research, fcaData, role, displayFirm, location, linkedinUrl, email, phone, headline, fcaBlock, currentFrn, currentFirmName, apollo }
    }
    const pending = work()
    pending.catch(() => {}) // if the deadline wins, a later failure is already handled
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      deadlineTimer = setTimeout(
        () => reject(new Error('This adviser took too long to research. Please try again.')),
        Math.max(RESEARCH_DEADLINE_MS - (Date.now() - startedAt), 0)
      )
    })
    const { research, fcaData, role, displayFirm, location, linkedinUrl, email, phone, headline, fcaBlock, currentFrn, currentFirmName, apollo } =
      await Promise.race([pending, deadline]).finally(() => clearTimeout(deadlineTimer))

    fcaData.summary = research.summary
    fcaData.key_signals = research.key_signals
    fcaData.talking_points = research.talking_points
    fcaData.risk_flags = research.risk_flags

    const { error: saveError } = await admin.from('prospects').update({
      role,
      company: displayFirm,
      location,
      linkedin_url: linkedinUrl,
      email,
      phone,
      headline,
      fca_irn: fcaBlock.profile?.irn || prospect.fca_irn || null,
      fca_frn: currentFrn,
      fca_firm_name: currentFirmName,
      fca_status: fcaBlock.profile?.status || prospect.fca_status || null,
      fca_data: fcaData,
      research_notes: research.research_notes,
      key_trigger: research.key_signals[0] || null,
      scores: research.scores,
      total_score: research.total_score,
      tier: research.tier,
      outreach: research.outreach,
      status: 'completed',
      error_message: null,
      updated_at: new Date().toISOString(),
    }).eq('id', prospect.id)
    if (saveError) throw new Error(`Could not save the research: ${saveError.message}`)

    console.log(`[Adviser research] ${prospect.name}: tier ${research.tier} (${research.total_score}) in ${Date.now() - startedAt}ms, register=${fcaData.verified}, apollo=${!!apollo}`)

    return NextResponse.json({
      results: [{
        id: prospect.id,
        status: 'completed',
        tier: research.tier,
        total_score: research.total_score,
        linkedin_url: linkedinUrl,
        email,
        apollo_match: !!apollo,
        register_match: fcaData.verified,
      }],
      completed: 1,
      failed: 0,
      timeTakenMs: Date.now() - startedAt,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Research failed'
    console.error(`[Adviser research] FAILED for ${prospect.name}:`, message)
    await admin.from('prospects').update({ status: 'failed', error_message: message }).eq('id', prospect.id)
    await refundRecruitmentResearch(gate)
    return NextResponse.json({
      results: [{ id: prospect.id, status: 'failed', error: message }],
      completed: 0,
      failed: 1,
    })
  }
}

interface RegisterBlock {
  profile: FCAIndividualProfile | null
  functions: FCAIndividualFunctions | null
  disciplinary: { found: boolean; detail: string | null }
}

// Firm-led candidates carry an IRN. Role-led candidates are matched by name
// at research time. No match is "Not on register", not an error.
async function lookupRegister(irn: string | null, name: string): Promise<RegisterBlock> {
  let resolvedIrn = irn
  if (!resolvedIrn) {
    try {
      const hits = await searchIndividuals(name)
      resolvedIrn = pickIndividualMatch(name, hits)?.irn || null
    } catch {
      resolvedIrn = null
    }
  }
  if (!resolvedIrn) return { profile: null, functions: null, disciplinary: { found: false, detail: null } }

  const [profile, functions, disciplinary] = await Promise.all([
    getIndividualProfile(resolvedIrn).catch(() => null),
    getIndividualFunctions(resolvedIrn).catch(() => null),
    getIndividualDisciplinary(resolvedIrn).catch(() => ({ found: false, detail: null })),
  ])
  return { profile, functions, disciplinary }
}
