'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { PLAN_LIMITS } from '@/types'
import { fcaIndividualUrl, fcaFirmUrl } from '@/lib/recruitment/links'

export interface WatchItem {
  id: string
  item_type: 'adviser' | 'firm'
  fca_irn: string | null
  fca_frn: string | null
  display_name: string
  firm_name: string | null
  prospect_id: string | null
  campaign_id: string | null
  last_checked_at: string | null
  last_snapshot: Record<string, unknown> | null
  created_at: string
}

export interface WatchableProspect {
  id: string
  name: string
  campaign_id: string
  fca_irn: string | null
  fca_frn: string | null
  fca_firm_name: string | null
  company: string | null
}

interface Props {
  initialItems: WatchItem[]
  unreadByItem: Record<string, number>
  prospects: WatchableProspect[]
}

function formatChecked(iso: string | null): string {
  if (!iso) return 'Not checked yet'
  const d = new Date(iso)
  const mins = Math.round((Date.now() - d.getTime()) / 60000)
  if (mins < 60) return `${Math.max(1, mins)} min ago`
  if (mins < 60 * 24) return `${Math.round(mins / 60)} hours ago`
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

export default function WatchlistManager({ initialItems, unreadByItem, prospects }: Props) {
  const [items, setItems] = useState<WatchItem[]>(initialItems)
  const [busy, setBusy] = useState<string | null>(null)
  const [tab, setTab] = useState<'adviser' | 'firm' | 'search'>('adviser')
  const [adviserPick, setAdviserPick] = useState('')
  const [firmPick, setFirmPick] = useState('')
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<{ frn: string; name: string; status: string }[]>([])
  const [filter, setFilter] = useState<'all' | 'adviser' | 'firm'>('all')

  const limit = PLAN_LIMITS.recruitment.watchlist_items
  const atLimit = items.length >= limit

  const watchedIrns = useMemo(() => new Set(items.filter((i) => i.fca_irn).map((i) => i.fca_irn as string)), [items])
  const watchedFrns = useMemo(() => new Set(items.filter((i) => i.fca_frn && i.item_type === 'firm').map((i) => i.fca_frn as string)), [items])

  const adviserOptions = prospects.filter((p) => p.fca_irn && !watchedIrns.has(p.fca_irn))
  const firmOptions = useMemo(() => {
    const seen = new Set<string>()
    const out: { frn: string; name: string; prospect_id: string }[] = []
    for (const p of prospects) {
      if (!p.fca_frn || seen.has(p.fca_frn) || watchedFrns.has(p.fca_frn)) continue
      seen.add(p.fca_frn)
      out.push({ frn: p.fca_frn, name: p.fca_firm_name || p.company || p.fca_frn, prospect_id: p.id })
    }
    return out
  }, [prospects, watchedFrns])

  async function add(body: Record<string, unknown>, key: string) {
    if (atLimit) return toast.error(`Watchlist limit reached (${limit}). Remove an item first.`)
    setBusy(key)
    try {
      const res = await fetch('/api/recruitment/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not add')
      setItems((prev) => [data.item as WatchItem, ...prev])
      toast.success(`Watching ${data.item.display_name}. The first check stores a baseline.`)
      setAdviserPick('')
      setFirmPick('')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not add')
    } finally {
      setBusy(null)
    }
  }

  async function remove(id: string) {
    setBusy(id)
    try {
      const res = await fetch('/api/recruitment/watchlist', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not remove')
      setItems((prev) => prev.filter((i) => i.id !== id))
      toast.success('Removed from watchlist')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not remove')
    } finally {
      setBusy(null)
    }
  }

  async function search() {
    if (query.trim().length < 2) return
    setSearching(true)
    try {
      const res = await fetch('/api/recruitment/watchlist/firm-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Search failed')
      setResults(data.firms || [])
      if ((data.firms || []).length === 0) toast.success('No firms found on the register')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Search failed')
    } finally {
      setSearching(false)
    }
  }

  const shown = filter === 'all' ? items : items.filter((i) => i.item_type === filter)

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <p className="text-brand-rose-gold text-[10px] font-bold tracking-[2px] uppercase mb-1">Recruitment</p>
          <h1 className="text-2xl font-display text-brand-cream">Watchlist</h1>
          <p className="text-brand-beige text-sm mt-1">
            Advisers and firms are checked against the FCA Register in rotation, a batch every 15 minutes. Changes raise an alert.
          </p>
        </div>
        <div className="text-right">
          <p className="text-brand-cream text-2xl font-display">{items.length}<span className="text-brand-beige text-sm font-body">/{limit}</span></p>
          <p className="text-brand-beige text-[10px] uppercase tracking-wide">Items watched</p>
        </div>
      </div>

      {/* Add */}
      <div className="bg-brand-charcoal-deep rounded-xl border border-brand-charcoal p-5 mb-6">
        <div className="flex gap-2 mb-4">
          {([
            { key: 'adviser', label: 'Add an adviser' },
            { key: 'firm', label: "Add an adviser's firm" },
            { key: 'search', label: 'Search the register for a firm' },
          ] as const).map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${tab === t.key ? 'border-brand-rose-gold text-brand-rose-gold bg-brand-rose-gold/10' : 'border-brand-charcoal text-brand-beige hover:border-brand-rose-gold'}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'adviser' && (
          <div className="flex gap-3 items-center">
            <select value={adviserPick} onChange={(e) => setAdviserPick(e.target.value)} className="flex-1 text-sm">
              <option value="">{adviserOptions.length ? 'Choose a researched adviser' : 'No researched advisers with a register entry left to add'}</option>
              {adviserOptions.map((p) => (
                <option key={p.id} value={p.id}>{p.name}{p.company ? `, ${p.company}` : ''} ({p.fca_irn})</option>
              ))}
            </select>
            <button
              onClick={() => add({ item_type: 'adviser', prospect_id: adviserPick }, 'add-adviser')}
              disabled={!adviserPick || busy !== null || atLimit}
              className="btn-primary text-sm"
            >
              {busy === 'add-adviser' ? 'Adding...' : 'Watch adviser'}
            </button>
          </div>
        )}

        {tab === 'firm' && (
          <div className="flex gap-3 items-center">
            <select value={firmPick} onChange={(e) => setFirmPick(e.target.value)} className="flex-1 text-sm">
              <option value="">{firmOptions.length ? "Choose a researched adviser's firm" : 'No firms left to add from your researched advisers'}</option>
              {firmOptions.map((f) => (
                <option key={f.frn} value={f.prospect_id}>{f.name} (FRN {f.frn})</option>
              ))}
            </select>
            <button
              onClick={() => add({ item_type: 'firm', prospect_id: firmPick }, 'add-firm')}
              disabled={!firmPick || busy !== null || atLimit}
              className="btn-primary text-sm"
            >
              {busy === 'add-firm' ? 'Adding...' : 'Watch firm'}
            </button>
          </div>
        )}

        {tab === 'search' && (
          <div>
            <div className="flex gap-3 items-center">
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') search() }}
                placeholder="Firm name or FRN, e.g. Openwork Limited or 408285"
                className="flex-1 text-sm"
              />
              <button onClick={search} disabled={searching || query.trim().length < 2} className="btn-secondary text-sm">
                {searching ? 'Searching...' : 'Search'}
              </button>
            </div>
            {results.length > 0 && (
              <div className="mt-3 divide-y divide-brand-charcoal border border-brand-charcoal rounded-lg">
                {results.map((f) => (
                  <div key={f.frn} className="flex items-center justify-between p-3">
                    <div className="min-w-0">
                      <p className="text-brand-cream text-sm truncate">{f.name}</p>
                      <p className="text-brand-beige text-xs">FRN {f.frn} &middot; {f.status}</p>
                    </div>
                    {watchedFrns.has(f.frn) ? (
                      <span className="text-brand-beige text-xs">Watching</span>
                    ) : (
                      <button
                        onClick={() => add({ item_type: 'firm', fca_frn: f.frn, display_name: f.name }, `search-${f.frn}`)}
                        disabled={busy !== null || atLimit}
                        className="text-brand-rose-gold text-xs font-semibold hover:underline"
                      >
                        {busy === `search-${f.frn}` ? 'Adding...' : 'Watch firm'}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* List */}
      <div className="flex gap-2 mb-3">
        {(['all', 'adviser', 'firm'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${filter === f ? 'bg-brand-rose-gold text-brand-dark' : 'text-brand-beige border border-brand-charcoal hover:border-brand-rose-gold'}`}
          >
            {f === 'all' ? 'All' : f === 'adviser' ? 'Advisers' : 'Firms'}
          </button>
        ))}
      </div>

      <div className="bg-brand-charcoal-deep rounded-xl border border-brand-charcoal overflow-hidden">
        <div className="grid grid-cols-12 gap-3 px-5 py-3 border-b border-brand-charcoal text-brand-beige text-[10px] uppercase tracking-wider font-semibold">
          <div className="col-span-4">Watching</div>
          <div className="col-span-2">Status</div>
          <div className="col-span-3">Current firm or headcount</div>
          <div className="col-span-2">Last checked</div>
          <div className="col-span-1 text-right"></div>
        </div>
        {shown.length === 0 ? (
          <div className="p-10 text-center text-brand-beige text-sm">
            Nothing on your watchlist yet. Add an adviser or firm above, or use Watch on a researched adviser.
          </div>
        ) : (
          <div className="divide-y divide-brand-charcoal">
            {shown.map((item) => {
              const snap = item.last_snapshot || {}
              const unread = unreadByItem[item.id] || 0
              const status = typeof snap.status === 'string' ? snap.status : null
              const detail = item.item_type === 'adviser'
                ? (typeof snap.current_firm_name === 'string' ? snap.current_firm_name : item.firm_name) || (item.last_checked_at ? 'No current firm' : '')
                : snap.individual_count !== undefined
                ? `${snap.individual_count ?? '?'} individuals, ${snap.ar_count ?? '?'}${snap.ar_count_is_minimum ? '+' : ''} ARs`
                : ''
              return (
                <div key={item.id} className="grid grid-cols-12 gap-3 px-5 py-4 items-center">
                  <div className="col-span-4 min-w-0">
                    <div className="flex items-center gap-2">
                      {unread > 0 && (
                        <Link href="/dashboard/recruitment/alerts" title={`${unread} unread alert${unread === 1 ? '' : 's'}`} className="w-2 h-2 rounded-full bg-brand-rose-gold flex-shrink-0" />
                      )}
                      <p className="text-brand-cream text-sm font-medium truncate">{item.display_name}</p>
                      <span className={`text-[9px] px-1.5 py-0.5 rounded uppercase font-bold ${item.item_type === 'adviser' ? 'bg-green-900/40 text-green-400' : 'bg-blue-900/40 text-blue-400'}`}>
                        {item.item_type}
                      </span>
                    </div>
                    <a
                      href={item.item_type === 'adviser' ? fcaIndividualUrl(item.fca_irn || '') : fcaFirmUrl(item.fca_frn || '')}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-brand-beige text-xs hover:text-green-400"
                    >
                      {item.item_type === 'adviser' ? `IRN ${item.fca_irn}` : `FRN ${item.fca_frn}`} &rarr;
                    </a>
                  </div>
                  <div className="col-span-2 text-brand-cream text-xs">{status || <span className="text-brand-beige">Awaiting check</span>}</div>
                  <div className="col-span-3 text-brand-cream text-xs truncate">{detail}</div>
                  <div className="col-span-2 text-xs">
                    <p className="text-brand-beige">{formatChecked(item.last_checked_at)}</p>
                    {unread > 0 && (
                      <Link href="/dashboard/recruitment/alerts" className="text-brand-rose-gold font-semibold hover:underline">
                        {unread} change{unread === 1 ? '' : 's'}
                      </Link>
                    )}
                  </div>
                  <div className="col-span-1 text-right">
                    <button onClick={() => remove(item.id)} disabled={busy === item.id} className="text-brand-beige hover:text-red-400 text-xs">
                      {busy === item.id ? '...' : 'Remove'}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
