'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'

// v79: admin section on /dashboard/heyreach. HeyReach API keys belong to one
// workspace, so each client workspace needs its own key here. The key is
// checked with HeyReach, stored encrypted, and never shown again.

interface Workspace {
  id: string | null
  name: string
  createdAt?: string
  keyUpdatedAt?: string
  keyOk: boolean
  campaigns: number | null
  error?: string
}

async function send(body: unknown) {
  const res = await fetch('/api/heyreach/workspaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error || 'Could not save')
  return json as { ok: boolean }
}

export default function WorkspacesAdmin({ onChange }: { onChange?: () => void }) {
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [name, setName] = useState('')
  const [key, setKey] = useState('')
  const [replacing, setReplacing] = useState<string | null>(null)
  const [newKey, setNewKey] = useState('')

  async function load() {
    try {
      const res = await fetch('/api/heyreach/workspaces', { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Could not load')
      setWorkspaces(json.workspaces || [])
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load')
    }
  }

  useEffect(() => {
    load()
  }, [])

  async function run(body: Record<string, unknown>, done: string) {
    setSaving(true)
    try {
      await send(body)
      toast.success(done)
      await load()
      onChange?.()
      return true
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save')
      return false
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="border border-brand-charcoal rounded-lg p-5">
      <h2 className="text-brand-cream font-semibold">4. HeyReach workspaces</h2>
      <p className="text-brand-beige text-sm mt-1">
        Each HeyReach workspace has its own API key. Your main workspace uses the key in Netlify. For a client&apos;s workspace, switch to it in HeyReach, go to Settings, then Integrations, click New API key, and paste the key here. It&apos;s checked with HeyReach, stored encrypted, and never shown again.
      </p>

      {error && <p className="text-red-400 text-sm mt-3">{error}</p>}
      {!workspaces && !error && <p className="text-brand-beige text-sm mt-3">Checking workspaces...</p>}

      {workspaces && (
        <div className="mt-4 divide-y divide-brand-charcoal border border-brand-charcoal rounded-lg">
          {workspaces.length === 0 && <p className="p-4 text-brand-beige text-sm">No workspaces yet.</p>}
          {workspaces.map((w) => (
            <div key={w.id || 'main'} className="p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-brand-cream">{w.name}</p>
                  <p className={`text-xs ${w.keyOk ? 'text-green-400' : 'text-red-400'}`}>
                    {w.keyOk ? `Key works · ${w.campaigns ?? 0} campaign${w.campaigns === 1 ? '' : 's'}` : `Key not working${w.error ? `: ${w.error}` : ''}`}
                    {!w.id && <span className="text-brand-beige"> · key in Netlify</span>}
                  </p>
                </div>
                {w.id && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        setReplacing(replacing === w.id ? null : w.id)
                        setNewKey('')
                      }}
                      disabled={saving}
                      className="btn-secondary text-xs px-3 py-1.5"
                    >
                      Replace key
                    </button>
                    <button
                      onClick={() => {
                        if (window.confirm(`Remove "${w.name}"? Anyone given a campaign from it loses access to that pipeline.`)) {
                          run({ action: 'remove', id: w.id }, 'Workspace removed')
                        }
                      }}
                      disabled={saving}
                      className="btn-secondary text-xs px-3 py-1.5"
                    >
                      Remove
                    </button>
                  </div>
                )}
              </div>
              {replacing === w.id && w.id && (
                <div className="flex flex-wrap items-center gap-2 mt-3">
                  <input
                    type="password"
                    autoComplete="off"
                    value={newKey}
                    onChange={(e) => setNewKey(e.target.value)}
                    placeholder="New API key"
                    className="text-sm py-2 px-3 min-w-[18rem]"
                  />
                  <button
                    onClick={async () => {
                      if (await run({ action: 'replace_key', id: w.id, key: newKey.trim() }, 'Key replaced')) {
                        setReplacing(null)
                        setNewKey('')
                      }
                    }}
                    disabled={saving || newKey.trim().length < 10}
                    className="btn-primary text-sm px-4 py-2"
                  >
                    {saving ? 'Checking...' : 'Save key'}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3 mt-4">
        <label className="text-brand-beige text-xs flex flex-col gap-1">
          Workspace name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Rob Saunderson" className="text-sm py-2 px-3 min-w-[14rem]" />
        </label>
        <label className="text-brand-beige text-xs flex flex-col gap-1">
          API key from that workspace
          <input
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Paste the key"
            className="text-sm py-2 px-3 min-w-[18rem]"
          />
        </label>
        <button
          onClick={async () => {
            if (await run({ action: 'add', name: name.trim(), key: key.trim() }, 'Workspace added')) {
              setName('')
              setKey('')
            }
          }}
          disabled={saving || !name.trim() || key.trim().length < 10}
          className="btn-primary text-sm px-4 py-2"
        >
          {saving ? 'Checking...' : 'Add workspace'}
        </button>
      </div>
    </section>
  )
}
