import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireRecruitmentAccess } from '@/lib/recruitment/gate'
import { z } from 'zod'

// Mark alerts read: specific ids, or all unread.
const Schema = z.object({
  ids: z.array(z.string().uuid()).max(500).optional(),
  all: z.boolean().optional(),
})

export async function PATCH(req: NextRequest) {
  const gate = await requireRecruitmentAccess()
  if (!gate.ok) return gate.response

  const parsed = Schema.safeParse(await req.json())
  if (!parsed.success || (!parsed.data.all && !parsed.data.ids?.length)) {
    return NextResponse.json({ error: 'Invalid input' }, { status: 400 })
  }

  const supabase = createClient()
  let query = supabase
    .from('alerts')
    .update({ read_at: new Date().toISOString() })
    .eq('user_id', gate.user.id)
    .is('read_at', null)
  if (!parsed.data.all) query = query.in('id', parsed.data.ids!)

  const { error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
