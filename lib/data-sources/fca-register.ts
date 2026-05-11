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
async function fcaFetch(url: string): Promise<Record<string, unknown> | null> {
  const apiKey = process.env.FCA_REGISTER_API_KEY
  if (!apiKey) return null

  // Rate limiting: max 40 per 10s window
  const now = Date.now()
  if (now - windowStart > 10000) {
    requestCount = 0
    windowStart = now
  }
  if (requestCount >= 40) {
    const waitMs = 10000 - (now - windowStart) + 200
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

    if (!res.ok) return null

    // Read as text first to catch HTML responses
    const text = await res.text()
    if (!text || text.startsWith('<') || text.startsWith('<!')) return null

    return JSON.parse(text)
  } catch {
    return null
  }
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

export async function getIndividualDetail(irn: string): Promise<FCAIndividualDetail | null> {
  const data = await fcaFetch(`${FCA_BASE_URL}/Individuals/${irn}`)
  if (!data) return null

  const rawData = data.Data as Record<string, string>[] | null
  const individual = rawData?.[0] || {}

  const roles: FCARole[] = []
  try {
    const cfUrl = individual['Controlled Functions'] || individual['CF']
    if (cfUrl && typeof cfUrl === 'string') {
      const cfData = await fcaFetch(cfUrl)
      if (cfData) {
        const cfArray = cfData.Data as Record<string, string>[] | null
        for (const cf of cfArray || []) {
          roles.push({
            firmName: cf['Firm Name'] || '',
            firmReference: cf['Firm Reference Number'] || '',
            status: cf['Status'] || '',
            function: cf['Controlled Function'] || cf['Function'] || '',
            effectiveFrom: cf['Effective From'],
          })
        }
      }
    }
  } catch {
    // Roles are optional
  }

  return {
    irn,
    name: (individual['Full Name'] || individual['Name'] || '') as string,
    status: (individual['Status'] || '') as string,
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
