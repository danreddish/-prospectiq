// Daily alerts digest at 07:00 UTC (v76.1). Schedule is set in netlify.toml.
// Sends only when BREVO_API_KEY and RECRUITMENT_DIGEST_FROM_EMAIL are set.
// Static imports only.

import { runAlertsDigest } from '../../lib/recruitment/alerts-digest'

export default async (): Promise<Response> => {
  try {
    const result = await runAlertsDigest()
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Digest failed'
    console.error('[alerts-digest] error:', message)
    return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
}
