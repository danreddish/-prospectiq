import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireRecruitmentAccess, reserveRecruitmentFindUnits, refundRecruitmentFindUnits } from '@/lib/recruitment/gate'
import { parseHiringBrief, inferFamilies, buildUkLocations, ADVISER_TITLES } from '@/lib/recruitment/intent'
import { resolveFirm, searchFirmsPage, rankFirmMatches, type FCAFirmSearchResult } from '@/lib/data-sources/fca-register'
import { z } from 'zod'

// Parse a plain English hiring brief into one of two paths and return the
// parsed intent so the UI can show it.
//
// Firm-led: names firms, networks or ARs -> FCA Register, resolved to FRNs here.
// Role-led: no firm named -> Apollo api_search with adviser titles, run by
// /api/recruitment/find-apollo.

const FindSchema = z.object({
  campaign_id: z.string().uuid(),
  description: z.string().min(8).max(1500),
})

export interface ResolvedFirm {
  query: string
  frn: string | null
  name: string | null
  status: string | null
  alternatives: { frn: string; name: string; status: string }[]
}

export async function POST(req: NextRequest) {
  const gate = await requireRecruitmentAccess()
  if (!gate.ok) return gate.response

  const body = await req.json()
  const parsed = FindSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Describe who you want to hire in a sentence or two' }, { status: 400 })
  }
  const { campaign_id, description } = parsed.data

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

  // Reading the brief is a Claude call: one unit of the Recruitment search
  // budget, given back if it fails.
  const budget = await reserveRecruitmentFindUnits(gate, 1)
  if (budget.response) return budget.response

  const startTime = Date.now()

  try {
    const intent = await parseHiringBrief(description)

    // ── Firm-led: resolve names to FRNs now, so every later page is cheap ──
    let resolvedFirms: ResolvedFirm[] = []
    if (intent.path === 'firm_led') {
      resolvedFirms = await Promise.all(
        intent.firms.map(async (query): Promise<ResolvedFirm> => {
          try {
            const top = await resolveFirm(query)
            let alternatives: FCAFirmSearchResult[] = []
            try {
              const page = await searchFirmsPage(query, 1)
              alternatives = rankFirmMatches(query, page.firms)
                .filter((f) => !f.status.toLowerCase().includes('no longer') && !f.status.toLowerCase().includes('revoked'))
                .filter((f) => f.referenceNumber !== top?.referenceNumber)
                .slice(0, 4)
            } catch { /* alternatives are optional */ }
            return {
              query,
              frn: top?.referenceNumber || null,
              name: top?.name || null,
              status: top?.status || null,
              alternatives: alternatives.map((f) => ({ frn: f.referenceNumber, name: f.name, status: f.status })),
            }
          } catch {
            return { query, frn: null, name: null, status: null, alternatives: [] }
          }
        })
      )
    }

    // ── Role-led: Apollo params using the adviser title taxonomy ──
    let apolloParams: Record<string, unknown> | null = null
    if (intent.path === 'role_led') {
      const families = intent.role_families.length ? intent.role_families : inferFamilies(`${description} ${intent.roles.join(' ')}`)
      const titles = Array.from(new Set(families.flatMap((f) => ADVISER_TITLES[f] || [])))
      const locations = buildUkLocations(intent.locations)
      // person_locations only. Advisers at national networks work far from
      // the network's head office, so an organisation location filter would
      // exclude them.
      apolloParams = {
        person_titles: titles.length ? titles : ADVISER_TITLES.mortgage.concat(ADVISER_TITLES.financial),
        person_locations: locations,
      }
      if (intent.keywords) apolloParams.q_keywords = intent.keywords
    }

    return NextResponse.json({
      intent,
      resolved_firms: resolvedFirms,
      apollo_params: apolloParams,
      meta: { timeTakenMs: Date.now() - startTime },
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Finding failed'
    console.error('[Recruitment find] error:', message)
    await refundRecruitmentFindUnits(gate, budget.granted)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
