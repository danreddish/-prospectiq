import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { PLAN_LIMITS, PlanTier } from '@/types'
import { isAdmin, researchAccess, effectiveUsage, accessMessage } from '@/lib/access'

export const dynamic = 'force-dynamic'

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/auth/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single()

  if (!profile) redirect('/auth/login')

  const limits = PLAN_LIMITS[(profile.plan_tier as PlanTier)] || PLAN_LIMITS.free
  // v75.7: a cycle that has passed counts as reset, matching the database.
  const used = effectiveUsage(profile)
  const usagePercent = Math.min(100, Math.round((used / Math.max(limits.prospects_per_cycle, 1)) * 100))
  const admin = isAdmin(user.email)
  // v75.7: explain why research is blocked, before the user hits an error.
  const blockedReason = admin ? 'ok' : researchAccess(profile)
  const blockedMessage = blockedReason === 'ok'
    ? null
    : accessMessage(blockedReason, { limit: limits.prospects_per_cycle, resetsAt: profile.cycle_reset_at })

  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <aside className="w-64 bg-brand-charcoal-deeper border-r border-brand-charcoal flex flex-col">
        {/* Brand */}
        <div className="p-5 border-b border-brand-charcoal">
          <p className="text-brand-rose-gold text-[10px] font-bold tracking-[2px] uppercase">
            AI Wealth Partners
          </p>
          <h1 className="text-brand-cream text-lg font-display mt-0.5">ProspectIQ</h1>
        </div>

        {/* Nav */}
        <nav className="flex-1 p-4 space-y-1">
          <NavLink href="/dashboard" label="Dashboard" />
          <NavLink href="/dashboard/campaigns" label="Campaigns" />
          <NavLink href="/dashboard/settings" label="Settings" />
          {admin && (
            <NavLink href="/dashboard/admin" label="Admin" />
          )}
        </nav>

        {/* Usage meter */}
        <div className="p-4 border-t border-brand-charcoal">
          <div className="flex justify-between text-xs mb-2">
            <span className="text-brand-beige">Prospects used</span>
            <span className="text-brand-cream font-semibold">
              {used}/{limits.prospects_per_cycle}
            </span>
          </div>
          <div className="h-1.5 bg-brand-charcoal rounded-full overflow-hidden">
            <div
              className="h-full bg-brand-rose-gold rounded-full transition-all duration-500"
              style={{ width: `${usagePercent}%` }}
            />
          </div>
          <p className="text-[10px] text-brand-beige mt-2 uppercase tracking-wide">
            {planLabel(profile.plan_tier, profile.trial_ends_at)}
          </p>
        </div>

        {/* User */}
        <div className="p-4 border-t border-brand-charcoal">
          <p className="text-brand-cream text-sm font-medium truncate">
            {profile.full_name || profile.email}
          </p>
          <p className="text-brand-beige text-xs truncate">{profile.email}</p>
          <form action="/auth/signout" method="post" className="mt-3">
            <button
              type="submit"
              className="text-xs text-brand-beige hover:text-brand-rose-gold transition-colors"
            >
              Sign out
            </button>
          </form>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-6xl mx-auto p-8">
          {blockedMessage && (
            <div className="bg-brand-rose-gold/10 border border-brand-rose-gold/30 rounded-lg p-4 mb-6 flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
              <p className="text-brand-cream text-sm">{blockedMessage}</p>
              <Link href="/dashboard/settings" className="btn-primary text-sm whitespace-nowrap text-center">
                Choose a plan
              </Link>
            </div>
          )}
          {children}
        </div>
      </main>
    </div>
  )
}

// v75.6: show trial days left instead of "trial plan".
function planLabel(tier: string, trialEndsAt: string | null): string {
  if (tier === 'free') return 'Free tier'
  if (tier === 'trial') {
    if (!trialEndsAt) return 'Free trial'
    const daysLeft = Math.ceil((new Date(trialEndsAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    if (daysLeft <= 0) return 'Free trial ended'
    return `Free trial · ${daysLeft} day${daysLeft === 1 ? '' : 's'} left`
  }
  return `${tier} plan`
}

function NavLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="block px-3 py-2 rounded-lg text-sm text-brand-beige hover:text-brand-cream hover:bg-brand-charcoal-deep transition-colors"
    >
      {label}
    </Link>
  )
}
