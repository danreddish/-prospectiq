import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import WatchlistManager, { type WatchItem, type WatchableProspect } from './watchlist-manager'

export const dynamic = 'force-dynamic'

export default async function WatchlistPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  const [itemsRes, unreadRes, prospectsRes] = await Promise.all([
    supabase
      .from('watchlist_items')
      .select('id, item_type, fca_irn, fca_frn, display_name, firm_name, prospect_id, campaign_id, last_checked_at, last_snapshot, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false }),
    supabase
      .from('alerts')
      .select('watchlist_item_id')
      .eq('user_id', user.id)
      .is('read_at', null),
    supabase
      .from('prospects')
      .select('id, name, campaign_id, fca_irn, fca_frn, fca_firm_name, company')
      .eq('user_id', user.id)
      .eq('prospect_type', 'adviser')
      .eq('status', 'completed')
      .order('total_score', { ascending: false })
      .limit(500),
  ])

  const unreadByItem: Record<string, number> = {}
  for (const a of unreadRes.data || []) {
    unreadByItem[a.watchlist_item_id] = (unreadByItem[a.watchlist_item_id] || 0) + 1
  }

  return (
    <WatchlistManager
      initialItems={(itemsRes.data || []) as WatchItem[]}
      unreadByItem={unreadByItem}
      prospects={(prospectsRes.data || []) as WatchableProspect[]}
    />
  )
}
