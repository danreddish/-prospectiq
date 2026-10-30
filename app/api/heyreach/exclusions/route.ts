import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server'
import { requireHeyReachAdmin } from '@/lib/heyreach-route'

// v77: LinkedIn exclusions. The browser reads a Ulinc contact export and
// sends only the profile names (the part after /in/), in chunks:
//   first chunk  -> no upload_id; the reply carries one
//   later chunks -> the same upload_id
//   last chunk   -> final: true; Ulinc rows not stamped with this upload's
//                   ID are deleted, so the list matches the new export
// If an upload fails part way, nothing is deleted and the old list stays.
// 'heyreach' rows (people already pushed) are never touched by an upload.

const SLUG = /^[^\s/?#]{1,200}$/

const PostSchema = z.object({
  slugs: z.array(z.string()).min(1).max(5000),
  upload_id: z.string().datetime().optional(),
  final: z.boolean().default(false),
})

async function counts(userId: string) {
  const admin = createAdminClient()
  const [ulinc, heyreach] = await Promise.all([
    admin.from('linkedin_exclusions').select('profile_slug', { count: 'exact', head: true }).eq('user_id', userId).eq('source', 'ulinc'),
    admin.from('linkedin_exclusions').select('profile_slug', { count: 'exact', head: true }).eq('user_id', userId).eq('source', 'heyreach'),
  ])
  if (ulinc.error || heyreach.error) throw new Error((ulinc.error || heyreach.error)!.message)
  return { ulinc: ulinc.count || 0, heyreach: heyreach.count || 0 }
}

export async function GET() {
  const auth = await requireHeyReachAdmin()
  if (auth.response) return auth.response
  try {
    const c = await counts(auth.user.id)
    return NextResponse.json({ total: c.ulinc + c.heyreach, ...c }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Could not count' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireHeyReachAdmin()
  if (auth.response) return auth.response

  const parsed = PostSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input' }, { status: 400 })
  const uploadId = parsed.data.upload_id || new Date().toISOString()
  const slugs = Array.from(new Set(parsed.data.slugs.map((s) => s.trim().toLowerCase()).filter((s) => SLUG.test(s))))

  const admin = createAdminClient()
  // Every row from this upload is stamped with the upload's ID, so the last
  // chunk can remove exactly the rows this upload didn't include.
  for (let i = 0; i < slugs.length; i += 1000) {
    const rows = slugs.slice(i, i + 1000).map((profile_slug) => ({ user_id: auth.user.id, profile_slug, source: 'ulinc', seen_at: uploadId }))
    const { error } = await admin.from('linkedin_exclusions').upsert(rows, { onConflict: 'user_id,profile_slug,source' })
    if (error) return NextResponse.json({ error: `Could not save the list: ${error.message}` }, { status: 500 })
  }

  let removed = 0
  if (parsed.data.final) {
    const { count, error } = await admin
      .from('linkedin_exclusions')
      .delete({ count: 'exact' })
      .eq('user_id', auth.user.id)
      .eq('source', 'ulinc')
      .neq('seen_at', uploadId)
    if (error) return NextResponse.json({ error: `Saved, but could not remove old entries: ${error.message}` }, { status: 500 })
    removed = count || 0
  }

  const c = await counts(auth.user.id).catch(() => ({ ulinc: 0, heyreach: 0 }))
  console.log(`[Exclusions] Ulinc upload ${uploadId}: saved ${slugs.length}${parsed.data.final ? `, removed ${removed} no longer in the export` : ''}. Ulinc total ${c.ulinc}`)
  return NextResponse.json({ upload_id: uploadId, saved: slugs.length, removed, total: c.ulinc + c.heyreach, ...c })
}
