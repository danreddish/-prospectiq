// v79: HeyReach workspaces (server only).
//
// HeyReach API keys belong to one workspace. The main workspace uses
// HEYREACH_API_KEY from Netlify (workspace id null). Each client workspace
// Dan adds on /dashboard/heyreach is a row in heyreach_workspaces, its key in
// Supabase Vault (migration 011), read only here through a service-role RPC.
// Keys never go to the browser and are never logged.

import { createAdminClient } from '@/lib/supabase/server'
import { heyReachKeyIsSet, listHeyReachCampaigns, type HeyReachCampaignSummary } from '@/lib/heyreach'

export const MAIN_WORKSPACE_NAME = 'Main workspace'

export interface HeyReachWorkspace {
  /** null = the main workspace (HEYREACH_API_KEY in Netlify) */
  id: string | null
  name: string
  createdAt?: string
  keyUpdatedAt?: string
}

export interface WorkspaceCampaign extends HeyReachCampaignSummary {
  workspaceId: string | null
  workspaceName: string
}

/** The main workspace (if its key is set) and every added workspace. */
export async function listWorkspaces(): Promise<HeyReachWorkspace[]> {
  const out: HeyReachWorkspace[] = heyReachKeyIsSet() ? [{ id: null, name: MAIN_WORKSPACE_NAME }] : []
  const { data, error } = await createAdminClient()
    .from('heyreach_workspaces')
    .select('id, name, created_at, key_updated_at')
    .order('created_at', { ascending: true })
  if (error) {
    // Migration 011 not run yet: just the main workspace.
    console.warn(`[Workspaces] Could not list workspaces: ${error.message}`)
    return out
  }
  for (const w of data || []) {
    out.push({ id: w.id as string, name: w.name as string, createdAt: w.created_at as string, keyUpdatedAt: w.key_updated_at as string })
  }
  return out
}

/**
 * The API key for a workspace. Undefined for the main workspace, so the
 * HeyReach client falls back to HEYREACH_API_KEY. Throws if a client
 * workspace's key can't be read, so nothing runs against the wrong account.
 */
export async function workspaceKey(workspaceId: string | null): Promise<string | undefined> {
  if (!workspaceId) return undefined
  const { data, error } = await createAdminClient().rpc('heyreach_workspace_key', { p_id: workspaceId })
  if (error) throw new Error(`Could not read the workspace's HeyReach key: ${error.message}`)
  if (typeof data !== 'string' || !data) throw new Error('That HeyReach workspace has no key saved.')
  return data
}

/**
 * Campaigns from each workspace, tagged with where they live. A workspace
 * that fails (bad key, HeyReach down) is reported, not fatal.
 */
export async function campaignsAcrossWorkspaces(
  workspaces: HeyReachWorkspace[],
  timeoutMs = 3500
): Promise<{ campaigns: WorkspaceCampaign[]; errors: { workspaceName: string; error: string }[] }> {
  const results = await Promise.allSettled(
    workspaces.map(async (w) => {
      const key = await workspaceKey(w.id)
      const list = await listHeyReachCampaigns(timeoutMs, key)
      return list.map((c) => ({ ...c, workspaceId: w.id, workspaceName: w.name }))
    })
  )
  const campaigns: WorkspaceCampaign[] = []
  const errors: { workspaceName: string; error: string }[] = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') campaigns.push(...r.value)
    else errors.push({ workspaceName: workspaces[i].name, error: r.reason instanceof Error ? r.reason.message : String(r.reason) })
  })
  return { campaigns, errors }
}
