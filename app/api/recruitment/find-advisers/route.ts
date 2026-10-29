import { NextRequest, NextResponse } from 'next/server'
import { requireRecruitmentAccess } from '@/lib/recruitment/gate'
import { findViaPrincipal, findViaAppointedReps } from '@/lib/recruitment/find-advisers'
import { z } from 'zod'

// Firm-led candidate search, 25 per request, cursor paginated.
// Logic lives in lib/recruitment/find-advisers.ts.

const Schema = z.object({
  frn: z.string().regex(/^\d{5,7}$/),
  firm_name: z.string().min(1).max(200),
  include_ars: z.boolean().default(false),
  cursor: z.object({
    page: z.number().int().min(1).default(1),
    offset: z.number().int().min(0).default(0),
  }).optional(),
})

export async function POST(req: NextRequest) {
  const gate = await requireRecruitmentAccess()
  if (!gate.ok) return gate.response

  const body = await req.json()
  const parsed = Schema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }
  const { frn, firm_name, include_ars, cursor } = parsed.data
  const startPage = cursor?.page || 1
  const startOffset = cursor?.offset || 0
  const startedAt = Date.now()

  try {
    if (include_ars) {
      return NextResponse.json(await findViaAppointedReps(frn, firm_name, startPage, startOffset, startedAt))
    }
    return NextResponse.json(await findViaPrincipal(frn, firm_name, startPage, startOffset, startedAt))
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Search failed'
    console.error('[Recruitment find-advisers] error:', message)
    return NextResponse.json({ candidates: [], error: message, done: true })
  }
}
