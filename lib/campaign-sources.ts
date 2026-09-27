import type { CampaignSource } from '@/types'

export interface CampaignSourceOption {
  key: CampaignSource
  /** Full card label, e.g. on the campaign setup step. */
  label: string
  /** Long one-line description used on the setup step cards. */
  detail: string
  /** Compact description used on the Find step cards. */
  compactDetail: string
  /** Short label used for the badge on the campaigns list. */
  badgeLabel: string
  /** Plain English guidance on what this source is actually good at. */
  bestFor: string
}

export const CAMPAIGN_SOURCES: CampaignSourceOption[] = [
  {
    key: 'hnw_clients',
    label: 'HNW Clients (UK)',
    detail: 'Company directors from Companies House',
    compactDetail: 'Companies House',
    badgeLabel: 'Companies House',
    bestFor: "Best for: directors of UK companies by sector and location. Can't identify founders or job titles.",
  },
  {
    key: 'financial_professionals',
    label: 'Financial Pros (UK)',
    detail: 'IFAs, wealth managers from FCA Register',
    compactDetail: 'FCA Register',
    badgeLabel: 'FCA Register',
    bestFor: 'Best for: FCA-registered advisers and firms.',
  },
  {
    key: 'global_prospects',
    label: 'Global Prospects',
    detail: 'Directors and executives worldwide via Apollo',
    compactDetail: 'Apollo 270M+',
    badgeLabel: 'Global',
    bestFor: 'Best for: job titles like founder, CEO or partner, in the UK or worldwide.',
  },
]

/**
 * Badge label for a stored campaigns.source value. Older campaigns were
 * created before the column existed, so null is expected.
 */
export function campaignSourceBadgeLabel(source: string | null | undefined): string {
  const match = CAMPAIGN_SOURCES.find((s) => s.key === source)
  return match ? match.badgeLabel : 'Unknown'
}

/**
 * Role words Companies House cannot search on. Companies House indexes
 * company names and only tells us that someone is a director, so an ICP
 * written in job titles will not match well.
 *
 * Plain client-side regex, whole words, case-insensitive. No AI call.
 */
export const ROLE_WORD_REGEX =
  /\b(?:founders?|co-founders?|ceos?|ctos?|cfos?|coos?|chief|vps?|head of|partners?)\b/i

export function mentionsJobTitle(text: string): boolean {
  return ROLE_WORD_REGEX.test(text)
}
