import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server'
import { requireHeyReachAdmin } from '@/lib/heyreach-route'
import { checkHeyReachKey, listHeyReachCampaigns } from '@/lib/heyreach'
import { listWorkspaces, workspaceKey } from '@/lib/heyreach-workspaces'

export const dynamic = 'force-dynamic'

// v79: admin only. HeyReach workspaces and their API keys. A key is checked
// with HeyReach before it is saved, stored in Supabase Vault (migration 011),
// and never sent back to the browser or logged.

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } }

const PostSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add'), name: z.string().trim().min(1).max(80), key: z.string().trim().min(10).max(500) }),
  z.object({ action: z.literal('replace_key'), id: z.string().uuid(), key: z.string().trim().min(10).max(500) }),
  z.object({ action: z.literal('rename'), id: z.string().uuid(), name: z.string().trim().min(1).max(80) }),
  z.object({ action: z.literal('remove'), id: z.string().uuid() }),
])

/** Each workspace with whether its key still works and how many campaigns it has. */
async function describe() {
  const workspaces = await listWorkspaces()
  return Promise.all(
    workspaces.map(async (w) => {
      try {
        const key = await workspaceKey(w.id)
        const ok = await checkHeyReachKey(key)
        const campaigns = ok ? (await listHeyReachCampaigns(3500, key)).length : null
        return { ...w, keyOk: ok, campaigns }
      } catch (err) {
        return { ...w, keyOk: false, campaigns: null, error: err instanceof Error ? err.message : 'Check failed' }
      }
    })
  )
}

export async function GET() {
  const auth = await requireHeyReachAdmin()
  if (auth.response) return auth.response
  return NextResponse.json({ workspaces: await describe() }, NO_STORE)
}

export async function POST(req: NextRequest) {
  const auth = await requireHeyReachAdmin()
  if (auth.response) return auth.response
  const parsed = PostSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Check the name and key, then try again.' }, { status: 400 })
  const body = parsed.data
  const admin = createAdminClient()

  if (body.action === 'add' || body.action === 'replace_key') {
    if (process.env.HEYREACH_API_KEY && body.key === process.env.HEYREACH_API_KEY.trim()) {
      return NextResponse.json({ error: "That's your main workspace's key. Generate the key inside the client's workspace in HeyReach." }, { status: 400 })
    }
    let ok = false
    try {
      ok = await checkHeyReachKey(body.key)
    } catch {
      return NextResponse.json({ error: 'Could not reach HeyReach to check the key. Try again in a minute.' }, { status: 502 })
    }
    if (!ok) return NextResponse.json({ error: 'HeyReach rejected that key. Copy it again from the workspace in HeyReach.' }, { status: 400 })
  }

  if (body.action === 'add' || body.action === 'rename') {
    // One workspace per name, so a retried "Add" can't make a second copy.
    const { data: same } = await admin.from('heyreach_workspaces').select('id').ilike('name', body.name.replace(/[\\%_]/g, (c) => `\\${c}`))
    if ((same || []).some((w) => body.action === 'add' || w.id !== body.id)) {
      return NextResponse.json({ error: `There's already a workspace called "${body.name}".` }, { status: 409 })
    }
  }

  if (body.action === 'add') {
    const { error } = await admin.rpc('heyreach_workspace_create', { p_name: body.name, p_key: body.key })
    if (error) return NextResponse.json({ error: `Could not save: ${error.message}` }, { status: 500 })
    console.log(`[Workspaces] ${auth.user.email} added HeyReach workspace "${body.name}"`)
  } else if (body.action === 'replace_key') {
    const { error } = await admin.rpc('heyreach_workspace_set_key', { p_id: body.id, p_key: body.key })
    if (error) return NextResponse.json({ error: `Could not save: ${error.message}` }, { status: 500 })
    console.log(`[Workspaces] ${auth.user.email} replaced the key for workspace ${body.id}`)
  } else if (body.action === 'rename') {
    const { error } = await admin.from('heyreach_workspaces').update({ name: body.name }).eq('id', body.id)
    if (error) return NextResponse.json({ error: `Could not save: ${error.message}` }, { status: 500 })
  } else {
    const { error } = await admin.rpc('heyreach_workspace_delete', { p_id: body.id })
    if (error) return NextResponse.json({ error: `Could not remove: ${error.message}` }, { status: 500 })
    console.log(`[Workspaces] ${auth.user.email} removed workspace ${body.id} and its campaign access`)
  }

  // The page reloads the list (with each key checked) in a separate request,
  // so this one stays well inside the 10 second limit.
  return NextResponse.json({ ok: true }, NO_STORE)
}
