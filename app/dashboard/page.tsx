import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'

export default async function DashboardPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: campaigns } = await supabase
    .from('campaigns')
    .select('*, prospects(count)')
    .eq('user_id', user!.id)
    .order('created_at', { ascending: false })
    .limit(10)

  const { data: recentProspects } = await supabase
    .from('prospects')
    .select('*')
    .eq('user_id', user!.id)
    .eq('status', 'completed')
    .order('created_at', { ascending: false })
    .limit(5)

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-display text-brand-cream">Dashboard</h1>
          <p className="text-brand-beige text-sm mt-1">
            Research, score, and sequence your prospects.
          </p>
        </div>
        <Link href="/dashboard/campaigns" className="btn-primary text-sm">
          New Campaign
        </Link>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-4 gap-4 mb-8">
        {[
          { label: 'Active Campaigns', value: campaigns?.length || 0 },
          { label: 'Prospects Researched', value: recentProspects?.length || 0 },
          { label: 'Tier A Prospects', value: recentProspects?.filter(p => p.tier === 'A').length || 0 },
          { label: 'Avg Score', value: recentProspects?.length
            ? Math.round(recentProspects.reduce((sum, p) => sum + (p.total_score || 0), 0) / recentProspects.length)
            : 0
          },
        ].map((stat) => (
          <div
            key={stat.label}
            className="bg-brand-charcoal-deep rounded-xl p-5 border border-brand-charcoal"
          >
            <p className="text-brand-beige text-xs uppercase tracking-wide">{stat.label}</p>
            <p className="text-brand-cream text-2xl font-display mt-1">{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Campaigns list */}
      <div className="bg-brand-charcoal-deep rounded-xl border border-brand-charcoal">
        <div className="p-5 border-b border-brand-charcoal">
          <h2 className="text-brand-cream font-display text-lg">Your Campaigns</h2>
        </div>

        {campaigns && campaigns.length > 0 ? (
          <div className="divide-y divide-brand-charcoal">
            {campaigns.map((campaign) => (
              <Link
                key={campaign.id}
                href={`/dashboard/campaigns/${campaign.id}`}
                className="flex items-center justify-between p-5 hover:bg-brand-charcoal-deeper/50 transition-colors"
              >
                <div>
                  <p className="text-brand-cream font-medium">{campaign.name}</p>
                  <p className="text-brand-beige text-sm mt-0.5">
                    {campaign.niche || 'No niche set'} &middot; {campaign.prospect_count} prospects
                  </p>
                </div>
                <div className="text-brand-beige text-sm">
                  {new Date(campaign.created_at).toLocaleDateString('en-GB', {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                  })}
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <div className="p-12 text-center">
            <p className="text-brand-beige mb-4">No campaigns yet. Create your first one to start researching prospects.</p>
            <Link href="/dashboard/campaigns" className="btn-primary text-sm">
              Create Campaign
            </Link>
          </div>
        )}
      </div>

      {/* Recent prospects */}
      {recentProspects && recentProspects.length > 0 && (
        <div className="mt-8 bg-brand-charcoal-deep rounded-xl border border-brand-charcoal">
          <div className="p-5 border-b border-brand-charcoal">
            <h2 className="text-brand-cream font-display text-lg">Recent Prospects</h2>
          </div>
          <div className="divide-y divide-brand-charcoal">
            {recentProspects.map((prospect) => (
              <div key={prospect.id} className="flex items-center justify-between p-5">
                <div>
                  <p className="text-brand-cream font-medium">{prospect.name}</p>
                  <p className="text-brand-beige text-sm">
                    {prospect.role} {prospect.company ? `at ${prospect.company}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-brand-cream text-sm font-semibold">
                    {prospect.total_score}/40
                  </span>
                  <span
                    className={`px-2.5 py-0.5 rounded text-xs font-bold ${
                      prospect.tier === 'A'
                        ? 'bg-brand-rose-gold text-brand-dark'
                        : prospect.tier === 'B'
                        ? 'bg-brand-charcoal text-brand-cream'
                        : 'bg-brand-charcoal-dark text-brand-beige'
                    }`}
                  >
                    TIER {prospect.tier}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
