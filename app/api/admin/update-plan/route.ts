import { NextRequest, NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { z } from 'zod'

const ADMIN_EMAILS = ['dan.reddish@gmail.com', 'dan@aiwealthpartners.co.uk']

const Schema = z.object({
  user_id: z.string().uuid(),
  plan_tier: z.enum(['free', 'trial', 'starter', 'professional', 'growth']).optional(),
  days: z.number().min(1).max(365).optional().default(30),
  reset_usage: z.boolean().optional(),
})

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const admin = createAdminClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !ADMIN_EMAILS.includes(user.email || '')) {
    return NextResponse.json({ error: 'Not authorised' }, { status: 403 })
  }

  const body = await req.json()
  const parsed = Schema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input' }, { status: 400 })
  }

  const { user_id, plan_tier, days, reset_usage } = parsed.data

  const updates: Record<string, unknown> = {}

  if (plan_tier) {
    updates.plan_tier = plan_tier
    updates.plan_status = 'active'
    updates.prospects_used_this_cycle = 0
    updates.cycle_reset_at = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
  }

  if (reset_usage) {
    updates.prospects_used_this_cycle = 0
    updates.cycle_reset_at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  }

  const { error } = await admin
    .from('profiles')
    .update(updates)
    .eq('id', user_id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, updated: updates })
}
