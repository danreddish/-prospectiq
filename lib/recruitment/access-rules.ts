// v76: who may use Recruitment, and why not. Mirrors public.recruitment_access()
// in migration 007, which is the source of truth for counted usage.
//
// Relative imports only: the Netlify scheduled functions use this file and
// are bundled without the "@/" path alias.

import { isAdmin } from '../admin'

export type RecruitmentReason =
  | 'ok'
  | 'recruitment_inactive'
  | 'recruitment_payment_failed'
  | 'recruitment_cancelled'
  | 'recruitment_expired'
  | 'recruitment_limit_reached'
  | 'recruitment_find_limit_reached'

export interface RecruitmentAccessFields {
  recruitment_status?: string | null
  recruitment_subscription_id?: string | null
  recruitment_current_period_end?: string | null
}

// Admin-enabled (beta) access has no Stripe subscription and ends at
// recruitment_current_period_end. Paid access is kept current by the
// webhook. past_due blocks straight away.
export function recruitmentAccess(
  p: RecruitmentAccessFields | null | undefined,
  now: Date = new Date()
): Exclude<RecruitmentReason, 'recruitment_limit_reached' | 'recruitment_find_limit_reached'> {
  const status = p?.recruitment_status || 'inactive'
  if (status === 'active') {
    if (!p?.recruitment_subscription_id && p?.recruitment_current_period_end
        && new Date(p.recruitment_current_period_end).getTime() <= now.getTime()) {
      return 'recruitment_expired'
    }
    return 'ok'
  }
  if (status === 'past_due') return 'recruitment_payment_failed'
  if (status === 'cancelled') return 'recruitment_cancelled'
  return 'recruitment_inactive'
}

export function hasRecruitmentAccess(
  profile: RecruitmentAccessFields | null | undefined,
  email: string | null | undefined
): boolean {
  return isAdmin(email) || recruitmentAccess(profile) === 'ok'
}

function formatReset(resetsAt: string | null | undefined): string | null {
  return resetsAt
    ? new Date(resetsAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'Europe/London' })
    : null
}

export function recruitmentMessage(
  reason: RecruitmentReason,
  detail?: { limit?: number | null; resetsAt?: string | null }
): string {
  switch (reason) {
    case 'recruitment_inactive':
      return 'Recruitment is a separate plan. Start it from the Recruitment page to find and research advisers.'
    case 'recruitment_payment_failed':
      return 'Your last Recruitment payment did not go through, so Recruitment is paused. Restart it from the Recruitment page.'
    case 'recruitment_cancelled':
      return 'Your Recruitment subscription has been cancelled. Restart it from the Recruitment page to carry on.'
    case 'recruitment_expired':
      return 'Your Recruitment beta access has ended. Start the plan from the Recruitment page to carry on.'
    case 'recruitment_limit_reached': {
      const resets = formatReset(detail?.resetsAt)
      return `You have used all ${detail?.limit ?? 'your'} adviser researches for this month${resets ? `. Your allowance resets on ${resets}` : ''}.`
    }
    case 'recruitment_find_limit_reached': {
      const resets = formatReset(detail?.resetsAt)
      return `You have used this month's adviser searches${resets ? `. They reset on ${resets}` : ''}. You can still research the advisers already in your campaigns.`
    }
    default:
      return ''
  }
}

// Columns to select when a Recruitment access check is needed.
export const RECRUITMENT_ACCESS_COLUMNS = 'recruitment_status, recruitment_subscription_id, recruitment_current_period_end'
