import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server'
import { requireHeyReachAdmin } from '@/lib/heyreach-route'
import { heyReachKeyIsSet, listHeyReachCampaigns, type HeyReachCampaignSummary } from '@/lib/heyreach'

export const dynamic = 'force-dynamic'

// v78: admin only. Which HeyReach campaigns each user sees in their LinkedIn
// pipeline. Reads and writes heyreach_campaign_access with the service role
// (users can only read their own rows).

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } }

const PostSchema = z.object({
  action: z.enum(['assign', 'remove']),
  user_id: z.string().uuid(),
  heyreach_campaign_id: z.number().int().positive(),
})

async function listAll() {
  const admin = createAdminClient()
  const [accessRes, usersRes] = await Promise.all([
    admin.from('heyreach_campaign_access').select('user_id, heyreach_campaign_id, campaign_name, assigned_at').order('assigned_at', { ascending: false }),
    admin.from('profiles').select('id, email, full_name').order('email', { ascending: true }).limit(1000),
  ])
  if (accessRes.error) {
    const missing = /heyreach_campaign_access/.test(accessRes.error.message) && /does not exist|schema cache/i.test(accessRes.error.message)
    throw new Error(missing ? 'Run migration 010 (heyreach_campaign_access) in Supabase first.' : accessRes.error.message)
  }
  if (usersRes.error) throw new Error(usersRes.error.message)
  const users = (usersRes.data || []).map((u) => ({ id: u.id as string, email: u.email as string, name: (u.full_name as string | null) || null }))
  const byId = new Map(users.map((u) => [u.id, u]))
  const assignments = (accessRes.data || []).map((a) => ({
    user_id: a.user_id as string,
    email: byId.get(a.user_id as string)?.email || '(deleted user)',
    name: byId.get(a.user_id as string)?.name || null,
    heyreach_campaign_id: Number(a.heyreach_campaign_id),
    campaign_name: (a.campaign_name as string | null) || null,
    assigned_at: a.assigned_at as string,
  }))
  return { users, assignments }
}

export async function GET() {
  const auth = await requireHeyReachAdmin()
  if (auth.response) return auth.response
  try {
    const [{ users, assignments }, campaigns] = await Promise.all([
      listAll(),
      heyReachKeyIsSet() ? listHeyReachCampaigns(4000).catch(() => [] as HeyReachCampaignSummary[]) : Promise.resolve([] as HeyReachCampaignSummary[]),
    ])
    return NextResponse.json({ users, assignments, campaigns }, NO_STORE)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Could not load access' }, { status: 500, ...NO_STORE })
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireHeyReachAdmin()
  if (auth.response) return auth.response
  const parsed = PostSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input' }, { status: 400 })
  const { action, user_id, heyreach_campaign_id } = parsed.data
  const admin = createAdminClient()

  if (action === 'assign') {
    // Only a campaign that exists in the HeyReach workspace can be assigned.
    let campaigns: HeyReachCampaignSummary[]
    try {
      campaigns = await listHeyReachCampaigns(4000)
    } catch (err) {
      return NextResponse.json({ error: `Could not check HeyReach: ${err instanceof Error ? err.message : err}` }, { status: 502 })
    }
    const campaign = campaigns.find((c) => c.id === heyreach_campaign_id)
    if (!campaign) return NextResponse.json({ error: 'That campaign is not in HeyReach.' }, { status: 400 })
    const { data: profile } = await admin.from('profiles').select('id, email').eq('id', user_id).maybeSingle()
    if (!profile) return NextResponse.json({ error: 'That user does not exist.' }, { status: 400 })
    const { error } = await admin
      .from('heyreach_campaign_access')
      .upsert({ user_id, heyreach_campaign_id, campaign_name: campaign.name, assigned_at: new Date().toISOString() }, { onConflict: 'user_id,heyreach_campaign_id' })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    console.log(`[Access] ${auth.user.email} gave ${profile.email} the HeyReach campaign "${campaign.name}" (${campaign.id})`)
  } else {
    const { error } = await admin.from('heyreach_campaign_access').delete().eq('user_id', user_id).eq('heyreach_campaign_id', heyreach_campaign_id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    console.log(`[Access] ${auth.user.email} removed HeyReach campaign ${heyreach_campaign_id} from user ${user_id}`)
  }

  try {
    const { users, assignments } = await listAll()
    return NextResponse.json({ ok: true, users, assignments }, NO_STORE)
  } catch (err) {
    return NextResponse.json({ ok: true, error: err instanceof Error ? err.message : 'Saved, but could not reload' }, NO_STORE)
  }
}
