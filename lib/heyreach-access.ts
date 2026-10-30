// v78: which HeyReach campaigns a user may see in their LinkedIn pipeline.
// Dan runs HeyReach for clients in his own workspace and assigns campaigns
// to users on /dashboard/heyreach (table heyreach_campaign_access, migration
// 010). Admins see every campaign.

import type { createClient } from '@/lib/supabase/server'

type ServerClient = ReturnType<typeof createClient>

/**
 * The HeyReach campaign IDs assigned to this user, read with their own login
 * (RLS: own rows only). Missing table (migration not run yet) or any error
 * reads as "none", so nobody sees a campaign they weren't given.
 */
export async function assignedCampaignIds(supabase: ServerClient, userId: string): Promise<number[]> {
  const { data, error } = await supabase
    .from('heyreach_campaign_access')
    .select('heyreach_campaign_id')
    .eq('user_id', userId)
  if (error) {
    console.warn(`[Pipeline] Could not read campaign access for ${userId}: ${error.message}`)
    return []
  }
  return (data || []).map((r) => Number(r.heyreach_campaign_id)).filter((n) => Number.isFinite(n) && n > 0)
}

/**
 * The campaigns this user may see: all of them for an admin (allowed = null),
 * otherwise only the assigned IDs. Unknown IDs (a campaign deleted in
 * HeyReach) simply drop out.
 */
export function visibleCampaigns<T extends { id: number }>(all: T[], allowed: number[] | null): T[] {
  if (allowed === null) return all
  const ids = new Set(allowed)
  return all.filter((c) => ids.has(c.id))
}
