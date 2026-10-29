// Watchlist check (v76.1). Shared by the Netlify scheduled function
// (netlify/functions/watchlist-check.ts) and the admin-only manual route
// (/api/admin/watchlist-check), because scheduled functions only run on
// production deploys, not previews.
//
// Relative imports only: this file is bundled by Netlify's function bundler,
// which does not read the "@/" path alias from tsconfig.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  getIndividualProfile,
  getIndividualFunctions,
  deriveCareerSignals,
  getFirmProfile,
  getFirmIndividualCount,
  getFirmCurrentArCount,
  getFirmRequirements,
} from '../data-sources/fca-register'
import { hasRecruitmentAccess } from './access-rules'

export const BATCH_SIZE = 15
const DEFAULT_BUDGET_MS = 8000
// The register allows 50 calls per 10 seconds for the whole app, shared
// with users' own searches. Two items at a time, starting at most one every
// 600ms, keeps a run to a few calls a second.
const CONCURRENCY = 2
const START_GAP_MS = 600

// ── Snapshot shapes ──────────────────────────

export interface AdviserSnapshot {
  kind: 'adviser'
  status: string
  current_frn: string | null
  current_firm_name: string | null
  current_functions: { name: string; frn: string | null; firm_name: string }[]
  checked_at: string
}

export interface FirmSnapshot {
  kind: 'firm'
  name: string
  status: string
  individual_count: number | null
  ar_count: number | null
  ar_count_is_minimum: boolean
  requirement_count: number
  checked_at: string
}

export type Snapshot = AdviserSnapshot | FirmSnapshot

export type AlertType =
  | 'adviser_status_changed'
  | 'adviser_moved_firm'
  | 'adviser_left_firm'
  | 'adviser_new_function'
  | 'firm_status_changed'
  | 'firm_headcount_drop'
  | 'firm_ar_count_drop'
  | 'firm_requirements_added'

export interface AlertDraft {
  alert_type: AlertType
  title: string
  detail: Record<string, unknown>
}

interface WatchlistRow {
  id: string
  user_id: string
  item_type: 'adviser' | 'firm'
  fca_irn: string | null
  fca_frn: string | null
  display_name: string
  firm_name: string | null
  prospect_id: string | null
  campaign_id: string | null
  last_checked_at: string | null
  last_snapshot: Snapshot | null
}

export interface WatchlistCheckResult {
  checked: number
  alerts_created: number
  failed: number
  skipped_for_time: number
  first_checks: number
  items: { id: string; name: string; outcome: 'first_check' | 'unchanged' | 'changed' | 'failed' | 'skipped'; alerts: string[] }[]
  duration_ms: number
}

// ── Register lookups ─────────────────────────

// Strict lookups: a failed call throws, so an outage never reads as a
// change. "Not found" is a real answer and becomes part of the snapshot.
export async function fetchAdviserSnapshot(irn: string): Promise<AdviserSnapshot> {
  const [profile, functions] = await Promise.all([
    getIndividualProfile(irn, { strict: true }),
    getIndividualFunctions(irn, { strict: true }),
  ])
  const career = deriveCareerSignals(functions)
  return {
    kind: 'adviser',
    status: profile ? profile.status : 'Not on register',
    current_frn: career.current_frn,
    current_firm_name: career.current_firm_name,
    current_functions: functions.current.map((f) => ({ name: f.name, frn: f.frn, firm_name: f.firm_name })),
    checked_at: new Date().toISOString(),
  }
}

export async function fetchFirmSnapshot(frn: string): Promise<FirmSnapshot> {
  const [profile, individualCount, arCount, requirements] = await Promise.all([
    getFirmProfile(frn, { includeAddress: false, strict: true }),
    getFirmIndividualCount(frn),
    getFirmCurrentArCount(frn, 8, { strict: true }),
    getFirmRequirements(frn, { strict: true }),
  ])
  // getFirmIndividualCount returns null only when the call failed
  if (individualCount === null) throw new Error(`FCA Register lookup failed: Firm/${frn}/Individuals`)
  return {
    kind: 'firm',
    name: profile ? profile.name : frn,
    status: profile ? profile.status : 'Not on register',
    individual_count: individualCount,
    ar_count: arCount.count,
    ar_count_is_minimum: arCount.isMinimum,
    requirement_count: requirements.count,
    checked_at: new Date().toISOString(),
  }
}

// ── Diffing ──────────────────────────────────

function functionKey(f: { name: string; frn: string | null; firm_name: string }): string {
  return `${f.name}|${f.frn || f.firm_name}`
}

function isDrop(before: number | null, after: number | null, pct: number, abs: number): boolean {
  if (before === null || after === null || before <= 0) return false
  const drop = before - after
  if (drop <= 0) return false
  return drop >= abs || drop / before >= pct
}

export function diffSnapshots(name: string, before: Snapshot, after: Snapshot): AlertDraft[] {
  const alerts: AlertDraft[] = []

  if (before.kind === 'adviser' && after.kind === 'adviser') {
    if (before.status !== after.status) {
      alerts.push({
        alert_type: 'adviser_status_changed',
        title: `${name}: register status changed to ${after.status || 'unknown'}`,
        detail: { before: before.status, after: after.status },
      })
    }
    if (before.current_frn && after.current_frn && before.current_frn !== after.current_frn) {
      alerts.push({
        alert_type: 'adviser_moved_firm',
        title: `${name} moved from ${before.current_firm_name || before.current_frn} to ${after.current_firm_name || after.current_frn}`,
        detail: {
          from_frn: before.current_frn, from_firm: before.current_firm_name,
          to_frn: after.current_frn, to_firm: after.current_firm_name,
        },
      })
    } else if (before.current_frn && !after.current_frn) {
      alerts.push({
        alert_type: 'adviser_left_firm',
        title: `${name} no longer holds a function at ${before.current_firm_name || before.current_frn}`,
        detail: { from_frn: before.current_frn, from_firm: before.current_firm_name },
      })
    }
    const beforeKeys = new Set(before.current_functions.map(functionKey))
    const added = after.current_functions.filter((f) => !beforeKeys.has(functionKey(f)))
    // A move already explains new functions at the new firm; only report
    // new functions that are not part of a move.
    const moved = alerts.some((a) => a.alert_type === 'adviser_moved_firm')
    const newOnes = moved ? added.filter((f) => f.frn !== after.current_frn) : added
    if (newOnes.length > 0) {
      alerts.push({
        alert_type: 'adviser_new_function',
        title: `${name} has a new function: ${newOnes.map((f) => `${f.name} at ${f.firm_name}`).join('; ')}`,
        detail: { functions: newOnes },
      })
    }
  }

  if (before.kind === 'firm' && after.kind === 'firm') {
    if (before.status !== after.status) {
      alerts.push({
        alert_type: 'firm_status_changed',
        title: `${name}: firm status changed to ${after.status || 'unknown'}`,
        detail: { before: before.status, after: after.status },
      })
    }
    if (isDrop(before.individual_count, after.individual_count, 0.10, 3)) {
      alerts.push({
        alert_type: 'firm_headcount_drop',
        title: `${name}: approved individuals down from ${before.individual_count} to ${after.individual_count}`,
        detail: { before: before.individual_count, after: after.individual_count },
      })
    }
    // A capped AR count is a floor, so only compare exact counts.
    if (!before.ar_count_is_minimum && !after.ar_count_is_minimum && isDrop(before.ar_count, after.ar_count, 0.10, 2)) {
      alerts.push({
        alert_type: 'firm_ar_count_drop',
        title: `${name}: appointed representatives down from ${before.ar_count} to ${after.ar_count}`,
        detail: { before: before.ar_count, after: after.ar_count },
      })
    }
    if (after.requirement_count > before.requirement_count) {
      alerts.push({
        alert_type: 'firm_requirements_added',
        title: `${name}: ${after.requirement_count - before.requirement_count} new requirement${after.requirement_count - before.requirement_count === 1 ? '' : 's'} on the register`,
        detail: { before: before.requirement_count, after: after.requirement_count },
      })
    }
  }

  return alerts
}

// ── Run ──────────────────────────────────────

// User ids, from those given, whose owner has Recruitment (or is an admin).
export async function usersWithRecruitment(supabase: SupabaseClient, userIds: string[]): Promise<Set<string>> {
  const unique = Array.from(new Set(userIds))
  if (unique.length === 0) return new Set()
  const { data, error } = await supabase
    .from('profiles')
    .select('id, email, recruitment_status, recruitment_subscription_id, recruitment_current_period_end')
    .in('id', unique)
  if (error) throw new Error(`Could not read profiles: ${error.message}`)
  return new Set((data || []).filter((p) => hasRecruitmentAccess(p, p.email)).map((p) => p.id as string))
}

export function createServiceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase service role is not configured')
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
}

type ItemOutcome =
  | { kind: 'done'; row: WatchlistRow; snapshot: Snapshot }
  | { kind: 'failed'; row: WatchlistRow; reason: string }
  | { kind: 'timeout'; row: WatchlistRow; started?: boolean }

export async function runWatchlistCheck(
  options: { budgetMs?: number; batchSize?: number; client?: SupabaseClient } = {}
): Promise<WatchlistCheckResult> {
  const startedAt = Date.now()
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS
  const batchSize = options.batchSize ?? BATCH_SIZE
  const supabase = options.client || createServiceClient()

  const result: WatchlistCheckResult = {
    checked: 0, alerts_created: 0, failed: 0, skipped_for_time: 0, first_checks: 0, items: [], duration_ms: 0,
  }

  // Read a wider window than the batch, then keep only items whose owner
  // still has Recruitment. Items of lapsed users are not checked, but their
  // last_checked_at moves on so they don't sit at the front of the queue
  // and block everyone else. If the user comes back, the next check diffs
  // against the old snapshot.
  const { data: rows, error } = await supabase
    .from('watchlist_items')
    .select('id, user_id, item_type, fca_irn, fca_frn, display_name, firm_name, prospect_id, campaign_id, last_checked_at, last_snapshot')
    .order('last_checked_at', { ascending: true, nullsFirst: true })
    .limit(batchSize * 6)

  if (error) throw new Error(`Could not read watchlist: ${error.message}`)
  const candidates = (rows || []) as WatchlistRow[]
  const activeUsers = await usersWithRecruitment(supabase, candidates.map((r) => r.user_id))
  const lapsed = candidates.filter((r) => !activeUsers.has(r.user_id))
  const items = candidates.filter((r) => activeUsers.has(r.user_id)).slice(0, batchSize)
  if (lapsed.length > 0) {
    const { error: lapsedError } = await supabase
      .from('watchlist_items')
      .update({ last_checked_at: new Date().toISOString() })
      .in('id', lapsed.map((r) => r.id))
    if (lapsedError) console.error('[Watchlist] could not move lapsed items on:', lapsedError.message)
  }
  if (items.length === 0) {
    result.duration_ms = Date.now() - startedAt
    return result
  }

  // Leave a quarter of the budget (at least 1.5s) for the database writes
  // after the register lookups.
  const lookupDeadline = startedAt + Math.max(1000, budgetMs - Math.max(1500, Math.round(budgetMs * 0.25)))

  // Paced, so one run never bursts past the register's shared rate limit.
  let nextStartAt = Date.now()
  const runOne = async (row: WatchlistRow): Promise<ItemOutcome> => {
    const wait = nextStartAt - Date.now()
    nextStartAt = Math.max(nextStartAt, Date.now()) + START_GAP_MS
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    if (Date.now() >= lookupDeadline) return { kind: 'timeout', row, started: false }
    const work = (async (): Promise<ItemOutcome> => {
      try {
        const snapshot = row.item_type === 'adviser'
          ? (row.fca_irn ? await fetchAdviserSnapshot(row.fca_irn) : null)
          : (row.fca_frn ? await fetchFirmSnapshot(row.fca_frn) : null)
        if (!snapshot) return { kind: 'failed', row, reason: 'No IRN or FRN on the item' }
        return { kind: 'done', row, snapshot }
      } catch (err) {
        return { kind: 'failed', row, reason: err instanceof Error ? err.message : 'Register lookup failed' }
      }
    })()
    let timerId: ReturnType<typeof setTimeout> | undefined
    const timer = new Promise<ItemOutcome>((resolve) => {
      timerId = setTimeout(() => resolve({ kind: 'timeout', row, started: true }), Math.max(0, lookupDeadline - Date.now()))
    })
    return Promise.race([work, timer]).finally(() => clearTimeout(timerId))
  }

  const outcomes: ItemOutcome[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      outcomes[i] = await runOne(items[i]).catch((err) => ({ kind: 'failed' as const, row: items[i], reason: String(err) }))
    }
  }))

  // Failed and timed-out items move to the back of the queue, so a bad IRN
  // or a slow firm can't sit at the front and block everyone else. Items
  // there was no time to start keep their place.
  const parked = outcomes
    .filter((o) => o.kind === 'failed' || (o.kind === 'timeout' && o.started))
    .map((o) => o.row.id)
  if (parked.length > 0) {
    const { error: parkError } = await supabase
      .from('watchlist_items')
      .update({ last_checked_at: new Date().toISOString() })
      .in('id', parked)
    if (parkError) console.error('[Watchlist] could not move failed items on:', parkError.message)
  }

  for (let i = 0; i < outcomes.length; i++) {
    const row = items[i]
    const outcome = outcomes[i]
    if (outcome.kind === 'timeout') {
      result.skipped_for_time++
      result.items.push({ id: row.id, name: row.display_name, outcome: 'skipped', alerts: [] })
      continue
    }
    if (outcome.kind === 'failed') {
      result.failed++
      console.error(`[Watchlist] ${row.item_type} ${row.fca_irn || row.fca_frn} failed: ${outcome.reason}`)
      result.items.push({ id: row.id, name: row.display_name, outcome: 'failed', alerts: [] })
      continue
    }

    // Stop writing if we are about to run out of time. Unwritten items keep
    // their old last_checked_at and are picked up first next run.
    if (Date.now() - startedAt > budgetMs) {
      result.skipped_for_time++
      result.items.push({ id: row.id, name: row.display_name, outcome: 'skipped', alerts: [] })
      continue
    }

    const before = row.last_snapshot && typeof row.last_snapshot === 'object' && 'kind' in row.last_snapshot
      ? row.last_snapshot
      : null
    const isFirstCheck = !before
    const drafts = isFirstCheck ? [] : diffSnapshots(row.display_name, before!, outcome.snapshot)

    try {
      if (drafts.length > 0) {
        const { error: alertError } = await supabase.from('alerts').insert(
          drafts.map((d) => ({
            user_id: row.user_id,
            watchlist_item_id: row.id,
            alert_type: d.alert_type,
            title: d.title,
            detail: {
              ...d.detail,
              item_type: row.item_type,
              fca_irn: row.fca_irn,
              fca_frn: row.fca_frn,
              prospect_id: row.prospect_id,
              campaign_id: row.campaign_id,
            },
          }))
        )
        if (alertError) throw new Error(`alert insert: ${alertError.message}`)
      }

      const update: Record<string, unknown> = {
        last_snapshot: outcome.snapshot,
        last_checked_at: new Date().toISOString(),
      }
      if (outcome.snapshot.kind === 'adviser' && outcome.snapshot.current_firm_name) {
        update.firm_name = outcome.snapshot.current_firm_name
      }
      const { error: updateError } = await supabase.from('watchlist_items').update(update).eq('id', row.id)
      if (updateError) throw new Error(`snapshot update: ${updateError.message}`)

      result.checked++
      result.alerts_created += drafts.length
      if (isFirstCheck) result.first_checks++
      result.items.push({
        id: row.id,
        name: row.display_name,
        outcome: isFirstCheck ? 'first_check' : drafts.length > 0 ? 'changed' : 'unchanged',
        alerts: drafts.map((d) => d.alert_type),
      })
    } catch (err) {
      result.failed++
      console.error(`[Watchlist] write failed for ${row.id}:`, err instanceof Error ? err.message : err)
      result.items.push({ id: row.id, name: row.display_name, outcome: 'failed', alerts: [] })
    }
  }

  result.duration_ms = Date.now() - startedAt
  console.log(`[Watchlist] checked ${result.checked}, alerts ${result.alerts_created}, failed ${result.failed}, skipped ${result.skipped_for_time} in ${result.duration_ms}ms`)
  return result
}
