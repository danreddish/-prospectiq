'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { linkedInProfileSlug } from '@/lib/linkedin'
import { cleanPersonName } from '@/lib/names'
import {
  HEYREACH_MESSAGE_FIELDS,
  HEYREACH_MESSAGE_LABELS,
  HEYREACH_MESSAGE_SOFT_LIMITS,
  pushProblems,
  splitName,
  type HeyReachMessageField,
  type HeyReachState,
} from '@/lib/heyreach-shared'

export interface TestRow {
  id: string
  name: string
  role: string | null
  company: string | null
  location: string | null
  linkedin_url: string | null
  status: string
  total_score: number | null
  tier: string | null
  research_notes: string | null
  heyreach: HeyReachState | null
}

interface SendableCampaign {
  id: number
  name: string
  status: string
  workspaceId: string | null
  workspaceName: string
}

interface CampaignCheck {
  keySet: boolean
  keyValid?: boolean
  campaigns?: SendableCampaign[]
  campaign?: { id: number; name: string; status: string; accountIds: number[]; pushable: boolean; workspaceId: string | null; workspaceName: string } | null
  problem?: string | null
}

const TEST_SIZE = 5

const STATUS_LABEL: Record<string, string> = {
  draft: 'Waiting for your review',
  approved: 'Approved',
  rejected: 'Rejected',
  pushing: 'Sending, or not confirmed yet',
  pushed: 'In HeyReach',
  push_failed: 'HeyReach did not accept',
}

const STATUS_CLASS: Record<string, string> = {
  draft: 'text-brand-beige border-brand-charcoal',
  approved: 'text-green-400 border-green-400/40',
  rejected: 'text-red-400 border-red-400/40',
  pushing: 'text-brand-rose-gold border-brand-rose-gold/40',
  pushed: 'text-green-400 border-green-400/40',
  push_failed: 'text-red-400 border-red-400/40',
}

async function post(path: string, body: unknown) {
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const data = await res.json().catch(() => ({}))
    return { ok: res.ok && data.ok !== false, data }
  } catch {
    return { ok: false, data: { error: 'Could not reach ProspectIQ.' } }
  }
}

export default function HeyReachTest({
  admin,
  campaign,
  initialRows,
  excludedBySlug,
  exclusionsError,
}: {
  admin: boolean
  campaign: { id: string; name: string; customInstructions?: string | null }
  initialRows: TestRow[]
  excludedBySlug: Record<string, 'ulinc' | 'heyreach'>
  exclusionsError: string
}) {
  const [rows, setRows] = useState<TestRow[]>(initialRows)
  const [check, setCheck] = useState<CampaignCheck | null>(null)
  const [busy, setBusy] = useState('')
  const [confirmPush, setConfirmPush] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, HeyReachState>>({})

  const exclusionOf = (r: TestRow) => {
    const slug = linkedInProfileSlug(r.linkedin_url)
    return slug ? excludedBySlug[slug] : undefined
  }

  const inTest = useMemo(() => rows.filter((r) => r.heyreach?.status), [rows])
  const candidates = useMemo(
    () => rows.filter((r) => r.status === 'completed' && linkedInProfileSlug(r.linkedin_url) && !r.heyreach?.status && !exclusionOf(r)),
    [rows] // eslint-disable-line react-hooks/exhaustive-deps
  )
  const noProfile = rows.filter((r) => r.status === 'completed' && !linkedInProfileSlug(r.linkedin_url)).length
  const notResearched = rows.filter((r) => r.status !== 'completed').length
  const leftOut = rows.filter((r) => r.status === 'completed' && !r.heyreach?.status && exclusionOf(r))

  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(candidates.slice(0, Math.max(0, TEST_SIZE - inTest.length)).map((r) => r.id))
  )

  const approved = inTest.filter((r) => r.heyreach?.status === 'approved')
  const dirtyNames = Object.keys(drafts)
    .map((id) => rows.find((r) => r.id === id))
    .filter((r): r is TestRow => !!r)
    .map((r) => cleanPersonName(r.name))
  const sent = inTest.filter((r) => r.heyreach?.push)

  // v79: which HeyReach campaign to send into (any workspace for an admin;
  // only the campaigns assigned to this user otherwise). The server checks it
  // again on every send.
  async function runCheck(target?: { id: number; workspaceId: string | null }) {
    const chosen = target || (check?.campaign ? { id: check.campaign.id, workspaceId: check.campaign.workspaceId } : null)
    const q = chosen ? `?heyreach_campaign_id=${chosen.id}&workspace_id=${chosen.workspaceId || 'main'}` : ''
    try {
      const res = await fetch(`/api/heyreach/campaign${q}`, { cache: 'no-store' })
      setCheck(await res.json())
    } catch {
      setCheck({ keySet: false, problem: 'Could not reach ProspectIQ.' })
    }
  }
  useEffect(() => {
    runCheck()
  }, [])
  // Never confirm a send against a campaign that has since changed.
  useEffect(() => {
    setConfirmPush(false)
  }, [check?.campaign?.id, check?.campaign?.workspaceId])

  function updateRow(id: string, heyreach: HeyReachState | undefined, keepDraft = false) {
    if (heyreach) setRows((prev) => prev.map((r) => (r.id === id ? { ...r, heyreach } : r)))
    if (!keepDraft) {
      setDrafts((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
    }
  }

  function draftFor(r: TestRow): HeyReachState {
    return drafts[r.id] || r.heyreach || {}
  }

  // The name boxes show a split of the full name until one is saved.
  function withNames(r: TestRow, d: HeyReachState): HeyReachState {
    const names = splitName(r.name)
    return { ...d, first_name: d.first_name ?? names.first, last_name: d.last_name ?? names.last }
  }

  function editDraft(r: TestRow, patch: Partial<HeyReachState>, msgPatch?: Partial<Record<HeyReachMessageField, string>>) {
    const base = draftFor(r)
    setDrafts((prev) => ({ ...prev, [r.id]: { ...base, ...patch, msgs: { ...base.msgs, ...msgPatch } } }))
  }

  async function writeFor(r: TestRow): Promise<boolean> {
    for (const part of [1, 2] as const) {
      const { ok, data } = await post('/api/heyreach/messages', { campaign_id: campaign.id, prospect_id: r.id, part })
      if (!ok) {
        toast.error(`${cleanPersonName(r.name)}: ${data.error || `messages part ${part} failed`}`)
        return false
      }
      updateRow(r.id, data.heyreach)
    }
    return true
  }

  async function writeSelected() {
    const list = candidates.filter((r) => picked.has(r.id))
    let done = 0
    for (let i = 0; i < list.length; i++) {
      setBusy(`Writing messages for ${cleanPersonName(list[i].name)} (${i + 1} of ${list.length})...`)
      if (await writeFor(list[i])) done++
    }
    setBusy('')
    setPicked(new Set())
    if (done > 0) toast.success(`Messages written for ${done}. Review them below.`)
  }

  async function review(r: TestRow, action: 'save' | 'approve' | 'reject' | 'reopen') {
    const d = withNames(r, draftFor(r))
    setBusy(`${action === 'approve' ? 'Approving' : action === 'reject' ? 'Rejecting' : 'Saving'} ${cleanPersonName(r.name)}...`)
    const { ok, data } = await post('/api/heyreach/review', {
      campaign_id: campaign.id,
      prospect_id: r.id,
      action,
      first_name: d.first_name ?? '',
      last_name: d.last_name ?? '',
      msgs: Object.fromEntries(HEYREACH_MESSAGE_FIELDS.map((f) => [f, d.msgs?.[f] ?? ''])),
    })
    setBusy('')
    if (!ok) return toast.error(data.error || 'Could not save')
    updateRow(r.id, data.heyreach)
  }

  async function rewrite(r: TestRow) {
    setBusy(`Rewriting messages for ${cleanPersonName(r.name)}...`)
    if (r.heyreach?.status === 'rejected') {
      const { data } = await post('/api/heyreach/review', { campaign_id: campaign.id, prospect_id: r.id, action: 'reopen' })
      if (data.heyreach) updateRow(r.id, data.heyreach)
    }
    await writeFor(r)
    setBusy('')
  }

  async function pushOne(r: TestRow): Promise<boolean> {
    const { ok, data } = await post('/api/heyreach/push', {
      campaign_id: campaign.id,
      prospect_id: r.id,
      heyreach_campaign_id: check?.campaign?.id,
      heyreach_workspace_id: check?.campaign?.workspaceId ?? null,
    })
    updateRow(r.id, data.heyreach, true)
    if (!ok) toast.error(`${cleanPersonName(r.name)}: ${data.error || 'not sent'}`)
    return ok
  }

  async function pushApproved() {
    setConfirmPush(false)
    const list = approved
    let accepted = 0
    for (let i = 0; i < list.length; i++) {
      setBusy(`Sending ${cleanPersonName(list[i].name)} (${i + 1} of ${list.length})...`)
      if (await pushOne(list[i])) accepted++
    }
    setBusy('')
    toast.success(`HeyReach accepted ${accepted} of ${list.length}.`)
  }

  async function checkStuck(r: TestRow) {
    setBusy(`Checking HeyReach for ${cleanPersonName(r.name)}...`)
    const ok = await pushOne(r)
    setBusy('')
    if (ok) toast.success(`${cleanPersonName(r.name)} is in HeyReach.`)
  }

  const ready = !!check && !check.problem
  const canPush = ready && approved.length > 0 && dirtyNames.length === 0 && !busy

  return (
    <div className="p-8 max-w-5xl space-y-8">
      <div>
        <Link href={`/dashboard/campaigns/${campaign.id}`} className="text-brand-rose-gold text-xs font-semibold hover:underline">
          &larr; {campaign.name}
        </Link>
        <h1 className="text-2xl font-display text-brand-cream mt-2">Send to LinkedIn</h1>
        <p className="text-brand-beige text-sm mt-1">
          ProspectIQ writes four LinkedIn messages for each person. You check them, then send. They get a blank connection request, then the four messages once they accept. Nothing is sent until you approve it.
        </p>
        {busy && <p className="text-brand-rose-gold text-sm mt-3">{busy}</p>}
        {exclusionsError && (
          <p className="text-red-400 text-sm mt-3">
            Could not check your Ulinc contacts ({exclusionsError}). Approving and sending will still check them and refuse anyone on the list.
          </p>
        )}
      </div>

      {/* Connection */}
      <section className="border border-brand-charcoal rounded-lg p-5 text-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-brand-cream font-semibold">LinkedIn campaign</h2>
          <button onClick={() => runCheck()} className="btn-secondary text-xs px-3 py-1.5">Check again</button>
        </div>
        {((check?.campaigns?.length || 0) > 1 || (!check?.campaign && (check?.campaigns?.length || 0) > 0)) && (
          <label className="text-brand-beige text-xs flex items-center gap-2 mt-3">
            Send into
            <select
              value={check?.campaign ? `${check.campaign.workspaceId || 'main'}:${check.campaign.id}` : ''}
              aria-label="Campaign to send into"
              disabled={!!busy}
              onChange={(e) => {
                const [ws, id] = e.target.value.split(':')
                setCheck(null)
                runCheck({ id: Number(id), workspaceId: ws === 'main' ? null : ws })
              }}
              className="text-sm py-1.5 px-3"
            >
              {!check?.campaign && <option value="">Choose a campaign</option>}
              {(check?.campaigns || []).map((c) => (
                <option key={`${c.workspaceId || 'main'}:${c.id}`} value={`${c.workspaceId || 'main'}:${c.id}`}>
                  {admin ? `${c.workspaceName} · ` : ''}
                  {c.name} ({c.status.toLowerCase().replace(/_/g, ' ')})
                </option>
              ))}
            </select>
          </label>
        )}
        {!check ? (
          <p className="text-brand-beige mt-2">Checking...</p>
        ) : check.problem ? (
          <p className="text-red-400 mt-2">{check.problem}</p>
        ) : (
          <p className="text-green-400 mt-2">
            &ldquo;{check.campaign?.name}&rdquo;{admin && check.campaign ? ` (${check.campaign.workspaceName})` : ''} is {check.campaign?.status === 'IN_PROGRESS' || check.campaign?.status === 'ACTIVE' ? 'running' : check.campaign?.status}, with {check.campaign?.accountIds.length} LinkedIn account
            {check.campaign?.accountIds.length === 1 ? '' : 's'}. Ready.
          </p>
        )}
      </section>

      {/* Pick */}
      <section className="border border-brand-charcoal rounded-lg p-5">
        <h2 className="text-brand-cream font-semibold">1. Pick who to write for</h2>
        <p className="text-brand-beige text-sm mt-1">
          Researched prospects with an exact LinkedIn profile, best score first. The top {TEST_SIZE} are ticked.
          {noProfile > 0 && ` ${noProfile} researched without an exact profile are left out.`}
          {notResearched > 0 && ` ${notResearched} not researched yet.`}
        </p>
        {leftOut.length > 0 && (
          <p className="text-brand-beige text-sm mt-1">
            Also left out: {leftOut.map((r) => `${cleanPersonName(r.name)} (${exclusionOf(r) === 'ulinc' ? 'in your Ulinc contacts' : 'already sent to HeyReach'})`).join(', ')}.
          </p>
        )}
        {candidates.length === 0 ? (
          <p className="text-brand-beige text-sm mt-3">Nobody left to pick.</p>
        ) : (
          <>
            <div className="mt-3 divide-y divide-brand-charcoal border border-brand-charcoal rounded-lg">
              {candidates.map((r) => (
                <label key={r.id} className="flex items-center gap-3 p-3 text-sm cursor-pointer hover:bg-brand-charcoal-deep/40">
                  <input
                    type="checkbox"
                    className="w-4 h-4 p-0"
                    checked={picked.has(r.id)}
                    onChange={(e) =>
                      setPicked((prev) => {
                        const next = new Set(prev)
                        if (e.target.checked) next.add(r.id)
                        else next.delete(r.id)
                        return next
                      })
                    }
                  />
                  <span className="text-brand-cream w-48 truncate">{cleanPersonName(r.name)}</span>
                  <span className="text-brand-beige flex-1 truncate">{[r.role, r.company].filter(Boolean).join(', ')}</span>
                  <span className="text-brand-rose-gold text-xs w-16 text-right">
                    {r.tier || '?'} &middot; {r.total_score ?? 0}
                  </span>
                </label>
              ))}
            </div>
            <button onClick={writeSelected} disabled={!!busy || picked.size === 0} className="btn-primary text-sm mt-4">
              Write messages for {picked.size}
            </button>
          </>
        )}
      </section>

      {/* Review */}
      <section className="space-y-4">
        <h2 className="text-brand-cream font-semibold">2. Review, edit, approve or reject</h2>
        {campaign.customInstructions && (
          <p className="text-brand-beige text-xs mt-1 mb-3">
            Campaign instructions to check against: <span className="text-brand-cream">{campaign.customInstructions}</span>
          </p>
        )}
        {inTest.length === 0 && <p className="text-brand-beige text-sm">No messages written yet.</p>}
        {inTest.map((r) => {
          const d = withNames(r, draftFor(r))
          const status = r.heyreach?.status || 'draft'
          const locked = status === 'pushed' || status === 'pushing'
          const dirty = !!drafts[r.id]
          const problems = pushProblems(d)
          const excludedAs = exclusionOf(r)
          return (
            <div key={r.id} className="border border-brand-charcoal rounded-lg p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-brand-cream font-semibold">{cleanPersonName(r.name)}</p>
                  <p className="text-brand-beige text-sm truncate">{[r.role, r.company, r.location].filter(Boolean).join(', ')}</p>
                  <a href={r.linkedin_url || '#'} target="_blank" rel="noreferrer" className="text-brand-rose-gold text-xs hover:underline">
                    {r.linkedin_url}
                  </a>
                </div>
                <span className={`text-xs border rounded px-2 py-1 whitespace-nowrap ${STATUS_CLASS[status] || ''}`}>{STATUS_LABEL[status] || status}</span>
              </div>

              {excludedAs && !locked && (
                <p className="text-red-400 text-xs mt-3">
                  {excludedAs === 'ulinc' ? 'In your Ulinc contacts.' : 'Already sent to HeyReach.'} This person can&apos;t be approved or sent.
                </p>
              )}

              <div className="grid grid-cols-2 gap-3 mt-4">
                <div>
                  <label className="block text-brand-beige text-xs mb-1">First name</label>
                  <input className="w-full text-sm py-2" disabled={locked} value={d.first_name || ''} onChange={(e) => editDraft(r, { first_name: e.target.value })} />
                </div>
                <div>
                  <label className="block text-brand-beige text-xs mb-1">Last name</label>
                  <input className="w-full text-sm py-2" disabled={locked} value={d.last_name || ''} onChange={(e) => editDraft(r, { last_name: e.target.value })} />
                </div>
              </div>

              <div className="space-y-3 mt-4">
                {HEYREACH_MESSAGE_FIELDS.map((f) => {
                  const text = d.msgs?.[f] || ''
                  const limit = HEYREACH_MESSAGE_SOFT_LIMITS[f]
                  const hasDash = /[—]|\s–\s/.test(text)
                  return (
                    <div key={f}>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-brand-cream font-semibold">
                          {f} <span className="text-brand-beige font-normal">{HEYREACH_MESSAGE_LABELS[f]}</span>
                        </span>
                        <span className={text.length > limit || hasDash ? 'text-red-400' : 'text-brand-beige'}>
                          {text.length}/{limit}
                          {hasDash ? ' · has a dash' : ''}
                        </span>
                      </div>
                      <textarea
                        className="w-full text-sm h-24 resize-y"
                        disabled={locked}
                        value={text}
                        onChange={(e) => editDraft(r, {}, { [f]: e.target.value })}
                      />
                    </div>
                  )
                })}
              </div>

              {!locked && problems.length > 0 && <p className="text-red-400 text-xs mt-3">Missing before it can be approved: {problems.join(', ')}.</p>}
              {r.heyreach?.push_error && <p className="text-red-400 text-xs mt-3">{r.heyreach.push_error}</p>}
              {dirty && (status === 'approved' || status === 'push_failed') && (
                <p className="text-brand-rose-gold text-xs mt-3">Saving these edits takes the approval away. You&apos;ll need to approve again.</p>
              )}

              {status === 'pushing' && (
                <div className="mt-4">
                  <button onClick={() => checkStuck(r)} disabled={!!busy} className="btn-secondary text-xs px-3 py-1.5">
                    Check HeyReach
                  </button>
                  <p className="text-brand-beige text-xs mt-2">
                    Asks HeyReach whether it already has this person. It never adds them from here: if HeyReach doesn&apos;t have them, they go back to approved for you to send again. Available a minute after the last attempt.
                  </p>
                </div>
              )}

              {!locked && (
                <div className="flex flex-wrap gap-2 mt-4">
                  {dirty && (
                    <button onClick={() => review(r, 'save')} disabled={!!busy} className="btn-secondary text-xs px-3 py-1.5">
                      Save edits
                    </button>
                  )}
                  {status !== 'approved' && (
                    <button
                      onClick={() => review(r, 'approve')}
                      disabled={!!busy || problems.length > 0 || !!excludedAs}
                      className="btn-primary text-xs px-3 py-1.5"
                    >
                      {dirty ? 'Save and approve' : status === 'push_failed' ? 'Approve again' : 'Approve'}
                    </button>
                  )}
                  {status !== 'rejected' && (
                    <button onClick={() => review(r, 'reject')} disabled={!!busy} className="btn-secondary text-xs px-3 py-1.5">
                      Reject
                    </button>
                  )}
                  {(status === 'approved' || status === 'rejected' || status === 'push_failed') && (
                    <button onClick={() => review(r, 'reopen')} disabled={!!busy} className="btn-secondary text-xs px-3 py-1.5">
                      Reopen
                    </button>
                  )}
                  {(status === 'draft' || status === 'rejected') && !excludedAs && (
                    <button onClick={() => rewrite(r)} disabled={!!busy} className="btn-secondary text-xs px-3 py-1.5">
                      Rewrite messages
                    </button>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </section>

      {/* Push */}
      <section className="border border-brand-charcoal rounded-lg p-5">
        <h2 className="text-brand-cream font-semibold">3. Send to HeyReach</h2>
        <p className="text-brand-beige text-sm mt-1">
          Adds each approved person to &ldquo;{check?.campaign?.name || 'your LinkedIn campaign'}&rdquo; with msg_1 to msg_4. The campaign is live, so their blank connection
          request goes out on HeyReach&apos;s schedule.
        </p>
        <p className="text-brand-cream text-sm mt-3">
          Approved and ready: {approved.length ? approved.map((r) => cleanPersonName(r.name)).join(', ') : 'nobody yet'}
        </p>
        {dirtyNames.length > 0 && (
          <p className="text-red-400 text-xs mt-2">Save or undo your edits first ({dirtyNames.join(', ')}). Only saved, approved text is sent.</p>
        )}
        {!confirmPush ? (
          <button onClick={() => setConfirmPush(true)} disabled={!canPush} className="btn-primary text-sm mt-3">
            Send {approved.length} approved to HeyReach
          </button>
        ) : (
          <div className="mt-3">
            <p className="text-brand-cream text-sm">
              {admin
                ? `This sends connection requests from the LinkedIn account on "${check?.campaign?.name}" (${check?.campaign?.workspaceName}) to: `
                : `This sends connection requests from your LinkedIn, through "${check?.campaign?.name}", to: `}
              {approved.map((r) => cleanPersonName(r.name)).join(', ')}.
            </p>
            <div className="flex gap-2 mt-2">
              <button onClick={pushApproved} disabled={!canPush} className="btn-primary text-sm">
                Yes, send {approved.length} now
              </button>
              <button onClick={() => setConfirmPush(false)} className="btn-secondary text-sm">
                Cancel
              </button>
            </div>
          </div>
        )}
        {!ready && check && <p className="text-red-400 text-xs mt-2">{admin ? `Fix the HeyReach campaign first: ${check.problem}` : 'Your LinkedIn campaign isn\'t ready yet. We\'ll let you know when it is.'}</p>}
      </section>

      {/* Results */}
      {sent.length > 0 && (
        <section className="border border-brand-charcoal rounded-lg p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-brand-cream font-semibold">4. What HeyReach returned</h2>
            <Link href="/dashboard/linkedin" className="text-brand-rose-gold text-xs font-semibold hover:underline">
              See the pipeline &rarr;
            </Link>
          </div>
          <div className="mt-3 divide-y divide-brand-charcoal border border-brand-charcoal rounded-lg">
            {sent.map((r) => {
              const p = r.heyreach!.push!
              return (
                <div key={r.id} className="p-4 text-sm">
                  <div className="flex justify-between">
                    <span className="text-brand-cream font-semibold">{cleanPersonName(r.name)}</span>
                    <span className={p.outcome === 'accepted' ? 'text-green-400' : 'text-red-400'}>{p.outcome === 'accepted' ? 'Accepted' : 'Not accepted'}</span>
                  </div>
                  <p className="text-brand-beige text-xs mt-1">
                    {p.response
                      ? `HTTP ${p.response.status} in ${p.response.ms}ms: added ${p.response.added}, updated ${p.response.updated}, failed ${p.response.failed}.`
                      : p.recovered
                        ? 'Found already in HeyReach when checked.'
                        : 'No reply recorded.'}{' '}
                    Campaign {p.heyreach_campaign_id} ({p.heyreach_campaign_status}), sender {p.linkedin_account_id}. {new Date(p.at).toLocaleString('en-GB')}
                  </p>
                  {p.read_back && 'warnings' in p.read_back && p.read_back.warnings?.map((w) => (
                    <p key={w} className="text-amber-400 text-xs mt-1">{w}</p>
                  ))}
                  <details className="mt-2">
                    <summary className="text-brand-rose-gold text-xs cursor-pointer">Raw replies</summary>
                    <pre className="text-[11px] text-brand-beige whitespace-pre-wrap break-all mt-2 max-h-80 overflow-auto">
                      {JSON.stringify({ sent: p.sent_lead, response: p.response?.body ?? null, read_back: p.read_back }, null, 2)}
                    </pre>
                  </details>
                </div>
              )
            })}
          </div>
        </section>
      )}
    </div>
  )
}
