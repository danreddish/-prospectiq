import { createClient } from '@/lib/supabase/server'
import { notFound, redirect } from 'next/navigation'
import { isAdmin } from '@/lib/admin'
import PipelineDashboard from './pipeline-dashboard'

export const dynamic = 'force-dynamic'

// v78: admin-only LinkedIn pipeline, live from HeyReach.
export default async function HeyReachPipelinePage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')
  if (!isAdmin(user.email)) notFound()
  return <PipelineDashboard />
}
