import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

interface CampaignRow {
  id: string
  name: string
  niche: string | null
  audience_mode: string | null
  custom_instructions: string | null
  created_at: string
  updated_at: string
  prospects: { tier: string | null; status: string }[]
}

export default async function CampaignsListPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  const { data: campaigns } = await supabase
    .from('campaigns')
    .select('id, name, niche, audience_mode, custom_instructions, created_at, updated_at, prospects(tier, status)')
    .eq('user_id', user.id)
    .order('updated_at', { ascending: false })

  const rows = (campaigns || []) as CampaignRow[]

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-display text-brand-cream">My Campaigns</h1>
          <p className="text-brand-beige text-sm mt-1">
            {rows.length === 0
              ? 'No campaigns yet. Create your first one to start finding prospects.'
              : `${rows.length} campaign${rows.length === 1 ? '' : 's'}`}
          </p>
        </div>
        <Link href="/dashboard/campaigns/new" className="btn-primary text-sm">
          + New Campaign
        </Link>
      </div>

      {rows.length === 0 ? (
        <div className="bg-brand-charcoal-deep rounded-xl border border-brand-charcoal p-12 text-center">
          <p className="text-brand-beige mb-6">Each campaign holds a set of prospects, their research, and outreach.</p>
          <Link href="/dashboard/campaigns/new" className="btn-primary text-sm">
            Create your first campaign
          </Link>
        </div>
      ) : (
        <div className="bg-brand-charcoal-deep rounded-xl border border-brand-charcoal overflow-hidden">
          <div className="grid grid-cols-12 gap-3 px-5 py-3 border-b border-brand-charcoal text-brand-beige text-[10px] uppercase tracking-wider font-semibold">
            <div className="col-span-4">Campaign</div>
            <div className="col-span-3">Mode</div>
            <div className="col-span-3">Prospects</div>
            <div className="col-span-2 text-right">Updated</div>
          </div>

          <div className="divide-y divide-brand-charcoal">
            {rows.map((c) => {
              const total = c.prospects?.length || 0
              const tierA = c.prospects?.filter((p) => p.tier === 'A').length || 0
              const tierB = c.prospects?.filter((p) => p.tier === 'B').length || 0
              const tierC = c.prospects?.filter((p) => p.tier === 'C').length || 0
              const completed = c.prospects?.filter((p) => p.status === 'completed').length || 0
              const pending = total - completed

              const modeLabel = c.audience_mode === 'match_profile'
                ? 'Match my profile'
                : c.audience_mode === 'different_audience'
                ? 'Different audience'
                : 'Not set'

              const updatedAt = new Date(c.updated_at)
              const updatedLabel = updatedAt.toLocaleDateString('en-GB', {
                day: 'numeric',
                month: 'short',
                year: updatedAt.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
              })

              return (
                <Link
                  key={c.id}
                  href={`/dashboard/campaigns/${c.id}`}
                  className="grid grid-cols-12 gap-3 px-5 py-4 hover:bg-brand-charcoal-deeper/50 transition-colors items-center"
                >
                  <div className="col-span-4 min-w-0">
                    <p className="text-brand-cream font-medium truncate">{c.name}</p>
                    <p className="text-brand-beige text-xs truncate mt-0.5">
                      {c.niche || 'No niche set'}
                      {c.custom_instructions && (
                        <span className="ml-2 inline-flex items-center gap-1 text-brand-rose-gold">
                          <span className="w-1 h-1 rounded-full bg-brand-rose-gold" />
                          Custom instructions
                        </span>
                      )}
                    </p>
                  </div>

                  <div className="col-span-3">
                    <span className={`inline-block px-2 py-0.5 rounded text-[10px] uppercase tracking-wide font-semibold ${
                      c.audience_mode === 'match_profile'
                        ? 'bg-brand-rose-gold/20 text-brand-rose-gold'
                        : c.audience_mode === 'different_audience'
                        ? 'bg-brand-charcoal text-brand-cream'
                        : 'bg-brand-charcoal-dark text-brand-beige'
                    }`}>
                      {modeLabel}
                    </span>
                  </div>

                  <div className="col-span-3">
                    {total === 0 ? (
                      <p className="text-brand-beige text-xs">None yet</p>
                    ) : (
                      <div className="flex items-center gap-3 text-xs">
                        <span className="text-brand-cream font-semibold">{total}</span>
                        {tierA > 0 && (
                          <span className="text-brand-rose-gold">A: {tierA}</span>
                        )}
                        {tierB > 0 && (
                          <span className="text-brand-cream">B: {tierB}</span>
                        )}
                        {tierC > 0 && (
                          <span className="text-brand-beige">C: {tierC}</span>
                        )}
                        {pending > 0 && (
                          <span className="text-brand-beige">({pending} pending)</span>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="col-span-2 text-right">
                    <p className="text-brand-beige text-xs">{updatedLabel}</p>
                  </div>
                </Link>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
