import { NextRequest, NextResponse } from 'next/server'
import { getStripe, getTierFromPriceId } from '@/lib/stripe'
import { createAdminClient } from '@/lib/supabase/server'
import Stripe from 'stripe'

export async function POST(req: NextRequest) {
  const body = await req.text()
  const sig = req.headers.get('stripe-signature')!

  let event: Stripe.Event

  try {
    event = getStripe().webhooks.constructEvent(
      body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    )
  } catch (err: any) {
    console.error('Webhook signature verification failed:', err.message)
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  const supabase = createAdminClient()

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session
        const userId = session.metadata?.userId
        if (!userId) break

        // Link Stripe customer to user profile. v75.7: plan and status come
        // from the subscription events, so this no longer marks the account
        // as trialing (there is no Stripe trial any more).
        await supabase
          .from('profiles')
          .update({
            stripe_customer_id: session.customer as string,
            updated_at: new Date().toISOString(),
          })
          .eq('id', userId)
        break
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription
        const customerId = subscription.customer as string
        const priceId = subscription.items.data[0]?.price.id
        const tier = getTierFromPriceId(priceId)

        // v75.7: plan status now decides access, so unknown values fail
        // closed. 'incomplete' means the first payment hasn't gone through.
        const statusMap: Record<string, string> = {
          active: 'active',
          trialing: 'trialing',
          past_due: 'past_due',
          canceled: 'canceled',
          unpaid: 'unpaid',
          incomplete: 'unpaid',
          incomplete_expired: 'canceled',
          paused: 'canceled',
        }
        const planStatus = statusMap[subscription.status]
        if (!planStatus) console.error(`[Stripe] Unknown subscription status "${subscription.status}" for ${customerId}; blocking until resolved`)

        const update: Record<string, unknown> = {
          plan_status: planStatus || 'unpaid',
          trial_ends_at: subscription.trial_end
            ? new Date(subscription.trial_end * 1000).toISOString()
            : null,
          updated_at: new Date().toISOString(),
        }
        // v75.7: an unrecognised price id maps to 'free', which would now
        // block a paying customer (for example if a price env var is missing
        // after the switch to live mode). Leave the tier alone and log it.
        if (tier === 'free') {
          console.error(`[Stripe] Unrecognised price "${priceId}" for ${customerId}; plan tier left unchanged. Check the STRIPE_PRICE_* env vars.`)
        } else {
          update.plan_tier = tier
        }

        await supabase
          .from('profiles')
          .update(update)
          .eq('stripe_customer_id', customerId)
        break
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription
        const customerId = subscription.customer as string

        await supabase
          .from('profiles')
          .update({
            plan_tier: 'free',
            plan_status: 'canceled',
            updated_at: new Date().toISOString(),
          })
          .eq('stripe_customer_id', customerId)
        break
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice
        const customerId = invoice.customer as string

        await supabase
          .from('profiles')
          .update({
            plan_status: 'past_due',
            updated_at: new Date().toISOString(),
          })
          .eq('stripe_customer_id', customerId)
        break
      }
    }
  } catch (error) {
    console.error('Webhook processing error:', error)
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 })
  }

  return NextResponse.json({ received: true })
}
