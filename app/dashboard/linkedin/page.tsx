import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { isAdmin } from '@/lib/admin'
import PipelineDashboard from './pipeline-dashboard'

export const dynamic = 'force-dynamic'

// v78: the LinkedIn pipeline, live from HeyReach. Every signed-in user sees
// the HeyReach campaigns assigned to them (admins see all). The API route
// enforces it; this page only decides the wording.
export default async function LinkedInPipelinePage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')
  return <PipelineDashboard admin={isAdmin(user.email)} />
}
