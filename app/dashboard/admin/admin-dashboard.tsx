'use client'

import { useMemo, useState } from 'react'
import { toast } from 'sonner'

interface UserRow {
  id: string
  email: string
  full_name: string | null
  company_name: string | null
  plan_tier: string
  plan_status: string
  trial_ends_at: string | null
  prospects_used_this_cycle: number
  cycle_reset_at: string
  created_at: string
  campaignCount: number
  prospectTotal: number
  prospectCompleted: number
}

interface Props {
  users: UserRow[]
}

type FilterKey = 'all' | 'trialing' | 'canceled' | 'past_due' | 'paying' | 'beta' | 'free'

// Derive a single human-readable status for a user, factoring in plan_status + trial_ends_at
function getDerivedStatus(user: UserRow): {
  key: FilterKey
  label: string
  detail: string
  classes: string
} {
  const now = Date.now()
  const trialEnd = user.trial_ends_at ? new Date(user.trial_ends_at).getTime() : null

  if (user.plan_status === 'canceled') {
    let detail = 'Cancelled'
    if (trialEnd && trialEnd > now) {
      const daysLeft = Math.ceil((trialEnd - now) / (1000 * 60 * 60 * 24))
      detail = `Cancelled · access ends in ${daysLeft}d`
    }
    return {
      key: 'canceled',
      label: 'CANCELLED',
      detail,
      classes: 'bg-red-900/40 text-red-400 border-red-900',
    }
  }

  if (user.plan_status === 'past_due' || user.plan_status === 'unpaid') {
    return {
      key: 'past_due',
      label: 'PAYMENT FAILED',
      detail: 'Stripe could not charge them',
      classes: 'bg-orange-900/40 text-orange-400 border-orange-900',
    }
  }

  if (user.plan_status === 'trialing' || user.plan_tier === 'trial') {
    if (trialEnd) {
      const daysLeft = Math.ceil((trialEnd - now) / (1000 * 60 * 60 * 24))
      if (daysLeft <= 0) {
        return {
          key: 'trialing',
          label: 'TRIAL ENDING',
          detail: 'Trial expired today',
          classes: 'bg-yellow-900/40 text-yellow-400 border-yellow-900',
        }
      }
      return {
        key: 'trialing',
        label: 'ON TRIAL',
        detail: `${daysLeft} day${daysLeft === 1 ? '' : 's'} left`,
        classes: 'bg-yellow-900/40 text-yellow-400 border-yellow-900',
      }
    }
    return {
      key: 'trialing',
      label: 'ON TRIAL',
      detail: 'Free trial',
      classes: 'bg-yellow-900/40 text-yellow-400 border-yellow-900',
    }
  }

  if (['starter', 'growth'].includes(user.plan_tier)) {
    return {
      key: 'paying',
      label: 'PAYING',
      detail: `${user.plan_tier} · active`,
      classes: 'bg-green-900/40 text-green-400 border-green-900',
    }
  }

  if (user.plan_tier === 'professional') {
    return {
      key: 'beta',
      label: 'BETA',
      detail: 'Professional · comp',
      classes: 'bg-brand-rose-gold/20 text-brand-rose-gold border-brand-rose-gold/40',
    }
  }

  return {
    key: 'free',
    label: 'FREE',
    detail: 'No plan',
    classes: 'bg-brand-charcoal text-brand-beige border-brand-charcoal',
  }
}

export default function AdminDashboard({ users: initialUsers }: Props) {
  const [users, setUsers] = useState(initialUsers)
  const [updating, setUpdating] = useState<string | null>(null)
  const [filter, setFilter] = useState<FilterKey>('all')

  async function updatePlan(userId: string, plan: string, days: number) {
    setUpdating(userId)
    try {
      const res = await fetch('/api/admin/update-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, plan_tier: plan, days }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Update failed')

      setUsers(users.map((u) =>
        u.id === userId
          ? { ...u, plan_tier: plan, plan_status: 'active', prospects_used_this_cycle: 0 }
          : u
      ))
      toast.success(`Plan updated to ${plan}`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Update failed'
      toast.error(message)
    } finally {
      setUpdating(null)
    }
  }

  async function resetUsage(userId: string) {
    setUpdating(userId)
    try {
      const res = await fetch('/api/admin/update-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, reset_usage: true }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Reset failed')

      setUsers(users.map((u) =>
        u.id === userId ? { ...u, prospects_used_this_cycle: 0 } : u
      ))
      toast.success('Usage reset')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Reset failed'
      toast.error(message)
    } finally {
      setUpdating(null)
    }
  }

  const tierColors: Record<string, string> = {
    free: 'bg-brand-charcoal text-brand-beige',
    trial: 'bg-yellow-900/40 text-yellow-400',
    starter: 'bg-blue-900/40 text-blue-400',
    professional: 'bg-brand-rose-gold/20 text-brand-rose-gold',
    growth: 'bg-green-900/40 text-green-400',
  }

  const statusCounts = useMemo(() => {
    const counts: Record<FilterKey, number> = {
      all: users.length,
      trialing: 0,
      canceled: 0,
      past_due: 0,
      paying: 0,
      beta: 0,
      free: 0,
    }
    for (const u of users) {
      counts[getDerivedStatus(u).key]++
    }
    return counts
  }, [users])

  const filteredUsers = useMemo(() => {
    if (filter === 'all') return users
    return users.filter((u) => getDerivedStatus(u).key === filter)
  }, [users, filter])

  const filterPills: { key: FilterKey; label: string; classes: string }[] = [
    { key: 'all', label: 'All', classes: 'border-brand-beige text-brand-beige' },
    { key: 'trialing', label: 'On trial', classes: 'border-yellow-900 text-yellow-400' },
    { key: 'canceled', label: 'Cancelled', classes: 'border-red-900 text-red-400' },
    { key: 'past_due', label: 'Payment failed', classes: 'border-orange-900 text-orange-400' },
    { key: 'paying', label: 'Paying', classes: 'border-green-900 text-green-400' },
    { key: 'beta', label: 'Beta', classes: 'border-brand-rose-gold/40 text-brand-rose-gold' },
    { key: 'free', label: 'Free', classes: 'border-brand-charcoal text-brand-beige' },
  ]

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-display text-brand-cream">Admin</h1>
          <p className="text-brand-beige text-sm mt-1">{users.length} users registered</p>
        </div>
      </div>

      <div className="grid grid-cols-5 gap-4 mb-6">
        {[
          { label: 'Total Users', value: users.length, accent: 'text-brand-cream' },
          { label: 'On Trial', value: statusCounts.trialing, accent: 'text-yellow-400' },
          { label: 'Cancelled', value: statusCounts.canceled, accent: 'text-red-400' },
          { label: 'Paying', value: statusCounts.paying, accent: 'text-green-400' },
          { label: 'Prospects Researched', value: users.reduce((sum, u) => sum + u.prospectCompleted, 0), accent: 'text-brand-cream' },
        ].map((s) => (
          <div key={s.label} className="bg-brand-charcoal-deep rounded-xl border border-brand-charcoal p-4">
            <p className="text-brand-beige text-[10px] uppercase tracking-wider">{s.label}</p>
            <p className={`text-2xl font-display mt-1 ${s.accent}`}>{s.value}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        {filterPills.map((p) => {
          const isActive = filter === p.key
          return (
            <button
              key={p.key}
              onClick={() => setFilter(p.key)}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                isActive
                  ? `${p.classes} bg-brand-charcoal-deep`
                  : 'border-brand-charcoal text-brand-beige hover:border-brand-rose-gold hover:text-brand-cream'
              }`}
            >
              {p.label} <span className="opacity-60 ml-1">({statusCounts[p.key]})</span>
            </button>
          )
        })}
      </div>

      <div className="bg-brand-charcoal-deep rounded-xl border border-brand-charcoal overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-brand-charcoal text-left">
              <th className="p-3 text-brand-beige text-xs font-semibold uppercase tracking-wider">User</th>
              <th className="p-3 text-brand-beige text-xs font-semibold uppercase tracking-wider">Status</th>
              <th className="p-3 text-brand-beige text-xs font-semibold uppercase tracking-wider">Plan</th>
              <th className="p-3 text-brand-beige text-xs font-semibold uppercase tracking-wider">Usage</th>
              <th className="p-3 text-brand-beige text-xs font-semibold uppercase tracking-wider">Campaigns</th>
              <th className="p-3 text-brand-beige text-xs font-semibold uppercase tracking-wider">Prospects</th>
              <th className="p-3 text-brand-beige text-xs font-semibold uppercase tracking-wider">Joined</th>
              <th className="p-3 text-brand-beige text-xs font-semibold uppercase tracking-wider">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-brand-charcoal">
            {filteredUsers.map((user) => {
              const status = getDerivedStatus(user)
              return (
                <tr key={user.id} className="hover:bg-brand-charcoal-deeper/30">
                  <td className="p-3">
                    <p className="text-brand-cream font-semibold">{user.full_name || 'No name'}</p>
                    <p className="text-brand-beige text-xs">{user.email}</p>
                    {user.company_name && (
                      <p className="text-brand-charcoal text-xs">{user.company_name}</p>
                    )}
                  </td>
                  <td className="p-3">
                    <span className={`text-[10px] px-2 py-1 rounded font-bold uppercase border ${status.classes}`}>
                      {status.label}
                    </span>
                    <p className="text-brand-beige text-[10px] mt-1.5">{status.detail}</p>
                  </td>
                  <td className="p-3">
                    <span className={`text-[10px] px-2 py-1 rounded font-bold uppercase ${tierColors[user.plan_tier] || tierColors.free}`}>
                      {user.plan_tier}
                    </span>
                  </td>
                  <td className="p-3">
                    <p className="text-brand-cream">{user.prospects_used_this_cycle}</p>
                    <p className="text-brand-charcoal text-[10px]">this cycle</p>
                  </td>
                  <td className="p-3 text-brand-cream">{user.campaignCount}</td>
                  <td className="p-3">
                    <p className="text-brand-cream">{user.prospectCompleted}</p>
                    <p className="text-brand-charcoal text-[10px]">{user.prospectTotal} total</p>
                  </td>
                  <td className="p-3 text-brand-beige text-xs">
                    {new Date(user.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                  </td>
                  <td className="p-3">
                    <div className="flex flex-wrap gap-1.5">
                      {(['free', 'starter', 'professional', 'growth'] as const).map((plan) => (
                        <button
                          key={plan}
                          onClick={() => updatePlan(user.id, plan, 30)}
                          disabled={updating === user.id || user.plan_tier === plan}
                          className={`text-[9px] px-2 py-1 rounded border transition-colors ${
                            user.plan_tier === plan
                              ? 'border-brand-rose-gold text-brand-rose-gold opacity-50 cursor-not-allowed'
                              : 'border-brand-charcoal text-brand-beige hover:border-brand-rose-gold hover:text-brand-cream'
                          }`}
                        >
                          {plan}
                        </button>
                      ))}
                      <button
                        onClick={() => resetUsage(user.id)}
                        disabled={updating === user.id}
                        className="text-[9px] px-2 py-1 rounded border border-brand-charcoal text-brand-beige hover:border-yellow-500 hover:text-yellow-400 transition-colors"
                      >
                        Reset
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
            {filteredUsers.length === 0 && (
              <tr>
                <td colSpan={8} className="p-8 text-center text-brand-beige text-sm">
                  No users match this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
