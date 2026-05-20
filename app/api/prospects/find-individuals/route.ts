import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  searchCompanies,
  getCompanyOfficers,
  isDirector,
  estimateAge,
} from '@/lib/data-sources/companies-house'
import {
  searchFirms,
  getFirmIndividuals,
  getFirmDetail,
} from '@/lib/data-sources/fca-register'
import {
  searchPeople,
  enrichById,
  type ApolloProspect,
} from '@/lib/data-sources/apollo'
import { z } from 'zod'

const Schema = z.object({
  search_term: z.string().min(1),
  target_locations: z.array(z.string()).optional().default([]),
  target_roles: z.array(z.string()).optional().default(['director']),
  max_individuals: z.number().min(1).max(30).default(10),
  source: z.enum(['hnw_clients', 'financial_professionals', 'global_prospects']).default('hnw_clients'),
  apollo_params: z.record(z.unknown()).optional(),
})

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const parsed = Schema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const { search_term, target_locations, max_individuals, source, apollo_params } = parsed.data

  try {
    if (source === 'global_prospects') {
      return await findApolloProspects(apollo_params || {}, max_individuals, search_term)
    } else if (source === 'financial_professionals') {
      return await findFCAIndividuals(search_term, target_locations, max_individuals)
    } else {
      return await findCHDirectors(search_term, target_locations, max_individuals)
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Search failed'
    return NextResponse.json({ individuals: [], error: message })
  }
}

// ── Apollo: Global prospect search + enrichment by ID ──

async function findApolloProspects(
  params: Record<string, unknown>,
  maxIndividuals: number,
  searchTermFallback: string
) {
  const page = (params.page as number) || 1
  const perPage = Math.min(maxIndividuals, 5) // Max 5 per call to fit Netlify timeout

  // Build the primary search params from what the AI generated
  const searchParams = {
    person_locations: params.person_locations as string[] | undefined,
    organization_locations: params.organization_locations as string[] | undefined,
    person_seniorities: params.person_seniorities as string[] | undefined,
    person_titles: params.person_titles as string[] | undefined,
    q_organization_keyword_tags: params.q_organization_keyword_tags as string[] | undefined,
    organization_num_employees_ranges: params.organization_num_employees_ranges as string[] | undefined,
    q_keywords: params.q_keywords as string | undefined,
    per_page: perPage,
    page,
  }

  console.log('[Apollo] Primary search params:', JSON.stringify(searchParams))
  const { people, totalEntries } = await searchPeople(searchParams)
  console.log(`[Apollo] Primary search: ${people.length} people, ${totalEntries} total`)

  let finalPeople = people
  let finalTotal = totalEntries
  let usedFallback = false

  // Fallback chain — only on page 1 to avoid duplicate results on later pages
  if (people.length === 0 && page === 1) {
    // q_keywords AND's every word, so fewer words = more results
    // Strategy: try progressively shorter keyword phrases
    const originalKeywords = searchParams.q_keywords || ''
    const fallbackFromIcp = searchTermFallback || ''

    // Build a list of keyword attempts from most specific to least
    const keywordAttempts: string[] = []

    // Attempt 1: first 2 words of q_keywords (e.g. "family office" from "family office investment strategy deeptech")
    if (originalKeywords) {
      const twoWords = originalKeywords.split(/\s+/).slice(0, 2).join(' ')
      if (twoWords && twoWords !== originalKeywords) {
        keywordAttempts.push(twoWords)
      }
    }

    // Attempt 2: first 2 meaningful words from ICP description
    if (fallbackFromIcp) {
      const stopWords = new Set(['the','a','an','and','or','in','of','for','to','with','at','by','on','is','are','who','that','this','their','my','our','also','from','as','be','been','being','was','were','will','would','could','should','have','has','had','do','does','did','but','not','no','if','then','than','into','over','out','about','between','through','during','before','after','above','below','each','every','all','both','such','other','some','any','most','more','many','much','very','too','quite','rather','really','just','only','own','same','so','these','those','seeking','looking','need','needs','want','wants','based','including','particularly','especially','ideally','primarily','focused','targeting','individuals','professionals','clients','prospects','opportunities','exposure','alignment','emerging','strategy','advisory','ultra','high','net','worth'])
      const words = fallbackFromIcp
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !stopWords.has(w))
      if (words.length >= 2) {
        keywordAttempts.push(words.slice(0, 2).join(' '))
      }
      if (words.length >= 1) {
        keywordAttempts.push(words[0])
      }
    }

    // Try each keyword attempt
    for (const kw of keywordAttempts) {
      console.log(`[Apollo] Fallback: trying q_keywords="${kw}" + seniorities`)
      const fb = await searchPeople({
        q_keywords: kw,
        person_seniorities: searchParams.person_seniorities || ['director', 'c_suite', 'owner', 'partner', 'vp'],
        person_locations: searchParams.person_locations,
        organization_locations: searchParams.organization_locations,
        per_page: perPage,
        page,
      })
      console.log(`[Apollo] Fallback result: ${fb.people.length} people, ${fb.totalEntries} total`)

      if (fb.people.length > 0) {
        finalPeople = fb.people
        finalTotal = fb.totalEntries
        usedFallback = true
        break
      }
    }
  }

  if (finalPeople.length === 0) {
    return NextResponse.json({
      individuals: [],
      companiesSearched: 0,
      totalFound: 0,
      totalInDatabase: finalTotal,
      usedFallback,
    })
  }

  // Enrich all results in parallel (max 5, takes ~2-3 seconds)
  const results = await Promise.all(
    finalPeople.map((p) => enrichById(p.id).catch(() => null))
  )

  const prospects: ApolloProspect[] = []
  for (let i = 0; i < finalPeople.length; i++) {
    const result = results[i]
    const raw = finalPeople[i]

    if (result && result.name) {
      // Fully enriched prospect
      prospects.push({
        name: result.name,
        role: result.title || 'Director',
        company: result.company || '',
        location: result.location || '',
        linkedin_url: result.linkedin_url || `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent((result.name || '') + ' ' + (result.company || ''))}`,
        email: result.email || null,
        phone: result.phone || null,
        headline: result.headline || null,
        source: 'apollo',
        confidence: 7,
      })
    } else if (raw.first_name && raw.org_name) {
      // Enrichment failed (likely out of credits) — use search data
      prospects.push({
        name: raw.first_name,
        role: raw.title || 'Director',
        company: raw.org_name,
        location: '',
        linkedin_url: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(raw.first_name + ' ' + raw.org_name)}`,
        email: null,
        phone: null,
        headline: null,
        source: 'apollo',
        confidence: 4,
      })
    }
  }

  // Flag if no enrichments succeeded (likely credit issue)
  const enrichmentsFailed = results.every(r => r === null) && finalPeople.length > 0

  return NextResponse.json({
    individuals: prospects,
    companiesSearched: finalPeople.length,
    totalFound: prospects.length,
    totalInDatabase: finalTotal,
    page,
    usedFallback,
    enrichmentsFailed,
  })
}

// ── FCA Register: Find approved persons ──

async function findFCAIndividuals(
  searchTerm: string,
  targetLocations: string[],
  maxIndividuals: number
) {
  const { firms } = await searchFirms(searchTerm)
  const authorised = firms.filter((f) => f.status.toLowerCase().includes('authoris'))

  const prospects: Record<string, unknown>[] = []

  for (const firm of authorised) {
    if (prospects.length >= maxIndividuals) break

    try {
      const detail = await getFirmDetail(firm.referenceNumber)
      const firmAddress = detail?.address
        ? [detail.address.line1, detail.address.town, detail.address.postcode].filter(Boolean).join(', ')
        : ''

      if (targetLocations.length > 0) {
        const locationStr = `${firmAddress} ${firm.name}`.toLowerCase()
        const match = targetLocations.some((loc) => locationStr.includes(loc.toLowerCase()))
        if (!match) continue
      }

      const individuals = await getFirmIndividuals(firm.referenceNumber)
      const active = individuals.filter((ind) => {
        const s = ind.status.toLowerCase()
        return s.includes('active') || s.includes('approved')
      })

      for (const ind of active.slice(0, 3)) {
        if (prospects.length >= maxIndividuals) break
        const linkedinSearch = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(ind.name + ' ' + firm.name)}`
        prospects.push({
          name: ind.name,
          role: 'FCA Approved Person',
          company: firm.name,
          location: firmAddress,
          linkedin_url: linkedinSearch,
          source: 'fca_register',
          firmFRN: firm.referenceNumber,
          firmStatus: firm.status,
          individualIRN: ind.irn,
          regulatoryStatus: ind.status,
          confidence: 7,
        })
      }
    } catch { continue }
  }

  return NextResponse.json({
    individuals: prospects,
    companiesSearched: authorised.length,
    totalFound: prospects.length,
  })
}

// ── Companies House: Find company directors ──

async function findCHDirectors(
  searchTerm: string,
  targetLocations: string[],
  maxIndividuals: number
) {
  const companies = await searchCompanies(searchTerm, 10)
  const activeCompanies = companies.filter((c) => c.companyStatus === 'active')

  const prospects: Record<string, unknown>[] = []

  for (const company of activeCompanies) {
    if (prospects.length >= maxIndividuals) break

    if (targetLocations.length > 0) {
      const companyLocation = [company.locality, company.region, company.addressSnippet]
        .filter(Boolean).join(' ').toLowerCase()
      const locationMatch = targetLocations.some((loc) => companyLocation.includes(loc.toLowerCase()))
      if (!locationMatch) continue
    }

    try {
      const officers = await getCompanyOfficers(company.companyNumber)
      const directors = officers.filter((o) => isDirector(o.officerRole))

      for (const director of directors) {
        if (prospects.length >= maxIndividuals) break
        const nameParts = director.name.split(',').map((s) => s.trim())
        const displayName = nameParts.length >= 2
          ? `${nameParts[1]} ${nameParts[0].charAt(0)}${nameParts[0].slice(1).toLowerCase()}`
          : director.name
        const location = [director.locality, director.region, director.postalCode]
          .filter(Boolean).join(', ') || company.addressSnippet
        const linkedinSearch = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(displayName + ' ' + company.title)}`

        prospects.push({
          name: displayName,
          role: director.officerRole.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
          company: company.title,
          location,
          linkedin_url: linkedinSearch,
          source: 'companies_house',
          companyNumber: company.companyNumber,
          regulatoryStatus: `Active company (${company.companyNumber})`,
          confidence: 7,
          occupation: director.occupation,
          estimatedAge: estimateAge(director.dateOfBirth),
        })
      }
    } catch { continue }
  }

  return NextResponse.json({
    individuals: prospects,
    companiesSearched: activeCompanies.length,
    totalFound: prospects.length,
  })
}
