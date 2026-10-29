import { NextRequest, NextResponse } from 'next/server'
import { requireRecruitmentAccess } from '@/lib/recruitment/gate'
import { searchFirmsPage, rankFirmMatches } from '@/lib/data-sources/fca-register'
import { z } from 'zod'

// Search the register for a firm to watch, by name or FRN.
const Schema = z.object({ query: z.string().min(2).max(120) })

export async function POST(req: NextRequest) {
  const gate = await requireRecruitmentAccess()
  if (!gate.ok) return gate.response

  const parsed = Schema.safeParse(await req.json())
  if (!parsed.success) return NextResponse.json({ error: 'Enter a firm name or FRN' }, { status: 400 })
  const q = parsed.data.query.trim()

  try {
    const isFrn = /^\d{5,7}$/.test(q)
    const [quoted, plain] = await Promise.all([
      isFrn ? Promise.resolve({ firms: [] as Awaited<ReturnType<typeof searchFirmsPage>>['firms'] }) : searchFirmsPage(`"${q.replace(/"/g, '')}"`, 1),
      searchFirmsPage(q, 1),
    ])
    const seen = new Set<string>()
    const merged = [...quoted.firms, ...plain.firms].filter((f) => {
      if (seen.has(f.referenceNumber)) return false
      seen.add(f.referenceNumber)
      return true
    })
    const ranked = isFrn ? merged.filter((f) => f.referenceNumber === q) : rankFirmMatches(q, merged)
    return NextResponse.json({
      firms: ranked.slice(0, 10).map((f) => ({ frn: f.referenceNumber, name: f.name, status: f.status })),
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Search failed' }, { status: 500 })
  }
}
