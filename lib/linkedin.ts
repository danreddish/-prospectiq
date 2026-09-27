export type LinkedInLinkKind = 'profile' | 'search' | 'other'

/**
 * Tells a verified LinkedIn profile URL apart from the search fallback we
 * generate when Apollo returns no profile. Used to label the link honestly
 * rather than implying every link is a real profile.
 */
export function linkedInLinkKind(url: string | null | undefined): LinkedInLinkKind {
  if (!url) return 'other'
  const value = url.toLowerCase()
  if (value.includes('linkedin.com/in/')) return 'profile'
  if (value.includes('/search/')) return 'search'
  return 'other'
}

export function isLinkedInProfileUrl(url: string | null | undefined): boolean {
  return linkedInLinkKind(url) === 'profile'
}

export const LINKEDIN_SEARCH_TOOLTIP =
  'No verified profile found. This opens a LinkedIn search.'

/** Button or link label for a prospect's LinkedIn URL. */
export function linkedInLinkLabel(url: string | null | undefined): string {
  const kind = linkedInLinkKind(url)
  if (kind === 'profile') return 'View profile'
  if (kind === 'search') return 'Search LinkedIn'
  return 'Open link'
}

/** Tooltip for a prospect's LinkedIn URL, or undefined when none is needed. */
export function linkedInLinkTooltip(url: string | null | undefined): string | undefined {
  return linkedInLinkKind(url) === 'search' ? LINKEDIN_SEARCH_TOOLTIP : undefined
}
