import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server'
import { requireHeyReachAdmin } from '@/lib/heyreach-route'
import {
  createHeyReachCampaign,
  createHeyReachLeadList,
  getHeyReachCampaign,
  getHeyReachCampaignSequence,
  heyReachError,
  listHeyReachCampaigns,
  listHeyReachSenders,
  startHeyReachCampaign,
} from '@/lib/heyreach'
import { campaignsAcrossWorkspaces, listWorkspaces, workspaceKey } from '@/lib/heyreach-workspaces'
import {
  CAMPAIGN_NAME_MAX,
  CLIENT_SCHEDULE,
  describeSequence,
  messageFieldsUsed,
  sequenceFromReply,
  standardSequence,
  type SequenceNode,
} from '@/lib/heyreach-sequence'
import { HEYREACH_MESSAGE_FIELDS } from '@/lib/heyreach-shared'

export const dynamic = 'force-dynamic'

// v80: admin only. "Set up a client" on /dashboard/heyreach. In a client's
// own HeyReach workspace it creates an empty lead list and a campaign that
// copies the sequence of a campaign Dan already built by hand (or the
// built-in one), on weekday London hours, sending from the client's LinkedIn,
// then starts it. The page then gives the client send access to it through
// /api/heyreach/access. Never in the main workspace: that sends from Dan's
// LinkedIn. Each step is its own request so each stays inside Netlify's 10
// second limit, and a retried step never makes a second campaign.

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } }

const Template = z.object({
  workspace_id: z.string().uuid().nullable(),
  campaign_id: z.number().int().positive(),
})

const PostSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('preview'), template: Template.nullable() }),
  z.object({
    action: z.literal('create'),
    workspace_id: z.string().uuid(),
    sender_id: z.number().int().positive(),
    name: z.string().trim().min(1).max(CAMPAIGN_NAME_MAX),
    template: Template.nullable(),
  }),
  z.object({ action: z.literal('start'), workspace_id: z.string().uuid(), campaign_id: z.number().int().positive() }),
])

// Started. A started campaign with nobody in it yet shows FINISHED, and the
// first person sent restarts it.
const STARTED = new Set(['ACTIVE', 'IN_PROGRESS', 'FINISHED'])

/** The sequence to use: a copy of the template campaign's, or the built-in one. */
async function loadSequence(template: z.infer<typeof Template> | null, timeoutMs: number): Promise<{ sequence: SequenceNode; source: string }> {
  if (!template) return { sequence: standardSequence(), source: 'built-in' }
  const workspace = (await listWorkspaces()).find((w) => w.id === template.workspace_id)
  if (!workspace) throw new Error("The template campaign's workspace isn't set up in ProspectIQ.")
  const key = await workspaceKey(workspace.id)
  const reply = await getHeyReachCampaignSequence(template.campaign_id, key, timeoutMs)
  if (!reply.ok) throw new Error(`HeyReach couldn't give that campaign's sequence: ${heyReachError(reply)}`)
  return { sequence: sequenceFromReply(reply.body), source: `${workspace.name} · campaign ${template.campaign_id}` }
}

function summary(sequence: SequenceNode) {
  const fieldsUsed = messageFieldsUsed(sequence)
  const missing = HEYREACH_MESSAGE_FIELDS.filter((f) => !fieldsUsed.includes(f))
  return {
    steps: describeSequence(sequence),
    fieldsUsed,
    warning: missing.length
      ? `This sequence doesn't use ${missing.join(', ')}, so ${missing.length === 1 ? 'that message' : 'those messages'} would never be sent.`
      : null,
  }
}

export async function GET(req: NextRequest) {
  const auth = await requireHeyReachAdmin()
  if (auth.response) return auth.response
  const workspaceId = new URL(req.url).searchParams.get('workspace_id')

  try {
    // One workspace: its LinkedIn senders and campaign names.
    if (workspaceId) {
      const workspace = (await listWorkspaces()).find((w) => w.id === workspaceId)
      if (!workspace || !workspace.id) return NextResponse.json({ error: 'Choose one of your client workspaces.' }, { status: 400, ...NO_STORE })
      const key = await workspaceKey(workspace.id)
      const [senders, campaigns] = await Promise.all([listHeyReachSenders(key), listHeyReachCampaigns(4000, key)])
      return NextResponse.json({ senders, campaigns }, NO_STORE)
    }

    // The form: clients, client workspaces, and campaigns to copy a sequence from.
    const admin = createAdminClient()
    const [workspaces, usersRes] = await Promise.all([
      listWorkspaces(),
      admin.from('profiles').select('id, email, full_name').order('email', { ascending: true }).limit(1000),
    ])
    if (usersRes.error) throw new Error(usersRes.error.message)
    const { campaigns, errors } = await campaignsAcrossWorkspaces(workspaces, 4000)
    return NextResponse.json(
      {
        users: (usersRes.data || []).map((u) => ({ id: u.id as string, email: u.email as string, name: (u.full_name as string | null) || null })),
        workspaces: workspaces.filter((w) => w.id).map((w) => ({ id: w.id as string, name: w.name })),
        templates: campaigns,
        templateErrors: errors,
      },
      NO_STORE
    )
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Could not load' }, { status: 500, ...NO_STORE })
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireHeyReachAdmin()
  if (auth.response) return auth.response
  const parsed = PostSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Check the form and try again.' }, { status: 400, ...NO_STORE })
  const body = parsed.data
  const fail = (status: number, error: string, extra: Record<string, unknown> = {}) => NextResponse.json({ error, ...extra }, { status, ...NO_STORE })

  // ── Show the sequence before anything is created ──
  if (body.action === 'preview') {
    try {
      const { sequence, source } = await loadSequence(body.template, 5000)
      return NextResponse.json({ ok: true, source, ...summary(sequence) }, NO_STORE)
    } catch (err) {
      return fail(502, err instanceof Error ? err.message : 'Could not read the sequence')
    }
  }

  // Client workspaces only: a campaign sends from the LinkedIn attached to it.
  const workspace = (await listWorkspaces()).find((w) => w.id === body.workspace_id)
  if (!workspace || !workspace.id) return fail(400, "That isn't one of your client workspaces. Add it under HeyReach workspaces first.")
  let key: string | undefined
  try {
    key = await workspaceKey(workspace.id)
  } catch (err) {
    return fail(500, err instanceof Error ? err.message : "Could not read the workspace's key")
  }

  // ── Start the campaign ──
  if (body.action === 'start') {
    try {
      const before = await getHeyReachCampaign(body.campaign_id, 3000, key)
      if (!before) return fail(404, `HeyReach can't find campaign ${body.campaign_id} in "${workspace.name}".`)
      if (!STARTED.has(before.status)) {
        const reply = await startHeyReachCampaign(body.campaign_id, key, 4000)
        if (!reply.ok) {
          console.warn(`[Setup] StartCampaign ${body.campaign_id} in "${workspace.name}" returned ${reply.status}: ${reply.text.slice(0, 300)}`)
          return fail(502, `HeyReach didn't start it: ${heyReachError(reply)}`, { status: before.status })
        }
      }
      const after = await getHeyReachCampaign(body.campaign_id, 3000, key)
      const status = after?.status || before.status
      console.log(`[Setup] ${auth.user.email} started "${before.name}" (${body.campaign_id}) in "${workspace.name}": ${status}`)
      return NextResponse.json({ ok: true, status, running: STARTED.has(status), name: after?.name || before.name, senders: after?.accountIds.length ?? before.accountIds.length }, NO_STORE)
    } catch (err) {
      return fail(502, err instanceof Error ? err.message : 'Could not reach HeyReach')
    }
  }

  // ── Create the list and the campaign ──
  const name = body.name.trim()
  let sequence: SequenceNode
  let source: string
  try {
    const [loaded, senders, existing] = await Promise.all([
      loadSequence(body.template, 3000),
      listHeyReachSenders(key, 3000),
      listHeyReachCampaigns(3000, key),
    ])
    sequence = loaded.sequence
    source = loaded.source

    // A retry after a timeout finds the campaign it already made.
    const same = existing.find((c) => c.name.trim().toLowerCase() === name.toLowerCase())
    if (same) {
      console.log(`[Setup] "${name}" already exists in "${workspace.name}" (${same.id}); using it`)
      return NextResponse.json({ ok: true, campaignId: same.id, existing: true, status: same.status, source: null, ...summary(sequence) }, NO_STORE)
    }

    const sender = senders.find((s) => s.id === body.sender_id)
    if (!sender) return fail(400, `That LinkedIn account isn't connected to "${workspace.name}" in HeyReach.`)
    if (sender.authValid === false) return fail(400, `${sender.name}'s LinkedIn login needs reconnecting in HeyReach first.`)
  } catch (err) {
    return fail(502, err instanceof Error ? err.message : 'Could not reach HeyReach')
  }

  try {
    const list = await createHeyReachLeadList(name, key, 3000)
    if (!list.listId) {
      console.warn(`[Setup] CreateEmptyList in "${workspace.name}" returned ${list.reply.status}: ${list.reply.text.slice(0, 300)}`)
      return fail(502, `HeyReach didn't create the lead list: ${list.reply.ok ? 'no list ID came back' : heyReachError(list.reply)}`)
    }
    const created = await createHeyReachCampaign(
      { name, listId: list.listId, linkedInAccountIds: [body.sender_id], schedule: { ...CLIENT_SCHEDULE }, sequence },
      key,
      4000
    )
    if (!created.campaignId) {
      console.warn(`[Setup] Create in "${workspace.name}" returned ${created.reply.status}: ${created.reply.text.slice(0, 500)}`)
      return fail(502, `HeyReach didn't create the campaign: ${created.reply.ok ? 'no campaign ID came back' : heyReachError(created.reply)}`)
    }
    console.log(`[Setup] ${auth.user.email} created "${name}" (${created.campaignId}) in "${workspace.name}" from ${source}, list ${list.listId}, sender ${body.sender_id}`)
    return NextResponse.json({ ok: true, campaignId: created.campaignId, listId: list.listId, existing: false, status: 'DRAFT', source, ...summary(sequence) }, NO_STORE)
  } catch (err) {
    // A timeout here may still have created it. Trying again finds it by name.
    return fail(502, `${err instanceof Error ? err.message : 'Could not reach HeyReach'}. Click Set up again: if the campaign was made, it's picked up rather than made twice.`)
  }
}
