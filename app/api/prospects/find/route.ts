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

// ── UK Geography Lock ──
// Apollo's person_locations does fuzzy matching. Passing just "United Kingdom"
// often leaks US/Commonwealth results. Including specific cities anchors the
// search much more reliably.
const UK_LOCATIONS = [
  'United Kingdom',
  'England',
  'Scotland',
  'Wales',
  'Northern Ireland',
  'London',
  'Manchester',
  'Birmingham',
  'Leeds',
  'Liverpool',
  'Sheffield',
  'Bristol',
  'Edinburgh',
  'Glasgow',
  'Cardiff',
  'Belfast',
  'Newcastle',
  'Nottingham',
  'Cambridge',
  'Oxford',
  'Brighton',
  'Reading',
]

// Country aliases the user might type, mapped to the strict location array.
const GEOGRAPHY_LOCK: Record<string, string[]> = {
  uk: UK_LOCATIONS,
  'united kingdom': UK_LOCATIONS,
  britain: UK_LOCATIONS,
  'great britain': UK_LOCATIONS,
  england: UK_LOCATIONS,
  scotland: ['Scotland', 'Edinburgh', 'Glasgow', 'Aberdeen', 'Dundee'],
  wales: ['Wales', 'Cardiff', 'Swansea', 'Newport'],
  ireland: ['Ireland', 'Dublin', 'Cork', 'Galway'],
  uae: ['United Arab Emirates', 'Dubai', 'Abu Dhabi', 'Sharjah'],
  'united arab emirates': ['United Arab Emirates', 'Dubai', 'Abu Dhabi', 'Sharjah'],
  dubai: ['Dubai', 'United Arab Emirates'],
  singapore: ['Singapore'],
  switzerland: ['Switzerland', 'Zurich', 'Geneva', 'Basel', 'Bern'],
  germany: ['Germany', 'Berlin', 'Munich', 'Frankfurt', 'Hamburg'],
  france: ['France', 'Paris', 'Lyon', 'Marseille'],
  australia: ['Australia', 'Sydney', 'Melbourne', 'Brisbane', 'Perth'],
  canada: ['Canada', 'Toronto', 'Vancouver', 'Montreal', 'Calgary'],
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

  // Load campaign + profile so we know the user's service profile and can
  // honour the audience_mode toggle.
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

    // Build the context block the parser sees.
    // The audience_mode toggle controls whether the seller's profile is
    // injected as positive ICP context or stripped entirely.
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

4. person_seniorities: ALWAYS include. Default is ["director","c_suite","owner","partner","founder"] for founders, swap to ["director","c_suite","vp","head","manager"] for non-founders.

5. person_locations: STRICT. Always return an ARRAY of strings, never a single string. For a country, include the country name AND its major cities. For the UK include: ["United Kingdom","England","Scotland","Wales","Northern Ireland","London","Manchester","Birmingham","Leeds","Edinburgh","Glasgow","Bristol"].

6. organization_locations: For region-bound searches, ALSO set organization_locations to the same array. This stops US-based people who happen to work for UK companies (and vice versa) leaking in.

RETURN FORMAT (only include fields you are setting):
{
  "q_keywords": "family office",
  "person_titles": ["Founder","CEO"],
  "person_seniorities": ["director","c_suite","owner","partner"],
  "q_organization_keyword_tags": ["technology"],
  "person_locations": ["United Kingdom","London","Manchester"],
  "organization_locations": ["United Kingdom","London","Manchester"],
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
      // Trim q_keywords to max 2 meaningful words
      if (searchParams.q_keywords) {
        const words = (searchParams.q_keywords as string).split(/\s+/).filter(Boolean)
        if (words.length > 2) {
          searchParams.q_keywords = words.slice(0, 2).join(' ')
          console.log(`[Find] Trimmed q_keywords to: "${searchParams.q_keywords}"`)
        }
      }

      // If the parser supplied no usable signal at all, fall back to extracting
      // a 2-word keyword from the ICP.
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

      // Default seniorities
      if (!searchParams.person_seniorities) {
        searchParams.person_seniorities = ['director', 'c_suite', 'owner', 'partner', 'founder']
      }

      // ─── HARD GEOGRAPHY LOCK ───
      // If the user named a country/region anywhere in the ICP or in custom
      // instructions, force a strict location array. This overrides whatever
      // the parser produced (which is often a soft single-string country).
      const combinedText = `${icp_description} ${effectiveCustomInstructions}`
      const lockedLocations = detectGeographyLock(combinedText)
      if (lockedLocations) {
        searchParams.person_locations = lockedLocations
        searchParams.organization_locations = lockedLocations
        console.log(`[Find] Geography locked to: ${lockedLocations.slice(0, 3).join(', ')}... (${lockedLocations.length} locations)`)
      } else if (searchParams.person_locations && typeof searchParams.person_locations === 'string') {
        // Parser gave a string instead of an array, coerce
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
