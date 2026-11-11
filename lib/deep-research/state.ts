// v81: what is stored in prospects.deep_research, and small helpers shared by
// the server routes, the background job and the pages. Types and plain
// functions only, so it is safe to import in the browser.
// Relative imports only (the background function bundles this file).

import type { Evidence } from './evidence'
import type { Finding } from './analyse'

export type DeepResearchStatus = 'queued' | 'running' | 'done' | 'failed'

export interface DeepResearchState {
  status: DeepResearchStatus
  queued_at?: string
  started_at?: string
  finished_at?: string
  error?: string
  /** What the job is doing right now, in plain words, while it runs. */
  stage?: string
  evidence?: Evidence
  findings?: Finding[]
  who_they_serve?: string | null
  fit?: 'strong' | 'possible' | 'poor'
  fit_reason?: string
  searches?: number
  web_search?: boolean
  model?: string
  /** False when the research finished but the messages could not be written. */
  outreach_written?: boolean
  outreach_error?: string
  /** The quick first-pass score, kept so the change is visible. */
  first_pass?: { total_score: number | null; tier: string | null }
}

/** The three steps of the job, in order. Shown to the user while it runs. */
export const DEEP_RESEARCH_STAGES = [
  'Checking Companies House, the FCA Register and their LinkedIn profile',
  "Reading the firm's website and scoring",
  'Writing the messages',
] as const

/** A job that has sat queued or running this long has died and may be started again. */
export const DEEP_RESEARCH_STALE_MS = 15 * 60 * 1000

export function deepResearchInProgress(state: DeepResearchState | null | undefined, now: number = Date.now()): boolean {
  if (!state || (state.status !== 'queued' && state.status !== 'running')) return false
  const since = Date.parse(state.started_at || state.queued_at || '')
  return Number.isFinite(since) ? now - since < DEEP_RESEARCH_STALE_MS : false
}

/** May deep research be started (or started again) for this person? */
export function deepResearchCanStart(state: DeepResearchState | null | undefined): boolean {
  if (!state) return true
  if (state.status === 'failed') return true
  // Finished, but the messages were never written from the findings: allow another go.
  if (state.status === 'done') return state.outreach_written !== true
  return !deepResearchInProgress(state)
}

/** What the message writers are told about a person: verified findings once deep research is done. */
export function researchContext(
  researchNotes: string | null,
  keyTrigger: string | null,
  state: DeepResearchState | null | undefined
): { research_notes: string | null; key_trigger: string | null; verified?: boolean; findings?: Finding[] } {
  if (state?.status === 'done') {
    return { research_notes: researchNotes, key_trigger: keyTrigger, verified: true, findings: state.findings || [] }
  }
  return { research_notes: researchNotes, key_trigger: keyTrigger }
}
