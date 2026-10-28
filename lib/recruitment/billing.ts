// v76: Recruitment billing state from Stripe. Used by the Stripe webhook
// and checkout. Kept out of the route files so it can be tested.

import type Stripe from 'stripe'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getRecruitmentPeriodFromPriceId } from '@/lib/stripe'

export const RECRUITMENT_STATUS: Record<string, string> = {
  active: 'active',
  trialing: 'active',
  past_due: 'past_due',
  unpaid: 'past_due',
  canceled: 'cancelled',
  incomplete: 'inactive',
  incomplete_expired: 'inactive',
  paused: 'inactive',
}

const TERMINAL = ['canceled', 'incomplete_expired']

export function subscriptionPriceId(subscription: Stripe.Subscription): string | undefined {
  return subscription.items.data[0]?.price.id
}

// Our checkout tags every subscription with metadata.product, so a new
// Recruitment price (prices can't be edited, only replaced) is still
// recognised. The price env vars are the fallback for anything else.
export function isRecruitmentSubscription(subscription: Stripe.Subscription): boolean {
  if (subscription.metadata?.product === 'recruitment') return true
  if (subscription.metadata?.product === 'plan') return false
  return !!getRecruitmentPeriodFromPriceId(subscriptionPriceId(subscription))
}

export function invoiceIsRecruitment(invoice: Stripe.Invoice): boolean {
  const product = invoice.subscription_details?.metadata?.product
  if (product === 'recruitment') return true
  if (product === 'plan') return false
  return invoice.lines.data.some((line) => !!getRecruitmentPeriodFromPriceId(line.price?.id))
}

function periodOf(sub: Stripe.Subscription): 'monthly' | 'annual' | null {
  const fromPrice = getRecruitmentPeriodFromPriceId(subscriptionPriceId(sub))
  if (fromPrice) return fromPrice
  const interval = sub.items.data[0]?.price.recurring?.interval
  return interval === 'year' ? 'annual' : interval === 'month' ? 'monthly' : null
}

function customerIdOf(sub: Stripe.Subscription): string {
  return typeof sub.customer === 'string' ? sub.customer : sub.customer.id
}

// The customer's Recruitment subscriptions, newest first.
export async function listRecruitmentSubscriptions(stripe: Stripe, customerId: string): Promise<Stripe.Subscription[]> {
  const list = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 })
  return list.data.filter(isRecruitmentSubscription).sort((a, b) => b.created - a.created)
}

// True when the customer already has a Recruitment subscription that is
// paid up or about to be. A past_due one doesn't count: restarting with a
// working card is how a customer recovers, and the webhook then cancels it.
// An 'incomplete' one counts only for an hour: long enough to cover a
// payment that is still going through, not so long that an abandoned one
// blocks a retry.
export async function hasLiveRecruitmentSubscription(stripe: Stripe, customerId: string): Promise<boolean> {
  const subs = await listRecruitmentSubscriptions(stripe, customerId)
  const hourAgo = Math.floor(Date.now() / 1000) - 3600
  return subs.some((s) => ['active', 'trialing'].includes(s.status) || (s.status === 'incomplete' && s.created > hourAgo))
}

// Cancels a superseded Recruitment subscription. Every step is safe to
// repeat, so if one fails the webhook throws, Stripe retries, and the next
// run picks up where this one stopped (the subscription stays live until
// the cancel itself succeeds).
// - Paid up (an accidental second purchase): its paid invoices are refunded
//   in full through a credit note, which keeps a clean VAT record, then it
//   is cancelled without proration.
// - Not paid (a failed card the customer replaced): its open invoices are
//   voided, so they are never chased, then it is cancelled.
async function cancelSuperseded(stripe: Stripe, sub: Stripe.Subscription): Promise<void> {
  if (['active', 'trialing'].includes(sub.status)) {
    const paid = await stripe.invoices.list({ subscription: sub.id, status: 'paid', limit: 20 })
    for (const inv of paid.data) {
      const already = (inv.post_payment_credit_notes_amount || 0) > 0
      if (!inv.id || already || !inv.amount_paid) continue
      // Several webhook deliveries can run at once for one duplicate
      // purchase. The idempotency key makes them all the same refund.
      await stripe.creditNotes.create({
        invoice: inv.id,
        amount: inv.amount_paid,
        refund_amount: inv.amount_paid,
        reason: 'duplicate',
        memo: 'Refund for a duplicate Recruitment subscription. Your other Recruitment subscription carries on.',
      }, { idempotencyKey: `recruitment-duplicate-refund-${inv.id}` })
    }
    await stripe.subscriptions.cancel(sub.id, { prorate: false })
    return
  }
  const open = await stripe.invoices.list({ subscription: sub.id, status: 'open', limit: 20 })
  for (const inv of open.data) {
    if (inv.id) await stripe.invoices.voidInvoice(inv.id)
  }
  await stripe.subscriptions.cancel(sub.id)
}

// Only an accidental double purchase is refunded automatically: both made
// through our checkout, within 48 hours of each other. Anything else (for
// example a subscription set up by hand in the Stripe dashboard to move
// someone from monthly to annual) is left alone for a person to sort out.
const DUPLICATE_WINDOW_SECONDS = 48 * 60 * 60
function isAccidentalDuplicate(keeper: Stripe.Subscription, other: Stripe.Subscription): boolean {
  return other.metadata?.product === 'recruitment'
    && keeper.metadata?.product === 'recruitment'
    && Math.abs(other.created - keeper.created) <= DUPLICATE_WINDOW_SECONDS
}

// Brings the account's Recruitment state in line with Stripe. Called for
// any Recruitment subscription or invoice event. Rules:
// 1. Read from Stripe, not the event, because events arrive out of order.
// 2. One Recruitment subscription per account. The oldest active one
//    decides; failing that, the newest with a failed payment, then the
//    newest still being paid for. When there is an active one, every other
//    live one is cancelled, so nobody is billed twice (two checkouts at
//    once: the duplicate is refunded; restarting after a failed card: the
//    failed one's invoice is voided). A second active subscription that
//    isn't an accidental double purchase is logged and left alone. Safe to
//    repeat, so a failure throws and Stripe retries the event.
// 3. Becoming active on a new subscription, or after being inactive or
//    cancelled, starts a fresh usage cycle, so someone who restarts or
//    converts from the beta isn't left blocked by old usage.
// 4. An active beta (admin-enabled, no subscription) is never ended by a
//    subscription that isn't active yet.
// Errors throw, so the webhook returns 500 and Stripe retries.
export async function syncRecruitment(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  stripe: Stripe,
  source: Stripe.Subscription
): Promise<void> {
  const customerId = customerIdOf(source)
  const subs = await listRecruitmentSubscriptions(stripe, customerId)
  const live = subs.filter((s) => !TERMINAL.includes(s.status))
  const oldestFirst = [...live].reverse()
  const keeper =
    // The first paid subscription stays; a later duplicate is refunded.
    oldestFirst.find((s) => ['active', 'trialing'].includes(s.status)) ||
    // Otherwise the newest with a failed payment, then the newest still
    // going through its first payment, then anything else.
    live.find((s) => ['past_due', 'unpaid'].includes(s.status)) ||
    live.find((s) => s.status === 'incomplete') ||
    live[0] ||
    subs[0] ||
    source

  // Find the account: by Stripe customer, else the user id our checkout put
  // on the subscription.
  const byCustomer = await supabase
    .from('profiles')
    .select('id, recruitment_status, recruitment_subscription_id, recruitment_current_period_end')
    .eq('stripe_customer_id', customerId)
    .maybeSingle()
  if (byCustomer.error) throw new Error(`Profile lookup failed: ${byCustomer.error.message}`)
  let profile = byCustomer.data
  if (!profile) {
    const userId = keeper.metadata?.userId || source.metadata?.userId
    if (userId) {
      const byId = await supabase
        .from('profiles')
        .select('id, recruitment_status, recruitment_subscription_id, recruitment_current_period_end')
        .eq('id', userId)
        .maybeSingle()
      if (byId.error) throw new Error(`Profile lookup failed: ${byId.error.message}`)
      profile = byId.data
    }
  }
  if (!profile) throw new Error(`No profile for Stripe customer ${customerId} (Recruitment subscription ${keeper.id})`)

  const status = RECRUITMENT_STATUS[keeper.status] || 'inactive'

  // Rule 4: keep an active beta until a subscription is actually active.
  const betaLive = profile.recruitment_status === 'active' && !profile.recruitment_subscription_id
    && (!profile.recruitment_current_period_end || new Date(profile.recruitment_current_period_end).getTime() > Date.now())
  if (betaLive && status !== 'active') {
    console.log(`[Stripe] Recruitment ${keeper.id} is ${keeper.status}; keeping the beta access on ${profile.id}`)
    return
  }

  // Rule 2: cancel every other live Recruitment subscription.
  if (status === 'active') {
    for (const other of live) {
      if (other.id === keeper.id) continue
      if (['active', 'trialing'].includes(other.status) && !isAccidentalDuplicate(keeper, other)) {
        console.error(`[Stripe] ACTION NEEDED: ${customerId} has two active Recruitment subscriptions (${keeper.id} kept, ${other.id} left running). Not refunded automatically; cancel or refund one in Stripe.`)
        continue
      }
      await cancelSuperseded(stripe, other)
      console.log(`[Stripe] Cancelled superseded Recruitment subscription ${other.id} (${other.status}) for ${customerId}`)
    }
  }

  const update: Record<string, unknown> = {
    recruitment_status: status,
    recruitment_period: periodOf(keeper),
    recruitment_subscription_id: keeper.id,
    recruitment_current_period_end: keeper.current_period_end
      ? new Date(keeper.current_period_end * 1000).toISOString()
      : null,
    updated_at: new Date().toISOString(),
  }
  // Rule 3
  if (status === 'active' && (profile.recruitment_subscription_id !== keeper.id
      || ['inactive', 'cancelled'].includes(profile.recruitment_status))) {
    update.recruitment_advisers_used = 0
    update.recruitment_finds_used = 0
    update.recruitment_usage_reset_at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
  }

  const { error } = await supabase.from('profiles').update(update).eq('id', profile.id)
  if (error) throw new Error(`Recruitment update failed: ${error.message}`)
}
