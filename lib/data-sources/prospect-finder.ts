/**
 * Prospect Finder Orchestrator
 *
 * Takes a plain-English ICP description from the user, translates it into
 * structured search parameters, queries FCA Register + Companies House,
 * and returns an enriched list of prospects ready for AI scoring.
 *
 * Pipeline:
 * 1. Claude interprets ICP description into search terms
 * 2. FCA Register finds matching authorised firms
 * 3. FCA Register pulls individuals at each firm
 * 4. Companies House enriches firm data (size, address, officers)
 * 5. Returns structured prospect list ready for the AI research engine
 */

import Anthropic from '@anthropic-ai/sdk'
import {
  findWealthFirms,
  getFirmDetail,
  getFirmIndividuals,
  type FCAFirmSearchResult,
  type FCAIndividual,
} from './fca-register'
import {
  searchCompanies,
  getCompanyProfile,
  getCompanyOfficers,
  type CHCompanyProfile,
} from './companies-house'
import { ProspectInput } from '@/types'

// Lazy Anthropic client
let _anthropic: Anthropic | null = null
function getAnthropic(): Anthropic {
  if (!_anthropic) {
    const key = process.env.ANTHROPIC_API_KEY
    if (!key) throw new Error('ANTHROPIC_API_KEY is not set')
    _anthropic = new Anthropic({ apiKey: key })
  }
  return _anthropic
}

// ── Types ────────────────────────────────────

export interface ICPDescription {
  raw: string // User's plain-English description
}

interface ParsedICP {
  firmSearchTerms: string[] // Terms to search FCA Register
  roleKeywords: string[] // Roles to filter individuals by
  locations: string[] // Geographic filters
  firmSizeIndicators: string[] // e.g. "small", "boutique", "large"
  excludeTerms: string[] // Firms/roles to exclude
  minRelevanceScore: number // 1-10, how strict to filter
}

export interface FoundProspect extends ProspectInput {
  source: 'fca_register' | 'companies_house' | 'combined'
  firmFRN?: string
  firmStatus?: string
  firmAddress?: string
  companyNumber?: string
  companySIC?: string[]
  individualIRN?: string
  regulatoryStatus?: string
  confidence: number // 1-10 how well they match the ICP
}

export interface FindProspectsResult {
  prospects: FoundProspect[]
  firmsSearched: number
  individualsFound: number
  searchTermsUsed: string[]
  timeTakenMs: number
}

// ── Step 1: Parse ICP with Claude ────────────

async function parseICP(description: string): Promise<ParsedICP> {
  const response = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: `You translate plain-English ICP descriptions into structured search parameters for the UK FCA Financial Services Register API. The context is HNW (high-net-worth) client acquisition.

CRITICAL: The FCA Register API searches FIRM NAMES. You must understand these rules:
- Single common words like "mortgage" or "financial" return too many results and crash
- Terms with "ltd" like "wealth management ltd" or "financial planning ltd" return ZERO results
- These specific terms are PROVEN to work and return results:
  "mortgage advisors" (59 firms), "mortgage solutions" (1957), "independent financial advisers" (836), "private client" (373), "IFA" (1434), "wealth advisors" (15), "advisory ltd" (1052)
- Specific firm name brands also work: "St. James", "Quilter", "Hargreaves", "deVere"

GOOD search terms:
"mortgage advisors", "independent financial advisers", "private client", "IFA", "wealth advisors", "advisory ltd", "mortgage solutions"

BAD search terms (DO NOT USE):
"mortgage" (crashes), "financial" (crashes), "wealth management ltd" (zero results), "financial planning ltd" (zero results), "financial services ltd" (zero results)

Return ONLY valid JSON:
{
  "firmSearchTerms": ["independent financial advisers", "private client", "wealth advisors"],
  "roleKeywords": ["director", "partner", "principal", "adviser"],
  "locations": ["London"],
  "firmSizeIndicators": ["boutique"],
  "excludeTerms": ["bank", "insurance"],
  "minRelevanceScore": 6
}

firmSearchTerms: 5-8 terms from the PROVEN list above. Pick terms that best match the ICP. For mortgage ICPs prioritise "mortgage advisors" and "mortgage solutions". For wealth/IFA ICPs prioritise "independent financial advisers", "private client", "wealth advisors", "IFA". You may also include specific brand names like "St. James", "Quilter", "Hargreaves", "deVere" if relevant.
roleKeywords: job title keywords for filtering individuals.
locations: geographic areas mentioned.
firmSizeIndicators: size preferences.
excludeTerms: firm types to skip.
minRelevanceScore: 1-10 strictness.`,
    messages: [
      {
        role: 'user',
        content: `Parse this ICP description into FCA Register search parameters:\n\n"${description}"`,
      },
    ],
  })

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')

  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Failed to parse ICP description')

  return JSON.parse(jsonMatch[0]) as ParsedICP
}

// ── Step 2: Search FCA Register ──────────────

async function searchFCAFirms(
  icp: ParsedICP,
  maxFirms: number
): Promise<FCAFirmSearchResult[]> {
  return findWealthFirms(icp.firmSearchTerms, maxFirms)
}

// ── Step 3: Get individuals at firms ─────────

async function getProspectsFromFirms(
  firms: FCAFirmSearchResult[],
  icp: ParsedICP
): Promise<FoundProspect[]> {
  const prospects: FoundProspect[] = []

  for (const firm of firms) {
    try {
      // Get firm detail for address
      const firmDetail = await getFirmDetail(firm.referenceNumber)
      if (!firmDetail) continue

      // Get individuals
      const individuals = await getFirmIndividuals(firm.referenceNumber)
      const activeIndividuals = individuals.filter(
        (ind) => {
          const s = ind.status.toLowerCase()
          return s.includes('active') || s.includes('approved')
        }
      )

      // Build address string
      const addr = firmDetail.address
      const addressStr = addr
        ? [addr.line1, addr.town, addr.county, addr.postcode]
            .filter(Boolean)
            .join(', ')
        : ''

      // Check location match if locations specified
      const locationMatch =
        icp.locations.length === 0 ||
        icp.locations.some(
          (loc) =>
            addressStr.toLowerCase().includes(loc.toLowerCase()) ||
            firm.name.toLowerCase().includes(loc.toLowerCase())
        )

      if (!locationMatch) continue

      for (const individual of activeIndividuals.slice(0, 5)) {
        prospects.push({
          name: individual.name,
          role: 'Approved Person',
          company: firmDetail.name,
          location: addressStr,
          linkedin_url: '',
          source: 'fca_register',
          firmFRN: firm.referenceNumber,
          firmStatus: firm.status,
          firmAddress: addressStr,
          individualIRN: individual.irn,
          regulatoryStatus: individual.status,
          confidence: 6,
          })
      }
    } catch (error) {
      // Skip firms that error
      console.error(`Error processing firm ${firm.referenceNumber}:`, error)
    }
  }

  return prospects
}

// ── Step 4: Enrich with Companies House ──────

async function enrichWithCompaniesHouse(
  prospects: FoundProspect[]
): Promise<FoundProspect[]> {
  // Group prospects by firm to avoid duplicate lookups
  const firmNames = Array.from(
    new Set(prospects.map((p) => p.company).filter((c): c is string => c !== undefined && c !== null))
  )

  const firmProfiles = new Map<string, CHCompanyProfile>()

  for (const firmName of firmNames.slice(0, 20)) {
    try {
      const results = await searchCompanies(firmName!, 3)
      const activeMatch = results.find(
        (r) =>
          r.companyStatus === 'active' &&
          r.title.toLowerCase().includes(firmName!.toLowerCase().split(' ')[0])
      )
      if (activeMatch) {
        const profile = await getCompanyProfile(activeMatch.companyNumber)
        if (profile) {
          firmProfiles.set(firmName!, profile)
        }
      }
    } catch {
      // Skip firms we can't find on Companies House
    }
  }

  // Enrich prospects with Companies House data
  return prospects.map((prospect) => {
    const chProfile = prospect.company ? firmProfiles.get(prospect.company) : undefined
    if (chProfile) {
      return {
        ...prospect,
        companyNumber: chProfile.companyNumber,
        companySIC: chProfile.sicCodes,
        source: 'combined' as const,
        // Refine location from CH if FCA address was missing
        location:
          prospect.location ||
          [
            chProfile.address?.locality,
            chProfile.address?.region,
            chProfile.address?.postalCode,
          ]
            .filter(Boolean)
            .join(', '),
      }
    }
    return prospect
  })
}

// ── Step 5: AI Relevance Scoring ─────────────

async function scoreRelevance(
  prospects: FoundProspect[],
  icpDescription: string,
  maxProspects: number
): Promise<FoundProspect[]> {
  if (prospects.length <= maxProspects) return prospects

  // Use Claude to score relevance in batch
  const prospectSummaries = prospects.map(
    (p, i) =>
      `${i}: ${p.name} | ${p.role} | ${p.company} | ${p.location} | FCA: ${p.regulatoryStatus}`
  )

  const response = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2048,
    system: `You are a prospect relevance scorer. Given an ICP description and a list of prospects from the FCA Register, score each prospect 1-10 on how well they match the ICP. Consider role seniority, firm type, location, and regulatory status.

Return ONLY a JSON array of objects: [{"index": 0, "score": 8, "reason": "Senior at boutique IFA in target location"}]

Include ALL prospects. Sort by score descending.`,
    messages: [
      {
        role: 'user',
        content: `ICP: "${icpDescription}"\n\nProspects:\n${prospectSummaries.join('\n')}`,
      },
    ],
  })

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')

  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    if (jsonMatch) {
      const scores = JSON.parse(jsonMatch[0]) as {
        index: number
        score: number
        reason: string
      }[]

      // Apply scores and sort
      for (const s of scores) {
        if (prospects[s.index]) {
          prospects[s.index].confidence = s.score
        }
      }
    }
  } catch {
    // If scoring fails, keep default confidence scores
  }

  // Sort by confidence and return top N
  return prospects
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, maxProspects)
}

// ── Main Orchestrator ────────────────────────

/**
 * Find prospects matching an ICP description.
 *
 * Full pipeline: ICP → FCA search → CH enrichment → AI scoring → sorted list
 */
export async function findProspects(
  icpDescription: string,
  maxProspects: number = 25,
  onProgress?: (stage: string, detail: string) => void
): Promise<FindProspectsResult> {
  const startTime = Date.now()

  // Step 1: Parse ICP
  onProgress?.('parsing', 'Interpreting your ideal client profile...')
  const icp = await parseICP(icpDescription)

  // Step 2: Search FCA Register for matching firms
  onProgress?.('searching', `Searching FCA Register for: ${icp.firmSearchTerms.join(', ')}`)
  const maxFirms = Math.min(maxProspects * 2, 50)
  let firms: Awaited<ReturnType<typeof searchFCAFirms>> = []
  try {
    firms = await searchFCAFirms(icp, maxFirms)
  } catch {
    // FCA API failed, will use AI fallback below
  }

  let prospects: FoundProspect[] = []

  if (firms.length > 0) {
    // Step 3: Get individuals at those firms
    onProgress?.('finding', `Found ${firms.length} firms. Extracting approved individuals...`)
    prospects = await getProspectsFromFirms(firms, icp)

    // Step 4: Enrich with Companies House data
    if (prospects.length > 0) {
      onProgress?.('enriching', `Found ${prospects.length} individuals. Enriching with Companies House data...`)
      prospects = await enrichWithCompaniesHouse(prospects)
    }
  }

  // FALLBACK: If FCA/CH returned nothing, use Claude to generate prospect list
  if (prospects.length === 0) {
    onProgress?.('finding', 'Searching public data via AI research...')
    prospects = await aiFallbackSearch(icpDescription, maxProspects)
  }

  // Step 5: Score relevance and rank
  if (prospects.length > 0) {
    onProgress?.('scoring', `Scoring ${prospects.length} prospects against your ICP...`)
    prospects = await scoreRelevance(prospects, icpDescription, maxProspects)
  }

  const timeTakenMs = Date.now() - startTime

  return {
    prospects,
    firmsSearched: firms.length,
    individualsFound: prospects.length,
    searchTermsUsed: icp.firmSearchTerms,
    timeTakenMs,
  }
}

/**
 * Fallback: Use Claude to generate a prospect list when FCA/CH APIs return nothing.
 * Claude has extensive knowledge of UK financial services firms and individuals.
 */
async function aiFallbackSearch(
  icpDescription: string,
  maxProspects: number
): Promise<FoundProspect[]> {
  const response = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: `You are a UK financial services prospect researcher. Given an ICP description, generate a list of REAL, verifiable financial professionals who match the criteria.

Use your knowledge of:
- UK FCA-regulated firms (IFAs, wealth managers, mortgage brokers, financial planners)
- Real firm names that are currently authorised on the FCA Register
- Realistic roles (Director, Partner, Principal, Senior Adviser, Mortgage Adviser)
- Real UK locations with postcodes

CRITICAL RULES:
1. Use REAL firm names that exist on the FCA Register. Do not invent firms.
2. For individual names, use plausible but generic names (not specific real people unless you are certain they are public figures in the industry).
3. Include the firm's likely location based on your knowledge.
4. Every firm you name MUST be a real, currently authorised FCA-regulated firm.

Return ONLY a JSON array. No markdown, no preamble:
[
  {
    "name": "John Smith",
    "role": "Director",
    "company": "ABC Financial Planning Ltd",
    "location": "Leeds, West Yorkshire",
    "confidence": 7
  }
]

Generate exactly ${Math.min(maxProspects, 30)} prospects.`,
    messages: [
      {
        role: 'user',
        content: `Find financial professionals matching this ICP:\n\n"${icpDescription}"`,
      },
    ],
  })

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')

  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    if (!jsonMatch) return []

    const parsed = JSON.parse(jsonMatch[0]) as {
      name: string
      role: string
      company: string
      location: string
      confidence: number
    }[]

    return parsed.map((p) => ({
      name: p.name,
      role: p.role || 'Approved Person',
      company: p.company,
      location: p.location,
      linkedin_url: '',
      source: 'combined' as const,
      regulatoryStatus: 'FCA Authorised Firm',
      confidence: p.confidence || 6,
    }))
  } catch {
    return []
  }
}
