// v81: starting the deep research background function from an API route.
// The function is public on the site's address, so each request carries a
// signature made with the service key, which only the server holds.
// Relative imports only (the background function bundles this file).

import { createHmac, timingSafeEqual } from 'crypto'

export const DEEP_RESEARCH_FUNCTION_PATH = '/.netlify/functions/deep-research-background'

/** Off switch: set DEEP_RESEARCH_DISABLED=1 in Netlify to go back to first-pass research only. */
export function deepResearchEnabled(): boolean {
  return process.env.DEEP_RESEARCH_DISABLED !== '1' && !!process.env.SUPABASE_SERVICE_ROLE_KEY
}

export function signProspect(prospectId: string): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) throw new Error('Deep research is not configured')
  return createHmac('sha256', key).update(`deep-research:${prospectId}`).digest('hex')
}

export function verifyProspectSignature(prospectId: string, signature: string): boolean {
  try {
    const expected = Buffer.from(signProspect(prospectId), 'hex')
    const given = Buffer.from(signature, 'hex')
    return expected.length === given.length && timingSafeEqual(expected, given)
  } catch {
    return false
  }
}

/**
 * Ask Netlify to run the job. A background function answers 202 straight
 * away and carries on by itself. Returns false if the request did not land.
 */
export async function triggerDeepResearch(origin: string, prospectId: string): Promise<boolean> {
  try {
    const res = await fetch(`${origin}${DEEP_RESEARCH_FUNCTION_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prospect_id: prospectId, signature: signProspect(prospectId) }),
      signal: AbortSignal.timeout(2500),
    })
    if (res.status !== 202 && !res.ok) {
      console.error(`[DeepResearch] Trigger for ${prospectId} answered ${res.status}`)
      return false
    }
    return true
  } catch (err) {
    console.error(`[DeepResearch] Trigger for ${prospectId} failed:`, err instanceof Error ? err.message : err)
    return false
  }
}
