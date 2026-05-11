import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getAnthropic } from '@/lib/ai-engine'
import { z } from 'zod'

const FindSchema = z.object({
  campaign_id: z.string().uuid(),
  icp_description: z.string().min(10),
  max_prospects: z.number().min(5).max(50).default(25),
  source: z.enum(['hnw_clients', 'financial_professionals', 'global_prospects']).default('hnw_clients'),
})

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

  const { campaign_id, icp_description, max_prospects, source } = parsed.data

  const { data: campaign } = await supabase
    .from('campaigns')
    .select('*')
    .eq('id', campaign_id)
    .eq('user_id', user.id)
    .single()

  if (!campaign) {
    return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
  }

  try {
    const startTime = Date.now()

    const prompts: Record<string, { system: string; user: string }> = {
      financial_professionals: {
        system: `Generate search terms for the UK FCA Register API. PROVEN terms: "mortgage advisors", "mortgage solutions", "independent financial advisers", "private client", "IFA", "wealth advisors", "advisory ltd". DO NOT USE: "mortgage", "financial", "wealth management ltd". Return JSON: {"firmSearchTerms":["..."],"roleKeywords":["director"],"locations":["..."]}`,
        user: `Find FCA-registered professionals matching: "${icp_description}"`,
      },
      hnw_clients: {
        system: `Generate Companies House search terms for HNW company directors. Return JSON: {"searchTerms":["property development Surrey","investment holdings London"],"targetLocations":["Surrey"],"targetRoles":["director"]}. searchTerms: 8-15 queries mixing industry + location.`,
        user: `Find HNW prospect search parameters for: "${icp_description}"`,
      },
      global_prospects: {
        system: `Generate Apollo.io People Search API parameters to find prospects globally. Return JSON only.

IMPORTANT: Apollo uses AND logic across ALL filters AND across all words in q_keywords. Every word you add NARROWS results. "family office" returns thousands. "family office investment strategy deeptech" returns ZERO because nobody matches ALL those words.

RULES:
1. q_keywords: Use MAXIMUM 2-3 words. This is a keyword AND search. Use ONLY the core entity type. Examples: "family office", "property development", "private equity", "venture capital", "mortgage broker". NEVER add qualifiers like "investment strategy" or "deeptech" or "UHNW" — these kill results.
2. person_seniorities: ALWAYS include. Use ["director","c_suite","owner","partner","vp"] unless the ICP specifies otherwise.
3. person_locations: Include ONLY if the ICP specifies a region. Use broad regions like "United Kingdom" or "United Arab Emirates".
4. person_titles: OMIT unless the ICP names very specific job titles.
5. q_organization_keyword_tags: OMIT for niche searches.
6. organization_num_employees_ranges: OMIT unless company size is explicitly important.

RETURN FORMAT:
{
  "q_keywords": "family office",
  "person_seniorities": ["director", "c_suite", "owner", "partner"],
  "person_locations": ["United Arab Emirates"],
  "searchTerms": ["family office principals UAE"]
}

Only include fields you are using. Omit all others.
searchTerms: 1-3 summary terms for display only.`,
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
    } catch (parseErr) {
      console.error('[Find] Failed to parse AI response:', text.slice(0, 500))
    }

    // For global Apollo searches: ALWAYS ensure q_keywords exists
    // This is the safety net that prevents zero-result searches
    if (source === 'global_prospects' && !searchParams.q_keywords) {
      // Extract first 2 meaningful words from the ICP description
      const stopWords = new Set(['the','a','an','and','or','in','of','for','to','with','at','by','on','is','are','who','that','this','their','my','our','also','from','as','be','been','being','was','were','will','would','could','should','have','has','had','do','does','did','but','not','no','if','then','than','into','over','out','about','between','through','during','before','after','above','below','each','every','all','both','such','other','some','any','most','more','many','much','very','too','quite','rather','really','just','only','own','same','so','these','those','seeking','looking','need','needs','want','wants','based','including','particularly','especially','ideally','primarily','focused','targeting','individuals','professionals','clients','prospects','opportunities','exposure','alignment','emerging','strategy','advisory','ultra','high','net','worth'])
      const keywords = icp_description
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !stopWords.has(w))
        .slice(0, 2)
        .join(' ')
      if (keywords) {
        searchParams.q_keywords = keywords
        console.log(`[Find] Injected q_keywords from ICP: "${keywords}"`)
      }
    }

    // Also enforce max 3 words in q_keywords even if AI generated more
    if (source === 'global_prospects' && searchParams.q_keywords) {
      const words = (searchParams.q_keywords as string).split(/\s+/)
      if (words.length > 3) {
        searchParams.q_keywords = words.slice(0, 2).join(' ')
        console.log(`[Find] Trimmed q_keywords to: "${searchParams.q_keywords}"`)
      }
    }

    // For global Apollo searches: ALWAYS ensure person_seniorities exists
    if (source === 'global_prospects' && !searchParams.person_seniorities) {
      searchParams.person_seniorities = ['director', 'c_suite', 'owner', 'partner', 'vp']
    }

    console.log(`[Find] Source: ${source}, AI params:`, JSON.stringify(searchParams))

    const timeTakenMs = Date.now() - startTime
    const terms = (searchParams.searchTerms || searchParams.firmSearchTerms || []) as string[]

    return NextResponse.json({
      searchParams,
      source,
      meta: {
        firmsFound: terms.length,
        searchTermsUsed: terms.slice(0, 5),
        timeTakenMs,
      },
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Finding failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
