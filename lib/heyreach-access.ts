// v78/v79: which HeyReach campaigns a user may see in their LinkedIn
// pipeline and send into. Dan runs HeyReach for clients and assigns
// campaigns to users on /dashboard/heyreach (table heyreach_campaign_access,
// migrations 010 and 011). Admins see and send into every campaign.

import type { createClient } from '@/lib/supabase/server'
import type { HeyReachWorkspace, WorkspaceCampaign } from '@/lib/heyreach-workspaces'

type ServerClient = ReturnType<typeof createClient>

export interface CampaignGrant {
  heyreachCampaignId: number
  /** null = the main workspace */
  workspaceId: string | null
}

/**
 * The HeyReach campaigns assigned to this user, read with their own login
 * (RLS: own rows only). Missing table, missing column (migration 011 not
 * run) or any error reads as "none", so nobody gets a campaign they weren't
 * given.
 */
export async function campaignGrants(supabase: ServerClient, userId: string): Promise<CampaignGrant[]> {
  const { data, error } = await supabase
    .from('heyreach_campaign_access')
    .select('heyreach_campaign_id, workspace_id')
    .eq('user_id', userId)
  if (error) {
    console.warn(`[Access] Could not read campaign access for ${userId}: ${error.message}`)
    return []
  }
  return (data || [])
    .map((r) => ({ heyreachCampaignId: Number(r.heyreach_campaign_id), workspaceId: (r.workspace_id as string | null) || null }))
    .filter((g) => Number.isFinite(g.heyreachCampaignId) && g.heyreachCampaignId > 0)
}

/**
 * The campaigns this user may see: all of them for an admin (grants = null),
 * otherwise only the assigned ones, matched on campaign AND workspace.
 * Unknown campaigns (deleted in HeyReach) simply drop out.
 */
export function visibleCampaigns<T extends { id: number; workspaceId?: string | null }>(all: T[], grants: CampaignGrant[] | null): T[] {
  if (grants === null) return all
  return all.filter((c) => grants.some((g) => g.heyreachCampaignId === c.id && g.workspaceId === (c.workspaceId ?? null)))
}

/** Only the workspaces a user's grants point at (admins: all). */
export function workspacesFor(workspaces: HeyReachWorkspace[], grants: CampaignGrant[] | null): HeyReachWorkspace[] {
  if (grants === null) return workspaces
  const ids = new Set(grants.map((g) => g.workspaceId ?? 'main'))
  return workspaces.filter((w) => ids.has(w.id ?? 'main'))
}

export type { WorkspaceCampaign }
