import { NextRequest, NextResponse } from 'next/server'
import { requireRecruitmentAccess } from '@/lib/recruitment/gate'
import { getFirmSignals } from '@/lib/data-sources/fca-register'
import { z } from 'zod'

// Firm signals for one FRN. The research client calls this once per firm
// in a batch and passes the result into each adviser research request, so
// a firm-led batch of 25 advisers at one network costs one set of firm
// calls, not 25.

const Schema = z.object({
  frn: z.string().regex(/^\d{5,7}$/),
})

export async function POST(req: NextRequest) {
  const gate = await requireRecruitmentAccess()
  if (!gate.ok) return gate.response

  const body = await req.json()
  const parsed = Schema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid FRN' }, { status: 400 })
  }

  try {
    const signals = await getFirmSignals(parsed.data.frn, { arSteps: 7, includePermissions: true })
    if (!signals) return NextResponse.json({ error: 'Firm not found on the register' }, { status: 404 })
    return NextResponse.json({ firm_signals: signals })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Lookup failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
