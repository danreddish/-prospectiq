import { NextRequest, NextResponse } from 'next/server'
import { requireHeyReachSender, userCampaigns } from '@/lib/heyreach-route'
import { checkHeyReachKey, getHeyReachCampaign, campaignProblem } from '@/lib/heyreach'
import { workspaceKey, type WorkspaceCampaign } from '@/lib/heyreach-workspaces'
import { HEYREACH_TEST_CAMPAIGN } from '@/lib/heyreach-shared'

export const dynamic = 'force-dynamic'

// v77: checks the HeyReach connection and the campaign leads will go into.
// v79: for admins and for users with a campaign assigned. Lists the campaigns
// this person can send into (any workspace for an admin; only their assigned
// ones otherwise) and checks the chosen one is running with a sender. Read
// only. Optional ?heyreach_campaign_id=&workspace_id= picks the campaign.

// The status changes when the campaign is started, so never cache this.
const NO_STORE = { headers: { 'Cache-Control': 'no-store' } }

/**
 * The campaign to check. A campaign asked for by id is that campaign or
 * nothing: never a silent fallback to another one. With nothing asked for,
 * an admin starts on "ProspectIQ test" in the main workspace (never a
 * client's campaign); a client starts on their first running campaign.
 */
function pick(campaigns: WorkspaceCampaign[], wantedId: number | null, wantedWorkspace: string | null | undefined, admin: boolean): WorkspaceCampaign | null {
  if (wantedId) {
    return campaigns.find((c) => c.id === wantedId && (wantedWorkspace === undefined || c.workspaceId === wantedWorkspace)) || null
  }
  if (admin) return campaigns.find((c) => c.workspaceId === null && c.name.trim().toLowerCase() === HEYREACH_TEST_CAMPAIGN.toLowerCase()) || null
  return campaigns.find((c) => c.status === 'IN_PROGRESS' || c.status === 'ACTIVE') || campaigns[0] || null
}

export async function GET(req: NextRequest) {
  const auth = await requireHeyReachSender()
  if (auth.response) return auth.response
  const say = (detail: string) => (auth.admin ? detail : 'Could not reach your LinkedIn campaign just now. Try again in a minute.')

  if (!process.env.HEYREACH_API_KEY && auth.admin) {
    return NextResponse.json({ keySet: false, campaigns: [], problem: 'HEYREACH_API_KEY is not set in Netlify yet. Add it, then redeploy so the functions pick it up.' }, NO_STORE)
  }

  const params = new URL(req.url).searchParams
  const wantedId = Number(params.get('heyreach_campaign_id')) || null
  const ws = params.get('workspace_id')
  const wantedWorkspace = ws === null ? undefined : ws === '' || ws === 'main' ? null : ws

  try {
    if (auth.admin && !(await checkHeyReachKey())) {
      return NextResponse.json({ keySet: true, keyValid: false, campaigns: [], problem: 'HeyReach rejected the main API key.' }, NO_STORE)
    }
    const { campaigns, errors } = await userCampaigns(auth.grants)
    const chosen = pick(campaigns, wantedId, wantedWorkspace, auth.admin)
    if (!chosen) {
      const listProblem = errors.length ? ` Could not list: ${errors.map((e) => `${e.workspaceName}: ${e.error}`).join('; ')}` : ''
      const problem = auth.admin
        ? wantedId
          ? `That campaign isn't available right now.${listProblem}`
          : `Choose the campaign to send into.${listProblem}`
        : say('No campaign found.')
      return NextResponse.json({ keySet: true, keyValid: true, campaigns, campaign: null, problem }, NO_STORE)
    }
    // GetById carries the sender accounts and the live status.
    const detail = await getHeyReachCampaign(chosen.id, 4000, await workspaceKey(chosen.workspaceId))
    const campaign = detail ? { ...detail, workspaceId: chosen.workspaceId, workspaceName: chosen.workspaceName } : null
    return NextResponse.json(
      {
        keySet: true,
        keyValid: true,
        campaigns,
        campaign,
        problem: campaignProblem(detail, chosen.name),
      },
      NO_STORE
    )
  } catch (err) {
    return NextResponse.json({ keySet: true, campaigns: [], problem: say(err instanceof Error ? err.message : 'HeyReach check failed') }, NO_STORE)
  }
}
