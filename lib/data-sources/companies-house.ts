/**
 * Companies House REST API Client
 *
 * Free API key from: https://developer.company-information.service.gov.uk/
 * Used to find HNW prospects: company directors, PSCs, and officers.
 */

const CH_BASE_URL = 'https://api.company-information.service.gov.uk'

// Safe fetch with auth - returns parsed JSON or null
async function chFetch(path: string): Promise<Record<string, unknown> | null> {
  const key = process.env.COMPANIES_HOUSE_API_KEY
  if (!key) return null

  const auth = Buffer.from(`${key}:`).toString('base64')

  try {
    const res = await fetch(`${CH_BASE_URL}${path}`, {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
      },
    })

    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 2000))
      const retry = await fetch(`${CH_BASE_URL}${path}`, {
        headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
      })
      if (!retry.ok) return null
      const text = await retry.text()
      if (!text || text.startsWith('<')) return null
      return JSON.parse(text)
    }

    if (!res.ok) return null

    const text = await res.text()
    if (!text || text.startsWith('<')) return null
    return JSON.parse(text)
  } catch {
    return null
  }
}

// ── Types ────────────────────────────────────

export interface CHCompanySearchResult {
  companyNumber: string
  title: string
  companyStatus: string
  companyType: string
  addressSnippet: string
  locality?: string
  postalCode?: string
  region?: string
  dateOfCreation?: string
  sicCodes?: string[]
}

export interface CHCompanyProfile {
  companyNumber: string
  companyName: string
  companyStatus: string
  type: string
  address?: {
    line1?: string
    line2?: string
    locality?: string
    postalCode?: string
    region?: string
    country?: string
  }
  sicCodes?: string[]
  dateOfCreation?: string
  accountsType?: string
}

export interface CHOfficer {
  name: string
  officerRole: string
  appointedOn?: string
  nationality?: string
  occupation?: string
  locality?: string
  postalCode?: string
  region?: string
  dateOfBirth?: { month?: number; year?: number }
}

// ── Core Functions ───────────────────────────

export async function searchCompanies(
  query: string,
  itemsPerPage: number = 20
): Promise<CHCompanySearchResult[]> {
  const data = await chFetch(`/search/companies?q=${encodeURIComponent(query)}&items_per_page=${itemsPerPage}`)
  if (!data) return []

  const items = data.items as Record<string, unknown>[] | undefined
  return (items || []).map((item) => {
    const addr = item.address as Record<string, string> | undefined
    return {
      companyNumber: (item.company_number || '') as string,
      title: (item.title || '') as string,
      companyStatus: (item.company_status || '') as string,
      companyType: (item.company_type || '') as string,
      addressSnippet: (item.address_snippet || '') as string,
      locality: addr?.locality,
      postalCode: addr?.postal_code,
      region: addr?.region,
      dateOfCreation: item.date_of_creation as string | undefined,
      sicCodes: item.sic_codes as string[] | undefined,
    }
  })
}

export async function getCompanyProfile(companyNumber: string): Promise<CHCompanyProfile | null> {
  const data = await chFetch(`/company/${companyNumber}`)
  if (!data) return null

  const addr = data.registered_office_address as Record<string, string> | undefined
  return {
    companyNumber: (data.company_number || '') as string,
    companyName: (data.company_name || '') as string,
    companyStatus: (data.company_status || '') as string,
    type: (data.type || '') as string,
    address: addr ? {
      line1: addr.address_line_1,
      line2: addr.address_line_2,
      locality: addr.locality,
      postalCode: addr.postal_code,
      region: addr.region,
      country: addr.country,
    } : undefined,
    sicCodes: data.sic_codes as string[] | undefined,
    dateOfCreation: data.date_of_creation as string | undefined,
    accountsType: (data.accounts as Record<string, unknown>)?.last_accounts
      ? ((data.accounts as Record<string, Record<string, string>>).last_accounts?.type)
      : undefined,
  }
}

export async function getCompanyOfficers(companyNumber: string): Promise<CHOfficer[]> {
  const data = await chFetch(`/company/${companyNumber}/officers?items_per_page=50`)
  if (!data) return []

  const items = data.items as Record<string, unknown>[] | undefined
  return (items || [])
    .filter((item) => !item.resigned_on) // Only current officers
    .map((item) => {
      const addr = item.address as Record<string, string> | undefined
      const dob = item.date_of_birth as Record<string, number> | undefined
      return {
        name: (item.name || '') as string,
        officerRole: (item.officer_role || '') as string,
        appointedOn: item.appointed_on as string | undefined,
        nationality: item.nationality as string | undefined,
        occupation: item.occupation as string | undefined,
        locality: addr?.locality,
        postalCode: addr?.postal_code,
        region: addr?.region,
        dateOfBirth: dob ? { month: dob.month, year: dob.year } : undefined,
      }
    })
}

// ── Wealth Signal Helpers ────────────────────

// Account type indicates company size (micro, small, medium, large, etc.)
export function getCompanySizeFromAccounts(accountsType?: string): string {
  if (!accountsType) return 'unknown'
  const t = accountsType.toLowerCase()
  if (t.includes('full') || t.includes('group')) return 'large'
  if (t.includes('medium')) return 'medium'
  if (t.includes('small')) return 'small'
  if (t.includes('micro') || t.includes('dormant')) return 'micro'
  return 'unknown'
}

// Estimate age from date of birth
export function estimateAge(dob?: { month?: number; year?: number }): number | null {
  if (!dob?.year) return null
  const now = new Date()
  let age = now.getFullYear() - dob.year
  if (dob.month && now.getMonth() + 1 < dob.month) age--
  return age
}

// Check if officer is a director (not secretary, etc.)
export function isDirector(role: string): boolean {
  const r = role.toLowerCase()
  return r.includes('director') || r.includes('member') || r.includes('partner')
}
