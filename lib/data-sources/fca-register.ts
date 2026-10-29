/**
 * FCA Financial Services Register API Client
 *
 * Free API. Rate limit: 50 requests per 10 seconds.
 * Auth: X-Auth-Email = signup email, X-Auth-Key = API key
 */

const FCA_BASE_URL = 'https://register.fca.org.uk/services/V0.1'

let requestCount = 0
let windowStart = Date.now()

// Fetch with rate limiting. Returns parsed JSON or null on any failure.
// A 429 is retried once after a short wait (the register is rate limited).
async function fcaFetch(url: string, isRetry = false): Promise<Record<string, unknown> | null> {
  const apiKey = process.env.FCA_REGISTER_API_KEY
  if (!apiKey) return null

  // Rate limiting: max 40 per 10s window
  const now = Date.now()
  if (now - windowStart > 10000) {
    requestCount = 0
    windowStart = now
  }
  if (requestCount >= 40) {
    // v76: never sleep out the whole window. A serverless function has a
    // 10 second limit, and a full-window wait killed requests. The register
    // answered 70 parallel calls without a 429 in testing; a 429 is retried
    // once below.
    const waitMs = Math.min(1000, 10000 - (now - windowStart) + 200)
    await new Promise((r) => setTimeout(r, waitMs))
    requestCount = 0
    windowStart = Date.now()
  }
  requestCount++

  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'X-Auth-Email': process.env.FCA_REGISTER_EMAIL || '',
        'X-Auth-Key': apiKey,
      },
    })

    if (res.status === 429 && !isRetry) {
      await new Promise((r) => setTimeout(r, 1200))
      return fcaFetch(url, true)
    }

    if (!res.ok) return null

    // Read as text first to catch HTML responses
    const text = await res.text()
    if (!text || text.startsWith('<') || text.startsWith('<!')) return null

    return JSON.parse(text)
  } catch {
    return null
  }
}

// A lookup that failed (network error, non-200, 429 after the retry), as
// opposed to the register answering "not found". Callers that must not
// mistake an outage for a change (the watchlist) ask for strict mode.
export class FcaLookupError extends Error {
  constructor(url: string) {
    super(`FCA Register lookup failed: ${url.replace(FCA_BASE_URL, '')}`)
    this.name = 'FcaLookupError'
  }
}

// fcaFetch returns null only when the call itself failed. "Not found" is a
// 200 with Data null (verified 23/09/2026).
function assertFetched(data: Record<string, unknown> | null, url: string, strict: boolean | undefined): void {
  if (strict && data === null) throw new FcaLookupError(url)
}

// The register returns "Page Not found" / "... not found" with Data null for
// empty collections. Treat those as empty rather than as failures.
function isEmptyResponse(data: Record<string, unknown> | null): boolean {
  if (!data) return true
  return data.Data === null || data.Data === undefined
}

function resultTotal(data: Record<string, unknown> | null): number {
  const info = data?.ResultInfo as Record<string, string> | null | undefined
  const n = parseInt(info?.total_count || '0', 10)
  return Number.isFinite(n) ? n : 0
}

function resultHasNext(data: Record<string, unknown> | null): boolean {
  const info = data?.ResultInfo as Record<string, string> | null | undefined
  return !!info?.Next
}

// Register dates are DD/MM/YYYY. Convert to ISO (YYYY-MM-DD) or null.
export function fcaDateToIso(value: string | undefined | null): string | null {
  if (!value || typeof value !== 'string') return null
  const m = value.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})/)
  if (!m) return null
  return `${m[3]}-${m[2]}-${m[1]}`
}

// Firm URLs look like .../Firm/435779 -> "435779"
function frnFromUrl(url: string | undefined | null): string | null {
  if (!url || typeof url !== 'string') return null
  const m = url.match(/\/Firm\/(\d+)/)
  return m ? m[1] : null
}

function monthsBetween(fromIso: string, toDate: Date): number {
  const from = new Date(fromIso)
  if (Number.isNaN(from.getTime())) return 0
  const months = (toDate.getFullYear() - from.getFullYear()) * 12 + (toDate.getMonth() - from.getMonth())
  return Math.max(0, months)
}

// ── Types ────────────────────────────────────

export interface FCAFirmSearchResult {
  url: string
  status: string
  referenceNumber: string
  type: string
  name: string
}

export interface FCAFirmDetail {
  referenceNumber: string
  name: string
  status: string
  address?: {
    line1?: string
    line2?: string
    town?: string
    county?: string
    postcode?: string
    country?: string
  }
  phone?: string
  website?: string
}

export interface FCAIndividual {
  irn: string
  name: string
  status: string
  url: string
}

export interface FCAIndividualDetail {
  irn: string
  name: string
  status: string
  roles?: FCARole[]
}

export interface FCARole {
  firmName: string
  firmReference: string
  status: string
  function: string
  effectiveFrom?: string
}

// ── Search Functions ─────────────────────────

export async function searchFirms(
  query: string
): Promise<{ firms: FCAFirmSearchResult[]; totalCount: number }> {
  const encoded = query.trim().replace(/\s+/g, '+')
  const url = `${FCA_BASE_URL}/Search?q=${encoded}&type=firm`

  const data = await fcaFetch(url)
  if (!data) return { firms: [], totalCount: 0 }

  const rawData = data.Data as Record<string, string>[] | null
  const firms: FCAFirmSearchResult[] = (rawData || []).map((item) => ({
    url: item['URL'] || '',
    status: item['Status'] || '',
    referenceNumber: item['Reference Number'] || '',
    type: item['Type of business or Individual'] || '',
    name: (item['Name'] || '').replace(/\s*\(Postcode:.*?\)\s*$/, '').trim(),
  }))

  const info = data.ResultInfo as Record<string, string> | null
  const totalCount = parseInt(info?.total_count || '0', 10)
  return { firms, totalCount }
}

export async function getFirmDetail(frn: string): Promise<FCAFirmDetail | null> {
  const data = await fcaFetch(`${FCA_BASE_URL}/Firm/${frn}`)
  if (!data) return null

  const rawData = data.Data as Record<string, string>[] | null
  const firm = rawData?.[0] || {}

  let address: FCAFirmDetail['address']
  try {
    const addrUrl = firm['Address']
    if (addrUrl && typeof addrUrl === 'string') {
      const addrData = await fcaFetch(addrUrl)
      if (addrData) {
        const addrArray = addrData.Data as Record<string, unknown>[] | null
        const currentAddr = addrArray?.[0] as Record<string, unknown> | undefined
        const addrList = currentAddr?.['Current Address'] as Record<string, string>[] | undefined
        const addr = addrList?.[0]
        if (addr) {
          address = {
            line1: addr['Address Line 1'],
            line2: addr['Address Line 2'],
            town: addr['Town'],
            county: addr['County'],
            postcode: addr['Postcode'],
            country: addr['Country'],
          }
        }
      }
    }
  } catch {
    // Address is optional
  }

  return {
    referenceNumber: frn,
    name: (firm['Organisation Name'] || firm['Name'] || '') as string,
    status: (firm['Status'] || '') as string,
    address,
    phone: firm['Phone Number'] as string | undefined,
    website: firm['Website'] as string | undefined,
  }
}

export async function getFirmIndividuals(frn: string): Promise<FCAIndividual[]> {
  const data = await fcaFetch(`${FCA_BASE_URL}/Firm/${frn}/Individuals`)
  if (!data) return []

  const rawData = data.Data as Record<string, string>[] | null
  return (rawData || []).map((item) => ({
    irn: item['IRN'] || '',
    name: item['Name'] || '',
    status: item['Status'] || '',
    url: item['URL'] || '',
  }))
}

// Individual detail plus a flat list of current functions.
// Verified shape (v76): Data[0].Details holds the person, and the controlled
// function history lives at /Individuals/{irn}/CF as Previous/Current maps.
export async function getIndividualDetail(irn: string): Promise<FCAIndividualDetail | null> {
  const profile = await getIndividualProfile(irn)
  if (!profile) return null

  const functions = await getIndividualFunctions(irn)
  const roles: FCARole[] = functions.current.map((f) => ({
    firmName: f.firm_name,
    firmReference: f.frn || '',
    status: 'Current',
    function: f.name,
    effectiveFrom: f.effective_from || undefined,
  }))

  return {
    irn,
    name: profile.name,
    status: profile.status,
    roles,
  }
}

// ── High-Level Search Functions ──────────────

export async function findWealthFirms(
  searchTerms: string[],
  maxFirms: number = 20
): Promise<FCAFirmSearchResult[]> {
  const allFirms: FCAFirmSearchResult[] = []
  const seenFRNs: Record<string, boolean> = {}

  // Proven terms that return results from FCA Register
  const fallbackTerms = [
    'mortgage advisors',
    'independent financial advisers',
    'private client',
    'IFA',
    'wealth advisors',
    'advisory ltd',
    'mortgage solutions',
    'St. James',
    'Quilter',
    'Hargreaves',
  ]

  // Combine and deduplicate
  const combined = searchTerms.concat(fallbackTerms)
  const seen: Record<string, boolean> = {}
  const allTerms: string[] = []
  for (const t of combined) {
    const lower = t.toLowerCase().trim()
    if (lower && !seen[lower]) {
      seen[lower] = true
      allTerms.push(t.trim()) // Keep original case for API
    }
  }

  for (const term of allTerms) {
    try {
      const { firms } = await searchFirms(term)
      for (const firm of firms) {
        const isAuthorised = firm.status.toLowerCase().includes('authoris')
        if (isAuthorised && !seenFRNs[firm.referenceNumber]) {
          seenFRNs[firm.referenceNumber] = true
          allFirms.push(firm)
        }
        if (allFirms.length >= maxFirms) break
      }
      if (allFirms.length >= maxFirms) break
    } catch {
      continue
    }
  }

  return allFirms.slice(0, maxFirms)
}

export async function findIndividualsAtFirms(
  firms: FCAFirmSearchResult[],
  maxPerFirm: number = 10
): Promise<{
  firm: FCAFirmSearchResult
  individuals: FCAIndividual[]
}[]> {
  const results = []

  for (const firm of firms) {
    try {
      const individuals = await getFirmIndividuals(firm.referenceNumber)
      const active = individuals
        .filter((ind) => {
          const s = ind.status.toLowerCase()
          return s.includes('active') || s.includes('approved')
        })
        .slice(0, maxPerFirm)

      results.push({ firm, individuals: active })
    } catch {
      results.push({ firm, individuals: [] })
    }
  }

  return results
}

// ═══════════════════════════════════════════════════════════════
// Recruitment mode (v76): firms, appointed representatives,
// individuals and controlled function history.
//
// Every function below was written against live register responses
// (23/09/2026). Field names are the register's own, including the
// spaces and capitalisation. Dates arrive as DD/MM/YYYY and are
// converted to ISO on the way out.
// ═══════════════════════════════════════════════════════════════

export interface FCAFirmProfile {
  frn: string
  name: string
  status: string
  business_type: string | null
  status_effective_date: string | null
  companies_house_number: string | null
  address: {
    line1: string | null
    line2: string | null
    town: string | null
    county: string | null
    postcode: string | null
    country: string | null
  } | null
  phone: string | null
  website: string | null
}

export interface FCAIndividualProfile {
  irn: string
  name: string
  commonly_used_name: string | null
  status: string
  workplaces: { firm_name: string; location: string | null }[]
}

export interface FCAFunctionRecord {
  name: string
  firm_name: string
  frn: string | null
  effective_from: string | null
  end_date: string | null
  customer_facing: boolean
  engagement_method: string | null
  restriction: string | null
}

export interface FCAIndividualFunctions {
  current: FCAFunctionRecord[]
  previous: FCAFunctionRecord[]
}

export interface FCAAppointedRep {
  frn: string
  name: string
  effective_date: string | null
  termination_date: string | null
}

export interface FCACareerSignals {
  current_firm_name: string | null
  current_frn: string | null
  current_customer_function: FCAFunctionRecord | null
  tenure_months: number | null
  years_approved: number | null
  first_approved: string | null
  previous_firms: { name: string; frn: string | null; from: string | null; to: string | null }[]
  moves_count: number
}

// ── Firm search (paginated) ──────────────────

export async function searchFirmsPage(
  query: string,
  page: number = 1
): Promise<{ firms: FCAFirmSearchResult[]; totalCount: number; hasNext: boolean }> {
  const encoded = encodeURIComponent(query.trim())
  const url = `${FCA_BASE_URL}/Search?q=${encoded}&type=firm${page > 1 ? `&pgnp=${page}` : ''}`
  const data = await fcaFetch(url)
  if (isEmptyResponse(data)) return { firms: [], totalCount: 0, hasNext: false }

  const rawData = data!.Data as Record<string, string>[]
  const firms: FCAFirmSearchResult[] = (rawData || []).map((item) => ({
    url: item['URL'] || '',
    status: item['Status'] || '',
    referenceNumber: item['Reference Number'] || '',
    type: item['Type of business or Individual'] || '',
    name: (item['Name'] || '').replace(/\s*\(Postcode:.*?\)\s*$/, '').trim(),
  }))

  return { firms, totalCount: resultTotal(data), hasNext: resultHasNext(data) }
}

// Rank search hits for a firm the user named. Exact name first, then names
// that start with the query, then authorised firms, then ARs. Firms that are
// no longer authorised or no longer ARs go last.
export function rankFirmMatches(query: string, firms: FCAFirmSearchResult[]): FCAFirmSearchResult[] {
  const q = query.trim().toLowerCase()
  const norm = (s: string) => s.toLowerCase().replace(/\b(limited|ltd|llp|plc)\b/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
  const nq = norm(q)
  const score = (f: FCAFirmSearchResult): number => {
    const n = norm(f.name)
    const s = f.status.toLowerCase()
    let pts = 0
    if (n === nq) pts += 100
    else if (n.startsWith(nq)) pts += 60
    else if (n.includes(nq)) pts += 30
    if (s === 'authorised') pts += 20
    else if (s.startsWith('appointed representative')) pts += 10
    if (s.includes('no longer') || s.includes('revoked')) pts -= 50
    // Tie-breaker: advice firms over namesakes in other trades
    if (/mortgage|financial|advice|advis|wealth|planning|ifa|network|insurance|protection|invest/.test(n)) pts += 5
    return pts
  }
  return [...firms].sort((a, b) => score(b) - score(a))
}

// Resolve a firm the user named (or an FRN) to one register entry.
// Quoted phrase search first (the register's unquoted search is fuzzy and
// sorted by FRN, which buries "Mortgage Advice Bureau Limited" on page 12
// of 382 hits), then the plain search as a fallback.
export async function resolveFirm(
  nameOrFrn: string
): Promise<FCAFirmSearchResult | null> {
  const q = nameOrFrn.trim()
  if (!q) return null

  if (/^\d{5,7}$/.test(q)) {
    const { firms } = await searchFirmsPage(q, 1)
    return firms.find((f) => f.referenceNumber === q) || null
  }

  const scanned: FCAFirmSearchResult[] = []
  for (let page = 1; page <= 3; page++) {
    const r = await searchFirmsPage(`"${q.replace(/"/g, '')}"`, page)
    scanned.push(...r.firms)
    if (!r.hasNext) break
  }
  let ranked = rankFirmMatches(q, scanned)
  let top = ranked[0]
  if (top && !top.status.toLowerCase().includes('no longer') && !top.status.toLowerCase().includes('revoked')) {
    return top
  }

  const plain = await searchFirmsPage(q, 1)
  ranked = rankFirmMatches(q, plain.firms.filter((f) => {
    const s = f.status.toLowerCase()
    return !s.includes('no longer') && !s.includes('revoked')
  }))
  top = ranked[0]
  return top || null
}

// ── Firm profile (detail + address) ──────────

export async function getFirmProfile(
  frn: string,
  options: { includeAddress?: boolean; strict?: boolean } = {}
): Promise<FCAFirmProfile | null> {
  const includeAddress = options.includeAddress ?? true
  const url = `${FCA_BASE_URL}/Firm/${frn}`
  const [data, addrData] = await Promise.all([
    fcaFetch(url),
    includeAddress ? fcaFetch(`${FCA_BASE_URL}/Firm/${frn}/Address`) : Promise.resolve(null),
  ])
  assertFetched(data, url, options.strict)
  if (isEmptyResponse(data)) return null

  const firm = ((data!.Data as Record<string, unknown>[])?.[0] || {}) as Record<string, string>

  let address: FCAFirmProfile['address'] = null
  let phone: string | null = null
  let website: string | null = null
  if (!isEmptyResponse(addrData)) {
    const list = (addrData!.Data as Record<string, string>[]) || []
    const ppob = list.find((a) => (a['Address Type'] || '').toLowerCase().includes('principal')) || list[0]
    if (ppob) {
      address = {
        line1: ppob['Address Line 1'] || null,
        line2: ppob['Address Line 2'] || null,
        town: ppob['Town'] || null,
        county: ppob['County'] || null,
        postcode: ppob['Postcode'] || null,
        country: ppob['Country'] || null,
      }
      phone = ppob['Phone Number'] || null
      website = ppob['Website Address'] || null
    }
  }

  return {
    frn: firm['FRN'] || frn,
    name: firm['Organisation Name'] || '',
    status: firm['Status'] || '',
    business_type: firm['Business Type'] || null,
    status_effective_date: fcaDateToIso(firm['Status Effective Date']),
    companies_house_number: firm['Companies House Number'] || null,
    address,
    phone,
    website,
  }
}

// ── Firm individuals (paginated, 20 per register page) ──

export async function getFirmIndividualsPage(
  frn: string,
  page: number = 1
): Promise<{ individuals: FCAIndividual[]; totalCount: number; hasNext: boolean }> {
  const url = `${FCA_BASE_URL}/Firm/${frn}/Individuals${page > 1 ? `?pgnp=${page}` : ''}`
  const data = await fcaFetch(url)
  if (isEmptyResponse(data)) return { individuals: [], totalCount: 0, hasNext: false }

  const rawData = (data!.Data as Record<string, string>[]) || []
  const individuals = rawData.map((item) => ({
    irn: item['IRN'] || '',
    name: item['Name'] || '',
    status: item['Status'] || '',
    url: item['URL'] || '',
  }))
  return { individuals, totalCount: resultTotal(data), hasNext: resultHasNext(data) }
}

// Headcount only (one call). total_count on the individuals list.
export async function getFirmIndividualCount(frn: string): Promise<number | null> {
  const data = await fcaFetch(`${FCA_BASE_URL}/Firm/${frn}/Individuals`)
  if (!data) return null
  if (isEmptyResponse(data)) return 0
  return resultTotal(data)
}

// ── Appointed representatives (paginated, 10 per register page) ──
// The register returns current and previous ARs side by side. total_count is
// the combined figure, and the Current array becomes null once exhausted while
// Previous carries on.

export async function getFirmAppointedRepsPage(
  frn: string,
  page: number = 1,
  options: { strict?: boolean } = {}
): Promise<{ current: FCAAppointedRep[]; previous: FCAAppointedRep[]; totalCount: number; hasNext: boolean }> {
  const url = `${FCA_BASE_URL}/Firm/${frn}/AR${page > 1 ? `?pgnp=${page}` : ''}`
  const data = await fcaFetch(url)
  assertFetched(data, url, options.strict)
  if (isEmptyResponse(data)) return { current: [], previous: [], totalCount: 0, hasNext: false }

  const d = data!.Data as Record<string, Record<string, string>[] | null>
  const map = (list: Record<string, string>[] | null | undefined): FCAAppointedRep[] =>
    (list || []).map((ar) => ({
      frn: ar['FRN'] || frnFromUrl(ar['URL']) || '',
      name: ar['Name'] || '',
      effective_date: fcaDateToIso(ar['Effective Date']),
      termination_date: fcaDateToIso(ar['Termination Date']),
    }))

  return {
    current: map(d?.['CurrentAppointedRepresentatives']),
    previous: map(d?.['PreviousAppointedRepresentatives']),
    totalCount: resultTotal(data),
    hasNext: resultHasNext(data),
  }
}

// Count current ARs without walking every page. Page 1 answers small firms
// outright. Larger firms are binary searched for the last page that still
// has Current entries, capped at maxSteps extra calls. When the cap is hit
// the count is a floor and isMinimum is true.
export async function getFirmCurrentArCount(
  frn: string,
  maxSteps: number = 6,
  options: { strict?: boolean } = {}
): Promise<{ count: number; isMinimum: boolean }> {
  const first = await getFirmAppointedRepsPage(frn, 1, options)
  const perPage = 10
  if (first.current.length < perPage) return { count: first.current.length, isMinimum: false }

  const totalPages = Math.max(1, Math.ceil(first.totalCount / perPage))
  if (totalPages === 1) return { count: first.current.length, isMinimum: false }

  let lo = 1 // known to have current entries
  let hi = totalPages + 1 // known (assumed) empty
  let loCount = first.current.length
  let steps = 0
  while (hi - lo > 1 && steps < maxSteps) {
    const mid = Math.floor((lo + hi) / 2)
    const pageData = await getFirmAppointedRepsPage(frn, mid, options)
    steps++
    if (pageData.current.length > 0) {
      lo = mid
      loCount = pageData.current.length
    } else {
      hi = mid
    }
  }
  const isMinimum = hi - lo > 1
  // Floor: pages below lo are full, lo itself holds loCount.
  const count = (lo - 1) * perPage + loCount
  return { count, isMinimum }
}

// ── Firm permissions and requirements ───────

export async function getFirmPermissions(frn: string): Promise<string[]> {
  const data = await fcaFetch(`${FCA_BASE_URL}/Firm/${frn}/Permissions`)
  if (isEmptyResponse(data)) return []
  const d = data!.Data
  if (Array.isArray(d)) {
    // Defensive: some firms may come back as a list of {name: [...]} objects
    const names: string[] = []
    for (const item of d as Record<string, unknown>[]) {
      for (const k of Object.keys(item || {})) names.push(k)
    }
    return names
  }
  if (d && typeof d === 'object') return Object.keys(d as Record<string, unknown>)
  return []
}

// Many firms carry routine requirements that are not a sign of trouble:
// approval rights for financial promotions, and the standard consumer credit
// rule against canvassing off trade premises. These are counted but are not
// treated as restrictions for scoring.
function isStandardRequirement(text: string): boolean {
  const t = text.toLowerCase()
  return t.includes('financial promotions for own firm')
    || t.includes('can approve its own financial promotions')
    || t.includes('approve financial promotions')
    || t.includes('not permitted to canvass')
}

export async function getFirmRequirements(
  frn: string,
  options: { strict?: boolean } = {}
): Promise<{ count: number; restriction_count: number; items: string[] }> {
  const url = `${FCA_BASE_URL}/Firm/${frn}/Requirements`
  const data = await fcaFetch(url)
  assertFetched(data, url, options.strict)
  if (isEmptyResponse(data)) return { count: 0, restriction_count: 0, items: [] }
  const list = (data!.Data as Record<string, string>[]) || []
  const skip = new Set(['Effective Date', 'Requirement Reference', 'Financial Promotions Requirement'])
  const items = list.map((r) => {
    const descKey = Object.keys(r).find((k) => !skip.has(k))
    const desc = descKey ? `${descKey}: ${r[descKey]}` : r['Requirement Reference'] || 'Requirement'
    const eff = fcaDateToIso(r['Effective Date'])
    return eff ? `${desc} (from ${eff})` : desc
  })
  const restrictive = items.filter((i) => !isStandardRequirement(i))
  // Restrictive ones first so the UI and prompt show them before routine ones
  const ordered = restrictive.concat(items.filter((i) => isStandardRequirement(i)))
  return { count: Math.max(resultTotal(data), list.length), restriction_count: restrictive.length, items: ordered }
}

// ── Individuals ─────────────────────────────

export async function getIndividualProfile(
  irn: string,
  options: { strict?: boolean } = {}
): Promise<FCAIndividualProfile | null> {
  const url = `${FCA_BASE_URL}/Individuals/${irn}`
  const data = await fcaFetch(url)
  assertFetched(data, url, options.strict)
  if (isEmptyResponse(data)) return null
  const row = ((data!.Data as Record<string, unknown>[])?.[0] || {}) as Record<string, unknown>
  const details = (row['Details'] || {}) as Record<string, string>

  const workplaces: FCAIndividualProfile['workplaces'] = []
  for (const key of Object.keys(row)) {
    if (!/^Workplace Location/i.test(key)) continue
    const wp = row[key] as Record<string, string>
    if (wp?.['Firm Name']) {
      workplaces.push({ firm_name: wp['Firm Name'], location: wp['Location 1'] || null })
    }
  }

  return {
    irn: details['IRN'] || irn,
    name: details['Full Name'] || '',
    commonly_used_name: details['Commonly Used Name'] && details['Commonly Used Name'] !== 'None' ? details['Commonly Used Name'] : null,
    status: details['Status'] || '',
    workplaces,
  }
}

// Customer-facing test. The register marks customer engagement on the
// function itself, and the certification-regime function names are stable.
export function isCustomerFacingFunction(name: string, engagementMethod: string | null): boolean {
  if (engagementMethod && engagementMethod.trim()) return true
  const n = name.toLowerCase()
  if (/\bcf30\b/.test(n)) return true
  if (n.includes('requiring qualification')) return true
  if (n.includes('dealing with clients')) return true
  if (n.includes('customer function')) return true
  if (n.includes('advising') || n.includes('adviser') || n.includes('advisor')) return true
  return false
}

function parseFunctionMap(map: Record<string, Record<string, string>> | null | undefined, previous: boolean): FCAFunctionRecord[] {
  const out: FCAFunctionRecord[] = []
  for (const key of Object.keys(map || {})) {
    const cf = map![key]
    if (!cf) continue
    const name = cf['Name'] || key.replace(/^\(\d+\)/, '')
    const engagement = cf['Customer Engagement Method'] || null
    out.push({
      name,
      firm_name: cf['Firm Name'] || '',
      frn: frnFromUrl(cf['URL']),
      effective_from: fcaDateToIso(cf['Effective Date']),
      end_date: previous ? fcaDateToIso(cf['End Date']) : null,
      customer_facing: isCustomerFacingFunction(name, engagement),
      engagement_method: engagement,
      restriction: cf['Restriction'] || null,
    })
  }
  return out
}

export async function getIndividualFunctions(
  irn: string,
  options: { strict?: boolean } = {}
): Promise<FCAIndividualFunctions> {
  const url = `${FCA_BASE_URL}/Individuals/${irn}/CF`
  const data = await fcaFetch(url)
  assertFetched(data, url, options.strict)
  if (isEmptyResponse(data)) return { current: [], previous: [] }
  const row = ((data!.Data as Record<string, unknown>[])?.[0] || {}) as Record<string, unknown>
  return {
    current: parseFunctionMap(row['Current'] as Record<string, Record<string, string>> | undefined, false),
    previous: parseFunctionMap(row['Previous'] as Record<string, Record<string, string>> | undefined, true),
  }
}

export async function getIndividualDisciplinary(irn: string): Promise<{ found: boolean; detail: string | null }> {
  const data = await fcaFetch(`${FCA_BASE_URL}/Individuals/${irn}/DisciplinaryHistory`)
  if (isEmptyResponse(data)) return { found: false, detail: null }
  const list = data!.Data
  const text = JSON.stringify(list).slice(0, 600)
  return { found: true, detail: text }
}

export async function searchIndividuals(
  name: string
): Promise<{ irn: string; name: string; status: string }[]> {
  const encoded = encodeURIComponent(name.trim())
  const data = await fcaFetch(`${FCA_BASE_URL}/Search?q=${encoded}&type=individual`)
  if (isEmptyResponse(data)) return []
  const rawData = (data!.Data as Record<string, string>[]) || []
  return rawData
    .filter((r) => (r['Type of business or Individual'] || '').toLowerCase() === 'individual')
    .map((r) => ({
      irn: r['Reference Number'] || '',
      name: r['Name'] || '',
      status: r['Status'] || '',
    }))
}

// Pick the register hit that matches a name. Exact match on the full name
// wins; otherwise a hit whose tokens contain every token of the query.
export function pickIndividualMatch(
  name: string,
  hits: { irn: string; name: string; status: string }[]
): { irn: string; name: string; status: string } | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim()
  const target = norm(name)
  const targetTokens = target.split(' ').filter(Boolean)
  const active = hits.filter((h) => (h.status || '').toLowerCase() === 'active')
  const pool = active.length > 0 ? active : hits
  const exact = pool.find((h) => norm(h.name) === target)
  if (exact) return exact
  if (targetTokens.length < 2) return null
  const first = targetTokens[0]
  const last = targetTokens[targetTokens.length - 1]
  const loose = pool.filter((h) => {
    const t = norm(h.name).split(' ')
    return t[0] === first && t[t.length - 1] === last
  })
  return loose.length === 1 ? loose[0] : null
}

// ── Career signals derived from function history ──

export function deriveCareerSignals(functions: FCAIndividualFunctions, now: Date = new Date()): FCACareerSignals {
  const dated = (list: FCAFunctionRecord[]) => list.filter((f) => f.effective_from)

  // Current firm: prefer the current customer-facing function with a date,
  // then any current function with a date, then any current function.
  const currentCustomer = functions.current.filter((f) => f.customer_facing)
  const currentPick =
    dated(currentCustomer).sort((a, b) => (a.effective_from! < b.effective_from! ? -1 : 1))[0] ||
    currentCustomer[0] ||
    dated(functions.current).sort((a, b) => (a.effective_from! < b.effective_from! ? -1 : 1))[0] ||
    functions.current[0] ||
    null

  const currentFrn = currentPick?.frn || null
  const currentFirmName = currentPick?.firm_name || null

  // Tenure at the current firm: earliest dated function at that firm.
  let tenureMonths: number | null = null
  if (currentFrn || currentFirmName) {
    const atFirm = dated(functions.current).filter((f) =>
      currentFrn ? f.frn === currentFrn : f.firm_name === currentFirmName
    )
    const earliest = atFirm.map((f) => f.effective_from!).sort()[0]
    if (earliest) tenureMonths = monthsBetween(earliest, now)
  }

  // Years approved: earliest dated function anywhere.
  const allDates = [...dated(functions.current), ...dated(functions.previous)].map((f) => f.effective_from!).sort()
  const firstApproved = allDates[0] || null
  const yearsApproved = firstApproved ? Math.round((monthsBetween(firstApproved, now) / 12) * 10) / 10 : null

  // Previous firms: distinct firms in the previous list that are not the current firm.
  const prevByFirm = new Map<string, { name: string; frn: string | null; from: string | null; to: string | null }>()
  for (const f of functions.previous) {
    const key = f.frn || f.firm_name
    if (!key) continue
    if (currentFrn && f.frn === currentFrn) continue
    if (!currentFrn && currentFirmName && f.firm_name === currentFirmName) continue
    const existing = prevByFirm.get(key)
    if (!existing) {
      prevByFirm.set(key, { name: f.firm_name, frn: f.frn, from: f.effective_from, to: f.end_date })
    } else {
      if (f.effective_from && (!existing.from || f.effective_from < existing.from)) existing.from = f.effective_from
      if (f.end_date && (!existing.to || f.end_date > existing.to)) existing.to = f.end_date
    }
  }
  const previousFirms = Array.from(prevByFirm.values()).sort((a, b) => ((a.to || '') < (b.to || '') ? 1 : -1))

  return {
    current_firm_name: currentFirmName,
    current_frn: currentFrn,
    current_customer_function: currentCustomer[0] || null,
    tenure_months: tenureMonths,
    years_approved: yearsApproved,
    first_approved: firstApproved,
    previous_firms: previousFirms,
    moves_count: previousFirms.length,
  }
}

// ── Firm signals for scoring and watchlist snapshots ──

export interface FCAFirmSignalsResult {
  frn: string
  name: string
  status: string
  business_type: string | null
  individual_count: number | null
  ar_count: number | null
  ar_count_is_minimum: boolean
  requirement_count: number
  restriction_count: number
  requirements: string[]
  permissions: string[]
  town: string | null
  postcode: string | null
  status_effective_date: string | null
  fetched_at: string
}

export async function getFirmSignals(
  frn: string,
  options: { arSteps?: number; includePermissions?: boolean; includeAddress?: boolean } = {}
): Promise<FCAFirmSignalsResult | null> {
  const arSteps = options.arSteps ?? 6
  const includePermissions = options.includePermissions ?? true
  const includeAddress = options.includeAddress ?? true

  const [profile, individualCount, arCount, requirements, permissions] = await Promise.all([
    getFirmProfile(frn, { includeAddress }),
    getFirmIndividualCount(frn),
    getFirmCurrentArCount(frn, arSteps).catch(() => ({ count: 0, isMinimum: false })),
    getFirmRequirements(frn).catch(() => ({ count: 0, restriction_count: 0, items: [] as string[] })),
    includePermissions ? getFirmPermissions(frn).catch(() => []) : Promise.resolve([]),
  ])
  if (!profile) return null

  return {
    frn: profile.frn,
    name: profile.name,
    status: profile.status,
    business_type: profile.business_type,
    individual_count: individualCount,
    ar_count: arCount.count,
    ar_count_is_minimum: arCount.isMinimum,
    requirement_count: requirements.count,
    restriction_count: requirements.restriction_count,
    requirements: requirements.items.slice(0, 10),
    permissions,
    town: profile.address?.town || null,
    postcode: profile.address?.postcode || null,
    status_effective_date: profile.status_effective_date,
    fetched_at: new Date().toISOString(),
  }
}
