import { NextRequest, NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { writeOutreachSequence } from '@/lib/ai-engine'
import { z } from 'zod'

// v76.2: the second half of research. /api/prospects/research scores the
// prospect and saves it; this writes the LINK Method sequence for it. Splitting
// the two keeps each request well inside Netlify's 10 second limit.
//
// No research credit is used here: the credit was taken by the research
// request. To stop this becoming a free, repeatable Claude call, it only
// writes outreach for a completed prospect that has none yet.

const Schema = z.object({
  campaign_id: z.string().uuid(),
  prospect_id: z.string().uuid(),
})

const OUTREACH_DEADLINE_MS = 9000
const SAVE_RESERVE_MS = 800

function stepLog(startedAt: number, step: string, stepStartedAt: number, detail?: string) {
  const now = Date.now()
  console.log(
    `[Outreach] ${step}: ${now - stepStartedAt}ms (at ${((now - startedAt) / 1000).toFixed(1)}s)${detail ? `. ${detail}` : ''}`
  )
}

function hasOutreach(outreach: unknown): boolean {
  if (!outreach || typeof outreach !== 'object') return false
  const o = outreach as Record<string, { message?: string } | undefined>
  return !!(o.step1?.message || o.step2?.message || o.step3?.message)
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now()
  const supabase = createClient()
  const admin = createAdminClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const parsed = Schema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input' }, { status: 400 })
  }
  const { campaign_id, prospect_id } = parsed.data

  const setupStartedAt = Date.now()
  const [prospectRes, campaignRes, profileRes] = await Promise.all([
    supabase
      .from('prospects')
      .select('id, campaign_id, name, role, company, location, status, outreach, research_notes, key_trigger')
      .eq('id', prospect_id)
      .eq('user_id', user.id)
      .maybeSingle(),
    supabase
      .from('campaigns')
      .select('id, niche, sender_name, service_profile, custom_instructions')
      .eq('id', campaign_id)
      .eq('user_id', user.id)
      .maybeSingle(),
    supabase.from('profiles').select('niche, sender_name, service_profile').eq('id', user.id).single(),
  ])

  const prospect = prospectRes.data
  const campaign = campaignRes.data
  if (!prospect || !campaign || prospect.campaign_id !== campaign.id) {
    return NextResponse.json({ error: 'Prospect not found' }, { status: 404 })
  }
  if (prospect.status !== 'completed') {
    return NextResponse.json({ error: 'Research this prospect first.' }, { status: 409 })
  }
  if (hasOutreach(prospect.outreach)) {
    return NextResponse.json({ ok: true, already_written: true, outreach: prospect.outreach })
  }
  stepLog(startedAt, 'Signed in and prospect loaded', setupStartedAt, prospect.name)

  const profile = profileRes.data
  const accountSP = (profile?.service_profile || {}) as Record<string, string | null>
  const campaignSP = (campaign.service_profile || {}) as Record<string, string | null>
  const serviceProfile = {
    what_you_do: campaignSP.what_you_do || accountSP.what_you_do || null,
    who_you_help: campaignSP.who_you_help || accountSP.who_you_help || null,
    key_outcomes: campaignSP.key_outcomes || accountSP.key_outcomes || null,
    minimum_threshold: campaignSP.minimum_threshold || accountSP.minimum_threshold || null,
    geographic_focus: campaignSP.geographic_focus || accountSP.geographic_focus || null,
  }

  try {
    const work = writeOutreachSequence(
      {
        name: prospect.name,
        role: prospect.role || undefined,
        company: prospect.company || undefined,
        location: prospect.location || undefined,
      },
      { research_notes: prospect.research_notes, key_trigger: prospect.key_trigger },
      {
        niche: campaign.niche || profile?.niche || 'Wealth management',
        senderName: campaign.sender_name || profile?.sender_name || 'Financial Advisor',
        serviceProfile,
        customInstructions: campaign.custom_instructions || null,
      },
      { timeoutMs: OUTREACH_DEADLINE_MS - (Date.now() - startedAt) - SAVE_RESERVE_MS }
    )
    work.catch(() => {}) // if the deadline wins, a later failure is already handled
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      deadlineTimer = setTimeout(
        () => reject(new Error('Writing the outreach took too long. Please try again.')),
        Math.max(OUTREACH_DEADLINE_MS - (Date.now() - startedAt), 0)
      )
    })
    const outreach = await Promise.race([work, deadline]).finally(() => clearTimeout(deadlineTimer))

    const saveStartedAt = Date.now()
    const { error: saveError } = await admin
      .from('prospects')
      .update({ outreach })
      .eq('id', prospect.id)
      .eq('user_id', user.id)
    if (saveError) throw new Error(`Could not save the outreach: ${saveError.message}`)
    stepLog(startedAt, 'Saved', saveStartedAt, `Outreach finished in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)

    return NextResponse.json({ ok: true, outreach })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Outreach failed'
    console.error(`[Outreach] FAILED for ${prospect.name} at ${((Date.now() - startedAt) / 1000).toFixed(1)}s:`, message)
    // The research stays saved. The prospect page offers "Write outreach".
    return NextResponse.json({ ok: false, error: message }, { status: 502 })
  }
}
