// Watchlist check every 15 minutes (v76.1). Schedule is set in netlify.toml.
// Up to 40 items a run, paced for the register's rate limit: roughly
// 2,500 to 3,500 checks a day depending on how fast the register answers.
// Scheduled functions only run on published production deploys. For deploy
// previews and manual runs, use the admin route /api/admin/watchlist-check.
// Static imports only.

import { runWatchlistCheck } from '../../lib/recruitment/watchlist-check'

export default async (): Promise<Response> => {
  try {
    // Scheduled functions may run for 30 seconds (API routes get 10).
    const result = await runWatchlistCheck({ budgetMs: 25000, batchSize: 40 })
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Watchlist check failed'
    console.error('[watchlist-check] error:', message)
    return new Response(JSON.stringify({ error: message }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
}
