// v75.7: route guards for API handlers. Server-only (uses next/server).
import { NextResponse } from 'next/server'
import type { SupabaseClient, User } from '@supabase/supabase-js'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import {
  isAdmin,
  planAccess,
  researchAccess,
  accessMessage,
  prospectLimit,
  ACCESS_COLUMNS,
  type AccessProfile,
  type AccessReason,
} from '@/lib/access'

// Returns a 402 response when the user may not use paid features, or null
// when they may. needsResearchLeft also requires at least one research
// left this cycle (used before finding prospects, which spends Apollo
// credits). Nothing is counted here; research counts in the database.
export async function requireAccess(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  user: User,
  opts: { needsResearchLeft?: boolean } = {}
): Promise<NextResponse | null> {
  if (isAdmin(user.email)) return null

  const { data } = await supabase.from('profiles').select(ACCESS_COLUMNS).eq('id', user.id).single()
  if (!data) {
    return NextResponse.json({ error: accessMessage('no_plan'), code: 'no_plan' }, { status: 402 })
  }

  const p = data as AccessProfile
  const reason = opts.needsResearchLeft ? researchAccess(p) : planAccess(p)
  if (reason === 'ok') return null

  return NextResponse.json(
    { error: accessMessage(reason, { limit: prospectLimit(p.plan_tier), resetsAt: p.cycle_reset_at }), code: reason },
    { status: 402 }
  )
}

// Debug endpoints are for the admin only. Anyone else gets a plain 404.
export async function requireAdmin(): Promise<NextResponse | null> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user.email)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  return null
}

// Reserves up to `units` of the user's monthly find budget (one unit per
// AI search, one per Apollo-enriched contact). Grants what is left if that
// is less than asked. Admins are never blocked or counted. Returns the
// units granted, or a response to send back when none can be granted.
export async function reserveFindUnits(
  user: User,
  units: number
): Promise<{ granted: number; response: NextResponse | null }> {
  if (isAdmin(user.email)) return { granted: units, response: null }

  const { data, error } = await createAdminClient().rpc('consume_find_units', { p_user_id: user.id, p_units: units })
  if (error || !data) {
    console.error('[Find] Plan check failed:', error?.message)
    return {
      granted: 0,
      response: NextResponse.json(
        { error: 'We could not check your plan just now. Please try again in a moment.', code: 'plan_check_failed' },
        { status: 503 }
      ),
    }
  }

  const r = data as { ok: boolean; granted?: number; reason?: AccessReason; limit?: number; resets_at?: string | null }
  if (!r.ok) {
    const reason = r.reason || 'no_plan'
    return {
      granted: 0,
      response: NextResponse.json(
        { error: accessMessage(reason, { limit: r.limit, resetsAt: r.resets_at }), code: reason },
        { status: 402 }
      ),
    }
  }
  return { granted: r.granted ?? 0, response: null }
}

// Gives back find units that were reserved but not used.
export async function refundFindUnits(user: User, units: number): Promise<void> {
  if (units <= 0 || isAdmin(user.email)) return
  const { error } = await createAdminClient().rpc('refund_find_units', { p_user_id: user.id, p_units: units })
  if (error) console.error('[Find] Refund failed:', error.message)
}
