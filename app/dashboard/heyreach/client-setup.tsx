'use client'

import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { HEYREACH_TEST_CAMPAIGN } from '@/lib/heyreach-shared'
import { CAMPAIGN_NAME_MAX, CLIENT_SCHEDULE_LABEL } from '@/lib/heyreach-sequence'

// v80: admin section on /dashboard/heyreach. One button that does what used
// to be a dozen clicks in HeyReach for each new client: an empty lead list, a
// campaign with a copy of a sequence that already works, weekday London
// hours, the client's own LinkedIn as the sender, started, and the client
// given send access to that campaign only. Client workspaces only, so nothing
// can ever be set up to send from Dan's LinkedIn.

interface User {
  id: string
  email: string
  name: string | null
}
interface Workspace {
  id: string
  name: string
}
interface Template {
  id: number
  name: string
  status: string
  workspaceId: string | null
  workspaceName: string
}
interface Sender {
  id: number
  name: string
  email: string | null
  authValid: boolean | null
  active: boolean | null
}
interface Preview {
  steps: string[]
  warning: string | null
  source?: string | null
}
type StepState = 'todo' | 'doing' | 'done' | 'failed'

const BUILT_IN = 'builtin'
const STEPS = ['Create the campaign in HeyReach', 'Start it', 'Give the client send access'] as const

async function call(path: string, init?: RequestInit) {
  const res = await fetch(path, { cache: 'no-store', ...init })
  const json = await res.json().catch(() => ({}))
  if (!res.ok || json.ok === false) throw new Error(json.error || 'Something went wrong')
  return json
}

const post = (path: string, body: unknown) =>
  call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

function templateKey(t: { workspaceId: string | null; id: number }) {
  return `${t.workspaceId || 'main'}:${t.id}`
}

export default function ClientSetup({ onChange }: { onChange?: () => void }) {
  const [users, setUsers] = useState<User[]>([])
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [templates, setTemplates] = useState<Template[]>([])
  const [loadError, setLoadError] = useState('')
  const [loading, setLoading] = useState(true)

  const [userId, setUserId] = useState('')
  const [workspaceId, setWorkspaceId] = useState('')
  const [senders, setSenders] = useState<Sender[] | null>(null)
  const [sendersError, setSendersError] = useState('')
  const [takenNames, setTakenNames] = useState<string[]>([])
  const [senderId, setSenderId] = useState('')
  const [name, setName] = useState('')
  const [nameEdited, setNameEdited] = useState(false)
  const [template, setTemplate] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewError, setPreviewError] = useState('')
  const [previewing, setPreviewing] = useState(false)

  const [running, setRunning] = useState(false)
  const [steps, setSteps] = useState<StepState[]>(['todo', 'todo', 'todo'])
  const [stepNotes, setStepNotes] = useState<string[]>(['', '', ''])
  const [campaignId, setCampaignId] = useState<number | null>(null)
  const [finished, setFinished] = useState('')

  useEffect(() => {
    call('/api/heyreach/setup')
      .then((json) => {
        setUsers(json.users || [])
        setWorkspaces(json.workspaces || [])
        const list: Template[] = json.templates || []
        setTemplates(list)
        const preferred = list.find((t) => t.workspaceId === null && t.name.trim().toLowerCase() === HEYREACH_TEST_CAMPAIGN.toLowerCase()) || list[0]
        setTemplate(preferred ? templateKey(preferred) : BUILT_IN)
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Could not load'))
      .finally(() => setLoading(false))
  }, [])

  const workspace = workspaces.find((w) => w.id === workspaceId)
  const user = users.find((u) => u.id === userId)

  // A new workspace: its LinkedIn accounts, and a name for the campaign.
  useEffect(() => {
    setSenders(null)
    setSenderId('')
    setSendersError('')
    setTakenNames([])
    if (!workspaceId) return
    let live = true
    call(`/api/heyreach/setup?workspace_id=${workspaceId}`)
      .then((json) => {
        if (!live) return
        const list: Sender[] = json.senders || []
        setSenders(list)
        setTakenNames((json.campaigns || []).map((c: { name: string }) => c.name.trim().toLowerCase()))
        const usable = list.filter((s) => s.authValid !== false)
        if (usable.length === 1) setSenderId(String(usable[0].id))
      })
      .catch((err) => live && setSendersError(err instanceof Error ? err.message : 'Could not load'))
    return () => {
      live = false
    }
  }, [workspaceId])

  useEffect(() => {
    if (nameEdited) return
    const base = workspace?.name || user?.name || ''
    setName(base ? `${base} · ProspectIQ`.slice(0, CAMPAIGN_NAME_MAX) : '')
  }, [workspace, user, nameEdited])

  // Show the sequence the new campaign will get, before anything is made.
  useEffect(() => {
    if (!template) return
    let live = true
    setPreview(null)
    setPreviewError('')
    setPreviewing(true)
    const t = templates.find((x) => templateKey(x) === template)
    post('/api/heyreach/setup', { action: 'preview', template: t ? { workspace_id: t.workspaceId, campaign_id: t.id } : null })
      .then((json) => live && setPreview({ steps: json.steps || [], warning: json.warning || null, source: json.source }))
      .catch((err) => live && setPreviewError(err instanceof Error ? err.message : 'Could not read the sequence'))
      .finally(() => live && setPreviewing(false))
    return () => {
      live = false
    }
  }, [template, templates])

  // A different client, workspace or sequence starts a fresh run.
  useEffect(() => {
    setSteps(['todo', 'todo', 'todo'])
    setStepNotes(['', '', ''])
    setCampaignId(null)
    setFinished('')
  }, [userId, workspaceId, senderId, template])

  const nameTaken = !!name.trim() && takenNames.includes(name.trim().toLowerCase())
  const chosenTemplate = templates.find((t) => templateKey(t) === template) || null
  const builtIn = template === BUILT_IN
  const sender = senders?.find((s) => String(s.id) === senderId)
  const ready = !!user && !!workspace && !!sender && !!name.trim() && !!preview && !previewError && !running && !finished

  const blockers = useMemo(() => {
    const out: string[] = []
    if (!user) out.push('choose the client')
    if (!workspace) out.push('choose their HeyReach workspace')
    else if (senders && senders.length === 0) out.push(`connect their LinkedIn to "${workspace.name}" in HeyReach first`)
    else if (!sender) out.push('choose the LinkedIn account to send from')
    if (!name.trim()) out.push('name the campaign')
    if (previewError) out.push('pick a sequence that can be read')
    return out
  }, [user, workspace, senders, sender, name, previewError])

  function mark(i: number, state: StepState, note = '') {
    setSteps((prev) => prev.map((s, j) => (j === i ? state : s)))
    setStepNotes((prev) => prev.map((n, j) => (j === i ? note : n)))
  }

  async function run() {
    if (!user || !workspace || !sender) return
    setRunning(true)
    let id = campaignId
    let startProblem = ''
    try {
      // 1. Create (a retry picks up the campaign it already made, by name)
      if (!id || steps[0] !== 'done') {
        mark(0, 'doing')
        try {
          const json = await post('/api/heyreach/setup', {
            action: 'create',
            workspace_id: workspace.id,
            sender_id: sender.id,
            name: name.trim(),
            template: chosenTemplate ? { workspace_id: chosenTemplate.workspaceId, campaign_id: chosenTemplate.id } : null,
          })
          id = json.campaignId as number
          setCampaignId(id)
          mark(0, 'done', json.existing ? `A campaign called "${name.trim()}" was already there (${String(json.status || '').toLowerCase().replace(/_/g, ' ') || 'status unknown'}), so it was used.` : `Campaign ${id}, sending from ${sender.name}.`)
        } catch (err) {
          mark(0, 'failed', err instanceof Error ? err.message : 'Failed')
          return
        }
      }

      // 2. Start. If HeyReach won't, carry on: sending refuses until it runs.
      if (steps[1] !== 'done') {
        mark(1, 'doing')
        try {
          const json = await post('/api/heyreach/setup', { action: 'start', workspace_id: workspace.id, campaign_id: id })
          if (json.running) mark(1, 'done', `Started${json.status === 'FINISHED' ? ': HeyReach shows it as finished until the first person is sent, which restarts it' : ''}. Nothing is sent until someone is approved and sent.`)
          else {
            startProblem = `HeyReach says it's ${String(json.status || 'not running').toLowerCase().replace(/_/g, ' ')}.`
            mark(1, 'failed', `${startProblem} Start it in HeyReach, or click Try again.`)
          }
        } catch (err) {
          startProblem = err instanceof Error ? err.message : 'Failed'
          mark(1, 'failed', `${startProblem} Start it in HeyReach, or click Try again.`)
        }
      }

      // 3. Access: this campaign, can send. Their LinkedIn, their workspace.
      if (steps[2] !== 'done') {
        mark(2, 'doing')
        try {
          await post('/api/heyreach/access', { action: 'assign', user_id: user.id, heyreach_campaign_id: id, workspace_id: workspace.id, can_send: true })
          mark(2, 'done', `${user.name || user.email} sees and sends into it.`)
          onChange?.()
        } catch (err) {
          mark(2, 'failed', err instanceof Error ? err.message : 'Failed')
          return
        }
      }

      if (!startProblem) {
        setFinished(`${user.name || user.email} can now send into "${name.trim()}" from Send to LinkedIn on any of their campaigns.`)
        toast.success('Client set up')
      }
    } finally {
      setRunning(false)
    }
  }

  const label = (u: User) => (u.name ? `${u.name} (${u.email})` : u.email)
  const icon: Record<StepState, string> = { todo: '○', doing: '…', done: '✓', failed: '✕' }
  const iconClass: Record<StepState, string> = { todo: 'text-brand-beige', doing: 'text-brand-rose-gold', done: 'text-green-400', failed: 'text-red-400' }
  const started = steps.some((s) => s !== 'todo')

  return (
    <section className="border border-brand-charcoal rounded-lg p-5">
      <h2 className="text-brand-cream font-semibold">5. Set up a client&apos;s LinkedIn campaign</h2>
      <p className="text-brand-beige text-sm mt-1">
        Does the HeyReach set-up for you. Before you start: add the client&apos;s HeyReach workspace above, and have them connect their own LinkedIn to it in HeyReach. Then this creates the campaign there, copies a sequence that already works, sets the hours, starts it, and lets the client send into it. Nothing is sent to anyone until they approve and send prospects themselves.
      </p>

      {loading && <p className="text-brand-beige text-sm mt-3">Loading...</p>}
      {loadError && <p className="text-red-400 text-sm mt-3">{loadError}</p>}

      {!loading && !loadError && (
        <div className="mt-4 space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-brand-beige text-xs flex flex-col gap-1">
              Client
              <select value={userId} onChange={(e) => setUserId(e.target.value)} className="text-sm py-2 px-3 min-w-[16rem]">
                <option value="">Choose the client</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {label(u)}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-brand-beige text-xs flex flex-col gap-1">
              Their HeyReach workspace
              <select value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} className="text-sm py-2 px-3 min-w-[14rem]">
                <option value="">{workspaces.length ? 'Choose a workspace' : 'Add a client workspace above first'}</option>
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
            {workspaceId && (
              <label className="text-brand-beige text-xs flex flex-col gap-1">
                Send from
                <select value={senderId} onChange={(e) => setSenderId(e.target.value)} disabled={!senders || senders.length === 0} className="text-sm py-2 px-3 min-w-[14rem]">
                  <option value="">{!senders ? (sendersError ? 'Could not load' : 'Loading...') : senders.length === 0 ? 'No LinkedIn connected yet' : 'Choose their LinkedIn'}</option>
                  {(senders || []).map((s) => (
                    <option key={s.id} value={s.id} disabled={s.authValid === false}>
                      {s.name}
                      {s.email ? ` (${s.email})` : ''}
                      {s.authValid === false ? ' · needs reconnecting' : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {sendersError && <p className="text-red-400 text-xs">{sendersError}</p>}
          {workspace && senders && senders.length === 0 && (
            <p className="text-red-400 text-xs">No LinkedIn account is connected to &ldquo;{workspace.name}&rdquo; yet. The client has to sign in to LinkedIn in that workspace in HeyReach themselves (Settings, LinkedIn accounts). Then choose the workspace again.</p>
          )}

          <div className="flex flex-wrap items-end gap-3">
            <label className="text-brand-beige text-xs flex flex-col gap-1">
              Campaign name in HeyReach
              <input
                value={name}
                maxLength={CAMPAIGN_NAME_MAX}
                onChange={(e) => {
                  setName(e.target.value)
                  setNameEdited(true)
                }}
                placeholder="e.g. Rob Saunderson · ProspectIQ"
                className="text-sm py-2 px-3 min-w-[18rem]"
              />
            </label>
            <label className="text-brand-beige text-xs flex flex-col gap-1">
              Copy the sequence from
              <select value={template} onChange={(e) => setTemplate(e.target.value)} className="text-sm py-2 px-3 min-w-[18rem]">
                {templates.map((t) => (
                  <option key={templateKey(t)} value={templateKey(t)}>
                    {t.workspaceName} · {t.name}
                  </option>
                ))}
                <option value={BUILT_IN}>Built-in sequence</option>
              </select>
            </label>
          </div>
          {nameTaken && (
            <p className="text-brand-beige text-xs">There&apos;s already a campaign with this name in that workspace. Setting up will use it rather than make a second one.</p>
          )}

          <div className="border border-brand-charcoal rounded-lg p-3 text-xs">
            <p className="text-brand-cream font-semibold mb-1">What the campaign will do</p>
            <p className="text-brand-beige mb-2">{CLIENT_SCHEDULE_LABEL}. Leaves out anyone this workspace has already messaged in another campaign.</p>
            {previewing && <p className="text-brand-beige">Reading the sequence...</p>}
            {previewError && <p className="text-red-400">{previewError}</p>}
            {preview && (
              <>
                <pre className="text-brand-cream whitespace-pre-wrap font-sans leading-relaxed">{preview.steps.join('\n')}</pre>
                {preview.warning && <p className="text-red-400 mt-2">{preview.warning}</p>}
                {builtIn && (
                  <p className="text-brand-beige mt-2">
                    The same steps and variables as the hand-built &ldquo;{HEYREACH_TEST_CAMPAIGN}&rdquo; campaign. Copying a campaign is still the safer choice when you have one.
                  </p>
                )}
              </>
            )}
          </div>

          {started && (
            <ol className="space-y-1 text-sm">
              {STEPS.map((s, i) => (
                <li key={s} className="flex gap-2">
                  <span className={`w-4 ${iconClass[steps[i]]}`}>{icon[steps[i]]}</span>
                  <span>
                    <span className="text-brand-cream">{s}</span>
                    {stepNotes[i] && <span className={`block text-xs ${steps[i] === 'failed' ? 'text-red-400' : 'text-brand-beige'}`}>{stepNotes[i]}</span>}
                  </span>
                </li>
              ))}
            </ol>
          )}

          {finished ? (
            <p className="text-green-400 text-sm">{finished}</p>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <button onClick={run} disabled={!ready} className="btn-primary text-sm px-4 py-2">
                {running ? 'Setting up...' : steps.some((s) => s === 'failed') ? 'Try again' : 'Set up'}
              </button>
              {!running && blockers.length > 0 && <p className="text-brand-beige text-xs">To set up, {blockers.join(', ')}.</p>}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
