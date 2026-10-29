// Apollo global prospect search plus enrichment by Apollo ID.
// Shared by /api/prospects/find-individuals (client prospecting) and
// /api/recruitment/find-apollo (role-led adviser searches, v76).
//
// Search results have obfuscated surnames, so every contact is enriched by
// Apollo ID, never by name. At most 5 per call to fit Netlify's 10s limit.

import { searchPeople, enrichById, type ApolloProspect } from './apollo'

export interface ApolloFindResult {
  individuals: ApolloProspect[]
  companiesSearched: number
  totalFound: number
  totalInDatabase: number
  page?: number
  usedFallback: boolean
  enrichmentsFailed?: boolean
}

export async function findApolloProspects(
  params: Record<string, unknown>,
  maxIndividuals: number,
  searchTermFallback: string,
  opts: { noFallback?: boolean } = {}
): Promise<ApolloFindResult> {
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

  // Fallback chain — only on page 1 to avoid duplicate results on later pages.
  // v76: recruitment role-led searches turn it off, because the fallback
  // drops person_titles and would return company directors, not advisers.
  if (people.length === 0 && page === 1 && !opts.noFallback) {
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
    return {
      individuals: [],
      companiesSearched: 0,
      totalFound: 0,
      totalInDatabase: finalTotal,
      usedFallback,
    }
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

  return {
    individuals: prospects,
    companiesSearched: finalPeople.length,
    totalFound: prospects.length,
    totalInDatabase: finalTotal,
    page,
    usedFallback,
    enrichmentsFailed,
  }
}
