'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { formatRate, ratio, type PipelineActivity, type PipelineFunnel, type PipelineLead, type PipelineStage } from '@/lib/heyreach-pipeline'

interface Campaign {
  id: number
  name: string
  status: string
}

interface Lead extends PipelineLead {
  stage: PipelineStage
  stageLabel: string
  prospectiq: { prospectId: string; name: string; company: string | null; campaignId: string; campaignName: string | null; tier: string | null; score: number | null } | null
  companyChangedFrom: string | null
}

interface PipelineData {
  admin?: boolean
  notSetUp?: boolean
  campaigns?: Campaign[]
  campaign?: Campaign | null
  days?: number
  funnel?: PipelineFunnel | null
  leads?: Lead[]
  totalLeads?: number
  truncated?: boolean
  leadsError?: string | null
  activity?: PipelineActivity | null
  activityError?: string | null
  fetchedAt?: string
  problem?: string
}

const PERIODS = [7, 30, 90]

function niceStatus(s: string): string {
  const map: Record<string, string> = { IN_PROGRESS: 'running', ACTIVE: 'running', PAUSED: 'paused', DRAFT: 'draft', FINISHED: 'finished', STOPPED: 'stopped' }
  return map[s] || s.toLowerCase().replace(/_/g, ' ')
}

function when(iso: string | null): string {
  if (!iso) return '–'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '–'
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function StatTile({ label, value, note }: { label: string; value: string | number; note?: string }) {
  return (
    <div className="bg-brand-charcoal-deep rounded-xl p-5 border border-brand-charcoal">
      <p className="text-brand-beige text-xs">{label}</p>
      <p className="text-brand-cream text-3xl font-semibold mt-1">{value}</p>
      {note && <p className="text-brand-beige text-xs mt-1">{note}</p>}
    </div>
  )
}

/** One step of the funnel: a single-hue bar on a shared baseline, value at the tip. */
function FunnelBar({ label, value, whole, note }: { label: string; value: number; whole: number; note?: string }) {
  const share = whole > 0 ? value / whole : 0
  const accessible = `${label}: ${value} of ${whole}${note ? `, ${note}` : ''}`
  return (
    <div className="grid grid-cols-[9rem_1fr] items-center gap-3" title={accessible} aria-label={accessible} role="img">
      <div>
        <p className="text-brand-cream text-sm">{label}</p>
        {note && <p className="text-brand-beige text-[11px]">{note}</p>}
      </div>
      <div className="flex items-center gap-2 min-w-0">
        {value > 0 && (
          <div className="h-[18px] rounded-r bg-brand-rose-gold" style={{ width: `${Math.max(2, share * 100)}%`, maxWidth: 'calc(100% - 3rem)' }} />
        )}
        <span className="text-brand-cream text-sm font-semibold tabular-nums">{value}</span>
      </div>
    </div>
  )
}

export default function PipelineDashboard({ admin }: { admin: boolean }) {
  const [data, setData] = useState<PipelineData | null>(null)
  const [loading, setLoading] = useState(false)
  const [campaignId, setCampaignId] = useState<number | null>(null)
  const [days, setDays] = useState(30)

  const load = useCallback(async (id: number | null, period: number) => {
    setLoading(true)
    try {
      const q = new URLSearchParams({ days: String(period) })
      if (id) q.set('campaign_id', String(id))
      const res = await fetch(`/api/heyreach/pipeline?${q}`, { cache: 'no-store' })
      const json = (await res.json().catch(() => ({ problem: 'ProspectIQ returned something unreadable. Try again.' }))) as PipelineData
      setData(json)
      if (json.campaign && !id) setCampaignId(json.campaign.id)
    } catch {
      setData({ problem: 'Could not reach ProspectIQ. Try again.' })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load(null, 30)
  }, [load])

  const funnel = data?.funnel || null
  const activity = data?.activity || null
  const leads = data?.leads || []
  const active = funnel ? funnel.inCampaign - funnel.removed - funnel.alreadyConnected : 0
  const stopped = funnel
    ? [funnel.removed ? `${funnel.removed} removed or failed` : '', funnel.alreadyConnected ? `${funnel.alreadyConnected} already connected` : '']
        .filter(Boolean)
        .join(', ')
    : ''

  return (
    <div className="p-8 max-w-5xl space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          {admin && <p className="text-brand-rose-gold text-[10px] font-bold tracking-[2px] uppercase mb-1">Admin: all campaigns</p>}
          <h1 className="text-2xl font-display text-brand-cream">LinkedIn pipeline</h1>
          <p className="text-brand-beige text-sm mt-1">
            Live from your LinkedIn campaign: who has been sent a connection request, who accepted, and who replied.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {data?.fetchedAt && <span className="text-brand-beige text-xs">Updated {when(data.fetchedAt)}</span>}
          <button onClick={() => load(campaignId, days)} disabled={loading} className="btn-secondary text-xs px-3 py-1.5">
            {loading ? 'Loading...' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Filters: one row, above everything they change */}
      <div className="flex flex-wrap items-center gap-3">
        {(data?.campaigns?.length || 0) > 1 && (
        <label className="text-brand-beige text-xs flex items-center gap-2">
          Campaign
          <select
            value={campaignId ?? ''}
            disabled={loading || !data?.campaigns?.length}
            onChange={(e) => {
              const id = Number(e.target.value) || null
              setCampaignId(id)
              load(id, days)
            }}
            className="text-sm py-1.5 px-3"
          >
            {(data?.campaigns || []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({niceStatus(c.status)})
              </option>
            ))}
          </select>
        </label>
        )}
        <label className="text-brand-beige text-xs flex items-center gap-2">
          Activity period
          <select
            value={days}
            disabled={loading}
            onChange={(e) => {
              const d = Number(e.target.value)
              setDays(d)
              load(campaignId, d)
            }}
            className="text-sm py-1.5 px-3"
          >
            {PERIODS.map((d) => (
              <option key={d} value={d}>
                Last {d} days
              </option>
            ))}
          </select>
        </label>
      </div>

      {!data && <p className="text-brand-beige text-sm">Loading your pipeline...</p>}
      {data?.notSetUp && (
        <section className="border border-brand-charcoal rounded-lg p-5">
          <h2 className="text-brand-cream font-semibold">Not set up yet</h2>
          <p className="text-brand-beige text-sm mt-1">
            Your LinkedIn pipeline appears here once your LinkedIn campaign is live. Nothing to do on your side.
          </p>
        </section>
      )}
      {data?.problem && <p className="text-red-400 text-sm">{data.problem}</p>}

      {data?.campaign && (
        <>
          {data.leadsError ? (
            <p className="text-red-400 text-sm">Could not load the campaign&apos;s people: {data.leadsError}</p>
          ) : (
            funnel && (
              <>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <StatTile label="Connection requests sent" value={funnel.requestsSent} note={`of ${active} active in the campaign`} />
                  <StatTile label="Accepted" value={funnel.accepted} note={`${formatRate(funnel.acceptanceRate)} of requests sent`} />
                  <StatTile label="Messaged" value={funnel.messaged} note="had at least one message" />
                  <StatTile label="Replied" value={funnel.replied} note={`${formatRate(funnel.replyRate)} of those messaged`} />
                </div>

                <section className="border border-brand-charcoal rounded-lg p-5">
                  <h2 className="text-brand-cream font-semibold">Where everyone is now</h2>
                  <p className="text-brand-beige text-xs mt-1">
                    &ldquo;{data.campaign.name}&rdquo; is {niceStatus(data.campaign.status)}. Requests and messages go out on the campaign&apos;s own schedule.
                  </p>
                  <div className="mt-5 space-y-3">
                    <FunnelBar label="In the campaign" value={funnel.inCampaign} whole={funnel.inCampaign} note={stopped || undefined} />
                    <FunnelBar label="Request sent" value={funnel.requestsSent} whole={funnel.inCampaign} />
                    <FunnelBar label="Accepted" value={funnel.accepted} whole={funnel.inCampaign} note={`${formatRate(funnel.acceptanceRate)} of requests`} />
                    <FunnelBar label="Messaged" value={funnel.messaged} whole={funnel.inCampaign} />
                    <FunnelBar label="Replied" value={funnel.replied} whole={funnel.inCampaign} note={`${formatRate(funnel.replyRate)} of messaged`} />
                  </div>
                  {funnel.requestsSent === 0 && (
                    <p className="text-brand-beige text-xs mt-4">Nothing sent yet. The first connection requests go out at the campaign&apos;s next sending window.</p>
                  )}
                </section>
              </>
            )
          )}

          <section className="border border-brand-charcoal rounded-lg p-5">
            <h2 className="text-brand-cream font-semibold">Activity in the last {data.days} days</h2>
            <p className="text-brand-beige text-xs mt-1">
              Every action taken in this campaign in the period, so it can differ from &ldquo;where everyone is now&rdquo;.
            </p>
            {data.activityError ? (
              <p className="text-red-400 text-sm mt-3">Could not load activity: {data.activityError}</p>
            ) : (
              activity && (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mt-4">
                  <StatTile label="Requests sent" value={activity.connectionsSent} />
                  <StatTile label="Accepted" value={activity.connectionsAccepted} note={`${formatRate(ratio(activity.connectionsAccepted, activity.connectionsSent))} acceptance rate`} />
                  <StatTile label="Messages sent" value={activity.messagesSent} />
                  <StatTile
                    label="Replies"
                    value={activity.replies}
                    note={`${formatRate(ratio(activity.replies, activity.messageThreadsStarted || activity.messagesSent))} reply rate`}
                  />
                  <StatTile label="Conversations started" value={activity.messageThreadsStarted} />
                  <StatTile label="Profile views" value={activity.profileViews} />
                </div>
              )
            )}
          </section>

          {!data.leadsError && (
            <section className="border border-brand-charcoal rounded-lg p-5">
              <h2 className="text-brand-cream font-semibold">People</h2>
              {data.truncated && (
                <p className="text-brand-beige text-xs mt-1">Showing the first {leads.length} of {data.totalLeads}.</p>
              )}
              {leads.length === 0 ? (
                <p className="text-brand-beige text-sm mt-2">No leads in this campaign yet.</p>
              ) : (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-brand-beige text-xs border-b border-brand-charcoal">
                        <th className="py-2 pr-4 font-normal">Name</th>
                        <th className="py-2 pr-4 font-normal">Role</th>
                        <th className="py-2 pr-4 font-normal">Stage</th>
                        <th className="py-2 pr-4 font-normal">Last activity</th>
                        <th className="py-2 font-normal">ProspectIQ</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-brand-charcoal">
                      {leads.map((l, i) => (
                        <tr key={`${l.profileUrl || l.name}-${i}`} className="align-top">
                          <td className="py-3 pr-4">
                            {l.profileUrl ? (
                              <a href={l.profileUrl} target="_blank" rel="noopener noreferrer" className="text-brand-cream hover:text-brand-rose-gold">
                                {l.name}
                              </a>
                            ) : (
                              <span className="text-brand-cream">{l.name}</span>
                            )}
                          </td>
                          <td className="py-3 pr-4 text-brand-beige">
                            {[l.position, l.company].filter(Boolean).join(', ') || '–'}
                            {l.companyChangedFrom && (
                              <p className="text-amber-400 text-[11px] mt-1">
                                ProspectIQ had {l.companyChangedFrom}. Check their messages still fit.
                              </p>
                            )}
                          </td>
                          <td className="py-3 pr-4">
                            <span className={`inline-block border rounded-full px-2 py-0.5 text-xs ${l.stage === 'removed' ? 'border-brand-charcoal text-brand-beige' : 'border-brand-rose-gold/60 text-brand-cream'}`}>
                              {l.stageLabel}
                            </span>
                            {l.stage === 'already_connected' ? (
                              <p className="text-brand-beige text-[11px] mt-1">Already in your network, so the campaign stopped. Message them directly.</p>
                            ) : (
                              l.statusMessage && <p className="text-brand-beige text-[11px] mt-1">{l.statusMessage}</p>
                            )}
                          </td>
                          <td className="py-3 pr-4 text-brand-beige tabular-nums whitespace-nowrap">{when(l.lastActionTime || l.creationTime)}</td>
                          <td className="py-3 text-brand-beige whitespace-nowrap">
                            {l.prospectiq ? (
                              <Link href={admin ? `/dashboard/campaigns/${l.prospectiq.campaignId}/heyreach` : `/dashboard/campaigns/${l.prospectiq.campaignId}`} className="hover:text-brand-rose-gold">
                                {l.prospectiq.tier ? `Tier ${l.prospectiq.tier}` : 'Sent'}
                                {l.prospectiq.score !== null ? ` · ${l.prospectiq.score}` : ''}
                              </Link>
                            ) : (
                              '–'
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="text-brand-beige text-[11px] mt-4">
                Acceptance rate is accepted out of requests sent. Reply rate is replied out of those messaged. The campaign starts with a connection request, so anyone already connected to you is stopped; message them directly instead.
              </p>
            </section>
          )}
        </>
      )}
    </div>
  )
}
