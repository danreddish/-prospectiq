import { createClient } from '@/lib/supabase/server'
import { notFound, redirect } from 'next/navigation'
import { Prospect, Campaign } from '@/types'
import CampaignDashboard from '@/app/dashboard/campaigns/[id]/campaign-dashboard'

export const dynamic = 'force-dynamic'

// Recruitment campaign dashboard. Reuses the client campaign dashboard in
// adviser mode (score labels, FCA badge, register history, adviser exports).
export default async function RecruitmentCampaignPage({
  params,
  searchParams,
}: {
  params: { id: string }
  searchParams?: { prospect?: string }
}) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  const { data: campaign } = await supabase
    .from('campaigns')
    .select('*')
    .eq('id', params.id)
    .eq('user_id', user.id)
    .single()

  if (!campaign) notFound()
  if (campaign.purpose !== 'advisers') redirect(`/dashboard/campaigns/${campaign.id}`)

  const [completedRes, pendingRes, watchRes] = await Promise.all([
    supabase
      .from('prospects')
      .select('*')
      .eq('campaign_id', params.id)
      .eq('prospect_type', 'adviser')
      .eq('status', 'completed')
      .order('total_score', { ascending: false }),
    supabase
      .from('prospects')
      .select('*')
      .eq('campaign_id', params.id)
      .eq('prospect_type', 'adviser')
      .in('status', ['pending', 'failed'])
      .order('created_at', { ascending: true }),
    supabase
      .from('watchlist_items')
      .select('item_type, fca_irn, fca_frn')
      .eq('user_id', user.id),
  ])
  const watch = watchRes.data || []

  return (
    <CampaignDashboard
      campaign={campaign as Campaign}
      prospects={(completedRes.data as Prospect[]) || []}
      pendingProspects={(pendingRes.data as Prospect[]) || []}
      mode="advisers"
      watchedIrns={watch.filter((w) => w.item_type === 'adviser' && w.fca_irn).map((w) => w.fca_irn as string)}
      watchedFrns={watch.filter((w) => w.item_type === 'firm' && w.fca_frn).map((w) => w.fca_frn as string)}
      initialProspectId={searchParams?.prospect || null}
    />
  )
}
