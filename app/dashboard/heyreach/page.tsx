import { createAdminClient, createClient } from '@/lib/supabase/server'
import { notFound, redirect } from 'next/navigation'
import { isAdmin } from '@/lib/admin'
import HeyReachSetup from './heyreach-setup'

export const dynamic = 'force-dynamic'

// v77: admin-only. LinkedIn exclusions (Ulinc export) and the HeyReach
// connection, plus links into each campaign's HeyReach test page.
// v80: users for "whose Ulinc contacts" and "Set up a client".
export default async function HeyReachPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')
  if (!isAdmin(user.email)) notFound()

  const [countRes, campaignsRes, usersRes] = await Promise.all([
    supabase.from('linkedin_exclusions').select('profile_slug', { count: 'exact', head: true }).eq('user_id', user.id).eq('source', 'ulinc'),
    supabase
      .from('campaigns')
      .select('id, name, created_at, purpose')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(20),
    createAdminClient().from('profiles').select('id, email, full_name').order('email', { ascending: true }).limit(1000),
  ])

  const campaigns = (campaignsRes.data || [])
    .filter((c) => c.purpose !== 'advisers')
    .map((c) => ({ id: c.id as string, name: c.name as string }))

  const users = (usersRes.data || [])
    .filter((u) => u.id !== user.id)
    .map((u) => ({ id: u.id as string, email: u.email as string, name: (u.full_name as string | null) || null }))

  return <HeyReachSetup exclusionCount={countRes.count || 0} campaigns={campaigns} users={users} />
}
