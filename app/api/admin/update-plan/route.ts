import { NextRequest, NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { z } from 'zod'

import { isAdmin } from '@/lib/access'

const Schema = z.object({
  user_id: z.string().uuid(),
  plan_tier: z.enum(['free', 'trial', 'starter', 'professional', 'growth']).optional(),
  days: z.number().min(1).max(365).optional().default(30),
  reset_usage: z.boolean().optional(),
  // v76: Recruitment on/off (beta onboarding) and usage reset. Separate from the plan.
  recruitment: z.boolean().optional(),
  reset_recruitment_usage: z.boolean().optional(),
})

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const admin = createAdminClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user.email)) {
    return NextResponse.json({ error: 'Not authorised' }, { status: 403 })
  }

  const body = await req.json()
  const parsed = Schema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input' }, { status: 400 })
  }

  const { user_id, plan_tier, days, reset_usage, recruitment, reset_recruitment_usage } = parsed.data

  const updates: Record<string, unknown> = {}

  if (plan_tier) {
    updates.plan_tier = plan_tier
    updates.plan_status = 'active'
    updates.prospects_used_this_cycle = 0
    updates.cycle_reset_at = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
    // v75.7: trials are only usable with a future end date, so putting
    // someone on 'trial' gives them a fresh 7 days.
    if (plan_tier === 'trial') {
      updates.trial_ends_at = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    }
  }

  if (reset_usage) {
    updates.prospects_used_this_cycle = 0
    updates.cycle_reset_at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
  }

  // Beta access: no Stripe subscription, ends after `days`. Clearing a stale
  // subscription id matters, because access with a subscription id never
  // expires on its own. Usage still runs in 30-day cycles.
  // A user with a live Stripe subscription is managed by Stripe. Switching
  // them on as beta would drop the subscription id while Stripe keeps
  // billing, and switching them off would be undone by the next Stripe event.
  if (recruitment !== undefined) {
    const { data: target } = await admin
      .from('profiles')
      .select('recruitment_status, recruitment_subscription_id')
      .eq('id', user_id)
      .single()
    if (target?.recruitment_subscription_id && ['active', 'past_due'].includes(target.recruitment_status)) {
      return NextResponse.json(
        { error: 'This user has a Recruitment subscription in Stripe. Manage it in Stripe instead.' },
        { status: 409 }
      )
    }
  }

  if (recruitment === true) {
    updates.recruitment_status = 'active'
    updates.recruitment_subscription_id = null
    updates.recruitment_period = null
    updates.recruitment_current_period_end = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
    updates.recruitment_advisers_used = 0
    updates.recruitment_finds_used = 0
    updates.recruitment_usage_reset_at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
  } else if (recruitment === false) {
    updates.recruitment_status = 'inactive'
  }

  if (reset_recruitment_usage) {
    updates.recruitment_advisers_used = 0
    updates.recruitment_finds_used = 0
    updates.recruitment_usage_reset_at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
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
