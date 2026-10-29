// v75.7: who may use the paid features, and why not.
//
// The database is the source of truth for counted research
// (consume_research_credit / refund_research_credit in migration 005).
// This file mirrors the same rules for the checks that don't count usage
// (finding prospects, reply coach, LinkedIn import) and for the dashboard
// banner. Keep planAccess() in step with public.plan_access() in SQL.

import { PLAN_LIMITS, type PlanTier } from '@/types'

export { ADMIN_EMAILS, isAdmin } from './admin'

export type AccessReason =
  | 'ok'
  | 'trial_ended'
  | 'no_plan'
  | 'payment_failed'
  | 'canceled'
  | 'limit_reached'
  | 'find_limit_reached'

export interface AccessProfile {
  plan_tier: string | null
  plan_status: string | null
  trial_ends_at: string | null
  prospects_used_this_cycle?: number | null
  cycle_reset_at?: string | null
}

const PAID_TIERS = ['starter', 'professional', 'growth']
const PAID_OK_STATUSES = ['active', 'trialing', 'past_due']

// Mirrors public.plan_access(). Returns 'ok' or the reason access is blocked.
export function planAccess(
  p: AccessProfile,
  now: Date = new Date()
): Exclude<AccessReason, 'limit_reached' | 'find_limit_reached'> {
  const tier = p.plan_tier || 'free'
  const status = p.plan_status || 'active'

  if (PAID_TIERS.includes(tier)) {
    if (PAID_OK_STATUSES.includes(status)) return 'ok'
    if (status === 'unpaid') return 'payment_failed'
    return 'canceled'
  }
  if (tier === 'trial') {
    if (p.trial_ends_at && new Date(p.trial_ends_at).getTime() > now.getTime()) return 'ok'
    return 'trial_ended'
  }
  return 'no_plan'
}

// Prospects used this cycle, treating a cycle that has passed (or was
// never started) as reset, as the database does.
export function effectiveUsage(p: AccessProfile, now: Date = new Date()): number {
  if (!p.cycle_reset_at || new Date(p.cycle_reset_at).getTime() < now.getTime()) return 0
  return p.prospects_used_this_cycle || 0
}

export function prospectLimit(tier: string | null): number {
  return (PLAN_LIMITS[(tier || 'free') as PlanTier] || PLAN_LIMITS.free).prospects_per_cycle
}

// Access plus "has at least one research left this cycle". Used to gate
// finding prospects, which spends Apollo credits without counting usage.
export function researchAccess(p: AccessProfile, now: Date = new Date()): AccessReason {
  const reason = planAccess(p, now)
  if (reason !== 'ok') return reason
  if (effectiveUsage(p, now) >= prospectLimit(p.plan_tier)) return 'limit_reached'
  return 'ok'
}

export function accessMessage(
  reason: AccessReason,
  detail?: { limit?: number | null; resetsAt?: string | null }
): string {
  switch (reason) {
    case 'trial_ended':
      return 'Your 7-day free trial has ended. Choose a plan in Settings to keep researching prospects.'
    case 'no_plan':
      return 'Your account does not have an active plan. Choose a plan in Settings to research prospects.'
    case 'payment_failed':
      return 'Your last payment did not go through. Update your card in Settings to keep researching prospects.'
    case 'canceled':
      return 'Your subscription has been cancelled. Choose a plan in Settings to keep researching prospects.'
    case 'limit_reached': {
      const limit = detail?.limit
      const resets = detail?.resetsAt
        ? new Date(detail.resetsAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'Europe/London' })
        : null
      return `You have used all ${limit ?? 'your'} prospect researches for this month${resets ? `. Your allowance resets on ${resets}` : ''}. Upgrade in Settings for more.`
    }
    case 'find_limit_reached': {
      const resets = detail?.resetsAt
        ? new Date(detail.resetsAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'Europe/London' })
        : null
      return `You have used this month's prospect searches${resets ? `. They reset on ${resets}` : ''}. You can still research the prospects already in your campaigns. Upgrade in Settings for more.`
    }
    default:
      return ''
  }
}

// Columns to select when an access check is needed.
export const ACCESS_COLUMNS = 'plan_tier, plan_status, trial_ends_at, prospects_used_this_cycle, cycle_reset_at'
