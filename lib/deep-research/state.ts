// v81: what is stored in prospects.deep_research, and small helpers shared by
// the server routes, the background job and the pages. Types and plain
// functions only, so it is safe to import in the browser.
// Relative imports only (the background function bundles this file).

import type { Evidence } from './evidence'
import type { Finding } from './analyse'

// 'checking' and 'checked' are the quick register check (v82): Companies
// House and the FCA Register only, free and fast, run on a whole list before
// any deep research. A checked person has `evidence` but no findings.
export type DeepResearchStatus = 'queued' | 'running' | 'done' | 'failed' | 'checking' | 'checked'

export interface DeepResearchState {
  status: DeepResearchStatus
  queued_at?: string
  started_at?: string
  finished_at?: string
  /** When the quick register check finished. */
  checked_at?: string
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
  /** When `evidence` was gathered, and whether it includes the LinkedIn profile look-up (an Apollo credit). */
  evidence_at?: string
  evidence_full?: boolean
  /** How many times the full research has run for this person. */
  attempts?: number
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
  if (!state || (state.status !== 'queued' && state.status !== 'running' && state.status !== 'checking')) return false
  const since = Date.parse(state.started_at || state.queued_at || '')
  return Number.isFinite(since) ? now - since < DEEP_RESEARCH_STALE_MS : false
}

/** May deep research be started (or started again) for this person? */
export function deepResearchCanStart(state: DeepResearchState | null | undefined): boolean {
  if (!state) return true
  if (state.status === 'failed' || state.status === 'checked' || state.status === 'checking') return true
  // Finished, but the messages were never written from the findings: allow another go.
  if (state.status === 'done') {
    if (state.outreach_written !== true) return true
    // Who decides could not be worked out: one more go is allowed, as the matching may have improved.
    return state.evidence?.decision_maker?.verdict === 'unknown' && (state.attempts || 1) < 2
  }
  return !deepResearchInProgress(state)
}

/** Evidence is reused for a week: long enough for a retry, short enough to stay true. */
const EVIDENCE_FRESH_MS = 7 * 24 * 60 * 60 * 1000

/** What a new run may carry over from the last one: the evidence, if it is recent. */
export function carriedEvidence(state: DeepResearchState | null | undefined, now: number = Date.now()): Pick<DeepResearchState, 'evidence' | 'evidence_at' | 'evidence_full'> {
  // A finished run is only started again to try the matching afresh, so it starts clean.
  if (!state?.evidence || state.status === 'done') return {}
  const at = Date.parse(state.evidence_at || state.checked_at || state.finished_at || '')
  if (!Number.isFinite(at) || now - at > EVIDENCE_FRESH_MS) return {}
  return { evidence: state.evidence, evidence_at: new Date(at).toISOString(), evidence_full: !!state.evidence_full }
}

/** Has this person had neither the register check nor deep research? */
export function registerCheckCanStart(state: DeepResearchState | null | undefined): boolean {
  return !state || (state.status === 'checking' && !deepResearchInProgress(state))
}

export const REGISTER_CHECK_STAGE = 'Checking Companies House and the FCA Register'

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

/** "Appointed rep", "Directly authorised", or null when the firm was not found on the FCA Register. */
export function fcaLabel(businessType: string | null | undefined, status: string | null | undefined): 'Appointed rep' | 'Directly authorised' | null {
  const text = `${businessType || ''} ${status || ''}`.toLowerCase()
  if (!text.trim()) return null
  if (text.includes('appointed rep')) return 'Appointed rep'
  // Only a firm the register calls authorised. "Registered" alone is a lighter status.
  if (/\bauthorised\b/.test(text) && !text.includes('no longer') && !text.includes('unauthorised')) return 'Directly authorised'
  return null
}
