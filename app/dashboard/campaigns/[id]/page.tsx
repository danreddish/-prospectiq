import { createClient } from '@/lib/supabase/server'
import { notFound, redirect } from 'next/navigation'
import { Prospect } from '@/types'
import CampaignDashboard from './campaign-dashboard'
import { isAdmin } from '@/lib/admin'

export default async function CampaignDetailPage({
  params,
}: {
  params: { id: string }
}) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: campaign } = await supabase
    .from('campaigns')
    .select('*')
    .eq('id', params.id)
    .eq('user_id', user!.id)
    .single()

  if (!campaign) notFound()

  // Recruitment campaigns have their own dashboard (v76)
  if (campaign.purpose === 'advisers') redirect(`/dashboard/recruitment/campaigns/${campaign.id}`)

  const { data: prospects } = await supabase
    .from('prospects')
    .select('*')
    .eq('campaign_id', params.id)
    .eq('status', 'completed')
    .order('total_score', { ascending: false })

  const { data: pendingProspects } = await supabase
    .from('prospects')
    .select('*')
    .eq('campaign_id', params.id)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })

  return (
    <CampaignDashboard
      campaign={campaign}
      prospects={(prospects as Prospect[]) || []}
      pendingProspects={(pendingProspects as Prospect[]) || []}
      showHeyReach={isAdmin(user!.email)}
    />
  )
}
