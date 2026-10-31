import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { writeHeyReachMessages } from '@/lib/ai-engine'
import { canonicalProfileUrl } from '@/lib/linkedin'
import {
  requireHeyReachSender,
  loadTestProspect,
  mergedServiceProfile,
  exclusionFor,
  exclusionMessage,
  saveHeyReachIf,
} from '@/lib/heyreach-route'
import { splitName, type HeyReachState } from '@/lib/heyreach-shared'

// v77: writes the HeyReach sequence for one researched prospect, in two
// requests: part 1 = msg_1 and msg_2, part 2 = msg_3 and msg_4. Each stays
// well inside Netlify's 10 second limit.

const Schema = z.object({
  campaign_id: z.string().uuid(),
  prospect_id: z.string().uuid(),
  part: z.union([z.literal(1), z.literal(2)]),
})

const DEADLINE_MS = 9000
const SAVE_RESERVE_MS = 800

export async function POST(req: NextRequest) {
  const startedAt = Date.now()
  const auth = await requireHeyReachSender()
  if (auth.response) return auth.response

  const parsed = Schema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input' }, { status: 400 })
  const { campaign_id, prospect_id, part } = parsed.data

  const loaded = await loadTestProspect(auth.supabase, auth.user.id, campaign_id, prospect_id)
  if (loaded.response) return loaded.response
  const { prospect, campaign, profile } = loaded

  if (prospect.status !== 'completed') {
    return NextResponse.json({ error: 'Research this prospect first.' }, { status: 409 })
  }
  const profileUrl = canonicalProfileUrl(prospect.linkedin_url)
  if (!profileUrl) {
    return NextResponse.json({ error: 'No exact LinkedIn profile for this prospect, so HeyReach cannot use them.' }, { status: 409 })
  }
  const state: HeyReachState = prospect.heyreach || {}
  // Messages are only (re)written for a new, draft or rejected person.
  if (state.status && state.status !== 'draft' && state.status !== 'rejected') {
    return NextResponse.json({ error: 'Reopen this person before rewriting the messages.' }, { status: 409 })
  }
  try {
    const excluded = await exclusionFor(auth.user.id, profileUrl)
    if (excluded) return NextResponse.json({ error: exclusionMessage(excluded), excluded }, { status: 409 })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Exclusion check failed' }, { status: 503 })
  }
  if (part === 2 && !(state.msgs?.msg_1 && state.msgs?.msg_2)) {
    return NextResponse.json({ error: 'Write msg_1 and msg_2 first.' }, { status: 409 })
  }

  const names = splitName(prospect.name)
  const firstName = state.first_name || names.first
  const lastName = state.last_name || names.last

  try {
    const work = writeHeyReachMessages(
      {
        name: prospect.name,
        first_name: firstName,
        role: prospect.role || undefined,
        company: prospect.company || undefined,
        location: prospect.location || undefined,
      },
      { research_notes: prospect.research_notes, key_trigger: prospect.key_trigger },
      {
        niche: campaign.niche || profile?.niche || 'Wealth management',
        senderName: campaign.sender_name || profile?.sender_name || 'Financial Advisor',
        serviceProfile: mergedServiceProfile(campaign, profile),
        customInstructions: campaign.custom_instructions || null,
      },
      part,
      part === 2 ? { msg_1: state.msgs?.msg_1, msg_2: state.msgs?.msg_2 } : null,
      { timeoutMs: DEADLINE_MS - (Date.now() - startedAt) - SAVE_RESERVE_MS }
    )
    work.catch(() => {})
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Writing the messages took too long. Please try again.')), Math.max(DEADLINE_MS - (Date.now() - startedAt), 0))
    })
    const written = await Promise.race([work, deadline]).finally(() => clearTimeout(timer))

    const next: HeyReachState = {
      first_name: firstName,
      last_name: lastName,
      profile_url: profileUrl,
      // Part 1 starts a fresh sequence; part 2 adds to it.
      msgs: part === 1 ? { ...written } : { ...state.msgs, ...written },
      status: 'draft',
    }
    // Only if nobody approved or pushed this person while Claude was writing.
    const saved = await saveHeyReachIf(prospect.id, auth.user.id, [state.status || null], next)
    if (!saved) {
      return NextResponse.json({ ok: false, error: 'This person changed while the messages were being written. Reload the page.' }, { status: 409 })
    }
    console.log(`[HeyReach] Part ${part} for ${prospect.name} done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
    return NextResponse.json({ ok: true, heyreach: next })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Writing the messages failed'
    console.error(`[HeyReach] Part ${part} FAILED for ${prospect.name} at ${((Date.now() - startedAt) / 1000).toFixed(1)}s: ${message}`)
    return NextResponse.json({ ok: false, error: message }, { status: 502 })
  }
}
