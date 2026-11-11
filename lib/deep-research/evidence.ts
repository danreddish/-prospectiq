// v81: deep research, step 1. Gathers what the public registers and the
// person's LinkedIn profile (through Apollo) say, before Claude is asked
// anything. Every look-up is allowed to fail on its own: a missing source is
// recorded as missing, never guessed at.

import {
  getCompanyFinancials,
  getCompanyOfficers,
  getCompanyProfile,
  getCompanyPscs,
  searchCompanies,
  formatAccountsCategory,
  type CHOfficer,
  type CHPsc,
} from '../data-sources/companies-house'
import { getFirmIndividualCount, getFirmProfile, resolveFirm } from '../data-sources/fca-register'
import { enrichFullProfileByLinkedInUrl } from '../data-sources/apollo'
import { isLinkedInProfileUrl } from '../linkedin'
import {
  ageFromDob,
  assessDecisionMaker,
  alternativeCompanyQueries,
  matchPerson,
  sameCompanyName,
  similarCompanyName,
  type DecisionMaker,
} from './matching'

export interface EvidenceInput {
  name: string
  role: string | null
  company: string | null
  location: string | null
  linkedin_url: string | null
  headline: string | null
  company_number: string | null
}

export interface CompaniesHouseEvidence {
  company_number: string
  company_name: string
  status: string | null
  incorporated: string | null
  accounts: string | null
  accounts_made_up_to: string | null
  sic_codes: string[]
  registered_town: string | null
  /** How the company was matched to the prospect. */
  matched_by: 'stored number' | 'FCA Register' | 'name and director' | 'name only' | 'web search and director'
  url: string
}

export interface FcaEvidence {
  frn: string
  name: string
  /** e.g. "Authorised", "Appointed representative" */
  status: string
  business_type: string | null
  /** Individuals the register lists at the firm. */
  individuals: number | null
  website: string | null
  url: string
}

export interface ProfileEvidence {
  headline: string | null
  current_title: string | null
  career: { title: string; company: string; from: string; to: string | null }[]
  firm_website: string | null
  firm_industry: string | null
}

export interface Evidence {
  companies_house: CompaniesHouseEvidence | null
  fca: FcaEvidence | null
  profile: ProfileEvidence | null
  decision_maker: DecisionMaker
  /** From the Companies House month and year of birth, when they are a director. */
  age: number | null
  /** Sources that were tried and gave nothing, in plain words. */
  missing: string[]
}

async function safe<T>(label: string, work: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await work()
  } catch (err) {
    console.error(`[DeepResearch] ${label} failed:`, err instanceof Error ? err.message : err)
    return fallback
  }
}

interface CompanyMatch {
  number: string
  matchedBy: CompaniesHouseEvidence['matched_by']
  officers: CHOfficer[]
}

/** Find the prospect's company on Companies House, confirmed by their name among its officers where possible. */
async function matchCompany(input: EvidenceInput, fcaCompanyNumber: string | null): Promise<CompanyMatch | null> {
  if (input.company_number) {
    return { number: input.company_number, matchedBy: 'stored number', officers: await getCompanyOfficers(input.company_number) }
  }
  if (fcaCompanyNumber) {
    return { number: fcaCompanyNumber, matchedBy: 'FCA Register', officers: await getCompanyOfficers(fcaCompanyNumber) }
  }
  if (!input.company) return null

  // The name as given first, then other spellings ("Eleven.2" is registered as "11.2").
  let results = await searchCompanies(input.company, 15)
  let usable = results.filter((c) => c.companyStatus === 'active' && (sameCompanyName(c.title, input.company!) || similarCompanyName(c.title, input.company!)))
  for (const query of usable.length ? [] : alternativeCompanyQueries(input.company)) {
    results = await searchCompanies(query, 15)
    usable = results.filter((c) => c.companyStatus === 'active' && (sameCompanyName(c.title, input.company!) || similarCompanyName(c.title, input.company!)))
    if (usable.length) break
  }
  const live = results.filter((c) => c.companyStatus === 'active')
  const exact = live.filter((c) => sameCompanyName(c.title, input.company!))
  const similar = live.filter((c) => !exact.includes(c) && similarCompanyName(c.title, input.company!))
  const candidates = [...exact, ...similar].slice(0, 4)

  // A company whose officers include this person is the one, whatever its exact name.
  let fallback: CompanyMatch | null = null
  for (const c of candidates) {
    const officers = await getCompanyOfficers(c.companyNumber)
    if (matchPerson(input.name, officers.map((o) => o.name)).matched) {
      return { number: c.companyNumber, matchedBy: 'name and director', officers }
    }
    // Same name, and the only one with it: the firm is right even if they are not an officer.
    if (!fallback && exact.length === 1 && exact[0] === c) {
      fallback = { number: c.companyNumber, matchedBy: 'name only', officers }
    }
  }
  return fallback
}

/** The company's record, who decides, and the person's age, for a matched company. */
async function companyDetails(
  input: EvidenceInput,
  match: CompanyMatch
): Promise<{ companies_house: CompaniesHouseEvidence; decision_maker: DecisionMaker; age: number | null } | null> {
  const [companyProfile, financials, pscs] = await Promise.all([
    safe('Companies House profile', () => getCompanyProfile(match.number), null),
    safe('Companies House accounts', () => getCompanyFinancials(match.number), null),
    safe('Companies House owners', () => getCompanyPscs(match.number), [] as CHPsc[]),
  ])
  if (!companyProfile) return null
  const companies_house: CompaniesHouseEvidence = {
    company_number: match.number,
    company_name: companyProfile.companyName,
    status: companyProfile.companyStatus || null,
    incorporated: companyProfile.dateOfCreation || null,
    accounts: financials?.accountsCategory ? formatAccountsCategory(financials.accountsCategory) : null,
    accounts_made_up_to: financials?.lastAccountsMadeUpTo || null,
    sic_codes: companyProfile.sicCodes || [],
    registered_town: companyProfile.address?.locality || null,
    matched_by: match.matchedBy,
    url: `https://find-and-update.company-information.service.gov.uk/company/${match.number}`,
  }
  // The firm as the prospect writes it reads better than the register's capitals.
  const decision_maker = assessDecisionMaker(input.name, input.company || companies_house.company_name, match.officers, pscs)
  // Their age, from the officer record, only when they were matched as a director.
  const me = decision_maker.registeredName ? match.officers.find((o) => matchPerson(input.name, [o.name]).matched) : undefined
  return { companies_house, decision_maker, age: ageFromDob(me?.dateOfBirth) }
}

/**
 * A second chance at Companies House. When the name search found nothing
 * (a trading name, say) but the web research turned up the company number,
 * use it, but only if this person really is one of that company's officers.
 * Returns true when the evidence was filled in.
 */
export async function attachCompanyByNumber(input: EvidenceInput, evidence: Evidence, companyNumber: string): Promise<boolean> {
  const number = companyNumber.replace(/\s+/g, '').toUpperCase()
  if (evidence.companies_house || !/^[A-Z0-9]{6,8}$/.test(number)) return false
  const officers = await safe('Companies House officers', () => getCompanyOfficers(number), [] as CHOfficer[])
  if (!matchPerson(input.name, officers.map((o) => o.name)).matched) return false
  const company = await companyDetails(input, { number, matchedBy: 'web search and director', officers })
  if (!company) return false
  evidence.companies_house = company.companies_house
  evidence.decision_maker = company.decision_maker
  evidence.age = company.age
  evidence.missing = evidence.missing.filter((m) => !m.startsWith('Companies House'))
  return true
}

export async function gatherEvidence(input: EvidenceInput): Promise<Evidence> {
  const missing: string[] = []

  // FCA Register and the LinkedIn profile do not depend on each other.
  const [fca, profile] = await Promise.all([
    safe('FCA Register', () => fcaEvidence(input), null),
    safe('LinkedIn profile', () => profileEvidence(input), null),
  ])
  if (!fca) missing.push('FCA Register: no firm matched by name')
  if (!profile) missing.push('LinkedIn profile: no profile details available')

  const fcaCompanyNumber = fca?._companiesHouseNumber || null
  const match = await safe('Companies House match', () => matchCompany(input, fcaCompanyNumber), null)

  const company = match ? await companyDetails(input, match) : null
  const companies_house = company?.companies_house || null
  if (!companies_house) missing.push('Companies House: no company matched by name')
  // The firm as the prospect writes it reads better than the register's capitals.
  const companyName = input.company || companies_house?.company_name || 'the firm'
  const decision_maker = company?.decision_maker || assessDecisionMaker(input.name, companyName, null, null)
  const age = company?.age ?? null

  const publicFca: FcaEvidence | null = fca
    ? { frn: fca.frn, name: fca.name, status: fca.status, business_type: fca.business_type, individuals: fca.individuals, website: fca.website, url: fca.url }
    : null
  return { companies_house, fca: publicFca, profile, decision_maker, age, missing }
}

async function fcaEvidence(input: EvidenceInput): Promise<(FcaEvidence & { _companiesHouseNumber: string | null }) | null> {
  if (!input.company) return null
  // The register's search is loose. Only keep a firm whose name is really this one.
  const isThisFirm = (name: string) => sameCompanyName(name, input.company!) || similarCompanyName(name, input.company!)
  let firm = await resolveFirm(input.company)
  for (const query of firm && isThisFirm(firm.name) ? [] : alternativeCompanyQueries(input.company)) {
    firm = await resolveFirm(query)
    if (firm && isThisFirm(firm.name)) break
  }
  if (!firm || !isThisFirm(firm.name)) return null
  const [profile, individuals] = await Promise.all([
    getFirmProfile(firm.referenceNumber),
    getFirmIndividualCount(firm.referenceNumber).catch(() => null),
  ])
  return {
    frn: firm.referenceNumber,
    name: profile?.name || firm.name,
    // The register sometimes answers "See full details" here: fall back to the search result or the business type.
    status: [profile?.status, firm.status, profile?.business_type].find((v) => v && !/see full details/i.test(v)) || 'Unknown',
    business_type: profile?.business_type || null,
    individuals,
    website: profile?.website || null,
    url: `https://register.fca.org.uk/s/firm?id=${firm.referenceNumber}`,
    _companiesHouseNumber: profile?.companies_house_number || null,
  }
}

async function profileEvidence(input: EvidenceInput): Promise<ProfileEvidence | null> {
  if (!isLinkedInProfileUrl(input.linkedin_url)) {
    return input.headline ? { headline: input.headline, current_title: input.role, career: [], firm_website: null, firm_industry: null } : null
  }
  const full = await enrichFullProfileByLinkedInUrl(input.linkedin_url!)
  if (!full) {
    return input.headline ? { headline: input.headline, current_title: input.role, career: [], firm_website: null, firm_industry: null } : null
  }
  return {
    headline: full.headline || input.headline,
    current_title: full.title || input.role,
    career: full.employment_history.slice(0, 8).map((e) => ({ title: e.title, company: e.company, from: e.start_date, to: e.current ? null : e.end_date })),
    firm_website: full.org_website,
    firm_industry: full.org_industry,
  }
}

/** The evidence as plain lines for the AI, each tagged with where it came from. */
export function evidenceLines(e: Evidence): string[] {
  const lines: string[] = []
  const ch = e.companies_house
  if (ch) {
    lines.push(`[Companies House] ${ch.company_name} (company ${ch.company_number}), status ${ch.status || 'unknown'}, incorporated ${ch.incorporated || 'unknown'}.`)
    if (ch.accounts) lines.push(`[Companies House] Last accounts filed as: ${ch.accounts}${ch.accounts_made_up_to ? `, made up to ${ch.accounts_made_up_to}` : ''}.`)
    if (ch.registered_town) lines.push(`[Companies House] Registered office in ${ch.registered_town}.`)
    if (e.decision_maker.directors.length) lines.push(`[Companies House] Current directors: ${e.decision_maker.directors.join(', ')}.`)
    if (e.decision_maker.owners.length) lines.push(`[Companies House] People or companies with significant control: ${e.decision_maker.owners.join(', ')}.`)
  }
  lines.push(`[Decision-maker check] ${e.decision_maker.summary}`)
  if (e.age) lines.push(`[Companies House] Age ${e.age}. For scoring only, never mention it.`)
  const f = e.fca
  if (f) {
    lines.push(`[FCA Register] ${f.name} (FRN ${f.frn}), status: ${f.status}${f.business_type ? `, ${f.business_type}` : ''}.`)
    if (f.individuals !== null) lines.push(`[FCA Register] ${f.individuals} individual${f.individuals === 1 ? '' : 's'} listed at the firm.`)
    if (f.website) lines.push(`[FCA Register] Website: ${f.website}`)
  }
  const p = e.profile
  if (p) {
    if (p.headline) lines.push(`[LinkedIn profile] Headline, in their own words: ${p.headline}`)
    if (p.career.length) {
      lines.push(`[LinkedIn profile] Career: ${p.career.map((c) => `${c.title} at ${c.company} (${(c.from || '?').slice(0, 4)} to ${c.to ? c.to.slice(0, 4) : 'now'})`).join('; ')}.`)
    }
    if (p.firm_website) lines.push(`[LinkedIn profile] Firm website: ${p.firm_website}`)
  }
  for (const m of e.missing) lines.push(`[Not found] ${m}.`)
  return lines
}
