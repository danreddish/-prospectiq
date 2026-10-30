import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { linkedInProfileSlug } from '@/lib/linkedin'
import {
  requireHeyReachSender,
  loadTestProspect,
  exclusionFor,
  exclusionMessage,
  approvalHash,
  saveHeyReachIf,
} from '@/lib/heyreach-route'
import { HEYREACH_MESSAGE_FIELDS, pushProblems, type HeyReachState } from '@/lib/heyreach-shared'

// v77: Dan's review. Save edits, approve, reject or reopen one person.
//
// Rules:
// - Nothing reaches HeyReach unless approved here. Approval records a
//   fingerprint of the names, profile and messages; push refuses if any of
//   them changed since.
// - Any edit to an approved or failed person drops them back to draft, so a
//   change is never sent without a fresh approval.
// - Approval re-checks the Ulinc and already-sent lists on the server.

const Msgs = z.object(
  Object.fromEntries(HEYREACH_MESSAGE_FIELDS.map((f) => [f, z.string().max(8000).optional()])) as Record<
    (typeof HEYREACH_MESSAGE_FIELDS)[number],
    z.ZodOptional<z.ZodString>
  >
)

const Schema = z.object({
  campaign_id: z.string().uuid(),
  prospect_id: z.string().uuid(),
  action: z.enum(['save', 'approve', 'reject', 'reopen']),
  first_name: z.string().max(100).optional(),
  last_name: z.string().max(100).optional(),
  msgs: Msgs.optional(),
})

export async function POST(req: NextRequest) {
  const auth = await requireHeyReachSender()
  if (auth.response) return auth.response

  const parsed = Schema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input' }, { status: 400 })
  const { campaign_id, prospect_id, action, first_name, last_name, msgs } = parsed.data

  const loaded = await loadTestProspect(auth.supabase, auth.user.id, campaign_id, prospect_id)
  if (loaded.response) return loaded.response
  const { prospect } = loaded

  const state: HeyReachState = prospect.heyreach || {}
  if (!state.status) {
    return NextResponse.json({ error: 'Write the messages first.' }, { status: 409 })
  }
  if (state.status === 'pushed') {
    return NextResponse.json({ error: 'Already sent to HeyReach. It can no longer be changed here.' }, { status: 409 })
  }
  if (state.status === 'pushing') {
    return NextResponse.json({ error: 'A send to HeyReach is in progress or unconfirmed. Use Check HeyReach first.' }, { status: 409 })
  }
  if (action === 'approve' && state.status === 'approved') {
    return NextResponse.json({ error: 'Already approved. Reopen it to make changes.' }, { status: 409 })
  }

  // Edits are kept exactly as typed.
  const next: HeyReachState = { ...state, push_error: undefined }
  if (first_name !== undefined) next.first_name = first_name.trim()
  if (last_name !== undefined) next.last_name = last_name.trim()
  if (msgs) next.msgs = { ...state.msgs, ...Object.fromEntries(Object.entries(msgs).filter(([, v]) => v !== undefined)) }

  const clearApproval = () => {
    next.approved_at = undefined
    next.approved_hash = undefined
  }

  if (action === 'approve') {
    const problems = pushProblems(next)
    if (problems.length > 0) {
      return NextResponse.json({ error: `Can't approve yet. Missing: ${problems.join(', ')}.`, problems }, { status: 422 })
    }
    // The profile being approved must still be the prospect's profile.
    if (linkedInProfileSlug(next.profile_url) !== linkedInProfileSlug(prospect.linkedin_url)) {
      return NextResponse.json({ error: "This prospect's LinkedIn profile changed. Rewrite the messages before approving." }, { status: 409 })
    }
    try {
      const excluded = await exclusionFor(auth.user.id, next.profile_url)
      if (excluded) return NextResponse.json({ error: exclusionMessage(excluded), excluded }, { status: 409 })
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : 'Exclusion check failed' }, { status: 503 })
    }
    next.status = 'approved'
    next.approved_at = new Date().toISOString()
    next.approved_hash = approvalHash(next)
    next.rejected_at = undefined
  } else if (action === 'reject') {
    next.status = 'rejected'
    next.rejected_at = new Date().toISOString()
    clearApproval()
  } else if (action === 'reopen') {
    next.status = 'draft'
    next.rejected_at = undefined
    clearApproval()
  } else {
    // save: an edit to an approved or failed person needs a fresh approval.
    if (state.status === 'approved' || state.status === 'push_failed') {
      next.status = 'draft'
      clearApproval()
    }
  }

  // Only if the row is still in the status we read (not pushed meanwhile).
  const saved = await saveHeyReachIf(prospect.id, auth.user.id, [state.status], next)
  if (!saved) {
    return NextResponse.json({ error: 'This person changed in the meantime. Reload the page.' }, { status: 409 })
  }
  console.log(`[HeyReach] Review: ${action} ${prospect.name} -> ${next.status}`)
  return NextResponse.json({ ok: true, heyreach: next })
}
