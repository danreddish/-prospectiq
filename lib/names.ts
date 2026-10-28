/**
 * Apollo sometimes stores a professional credential in the surname field, so a
 * prospect comes back as "Jevon Rittech" when the person is Jevon Davies and
 * RITTech is a qualification. Stripping the credential is safer than guessing
 * a surname, so the name is shortened and the LinkedIn link carries the rest.
 *
 * Matching is case-sensitive and exact. Two-letter degrees such as MA, BA and
 * CA are deliberately absent, because they clash with real surnames like Ma.
 */
const CREDENTIAL_TOKENS: ReadonlySet<string> = new Set([
  'RITTech',
  'MBCS',
  'FBCS',
  'CITP',
  'CEng',
  'MIET',
  'FIET',
  'MBA',
  'PhD',
  'DPhil',
  'MSc',
  'BSc',
  'LLB',
  'LLM',
  'ACA',
  'FCA',
  'ACCA',
  'FCCA',
  'CFA',
  'CPA',
  'CIMA',
  'ACMA',
  'FCMA',
  'MRICS',
  'FRICS',
  'FRSA',
  'APFS',
  'FPFS',
  'CFP',
  'DipPFS',
  'DipFA',
  // UK wealth, investment and mortgage credentials common among ProspectIQ's
  // own prospects. 'Chartered' only ever appears here as part of a title such
  // as "Chartered FCSI", never as a surname.
  'Chartered',
  'FCSI',
  'MCSI',
  'ACSI',
  'CeMAP',
  'TEP',
  'CTA',
  'ACII',
  'FCII',
  'OBE',
  'MBE',
  'CBE',
  'KC',
  'QC',
])

/**
 * Removes trailing credential tokens from a person's name, including
 * comma-separated tails such as "Jane Smith, MBA, FCA". Never returns an
 * empty string for a non-empty input, and never strips the only token left.
 */
export function cleanPersonName(name: string | null | undefined): string {
  if (!name) return ''
  const original = name.trim()
  if (!original) return ''

  let tokens = original.split(/\s+/)

  while (tokens.length > 1) {
    const bare = tokens[tokens.length - 1].replace(/^,+/, '').replace(/,+$/, '')
    if (bare.length > 0 && CREDENTIAL_TOKENS.has(bare)) {
      tokens = tokens.slice(0, -1)
      continue
    }
    break
  }

  // A comma can be left dangling once a tail is removed: "Jane Smith," .
  const cleaned = tokens.join(' ').replace(/,+$/, '').trim()
  return cleaned || original
}

/** True when a display name carries more than a first name. */
export function hasSurname(name: string | null | undefined): boolean {
  if (!name) return false
  return name.trim().split(/\s+/).filter(Boolean).length > 1
}

export const SURNAME_MISSING_NOTE =
  'Surname not available. Use the LinkedIn link to find them.'
