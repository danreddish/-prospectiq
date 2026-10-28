import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { hasRecruitmentAccess } from '@/lib/recruitment/access'
import RecruitmentUpgrade from './upgrade-screen'

export const dynamic = 'force-dynamic'

// Every /dashboard/recruitment route needs recruitment_status active, or the
// admin email. Otherwise the upgrade screen renders in place of the page.
export default async function RecruitmentLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('recruitment_status, recruitment_subscription_id, recruitment_current_period_end')
    .eq('id', user.id)
    .single()

  if (!hasRecruitmentAccess(profile, user.email)) {
    const expiredBeta = profile?.recruitment_status === 'active'
    return <RecruitmentUpgrade status={expiredBeta ? 'expired' : profile?.recruitment_status || 'inactive'} />
  }

  return <>{children}</>
}
