// v81: deep research, the parts with no network calls. Matching a prospect
// to a Companies House company and its officers, and working out from the
// directors and owners whether this person decides alone. Kept pure so it
// can be tested without any API.

import type { CHOfficer, CHPsc } from '../data-sources/companies-house'

const LEGAL_WORDS = new Set(['ltd', 'limited', 'llp', 'plc', 'lp', 'the', 'and', 'co', 'company', 'uk'])

/** "Sweeny Wealth Management Ltd." -> "sweeny wealth management" */
export function normaliseCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\|.*$/, '') // "Somerset Wealth Management | B Corp"
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !LEGAL_WORDS.has(w))
    .join(' ')
    .trim()
}

/** Same firm name, ignoring legal endings, punctuation and "&" against "and". */
export function sameCompanyName(a: string, b: string): boolean {
  const na = normaliseCompanyName(a)
  const nb = normaliseCompanyName(b)
  return !!na && na === nb
}

/** Every word of the shorter name appears in the longer one, at least two words. */
export function similarCompanyName(a: string, b: string): boolean {
  const wa = normaliseCompanyName(a).split(' ').filter(Boolean)
  const wb = normaliseCompanyName(b).split(' ').filter(Boolean)
  if (wa.length === 0 || wb.length === 0) return false
  const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa]
  if (short.length < 2) return short[0] === long[0] && long.length <= 2
  return short.every((w) => long.includes(w))
}

// Letters after a name that Apollo sometimes returns as the surname.
const CREDENTIALS = new Set([
  'cfp', 'fpfs', 'apfs', 'dippfs', 'ifa', 'mifs', 'acii', 'fcii', 'mcsi', 'fcsi', 'cfa', 'mba', 'bsc', 'ba', 'ma',
  'chartered', 'adviser', 'advisor', 'planner', 'certs', 'cemap', 'tep', 'aca', 'fca', 'acca',
])

export interface PersonName {
  first: string
  /** Empty when the stored surname is really a qualification ("Robin Cfp"). */
  last: string
}

export function parseProspectName(name: string): PersonName {
  const parts = name
    .replace(/[™®.,()]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  const first = (parts[0] || '').toLowerCase()
  const lastRaw = parts.length > 1 ? parts[parts.length - 1].toLowerCase() : ''
  return { first, last: CREDENTIALS.has(lastRaw) ? '' : lastRaw }
}

/** Companies House writes "SURNAME, Forename Middle". */
export function parseOfficerName(name: string): { first: string; last: string; display: string } | null {
  const comma = name.indexOf(',')
  if (comma < 0) return null // a company acting as an officer
  const last = name.slice(0, comma).trim()
  const forenames = name.slice(comma + 1).trim().replace(/^(mr|mrs|ms|miss|dr)\.?\s+/i, '')
  const first = forenames.split(/\s+/)[0] || ''
  if (!first || !last) return null
  const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
  return {
    first: first.toLowerCase(),
    last: last.toLowerCase(),
    display: `${cap(first)} ${last.split(/([ -])/).map((w) => (w === ' ' || w === '-' ? w : cap(w))).join('')}`,
  }
}

/** Tim and Timothy, Rob and Robert: one starts the other, three letters or more. */
function firstNamesAgree(a: string, b: string): boolean {
  if (!a || !b) return false
  if (a === b) return true
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  return short.length >= 3 && long.startsWith(short)
}

export type PersonMatch =
  | { matched: true; by: 'full name' | 'first name only'; officerName: string }
  | { matched: false }

/** Is this prospect one of these people? `names` are Companies House style. */
export function matchPerson(prospectName: string, names: string[]): PersonMatch {
  const p = parseProspectName(prospectName)
  const parsed = names.map(parseOfficerName).filter((o): o is NonNullable<typeof o> => !!o)
  if (p.last) {
    const hit = parsed.find((o) => (o.last === p.last || o.last.split(/[ -]/).includes(p.last)) && firstNamesAgree(o.first, p.first))
    if (hit) return { matched: true, by: 'full name', officerName: hit.display }
    // Surname agrees and there is only one person with it: a middle name used as a first name.
    const bySurname = parsed.filter((o) => o.last === p.last)
    if (bySurname.length === 1 && bySurname[0].first.charAt(0) === p.first.charAt(0)) {
      return { matched: true, by: 'full name', officerName: bySurname[0].display }
    }
    return { matched: false }
  }
  // No usable surname: accept a first-name match only when it is the only one.
  const byFirst = parsed.filter((o) => firstNamesAgree(o.first, p.first))
  if (byFirst.length === 1) return { matched: true, by: 'first name only', officerName: byFirst[0].display }
  return { matched: false }
}

export type DecisionVerdict = 'sole' | 'holding' | 'shared' | 'board' | 'group' | 'not_director' | 'unknown'

export interface DecisionMaker {
  verdict: DecisionVerdict
  /** One plain sentence for the dashboard and for the AI. */
  summary: string
  directors: string[]
  owners: string[]
  /** Their name as Companies House has it, when matched. */
  registeredName: string | null
}

function isDirectorRole(role: string): boolean {
  const r = role.toLowerCase()
  return r.includes('director') || r === 'llp-member' || r === 'llp-designated-member'
}

/**
 * Does this person decide alone? From current directors and owners only:
 *   sole          the only director
 *   shared        one of two directors
 *   board         three or more directors
 *   holding       the only director, but the shares sit in another company
 *   group         owned or controlled by another company, with other directors
 *   not_director  the firm matched but they are not a director of it
 *   unknown       no Companies House record matched
 */
export function assessDecisionMaker(
  prospectName: string,
  companyName: string,
  officers: CHOfficer[] | null,
  pscs: CHPsc[] | null
): DecisionMaker {
  if (!officers) {
    return { verdict: 'unknown', summary: 'No Companies House record was matched, so who decides is not known.', directors: [], owners: [], registeredName: null }
  }
  const directorOfficers = officers.filter((o) => isDirectorRole(o.officerRole))
  const directors = directorOfficers.map((o) => parseOfficerName(o.name)?.display || o.name)
  const owners = (pscs || []).map((p) => (p.kind === 'individual' ? parseOwnerName(p.name) : p.name))
  const person = matchPerson(prospectName, directorOfficers.map((o) => o.name))
  const registeredName = person.matched ? person.officerName : null
  const corporateOwner = (pscs || []).find((p) => p.kind === 'corporate')
  const base = { directors, owners, registeredName }
  const first = prospectName.split(/\s+/)[0]

  // The only director, with the shares in another company: often their own
  // holding company, sometimes a group. Not marked down as hard as a group.
  if (corporateOwner && person.matched && directors.length === 1) {
    return {
      verdict: 'holding',
      summary: `${first} is the only director of ${companyName}, which is owned through ${corporateOwner.name}. If that is ${first}'s own holding company there is no board to consult. Worth a check.`,
      ...base,
    }
  }
  if (corporateOwner) {
    return { verdict: 'group', summary: `${companyName} is owned or controlled by ${corporateOwner.name}, so decisions are likely to involve the parent company.`, ...base }
  }
  if (!person.matched) {
    return {
      verdict: 'not_director',
      summary: directors.length
        ? `${first} is not listed as a director of ${companyName}. The directors are ${listNames(directors)}.`
        : `${companyName} has no current directors listed, so who decides is not known.`,
      ...base,
    }
  }
  if (directors.length === 1) {
    return { verdict: 'sole', summary: `${first} is the only director of ${companyName}, so there is no board to consult.`, ...base }
  }
  if (directors.length === 2) {
    const other = directors.find((d) => d !== person.officerName) || directors[1]
    return { verdict: 'shared', summary: `${first} is one of two directors of ${companyName}. The other is ${other}.`, ...base }
  }
  return { verdict: 'board', summary: `${companyName} has ${directors.length} directors (${listNames(directors)}), so a decision is likely to be discussed between them.`, ...base }
}

/** PSC names come as "Mr John Andrew Smith". */
function parseOwnerName(name: string): string {
  return name.replace(/^(mr|mrs|ms|miss|dr)\.?\s+/i, '').trim()
}

function listNames(names: string[]): string {
  const shown = names.slice(0, 5)
  const more = names.length - shown.length
  return shown.join(', ') + (more > 0 ? ` and ${more} more` : '')
}

/** Accessibility is tied to the decision-maker check, not left to the AI. */
export function accessibilityBounds(verdict: DecisionVerdict): { min: number; max: number } {
  switch (verdict) {
    case 'sole': return { min: 8, max: 10 }
    case 'shared': return { min: 5, max: 8 }
    case 'holding': return { min: 4, max: 8 }
    case 'board':
    case 'group':
    case 'not_director': return { min: 1, max: 3 }
    default: return { min: 1, max: 7 }
  }
}

/** Whole years from a Companies House month and year of birth. */
export function ageFromDob(dob: { month?: number; year?: number } | undefined, now: Date = new Date()): number | null {
  if (!dob?.year) return null
  let age = now.getFullYear() - dob.year
  if (dob.month && now.getMonth() + 1 < dob.month) age -= 1
  return age > 15 && age < 110 ? age : null
}
