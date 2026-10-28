import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import AlertsList, { type AlertRow } from './alerts-list'

export const dynamic = 'force-dynamic'

export default async function AlertsPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  const { data } = await supabase
    .from('alerts')
    .select('id, alert_type, title, detail, created_at, read_at, watchlist_item_id')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(300)

  return <AlertsList initialAlerts={(data || []) as AlertRow[]} />
}
