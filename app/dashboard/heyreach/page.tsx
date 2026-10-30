import { createClient } from '@/lib/supabase/server'
import { notFound, redirect } from 'next/navigation'
import { isAdmin } from '@/lib/admin'
import HeyReachSetup from './heyreach-setup'

export const dynamic = 'force-dynamic'

// v77: admin-only. LinkedIn exclusions (Ulinc export) and the HeyReach
// connection, plus links into each campaign's HeyReach test page.
export default async function HeyReachPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')
  if (!isAdmin(user.email)) notFound()

  const [countRes, campaignsRes] = await Promise.all([
    supabase.from('linkedin_exclusions').select('profile_slug', { count: 'exact', head: true }).eq('user_id', user.id).eq('source', 'ulinc'),
    supabase
      .from('campaigns')
      .select('id, name, created_at, purpose')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(20),
  ])

  const campaigns = (campaignsRes.data || [])
    .filter((c) => c.purpose !== 'advisers')
    .map((c) => ({ id: c.id as string, name: c.name as string }))

  return <HeyReachSetup exclusionCount={countRes.count || 0} campaigns={campaigns} />
}
