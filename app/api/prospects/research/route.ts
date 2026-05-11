import { NextRequest, NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { researchProspect } from '@/lib/ai-engine'
import { enrichWithApollo } from '@/lib/data-sources/apollo'
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
    supabase.from('campaigns').select('id, niche, sender_name, prospect_count, service_profile').eq('id', campaign_id).eq('user_id', user.id).single(),
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

  const context = {
    niche: campaign.niche || profile?.niche || 'Wealth management',
    senderName: campaign.sender_name || profile?.sender_name || 'Financial Advisor',
    serviceProfile,
  }

  // Check if this prospect already exists as 'pending' (found but not yet researched)
  let prospectId: string
  const { data: existingPending } = await supabase
    .from('prospects')
    .select('id')
    .eq('campaign_id', campaign_id)
    .eq('name', input.name)
    .eq('status', 'pending')
    .limit(1)
    .single()

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
        status: 'processing',
      })
      .select('id')
      .single()

    if (insertError || !inserted) {
      return NextResponse.json({ error: 'Failed to create prospect' }, { status: 500 })
    }
    prospectId = inserted.id
  }

  // Research + Apollo enrichment in parallel
  try {
    // Split name for Apollo lookup
    const nameParts = input.name.split(' ')
    const firstName = nameParts[0] || ''
    const lastName = nameParts.slice(1).join(' ') || ''

    // Build fallback LinkedIn search URL
    const linkedinSearchUrl = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(input.name + ' ' + (input.company || ''))}`

    console.log(`[Research] Starting for: ${input.name} at ${input.company || 'unknown'}`)

    // Run Apollo enrichment and AI research simultaneously
    const [apolloResult, research] = await Promise.all([
      enrichWithApollo(firstName, lastName, input.company || '').catch((err) => {
        console.error('[Research] Apollo enrichment failed:', err)
        return null
      }),
      researchProspect(input, context),
    ])

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
