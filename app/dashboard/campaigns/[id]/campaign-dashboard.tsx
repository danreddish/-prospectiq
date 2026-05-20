'use client'

import { useState } from 'react'
import { Campaign, Prospect, OutreachStep, ConversationTurn, ReplyOption } from '@/types'
import { toast } from 'sonner'

interface Props {
  campaign: Campaign
  prospects: Prospect[]
  pendingProspects: Prospect[]
}

export default function CampaignDashboard({ campaign, prospects, pendingProspects }: Props) {
  const [selected, setSelected] = useState<Prospect | null>(prospects[0] || null)
  const [activeTab, setActiveTab] = useState<'outreach' | 'research' | 'scores' | 'reply-coach'>('outreach')
  const [tierFilter, setTierFilter] = useState<'all' | 'A' | 'B' | 'C'>('all')
  const [copiedStep, setCopiedStep] = useState<number | null>(null)
  const [showPending, setShowPending] = useState(false)
  const [pendingSelected, setPendingSelected] = useState<Set<string>>(new Set())
  const [researching, setResearching] = useState(false)
  const [researchProgress, setResearchProgress] = useState({ completed: 0, total: 0 })

  // Reply Coach state
  const [replyInput, setReplyInput] = useState('')
  const [replyLoading, setReplyLoading] = useState(false)
  const [replyResults, setReplyResults] = useState<{ sentiment: string; replies: ReplyOption[] } | null>(null)
  const [conversationHistory, setConversationHistory] = useState<ConversationTurn[]>([])
  const [copiedReply, setCopiedReply] = useState<number | null>(null)

  const filtered = tierFilter === 'all'
    ? prospects
    : prospects.filter((p) => p.tier === tierFilter)

  const tierCounts = {
    A: prospects.filter((p) => p.tier === 'A').length,
    B: prospects.filter((p) => p.tier === 'B').length,
    C: prospects.filter((p) => p.tier === 'C').length,
  }

  function togglePendingSelect(id: string) {
    setPendingSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function handleResearchPending() {
    const toResearch = pendingProspects.filter(p => pendingSelected.has(p.id))
    if (toResearch.length === 0) return toast.error('Select at least one prospect')

    setResearching(true)
    const total = toResearch.length
    let completed = 0
    let failed = 0
    setResearchProgress({ completed: 0, total })

    for (const prospect of toResearch) {
      try {
        const res = await fetch('/api/prospects/research', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            campaign_id: campaign.id,
            prospects: [{
              name: prospect.name,
              role: prospect.role || '',
              company: prospect.company || '',
              location: prospect.location || '',
              linkedin_url: prospect.linkedin_url || '',
            }],
          }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'Research failed')
        completed += data.completed || 0
        failed += data.failed || 0
      } catch {
        failed++
      }
      setResearchProgress({ completed: completed + failed, total })
    }

    setResearching(false)
    if (completed > 0) {
      toast.success(`Researched ${completed} prospects${failed > 0 ? ` (${failed} failed)` : ''}`)
      // Reload the page to show updated data
      window.location.reload()
    } else {
      toast.error('All research requests failed. Check your Anthropic API key and try again.')
    }
  }

  function copyMessage(text: string, stepNum: number) {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedStep(stepNum)
      toast.success('Message copied to clipboard')
      setTimeout(() => setCopiedStep(null), 2000)
    })
  }

  // ── Reply Coach ─────────────────────────────
  async function handleReplyCoach() {
    if (!selected || !replyInput.trim()) return

    setReplyLoading(true)
    setReplyResults(null)

    try {
      const res = await fetch('/api/prospects/reply-coach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prospect_id: selected.id,
          prospect_reply: replyInput.trim(),
        }),
      })

      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to generate replies')

      setReplyResults({ sentiment: data.sentiment, replies: data.replies })

      // Update local conversation history
      setConversationHistory(prev => [
        ...prev,
        { from: 'prospect' as const, message: replyInput.trim(), timestamp: new Date().toISOString(), step: 'reply' }
      ])
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Something went wrong'
      toast.error(message)
    } finally {
      setReplyLoading(false)
    }
  }

  async function handleUseReply(reply: ReplyOption, index: number) {
    if (!selected) return

    // Copy to clipboard
    await navigator.clipboard.writeText(reply.message)
    setCopiedReply(index)
    setTimeout(() => setCopiedReply(null), 2000)

    // Save to conversation history
    try {
      await fetch('/api/prospects/reply-coach', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prospect_id: selected.id,
          message: reply.message,
        }),
      })

      setConversationHistory(prev => [
        ...prev,
        { from: 'user' as const, message: reply.message, timestamp: new Date().toISOString(), step: 'reply' }
      ])

      toast.success('Reply copied and saved to conversation log')
    } catch {
      toast.success('Reply copied to clipboard')
    }

    // Clear for next round
    setReplyInput('')
    setReplyResults(null)
  }

  // Load conversation history when selecting a new prospect
  function handleSelectProspect(prospect: Prospect) {
    setSelected(prospect)
    setActiveTab('outreach')
    setReplyInput('')
    setReplyResults(null)
    // Load conversation history from prospect data
    const existingConversations = ((prospect as unknown as Record<string, unknown>).conversations || []) as ConversationTurn[]
    setConversationHistory(existingConversations)
  }

  // ── CSV Export ─────────────────────────────
  function exportCSV() {
    const headers = [
      'Name', 'Role', 'Company', 'Location', 'Tier', 'Total Score',
      'Wealth Score', 'Timing Score', 'Accessibility Score', 'Complexity Score',
      'Wealth Estimate', 'Est Age', 'Key Trigger', 'LinkedIn', 'Email', 'Phone',
      'Step 1 - Connection Request', 'Step 2 - Welcome Message', 'Step 3 - Value + CTA',
      'Research Notes',
    ]

    const rows = prospects
      .filter((p) => p.status === 'completed')
      .sort((a, b) => b.total_score - a.total_score)
      .map((p) => [
        p.name,
        p.role || '',
        p.company || '',
        p.location || '',
        p.tier || '',
        p.total_score,
        p.scores?.wealth || '',
        p.scores?.timing || '',
        p.scores?.accessibility || '',
        p.scores?.complexity || '',
        p.wealth_estimate || '',
        p.est_age || '',
        p.key_trigger || '',
        p.linkedin_url || '',
        p.email || '',
        p.phone || '',
        p.outreach?.step1?.message || '',
        p.outreach?.step2?.message || '',
        p.outreach?.step3?.message || '',
        p.research_notes || '',
      ])

    const csvContent = [headers, ...rows]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n')

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${campaign.name.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-prospects.csv`
    link.click()
    URL.revokeObjectURL(url)
    toast.success(`Exported ${rows.length} prospects to CSV`)
  }

  // ── PDF Export (opens print-ready page) ────
  function exportPDF() {
    const completed = prospects
      .filter((p) => p.status === 'completed')
      .sort((a, b) => b.total_score - a.total_score)

    const tierColor = (tier: string | null) => {
      if (tier === 'A') return '#c49f8c'
      if (tier === 'B') return '#a18d89'
      return '#5d5d5d'
    }

    const html = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<title>${campaign.name} - ProspectIQ Report</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;font-size:11px;line-height:1.5}
.header{background:#1a1a1a;color:#f5f0ed;padding:24px 32px;display:flex;justify-content:space-between;align-items:center}
.header h1{font-size:18px;font-weight:600}
.header .brand{color:#c49f8c;font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase}
.header .meta{color:#a18d89;font-size:11px;text-align:right}
.summary{display:flex;gap:16px;padding:16px 32px;background:#f5f0ed;border-bottom:1px solid #ddd}
.summary .stat{text-align:center;flex:1}
.summary .stat .num{font-size:20px;font-weight:700;color:#1a1a1a}
.summary .stat .lbl{font-size:9px;color:#666;text-transform:uppercase;letter-spacing:1px;margin-top:2px}
.prospect{page-break-inside:avoid;padding:20px 32px;border-bottom:1px solid #eee}
.prospect-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px}
.prospect-name{font-size:14px;font-weight:700}
.prospect-role{font-size:11px;color:#666;margin-top:1px}
.tier-badge{display:inline-block;padding:2px 10px;border-radius:4px;font-size:10px;font-weight:700;color:#fff}
.scores{display:flex;gap:12px;margin:8px 0}
.score-item{text-align:center}
.score-item .val{font-size:14px;font-weight:700}
.score-item .lbl{font-size:8px;color:#666;text-transform:uppercase;letter-spacing:0.5px}
.research{background:#f9f7f5;border-radius:6px;padding:10px 14px;margin:8px 0;font-size:11px;color:#333}
.outreach{margin-top:10px}
.outreach h4{font-size:10px;font-weight:700;color:#c49f8c;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px}
.step{background:#fafafa;border:1px solid #eee;border-radius:6px;padding:10px 12px;margin-bottom:8px}
.step-title{font-size:9px;font-weight:700;color:#666;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px}
.step-msg{font-size:10px;line-height:1.5;color:#333;white-space:pre-wrap}
.footer{text-align:center;padding:16px;color:#999;font-size:9px;border-top:1px solid #eee;margin-top:20px}
@media print{.prospect{page-break-inside:avoid}body{font-size:10px}}
</style>
</head><body>
<div class="header">
<div><div class="brand">AI Wealth Partners | ProspectIQ</div><h1>${campaign.name}</h1></div>
<div class="meta">${campaign.niche || ''}<br>${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</div>
</div>
<div class="summary">
<div class="stat"><div class="num">${completed.length}</div><div class="lbl">Prospects</div></div>
<div class="stat"><div class="num" style="color:#c49f8c">${tierCounts.A}</div><div class="lbl">Tier A</div></div>
<div class="stat"><div class="num">${tierCounts.B}</div><div class="lbl">Tier B</div></div>
<div class="stat"><div class="num">${tierCounts.C}</div><div class="lbl">Tier C</div></div>
</div>
${completed.map((p, i) => `
<div class="prospect">
<div class="prospect-header">
<div>
<div class="prospect-name">${i + 1}. ${p.name}</div>
<div class="prospect-role">${p.role || 'Director'} at ${p.company || 'Unknown'}${p.location ? ' — ' + p.location : ''}</div>
</div>
<div style="text-align:right">
<span class="tier-badge" style="background:${tierColor(p.tier)}">TIER ${p.tier || 'C'}</span>
<div style="font-size:16px;font-weight:700;margin-top:4px">${p.total_score}/40</div>
</div>
</div>
<div class="scores">
<div class="score-item"><div class="val">${p.scores?.wealth || 0}</div><div class="lbl">Wealth</div></div>
<div class="score-item"><div class="val">${p.scores?.timing || 0}</div><div class="lbl">Timing</div></div>
<div class="score-item"><div class="val">${p.scores?.accessibility || 0}</div><div class="lbl">Access</div></div>
<div class="score-item"><div class="val">${p.scores?.complexity || 0}</div><div class="lbl">Complex</div></div>
<div class="score-item" style="margin-left:12px;padding-left:12px;border-left:1px solid #ddd"><div class="val" style="font-size:11px">${p.wealth_estimate || 'N/A'}</div><div class="lbl">Est. Wealth</div></div>
<div class="score-item"><div class="val" style="font-size:11px">${p.est_age || 'N/A'}</div><div class="lbl">Est. Age</div></div>
</div>
${p.key_trigger ? `<div style="font-size:11px;color:#c49f8c;font-weight:600;margin:6px 0">Key trigger: ${p.key_trigger}</div>` : ''}
${p.research_notes ? `<div class="research">${p.research_notes}</div>` : ''}
${p.linkedin_url ? `<div style="font-size:10px;margin:4px 0"><a href="${p.linkedin_url}" style="color:#0A66C2">${p.linkedin_url.includes('/in/') ? 'LinkedIn Profile' : 'Search LinkedIn'}</a></div>` : ''}
${p.email ? `<div style="font-size:10px;margin:2px 0"><strong>Email:</strong> <a href="mailto:${p.email}" style="color:#333">${p.email}</a></div>` : ''}
${p.phone ? `<div style="font-size:10px;margin:2px 0"><strong>Phone:</strong> ${p.phone}</div>` : ''}
<div class="outreach">
<h4>Outreach Sequence</h4>
${p.outreach?.step1 ? `<div class="step"><div class="step-title">Step 1: Connection Request (${p.outreach.step1.timing || 'Day 0'})</div><div class="step-msg">${p.outreach.step1.message}</div></div>` : ''}
${p.outreach?.step2 ? `<div class="step"><div class="step-title">Step 2: Welcome Message (${p.outreach.step2.timing || 'Day 1-2'})</div><div class="step-msg">${p.outreach.step2.message}</div></div>` : ''}
${p.outreach?.step3 ? `<div class="step"><div class="step-title">Step 3: Value + Soft CTA (${p.outreach.step3.timing || 'Day 7-10'})</div><div class="step-msg">${p.outreach.step3.message}</div></div>` : ''}
</div>
</div>
`).join('')}
<div class="footer">Generated by ProspectIQ | AI Wealth Partners Ltd | ${new Date().toLocaleDateString('en-GB')} | Confidential</div>
</body></html>`

    const blob = new Blob([html], { type: 'text/html' })
    const url = URL.createObjectURL(blob)
    const win = window.open(url, '_blank')
    if (win) {
      win.onload = () => {
        setTimeout(() => win.print(), 500)
      }
    }
    toast.success('PDF report opened — use Print > Save as PDF')
  }

  if (prospects.length === 0) {
    return (
      <div className="text-center py-20">
        <h2 className="text-brand-cream text-xl font-display mb-2">{campaign.name}</h2>
        <p className="text-brand-beige mb-6">No completed prospects yet. Add prospects and run research.</p>
        <a href="/dashboard/campaigns/new" className="btn-primary text-sm">
          Add Prospects
        </a>
      </div>
    )
  }

  return (
    <div className="flex h-[calc(100vh-4rem)] -m-8">
      {/* Sidebar - Prospect List */}
      <div className="w-80 border-r border-brand-charcoal bg-brand-charcoal-deeper overflow-y-auto flex-shrink-0">
        {/* Campaign header */}
        <div className="p-5 border-b border-brand-charcoal">
          <p className="text-brand-rose-gold text-[10px] font-bold tracking-[2px] uppercase">
            AI Wealth Partners
          </p>
          <h2 className="text-brand-cream text-lg font-display mt-0.5">{campaign.name}</h2>
          <p className="text-brand-beige text-xs mt-1">
            {campaign.niche || 'No niche set'} &middot; {prospects.length} prospects
          </p>
          <div className="flex gap-2 mt-3">
            <a
              href={`/dashboard/campaigns/new?campaign=${campaign.id}`}
              className="text-[10px] px-2.5 py-1.5 rounded border border-brand-rose-gold/50 text-brand-rose-gold hover:bg-brand-rose-gold/10 transition-colors"
            >
              + Find More
            </a>
            <button
              onClick={exportCSV}
              className="text-[10px] px-2.5 py-1.5 rounded border border-brand-charcoal text-brand-beige hover:border-brand-rose-gold hover:text-brand-cream transition-colors"
            >
              Export CSV
            </button>
            <button
              onClick={exportPDF}
              className="text-[10px] px-2.5 py-1.5 rounded border border-brand-charcoal text-brand-beige hover:border-brand-rose-gold hover:text-brand-cream transition-colors"
            >
              Export PDF
            </button>
          </div>
        </div>

        {/* Tier filter */}
        <div className="p-3 border-b border-brand-charcoal flex gap-2">
          {(['all', 'A', 'B', 'C'] as const).map((tier) => (
            <button
              key={tier}
              onClick={() => setTierFilter(tier)}
              className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                tierFilter === tier
                  ? 'bg-brand-rose-gold text-brand-dark'
                  : 'text-brand-beige border border-brand-charcoal hover:border-brand-rose-gold'
              }`}
            >
              {tier === 'all' ? 'All' : tier}
              {tier !== 'all' && (
                <span className="ml-1 opacity-70">({tierCounts[tier]})</span>
              )}
            </button>
          ))}
        </div>

        {/* Prospect cards */}
        <div className="p-2">
          {filtered.map((prospect) => (
            <button
              key={prospect.id}
              onClick={() => handleSelectProspect(prospect)}
              className={`w-full text-left p-3 rounded-lg mb-1 transition-colors ${
                selected?.id === prospect.id
                  ? 'bg-brand-rose-gold/10 border-l-3 border-brand-rose-gold'
                  : 'hover:bg-brand-charcoal-deep/50'
              }`}
              style={{
                borderLeft: selected?.id === prospect.id ? '3px solid #c49f8c' : '3px solid transparent'
              }}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-brand-cream text-sm font-semibold truncate">{prospect.name}</p>
                  <p className="text-brand-beige text-xs truncate mt-0.5">
                    {prospect.role}{prospect.company ? `, ${prospect.company}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className="text-brand-cream text-xs font-semibold">
                    {prospect.total_score}/40
                  </span>
                  <TierBadge tier={prospect.tier!} />
                </div>
              </div>
              {prospect.key_trigger && (
                <p className="text-brand-beige text-[11px] mt-1.5 line-clamp-1">
                  {prospect.key_trigger}
                </p>
              )}
              {/* Contact indicators */}
              <div className="flex items-center gap-2 mt-1.5">
                {prospect.linkedin_url && (
                  <span className={`text-[9px] px-1.5 py-0.5 rounded ${prospect.linkedin_url.includes('/in/') ? 'bg-[#0A66C2]/20 text-[#0A66C2]' : 'bg-brand-charcoal text-brand-beige'}`}>
                    {prospect.linkedin_url.includes('/in/') ? 'LI' : 'LI?'}
                  </span>
                )}
                {prospect.email && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-brand-rose-gold/20 text-brand-rose-gold">
                    Email
                  </span>
                )}
                {prospect.phone && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-green-900/30 text-green-400">
                    Phone
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>

        {/* Pending prospects (found but not yet researched) */}
        {pendingProspects.length > 0 && (
          <div className="border-t border-brand-charcoal">
            <button
              onClick={() => setShowPending(!showPending)}
              className="w-full p-3 flex items-center justify-between text-left hover:bg-brand-charcoal-deep/50 transition-colors"
            >
              <div>
                <p className="text-brand-rose-gold text-xs font-semibold">
                  {pendingProspects.length} prospects awaiting research
                </p>
                <p className="text-brand-beige text-[10px] mt-0.5">Click to select and research</p>
              </div>
              <svg className={`w-4 h-4 text-brand-beige transition-transform ${showPending ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {showPending && (
              <div className="p-2">
                <div className="flex items-center gap-2 px-2 mb-2">
                  <button
                    onClick={() => setPendingSelected(new Set(pendingProspects.map(p => p.id)))}
                    className="text-[10px] text-brand-beige hover:text-brand-cream"
                  >
                    Select all
                  </button>
                  <span className="text-brand-charcoal">|</span>
                  <button
                    onClick={() => setPendingSelected(new Set())}
                    className="text-[10px] text-brand-beige hover:text-brand-cream"
                  >
                    Deselect all
                  </button>
                  <span className="text-brand-beige text-[10px] ml-auto">{pendingSelected.size} selected</span>
                </div>

                {pendingProspects.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => togglePendingSelect(p.id)}
                    className={`w-full text-left p-2.5 rounded-lg mb-1 transition-colors flex items-start gap-2 ${
                      pendingSelected.has(p.id) ? 'bg-brand-rose-gold/10' : 'hover:bg-brand-charcoal-deep/50'
                    }`}
                  >
                    <div className={`w-4 h-4 rounded border mt-0.5 flex-shrink-0 flex items-center justify-center ${
                      pendingSelected.has(p.id) ? 'bg-brand-rose-gold border-brand-rose-gold' : 'border-brand-charcoal'
                    }`}>
                      {pendingSelected.has(p.id) && (
                        <svg className="w-3 h-3 text-brand-dark" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-brand-cream text-xs font-semibold truncate">{p.name}</p>
                      <p className="text-brand-beige text-[10px] truncate">
                        {p.role}{p.company ? ` at ${p.company}` : ''}
                      </p>
                    </div>
                  </button>
                ))}

                {pendingSelected.size > 0 && (
                  <button
                    onClick={handleResearchPending}
                    disabled={researching}
                    className="w-full mt-2 btn-primary text-xs py-2"
                  >
                    {researching
                      ? `Researching ${researchProgress.completed}/${researchProgress.total}...`
                      : `Research ${pendingSelected.size} Prospect${pendingSelected.size > 1 ? 's' : ''}`
                    }
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Main Panel */}
      {selected && (
        <div className="flex-1 overflow-y-auto p-6">
          {/* Prospect header */}
          <div className="mb-6">
            <div className="flex items-start justify-between">
              <div>
                <h1 className="text-brand-cream text-2xl font-display">{selected.name}</h1>
                <p className="text-brand-beige text-sm mt-1">
                  {selected.role}{selected.company ? ` at ${selected.company}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-brand-cream text-lg font-display">
                  {selected.total_score}/40
                </span>
                <TierBadge tier={selected.tier!} />
              </div>
            </div>

            {/* Stats row */}
            <div className="grid grid-cols-4 gap-3 mt-4">
              {[
                { label: 'Location', value: selected.location || 'Unknown' },
                { label: 'Est. Age', value: selected.est_age || 'Unknown' },
                { label: 'Wealth Est.', value: selected.wealth_estimate || 'Unknown' },
                { label: 'Sr. Level', value: selected.yrs_at_sr_level ? `${selected.yrs_at_sr_level} years` : 'Unknown' },
              ].map((stat) => (
                <div key={stat.label} className="bg-brand-charcoal-deep rounded-lg p-3 border border-brand-charcoal">
                  <p className="text-brand-beige text-[10px] uppercase tracking-wide">{stat.label}</p>
                  <p className="text-brand-cream text-sm font-semibold mt-0.5">{stat.value}</p>
                </div>
              ))}
            </div>

            {/* Companies House verified data (UK HNW source only) */}
            {selected.accounts_category && (() => {
              const cat = selected.accounts_category.toLowerCase()
              const isWarning = cat.includes('dormant') || cat.includes('micro')
              const label = cat.includes('dormant') ? 'Dormant'
                : cat.includes('micro') ? 'Micro-entity'
                : cat.includes('small') ? 'Small'
                : cat.includes('abridged') ? 'Abridged'
                : cat.includes('medium') ? 'Medium'
                : cat.includes('full') ? 'Full'
                : cat.includes('group') ? 'Group'
                : cat.replace(/-/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())

              const description = cat.includes('dormant')
                ? 'No trading activity in latest accounts'
                : cat.includes('micro')
                ? 'Turnover under £632k, balance sheet under £316k'
                : cat.includes('small')
                ? 'Turnover under £10.2M, balance sheet under £5.1M'
                : cat.includes('medium')
                ? 'Turnover under £36M, balance sheet under £18M'
                : cat.includes('full') || cat.includes('group')
                ? 'Full statutory accounts filed'
                : null

              const filed = selected.accounts_last_filed
                ? new Date(selected.accounts_last_filed).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
                : null

              return (
                <div className={`rounded-lg p-3 mt-3 border ${isWarning ? 'bg-amber-950/20 border-amber-700/40' : 'bg-brand-charcoal-deep border-brand-charcoal'}`}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-brand-beige text-[10px] uppercase tracking-wide">Companies House Verified</p>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${isWarning ? 'bg-amber-700/40 text-amber-200' : 'bg-brand-charcoal text-brand-cream'}`}>
                          {label}
                        </span>
                      </div>
                      {description && (
                        <p className="text-brand-cream text-xs mt-1">{description}</p>
                      )}
                    </div>
                    {filed && (
                      <div className="text-right flex-shrink-0">
                        <p className="text-brand-beige text-[10px] uppercase tracking-wide">Last filed</p>
                        <p className="text-brand-cream text-xs font-semibold mt-0.5">{filed}</p>
                      </div>
                    )}
                  </div>
                  {isWarning && (
                    <p className="text-amber-200/80 text-[10px] mt-2">
                      Wealth score has been capped based on filed accounts. Cross-check on the Companies House website if needed.
                    </p>
                  )}
                </div>
              )
            })()}

            {/* Key trigger */}
            {selected.key_trigger && (
              <div className="bg-brand-charcoal-deep rounded-lg p-4 mt-4 border-l-4 border-brand-rose-gold">
                <p className="text-brand-rose-gold text-[10px] uppercase tracking-wider font-bold mb-1">Key Trigger</p>
                <p className="text-brand-cream text-sm">{selected.key_trigger}</p>
              </div>
            )}
          </div>

          {/* Tabs */}
          <div className="flex gap-1 mb-6">
            {(['outreach', 'reply-coach', 'research', 'scores'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-5 py-2.5 rounded-t-lg text-sm font-semibold transition-colors ${
                  activeTab === tab
                    ? tab === 'reply-coach' ? 'bg-green-600 text-white' : 'bg-brand-rose-gold text-brand-dark'
                    : 'text-brand-beige hover:text-brand-cream'
                }`}
              >
                {tab === 'outreach' ? '3-Step Outreach' : tab === 'reply-coach' ? 'Reply Coach' : tab === 'research' ? 'Research Notes' : 'Score Breakdown'}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="bg-brand-charcoal-deeper rounded-b-xl rounded-tr-xl border border-brand-charcoal p-6">
            {activeTab === 'outreach' && (
              <div>
                <h3 className="text-brand-cream text-lg font-display mb-1">
                  LINK Method&trade; Outreach Sequence
                </h3>
                <p className="text-brand-beige text-sm mb-6">
                  Personalised 3-step sequence for {selected.name}. Copy each message and adjust as needed.
                </p>

                {[selected.outreach?.step1, selected.outreach?.step2, selected.outreach?.step3]
                  .filter(Boolean)
                  .map((step, i) => (
                    <OutreachStepCard
                      key={i}
                      step={step!}
                      stepNumber={i + 1}
                      copied={copiedStep === i + 1}
                      onCopy={() => copyMessage(step!.message, i + 1)}
                    />
                  ))}
              </div>
            )}

            {activeTab === 'reply-coach' && (
              <div>
                <h3 className="text-brand-cream text-lg font-display mb-1">
                  Reply Coach
                </h3>
                <p className="text-brand-beige text-sm mb-6">
                  Paste {selected.name}&apos;s reply below. The AI will generate suggested responses using everything it knows about this prospect.
                </p>

                {/* Conversation history */}
                {conversationHistory.length > 0 && (
                  <div className="mb-6">
                    <p className="text-brand-rose-gold text-[10px] uppercase tracking-wider font-bold mb-3">
                      Conversation History ({conversationHistory.length} messages)
                    </p>
                    <div className="space-y-2 max-h-48 overflow-y-auto">
                      {conversationHistory.map((turn, i) => (
                        <div
                          key={i}
                          className={`rounded-lg p-3 text-sm ${
                            turn.from === 'user'
                              ? 'bg-brand-rose-gold/10 border border-brand-rose-gold/30 ml-8'
                              : 'bg-brand-charcoal-deep border border-brand-charcoal mr-8'
                          }`}
                        >
                          <p className={`text-[10px] font-bold uppercase tracking-wide mb-1 ${
                            turn.from === 'user' ? 'text-brand-rose-gold' : 'text-green-400'
                          }`}>
                            {turn.from === 'user' ? 'You' : selected.name}
                          </p>
                          <p className="text-brand-cream text-sm leading-relaxed">{turn.message}</p>
                          <p className="text-brand-charcoal text-[10px] mt-1">
                            {new Date(turn.timestamp).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Input area */}
                <div className="mb-6">
                  <label className="block text-brand-beige text-xs uppercase tracking-wide font-bold mb-2">
                    Paste their LinkedIn reply
                  </label>
                  <textarea
                    value={replyInput}
                    onChange={(e) => setReplyInput(e.target.value)}
                    placeholder={`e.g. "Thanks for connecting! What exactly do you help with?"

Or: "Not really looking for anything right now but appreciate the message."

Or: "Interesting, tell me more about how you work with people like me."`}
                    className="w-full h-32 rounded-lg bg-brand-charcoal-deep border border-brand-charcoal text-brand-cream text-sm p-4 placeholder:text-brand-charcoal focus:border-brand-rose-gold focus:outline-none resize-none"
                  />
                  <div className="flex items-center justify-between mt-3">
                    <p className="text-brand-charcoal text-xs">
                      {replyInput.length > 0 ? `${replyInput.length} characters` : 'Paste their message above'}
                    </p>
                    <button
                      onClick={handleReplyCoach}
                      disabled={replyLoading || !replyInput.trim()}
                      className={`px-6 py-2.5 rounded-lg text-sm font-semibold transition-all ${
                        replyLoading || !replyInput.trim()
                          ? 'bg-brand-charcoal text-brand-charcoal cursor-not-allowed'
                          : 'bg-green-600 text-white hover:bg-green-500'
                      }`}
                    >
                      {replyLoading ? (
                        <span className="flex items-center gap-2">
                          <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                          Generating replies...
                        </span>
                      ) : 'Generate Reply Options'}
                    </button>
                  </div>
                </div>

                {/* Results */}
                {replyResults && (
                  <div>
                    {/* Sentiment analysis */}
                    <div className="bg-brand-charcoal-deep rounded-lg p-4 mb-6 border-l-4 border-green-500">
                      <p className="text-green-400 text-[10px] uppercase tracking-wider font-bold mb-1">Prospect Sentiment</p>
                      <p className="text-brand-cream text-sm">{replyResults.sentiment}</p>
                    </div>

                    {/* Reply options */}
                    <div className="space-y-4">
                      {replyResults.replies.map((reply, i) => (
                        <div
                          key={i}
                          className={`rounded-xl border p-5 ${
                            reply.intent === 'progress'
                              ? 'border-green-600/40 bg-green-900/10'
                              : 'border-brand-rose-gold/40 bg-brand-rose-gold/5'
                          }`}
                        >
                          <div className="flex items-center justify-between mb-3">
                            <div className="flex items-center gap-3">
                              <span className={`px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide ${
                                reply.intent === 'progress'
                                  ? 'bg-green-600/20 text-green-400'
                                  : 'bg-brand-rose-gold/20 text-brand-rose-gold'
                              }`}>
                                {reply.label}
                              </span>
                              <span className="text-brand-charcoal text-xs">{reply.chars}/600 chars</span>
                            </div>
                            <button
                              onClick={() => handleUseReply(reply, i)}
                              className={`px-4 py-2 rounded-lg text-xs font-semibold transition-all ${
                                copiedReply === i
                                  ? 'bg-green-600 text-white'
                                  : reply.intent === 'progress'
                                    ? 'bg-green-600 text-white hover:bg-green-500'
                                    : 'bg-brand-rose-gold text-brand-dark hover:bg-brand-rose-gold-light'
                              }`}
                            >
                              {copiedReply === i ? 'Copied & Saved!' : 'Copy & Use'}
                            </button>
                          </div>

                          <div className="bg-brand-charcoal-deeper rounded-lg p-4 font-mono text-sm text-brand-cream leading-relaxed whitespace-pre-wrap border border-brand-charcoal">
                            {reply.message}
                          </div>

                          <div className="mt-3 bg-brand-charcoal-dark rounded-md p-3" style={{ borderLeft: reply.intent === 'progress' ? '3px solid #16a34a' : '3px solid #c49f8c' }}>
                            <p className="text-brand-beige text-[10px] uppercase tracking-wide">Why this works</p>
                            <p className={`text-xs mt-1 ${reply.intent === 'progress' ? 'text-green-400' : 'text-brand-rose-gold-light'}`}>
                              {reply.reasoning}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Next round prompt */}
                    <div className="mt-6 p-4 rounded-lg border border-dashed border-brand-charcoal text-center">
                      <p className="text-brand-beige text-sm">
                        Once they reply again, paste their next message above to continue the conversation.
                      </p>
                      <p className="text-brand-charcoal text-xs mt-1">
                        The AI remembers the full thread and gets smarter with each exchange.
                      </p>
                    </div>
                  </div>
                )}

                {/* Empty state - no conversation yet */}
                {!replyResults && conversationHistory.length === 0 && !replyInput && (
                  <div className="text-center py-8">
                    <div className="w-16 h-16 rounded-full bg-green-900/20 flex items-center justify-center mx-auto mb-4">
                      <span className="text-green-400 text-2xl">&#8617;</span>
                    </div>
                    <h4 className="text-brand-cream text-sm font-semibold mb-2">Ready when they reply</h4>
                    <p className="text-brand-beige text-xs max-w-md mx-auto">
                      Send your LINK Method outreach first. When {selected.name} responds, paste their reply here. 
                      The AI uses their research profile, wealth signals, and your service offering to craft the perfect response.
                    </p>
                  </div>
                )}
              </div>
            )}

            {activeTab === 'research' && (
              <div>
                <h3 className="text-brand-cream text-lg font-display mb-4">Research Intelligence</h3>
                <div className="bg-brand-charcoal-deep rounded-lg p-5 border border-brand-charcoal">
                  <p className="text-brand-cream text-sm leading-relaxed">{selected.research_notes}</p>
                </div>

                {/* Contact Methods */}
                <div className="mt-6 bg-brand-charcoal-deep rounded-lg p-5 border border-brand-charcoal">
                  <h4 className="text-brand-rose-gold text-xs uppercase tracking-wider font-bold mb-4">
                    Contact Methods
                  </h4>
                  <div className="space-y-3">
                    {/* LinkedIn */}
                    {selected.linkedin_url && (
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-lg bg-[#0A66C2]/10 flex items-center justify-center flex-shrink-0">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="#0A66C2"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
                          </div>
                          <div>
                            <p className="text-brand-cream text-sm font-semibold">LinkedIn</p>
                            <p className="text-brand-beige text-xs">
                              {selected.linkedin_url.includes('/in/') ? 'Verified profile' : 'Search link'}
                            </p>
                          </div>
                        </div>
                        <a
                          href={selected.linkedin_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[#0A66C2] text-xs font-semibold hover:underline"
                        >
                          {selected.linkedin_url.includes('/in/') ? 'Open Profile' : 'Search'} &rarr;
                        </a>
                      </div>
                    )}

                    {/* Email */}
                    {selected.email && (
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-lg bg-brand-rose-gold/10 flex items-center justify-center flex-shrink-0">
                            <span className="text-brand-rose-gold text-xs">@</span>
                          </div>
                          <div>
                            <p className="text-brand-cream text-sm font-semibold">Email</p>
                            <p className="text-brand-beige text-xs">{selected.email}</p>
                          </div>
                        </div>
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(selected.email || '')
                            toast.success('Email copied')
                          }}
                          className="text-brand-rose-gold text-xs font-semibold hover:underline"
                        >
                          Copy
                        </button>
                      </div>
                    )}

                    {/* Phone */}
                    {selected.phone && (
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-lg bg-green-900/20 flex items-center justify-center flex-shrink-0">
                            <span className="text-green-400 text-xs">T</span>
                          </div>
                          <div>
                            <p className="text-brand-cream text-sm font-semibold">Phone</p>
                            <p className="text-brand-beige text-xs">{selected.phone}</p>
                          </div>
                        </div>
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(selected.phone || '')
                            toast.success('Phone number copied')
                          }}
                          className="text-green-400 text-xs font-semibold hover:underline"
                        >
                          Copy
                        </button>
                      </div>
                    )}

                    {/* Headline */}
                    {selected.headline && (
                      <div className="mt-2 pt-3 border-t border-brand-charcoal">
                        <p className="text-brand-beige text-xs italic">{selected.headline}</p>
                      </div>
                    )}

                    {/* No contact methods */}
                    {!selected.linkedin_url && !selected.email && !selected.phone && (
                      <p className="text-brand-charcoal text-xs">No contact methods found. Try searching for this person on LinkedIn manually.</p>
                    )}
                  </div>
                </div>

                <div className="mt-6">
                  <h4 className="text-brand-rose-gold text-xs uppercase tracking-wider font-bold mb-3">
                    Outreach Angles
                  </h4>
                  <div className="space-y-3">
                    {[
                      { angle: 'Primary', hook: selected.outreach?.step1?.personalization },
                      { angle: 'Secondary', hook: selected.outreach?.step2?.personalization },
                      { angle: 'Proof', hook: selected.outreach?.step3?.personalization },
                    ].filter(a => a.hook).map((item, i) => (
                      <div key={i} className="bg-brand-charcoal-deep rounded-lg p-3 border border-brand-charcoal flex gap-3">
                        <span className="bg-brand-charcoal text-brand-rose-gold px-2.5 py-0.5 rounded text-[10px] font-bold uppercase flex-shrink-0 h-fit">
                          {item.angle}
                        </span>
                        <p className="text-brand-cream text-sm">{item.hook}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'scores' && (
              <div>
                <h3 className="text-brand-cream text-lg font-display mb-6">Score Breakdown</h3>
                <div className="grid grid-cols-2 gap-6">
                  <div className="space-y-4">
                    {Object.entries(selected.scores || {}).map(([key, value]) => (
                      <ScoreBar
                        key={key}
                        label={key.charAt(0).toUpperCase() + key.slice(1)}
                        value={value as number}
                        color={
                          key === 'wealth' ? '#c49f8c' :
                          key === 'timing' ? '#22c55e' :
                          key === 'accessibility' ? '#a855f7' :
                          '#3b82f6'
                        }
                      />
                    ))}
                  </div>
                  <div className="bg-brand-charcoal-deep rounded-xl p-6 border border-brand-charcoal text-center">
                    <p className="text-brand-beige text-xs uppercase tracking-wide mb-2">Total Score</p>
                    <p className="text-brand-cream text-5xl font-display">{selected.total_score}</p>
                    <p className="text-brand-beige text-sm mt-1">out of 40</p>
                    <div className="mt-4">
                      <TierBadge tier={selected.tier!} />
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/* ── Sub-components ─────────────────────────── */

function TierBadge({ tier }: { tier: string }) {
  const styles = {
    A: 'bg-gradient-to-r from-brand-rose-gold to-brand-rose-gold-light text-brand-dark',
    B: 'bg-gradient-to-r from-brand-charcoal to-brand-beige text-white',
    C: 'bg-gradient-to-r from-brand-charcoal-dark to-brand-charcoal text-white',
  }
  return (
    <span className={`px-2.5 py-0.5 rounded text-[10px] font-bold tracking-wide ${styles[tier as keyof typeof styles] || styles.C}`}>
      TIER {tier}
    </span>
  )
}

function ScoreBar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div>
      <div className="flex justify-between mb-1">
        <span className="text-brand-beige text-xs uppercase tracking-wide">{label}</span>
        <span className="text-xs font-semibold" style={{ color }}>{value}/10</span>
      </div>
      <div className="h-1.5 bg-brand-charcoal-dark rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{ width: `${(value / 10) * 100}%`, background: color }}
        />
      </div>
    </div>
  )
}

function OutreachStepCard({
  step,
  stepNumber,
  copied,
  onCopy,
}: {
  step: OutreachStep
  stepNumber: number
  copied: boolean
  onCopy: () => void
}) {
  return (
    <div className="mb-6 last:mb-0">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <span className="bg-brand-rose-gold text-brand-dark w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold">
            {stepNumber}
          </span>
          <div>
            <p className="text-brand-cream text-sm font-semibold">{step.title}</p>
            <p className="text-brand-beige text-xs">{step.timing}</p>
          </div>
        </div>
        <span className={`text-xs ${step.chars > step.charLimit ? 'text-red-400' : 'text-brand-beige'}`}>
          {step.chars}/{step.charLimit} chars
        </span>
      </div>

      <div className="bg-brand-charcoal-deep rounded-lg p-4 font-mono text-sm text-brand-cream leading-relaxed whitespace-pre-wrap max-h-72 overflow-y-auto border border-brand-charcoal">
        {step.message}
      </div>

      <div className="flex items-start justify-between mt-3 gap-4">
        <div className="bg-brand-charcoal-dark rounded-md p-3 border-l-3 border-brand-rose-gold flex-1" style={{ borderLeft: '3px solid #c49f8c' }}>
          <p className="text-brand-beige text-[10px] uppercase tracking-wide">Personalisation Hook</p>
          <p className="text-brand-rose-gold-light text-xs mt-1">{step.personalization}</p>
        </div>
        <button
          onClick={onCopy}
          className={`px-4 py-2 rounded-lg text-xs font-semibold transition-all flex-shrink-0 ${
            copied
              ? 'bg-green-600 text-white'
              : 'bg-brand-charcoal text-brand-cream hover:bg-brand-rose-gold hover:text-brand-dark'
          }`}
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
    </div>
  )
}
