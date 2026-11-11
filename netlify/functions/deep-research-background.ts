// Deep research for one prospect (v81). The "-background" in the file name
// makes this a Netlify background function: it answers 202 at once and may
// run for up to 15 minutes, so the research is not cut off at 10 seconds.
// Started by /api/prospects/research and /api/prospects/deep-research.
// Static, relative imports only.

import { rewriteMessages, runDeepResearch } from '../../lib/deep-research/run'
import { verifyProspectSignature } from '../../lib/deep-research/trigger'

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  let body: { prospect_id?: unknown; signature?: unknown; mode?: unknown }
  try {
    body = await req.json()
  } catch {
    return new Response('Bad request', { status: 400 })
  }
  const prospectId = typeof body.prospect_id === 'string' ? body.prospect_id : ''
  const signature = typeof body.signature === 'string' ? body.signature : ''
  if (!/^[0-9a-f-]{36}$/i.test(prospectId) || !verifyProspectSignature(prospectId, signature)) {
    console.warn('[deep-research] rejected a request with a bad signature')
    return new Response('Forbidden', { status: 403 })
  }
  // mode 'messages': write the outreach again from the saved findings, no new research.
  const result = body.mode === 'messages' ? await rewriteMessages(prospectId) : await runDeepResearch(prospectId)
  return new Response(JSON.stringify(result), { status: result.ok ? 200 : 500, headers: { 'Content-Type': 'application/json' } })
}
