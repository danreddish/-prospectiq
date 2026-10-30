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

/**
 * Forces https, collapses duplicate slashes in the path and drops a trailing
 * slash. Apollo returns some profile URLs as http, which browsers and some
 * corporate proxies treat differently from the https original.
 *
 * Returns null for empty input so callers can store null rather than ''.
 */
export function normaliseLinkedInUrl(url: string | null | undefined): string | null {
  if (!url) return null
  const trimmed = url.trim()
  if (!trimmed) return null

  // http:// and protocol-relative and scheme-less values all become https://.
  let value = trimmed.replace(/^https?:\/\//i, 'https://')
  if (!/^https:\/\//i.test(value)) {
    value = `https://${value.replace(/^\/+/, '')}`
  }

  const rest = value.slice('https://'.length)
  const markerIndex = rest.search(/[?#]/)
  const path = markerIndex === -1 ? rest : rest.slice(0, markerIndex)
  const suffix = markerIndex === -1 ? '' : rest.slice(markerIndex)

  // Trailing slashes are only trimmed when there is no query or fragment, so
  // search URLs keep the shape LinkedIn expects.
  let cleanedPath = path.replace(/\/{2,}/g, '/')
  if (!suffix) cleanedPath = cleanedPath.replace(/\/+$/, '')
  if (!cleanedPath) return null

  return `https://${cleanedPath}${suffix}`
}

/**
 * v77: the profile name from a /in/ URL, lower-cased and URL-decoded, e.g.
 * "jane-smith-123" from https://www.linkedin.com/in/Jane-Smith-123/. Used to
 * match the same person across Apollo, Ulinc and HeyReach, which differ in
 * case, trailing slashes, query strings and http/https. Returns null for
 * search links, Sales Navigator links and anything else that isn't /in/.
 */
export function linkedInProfileSlug(url: string | null | undefined): string | null {
  if (!url) return null
  const match = url.trim().match(/linkedin\.com\/in\/([^/?#\s]+)/i)
  if (!match) return null
  let slug = match[1]
  try {
    slug = decodeURIComponent(slug)
  } catch {
    // keep the raw slug if it isn't valid percent-encoding
  }
  slug = slug.trim().toLowerCase()
  return slug || null
}

/**
 * v77: the clean profile URL for a slug, https://www.linkedin.com/in/<slug>,
 * with no query string or extra path. This is what goes to HeyReach.
 */
export function canonicalProfileUrl(url: string | null | undefined): string | null {
  const slug = linkedInProfileSlug(url)
  return slug ? `https://www.linkedin.com/in/${encodeURIComponent(slug)}` : null
}
