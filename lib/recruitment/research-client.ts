// Browser-side batching for adviser research. One adviser per request,
// sequential, the same pattern as the client research flow. Firm signals
// are fetched once per FRN and passed into each research call so a batch at
// one network does not repeat the firm lookups.

export interface AdviserResearchItem {
  id: string
  frn: string | null
}

export interface AdviserBatchResult {
  completed: number
  failed: number
  limitHit: boolean
  lastError: string
}

export async function researchAdvisersSequentially(
  campaignId: string,
  items: AdviserResearchItem[],
  onProgress: (done: number, total: number) => void
): Promise<AdviserBatchResult> {
  const signalsByFrn: Record<string, unknown> = {}
  const uniqueFrns = Array.from(new Set(items.map((i) => i.frn).filter((f): f is string => !!f)))
  for (const frn of uniqueFrns) {
    try {
      const res = await fetch('/api/recruitment/firm-signals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frn }),
      })
      const data = await res.json()
      if (res.ok && data.firm_signals) signalsByFrn[frn] = data.firm_signals
    } catch {
      // Research falls back to an inline lookup
    }
  }

  let completed = 0
  let failed = 0
  let lastError = ''
  let limitHit = false

  for (const item of items) {
    try {
      const res = await fetch('/api/recruitment/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          campaign_id: campaignId,
          prospect_id: item.id,
          firm_signals: item.frn ? signalsByFrn[item.frn] : undefined,
        }),
      })
      const data = await res.json()
      // 402: out of researches. 403: Recruitment not active. Either way the
      // rest of the batch would fail the same way, so stop.
      if (res.status === 402 || res.status === 403) {
        limitHit = true
        lastError = data.error || 'Adviser research limit reached'
        break
      }
      if (!res.ok) throw new Error(data.error || 'Research failed')
      completed += data.completed || 0
      failed += data.failed || 0
      if (data.failed) lastError = data.results?.[0]?.error || lastError
    } catch (err: unknown) {
      lastError = err instanceof Error ? err.message : 'Research failed'
      failed++
    }
    onProgress(completed + failed, items.length)
  }

  return { completed, failed, limitHit, lastError }
}
