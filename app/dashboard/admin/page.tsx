import { createClient, createAdminClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import AdminDashboard from './admin-dashboard'

export const dynamic = 'force-dynamic'

// Only these emails can access the admin page
const ADMIN_EMAILS = ['dan.reddish@gmail.com', 'dan@aiwealthpartners.co.uk']

export default async function AdminPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user || !ADMIN_EMAILS.includes(user.email || '')) {
    redirect('/dashboard')
  }

  const admin = createAdminClient()

  // Fetch all users with their usage
  const { data: profiles } = await admin
    .from('profiles')
    .select('*')
    .order('created_at', { ascending: false })

  // Fetch campaign counts per user
  const { data: campaigns } = await admin
    .from('campaigns')
    .select('user_id, id')

  // Fetch prospect counts per user
  const { data: prospects } = await admin
    .from('prospects')
    .select('user_id, status')

  // Build user stats
  const campaignCounts: Record<string, number> = {}
  const prospectCounts: Record<string, { total: number; completed: number }> = {}

  for (const c of campaigns || []) {
    campaignCounts[c.user_id] = (campaignCounts[c.user_id] || 0) + 1
  }

  for (const p of prospects || []) {
    if (!prospectCounts[p.user_id]) {
      prospectCounts[p.user_id] = { total: 0, completed: 0 }
    }
    prospectCounts[p.user_id].total++
    if (p.status === 'completed') prospectCounts[p.user_id].completed++
  }

  const users = (profiles || []).map((p) => ({
    ...p,
    campaignCount: campaignCounts[p.id] || 0,
    prospectTotal: prospectCounts[p.id]?.total || 0,
    prospectCompleted: prospectCounts[p.id]?.completed || 0,
  }))

  return <AdminDashboard users={users} />
}
