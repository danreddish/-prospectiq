/**
 * Apollo.io API Client
 *
 * People Search: find prospects globally (free, no credits used for search)
 * People Match by ID: enrich with full details (1 credit per person)
 * Free tier: 10,000 credits/year.
 */

const APOLLO_BASE = 'https://api.apollo.io/v1'

function getApiKey(): string | null {
  return process.env.APOLLO_API_KEY || null
}

async function apolloFetch(path: string, body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const apiKey = getApiKey()
  if (!apiKey) return null

  try {
    const res = await fetch(`${APOLLO_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': apiKey,
      },
      body: JSON.stringify({ ...body, api_key: apiKey }),
    })
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      console.error(`Apollo ${path} failed: ${res.status} ${errText.slice(0, 200)}`)
      return null
    }
    return await res.json()
  } catch (err) {
    console.error(`Apollo ${path} error:`, err)
    return null
  }
}

// ── Types ────────────────────────────────────

export interface ApolloEnrichResult {
  linkedin_url: string | null
  email: string | null
  phone: string | null
  title: string | null
  headline: string | null
  photo_url: string | null
  city: string | null
  name: string | null
  first_name: string | null
  last_name: string | null
  company: string | null
  location: string | null
}

export interface ApolloProspect {
  name: string
  role: string
  company: string
  location: string
  linkedin_url: string
  email: string | null
  phone: string | null
  headline: string | null
  source: string
  confidence: number
}

// ── People Search (global, free) ─────────────

export interface ApolloSearchParams {
  person_locations?: string[]
  person_seniorities?: string[]
  person_titles?: string[]
  q_organization_keyword_tags?: string[]
  organization_num_employees_ranges?: string[]
  q_keywords?: string
  per_page?: number
  page?: number
}

export async function searchPeople(params: ApolloSearchParams): Promise<{
  people: { id: string; first_name: string; title: string; org_name: string }[]
  totalEntries: number
}> {
  const data = await apolloFetch('/mixed_people/api_search', {
    ...params,
    per_page: params.per_page || 25,
    page: params.page || 1,
  })

  if (!data) return { people: [], totalEntries: 0 }

  const rawPeople = data.people as Record<string, unknown>[] | undefined
  const people = (rawPeople || []).map((p) => ({
    id: (p.id as string) || '',
    first_name: (p.first_name as string) || '',
    title: (p.title as string) || '',
    org_name: ((p.organization as Record<string, string>)?.name) || '',
  }))

  return {
    people,
    totalEntries: (data.total_entries as number) || 0,
  }
}

// ── Single Enrichment by Name + Company ──────

export async function enrichWithApollo(
  firstName: string,
  lastName: string,
  companyName: string
): Promise<ApolloEnrichResult | null> {
  const data = await apolloFetch('/people/match', {
    first_name: firstName,
    last_name: lastName,
    organization_name: companyName,
  })
  return parsePersonResult(data)
}

// ── Single Enrichment by Apollo ID ───────────

export async function enrichById(apolloId: string): Promise<ApolloEnrichResult | null> {
  const data = await apolloFetch('/people/match', {
    id: apolloId,
  })
  return parsePersonResult(data)
}

// ── Single Enrichment by LinkedIn URL ────────

export async function enrichByLinkedInUrl(linkedinUrl: string): Promise<ApolloEnrichResult | null> {
  const data = await apolloFetch('/people/match', {
    linkedin_url: linkedinUrl,
  })
  return parsePersonResult(data)
}

// ── Full Profile Enrichment by LinkedIn URL ──
// Returns standard enrich result plus raw employment history for AI parsing

export interface ApolloFullProfile extends ApolloEnrichResult {
  employment_history: { title: string; company: string; start_date: string; end_date: string | null; current: boolean }[]
  seniority: string | null
  departments: string[]
  org_industry: string | null
  org_website: string | null
}

export async function enrichFullProfileByLinkedInUrl(linkedinUrl: string): Promise<ApolloFullProfile | null> {
  const data = await apolloFetch('/people/match', {
    linkedin_url: linkedinUrl,
  })
  if (!data) return null
  const person = data.person as Record<string, unknown> | undefined
  if (!person) return null

  const base = parsePersonResult(data)
  if (!base) return null

  const org = person.organization as Record<string, unknown> | undefined
  const employmentHistory = (person.employment_history as Record<string, unknown>[] | undefined) || []

  return {
    ...base,
    employment_history: employmentHistory.map((e) => ({
      title: (e.title as string) || '',
      company: (e.organization_name as string) || '',
      start_date: (e.start_date as string) || '',
      end_date: (e.end_date as string) || null,
      current: (e.current as boolean) || false,
    })),
    seniority: (person.seniority as string) || null,
    departments: (person.departments as string[]) || [],
    org_industry: (org?.industry as string) || null,
    org_website: (org?.website_url as string) || null,
  }
}

// ── Parse Apollo person response ─────────────

function parsePersonResult(data: Record<string, unknown> | null): ApolloEnrichResult | null {
  if (!data) return null
  const person = data.person as Record<string, unknown> | undefined
  if (!person) return null

  const org = person.organization as Record<string, unknown> | undefined
  const city = (person.city as string) || ''
  const country = (person.country as string) || ''

  return {
    linkedin_url: (person.linkedin_url as string) || null,
    email: (person.email as string) || null,
    phone: extractPhone(person),
    title: (person.title as string) || null,
    headline: (person.headline as string) || null,
    photo_url: (person.photo_url as string) || null,
    city,
    name: (person.name as string) || `${person.first_name || ''} ${person.last_name || ''}`.trim() || null,
    first_name: (person.first_name as string) || null,
    last_name: (person.last_name as string) || null,
    company: (org?.name as string) || null,
    location: [city, country].filter(Boolean).join(', ') || null,
  }
}

function extractPhone(person: Record<string, unknown>): string | null {
  if (person.phone_number) return person.phone_number as string
  if (person.sanitized_phone) return person.sanitized_phone as string
  const phones = person.phone_numbers as { sanitized_number?: string; raw_number?: string }[] | undefined
  if (phones && phones.length > 0) return phones[0].sanitized_number || phones[0].raw_number || null
  const org = person.organization as Record<string, unknown> | undefined
  if (org?.phone) return org.phone as string
  const primaryPhone = org?.primary_phone as Record<string, string> | undefined
  if (primaryPhone?.number) return primaryPhone.number
  return null
}
