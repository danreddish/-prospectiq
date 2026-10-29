import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { PLAN_LIMITS } from '@/types'

export const dynamic = 'force-dynamic'

interface RecruitmentCampaignRow {
  id: string
  name: string
  sender_name: string | null
  created_at: string
  updated_at: string
  prospects: { tier: string | null; status: string }[]
}

export default async function RecruitmentOverviewPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  const limits = PLAN_LIMITS.recruitment

  const [profileRes, campaignsRes, alertsRes, watchCountRes] = await Promise.all([
    supabase
      .from('profiles')
      .select('recruitment_status, recruitment_period, recruitment_current_period_end, recruitment_advisers_used, recruitment_finds_used, recruitment_usage_reset_at, recruitment_profile')
      .eq('id', user.id)
      .single(),
    supabase
      .from('campaigns')
      .select('id, name, sender_name, created_at, updated_at, prospects(tier, status)')
      .eq('user_id', user.id)
      .eq('purpose', 'advisers')
      .order('updated_at', { ascending: false }),
    supabase
      .from('alerts')
      .select('id, alert_type, title, detail, created_at, read_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(5),
    supabase
      .from('watchlist_items')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id),
  ])
  const recentAlerts = alertsRes.data || []
  const watchCount = watchCountRes.count || 0

  const profile = profileRes.data
  const campaigns = (campaignsRes.data || []) as RecruitmentCampaignRow[]
  // A cycle that has passed counts as reset, matching the database.
  const cycleLive = !!profile?.recruitment_usage_reset_at && new Date(profile.recruitment_usage_reset_at).getTime() > Date.now()
  const advisersUsed = cycleLive ? profile?.recruitment_advisers_used || 0 : 0
  const searchesUsed = cycleLive ? profile?.recruitment_finds_used || 0 : 0
  const usagePercent = Math.min(100, Math.round((advisersUsed / limits.advisers_per_cycle) * 100))
  const resetAt = cycleLive && profile?.recruitment_usage_reset_at
    ? new Date(profile.recruitment_usage_reset_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    : null
  const rp = (profile?.recruitment_profile || {}) as Record<string, unknown>
  const profileSet = !!(rp.firm_name || rp.proposition)
  const researched = campaigns.reduce((sum, c) => sum + (c.prospects?.filter((p) => p.status === 'completed').length || 0), 0)
  const tierA = campaigns.reduce((sum, c) => sum + (c.prospects?.filter((p) => p.tier === 'A').length || 0), 0)

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <p className="text-brand-rose-gold text-[10px] font-bold tracking-[2px] uppercase mb-1">Recruitment</p>
          <h1 className="text-2xl font-display text-brand-cream">Adviser recruitment</h1>
          <p className="text-brand-beige text-sm mt-1">
            Find advisers likely to move, score them, watch their firms, and reach out as a peer.
          </p>
        </div>
        <div className="flex gap-3">
          <Link href="/dashboard/recruitment/watchlist" className="btn-secondary text-sm">
            Watchlist ({watchCount}/{limits.watchlist_items})
          </Link>
          <Link href="/dashboard/recruitment/campaigns" className="btn-primary text-sm">
            New Recruitment Campaign
          </Link>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-4 gap-4 mb-8">
        <div className="bg-brand-charcoal-deep rounded-xl p-5 border border-brand-charcoal">
          <p className="text-brand-beige text-xs uppercase tracking-wide">Advisers researched</p>
          <p className="text-brand-cream text-2xl font-display mt-1">
            {advisersUsed}<span className="text-brand-beige text-sm font-body">/{limits.advisers_per_cycle}</span>
          </p>
          <div className="h-1.5 bg-brand-charcoal rounded-full overflow-hidden mt-3">
            <div className="h-full bg-purple-400 rounded-full" style={{ width: `${usagePercent}%` }} />
          </div>
          <p className="text-[10px] text-brand-beige mt-2">
            {searchesUsed}/{limits.finds_per_cycle} searches. {resetAt ? `Resets ${resetAt}` : 'Resets 30 days after first use'}
          </p>
        </div>
        {[
          { label: 'Recruitment campaigns', value: `${campaigns.length}/${limits.campaigns}` },
          { label: 'Researched, all time', value: researched },
          { label: 'Tier A advisers', value: tierA },
        ].map((stat) => (
          <div key={stat.label} className="bg-brand-charcoal-deep rounded-xl p-5 border border-brand-charcoal">
            <p className="text-brand-beige text-xs uppercase tracking-wide">{stat.label}</p>
            <p className="text-brand-cream text-2xl font-display mt-1">{stat.value}</p>
          </div>
        ))}
      </div>

      {!profileSet && (
        <div className="mb-8 rounded-xl border border-brand-rose-gold/30 bg-brand-rose-gold/5 p-5 flex items-center justify-between gap-4">
          <div>
            <p className="text-brand-cream text-sm font-semibold">Set up your recruitment profile</p>
            <p className="text-brand-beige text-xs mt-1">
              Your firm, what you offer advisers, roles, locations and permissions. Scoring and outreach get much sharper once this is filled in.
            </p>
          </div>
          <Link href="/dashboard/settings#recruitment" className="btn-secondary text-xs whitespace-nowrap">
            Open Settings
          </Link>
        </div>
      )}

      {/* Recent alerts */}
      <div className="bg-brand-charcoal-deep rounded-xl border border-brand-charcoal mb-8">
        <div className="p-5 border-b border-brand-charcoal flex items-center justify-between">
          <h2 className="text-brand-cream font-display text-lg">Recent alerts</h2>
          <Link href="/dashboard/recruitment/alerts" className="text-brand-rose-gold text-xs hover:underline">All alerts &rarr;</Link>
        </div>
        {recentAlerts.length > 0 ? (
          <div className="divide-y divide-brand-charcoal">
            {recentAlerts.map((a) => (
              <Link key={a.id} href="/dashboard/recruitment/alerts" className="flex items-center gap-3 px-5 py-3 hover:bg-brand-charcoal-deeper/50 transition-colors">
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${a.read_at ? 'bg-transparent' : 'bg-brand-rose-gold'}`} />
                <p className={`text-sm flex-1 truncate ${a.read_at ? 'text-brand-beige' : 'text-brand-cream font-semibold'}`}>{a.title}</p>
                <span className="text-brand-beige text-xs whitespace-nowrap">
                  {new Date(a.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                </span>
              </Link>
            ))}
          </div>
        ) : (
          <p className="p-5 text-brand-beige text-sm">
            No alerts yet. Watch advisers and firms and we check the register in rotation for moves, status changes and firms losing people.
          </p>
        )}
      </div>

      {/* Campaigns */}
      <div className="bg-brand-charcoal-deep rounded-xl border border-brand-charcoal">
        <div className="p-5 border-b border-brand-charcoal flex items-center justify-between">
          <h2 className="text-brand-cream font-display text-lg">Recruitment campaigns</h2>
          <span className="text-brand-beige text-xs">{campaigns.length} of {limits.campaigns}</span>
        </div>

        {campaigns.length > 0 ? (
          <div className="divide-y divide-brand-charcoal">
            {campaigns.map((c) => {
              const total = c.prospects?.length || 0
              const completed = c.prospects?.filter((p) => p.status === 'completed').length || 0
              const a = c.prospects?.filter((p) => p.tier === 'A').length || 0
              const pending = c.prospects?.filter((p) => p.status === 'pending').length || 0
              return (
                <Link
                  key={c.id}
                  href={`/dashboard/recruitment/campaigns/${c.id}`}
                  className="flex items-center justify-between p-5 hover:bg-brand-charcoal-deeper/50 transition-colors"
                >
                  <div className="min-w-0">
                    <p className="text-brand-cream font-medium truncate">{c.name}</p>
                    <p className="text-brand-beige text-sm mt-0.5">
                      {completed} researched{a > 0 ? ` · ${a} tier A` : ''}{pending > 0 ? ` · ${pending} awaiting research` : ''}{total === 0 ? 'No advisers yet' : ''}
                    </p>
                  </div>
                  <div className="text-brand-beige text-sm">
                    {new Date(c.updated_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                  </div>
                </Link>
              )
            })}
          </div>
        ) : (
          <div className="p-12 text-center">
            <p className="text-brand-beige mb-4">No recruitment campaigns yet. Describe who you want to hire and we will find them on the register.</p>
            <Link href="/dashboard/recruitment/campaigns" className="btn-primary text-sm">
              Create Recruitment Campaign
            </Link>
          </div>
        )}
      </div>
    </div>
  )
}
