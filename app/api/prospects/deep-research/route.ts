import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { deepResearchEnabled, triggerDeepResearch } from '@/lib/deep-research/trigger'
import { DEEP_RESEARCH_STAGES, deepResearchCanStart, deepResearchInProgress, type DeepResearchState } from '@/lib/deep-research/state'

export const dynamic = 'force-dynamic'

// v81: deep research on people who are already researched. New prospects
// are handed to the background job by /api/prospects/outreach; this route is
// for the "Run deep research" buttons (people researched before v81, or a
// run that failed) and for the page to ask how the jobs are getting on.
//
// A person gets one finished deep research. It can only be started again
// after a failure, so this is not a free, repeatable Claude call.

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } }

const StartSchema = z.object({
  campaign_id: z.string().uuid(),
  // Five at a time keeps the request well inside Netlify's 10 seconds.
  prospect_ids: z.array(z.string().uuid()).min(1).max(5),
  // 'messages': write the outreach again from the saved findings, no new research.
  mode: z.enum(['research', 'messages']).optional(),
})

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, ...NO_STORE })
  if (!deepResearchEnabled()) {
    return NextResponse.json({ error: 'Deep research is switched off.' }, { status: 503, ...NO_STORE })
  }
  const parsed = StartSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input' }, { status: 400, ...NO_STORE })
  const { campaign_id, prospect_ids } = parsed.data
  const mode = parsed.data.mode || 'research'

  const { data: rows, error } = await supabase
    .from('prospects')
    .select('id, status, deep_research')
    .eq('campaign_id', campaign_id)
    .eq('user_id', user.id)
    .in('id', prospect_ids)
  if (error) return NextResponse.json({ error: 'Could not load those prospects.' }, { status: 500, ...NO_STORE })

  const admin = createAdminClient()
  const origin = req.nextUrl.origin
  const results = await Promise.all(
    (rows || []).map(async (row) => {
      const state = (row.deep_research || null) as DeepResearchState | null
      if (row.status !== 'completed') return { id: row.id, started: false, reason: 'Research this prospect first.' }
      if (mode === 'messages') {
        if (state?.status !== 'done' || !state.evidence) return { id: row.id, started: false, reason: 'Run deep research first.' }
        // Shows as running on the last step; the findings and evidence are kept.
        const rewriting: DeepResearchState = { ...state, status: 'running', started_at: new Date().toISOString(), stage: DEEP_RESEARCH_STAGES[2] }
        const { error: markError } = await admin.from('prospects').update({ deep_research: rewriting }).eq('id', row.id).eq('user_id', user.id)
        if (markError) return { id: row.id, started: false, reason: 'Could not start it.' }
        if (!(await triggerDeepResearch(origin, row.id, 'messages'))) {
          await admin.from('prospects').update({ deep_research: state }).eq('id', row.id)
          return { id: row.id, started: false, reason: 'Could not start it. Try again.' }
        }
        return { id: row.id, started: true }
      }
      if (!deepResearchCanStart(state)) {
        return { id: row.id, started: false, reason: state?.status === 'done' ? 'Already done.' : 'Already running.' }
      }
      const queued: DeepResearchState = { status: 'queued', queued_at: new Date().toISOString(), first_pass: state?.first_pass }
      const { error: queueError } = await admin.from('prospects').update({ deep_research: queued }).eq('id', row.id).eq('user_id', user.id)
      if (queueError) return { id: row.id, started: false, reason: 'Could not queue it.' }
      const ok = await triggerDeepResearch(origin, row.id)
      if (!ok) {
        await admin
          .from('prospects')
          .update({ deep_research: { status: 'failed', error: 'Deep research could not be started.', finished_at: new Date().toISOString(), first_pass: state?.first_pass } })
          .eq('id', row.id)
        return { id: row.id, started: false, reason: 'Could not start it. Try again.' }
      }
      return { id: row.id, started: true }
    })
  )
  return NextResponse.json({ ok: true, results, started: results.filter((r) => r.started).length }, NO_STORE)
}

/** How the jobs in a campaign are getting on. Light: no evidence, just states. */
export async function GET(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, ...NO_STORE })
  const campaignId = new URL(req.url).searchParams.get('campaign_id') || ''
  if (!/^[0-9a-f-]{36}$/i.test(campaignId)) return NextResponse.json({ error: 'Invalid input' }, { status: 400, ...NO_STORE })

  const { data, error } = await supabase
    .from('prospects')
    .select('id, status:deep_research->>status, queued_at:deep_research->>queued_at, started_at:deep_research->>started_at, stage:deep_research->>stage')
    .eq('campaign_id', campaignId)
    .eq('user_id', user.id)
    .not('deep_research', 'is', null)
  if (error) return NextResponse.json({ error: 'Could not load' }, { status: 500, ...NO_STORE })

  const states = (data || []).map((r) => {
    const row = r as unknown as { id: string; status: string; queued_at: string | null; started_at: string | null; stage: string | null }
    const inProgress = deepResearchInProgress({ status: row.status as DeepResearchState['status'], queued_at: row.queued_at || undefined, started_at: row.started_at || undefined })
    return { id: row.id, status: row.status, in_progress: inProgress, stage: inProgress ? row.stage || 'Waiting to start' : null }
  })
  return NextResponse.json({ ok: true, states, in_progress: states.filter((s) => s.in_progress).length }, NO_STORE)
}
