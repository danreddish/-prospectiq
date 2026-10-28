import { getAnthropic } from '@/lib/ai-engine'

// Parse a plain English hiring brief into search intent.
// Firm-led: names firms, networks or ARs. Role-led: roles and places only.

export interface ParsedIntent {
  path: 'firm_led' | 'role_led'
  firms: string[]
  include_ars: boolean
  roles: string[]
  role_families: string[]
  locations: string[]
  adviser_types: string[]
  keywords: string | null
  summary: string
}

// Apollo title taxonomy for advisers, limited to the six titles in the v76
// brief so the search does not drift or collapse to zero.
export const ADVISER_TITLES: Record<string, string[]> = {
  mortgage: ['Mortgage Adviser', 'Mortgage Advisor'],
  protection: ['Protection Adviser'],
  financial: ['Financial Adviser', 'Financial Planner'],
  wealth: ['Wealth Manager'],
  paraplanner: ['Financial Planner'],
  'equity release': ['Mortgage Adviser', 'Mortgage Advisor'],
}

export async function parseHiringBrief(description: string): Promise<ParsedIntent> {
  const response = await getAnthropic().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 700,
    system: `You parse a hiring brief from a UK financial advice firm principal or network BDM into search intent. Return JSON only.

Two paths:
- "firm_led" when the brief names one or more firms, networks, principals or appointed representative groups (PRIMIS, Mortgage Advice Bureau, Quilter, Openwork, Stonebridge, The Right Mortgage, Just Mortgages, Connect IFA, St. James's Place, Sesame, Tenet, Dynamo, or any named company). Put each firm's most likely FCA registered legal name in "firms" (for example PRIMIS is "First Complete Limited", Mortgage Advice Bureau is "Mortgage Advice Bureau Limited", Stonebridge is "Stonebridge Mortgage Solutions Limited", The Right Mortgage is "The Right Mortgage Limited", Quilter is "Quilter Financial Services Limited", Openwork is "Openwork Limited"). If unsure of the legal name, give the name as written. Set "include_ars" true only when the brief explicitly mentions appointed representatives or ARs. A network's own adviser list already includes its AR advisers.
- "role_led" when no firm is named, only roles, adviser types and places ("self-employed mortgage advisers in Leeds").

Fields:
- roles: the job titles wanted, as written.
- role_families: subset of ["mortgage","protection","financial","wealth","paraplanner","equity release"] matching the roles.
- locations: UK towns, cities, counties or regions mentioned, one per entry, without "UK".
- adviser_types: subset of ["AR","DA","employed","self-employed"] if stated.
- keywords: at most two words describing the business type when it helps a LinkedIn search, otherwise null.
- summary: one plain sentence from the hirer's point of view, starting "Find", for example "Find mortgage advisers at PRIMIS appointed representatives in Yorkshire." British English, no em dashes.

Return: {"path":"","firms":[],"include_ars":false,"roles":[],"role_families":[],"locations":[],"adviser_types":[],"keywords":null,"summary":""}`,
    messages: [{ role: 'user', content: `Hiring brief: "${description}"` }],
  })

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')

  let intent: ParsedIntent = {
    path: 'role_led', firms: [], include_ars: false, roles: [], role_families: [], locations: [], adviser_types: [], keywords: null, summary: description,
  }
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const raw = JSON.parse(jsonMatch[0]) as Partial<ParsedIntent>
      intent = {
        path: raw.path === 'firm_led' ? 'firm_led' : 'role_led',
        firms: Array.isArray(raw.firms) ? raw.firms.map(String).filter(Boolean).slice(0, 5) : [],
        include_ars: !!raw.include_ars,
        roles: Array.isArray(raw.roles) ? raw.roles.map(String).filter(Boolean) : [],
        role_families: Array.isArray(raw.role_families) ? raw.role_families.map(String).filter((f) => f in ADVISER_TITLES) : [],
        locations: Array.isArray(raw.locations) ? raw.locations.map(String).filter(Boolean).slice(0, 8) : [],
        adviser_types: Array.isArray(raw.adviser_types) ? raw.adviser_types.map(String).filter(Boolean) : [],
        keywords: typeof raw.keywords === 'string' && raw.keywords.trim() ? raw.keywords.trim().split(/\s+/).slice(0, 2).join(' ') : null,
        summary: typeof raw.summary === 'string' && raw.summary.trim() ? raw.summary.trim() : description,
      }
    }
  } catch {
    console.error('[Recruitment find] Failed to parse intent:', text.slice(0, 300))
  }

  // A path without firms is role-led whatever the model said.
  if (intent.path === 'firm_led' && intent.firms.length === 0) intent.path = 'role_led'
  return intent
}

export function inferFamilies(text: string): string[] {
  const t = text.toLowerCase()
  const out: string[] = []
  if (/mortgage|broker/.test(t)) out.push('mortgage')
  if (/protection/.test(t)) out.push('protection')
  if (/\bifa\b|financial (adviser|advisor|planner)|planner/.test(t)) out.push('financial')
  if (/wealth|private client/.test(t)) out.push('wealth')
  if (/paraplanner/.test(t)) out.push('paraplanner')
  if (/equity release|later life/.test(t)) out.push('equity release')
  return out.length ? out : ['mortgage', 'financial']
}

// "City, United Kingdom" form, plus the country so Apollo's fuzzy matcher
// cannot cross-match US towns of the same name. Same rule as the client flow.
// Apollo ORs the locations, so the country is only included when no town,
// city or region was named. Otherwise a Leeds search would cover the UK.
export function buildUkLocations(locations: string[]): string[] {
  const out: string[] = []
  for (const raw of locations) {
    const loc = raw.replace(/,?\s*(uk|united kingdom|england|scotland|wales)\s*$/i, '').trim()
    if (!loc) continue
    if (/^(uk|united kingdom|england|scotland|wales|northern ireland)$/i.test(loc)) {
      out.push(loc.replace(/^uk$/i, 'United Kingdom'))
      continue
    }
    out.push(`${loc}, United Kingdom`)
  }
  if (out.length === 0) out.push('United Kingdom')
  return Array.from(new Set(out))
}
