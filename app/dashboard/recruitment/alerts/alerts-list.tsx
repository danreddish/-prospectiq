'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { fcaIndividualUrl, fcaFirmUrl } from '@/lib/recruitment/links'

export interface AlertRow {
  id: string
  alert_type: string
  title: string
  detail: Record<string, unknown> | null
  created_at: string
  read_at: string | null
  watchlist_item_id: string
}

const TYPE_LABELS: Record<string, string> = {
  adviser_status_changed: 'Status change',
  adviser_moved_firm: 'Moved firm',
  adviser_left_firm: 'Left firm',
  adviser_new_function: 'New function',
  firm_status_changed: 'Firm status',
  firm_headcount_drop: 'Headcount down',
  firm_ar_count_drop: 'ARs down',
  firm_requirements_added: 'New requirement',
}

export default function AlertsList({ initialAlerts }: { initialAlerts: AlertRow[] }) {
  const router = useRouter()
  const [alerts, setAlerts] = useState(initialAlerts)
  const [busy, setBusy] = useState(false)
  const unread = alerts.filter((a) => !a.read_at).length

  async function markRead(body: { ids?: string[]; all?: boolean }) {
    setBusy(true)
    try {
      const res = await fetch('/api/recruitment/alerts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not update')
      const now = new Date().toISOString()
      setAlerts((prev) => prev.map((a) => (body.all || body.ids?.includes(a.id)) && !a.read_at ? { ...a, read_at: now } : a))
      router.refresh() // updates the nav badge
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <p className="text-brand-rose-gold text-[10px] font-bold tracking-[2px] uppercase mb-1">Recruitment</p>
          <h1 className="text-2xl font-display text-brand-cream">Alerts</h1>
          <p className="text-brand-beige text-sm mt-1">
            Register changes on advisers and firms you watch. {unread > 0 ? `${unread} unread.` : 'All caught up.'}
          </p>
        </div>
        <div className="flex gap-3">
          <Link href="/dashboard/recruitment/watchlist" className="btn-secondary text-sm">Watchlist</Link>
          <button onClick={() => markRead({ all: true })} disabled={busy || unread === 0} className="btn-primary text-sm">
            Mark all read
          </button>
        </div>
      </div>

      <div className="bg-brand-charcoal-deep rounded-xl border border-brand-charcoal overflow-hidden">
        {alerts.length === 0 ? (
          <div className="p-12 text-center text-brand-beige text-sm">
            No alerts yet. Watched advisers and firms are checked in rotation, a batch every hour. The first check sets a baseline, so alerts start from the second.
          </div>
        ) : (
          <div className="divide-y divide-brand-charcoal">
            {alerts.map((a) => {
              const d = a.detail || {}
              const irn = typeof d.fca_irn === 'string' ? d.fca_irn : null
              const frn = typeof d.fca_frn === 'string' ? d.fca_frn : null
              const campaignId = typeof d.campaign_id === 'string' ? d.campaign_id : null
              const prospectId = typeof d.prospect_id === 'string' ? d.prospect_id : null
              const isUnread = !a.read_at
              return (
                <div key={a.id} className={`p-5 flex items-start gap-4 ${isUnread ? 'bg-brand-rose-gold/5' : ''}`}>
                  <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${isUnread ? 'bg-brand-rose-gold' : 'bg-transparent'}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`text-[9px] px-1.5 py-0.5 rounded uppercase font-bold ${a.alert_type.startsWith('adviser') ? 'bg-green-900/40 text-green-400' : 'bg-blue-900/40 text-blue-400'}`}>
                        {TYPE_LABELS[a.alert_type] || a.alert_type}
                      </span>
                      <span className="text-brand-beige text-xs">
                        {new Date(a.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    <p className={`text-sm mt-1 ${isUnread ? 'text-brand-cream font-semibold' : 'text-brand-cream'}`}>{a.title}</p>
                    <div className="flex gap-4 mt-2 text-xs">
                      {campaignId && prospectId && d.item_type === 'adviser' && (
                        <Link href={`/dashboard/recruitment/campaigns/${campaignId}?prospect=${prospectId}`} className="text-brand-rose-gold hover:underline">
                          Open adviser &rarr;
                        </Link>
                      )}
                      {irn && (
                        <a href={fcaIndividualUrl(irn)} target="_blank" rel="noopener noreferrer" className="text-green-400 hover:underline">
                          FCA Register (IRN {irn}) &rarr;
                        </a>
                      )}
                      {!irn && frn && (
                        <a href={fcaFirmUrl(frn)} target="_blank" rel="noopener noreferrer" className="text-green-400 hover:underline">
                          FCA Register (FRN {frn}) &rarr;
                        </a>
                      )}
                    </div>
                  </div>
                  {isUnread && (
                    <button onClick={() => markRead({ ids: [a.id] })} disabled={busy} className="text-brand-beige hover:text-brand-cream text-xs whitespace-nowrap">
                      Mark read
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
