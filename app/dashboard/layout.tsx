import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { PLAN_LIMITS, PlanTier } from '@/types'

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
  const usagePercent = Math.min(100, Math.round((profile.prospects_used_this_cycle / limits.prospects_per_cycle) * 100))

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
          {(user.email === 'dan.reddish@gmail.com' || user.email === 'dan@aiwealthpartners.co.uk') && (
            <NavLink href="/dashboard/admin" label="Admin" />
          )}
        </nav>

        {/* Usage meter */}
        <div className="p-4 border-t border-brand-charcoal">
          <div className="flex justify-between text-xs mb-2">
            <span className="text-brand-beige">Prospects used</span>
            <span className="text-brand-cream font-semibold">
              {profile.prospects_used_this_cycle}/{limits.prospects_per_cycle}
            </span>
          </div>
          <div className="h-1.5 bg-brand-charcoal rounded-full overflow-hidden">
            <div
              className="h-full bg-brand-rose-gold rounded-full transition-all duration-500"
              style={{ width: `${usagePercent}%` }}
            />
          </div>
          <p className="text-[10px] text-brand-beige mt-2 uppercase tracking-wide">
            {profile.plan_tier === 'free' ? 'Free tier' : `${profile.plan_tier} plan`}
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
          {children}
        </div>
      </main>
    </div>
  )
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
