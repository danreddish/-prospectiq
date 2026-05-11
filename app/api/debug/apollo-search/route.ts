import { NextResponse } from 'next/server'
import { searchPeople } from '@/lib/data-sources/apollo'

export const dynamic = 'force-dynamic'

export async function GET() {
  const results: Record<string, unknown> = {}

  // Test 1: Minimal search - just q_keywords + seniorities (should return thousands)
  try {
    const test1 = await searchPeople({
      q_keywords: 'family office',
      person_seniorities: ['director', 'c_suite', 'owner', 'partner'],
      per_page: 3,
      page: 1,
    })
    results.test1_keywords_only = {
      success: true,
      totalEntries: test1.totalEntries,
      peopleReturned: test1.people.length,
      firstPerson: test1.people[0] || null,
    }
  } catch (err: unknown) {
    results.test1_keywords_only = { success: false, error: String(err) }
  }

  // Test 2: Over-filtered search (likely returns 0)
  try {
    const test2 = await searchPeople({
      q_keywords: 'single family office UHNW',
      person_seniorities: ['director', 'c_suite', 'owner', 'partner'],
      person_titles: ['principal', 'chief investment officer', 'CIO'],
      q_organization_keyword_tags: ['investment management', 'financial services'],
      organization_num_employees_ranges: ['1,10', '11,50'],
      person_locations: ['Middle East', 'Australia', 'Europe'],
      per_page: 3,
      page: 1,
    })
    results.test2_over_filtered = {
      success: true,
      totalEntries: test2.totalEntries,
      peopleReturned: test2.people.length,
    }
  } catch (err: unknown) {
    results.test2_over_filtered = { success: false, error: String(err) }
  }

  // Test 3: Raw API key check
  results.apollo_key_set = !!process.env.APOLLO_API_KEY
  results.apollo_key_prefix = process.env.APOLLO_API_KEY?.slice(0, 8) || 'NOT SET'

  return NextResponse.json(results)
}
