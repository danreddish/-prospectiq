import { NextRequest, NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { researchProspectScores, type ProspectFinancials } from '@/lib/ai-engine'
import { enrichWithApollo } from '@/lib/data-sources/apollo'
import { getCompanyFinancials, wealthCeilingFromAccounts, formatAccountsCategory } from '@/lib/data-sources/companies-house'
import { isAdmin, accessMessage, type AccessReason } from '@/lib/access'
import { normaliseLinkedInUrl, isLinkedInProfileUrl } from '@/lib/linkedin'
import { z } from 'zod'

const ResearchSchema = z.object({
  campaign_id: z.string().uuid(),
  prospects: z.array(
    z.object({
      name: z.string().min(1),
      role: z.string().optional(),
      company: z.string().optional(),
      location: z.string().optional(),
      linkedin_url: z.string().optional().or(z.literal('')),
      company_number: z.string().optional(),
    })
  ).min(1).max(1),
})

// v75.7: Netlify stops functions at 10 seconds. Give up a little before
// that, so a slow prospect is marked failed and its credit refunded,
// rather than the function being killed with the credit spent and the
// prospect stuck on 'processing'.
const RESEARCH_DEADLINE_MS = 9000

// v76.2: time kept back from the Claude call for saving the result.
const SAVE_RESERVE_MS = 800

// v76.2: the outreach sequence is no longer written here. This request finds
// the LinkedIn profile, reads Companies House and scores the prospect, then
// the browser calls /api/prospects/outreach for the messages. Every step logs
// how long it took, measured from the start of the request.
function stepLog(startedAt: number, step: string, stepStartedAt: number, detail?: string) {
  const now = Date.now()
  console.log(
    `[Research] ${step}: ${now - stepStartedAt}ms (at ${((now - startedAt) / 1000).toFixed(1)}s)${detail ? `. ${detail}` : ''}`
  )
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now()
  const supabase = createClient()
  const admin = createAdminClient()

  // Auth — single call
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  stepLog(startedAt, 'Signed in', startedAt)

  const body = await req.json()
  const parsed = ResearchSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input' }, { status: 400 })
  }

  const { campaign_id, prospects: prospectInputs } = parsed.data
  const input = prospectInputs[0]

  // Get campaign, profile and any pending row for this prospect in parallel.
  // The pending row is only used once the campaign is confirmed as the user's.
  const setupStartedAt = Date.now()
  const [campaignRes, profileRes, pendingRes] = await Promise.all([
    supabase.from('campaigns').select('id, niche, sender_name, prospect_count, service_profile, custom_instructions').eq('id', campaign_id).eq('user_id', user.id).single(),
    supabase.from('profiles').select('niche, sender_name, service_profile').eq('id', user.id).single(),
    // Check if this prospect already has a company_number stored from the find step
    // (so we don't lose it when re-running research on a pending prospect)
    supabase
      .from('prospects')
      .select('id, company_number, email, phone, headline')
      .eq('campaign_id', campaign_id)
      .eq('name', input.name)
      .eq('status', 'pending')
      .limit(1)
      .maybeSingle(),
  ])

  if (!campaignRes.data) {
    return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
  }

  const campaign = campaignRes.data
  const profile = profileRes.data

  // v75.7: reserve one research from the user's plan before spending any
  // Apollo or Claude credits. Admins are never blocked or counted.
  let creditReserved = false
  if (!isAdmin(user.email)) {
    const { data: credit, error: creditError } = await admin.rpc('consume_research_credit', { p_user_id: user.id })
    if (creditError || !credit) {
      console.error('[Research] Plan check failed:', creditError?.message)
      return NextResponse.json(
        { error: 'We could not check your plan just now. Please try again in a moment.', code: 'plan_check_failed' },
        { status: 503 }
      )
    }
    const c = credit as { ok: boolean; reason?: AccessReason; limit?: number; resets_at?: string | null }
    if (!c.ok) {
      const reason = c.reason || 'no_plan'
      const message = accessMessage(reason, { limit: c.limit, resetsAt: c.resets_at })
      return NextResponse.json({ error: message, code: reason }, { status: 402 })
    }
    creditReserved = true
  }
  const refundCredit = async () => {
    if (!creditReserved) return
    creditReserved = false
    const { error } = await admin.rpc('refund_research_credit', { p_user_id: user.id })
    if (error) console.error('[Research] Refund failed:', error.message)
  }

  // Merge service profile: campaign overrides account defaults
  const accountSP = (profile?.service_profile || {}) as Record<string, string | null>
  const campaignSP = (campaign.service_profile || {}) as Record<string, string | null>
  const serviceProfile = {
    what_you_do: campaignSP.what_you_do || accountSP.what_you_do || null,
    who_you_help: campaignSP.who_you_help || accountSP.who_you_help || null,
    key_outcomes: campaignSP.key_outcomes || accountSP.key_outcomes || null,
    minimum_threshold: campaignSP.minimum_threshold || accountSP.minimum_threshold || null,
    geographic_focus: campaignSP.geographic_focus || accountSP.geographic_focus || null,
  }

  let storedCompanyNumber: string | null = null
  const existingPending = pendingRes.data
  if (existingPending?.company_number) storedCompanyNumber = existingPending.company_number

  const effectiveCompanyNumber = input.company_number || storedCompanyNumber

  let prospectId: string
  if (existingPending) {
    // Update existing pending prospect to processing
    prospectId = existingPending.id
    await supabase.from('prospects').update({ status: 'processing' }).eq('id', prospectId)
  } else {
    // Insert new prospect as processing
    const { data: inserted, error: insertError } = await supabase
      .from('prospects')
      .insert({
        campaign_id,
        user_id: user.id,
        name: input.name,
        role: input.role || null,
        company: input.company || null,
        location: input.location || null,
        linkedin_url: input.linkedin_url || null,
        company_number: effectiveCompanyNumber,
        status: 'processing',
      })
      .select('id')
      .single()

    if (insertError || !inserted) {
      await refundCredit()
      return NextResponse.json({ error: 'Failed to create prospect' }, { status: 500 })
    }
    prospectId = inserted.id
  }
  stepLog(startedAt, 'Campaign, plan and prospect row ready', setupStartedAt)

  // Research + Apollo enrichment + CH financials in parallel
  try {
    // Split name for Apollo lookup
    const nameParts = input.name.split(' ')
    const firstName = nameParts[0] || ''
    const lastName = nameParts.slice(1).join(' ') || ''

    // Build fallback LinkedIn search URL
    const linkedinSearchUrl = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(input.name + ' ' + (input.company || ''))}`

    console.log(`[Research] Starting for: ${input.name} at ${input.company || 'unknown'}${effectiveCompanyNumber ? ` (CH ${effectiveCompanyNumber})` : ''}`)

    // v75.7: everything slow runs inside work(), raced against the deadline.
    const work = async () => {
      // Apollo doesn't feed the Claude call, so it runs alongside it. It has
      // its own 3.5 second budget (see enrichWithApollo).
      const apolloStartedAt = Date.now()
      const apolloPromise = enrichWithApollo(firstName, lastName, input.company || '')
        .then((r) => {
          stepLog(
            startedAt,
            'Apollo enrichment',
            apolloStartedAt,
            r ? (r.linkedin_url ? 'LinkedIn profile found' : 'person found, no LinkedIn profile') : 'no match'
          )
          return r
        })
        .catch((err) => {
          console.error('[Research] Apollo enrichment failed:', err)
          return null
        })

      // Companies House goes first: research uses it for the hard wealth caps.
      const chStartedAt = Date.now()
      const chFinancials = effectiveCompanyNumber
        ? await getCompanyFinancials(effectiveCompanyNumber).catch((err) => {
            console.error('[Research] CH financials failed:', err)
            return null
          })
        : null

      // Build the financials package for the AI engine
      let financialsForAi: ProspectFinancials | null = null
      if (chFinancials) {
        financialsForAi = {
          accountsCategory: chFinancials.accountsCategory,
          hasFiledAccounts: chFinancials.hasFiledAccounts,
          companyStatus: chFinancials.companyStatus,
          dateOfCreation: chFinancials.dateOfCreation,
          wealthCeiling: wealthCeilingFromAccounts(chFinancials.accountsCategory, chFinancials.companyStatus),
          formattedCategory: formatAccountsCategory(chFinancials.accountsCategory),
        }
      }
      stepLog(
        startedAt,
        'CH financials',
        chStartedAt,
        financialsForAi
          ? `${financialsForAi.formattedCategory}, ceiling: ${financialsForAi.wealthCeiling ?? 'none'}`
          : effectiveCompanyNumber ? 'no data' : 'no company number, skipped'
      )

      // The Claude call logs its own duration and token counts.
      const research = await researchProspectScores(
        input,
        {
          niche: campaign.niche || profile?.niche || 'Wealth management',
          senderName: campaign.sender_name || profile?.sender_name || 'Financial Advisor',
          serviceProfile,
          customInstructions: campaign.custom_instructions || null,
          financials: financialsForAi,
        },
        { timeoutMs: RESEARCH_DEADLINE_MS - (Date.now() - startedAt) - SAVE_RESERVE_MS }
      )

      const waitStartedAt = Date.now()
      const apolloResult = await apolloPromise
      const waited = Date.now() - waitStartedAt
      if (waited > 50) stepLog(startedAt, 'Waited for Apollo after Claude', waitStartedAt)

      return { apolloResult, chFinancials, research }
    }

    const pending = work()
    pending.catch(() => {}) // if the deadline wins, a later failure is already handled
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      deadlineTimer = setTimeout(
        () => reject(new Error('This prospect took too long to research. Please try again.')),
        Math.max(RESEARCH_DEADLINE_MS - (Date.now() - startedAt), 0)
      )
    })
    const { apolloResult, chFinancials, research } = await Promise.race([pending, deadline])
      .finally(() => clearTimeout(deadlineTimer))

    // Use Apollo LinkedIn URL if found, otherwise use search URL.
    // Always stored as https so older http rows do not reappear.
    // v77: a profile found at Find (Apollo, by ID) is exact; Apollo's match
    // here is by name and company, so it can be a namesake. Keep the exact one.
    const inputProfile = isLinkedInProfileUrl(input.linkedin_url) ? input.linkedin_url : null
    const linkedinUrl = normaliseLinkedInUrl(
      inputProfile || apolloResult?.linkedin_url || input.linkedin_url || linkedinSearchUrl
    )
    // v77: if we kept the Find profile and Apollo's name match is a different
    // profile, its email, phone and headline belong to someone else. Don't
    // use them. Either way, never wipe details Find already saved.
    const apolloIsSomeoneElse = !!(
      inputProfile &&
      apolloResult?.linkedin_url &&
      normaliseLinkedInUrl(apolloResult.linkedin_url) !== normaliseLinkedInUrl(inputProfile)
    )
    const trusted = apolloIsSomeoneElse ? null : apolloResult
    const apolloEmail = trusted?.email || existingPending?.email || null
    const apolloPhone = trusted?.phone || existingPending?.phone || null
    const apolloHeadline = trusted?.headline || existingPending?.headline || null

    // Backfill only what the source left blank. Never overwrite verified
    // Companies House / FCA location, company or role with Apollo's guess.
    const finalLocation = (input.location && input.location.trim())
      ? input.location
      : (trusted?.location || null)
    const finalCompany = (input.company && input.company.trim())
      ? input.company
      : (trusted?.company || null)
    const apolloMatched = !!apolloResult?.linkedin_url
    if (apolloIsSomeoneElse) {
      console.log(`[Research] Kept the profile from Find for ${input.name}; Apollo's name match was someone else, so its contact details were not used`)
    }

    if (apolloMatched) {
      console.log(`[Research] Apollo matched a LinkedIn profile for ${input.name}`)
    } else if (apolloResult) {
      console.log(`[Research] Apollo returned contact data but no profile URL for ${input.name}`)
    } else {
      console.log(`[Research] No Apollo match for ${input.name}; using LinkedIn search fallback`)
    }

    // Save results. Outreach is written by /api/prospects/outreach next.
    const saveStartedAt = Date.now()
    await admin
      .from('prospects')
      .update({
        linkedin_url: linkedinUrl,
        email: apolloEmail,
        phone: apolloPhone,
        headline: apolloHeadline,
        location: finalLocation,
        company: finalCompany,
        company_number: effectiveCompanyNumber,
        accounts_category: chFinancials?.accountsCategory || null,
        accounts_last_filed: chFinancials?.lastAccountsMadeUpTo || null,
        research_notes: research.research_notes,
        wealth_estimate: research.wealth_estimate,
        est_age: research.est_age,
        yrs_at_sr_level: research.yrs_at_sr_level,
        key_trigger: research.key_trigger,
        scores: research.scores,
        total_score: research.total_score,
        tier: research.tier,
        outreach: {},
        status: 'completed',
      })
      .eq('id', prospectId)
    stepLog(startedAt, 'Saved', saveStartedAt, `Research finished in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)

    return NextResponse.json({
      results: [{
        id: prospectId,
        status: 'completed',
        tier: research.tier,
        linkedin_url: linkedinUrl,
        email: apolloEmail,
        apollo_match: apolloMatched,
        accounts_category: chFinancials?.accountsCategory || null,
        outreach_pending: true,
      }],
      completed: 1,
      failed: 0,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Research failed'
    console.error(`[Research] FAILED for ${input.name} at ${((Date.now() - startedAt) / 1000).toFixed(1)}s:`, message)
    if (error instanceof Error && error.stack) {
      console.error('[Research] Stack:', error.stack.slice(0, 500))
    }
    await admin
      .from('prospects')
      .update({ status: 'failed', error_message: message })
      .eq('id', prospectId)

    // v75.7: a failed research doesn't use up the user's allowance.
    await refundCredit()

    return NextResponse.json({
      results: [{ id: prospectId, status: 'failed', error: message }],
      completed: 0,
      failed: 1,
    })
  }
}
