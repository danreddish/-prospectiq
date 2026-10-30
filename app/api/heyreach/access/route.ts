import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server'
import { requireHeyReachAdmin } from '@/lib/heyreach-route'
import { campaignsAcrossWorkspaces, listWorkspaces, type WorkspaceCampaign } from '@/lib/heyreach-workspaces'

export const dynamic = 'force-dynamic'

// v78: admin only. Which HeyReach campaigns each user sees in their LinkedIn
// pipeline. Reads and writes heyreach_campaign_access with the service role
// (users can only read their own rows). v79: campaigns come from every
// HeyReach workspace, and each assignment records its workspace.

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } }

const PostSchema = z.object({
  action: z.enum(['assign', 'remove', 'set_send']),
  // v79: may the user send into it, or only see its pipeline (default: see only)
  can_send: z.boolean().optional(),
  user_id: z.string().uuid(),
  heyreach_campaign_id: z.number().int().positive(),
  // null or missing = the main workspace
  workspace_id: z.string().uuid().nullable().optional(),
})

async function listAll() {
  const admin = createAdminClient()
  const [accessRes, usersRes] = await Promise.all([
    admin.from('heyreach_campaign_access').select('user_id, heyreach_campaign_id, workspace_id, can_send, campaign_name, assigned_at').order('assigned_at', { ascending: false }),
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
    workspace_id: (a.workspace_id as string | null) || null,
    can_send: a.can_send === true,
    campaign_name: (a.campaign_name as string | null) || null,
    assigned_at: a.assigned_at as string,
  }))
  return { users, assignments }
}

export async function GET() {
  const auth = await requireHeyReachAdmin()
  if (auth.response) return auth.response
  try {
    const workspaces = await listWorkspaces()
    const [{ users, assignments }, { campaigns, errors }] = await Promise.all([listAll(), campaignsAcrossWorkspaces(workspaces, 4000)])
    const names = new Map(workspaces.map((w) => [w.id ?? 'main', w.name]))
    return NextResponse.json(
      {
        users,
        assignments: assignments.map((a) => ({ ...a, workspace_name: names.get(a.workspace_id ?? 'main') || 'Removed workspace' })),
        campaigns,
        campaignErrors: errors,
      },
      NO_STORE
    )
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
  const workspaceId = parsed.data.workspace_id ?? null
  const admin = createAdminClient()

  if (action === 'assign') {
    // Only a campaign that exists in that HeyReach workspace can be assigned.
    const workspace = (await listWorkspaces()).find((w) => w.id === workspaceId)
    if (!workspace) return NextResponse.json({ error: 'That HeyReach workspace is not set up in ProspectIQ.' }, { status: 400 })
    const { campaigns, errors } = await campaignsAcrossWorkspaces([workspace], 4000)
    if (errors.length) return NextResponse.json({ error: `Could not check HeyReach: ${errors[0].error}` }, { status: 502 })
    const campaign: WorkspaceCampaign | undefined = campaigns.find((c) => c.id === heyreach_campaign_id)
    if (!campaign) return NextResponse.json({ error: `That campaign is not in the "${workspace.name}" workspace.` }, { status: 400 })
    const { data: profile } = await admin.from('profiles').select('id, email').eq('id', user_id).maybeSingle()
    if (!profile) return NextResponse.json({ error: 'That user does not exist.' }, { status: 400 })
    const { error } = await admin
      .from('heyreach_campaign_access')
      .upsert(
        { user_id, heyreach_campaign_id, workspace_id: workspaceId, can_send: parsed.data.can_send === true, campaign_name: campaign.name, assigned_at: new Date().toISOString() },
        { onConflict: 'user_id,heyreach_campaign_id' }
      )
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    console.log(`[Access] ${auth.user.email} gave ${profile.email} the HeyReach campaign "${campaign.name}" (${campaign.id}) in "${workspace.name}"${parsed.data.can_send ? ', can send' : ', view only'}`)
  } else if (action === 'set_send') {
    const { error } = await admin
      .from('heyreach_campaign_access')
      .update({ can_send: parsed.data.can_send === true })
      .eq('user_id', user_id)
      .eq('heyreach_campaign_id', heyreach_campaign_id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    console.log(`[Access] ${auth.user.email} set sending ${parsed.data.can_send ? 'on' : 'off'} for user ${user_id}, campaign ${heyreach_campaign_id}`)
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
