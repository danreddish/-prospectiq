import { NextResponse } from 'next/server'
import { requireHeyReachAdmin } from '@/lib/heyreach-route'
import { heyReachKeyIsSet, checkHeyReachKey, findHeyReachCampaign, campaignProblem } from '@/lib/heyreach'
import { HEYREACH_TEST_CAMPAIGN } from '@/lib/heyreach-shared'

export const dynamic = 'force-dynamic'

// The status changes when the campaign is started, so never cache this.
const NO_STORE = { headers: { 'Cache-Control': 'no-store' } }

// v77: checks the HeyReach connection and the test campaign. Read only.
export async function GET() {
  const auth = await requireHeyReachAdmin()
  if (auth.response) return auth.response

  if (!heyReachKeyIsSet()) {
    return NextResponse.json({
      keySet: false,
      problem: 'HEYREACH_API_KEY is not set in Netlify yet. Add it, then redeploy so the functions pick it up.',
    }, NO_STORE)
  }
  try {
    const keyValid = await checkHeyReachKey()
    if (!keyValid) {
      return NextResponse.json({ keySet: true, keyValid: false, problem: 'HeyReach rejected the API key.' }, NO_STORE)
    }
    const campaign = await findHeyReachCampaign(HEYREACH_TEST_CAMPAIGN)
    return NextResponse.json({
      keySet: true,
      keyValid: true,
      campaign,
      problem: campaignProblem(campaign, HEYREACH_TEST_CAMPAIGN),
    }, NO_STORE)
  } catch (err) {
    return NextResponse.json({ keySet: true, problem: err instanceof Error ? err.message : 'HeyReach check failed' }, NO_STORE)
  }
}
