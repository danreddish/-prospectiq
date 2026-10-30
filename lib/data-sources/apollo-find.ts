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
  /** v77: people Apollo's search returned on this page, before any filtering. */
  rawCount: number
  /** v77: Apollo enrichments made (each one uses an Apollo credit). */
  enrichedCount: number
  /** v77: people dropped because their title or company matched an exclude term. */
  excludedByTerms: number
}

/**
 * v77: the first "leave out" term found in a piece of text, or null. Terms
 * are word stems matched at the start of a word, so "recruit" catches
 * recruiter and recruitment but not "unrecruited". Hyphens are ignored on
 * both sides, so "para-planning" matches "paraplann".
 */
export function matchesExcludeTerm(text: string, terms: string[]): string | null {
  const lower = text.toLowerCase()
  // "Para-planning" should match "paraplann"; "IFA-Recruit" should match "recruit".
  const hays = [` ${lower.replace(/-/g, '')} `, ` ${lower.replace(/-/g, ' ')} `]
  for (const raw of terms) {
    const term = raw.trim().toLowerCase().replace(/-/g, '')
    if (term.length < 3) continue
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
    const re = new RegExp(`(^|[^a-z0-9])${escaped}`, 'i')
    if (hays.some((h) => re.test(h))) return raw
  }
  return null
}

/** Firm types are matched against the company name, roles against the job title. */
export interface ExcludeTerms {
  company: string[]
  title: string[]
}

function excludeHit(title: string | null | undefined, company: string | null | undefined, terms: ExcludeTerms): string | null {
  return matchesExcludeTerm(company || '', terms.company) || matchesExcludeTerm(title || '', terms.title)
}

export async function findApolloProspects(
  params: Record<string, unknown>,
  maxIndividuals: number,
  searchTermFallback: string,
  opts: { noFallback?: boolean; exclude?: ExcludeTerms } = {}
): Promise<ApolloFindResult> {
  const clean = (list?: string[]) => (list || []).filter((t) => typeof t === 'string' && t.trim().length >= 3)
  const exclude: ExcludeTerms = { company: clean(opts.exclude?.company), title: clean(opts.exclude?.title) }
  const excluding = exclude.company.length + exclude.title.length > 0
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

  const rawCount = finalPeople.length

  // v77: drop people the ICP says to leave out BEFORE enriching them, so no
  // Apollo credit is spent on a recruiter or a paraplanning firm.
  let excludedByTerms = 0
  if (excluding) {
    finalPeople = finalPeople.filter((p) => {
      const hit = excludeHit(p.title, p.org_name, exclude)
      if (hit) {
        excludedByTerms++
        console.log(`[Apollo] Left out before enrichment ("${hit}"): ${p.title || '?'} at ${p.org_name || '?'}`)
      }
      return !hit
    })
  }

  if (finalPeople.length === 0) {
    return {
      individuals: [],
      companiesSearched: 0,
      totalFound: 0,
      totalInDatabase: finalTotal,
      usedFallback,
      rawCount,
      enrichedCount: 0,
      excludedByTerms,
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
      // v77: enrichment gives the full title and company, so check again.
      // The headline is not checked: "we are recruiting" isn't a recruiter.
      const hit = excluding ? excludeHit(result.title, result.company, exclude) : null
      if (hit) {
        excludedByTerms++
        console.log(`[Apollo] Left out after enrichment ("${hit}"): ${result.title || '?'} at ${result.company || '?'}`)
        continue
      }
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
    rawCount,
    enrichedCount: results.filter((r) => r !== null).length,
    excludedByTerms,
  }
}
