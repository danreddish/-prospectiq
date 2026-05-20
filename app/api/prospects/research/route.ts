import { NextRequest, NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { researchProspect, type ProspectFinancials } from '@/lib/ai-engine'
import { enrichWithApollo } from '@/lib/data-sources/apollo'
import { getCompanyFinancials, wealthCeilingFromAccounts, formatAccountsCategory } from '@/lib/data-sources/companies-house'
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

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const admin = createAdminClient()

  // Auth — single call
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const parsed = ResearchSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input' }, { status: 400 })
  }

  const { campaign_id, prospects: prospectInputs } = parsed.data
  const input = prospectInputs[0]

  // Get campaign + profile in parallel (saves ~300ms)
  const [campaignRes, profileRes] = await Promise.all([
    supabase.from('campaigns').select('id, niche, sender_name, prospect_count, service_profile, custom_instructions').eq('id', campaign_id).eq('user_id', user.id).single(),
    supabase.from('profiles').select('niche, sender_name, service_profile').eq('id', user.id).single(),
  ])

  if (!campaignRes.data) {
    return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
  }

  const campaign = campaignRes.data
  const profile = profileRes.data

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

  // Check if this prospect already has a company_number stored from the find step
  // (so we don't lose it when re-running research on a pending prospect)
  let storedCompanyNumber: string | null = null
  const { data: existingPending } = await supabase
    .from('prospects')
    .select('id, company_number')
    .eq('campaign_id', campaign_id)
    .eq('name', input.name)
    .eq('status', 'pending')
    .limit(1)
    .single()

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
      return NextResponse.json({ error: 'Failed to create prospect' }, { status: 500 })
    }
    prospectId = inserted.id
  }

  // Research + Apollo enrichment + CH financials in parallel
  try {
    // Split name for Apollo lookup
    const nameParts = input.name.split(' ')
    const firstName = nameParts[0] || ''
    const lastName = nameParts.slice(1).join(' ') || ''

    // Build fallback LinkedIn search URL
    const linkedinSearchUrl = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(input.name + ' ' + (input.company || ''))}`

    console.log(`[Research] Starting for: ${input.name} at ${input.company || 'unknown'}${effectiveCompanyNumber ? ` (CH ${effectiveCompanyNumber})` : ''}`)

    // Pull Apollo enrichment and CH financials in parallel BEFORE research,
    // so research can use the financial data to apply hard scoring caps.
    const [apolloResult, chFinancials] = await Promise.all([
      enrichWithApollo(firstName, lastName, input.company || '').catch((err) => {
        console.error('[Research] Apollo enrichment failed:', err)
        return null
      }),
      effectiveCompanyNumber
        ? getCompanyFinancials(effectiveCompanyNumber).catch((err) => {
            console.error('[Research] CH financials failed:', err)
            return null
          })
        : Promise.resolve(null),
    ])

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
      console.log(`[Research] CH financials: ${financialsForAi.formattedCategory}, ceiling: ${financialsForAi.wealthCeiling ?? 'none'}`)
    }

    const research = await researchProspect(input, {
      niche: campaign.niche || profile?.niche || 'Wealth management',
      senderName: campaign.sender_name || profile?.sender_name || 'Financial Advisor',
      serviceProfile,
      customInstructions: campaign.custom_instructions || null,
      financials: financialsForAi,
    })

    // Use Apollo LinkedIn URL if found, otherwise use search URL
    const linkedinUrl = apolloResult?.linkedin_url || input.linkedin_url || linkedinSearchUrl
    const apolloEmail = apolloResult?.email || null
    const apolloPhone = apolloResult?.phone || null
    const apolloHeadline = apolloResult?.headline || null

    // Save results
    await admin
      .from('prospects')
      .update({
        linkedin_url: linkedinUrl,
        email: apolloEmail,
        phone: apolloPhone,
        headline: apolloHeadline,
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
        outreach: research.outreach,
        status: 'completed',
      })
      .eq('id', prospectId)

    return NextResponse.json({
      results: [{
        id: prospectId,
        status: 'completed',
        tier: research.tier,
        linkedin_url: linkedinUrl,
        email: apolloEmail,
        apollo_match: !!apolloResult?.linkedin_url,
        accounts_category: chFinancials?.accountsCategory || null,
      }],
      completed: 1,
      failed: 0,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Research failed'
    console.error(`[Research] FAILED for ${input.name}:`, message)
    if (error instanceof Error && error.stack) {
      console.error('[Research] Stack:', error.stack.slice(0, 500))
    }
    await admin
      .from('prospects')
      .update({ status: 'failed', error_message: message })
      .eq('id', prospectId)

    return NextResponse.json({
      results: [{ id: prospectId, status: 'failed', error: message }],
      completed: 0,
      failed: 1,
    })
  }
}
