// v77: HeyReach public API client (server only).
//
// The key is HEYREACH_API_KEY in Netlify, alongside the other secret keys.
// It is never logged or returned to the browser.
//
// HeyReach's public docs are thin, so this client is written defensively:
// it accepts the field names seen in the wild for the same value, and the
// push route stores HeyReach's raw replies so we can see exactly what was
// accepted. What we rely on:
//   - Base URL https://api.heyreach.io/api/public, header X-API-KEY.
//   - GET  /auth/CheckApiKey                     200 when the key is live.
//   - POST /campaign/GetAll {offset, limit}      {totalCount, items[]}
//   - GET  /campaign/GetById?campaignId=         campaign with its sender accounts
//   - POST /campaign/AddLeadsToCampaignV2        {campaignId, accountLeadPairs[]}
//         -> {addedLeadsCount, updatedLeadsCount, failedLeadsCount}
//         Only works on a running campaign (not a draft). A lead without a
//         first name, last name or profile URL fails silently.
//   - POST /lead/GetLead {profileUrl}            the LinkedIn profile HeyReach matched
//   - POST /campaign/GetLeadsFromCampaign        {campaignId, offset, limit}
//         -> {totalCount, items[]}, each with leadCampaignStatus,
//         leadConnectionStatus, leadMessageStatus (v78 pipeline)
//   - POST /stats/GetOverallStats                {accountIds, campaignIds, startDate, endDate}
//         -> {overallStats, byDayStats} (v78 pipeline)
//   - 300 requests a minute across the whole API.

import { HEYREACH_MESSAGE_FIELDS, type HeyReachMessages } from '@/lib/heyreach-shared'
import type { PipelineActivity, PipelineLead } from '@/lib/heyreach-pipeline'

const HEYREACH_BASE = 'https://api.heyreach.io/api/public'

/** Campaign statuses HeyReach accepts new leads in. */
const PUSHABLE_STATUSES = new Set(['ACTIVE', 'IN_PROGRESS'])

export function heyReachKeyIsSet(): boolean {
  return !!process.env.HEYREACH_API_KEY
}

export interface HeyReachReply {
  ok: boolean
  status: number
  ms: number
  body: unknown
  /** Raw text, cut to 2,000 characters, for the record. */
  text: string
}

async function heyReachRequest(
  path: string,
  init: { method?: 'GET' | 'POST'; body?: unknown; timeoutMs?: number; apiKey?: string } = {}
): Promise<HeyReachReply> {
  // v79: a workspace's own key, or the main workspace's key from Netlify.
  const key = init.apiKey || process.env.HEYREACH_API_KEY
  if (!key) throw new Error('HEYREACH_API_KEY is not set in Netlify.')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 5000)
  const startedAt = Date.now()
  try {
    const res = await fetch(`${HEYREACH_BASE}${path}`, {
      method: init.method || 'POST',
      headers: {
        'X-API-KEY': key,
        Accept: 'application/json',
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    })
    const text = await res.text().catch(() => '')
    let body: unknown = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = text
    }
    const reply = { ok: res.ok, status: res.status, ms: Date.now() - startedAt, body, text: text.slice(0, 2000) }
    console.log(`[HeyReach] ${init.method || 'POST'} ${path.split('?')[0]}: ${reply.status} in ${reply.ms}ms`)
    return reply
  } catch (err) {
    const message = err instanceof Error && err.name === 'AbortError' ? 'timed out' : err instanceof Error ? err.message : String(err)
    console.error(`[HeyReach] ${init.method || 'POST'} ${path.split('?')[0]} failed after ${Date.now() - startedAt}ms: ${message}`)
    throw new Error(`HeyReach ${path.split('?')[0]} ${message}`)
  } finally {
    clearTimeout(timer)
  }
}

function pick<T = unknown>(obj: unknown, ...keys: string[]): T | undefined {
  if (!obj || typeof obj !== 'object') return undefined
  const o = obj as Record<string, unknown>
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k] as T
  return undefined
}

export async function checkHeyReachKey(apiKey?: string): Promise<boolean> {
  const reply = await heyReachRequest('/auth/CheckApiKey', { method: 'GET', apiKey })
  return reply.ok
}

export interface HeyReachCampaign {
  id: number
  name: string
  status: string
  /** Sender LinkedIn account IDs attached to the campaign. */
  accountIds: number[]
  pushable: boolean
}

function accountIdsFrom(campaign: unknown): number[] {
  const raw = pick<unknown[]>(campaign, 'campaignAccountIds', 'linkedInAccountIds', 'accountIds') || []
  const ids = raw
    .map((v) => (typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number(pick(v, 'id', 'accountId', 'linkedInAccountId'))))
    .filter((n) => Number.isFinite(n) && n > 0)
  return Array.from(new Set(ids))
}

function campaignFrom(item: unknown, detail: unknown): HeyReachCampaign {
  const id = Number(pick(detail, 'id', 'campaignId') ?? pick(item, 'id', 'campaignId'))
  const status = String(pick(detail, 'status') || pick(item, 'status') || '').toUpperCase()
  const accountIds = accountIdsFrom(detail).length ? accountIdsFrom(detail) : accountIdsFrom(item)
  return {
    id,
    name: String(pick(detail, 'name') || pick(item, 'name') || ''),
    status,
    accountIds,
    pushable: PUSHABLE_STATUSES.has(status) && accountIds.length > 0,
  }
}

/** One campaign by ID, with its sender accounts. */
export async function getHeyReachCampaign(id: number, timeoutMs = 3000, apiKey?: string): Promise<HeyReachCampaign | null> {
  const reply = await heyReachRequest(`/campaign/GetById?campaignId=${id}`, { method: 'GET', timeoutMs, apiKey })
  if (!reply.ok || !reply.body || typeof reply.body !== 'object') return null
  return campaignFrom(reply.body, reply.body)
}

/**
 * Finds a campaign by its exact name (case and outer spaces ignored). If
 * several share the name, the running one wins; two running ones is an error,
 * so a lead never lands in a copy by mistake.
 */
export async function findHeyReachCampaign(name: string, apiKey?: string): Promise<HeyReachCampaign | null> {
  const wanted = name.trim().toLowerCase()
  const limit = 100
  const matches: unknown[] = []
  for (let offset = 0; offset < 500; offset += limit) {
    const reply = await heyReachRequest('/campaign/GetAll', { body: { offset, limit }, timeoutMs: 4000, apiKey })
    if (!reply.ok) throw new Error(`HeyReach campaign list returned ${reply.status}: ${reply.text.slice(0, 200)}`)
    const items = pick<unknown[]>(reply.body, 'items', 'campaigns', 'data') || []
    matches.push(...items.filter((c) => String(pick(c, 'name') || '').trim().toLowerCase() === wanted))
    const total = Number(pick(reply.body, 'totalCount', 'total') || 0)
    if (items.length < limit || offset + limit >= total) break
  }
  if (matches.length === 0) return null
  const running = matches.filter((m) => PUSHABLE_STATUSES.has(String(pick(m, 'status') || '').toUpperCase()))
  if (running.length > 1) {
    throw new Error(`${running.length} running HeyReach campaigns are called "${name}". Rename or stop the extra ones first.`)
  }
  const item = running[0] || matches[0]
  const id = Number(pick(item, 'id', 'campaignId'))
  // GetById carries the sender accounts reliably; the list may not.
  const byId = await heyReachRequest(`/campaign/GetById?campaignId=${id}`, { method: 'GET', timeoutMs: 4000, apiKey })
  return campaignFrom(item, byId.ok && byId.body && typeof byId.body === 'object' ? byId.body : item)
}

export function campaignProblem(campaign: HeyReachCampaign | null, name: string): string | null {
  if (!campaign) return `No HeyReach campaign called "${name}" was found.`
  if (!PUSHABLE_STATUSES.has(campaign.status)) {
    return `"${campaign.name}" is ${campaign.status || 'in an unknown state'}. HeyReach only takes new leads in a running campaign, so start it first.`
  }
  if (campaign.accountIds.length === 0) return `"${campaign.name}" has no LinkedIn sender account attached.`
  return null
}

export interface HeyReachLeadInput {
  firstName: string
  lastName: string
  profileUrl: string
  companyName?: string | null
  position?: string | null
  location?: string | null
  messages: HeyReachMessages
}

export interface HeyReachAddResult {
  reply: HeyReachReply
  added: number
  updated: number
  failed: number
  /** The exact lead object sent, for the record. */
  sentLead: Record<string, unknown>
}

/** Adds one lead. One lead per call, so each person gets their own result. */
export async function addLeadToHeyReach(
  campaignId: number,
  linkedInAccountId: number,
  lead: HeyReachLeadInput,
  timeoutMs = 6000,
  apiKey?: string
): Promise<HeyReachAddResult> {
  const sentLead: Record<string, unknown> = {
    firstName: lead.firstName,
    lastName: lead.lastName,
    profileUrl: lead.profileUrl,
    ...(lead.companyName ? { companyName: lead.companyName } : {}),
    ...(lead.position ? { position: lead.position } : {}),
    ...(lead.location ? { location: lead.location } : {}),
    customUserFields: HEYREACH_MESSAGE_FIELDS.map((name) => ({ name, value: lead.messages[name] })),
  }
  const reply = await heyReachRequest('/campaign/AddLeadsToCampaignV2', {
    body: { campaignId, accountLeadPairs: [{ linkedInAccountId, lead: sentLead }] },
    timeoutMs,
    apiKey,
  })
  const n = (k: string) => Number(pick(reply.body, k) || 0)
  return {
    reply,
    added: n('addedLeadsCount'),
    updated: n('updatedLeadsCount'),
    failed: n('failedLeadsCount'),
    sentLead,
  }
}

/** Reads a lead back by profile URL, to see what HeyReach stored. */
export async function getHeyReachLead(profileUrl: string, timeoutMs = 4000, apiKey?: string): Promise<HeyReachReply> {
  return heyReachRequest('/lead/GetLead', { body: { profileUrl }, timeoutMs, apiKey })
}

// ── v78: pipeline ──

/** Some wrappers put the payload under "result"; HeyReach itself doesn't. Accept both. */
function payload(body: unknown): unknown {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const o = body as Record<string, unknown>
    if (o.result && typeof o.result === 'object' && o.items === undefined && o.overallStats === undefined) return o.result
  }
  return body
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : 0
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

export interface HeyReachCampaignSummary {
  id: number
  name: string
  status: string
}

/** Every campaign in the HeyReach workspace (up to 500). */
export async function listHeyReachCampaigns(timeoutMs = 4000, apiKey?: string): Promise<HeyReachCampaignSummary[]> {
  const out: HeyReachCampaignSummary[] = []
  const limit = 100
  for (let offset = 0; offset < 500; offset += limit) {
    const reply = await heyReachRequest('/campaign/GetAll', { body: { offset, limit }, timeoutMs, apiKey })
    if (!reply.ok) throw new Error(`HeyReach campaign list returned ${reply.status}: ${reply.text.slice(0, 200)}`)
    const body = payload(reply.body)
    const items = pick<unknown[]>(body, 'items', 'campaigns', 'data') || []
    for (const c of items) {
      const id = Number(pick(c, 'id', 'campaignId'))
      if (Number.isFinite(id) && id > 0) {
        out.push({ id, name: String(pick(c, 'name') || `Campaign ${id}`), status: String(pick(c, 'status') || '').toUpperCase() })
      }
    }
    const total = Number(pick(body, 'totalCount', 'total') || 0)
    if (items.length < limit || offset + limit >= total) break
  }
  return out
}

/**
 * The leads in one campaign with where each has got to. Pages of 100, up to
 * maxLeads, and stops early if the time budget runs out (truncated: true).
 */
export async function getCampaignLeads(
  campaignId: number,
  opts: { maxLeads?: number; deadline?: number; apiKey?: string } = {}
): Promise<{ totalCount: number; leads: PipelineLead[]; truncated: boolean }> {
  const apiKey = opts.apiKey
  const maxLeads = opts.maxLeads ?? 1000
  const deadline = opts.deadline ?? Date.now() + 7000
  const limit = 100
  const leads: PipelineLead[] = []
  let totalCount = 0
  let path = '/campaign/GetLeadsFromCampaign'
  for (let offset = 0; offset < maxLeads; offset += limit) {
    const left = deadline - Date.now()
    if (left < 1200) return { totalCount, leads, truncated: true }
    let reply = await heyReachRequest(path, { body: { campaignId, offset, limit }, timeoutMs: Math.min(5000, left - 500), apiKey })
    // Older docs put this under /lead. Try that once if /campaign is missing.
    if (reply.status === 404 && offset === 0 && path.startsWith('/campaign')) {
      path = '/lead/GetLeadsFromCampaign'
      reply = await heyReachRequest(path, { body: { campaignId, offset, limit }, timeoutMs: Math.max(1000, Math.min(4000, deadline - Date.now() - 500)), apiKey })
    }
    if (!reply.ok) throw new Error(`HeyReach campaign leads returned ${reply.status}: ${reply.text.slice(0, 200)}`)
    const body = payload(reply.body)
    const items = pick<unknown[]>(body, 'items', 'leads', 'data') || []
    totalCount = Number(pick(body, 'totalCount', 'total') || 0) || Math.max(totalCount, offset + items.length)
    for (const item of items) {
      const profile = (pick<Record<string, unknown>>(item, 'linkedInUserProfile', 'lead', 'profile') || item) as Record<string, unknown>
      const first = str(profile.firstName)
      const last = str(profile.lastName)
      leads.push({
        name: [first, last].filter(Boolean).join(' ') || str(profile.fullName) || 'Unknown',
        profileUrl: str(profile.profileUrl),
        headline: str(profile.headline),
        company: str(profile.companyName),
        position: str(profile.position),
        campaignStatus: str(pick(item, 'leadCampaignStatus', 'campaignStatus', 'status')),
        connectionStatus: str(pick(item, 'leadConnectionStatus', 'connectionStatus')),
        messageStatus: str(pick(item, 'leadMessageStatus', 'messageStatus')),
        lastActionTime: str(pick(item, 'lastActionTime')),
        creationTime: str(pick(item, 'creationTime')),
        statusMessage: str(pick(item, 'leadCampaignStatusMessage', 'errorCode')),
      })
    }
    if (items.length < limit || leads.length >= totalCount) break
  }
  return { totalCount, leads, truncated: leads.length < totalCount }
}

/** Actions HeyReach took in a date range, for the given campaigns (all accounts). */
export async function getOverallStats(
  campaignIds: number[],
  startDate: Date,
  endDate: Date,
  timeoutMs = 4000,
  apiKey?: string
): Promise<PipelineActivity> {
  const reply = await heyReachRequest('/stats/GetOverallStats', {
    body: { accountIds: [], campaignIds, startDate: startDate.toISOString(), endDate: endDate.toISOString() },
    timeoutMs,
    apiKey,
  })
  if (!reply.ok) throw new Error(`HeyReach stats returned ${reply.status}: ${reply.text.slice(0, 200)}`)
  const s = pick<Record<string, unknown>>(payload(reply.body), 'overallStats') || {}
  return {
    connectionsSent: num(s.connectionsSent),
    connectionsAccepted: num(s.connectionsAccepted),
    messagesSent: num(s.messagesSent),
    messageThreadsStarted: num(s.totalMessageStarted),
    replies: num(s.totalMessageReplies),
    profileViews: num(s.profileViews),
  }
}

/**
 * The useful part of a GetLead reply: who HeyReach matched on LinkedIn.
 * GetLead returns the LinkedIn profile (with the full About text), not the
 * campaign's msg_1 to msg_4, so the whole body is often too long to keep.
 */
export function leadSummary(body: unknown): Record<string, string | null> {
  const s = (k: string, ...more: string[]) => {
    const v = pick(body, k, ...more)
    return typeof v === 'string' || typeof v === 'number' ? String(v).slice(0, 300) : null
  }
  return {
    linkedin_id: s('linkedin_id', 'linkedInId'),
    firstName: s('firstName'),
    lastName: s('lastName'),
    profileUrl: s('profileUrl'),
    headline: s('headline'),
    position: s('position'),
    companyName: s('companyName'),
    location: s('location'),
  }
}

/**
 * Things on the live LinkedIn profile that say this person is no longer the
 * right target. Apollo's title can be years out of date (the first live run
 * pushed an "Owner" whose LinkedIn headline was "Retired financial planner").
 */
export function leadWarnings(summary: Record<string, string | null>): string[] {
  const warnings: string[] = []
  for (const field of ['headline', 'position'] as const) {
    const v = summary[field]
    if (v && /\b(retired|formerly|former)\b|\bex-[a-z]/i.test(v)) {
      warnings.push(`LinkedIn ${field} says "${v.slice(0, 120)}". Check they are still in role, and remove them from the HeyReach campaign if not.`)
    }
  }
  return warnings
}

/**
 * What a GetLead reply says. Only a 404, or a 200 with no lead in it, means
 * "not there". A rate limit, a server error or anything odd is "unknown", so
 * a stuck push is never re-added on a guess.
 */
export function leadLookup(reply: HeyReachReply): 'found' | 'not_found' | 'unknown' {
  if (reply.status === 404) return 'not_found'
  if (!reply.ok) return 'unknown'
  if (!reply.body || typeof reply.body !== 'object') return 'not_found'
  return pick(reply.body, 'id', 'leadId', 'profileUrl', 'linkedin_id') ? 'found' : 'not_found'
}
