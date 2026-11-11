'use client'

// v81: what deep research found for one prospect, with where each fact came
// from, and the decision-maker check from Companies House. Shown on the
// Research tab of the campaign page.

import type { Prospect } from '@/types'
import { deepResearchCanStart, deepResearchInProgress, type DeepResearchState } from '@/lib/deep-research/state'
import type { DecisionVerdict } from '@/lib/deep-research/matching'

export const DECISION_LABELS: Record<DecisionVerdict, { label: string; tone: 'good' | 'ok' | 'bad' | 'none' }> = {
  sole: { label: 'Decides alone', tone: 'good' },
  shared: { label: 'Two directors', tone: 'ok' },
  board: { label: 'Board of directors', tone: 'bad' },
  group: { label: 'Owned by a group', tone: 'bad' },
  not_director: { label: 'Not a director', tone: 'bad' },
  unknown: { label: 'Decision-maker not known', tone: 'none' },
}

const TONE_CLASS = {
  good: 'bg-green-900/40 text-green-400',
  ok: 'bg-amber-900/40 text-amber-300',
  bad: 'bg-red-900/40 text-red-300',
  none: 'bg-brand-charcoal text-brand-beige',
}

export function deepState(p: Prospect): DeepResearchState | null {
  return (p.deep_research || null) as DeepResearchState | null
}

/** The small tags on a prospect card. */
export function DeepResearchChips({ prospect }: { prospect: Prospect }) {
  const state = deepState(prospect)
  if (!state) return null
  if (deepResearchInProgress(state)) {
    return <span className="text-[9px] px-1.5 py-0.5 rounded bg-brand-rose-gold/20 text-brand-rose-gold animate-pulse">Researching</span>
  }
  if (state.status !== 'done') return null
  const verdict = state.evidence?.decision_maker?.verdict
  const d = verdict ? DECISION_LABELS[verdict] : null
  return (
    <>
      {d && verdict !== 'unknown' && <span className={`text-[9px] px-1.5 py-0.5 rounded ${TONE_CLASS[d.tone]}`}>{d.label}</span>}
      {state.fit === 'poor' && <span className="text-[9px] px-1.5 py-0.5 rounded bg-red-900/40 text-red-300">Poor fit</span>}
    </>
  )
}

function SourceLink({ source }: { source: string }) {
  if (/^https?:\/\//i.test(source)) {
    let host = source
    try {
      host = new URL(source).hostname.replace(/^www\./, '')
    } catch {}
    return (
      <a href={source} target="_blank" rel="noopener noreferrer" className="text-brand-rose-gold hover:underline">
        {host}
      </a>
    )
  }
  return <span>{source}</span>
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 text-xs">
      <span className="text-brand-beige w-36 flex-shrink-0">{label}</span>
      <span className="text-brand-cream min-w-0">{children}</span>
    </div>
  )
}

export default function DeepResearchPanel({
  prospect,
  onRun,
  running,
}: {
  prospect: Prospect
  onRun: () => void
  running: boolean
}) {
  const state = deepState(prospect)
  const inProgress = deepResearchInProgress(state)
  const box = 'mt-6 bg-brand-charcoal-deep rounded-lg p-5 border border-brand-charcoal'
  const heading = 'text-brand-rose-gold text-xs uppercase tracking-wider font-bold'

  if (inProgress) {
    return (
      <div className={box}>
        <h4 className={`${heading} mb-2`}>Deep research</h4>
        <p className="text-brand-cream text-sm">
          Running now. It reads Companies House, the FCA Register, their LinkedIn profile and the firm&apos;s website, which takes about a minute.
        </p>
        <p className="text-brand-beige text-xs mt-2">The notes, score and outreach showing now are a first pass and will be replaced.</p>
      </div>
    )
  }

  if (!state || state.status !== 'done') {
    return (
      <div className={box}>
        <h4 className={`${heading} mb-2`}>Deep research</h4>
        <p className="text-brand-cream text-sm">
          {state?.status === 'failed'
            ? `Deep research did not finish${state.error ? `: ${state.error}` : '.'}`
            : 'Not run for this person. The notes and score above are a first pass from their name, role and company only.'}
        </p>
        {deepResearchCanStart(state) && (
          <button onClick={onRun} disabled={running} className="btn-primary text-xs py-2 px-4 mt-4">
            {running ? 'Starting...' : state?.status === 'failed' ? 'Try again' : 'Run deep research'}
          </button>
        )}
      </div>
    )
  }

  const e = state.evidence
  const dm = e?.decision_maker
  const d = dm ? DECISION_LABELS[dm.verdict] : null
  const ch = e?.companies_house
  const fca = e?.fca
  const career = e?.profile?.career || []
  const fitLabel = state.fit === 'strong' ? 'Strong fit' : state.fit === 'poor' ? 'Poor fit' : 'Possible fit'

  return (
    <>
      {dm && d && (
        <div className={box}>
          <div className="flex items-center justify-between gap-3 mb-3">
            <h4 className={heading}>Who decides</h4>
            <span className={`text-[10px] px-2 py-1 rounded font-semibold ${TONE_CLASS[d.tone]}`}>{d.label}</span>
          </div>
          <p className="text-brand-cream text-sm leading-relaxed">{dm.summary}</p>
          {dm.owners.length > 0 && <p className="text-brand-beige text-xs mt-2">Significant control: {dm.owners.join(', ')}</p>}
        </div>
      )}

      <div className={box}>
        <div className="flex items-center justify-between gap-3 mb-3">
          <h4 className={heading}>What was found</h4>
          <span className="text-brand-beige text-[10px]">
            {fitLabel}
            {state.fit_reason ? `: ${state.fit_reason}` : ''}
          </span>
        </div>
        {state.who_they_serve && <p className="text-brand-cream text-sm mb-3">Who they serve: {state.who_they_serve}</p>}
        {(state.findings || []).length === 0 ? (
          <p className="text-brand-beige text-sm">Nothing specific was found beyond the registers.</p>
        ) : (
          <ul className="space-y-2">
            {(state.findings || []).map((f, i) => (
              <li key={i} className="text-sm text-brand-cream leading-relaxed">
                {f.fact}{' '}
                <span className="text-brand-beige text-[11px]">
                  (<SourceLink source={f.source} />)
                </span>
              </li>
            ))}
          </ul>
        )}
        {state.web_search === false && (
          <p className="text-amber-300 text-xs mt-3">The firm&apos;s website was not read: web search is not switched on for the Anthropic key.</p>
        )}
      </div>

      <div className={box}>
        <h4 className={`${heading} mb-3`}>Registers and profile</h4>
        <div className="space-y-2">
          {ch ? (
            <>
              <Row label="Companies House">
                <a href={ch.url} target="_blank" rel="noopener noreferrer" className="text-brand-rose-gold hover:underline">
                  {ch.company_name}
                </a>{' '}
                ({ch.company_number}), {ch.status || 'status unknown'}
                {ch.incorporated ? `, since ${ch.incorporated.slice(0, 4)}` : ''}
              </Row>
              {ch.accounts && <Row label="Accounts">{ch.accounts}{ch.accounts_made_up_to ? `, to ${ch.accounts_made_up_to}` : ''}</Row>}
              {dm && dm.directors.length > 0 && <Row label="Directors">{dm.directors.join(', ')}</Row>}
              {ch.matched_by === 'name only' && <Row label="Note">Matched on the firm&apos;s name only. Check it is the right company.</Row>}
            </>
          ) : (
            <Row label="Companies House">No company matched</Row>
          )}
          {fca ? (
            <Row label="FCA Register">
              <a href={fca.url} target="_blank" rel="noopener noreferrer" className="text-brand-rose-gold hover:underline">
                {fca.name}
              </a>{' '}
              (FRN {fca.frn}), {fca.status}
              {fca.individuals !== null ? `, ${fca.individuals} individual${fca.individuals === 1 ? '' : 's'} listed` : ''}
            </Row>
          ) : (
            <Row label="FCA Register">No firm matched by name</Row>
          )}
          {career.length > 0 && (
            <Row label="Career">
              {career
                .slice(0, 4)
                .map((c) => `${c.title} at ${c.company} (${(c.from || '?').slice(0, 4)} to ${c.to ? c.to.slice(0, 4) : 'now'})`)
                .join('; ')}
            </Row>
          )}
        </div>
        <p className="text-brand-beige text-[10px] mt-4">
          {state.finished_at ? `Researched ${new Date(state.finished_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}
          {typeof state.searches === 'number' ? `, ${state.searches} web search${state.searches === 1 ? '' : 'es'}` : ''}
          {state.first_pass?.total_score != null ? `. First-pass score was ${state.first_pass.total_score}/40.` : ''}
        </p>
      </div>
    </>
  )
}
