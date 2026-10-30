// v77: shared bits for the admin-only /api/heyreach/* routes.

import { createHash } from 'crypto'
import { NextResponse } from 'next/server'
import type { User } from '@supabase/supabase-js'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { isAdmin } from '@/lib/admin'
import { linkedInProfileSlug } from '@/lib/linkedin'
import { HEYREACH_MESSAGE_FIELDS, type HeyReachState, type HeyReachStatus } from '@/lib/heyreach-shared'

type ServerClient = ReturnType<typeof createClient>

/** Signed-in admin, or a 404 (the feature is invisible to everyone else). */
export async function requireHeyReachAdmin(): Promise<
  { supabase: ServerClient; user: User; response?: undefined } | { response: NextResponse }
> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user.email)) {
    return { response: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  }
  return { supabase, user }
}

export interface TestProspect {
  id: string
  campaign_id: string
  name: string
  role: string | null
  company: string | null
  location: string | null
  linkedin_url: string | null
  status: string
  research_notes: string | null
  key_trigger: string | null
  total_score: number | null
  heyreach: HeyReachState | null
}

export interface TestCampaign {
  id: string
  purpose: string | null
  niche: string | null
  sender_name: string | null
  service_profile: Record<string, string | null> | null
  custom_instructions: string | null
}

/** Loads one of the user's prospects with its campaign and account profile. */
export async function loadTestProspect(
  supabase: ServerClient,
  userId: string,
  campaignId: string,
  prospectId: string
): Promise<
  | { prospect: TestProspect; campaign: TestCampaign; profile: { niche: string | null; sender_name: string | null; service_profile: Record<string, string | null> | null } | null; response?: undefined }
  | { response: NextResponse }
> {
  const [prospectRes, campaignRes, profileRes] = await Promise.all([
    supabase
      .from('prospects')
      .select('id, campaign_id, name, role, company, location, linkedin_url, status, research_notes, key_trigger, total_score, heyreach')
      .eq('id', prospectId)
      .eq('user_id', userId)
      .maybeSingle(),
    supabase
      .from('campaigns')
      .select('id, purpose, niche, sender_name, service_profile, custom_instructions')
      .eq('id', campaignId)
      .eq('user_id', userId)
      .maybeSingle(),
    supabase.from('profiles').select('niche, sender_name, service_profile').eq('id', userId).single(),
  ])
  const prospect = prospectRes.data as TestProspect | null
  const campaign = campaignRes.data as TestCampaign | null
  // Recruitment (adviser) campaigns are not part of the HeyReach test.
  if (!prospect || !campaign || prospect.campaign_id !== campaign.id || campaign.purpose === 'advisers') {
    return { response: NextResponse.json({ error: 'Prospect not found' }, { status: 404 }) }
  }
  return { prospect, campaign, profile: profileRes.data }
}

/**
 * Whether this LinkedIn profile is on the user's exclusions: their Ulinc
 * contacts, or someone ProspectIQ already pushed into HeyReach. Throws if the
 * check can't be made, so callers fail closed.
 */
export async function exclusionFor(userId: string, profileUrl: string | null | undefined): Promise<'ulinc' | 'heyreach' | null> {
  const slug = linkedInProfileSlug(profileUrl)
  if (!slug) return null
  const { data, error } = await createAdminClient()
    .from('linkedin_exclusions')
    .select('source')
    .eq('user_id', userId)
    .eq('profile_slug', slug)
  if (error) throw new Error(`Could not check your LinkedIn exclusions: ${error.message}`)
  const sources = (data || []).map((r) => r.source as string)
  if (sources.includes('ulinc')) return 'ulinc'
  if (sources.includes('heyreach')) return 'heyreach'
  return null
}

export function exclusionMessage(source: 'ulinc' | 'heyreach'): string {
  return source === 'ulinc'
    ? 'This person is in your Ulinc contacts, so they are left out.'
    : 'This person has already been sent to HeyReach.'
}

/** Fingerprint of everything that would be sent. Set at approval, checked at push. */
export function approvalHash(state: HeyReachState): string {
  const parts = [
    (state.first_name || '').trim(),
    (state.last_name || '').trim(),
    linkedInProfileSlug(state.profile_url) || '',
    ...HEYREACH_MESSAGE_FIELDS.map((f) => (state.msgs?.[f] || '').trim()),
  ]
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

/**
 * Saves the HeyReach state only if the row is still in a status we expect
 * (null = no HeyReach state yet). Returns false when something else changed
 * it first (another tab, a push in progress), so two requests can't both act
 * on the same person. pushingBefore: for a stuck push, only if it started
 * before this time. Uses save_prospect_heyreach_if (migration 009).
 */
export async function saveHeyReachIf(
  prospectId: string,
  userId: string,
  expected: Array<HeyReachStatus | null>,
  next: HeyReachState,
  pushingBefore?: string,
  expectedHash?: string
): Promise<boolean> {
  const { data, error } = await createAdminClient().rpc('save_prospect_heyreach_if', {
    p_prospect_id: prospectId,
    p_user_id: userId,
    p_expected: expected.filter((s): s is HeyReachStatus => !!s),
    p_allow_null: expected.includes(null),
    p_next: next,
    p_pushing_before: pushingBefore ?? null,
    p_expected_hash: expectedHash ?? null,
  })
  if (error) throw new Error(`Could not save: ${error.message}`)
  return data === true
}

/** Campaign service profile over the account one, field by field. */
export function mergedServiceProfile(
  campaign: TestCampaign,
  profile: { service_profile: Record<string, string | null> | null } | null
) {
  const a = (profile?.service_profile || {}) as Record<string, string | null>
  const c = (campaign.service_profile || {}) as Record<string, string | null>
  return {
    what_you_do: c.what_you_do || a.what_you_do || null,
    who_you_help: c.who_you_help || a.who_you_help || null,
    key_outcomes: c.key_outcomes || a.key_outcomes || null,
    minimum_threshold: c.minimum_threshold || a.minimum_threshold || null,
    geographic_focus: c.geographic_focus || a.geographic_focus || null,
  }
}
