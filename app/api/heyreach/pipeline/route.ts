import { NextRequest, NextResponse } from 'next/server'
import { requireHeyReachAdmin } from '@/lib/heyreach-route'
import { heyReachKeyIsSet, listHeyReachCampaigns, getCampaignLeads, getOverallStats, type HeyReachCampaignSummary } from '@/lib/heyreach'
import { HEYREACH_TEST_CAMPAIGN } from '@/lib/heyreach-shared'
import { funnelFrom, leadStage, STAGE_LABELS, type PipelineActivity, type PipelineStage } from '@/lib/heyreach-pipeline'
import { linkedInProfileSlug } from '@/lib/linkedin'
import type { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

// v78: the LinkedIn pipeline for one HeyReach campaign. Read only.
//   - funnel: where each lead has got to now (GetLeadsFromCampaign)
//   - activity: what HeyReach did in the last 7, 30 or 90 days (GetOverallStats)
//   - leads: each person's stage, matched to their ProspectIQ prospect when
//     ProspectIQ sent them
// Admin only, like the rest of the HeyReach work: there is one HeyReach key,
// and it is Dan's account.

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } }
const PERIODS = [7, 30, 90]
const DEADLINE_MS = 8500

const STAGE_ORDER: PipelineStage[] = ['replied', 'messaged', 'accepted', 'request_sent', 'waiting', 'paused', 'finished', 'removed']

interface ProspectMatch {
  prospectId: string
  campaignId: string
  campaignName: string | null
  tier: string | null
  score: number | null
}

async function prospectMatches(supabase: ReturnType<typeof createClient>, userId: string): Promise<Map<string, ProspectMatch>> {
  const { data, error } = await supabase
    .from('prospects')
    .select('id, campaign_id, total_score, tier, linkedin_url, heyreach')
    .eq('user_id', userId)
    .not('heyreach', 'is', null)
    .limit(2000)
  if (error) throw new Error(error.message)
  const rows = data || []
  const campaignIds = Array.from(new Set(rows.map((r) => r.campaign_id as string)))
  const names = new Map<string, string>()
  if (campaignIds.length) {
    const { data: campaigns } = await supabase.from('campaigns').select('id, name').in('id', campaignIds)
    for (const c of campaigns || []) names.set(c.id as string, c.name as string)
  }
  const map = new Map<string, ProspectMatch>()
  for (const r of rows) {
    const hr = (r.heyreach || {}) as { profile_url?: string }
    const slug = linkedInProfileSlug(hr.profile_url || (r.linkedin_url as string | null))
    if (!slug) continue
    map.set(slug, {
      prospectId: r.id as string,
      campaignId: r.campaign_id as string,
      campaignName: names.get(r.campaign_id as string) || null,
      tier: (r.tier as string | null) || null,
      score: typeof r.total_score === 'number' ? r.total_score : null,
    })
  }
  return map
}

function pickCampaign(campaigns: HeyReachCampaignSummary[], wantedId: number | null): HeyReachCampaignSummary | null {
  if (wantedId) {
    const found = campaigns.find((c) => c.id === wantedId)
    if (found) return found
  }
  return (
    campaigns.find((c) => c.name.trim().toLowerCase() === HEYREACH_TEST_CAMPAIGN.toLowerCase()) ||
    campaigns.find((c) => c.status !== 'DRAFT') ||
    campaigns[0] ||
    null
  )
}

export async function GET(req: NextRequest) {
  const startedAt = Date.now()
  const deadline = startedAt + DEADLINE_MS
  const auth = await requireHeyReachAdmin()
  if (auth.response) return auth.response

  if (!heyReachKeyIsSet()) {
    return NextResponse.json({ problem: 'HEYREACH_API_KEY is not set in Netlify.' }, NO_STORE)
  }

  const params = new URL(req.url).searchParams
  const daysParam = Number(params.get('days'))
  const days = PERIODS.includes(daysParam) ? daysParam : 30
  const wantedId = Number(params.get('campaign_id')) || null

  let campaigns: HeyReachCampaignSummary[]
  try {
    campaigns = await listHeyReachCampaigns(3500)
  } catch (err) {
    return NextResponse.json({ problem: `Could not reach HeyReach: ${err instanceof Error ? err.message : err}` }, { status: 502, ...NO_STORE })
  }
  const campaign = pickCampaign(campaigns, wantedId)
  if (!campaign) {
    return NextResponse.json({ campaigns, campaign: null, days, problem: 'There are no campaigns in HeyReach yet.' }, NO_STORE)
  }

  const end = new Date()
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000)
  const [leadsRes, statsRes, matchRes] = await Promise.allSettled([
    getCampaignLeads(campaign.id, { deadline: deadline - 300 }),
    getOverallStats([campaign.id], start, end, Math.max(1500, Math.min(4500, deadline - Date.now() - 500))),
    prospectMatches(auth.supabase, auth.user.id),
  ])

  const matches = matchRes.status === 'fulfilled' ? matchRes.value : new Map<string, ProspectMatch>()
  const leadsError = leadsRes.status === 'rejected' ? String(leadsRes.reason instanceof Error ? leadsRes.reason.message : leadsRes.reason) : null
  const activity: PipelineActivity | null = statsRes.status === 'fulfilled' ? statsRes.value : null
  const activityError = statsRes.status === 'rejected' ? String(statsRes.reason instanceof Error ? statsRes.reason.message : statsRes.reason) : null

  const rawLeads = leadsRes.status === 'fulfilled' ? leadsRes.value.leads : []
  const leads = rawLeads
    .map((l) => {
      const stage = leadStage(l)
      const slug = linkedInProfileSlug(l.profileUrl)
      return { ...l, stage, stageLabel: STAGE_LABELS[stage], prospectiq: (slug && matches.get(slug)) || null }
    })
    .sort((a, b) => {
      const byStage = STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage)
      if (byStage) return byStage
      return (b.lastActionTime || b.creationTime || '').localeCompare(a.lastActionTime || a.creationTime || '')
    })

  const funnel = funnelFrom(rawLeads)
  console.log(
    `[Pipeline] ${campaign.name} (${campaign.id}, ${campaign.status}): ${funnel.inCampaign} leads, ${funnel.requestsSent} requests, ${funnel.accepted} accepted, ${funnel.messaged} messaged, ${funnel.replied} replied${leadsError ? `; leads failed: ${leadsError}` : ''}${activityError ? `; stats failed: ${activityError}` : ''}. ${Date.now() - startedAt}ms`
  )

  return NextResponse.json(
    {
      campaigns,
      campaign,
      days,
      funnel: leadsError ? null : funnel,
      leads,
      totalLeads: leadsRes.status === 'fulfilled' ? leadsRes.value.totalCount : 0,
      truncated: leadsRes.status === 'fulfilled' ? leadsRes.value.truncated : false,
      leadsError,
      activity,
      activityError,
      fetchedAt: end.toISOString(),
    },
    NO_STORE
  )
}
