'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'

// v78: admin section on /dashboard/heyreach. Choose which HeyReach campaigns
// each user sees in their LinkedIn pipeline.

interface AccessUser {
  id: string
  email: string
  name: string | null
}

interface Assignment {
  user_id: string
  email: string
  name: string | null
  heyreach_campaign_id: number
  workspace_id: string | null
  workspace_name?: string
  can_send: boolean
  campaign_name: string | null
  assigned_at: string
}

interface Campaign {
  id: number
  name: string
  status: string
  workspaceId: string | null
  workspaceName: string
}

export default function PipelineAccess() {
  const [users, setUsers] = useState<AccessUser[]>([])
  const [assignments, setAssignments] = useState<Assignment[]>([])
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [userId, setUserId] = useState('')
  const [campaignId, setCampaignId] = useState('')
  // A campaign sends from the LinkedIn account attached to it. Client
  // workspaces hold the client's own LinkedIn, so sending is ticked for those;
  // your main workspace sends from yours, so it starts unticked.
  const [canSend, setCanSend] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const res = await fetch('/api/heyreach/access', { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Could not load')
      setUsers(json.users || [])
      setAssignments(json.assignments || [])
      setCampaigns(json.campaigns || [])
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  async function change(action: 'assign' | 'remove' | 'set_send', uid: string, cid: number, workspaceId: string | null, send = false) {
    setSaving(true)
    try {
      const res = await fetch('/api/heyreach/access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, user_id: uid, heyreach_campaign_id: cid, workspace_id: workspaceId, can_send: send }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || 'Could not save')
      if (json.assignments) load()
      if (json.users) setUsers(json.users)
      toast.success(action === 'assign' ? 'Campaign assigned' : action === 'set_send' ? (send ? 'Sending switched on' : 'Sending switched off') : 'Access removed')
      if (action === 'assign') setCampaignId('')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  const label = (u: { email: string; name: string | null }) => (u.name ? `${u.name} (${u.email})` : u.email)

  return (
    <section className="border border-brand-charcoal rounded-lg p-5">
      <h2 className="text-brand-cream font-semibold">5. Who sees and sends into which campaign</h2>
      <p className="text-brand-beige text-sm mt-1">
        Give a user a HeyReach campaign and they see its LinkedIn pipeline. Tick &ldquo;Can send into it&rdquo; to also let them send their own approved prospects into it from Send to LinkedIn. A campaign sends from the LinkedIn account attached to it, so only do that for a campaign running on their own LinkedIn. They see nothing else in HeyReach.
      </p>

      {loading && <p className="text-brand-beige text-sm mt-3">Loading...</p>}
      {error && <p className="text-red-400 text-sm mt-3">{error}</p>}

      {!loading && !error && (
        <>
          <div className="flex flex-wrap items-end gap-3 mt-4">
            <label className="text-brand-beige text-xs flex flex-col gap-1">
              User
              <select value={userId} onChange={(e) => setUserId(e.target.value)} className="text-sm py-2 px-3 min-w-[16rem]">
                <option value="">Choose a user</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {label(u)}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-brand-beige text-xs flex flex-col gap-1">
              HeyReach campaign
              <select
                value={campaignId}
                onChange={(e) => {
                  setCampaignId(e.target.value)
                  setCanSend(!!e.target.value && !e.target.value.startsWith('main:'))
                }}
                className="text-sm py-2 px-3 min-w-[14rem]"
              >
                <option value="">Choose a campaign</option>
                {campaigns.map((c) => (
                  <option key={`${c.workspaceId || 'main'}:${c.id}`} value={`${c.workspaceId || 'main'}:${c.id}`}>
                    {c.workspaceName} · {c.name} ({c.status.toLowerCase().replace(/_/g, ' ')})
                  </option>
                ))}
              </select>
            </label>
            <label className="text-brand-cream text-xs flex items-center gap-2 pb-2">
              <input type="checkbox" className="w-4 h-4 p-0" checked={canSend} onChange={(e) => setCanSend(e.target.checked)} />
              Can send into it
            </label>
            <button
              onClick={() => {
                const [ws, id] = campaignId.split(':')
                change('assign', userId, Number(id), ws === 'main' ? null : ws, canSend)
              }}
              disabled={saving || !userId || !campaignId}
              className="btn-primary text-sm px-4 py-2"
            >
              {saving ? 'Saving...' : 'Give access'}
            </button>
          </div>

          <div className="mt-4 divide-y divide-brand-charcoal border border-brand-charcoal rounded-lg">
            {assignments.length === 0 && <p className="p-4 text-brand-beige text-sm">Nobody has access yet.</p>}
            {assignments.map((a) => (
              <div key={`${a.user_id}-${a.heyreach_campaign_id}`} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                <div>
                  <p className="text-brand-cream">{label(a)}</p>
                  <p className="text-brand-beige text-xs">
                    {a.workspace_name ? `${a.workspace_name} · ` : ''}{a.campaign_name || `Campaign ${a.heyreach_campaign_id}`} · {a.can_send ? 'sees and sends' : 'sees the pipeline only'} · since {new Date(a.assigned_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    if (!a.can_send && !a.workspace_id && !window.confirm('This campaign is in your main workspace, so it sends from your LinkedIn. Let this user send into it?')) return
                    change('set_send', a.user_id, a.heyreach_campaign_id, a.workspace_id, !a.can_send)
                  }}
                  disabled={saving}
                  className="btn-secondary text-xs px-3 py-1.5"
                >
                  {a.can_send ? 'Turn sending off' : 'Let them send'}
                </button>
                <button
                  onClick={() => change('remove', a.user_id, a.heyreach_campaign_id, a.workspace_id)}
                  disabled={saving}
                  className="btn-secondary text-xs px-3 py-1.5"
                >
                  Remove
                </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  )
}
