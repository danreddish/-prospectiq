import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireRecruitmentAccess } from '@/lib/recruitment/gate'
import { PLAN_LIMITS } from '@/types'
import { z } from 'zod'

// Add to and remove from the recruitment watchlist. Snapshots are taken by
// the check job; the first check stores a snapshot and raises nothing.

const AddSchema = z.object({
  item_type: z.enum(['adviser', 'firm']),
  prospect_id: z.string().uuid().optional(),
  fca_irn: z.string().regex(/^[A-Za-z]{2,4}\d{4,6}$/).optional(),
  fca_frn: z.string().regex(/^\d{5,7}$/).optional(),
  display_name: z.string().min(1).max(200).optional(),
})

const RemoveSchema = z.object({ id: z.string().uuid() })

export async function POST(req: NextRequest) {
  const gate = await requireRecruitmentAccess()
  if (!gate.ok) return gate.response

  const parsed = AddSchema.safeParse(await req.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input' }, { status: 400 })
  const input = parsed.data
  const supabase = createClient()

  let irn = input.fca_irn || null
  let frn = input.fca_frn || null
  let displayName = input.display_name || null
  let firmName: string | null = null
  let campaignId: string | null = null

  if (input.prospect_id) {
    const { data: prospect } = await supabase
      .from('prospects')
      .select('id, name, campaign_id, fca_irn, fca_frn, fca_firm_name, company')
      .eq('id', input.prospect_id)
      .eq('user_id', gate.user.id)
      .single()
    if (!prospect) return NextResponse.json({ error: 'Adviser not found' }, { status: 404 })
    campaignId = prospect.campaign_id
    if (input.item_type === 'adviser') {
      irn = irn || prospect.fca_irn
      displayName = displayName || prospect.name
      firmName = prospect.fca_firm_name || prospect.company
    } else {
      frn = frn || prospect.fca_frn
      displayName = displayName || prospect.fca_firm_name || prospect.company
    }
  }

  if (input.item_type === 'adviser' && !irn) {
    return NextResponse.json({ error: 'This adviser is not on the FCA Register, so there is nothing to watch' }, { status: 400 })
  }
  if (input.item_type === 'firm' && !frn) {
    return NextResponse.json({ error: 'No FRN for this firm' }, { status: 400 })
  }

  const { count } = await supabase
    .from('watchlist_items')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', gate.user.id)
  if ((count || 0) >= PLAN_LIMITS.recruitment.watchlist_items) {
    return NextResponse.json({ error: `Watchlist limit reached (${PLAN_LIMITS.recruitment.watchlist_items}). Remove an item first.` }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('watchlist_items')
    .insert({
      user_id: gate.user.id,
      item_type: input.item_type,
      fca_irn: input.item_type === 'adviser' ? irn : null,
      fca_frn: input.item_type === 'firm' ? frn : null,
      display_name: displayName || (input.item_type === 'adviser' ? irn : frn),
      firm_name: firmName,
      prospect_id: input.prospect_id || null,
      campaign_id: campaignId,
    })
    .select('id, item_type, fca_irn, fca_frn, display_name, firm_name, last_checked_at, last_snapshot, created_at')
    .single()

  if (error) {
    if (error.code === '23505') return NextResponse.json({ error: 'Already on your watchlist', code: 'duplicate' }, { status: 409 })
    // Limit or access refused by the database trigger
    if (error.code === 'P0001') return NextResponse.json({ error: error.message }, { status: 400 })
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ item: data })
}

export async function DELETE(req: NextRequest) {
  const gate = await requireRecruitmentAccess()
  if (!gate.ok) return gate.response

  const parsed = RemoveSchema.safeParse(await req.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input' }, { status: 400 })

  const supabase = createClient()
  const { error } = await supabase
    .from('watchlist_items')
    .delete()
    .eq('id', parsed.data.id)
    .eq('user_id', gate.user.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ removed: true })
}
