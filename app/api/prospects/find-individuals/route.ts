import { requireAccess, reserveFindUnits, refundFindUnits } from '@/lib/access-guard'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  searchCompanies,
  getCompanyOfficers,
  getCompanyFinancials,
  isDirector,
  estimateAge,
  requiredNameWords,
  nameHasWholeWords,
  isDormantAccounts,
} from '@/lib/data-sources/companies-house'
import {
  searchFirms,
  getFirmIndividuals,
  getFirmDetail,
} from '@/lib/data-sources/fca-register'
import { findApolloProspects } from '@/lib/data-sources/apollo-find'
import { linkedInProfileSlug } from '@/lib/linkedin'
import { z } from 'zod'

const Schema = z.object({
  search_term: z.string().min(1),
  target_locations: z.array(z.string()).optional().default([]),
  target_roles: z.array(z.string()).optional().default(['director']),
  max_individuals: z.number().min(1).max(30).default(10),
  source: z.enum(['hnw_clients', 'financial_professionals', 'global_prospects']).default('hnw_clients'),
  apollo_params: z.record(z.unknown()).optional(),
  // v77: Global (Apollo) source only.
  exact_profile_only: z.boolean().optional().default(false),
  skip_excluded: z.boolean().optional().default(false),
})

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // v75.7: Global search spends Apollo enrichment credits on every page.
  const blocked = await requireAccess(supabase, user, { needsResearchLeft: true })
  if (blocked) return blocked

  const body = await req.json()
  const parsed = Schema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const { search_term, target_locations, max_individuals, source, apollo_params, exact_profile_only, skip_excluded } = parsed.data

  try {
    if (source === 'global_prospects') {
      // v75.7: each Apollo-enriched contact (name, email, phone, LinkedIn)
      // uses one unit of the monthly find budget. Reserve up front, then
      // give back whatever Apollo didn't return.
      const wanted = Math.min(max_individuals, 5)
      const budget = await reserveFindUnits(user, wanted)
      if (budget.response) return budget.response
      let returned = 0
      try {
        const strings = (v: unknown) => (Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [])
        const exclude = {
          company: strings(apollo_params?.exclude_company_terms),
          title: strings(apollo_params?.exclude_title_terms),
        }
        const result = await findApolloProspects(apollo_params || {}, budget.granted, search_term, { exclude })
        // v76/v75.7: one find unit per Apollo enrichment actually made, even
        // when the person is then dropped below.
        returned = result.enrichedCount

        // v77: keep only exact LinkedIn profiles, and skip anyone already on
        // the user's LinkedIn exclusions (e.g. their Ulinc contacts).
        let individuals = result.individuals
        let noProfile = 0
        let alreadyContacted = 0
        if (exact_profile_only) {
          individuals = individuals.filter((p) => {
            const keep = !!linkedInProfileSlug(p.linkedin_url)
            if (!keep) noProfile++
            return keep
          })
        }
        if (skip_excluded && individuals.length > 0) {
          const slugs = individuals.map((p) => linkedInProfileSlug(p.linkedin_url)).filter((v): v is string => !!v)
          if (slugs.length > 0) {
            const { data: hits, error: hitsError } = await supabase
              .from('linkedin_exclusions')
              .select('profile_slug')
              .eq('user_id', user.id)
              .in('profile_slug', slugs)
            if (hitsError) {
              // Fail closed: if we can't check, don't risk contacting someone twice.
              console.error('[Find] LinkedIn exclusions check failed:', hitsError.message)
              return NextResponse.json({ ...result, individuals: [], error: 'Could not check your LinkedIn exclusions. Please try again.' })
            }
            const excluded = new Set((hits || []).map((h) => h.profile_slug as string))
            individuals = individuals.filter((p) => {
              const slug = linkedInProfileSlug(p.linkedin_url)
              const keep = !slug || !excluded.has(slug)
              if (!keep) alreadyContacted++
              return keep
            })
          }
        }
        if (exact_profile_only || skip_excluded || result.excludedByTerms) {
          console.log(
            `[Find] Apollo page ${result.page || 1}: ${result.rawCount} found, ${result.excludedByTerms} left out by exclude terms, ${noProfile} without an exact LinkedIn profile, ${alreadyContacted} already in exclusions, ${individuals.length} kept`
          )
        }
        return NextResponse.json({
          ...result,
          individuals,
          totalFound: individuals.length,
          dropped: { excluded_terms: result.excludedByTerms, no_profile: noProfile, already_contacted: alreadyContacted },
        })
      } finally {
        await refundFindUnits(user, budget.granted - returned)
      }
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
  // v76.2: Companies House matches the start of words ("IFA" finds IFARM),
  // so ask for more results and keep only whole-word name matches.
  const companies = await searchCompanies(searchTerm, 50)
  const required = requiredNameWords(searchTerm, targetLocations)
  const activeCompanies = companies.filter(
    (c) => c.companyStatus === 'active' && nameHasWholeWords(c.title, required)
  )

  const prospects: Record<string, unknown>[] = []
  let dormantSkipped = 0
  let companiesUsed = 0

  for (const company of activeCompanies) {
    if (prospects.length >= maxIndividuals) break

    if (targetLocations.length > 0) {
      const companyLocation = [company.locality, company.region, company.addressSnippet]
        .filter(Boolean).join(' ').toLowerCase()
      const locationMatch = targetLocations.some((loc) => companyLocation.includes(loc.toLowerCase()))
      if (!locationMatch) continue
    }

    try {
      // v76.2: a dormant company still shows as "active", so check its
      // accounts at the same time as fetching its officers.
      const [financials, officers] = await Promise.all([
        getCompanyFinancials(company.companyNumber).catch(() => null),
        getCompanyOfficers(company.companyNumber),
      ])
      if (isDormantAccounts(financials?.accountsCategory)) {
        dormantSkipped++
        continue
      }
      companiesUsed++
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

  console.log(
    `[Find CH] "${searchTerm}": ${companies.length} results, ${activeCompanies.length} active with whole-word name match (needs: ${required.join(', ') || 'any'}), ${dormantSkipped} dormant skipped, ${prospects.length} directors from ${companiesUsed} companies`
  )

  return NextResponse.json({
    individuals: prospects,
    companiesSearched: activeCompanies.length,
    totalFound: prospects.length,
  })
}
