import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireRecruitmentAccess, reserveRecruitmentFindUnits, refundRecruitmentFindUnits } from '@/lib/recruitment/gate'
import { findApolloProspects } from '@/lib/data-sources/apollo-find'
import { ADVISER_TITLES } from '@/lib/recruitment/intent'
import { z } from 'zod'

// Role-led adviser search (v76): Apollo api_search with adviser titles from
// /api/recruitment/find, then enrichment by Apollo ID. Gated by Recruitment,
// not the client plan, and counted against the Recruitment search budget:
// one unit per enriched contact, reserved up front and the unused units
// given back. 5 per request; the browser pages through up to 6.
//
// Titles are limited to the adviser taxonomy on the server, so the
// Recruitment search budget can't be spent on general prospecting.

const ALLOWED_TITLES = new Map(
  Object.values(ADVISER_TITLES).flat().map((t) => [t.toLowerCase(), t] as const)
)
const DEFAULT_TITLES = Array.from(new Set([...ADVISER_TITLES.mortgage, ...ADVISER_TITLES.financial]))

const Schema = z.object({
  campaign_id: z.string().uuid(),
  search_term: z.string().min(1).max(1500),
  apollo_params: z.object({
    person_titles: z.array(z.string().max(120)).max(60).optional(),
    person_locations: z.array(z.string().max(120)).max(30).optional(),
    q_keywords: z.string().max(60).optional(),
    page: z.number().int().min(1).max(6).default(1),
  }),
})

export async function POST(req: NextRequest) {
  const gate = await requireRecruitmentAccess()
  if (!gate.ok) return gate.response

  const parsed = Schema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input' }, { status: 400 })
  }
  const { campaign_id, search_term, apollo_params } = parsed.data

  const supabase = createClient()
  const { data: campaign } = await supabase
    .from('campaigns')
    .select('id, purpose')
    .eq('id', campaign_id)
    .eq('user_id', gate.user.id)
    .single()
  if (!campaign || campaign.purpose !== 'advisers') {
    return NextResponse.json({ error: 'Recruitment campaign not found' }, { status: 404 })
  }

  const titles = Array.from(new Set(
    (apollo_params.person_titles || [])
      .map((t) => ALLOWED_TITLES.get(t.trim().toLowerCase()))
      .filter((t): t is string => !!t)
  ))
  const params = {
    person_titles: titles.length ? titles : DEFAULT_TITLES,
    person_locations: apollo_params.person_locations,
    q_keywords: apollo_params.q_keywords,
    page: apollo_params.page,
  }

  const budget = await reserveRecruitmentFindUnits(gate, 5)
  if (budget.response) return budget.response

  let returned = 0
  try {
    const result = await findApolloProspects(params, budget.granted, search_term, { noFallback: true })
    returned = result.individuals.length
    return NextResponse.json(result)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Search failed'
    console.error('[Recruitment find-apollo] error:', message)
    return NextResponse.json({ individuals: [], error: message }, { status: 500 })
  } finally {
    await refundRecruitmentFindUnits(gate, budget.granted - returned)
  }
}
