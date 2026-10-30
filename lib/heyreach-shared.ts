// v77: HeyReach test types and checks shared by the browser and the server.
// No secrets and no server-only imports here.

import { linkedInProfileSlug } from '@/lib/linkedin'
import { cleanPersonName } from '@/lib/names'

/** The live campaign the five-person test goes into. */
export const HEYREACH_TEST_CAMPAIGN = 'ProspectIQ test'

/** Custom variable names. Each HeyReach message step uses one of these. */
export const HEYREACH_MESSAGE_FIELDS = ['msg_1', 'msg_2', 'msg_3', 'msg_4'] as const
export type HeyReachMessageField = (typeof HEYREACH_MESSAGE_FIELDS)[number]
export type HeyReachMessages = Record<HeyReachMessageField, string>

export const HEYREACH_MESSAGE_LABELS: Record<HeyReachMessageField, string> = {
  msg_1: 'Welcome (24 hours after they accept)',
  msg_2: 'Value (5 to 7 days later)',
  msg_3: 'Value (5 to 7 days later)',
  msg_4: 'Audit offer (5 to 7 days later)',
}

/** Suggested lengths. Over these is flagged, not blocked. */
export const HEYREACH_MESSAGE_SOFT_LIMITS: Record<HeyReachMessageField, number> = {
  msg_1: 300,
  msg_2: 600,
  msg_3: 600,
  msg_4: 500,
}

export type HeyReachStatus = 'draft' | 'approved' | 'rejected' | 'pushing' | 'pushed' | 'push_failed'

export interface HeyReachPushRecord {
  at: string
  heyreach_campaign_id: number
  heyreach_campaign_name: string
  heyreach_campaign_status: string
  linkedin_account_id: number
  sent_lead: Record<string, unknown>
  response: { status: number; ms: number; added: number; updated: number; failed: number; body: unknown } | null
  read_back: { status: number; body: unknown } | { error: string } | { skipped: string } | null
  outcome: 'accepted' | 'rejected'
  /** True when a stuck push was resolved by finding the lead already in HeyReach. */
  recovered?: boolean
}

export interface HeyReachState {
  first_name?: string
  last_name?: string
  profile_url?: string
  msgs?: Partial<HeyReachMessages>
  status?: HeyReachStatus
  approved_at?: string
  /** Fingerprint of names, profile and messages at approval. Push refuses if they changed. */
  approved_hash?: string
  rejected_at?: string
  /** When the current push started. A push stuck longer than a minute can be checked. */
  pushing_at?: string
  push?: HeyReachPushRecord
  push_error?: string
}

const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'prof', 'professor', 'sir', 'dame', 'lord', 'lady', 'rev'])

/**
 * First name is the first word; last name is the rest. Credentials and a
 * leading title (Mr, Dr, Sir...) are stripped first. Always checked in review.
 */
export function splitName(fullName: string): { first: string; last: string } {
  const clean = cleanPersonName(fullName || '').trim().replace(/\s+/g, ' ')
  const parts = clean.split(' ')
  while (parts.length > 2 && HONORIFICS.has(parts[0].replace(/\.$/, '').toLowerCase())) parts.shift()
  return { first: parts[0] || '', last: parts.slice(1).join(' ') }
}

/**
 * Why a person can't be pushed yet. Empty when they can.
 * Rule: never push anyone missing a message, first name, last name or exact profile URL.
 */
export function pushProblems(state: HeyReachState | null | undefined): string[] {
  const problems: string[] = []
  if (!state?.first_name?.trim()) problems.push('first name')
  if (!state?.last_name?.trim()) problems.push('last name')
  const slug = linkedInProfileSlug(state?.profile_url)
  if (!slug) problems.push('exact LinkedIn profile URL')
  // Member-ID links (/in/ACwAA...) are case-sensitive and break when tidied.
  else if (/^ac[wo]aa/.test(slug)) problems.push('a named LinkedIn profile URL (member-ID links can\'t be used)')
  for (const f of HEYREACH_MESSAGE_FIELDS) {
    if (!state?.msgs?.[f]?.trim()) problems.push(f)
  }
  return problems
}
