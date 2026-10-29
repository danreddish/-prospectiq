import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { isAdmin } from '@/lib/access'
import { runWatchlistCheck } from '@/lib/recruitment/watchlist-check'

export const dynamic = 'force-dynamic'

// Admin-only manual run of the watchlist check. Same logic as the scheduled
// scheduled function, which only runs on production deploys.
async function handle() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user.email)) {
    return NextResponse.json({ error: 'Not authorised' }, { status: 403 })
  }

  try {
    const result = await runWatchlistCheck({ budgetMs: 8000, client: createAdminClient() })
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Watchlist check failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST() {
  return handle()
}

export async function GET() {
  return handle()
}
