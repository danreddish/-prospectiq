// v76.2: research is two requests. /api/prospects/research scores and saves
// the prospect, then this asks /api/prospects/outreach to write its LINK
// Method sequence. Each stays well inside Netlify's 10 second limit.
//
// Returns true when the outreach is written (or already was). On false, the
// research is still saved and the prospect page offers "Write outreach".
export async function writeOutreachFor(campaignId: string, prospectId: string): Promise<boolean> {
  try {
    const res = await fetch('/api/prospects/outreach', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaign_id: campaignId, prospect_id: prospectId }),
    })
    const data = await res.json().catch(() => ({}))
    return res.ok && !!data.ok
  } catch {
    return false
  }
}

/** Writes outreach for every completed result in a research response. */
export async function writeOutreachForResults(
  campaignId: string,
  results: { id?: string; status?: string; outreach_pending?: boolean }[] | undefined
): Promise<{ written: number; failed: number }> {
  let written = 0
  let failed = 0
  for (const r of results || []) {
    if (r.status !== 'completed' || !r.id || !r.outreach_pending) continue
    if (await writeOutreachFor(campaignId, r.id)) written++
    else failed++
  }
  return { written, failed }
}

export function outreachFailedNote(failed: number): string {
  if (failed <= 0) return ''
  return ` Outreach still to write for ${failed}. Open ${failed === 1 ? 'that prospect' : 'those prospects'} and click Write outreach.`
}
