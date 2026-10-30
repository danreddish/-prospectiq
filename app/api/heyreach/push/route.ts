import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server'
import { canonicalProfileUrl, linkedInProfileSlug } from '@/lib/linkedin'
import {
  requireHeyReachAdmin,
  loadTestProspect,
  exclusionFor,
  exclusionMessage,
  approvalHash,
  saveHeyReachIf,
} from '@/lib/heyreach-route'
import {
  heyReachKeyIsSet,
  findHeyReachCampaign,
  getHeyReachCampaign,
  campaignProblem,
  addLeadToHeyReach,
  getHeyReachLead,
  leadLookup,
  type HeyReachCampaign,
} from '@/lib/heyreach'
import {
  HEYREACH_TEST_CAMPAIGN,
  HEYREACH_MESSAGE_FIELDS,
  pushProblems,
  type HeyReachMessages,
  type HeyReachPushRecord,
  type HeyReachState,
} from '@/lib/heyreach-shared'

// v77: pushes ONE approved person into the live HeyReach campaign
// "ProspectIQ test", with msg_1 to msg_4 as custom variables.
//
// Adding a lead to a running campaign starts its sequence (the blank
// connection request goes out), so:
// - Only an approved person whose names, profile and messages still match
//   their approval fingerprint is pushed. The Ulinc and already-sent lists
//   are checked again here.
// - The person is claimed with an atomic status change (approved -> pushing),
//   so two requests can't both push them.
// - HeyReach's answer is saved the moment it arrives. The read-back comes
//   after, only if there's time.
// - If HeyReach doesn't answer in time (or answers with a server error), it
//   may still have taken the lead, so the person stays "pushing". After a
//   minute, "Check HeyReach" asks HeyReach whether it has them. If it does,
//   they're marked sent. If it clearly doesn't, they go back to approved and
//   nothing is added: sending again is a separate, deliberate click.

const Schema = z.object({
  campaign_id: z.string().uuid(),
  prospect_id: z.string().uuid(),
  // From the campaign check on the page. Saves looking the campaign up by name.
  heyreach_campaign_id: z.number().int().positive().optional(),
})

const DEADLINE_MS = 9000
const STUCK_AFTER_MS = 60_000

function trimBody(body: unknown): unknown {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? null)
  if (text.length <= 4000) return body
  return `${text.slice(0, 4000)}... (cut)`
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now()
  const left = () => DEADLINE_MS - (Date.now() - startedAt)
  const auth = await requireHeyReachAdmin()
  if (auth.response) return auth.response

  const parsed = Schema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input' }, { status: 400 })
  const { campaign_id, prospect_id, heyreach_campaign_id } = parsed.data

  const loaded = await loadTestProspect(auth.supabase, auth.user.id, campaign_id, prospect_id)
  if (loaded.response) return loaded.response
  const { prospect } = loaded
  const state: HeyReachState = prospect.heyreach || {}
  const userId = auth.user.id
  const reply = (status: number, body: Record<string, unknown>) => NextResponse.json(body, { status })

  if (state.status === 'pushed') return reply(200, { ok: true, already_pushed: true, heyreach: state })

  const stuck =
    state.status === 'pushing' &&
    (!state.pushing_at || Date.now() - new Date(state.pushing_at).getTime() > STUCK_AFTER_MS)
  if (state.status === 'pushing' && !stuck) {
    return reply(409, { error: 'Still sending this person. Wait a minute, then check again.', heyreach: state })
  }
  if (state.status !== 'approved' && !stuck) {
    return reply(409, { error: 'Approve this person before sending.', heyreach: state })
  }

  // ── Re-check everything on the server (not needed to look a stuck push up) ──
  const profileUrl = canonicalProfileUrl(state.profile_url)
  if (!profileUrl) return reply(422, { error: 'No exact LinkedIn profile URL.', heyreach: state })
  if (!stuck) {
    const problems = pushProblems(state)
    if (problems.length > 0) return reply(422, { error: `Not sent. Missing: ${problems.join(', ')}.`, heyreach: state })
    if (!state.approved_hash || state.approved_hash !== approvalHash(state)) {
      return reply(409, { error: 'The names or messages changed after approval. Approve again before sending.', heyreach: state })
    }
    if (linkedInProfileSlug(state.profile_url) !== linkedInProfileSlug(prospect.linkedin_url)) {
      return reply(409, { error: "This prospect's LinkedIn profile changed after approval. Rewrite and approve again.", heyreach: state })
    }
    try {
      const excluded = await exclusionFor(userId, profileUrl)
      if (excluded) return reply(409, { error: exclusionMessage(excluded), heyreach: state })
    } catch (err) {
      return reply(503, { error: err instanceof Error ? err.message : 'Exclusion check failed', heyreach: state })
    }
  }
  if (!heyReachKeyIsSet()) return reply(503, { error: 'HEYREACH_API_KEY is not set in Netlify yet.', heyreach: state })

  // ── Claim the person ──
  const pushing: HeyReachState = { ...state, status: 'pushing', pushing_at: new Date().toISOString(), push_error: undefined }
  // A normal claim must match the exact approved text (fingerprint).
  const claimed = stuck
    ? await saveHeyReachIf(prospect.id, userId, ['pushing'], pushing, new Date(Date.now() - STUCK_AFTER_MS).toISOString())
    : await saveHeyReachIf(prospect.id, userId, ['approved'], pushing, undefined, state.approved_hash)
  if (!claimed) return reply(409, { error: 'This person changed in the meantime. Reload the page.', heyreach: state })

  // Nothing has been sent yet: hand the person back as approved.
  const release = async (error: string, status: number) => {
    const back: HeyReachState = { ...state, status: stuck ? 'pushing' : 'approved', push_error: error }
    await saveHeyReachIf(prospect.id, userId, ['pushing'], back).catch(() => false)
    return reply(status, { error, heyreach: back })
  }

  // ── The campaign ──
  let campaign: HeyReachCampaign | null = null
  try {
    if (heyreach_campaign_id) {
      campaign = await getHeyReachCampaign(heyreach_campaign_id)
      if (campaign && campaign.name.trim().toLowerCase() !== HEYREACH_TEST_CAMPAIGN.toLowerCase()) {
        return await release(`HeyReach campaign ${heyreach_campaign_id} is "${campaign.name}", not "${HEYREACH_TEST_CAMPAIGN}".`, 409)
      }
    } else {
      campaign = await findHeyReachCampaign(HEYREACH_TEST_CAMPAIGN)
    }
  } catch (err) {
    return await release(err instanceof Error ? err.message : 'Could not reach HeyReach.', 502)
  }
  const problem = campaignProblem(campaign, HEYREACH_TEST_CAMPAIGN)
  if (problem || !campaign) return await release(problem || 'HeyReach campaign not found.', 409)
  const linkedInAccountId = campaign.accountIds[0]

  const finish = async (record: HeyReachPushRecord, accepted: boolean, error?: string) => {
    const next: HeyReachState = {
      ...pushing,
      status: accepted ? 'pushed' : 'push_failed',
      push: record,
      push_error: error,
    }
    const saved = await saveHeyReachIf(prospect.id, userId, ['pushing'], next).catch((e) => {
      console.error(`[HeyReach] Could not save the push result for ${prospect.name}: ${e instanceof Error ? e.message : e}`)
      return false
    })
    if (accepted) {
      // Never contact them again from ProspectIQ.
      const slug = linkedInProfileSlug(profileUrl)!
      const { error: exErr } = await createAdminClient()
        .from('linkedin_exclusions')
        .upsert({ user_id: userId, profile_slug: slug, source: 'heyreach', seen_at: new Date().toISOString() }, { onConflict: 'user_id,profile_slug,source' })
      if (exErr) console.error(`[HeyReach] Could not add ${slug} to exclusions: ${exErr.message}`)
    }
    return { next, saved }
  }

  const baseRecord = {
    heyreach_campaign_id: campaign.id,
    heyreach_campaign_name: campaign.name,
    heyreach_campaign_status: campaign.status,
    linkedin_account_id: linkedInAccountId,
  }

  // ── A stuck push: only ask HeyReach. Never add from here. ──
  if (stuck) {
    let lead
    try {
      lead = await getHeyReachLead(profileUrl, Math.min(3000, left() - 1000))
    } catch (err) {
      return reply(503, { error: `Could not check HeyReach: ${err instanceof Error ? err.message : err}. Try again in a moment.`, heyreach: pushing })
    }
    const found = leadLookup(lead)
    if (found === 'found') {
      // GetLead searches the whole HeyReach workspace, so this is noted as a
      // recovery: the read-back shows where HeyReach holds them.
      const { next } = await finish(
        { ...baseRecord, at: new Date().toISOString(), sent_lead: state.push?.sent_lead || {}, response: null, read_back: { status: lead.status, body: trimBody(lead.body) }, outcome: 'accepted', recovered: true },
        true
      )
      console.log(`[HeyReach] Stuck push for ${prospect.name}: HeyReach has the lead`)
      return reply(200, { ok: true, heyreach: next })
    }
    if (found === 'not_found') {
      const back: HeyReachState = { ...state, status: 'approved', pushing_at: undefined, push_error: "HeyReach doesn't have this person, so nothing was sent. Send again when you're ready." }
      await saveHeyReachIf(prospect.id, userId, ['pushing'], back).catch(() => false)
      console.log(`[HeyReach] Stuck push for ${prospect.name}: not in HeyReach, back to approved`)
      return reply(200, { ok: false, error: back.push_error, heyreach: back })
    }
    return reply(503, { error: `HeyReach gave an unclear answer (HTTP ${lead.status}). Try again in a moment.`, heyreach: pushing })
  }

  // ── Add the lead ──
  if (left() < 3500) return await release('Not enough time left in this request. Try again.', 503)
  const messages = Object.fromEntries(HEYREACH_MESSAGE_FIELDS.map((f) => [f, (state.msgs?.[f] || '').trim()])) as HeyReachMessages
  let result: Awaited<ReturnType<typeof addLeadToHeyReach>>
  try {
    result = await addLeadToHeyReach(
      campaign.id,
      linkedInAccountId,
      {
        firstName: state.first_name!.trim(),
        lastName: state.last_name!.trim(),
        profileUrl,
        companyName: prospect.company,
        position: prospect.role,
        location: prospect.location,
        messages,
      },
      Math.min(6000, left() - 1200)
    )
  } catch (err) {
    // HeyReach may have taken the lead before the connection dropped.
    const message = `HeyReach didn't answer in time (${err instanceof Error ? err.message : err}). It may have taken the lead. Wait a minute, then click Check HeyReach.`
    const unsure: HeyReachState = { ...pushing, push_error: message }
    await saveHeyReachIf(prospect.id, userId, ['pushing'], unsure).catch(() => false)
    console.error(`[HeyReach] Push for ${prospect.name} unclear: ${message}`)
    return reply(504, { error: message, heyreach: unsure })
  }

  // A HeyReach server error (5xx) doesn't tell us whether the lead was taken.
  if (result.reply.status >= 500) {
    const message = `HeyReach returned a server error (${result.reply.status}). It may have taken the lead. Wait a minute, then click Check HeyReach.`
    const unsure: HeyReachState = { ...pushing, push_error: message }
    await saveHeyReachIf(prospect.id, userId, ['pushing'], unsure).catch(() => false)
    console.error(`[HeyReach] Push for ${prospect.name} unclear: ${message}`)
    return reply(504, { error: message, heyreach: unsure })
  }

  const accepted = result.reply.ok && result.added + result.updated >= 1 && result.failed === 0
  const record: HeyReachPushRecord = {
    ...baseRecord,
    at: new Date().toISOString(),
    sent_lead: result.sentLead,
    response: {
      status: result.reply.status,
      ms: result.reply.ms,
      added: result.added,
      updated: result.updated,
      failed: result.failed,
      body: trimBody(result.reply.body),
    },
    read_back: null,
    outcome: accepted ? 'accepted' : 'rejected',
  }
  const error = accepted
    ? undefined
    : `HeyReach returned ${result.reply.status}: added ${result.added}, updated ${result.updated}, failed ${result.failed}.`
  let { next } = await finish(record, accepted, error)
  console.log(
    `[HeyReach] Push ${prospect.name}: ${record.outcome} (HTTP ${result.reply.status}, added ${result.added}, updated ${result.updated}, failed ${result.failed}) at ${((Date.now() - startedAt) / 1000).toFixed(1)}s`
  )

  // ── Read the lead back, if there's time ──
  if (result.reply.ok) {
    let readBack: HeyReachPushRecord['read_back']
    if (left() > 2500) {
      try {
        const lead = await getHeyReachLead(profileUrl, Math.min(3000, left() - 1000))
        readBack = { status: lead.status, body: trimBody(lead.body) }
      } catch (err) {
        readBack = { error: err instanceof Error ? err.message : 'read-back failed' }
      }
    } else {
      readBack = { skipped: 'not enough time left in this request' }
    }
    const withReadBack: HeyReachState = { ...next, push: { ...record, read_back: readBack } }
    const saved = await saveHeyReachIf(prospect.id, userId, [next.status!], withReadBack).catch(() => false)
    if (saved) next = withReadBack
  }

  return reply(accepted ? 200 : 502, { ok: accepted, error, heyreach: next })
}
