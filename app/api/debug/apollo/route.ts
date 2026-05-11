import { NextResponse } from 'next/server'
import { enrichWithApollo, searchPeople, enrichById } from '@/lib/data-sources/apollo'

export const dynamic = 'force-dynamic'

export async function GET() {
  const hasKey = !!process.env.APOLLO_API_KEY
  const keyPrefix = process.env.APOLLO_API_KEY?.slice(0, 8) || 'NOT SET'

  if (!hasKey) {
    return NextResponse.json({ success: false, error: 'APOLLO_API_KEY not set', keyPrefix })
  }

  const results: Record<string, unknown> = { keyPrefix }

  // Test 1: Enrich by name
  try {
    const enrich = await enrichWithApollo('Dan', 'Reddish', 'AI Wealth Partners')
    results.enrichTest = {
      success: true,
      hasLinkedIn: !!enrich?.linkedin_url,
      linkedin: enrich?.linkedin_url || null,
      email: enrich?.email ? 'found' : 'not found',
    }
  } catch (err: unknown) {
    results.enrichTest = { success: false, error: err instanceof Error ? err.message : String(err) }
  }

  // Test 2: Search — with detailed error capture
  try {
    // Raw fetch to see exact response
    const apiKey = process.env.APOLLO_API_KEY!
    const rawRes = await fetch('https://api.apollo.io/v1/mixed_people/api_search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': apiKey,
      },
      body: JSON.stringify({
        api_key: apiKey,
        person_locations: ['London, United Kingdom'],
        person_seniorities: ['director', 'c_suite'],
        person_titles: ['director', 'managing director'],
        q_organization_keyword_tags: ['property', 'real estate'],
        per_page: 3,
        page: 1,
      }),
    })

    const rawBody = await rawRes.text()
    let parsed = null
    try { parsed = JSON.parse(rawBody) } catch { /* not json */ }

    results.searchTest = {
      httpStatus: rawRes.status,
      totalEntries: parsed?.total_entries ?? null,
      peopleReturned: parsed?.people?.length ?? 0,
      firstPerson: parsed?.people?.[0] || null,
      rawResponsePreview: rawBody.slice(0, 500),
    }

    // Test 3: Enrich by ID if search returned results
    if (parsed?.people?.[0]?.id) {
      const enriched = await enrichById(parsed.people[0].id)
      results.enrichByIdTest = {
        success: true,
        name: enriched?.name || null,
        linkedin: enriched?.linkedin_url || null,
        email: enriched?.email ? 'found' : 'not found',
        phone: enriched?.phone ? 'found' : 'not found',
        company: enriched?.company || null,
      }
    }
  } catch (err: unknown) {
    results.searchTest = { success: false, error: err instanceof Error ? err.message : String(err) }
  }

  return NextResponse.json(results)
}
