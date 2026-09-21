import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getAnthropic } from '@/lib/ai-engine'
import { z } from 'zod'

const FindSchema = z.object({
  campaign_id: z.string().uuid(),
  icp_description: z.string().min(10),
  max_prospects: z.number().min(5).max(50).default(25),
  source: z.enum(['hnw_clients', 'financial_professionals', 'global_prospects']).default('hnw_clients'),
  custom_instructions: z.string().optional(),
  audience_mode: z.enum(['match_profile', 'different_audience']).optional(),
})

// ── UK Geography Lock (v75.1) ──
// v75 sent bare city names like "Reading", "Cambridge", "Birmingham" — these
// also match Reading PA, Cambridge MA, Birmingham AL. Cowork's post-v75 debug
// found 1 US Reading result across 53 UK prospects. Fix: use "City, United
// Kingdom" strings so Apollo's fuzzy matcher can't cross-match US cities of
// the same name. Country names stay in the array to catch prospects whose
// location Apollo has stored as just "England" or "Scotland".
const UK_LOCATIONS = [
  'United Kingdom',
  'England',
  'Scotland',
  'Wales',
  'Northern Ireland',
  'London, United Kingdom',
  'Manchester, United Kingdom',
  'Birmingham, United Kingdom',
  'Leeds, United Kingdom',
  'Liverpool, United Kingdom',
  'Sheffield, United Kingdom',
  'Bristol, United Kingdom',
  'Edinburgh, United Kingdom',
  'Glasgow, United Kingdom',
  'Cardiff, United Kingdom',
  'Belfast, United Kingdom',
  'Newcastle, United Kingdom',
  'Nottingham, United Kingdom',
  'Cambridge, United Kingdom',
  'Oxford, United Kingdom',
  'Brighton, United Kingdom',
  'Reading, United Kingdom',
]

// Country aliases the user might type, mapped to the strict location array.
// All city entries use "City, Country" form for the same anti-collision reason.
const GEOGRAPHY_LOCK: Record<string, string[]> = {
  uk: UK_LOCATIONS,
  'united kingdom': UK_LOCATIONS,
  britain: UK_LOCATIONS,
  'great britain': UK_LOCATIONS,
  england: UK_LOCATIONS,
  scotland: ['Scotland', 'Edinburgh, United Kingdom', 'Glasgow, United Kingdom', 'Aberdeen, United Kingdom', 'Dundee, United Kingdom'],
  wales: ['Wales', 'Cardiff, United Kingdom', 'Swansea, United Kingdom', 'Newport, United Kingdom'],
  ireland: ['Ireland', 'Dublin, Ireland', 'Cork, Ireland', 'Galway, Ireland'],
  uae: ['United Arab Emirates', 'Dubai, United Arab Emirates', 'Abu Dhabi, United Arab Emirates', 'Sharjah, United Arab Emirates'],
  'united arab emirates': ['United Arab Emirates', 'Dubai, United Arab Emirates', 'Abu Dhabi, United Arab Emirates', 'Sharjah, United Arab Emirates'],
  dubai: ['Dubai, United Arab Emirates', 'United Arab Emirates'],
  singapore: ['Singapore'],
  switzerland: ['Switzerland', 'Zurich, Switzerland', 'Geneva, Switzerland', 'Basel, Switzerland', 'Bern, Switzerland'],
  germany: ['Germany', 'Berlin, Germany', 'Munich, Germany', 'Frankfurt, Germany', 'Hamburg, Germany'],
  france: ['France', 'Paris, France', 'Lyon, France', 'Marseille, France'],
  australia: ['Australia', 'Sydney, Australia', 'Melbourne, Australia', 'Brisbane, Australia', 'Perth, Australia'],
  canada: ['Canada', 'Toronto, Canada', 'Vancouver, Canada', 'Montreal, Canada', 'Calgary, Canada'],
  usa: ['United States'],
  'united states': ['United States'],
  america: ['United States'],
  us: ['United States'],
}

function detectGeographyLock(text: string): string[] | null {
  const lower = text.toLowerCase()
  for (const [key, locations] of Object.entries(GEOGRAPHY_LOCK)) {
    const re = new RegExp(`\\b${key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`, 'i')
    if (re.test(lower)) return locations
  }
  return null
}

interface ServiceProfileLite {
  what_you_do?: string | null
  who_you_help?: string | null
  geographic_focus?: string | null
  minimum_threshold?: string | null
}

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const parsed = FindSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const { campaign_id, icp_description, source, custom_instructions, audience_mode } = parsed.data

  const [campaignRes, profileRes] = await Promise.all([
    supabase.from('campaigns')
      .select('id, service_profile, custom_instructions, audience_mode')
      .eq('id', campaign_id).eq('user_id', user.id).single(),
    supabase.from('profiles')
      .select('service_profile').eq('id', user.id).single(),
  ])

  if (!campaignRes.data) {
    return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
  }

  const effectiveAudienceMode = audience_mode
    || campaignRes.data.audience_mode
    || 'different_audience'
  const effectiveCustomInstructions = (custom_instructions ?? campaignRes.data.custom_instructions ?? '').trim()

  const accountSP = (profileRes.data?.service_profile || {}) as ServiceProfileLite
  const campaignSP = (campaignRes.data.service_profile || {}) as ServiceProfileLite
  const serviceProfile: ServiceProfileLite = {
    what_you_do: campaignSP.what_you_do || accountSP.what_you_do,
    who_you_help: campaignSP.who_you_help || accountSP.who_you_help,
    geographic_focus: campaignSP.geographic_focus || accountSP.geographic_focus,
    minimum_threshold: campaignSP.minimum_threshold || accountSP.minimum_threshold,
  }

  try {
    const startTime = Date.now()

    let contextBlock = ''
    if (effectiveAudienceMode === 'match_profile' && serviceProfile.who_you_help) {
      contextBlock = `\n\nThe sender wants prospects SIMILAR to their existing client base. The sender helps: "${serviceProfile.who_you_help}".${serviceProfile.minimum_threshold ? ` Minimum threshold: ${serviceProfile.minimum_threshold}.` : ''} Use this as a positive matching signal — find prospects who fit this profile.`
    } else {
      contextBlock = `\n\nIMPORTANT: This search is for PROSPECTS, not for people in the sender's own profession. Do NOT include the sender's job title or industry as a search criterion. Only use what the user describes in the ICP below.`
    }

    if (effectiveCustomInstructions) {
      contextBlock += `\n\nUSER'S ADDITIONAL INSTRUCTIONS FOR THIS BATCH (highest priority, treat as hard constraints): "${effectiveCustomInstructions}"`
    }

    const prompts: Record<string, { system: string; user: string }> = {
      financial_professionals: {
        system: `Generate search terms for the UK FCA Register API. PROVEN terms: "mortgage advisors", "mortgage solutions", "independent financial advisers", "private client", "IFA", "wealth advisors", "advisory ltd". DO NOT USE: "mortgage", "financial", "wealth management ltd". Return JSON: {"firmSearchTerms":["..."],"roleKeywords":["director"],"locations":["..."]}.${contextBlock}`,
        user: `Find FCA-registered professionals matching: "${icp_description}"`,
      },
      hnw_clients: {
        system: `Generate Companies House search terms for HNW company directors. Return JSON: {"searchTerms":["property development Surrey","investment holdings London"],"targetLocations":["Surrey"],"targetRoles":["director"]}.

RULES:
- searchTerms: 8-15 queries mixing industry/business-type + location.
- Do NOT use generic words alone ("ltd", "limited", "company") — they return millions of results.
- Pair industry keywords with locations whenever possible: "tech startup Manchester", "family office London".${contextBlock}`,
        user: `Find HNW prospect search parameters for: "${icp_description}"`,
      },
      global_prospects: {
        system: `Generate Apollo.io People Search API parameters. Return JSON only.

CRITICAL RULES about Apollo:
1. q_keywords ANDs every word and searches across the ENTIRE profile (about, headline, job description, company description). Every extra word NARROWS results. "family office" returns thousands; "family office investment strategy" returns near-zero. NEVER more than 2 words. Reserve for the core business type ONLY (e.g. "family office", "private equity", "property development"). If the ICP describes a job role rather than a business type, OMIT q_keywords entirely.

2. person_titles is the RIGHT field for job concepts like "founder", "CEO", "managing director". Provide an array of common variants. Examples:
   - "tech founders" -> person_titles: ["Founder","Co-Founder","CEO","Founder & CEO","Founder and CEO","Founding Partner"], q_organization_keyword_tags: ["technology"] or ["software"]
   - "wealth managers" -> person_titles: ["Wealth Manager","Private Wealth Manager","Senior Wealth Manager","Director of Wealth Management"]
   - "mortgage brokers" -> person_titles: ["Mortgage Broker","Mortgage Adviser","Mortgage Advisor","Mortgage Consultant"]

3. Do NOT combine q_keywords AND person_titles AND q_organization_keyword_tags all at once. Three intersecting filters routinely return zero results. Pick the TWO that best fit the ICP. Usually that's person_titles + (q_organization_keyword_tags OR q_keywords).

4. person_seniorities: ALWAYS include. Pick from Apollo's fixed list: "owner","founder","c_suite","partner","vp","head","director","manager","senior","entry","intern". Use these RULES so runs stay consistent for the same ICP shape:
   - If the ICP mentions founder/co-founder/founding: use exactly ["founder","c_suite","owner"] (in that order).
   - If the ICP mentions CEO/CTO/CFO/COO/CMO/CxO or "chief …": use ["c_suite","founder","owner"].
   - If the ICP mentions owner/proprietor/managing director/MD/business owner: use ["owner","founder","partner","c_suite"].
   - If the ICP mentions partner/associate at a firm: use ["partner","c_suite","director"].
   - If the ICP mentions director/head/VP/executive/senior: use ["director","c_suite","vp","head"].
   - If the ICP mentions manager/mid-level: use ["manager","director","senior"].
   - Default (unclear seniority signal): ["director","c_suite","owner","partner","founder"].
   Pick ONE rule based on the strongest signal in the ICP. Do not merge lists. Do not add seniorities the ICP does not imply.

5. person_locations: STRICT. Always return an ARRAY of strings, never a single string. For a country, include the country name AND its major cities in "City, Country" form to avoid US/UK city name collisions (Reading, Cambridge, Birmingham, etc). For the UK, prefer the orchestrator's canonical UK list — it will overwrite what you produce here anyway when it detects a UK cue. Example: ["United Kingdom","England","Scotland","Wales","Northern Ireland","London, United Kingdom","Manchester, United Kingdom","Birmingham, United Kingdom"].

6. organization_locations: For region-bound searches, ALSO set organization_locations to the same array. This stops US-based people who happen to work for UK companies (and vice versa) leaking in.

RETURN FORMAT (only include fields you are setting):
{
  "q_keywords": "family office",
  "person_titles": ["Founder","CEO"],
  "person_seniorities": ["founder","c_suite","owner"],
  "q_organization_keyword_tags": ["technology"],
  "person_locations": ["United Kingdom","London, United Kingdom","Manchester, United Kingdom"],
  "organization_locations": ["United Kingdom","London, United Kingdom","Manchester, United Kingdom"],
  "searchTerms": ["tech founders UK"]
}

searchTerms: 1-3 summary terms for display only.${contextBlock}`,
        user: `Find global prospects matching: "${icp_description}"`,
      },
    }

    const prompt = prompts[source]
    const response = await getAnthropic().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
    })

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')

    let searchParams: Record<string, unknown> = {}
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      if (jsonMatch) searchParams = JSON.parse(jsonMatch[0])
    } catch {
      console.error('[Find] Failed to parse AI response:', text.slice(0, 500))
    }

    // ─── Apollo-specific guards ────────────────
    if (source === 'global_prospects') {
      if (searchParams.q_keywords) {
        const words = (searchParams.q_keywords as string).split(/\s+/).filter(Boolean)
        if (words.length > 2) {
          searchParams.q_keywords = words.slice(0, 2).join(' ')
          console.log(`[Find] Trimmed q_keywords to: "${searchParams.q_keywords}"`)
        }
      }

      const hasSignal = !!(searchParams.q_keywords
        || (searchParams.person_titles as string[] | undefined)?.length
        || (searchParams.q_organization_keyword_tags as string[] | undefined)?.length)
      if (!hasSignal) {
        const stopWords = new Set(['the','a','an','and','or','in','of','for','to','with','at','by','on','is','are','who','that','this','their','my','our','also','from','as','be','been','being','was','were','will','would','could','should','have','has','had','do','does','did','but','not','no','if','then','than','into','over','out','about','between','through','during','before','after','above','below','each','every','all','both','such','other','some','any','most','more','many','much','very','too','quite','rather','really','just','only','own','same','so','these','those','seeking','looking','need','needs','want','wants','based','including','particularly','especially','ideally','primarily','focused','targeting','individuals','professionals','clients','prospects','opportunities','exposure','alignment','emerging','strategy','advisory','ultra','high','net','worth','founder','founders','director','directors','ceo','ceos'])
        const keywords = icp_description
          .toLowerCase()
          .replace(/[^a-z0-9\s-]/g, ' ')
          .split(/\s+/)
          .filter((w) => w.length > 2 && !stopWords.has(w))
          .slice(0, 2)
          .join(' ')
        if (keywords) {
          searchParams.q_keywords = keywords
          console.log(`[Find] No signal from parser, fell back to q_keywords="${keywords}"`)
        }
      }

      // ─── Deterministic seniorities backstop (v75.1) ───
      // Even with the rules in the prompt, Haiku sometimes returns arrays that
      // drift between runs. Apply the same rule set here to guarantee the
      // "tech founders → founder-led" pattern holds run to run. This does not
      // override a sensible list from the parser — it only kicks in when the
      // list is empty or clearly off-shape.
      const seniorityFromIcp = inferSeniorities(`${icp_description} ${effectiveCustomInstructions}`)
      const senList = searchParams.person_seniorities as string[] | undefined
      const senIsMissing = !senList || senList.length === 0
      const senIsGeneric = Array.isArray(senList) && senList.length >= 5
      if (senIsMissing || senIsGeneric || !seniorityMatchesIcp(senList, seniorityFromIcp)) {
        searchParams.person_seniorities = seniorityFromIcp
        console.log(`[Find] Seniorities normalised to: ${seniorityFromIcp.join(',')}`)
      }

      // ─── HARD GEOGRAPHY LOCK ───
      const combinedText = `${icp_description} ${effectiveCustomInstructions}`
      const lockedLocations = detectGeographyLock(combinedText)
      if (lockedLocations) {
        searchParams.person_locations = lockedLocations
        searchParams.organization_locations = lockedLocations
        console.log(`[Find] Geography locked to: ${lockedLocations.slice(0, 3).join(', ')}... (${lockedLocations.length} locations)`)
      } else if (searchParams.person_locations && typeof searchParams.person_locations === 'string') {
        searchParams.person_locations = [searchParams.person_locations]
      }
    }

    console.log(`[Find] Source: ${source}, audience_mode: ${effectiveAudienceMode}, params:`, JSON.stringify(searchParams).slice(0, 600))

    const timeTakenMs = Date.now() - startTime
    const terms = (searchParams.searchTerms || searchParams.firmSearchTerms || []) as string[]

    return NextResponse.json({
      searchParams,
      source,
      audience_mode: effectiveAudienceMode,
      meta: {
        firmsFound: terms.length,
        searchTermsUsed: terms.slice(0, 5),
        geographyLocked: source === 'global_prospects' && !!detectGeographyLock(`${icp_description} ${effectiveCustomInstructions}`),
        customInstructionsApplied: !!effectiveCustomInstructions,
        timeTakenMs,
      },
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Finding failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// ── Deterministic seniority inference (v75.1) ──
// Given an ICP string, return a fixed seniorities array. Same input → same
// output, every time. Rules mirror the prompt so a well-behaved LLM output
// will pass the seniorityMatchesIcp check and be kept; drift falls back here.
function inferSeniorities(icp: string): string[] {
  const t = icp.toLowerCase()
  const has = (words: string[]) => words.some((w) => new RegExp(`\\b${w}\\b`, 'i').test(t))

  if (has(['founder', 'founders', 'co-founder', 'co-founders', 'founding'])) {
    return ['founder', 'c_suite', 'owner']
  }
  if (has(['ceo', 'ceos', 'cto', 'ctos', 'cfo', 'cfos', 'coo', 'coos', 'cmo', 'cmos', 'cio', 'cios', 'cxo', 'chief'])) {
    return ['c_suite', 'founder', 'owner']
  }
  if (has(['owner', 'owners', 'proprietor', 'managing director', 'md ', ' md', 'business owner'])) {
    return ['owner', 'founder', 'partner', 'c_suite']
  }
  if (has(['partner', 'partners', 'associate', 'associates'])) {
    return ['partner', 'c_suite', 'director']
  }
  if (has(['director', 'directors', 'head of', 'heads of', 'vp ', 'vice president', 'executive', 'senior'])) {
    return ['director', 'c_suite', 'vp', 'head']
  }
  if (has(['manager', 'managers', 'mid-level', 'mid level'])) {
    return ['manager', 'director', 'senior']
  }
  return ['director', 'c_suite', 'owner', 'partner', 'founder']
}

// Consider the parser's list acceptable if it contains the top-priority
// seniority for the ICP. This keeps sensible LLM lists while still catching
// drift (e.g. "tech founders" coming back as ["director","c_suite","owner",
// "partner","founder"] with founder buried at the end).
function seniorityMatchesIcp(actual: string[] | undefined, expected: string[]): boolean {
  if (!actual || actual.length === 0) return false
  const topExpected = expected[0]
  if (actual[0] === topExpected) return true
  // Also accept if the top-expected appears in first two positions
  return actual.slice(0, 2).includes(topExpected)
}
