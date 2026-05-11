import { NextRequest, NextResponse } from 'next/server'
import { researchProspect } from '@/lib/ai-engine'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const startTime = Date.now()

  try {
    const result = await researchProspect(
      {
        name: 'John Smith',
        role: 'Director',
        company: 'Smith Property Holdings Ltd',
        location: 'Guildford, Surrey',
        linkedin_url: '',
      },
      {
        niche: 'Retirement planning for business owners',
        senderName: 'Dan Reddish',
      }
    )

    return NextResponse.json({
      success: true,
      timeTakenMs: Date.now() - startTime,
      tier: result.tier,
      total_score: result.total_score,
      research_notes: result.research_notes?.slice(0, 200),
      step1_chars: result.outreach?.step1?.chars,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({
      success: false,
      timeTakenMs: Date.now() - startTime,
      error: message,
    })
  }
}
