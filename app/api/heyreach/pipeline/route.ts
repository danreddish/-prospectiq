import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isAdmin } from '@/lib/admin'
import { assignedCampaignIds, visibleCampaigns } from '@/lib/heyreach-access'
import { heyReachKeyIsSet, listHeyReachCampaigns, getCampaignLeads, getOverallStats, type HeyReachCampaignSummary } from '@/lib/heyreach'
import { HEYREACH_TEST_CAMPAIGN } from '@/lib/heyreach-shared'
import { companyChanged, funnelFrom, leadStage, STAGE_LABELS, type PipelineActivity, type PipelineStage } from '@/lib/heyreach-pipeline'
import { cleanPersonName } from '@/lib/names'
import { linkedInProfileSlug } from '@/lib/linkedin'

export const dynamic = 'force-dynamic'

// v78: the LinkedIn pipeline for one HeyReach campaign. Read only.
//   - funnel: where each lead has got to now (GetLeadsFromCampaign)
//   - activity: what HeyReach did in the last 7, 30 or 90 days (GetOverallStats)
//   - leads: each person's stage, matched to their ProspectIQ prospect when
//     ProspectIQ sent them
// Every signed-in user, limited to the HeyReach campaigns assigned to them
// (heyreach_campaign_access). There is one HeyReach key, Dan's: he runs the
// campaigns for clients. Admins see every campaign. Nobody else is told the
// names or numbers of a campaign they weren't given.

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } }
const PERIODS = [7, 30, 90]
const DEADLINE_MS = 8500

const STAGE_ORDER: PipelineStage[] = ['replied', 'messaged', 'accepted', 'request_sent', 'waiting', 'paused', 'already_connected', 'finished', 'removed']

interface ProspectMatch {
  prospectId: string
  name: string
  company: string | null
  campaignId: string
  campaignName: string | null
  tier: string | null
  score: number | null
}

async function prospectMatches(supabase: ReturnType<typeof createClient>, userId: string): Promise<Map<string, ProspectMatch>> {
  const { data, error } = await supabase
    .from('prospects')
    .select('id, name, company, campaign_id, total_score, tier, linkedin_url, heyreach')
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
    const hrNames = r.heyreach as { first_name?: string; last_name?: string } | null
    map.set(slug, {
      prospectId: r.id as string,
      name: [hrNames?.first_name, hrNames?.last_name].filter(Boolean).join(' ') || cleanPersonName(r.name as string),
      company: (r.company as string | null) || null,
      campaignId: r.campaign_id as string,
      campaignName: names.get(r.campaign_id as string) || null,
      tier: (r.tier as string | null) || null,
      score: typeof r.total_score === 'number' ? r.total_score : null,
    })
  }
  return map
}

function pickCampaign(campaigns: HeyReachCampaignSummary[], wantedId: number | null, admin: boolean): HeyReachCampaignSummary | null {
  if (wantedId) {
    const found = campaigns.find((c) => c.id === wantedId)
    if (found) return found
  }
  return (
    (admin ? campaigns.find((c) => c.name.trim().toLowerCase() === HEYREACH_TEST_CAMPAIGN.toLowerCase()) : undefined) ||
    campaigns.find((c) => c.status !== 'DRAFT') ||
    campaigns[0] ||
    null
  )
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export async function GET(req: NextRequest) {
  const startedAt = Date.now()
  const deadline = startedAt + DEADLINE_MS
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, ...NO_STORE })
  const admin = isAdmin(user.email)
  // Raw HeyReach errors are for the admin. Everyone else gets a plain line.
  const say = (detail: string) => (admin ? detail : 'Could not load your LinkedIn pipeline just now. Try again in a minute.')

  const allowed = admin ? null : await assignedCampaignIds(supabase, user.id)
  if (allowed && allowed.length === 0) {
    return NextResponse.json({ admin, notSetUp: true, campaigns: [], campaign: null }, NO_STORE)
  }
  if (!heyReachKeyIsSet()) {
    return NextResponse.json({ admin, problem: say('HEYREACH_API_KEY is not set in Netlify.') }, NO_STORE)
  }

  const params = new URL(req.url).searchParams
  const daysParam = Number(params.get('days'))
  const days = PERIODS.includes(daysParam) ? daysParam : 30
  const wantedId = Number(params.get('campaign_id')) || null

  let campaigns: HeyReachCampaignSummary[]
  try {
    campaigns = await listHeyReachCampaigns(3500)
  } catch (err) {
    return NextResponse.json({ admin, problem: say(`Could not reach HeyReach: ${errorText(err)}`) }, { status: 502, ...NO_STORE })
  }
  // A user only ever sees the campaigns assigned to them, enforced here.
  campaigns = visibleCampaigns(campaigns, allowed)
  const campaign = pickCampaign(campaigns, wantedId, admin)
  if (!campaign) {
    return NextResponse.json(
      admin
        ? { admin, campaigns, campaign: null, days, problem: 'There are no campaigns in HeyReach yet.' }
        : { admin, notSetUp: true, campaigns: [], campaign: null },
      NO_STORE
    )
  }

  const end = new Date()
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000)
  const [leadsRes, statsRes, matchRes] = await Promise.allSettled([
    getCampaignLeads(campaign.id, { deadline: deadline - 300 }),
    getOverallStats([campaign.id], start, end, Math.max(1500, Math.min(4500, deadline - Date.now() - 500))),
    prospectMatches(supabase, user.id),
  ])

  const matches = matchRes.status === 'fulfilled' ? matchRes.value : new Map<string, ProspectMatch>()
  const leadsError = leadsRes.status === 'rejected' ? say(errorText(leadsRes.reason)) : null
  const activity: PipelineActivity | null = statsRes.status === 'fulfilled' ? statsRes.value : null
  const activityError = statsRes.status === 'rejected' ? say(errorText(statsRes.reason)) : null

  const rawLeads = leadsRes.status === 'fulfilled' ? leadsRes.value.leads : []
  const leads = rawLeads
    .map((l) => {
      const stage = leadStage(l)
      const slug = linkedInProfileSlug(l.profileUrl)
      const match = (slug && matches.get(slug)) || null
      return {
        ...l,
        // HeyReach takes names from LinkedIn, credentials and all ("Rob MCSI)").
        // The name ProspectIQ sent is cleaner.
        name: match?.name || cleanPersonName(l.name) || l.name,
        stage,
        stageLabel: STAGE_LABELS[stage],
        prospectiq: match,
        companyChangedFrom: match && companyChanged(match.company, l.company) ? match.company : null,
      }
    })
    .sort((a, b) => {
      const byStage = STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage)
      if (byStage) return byStage
      return (b.lastActionTime || b.creationTime || '').localeCompare(a.lastActionTime || a.creationTime || '')
    })

  const funnel = funnelFrom(rawLeads)
  console.log(
    `[Pipeline] ${admin ? 'admin' : user.id} ${campaign.name} (${campaign.id}, ${campaign.status}): ${funnel.inCampaign} leads, ${funnel.requestsSent} requests, ${funnel.accepted} accepted, ${funnel.messaged} messaged, ${funnel.replied} replied${leadsRes.status === 'rejected' ? `; leads failed: ${errorText(leadsRes.reason)}` : ''}${statsRes.status === 'rejected' ? `; stats failed: ${errorText(statsRes.reason)}` : ''}. ${Date.now() - startedAt}ms`
  )

  return NextResponse.json(
    {
      admin,
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
