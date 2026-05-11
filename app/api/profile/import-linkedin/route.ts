import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { enrichFullProfileByLinkedInUrl } from '@/lib/data-sources/apollo'
import { getAnthropic } from '@/lib/ai-engine'
import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'

export async function POST(request: Request) {
  try {
    const { linkedin_url, about_text } = await request.json()

    if (!linkedin_url && !about_text) {
      return NextResponse.json(
        { error: 'Please provide a LinkedIn URL or paste your About section.' },
        { status: 400 }
      )
    }

    // Validate LinkedIn URL format if provided
    if (linkedin_url) {
      const cleaned = linkedin_url.trim().toLowerCase()
      if (!cleaned.includes('linkedin.com/in/')) {
        return NextResponse.json(
          { error: 'That doesn\'t look like a LinkedIn profile URL. It should contain linkedin.com/in/' },
          { status: 400 }
        )
      }
    }

    // Authenticate user
    const cookieStore = await cookies()
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { cookies: { getAll: () => cookieStore.getAll() } }
    )
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    // Step 1: Apollo enrichment from LinkedIn URL
    let apolloContext = ''
    let apolloName = ''
    if (linkedin_url) {
      const profile = await enrichFullProfileByLinkedInUrl(linkedin_url.trim())
      if (profile) {
        apolloName = profile.name || ''
        const parts: string[] = []
        if (profile.name) parts.push(`Name: ${profile.name}`)
        if (profile.title) parts.push(`Current role: ${profile.title}`)
        if (profile.company) parts.push(`Company: ${profile.company}`)
        if (profile.headline) parts.push(`Headline: ${profile.headline}`)
        if (profile.location) parts.push(`Location: ${profile.location}`)
        if (profile.org_industry) parts.push(`Industry: ${profile.org_industry}`)
        if (profile.seniority) parts.push(`Seniority: ${profile.seniority}`)
        if (profile.departments?.length) parts.push(`Departments: ${profile.departments.join(', ')}`)
        if (profile.org_website) parts.push(`Company website: ${profile.org_website}`)
        if (profile.employment_history?.length) {
          const history = profile.employment_history
            .slice(0, 8)
            .map((e) => `${e.title} at ${e.company}${e.current ? ' (current)' : ''}${e.start_date ? ` from ${e.start_date}` : ''}${e.end_date ? ` to ${e.end_date}` : ''}`)
            .join('; ')
          parts.push(`Employment history: ${history}`)
        }
        apolloContext = parts.join('\n')
      }
    }

    // Step 2: Build AI prompt to extract service profile
    const inputParts: string[] = []
    if (apolloContext) {
      inputParts.push('PROFESSIONAL DATA (from verified database):\n' + apolloContext)
    }
    if (about_text?.trim()) {
      inputParts.push('LINKEDIN ABOUT SECTION:\n' + about_text.trim())
    }

    if (inputParts.length === 0) {
      return NextResponse.json(
        { error: 'Could not find any profile data. Check the LinkedIn URL is correct.' },
        { status: 404 }
      )
    }

    const anthropic = getAnthropic()
    const aiResponse = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      system: `Extract a service offering profile from this financial professional's LinkedIn data. Return JSON only.
The person is a financial services professional (wealth manager, IFA, financial planner, mortgage broker, or similar). Infer their service offering from their role, company, headline, About section, and employment history.
If data is limited, make reasonable inferences but keep text short and specific.
JSON format:
{"what_you_do":"One sentence describing their core service","who_you_help":"Who their ideal clients are, be specific about client type and wealth level","key_outcomes":"3-5 key outcomes they deliver, comma-separated","minimum_threshold":"Estimated minimum client threshold based on their positioning, or null if unclear","geographic_focus":"Where they operate based on location data"}
British English. Short, specific sentences. No waffle.`,
      messages: [{
        role: 'user',
        content: inputParts.join('\n\n'),
      }],
    })

    const text = aiResponse.content
      .filter((b) => b.type === 'text')
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')

    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return NextResponse.json(
        { error: 'AI could not extract a service profile. Try pasting your About section for better results.' },
        { status: 422 }
      )
    }

    const parsed = JSON.parse(jsonMatch[0])

    return NextResponse.json({
      success: true,
      apollo_found: !!apolloContext,
      apollo_name: apolloName || null,
      service_profile: {
        what_you_do: parsed.what_you_do || null,
        who_you_help: parsed.who_you_help || null,
        key_outcomes: parsed.key_outcomes || null,
        minimum_threshold: parsed.minimum_threshold || null,
        geographic_focus: parsed.geographic_focus || null,
      },
    })
  } catch (err) {
    console.error('LinkedIn import error:', err)
    return NextResponse.json(
      { error: 'Something went wrong importing your profile. Please try again.' },
      { status: 500 }
    )
  }
}
