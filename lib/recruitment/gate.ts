import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { isAdmin } from '@/lib/access'
import { recruitmentAccess, recruitmentMessage, type RecruitmentReason } from './access-rules'

// Shared gate for /api/recruitment/* routes: signed in, and either
// Recruitment active or an admin. Nothing is counted here; research and
// searches count in the database (migration 007).
export async function requireRecruitmentAccess(): Promise<
  | { ok: true; user: { id: string; email: string | null }; profile: RecruitmentGateProfile; isAdmin: boolean }
  | { ok: false; response: NextResponse }
> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return { ok: false, response: NextResponse.json({ error: 'Unauthorised' }, { status: 401 }) }
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('id, email, full_name, sender_name, company_name, recruitment_status, recruitment_subscription_id, recruitment_current_period_end, recruitment_advisers_used, recruitment_finds_used, recruitment_usage_reset_at, recruitment_profile')
    .eq('id', user.id)
    .single()

  const email = user.email || null
  const admin = isAdmin(email)
  const reason = recruitmentAccess(profile)
  if (!profile || (!admin && reason !== 'ok')) {
    const code = profile ? reason : 'recruitment_inactive'
    return {
      ok: false,
      response: NextResponse.json({ error: recruitmentMessage(code), code }, { status: 403 }),
    }
  }

  return { ok: true, user: { id: user.id, email }, profile: profile as RecruitmentGateProfile, isAdmin: admin }
}

export interface RecruitmentGateProfile {
  id: string
  email: string
  full_name: string | null
  sender_name: string | null
  company_name: string | null
  recruitment_status: string
  recruitment_advisers_used: number | null
  recruitment_finds_used: number | null
  recruitment_usage_reset_at: string | null
  recruitment_profile: unknown
}

type Gate = { user: { id: string }; isAdmin: boolean }

interface UsageResult {
  ok: boolean
  granted?: number
  reason?: RecruitmentReason
  limit?: number
  resets_at?: string | null
}

function planCheckFailed(): NextResponse {
  return NextResponse.json(
    { error: 'We could not check your Recruitment plan just now. Please try again in a moment.', code: 'plan_check_failed' },
    { status: 503 }
  )
}

function blocked(r: UsageResult): NextResponse {
  const reason = r.reason || 'recruitment_inactive'
  return NextResponse.json(
    { error: recruitmentMessage(reason, { limit: r.limit, resetsAt: r.resets_at }), code: reason },
    { status: 402 }
  )
}

// Reserves one adviser research. Admins are never blocked or counted.
// Returns a response to send back when the research may not go ahead.
export async function consumeRecruitmentResearch(gate: Gate): Promise<NextResponse | null> {
  if (gate.isAdmin) return null
  const { data, error } = await createAdminClient().rpc('consume_recruitment_research', { p_user_id: gate.user.id })
  if (error || !data) {
    console.error('[Recruitment] Research check failed:', error?.message)
    return planCheckFailed()
  }
  const r = data as UsageResult
  return r.ok ? null : blocked(r)
}

// Gives back a research when it failed. Capped in the database.
export async function refundRecruitmentResearch(gate: Gate): Promise<void> {
  if (gate.isAdmin) return
  const { error } = await createAdminClient().rpc('refund_recruitment_research', { p_user_id: gate.user.id })
  if (error) console.error('[Recruitment] Research refund failed:', error.message)
}

// Reserves up to `units` of the monthly adviser search budget (one unit per
// AI brief, one per Apollo-enriched contact). Grants what is left if that
// is less than asked. Admins are never blocked or counted.
export async function reserveRecruitmentFindUnits(
  gate: Gate,
  units: number
): Promise<{ granted: number; response: NextResponse | null }> {
  if (gate.isAdmin) return { granted: units, response: null }
  const { data, error } = await createAdminClient().rpc('consume_recruitment_find_units', { p_user_id: gate.user.id, p_units: units })
  if (error || !data) {
    console.error('[Recruitment] Search budget check failed:', error?.message)
    return { granted: 0, response: planCheckFailed() }
  }
  const r = data as UsageResult
  if (!r.ok) return { granted: 0, response: blocked(r) }
  return { granted: r.granted ?? 0, response: null }
}

// Gives back search units that were reserved but not used.
export async function refundRecruitmentFindUnits(gate: Gate, units: number): Promise<void> {
  if (units <= 0 || gate.isAdmin) return
  const { error } = await createAdminClient().rpc('refund_recruitment_find_units', { p_user_id: gate.user.id, p_units: units })
  if (error) console.error('[Recruitment] Search refund failed:', error.message)
}
