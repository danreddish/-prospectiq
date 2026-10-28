import { NextRequest, NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { createCheckoutSession, getOrCreateCustomer, getStripe } from '@/lib/stripe'
import { hasLiveRecruitmentSubscription } from '@/lib/recruitment/billing'
import { z } from 'zod'

// Map tier + period to env var names (looked up at runtime, not build time)
const PRICE_MAP: Record<string, string> = {
  'starter_monthly': 'STRIPE_PRICE_STARTER_MONTHLY',
  'starter_annual': 'STRIPE_PRICE_STARTER_ANNUAL',
  'professional_monthly': 'STRIPE_PRICE_PRO_MONTHLY',
  'professional_annual': 'STRIPE_PRICE_PRO_ANNUAL',
  'growth_monthly': 'STRIPE_PRICE_GROWTH_MONTHLY',
  'growth_annual': 'STRIPE_PRICE_GROWTH_ANNUAL',
  // v76: Recruitment is a separate subscription, no self-serve trial
  'recruitment_monthly': 'STRIPE_PRICE_RECRUITMENT_MONTHLY',
  'recruitment_annual': 'STRIPE_PRICE_RECRUITMENT_ANNUAL',
}

const CheckoutSchema = z.object({
  tier: z.enum(['starter', 'professional', 'growth', 'recruitment']),
  period: z.enum(['monthly', 'annual']).default('monthly'),
})

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const parsed = CheckoutSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid plan selection' }, { status: 400 })
  }

  // Look up price ID from env vars at runtime
  const envKey = PRICE_MAP[`${parsed.data.tier}_${parsed.data.period}`]
  if (!envKey) {
    return NextResponse.json({ error: 'Invalid plan' }, { status: 400 })
  }

  const priceId = process.env[envKey]
  if (!priceId) {
    return NextResponse.json(
      { error: `Price not configured. Set ${envKey} in environment variables.` },
      { status: 500 }
    )
  }

  try {
    // Get or create Stripe customer
    const { data: profile } = await supabase
      .from('profiles')
      .select('stripe_customer_id, email, full_name, recruitment_status, recruitment_subscription_id')
      .eq('id', user.id)
      .single()

    // v76: one Recruitment subscription per account. Checked in Stripe as
    // well as our copy, which can lag the webhook. Restarting after a failed
    // payment is allowed; the webhook cancels the failed subscription once
    // the new one is active. Beta access has no subscription, so beta users
    // can buy.
    const alreadySubscribed = NextResponse.json(
      { error: 'You already have Recruitment, so there is no need to buy it again. If you have just paid, give it a minute and refresh.', code: 'already_subscribed' },
      { status: 409 }
    )
    if (parsed.data.tier === 'recruitment') {
      if (profile?.recruitment_status === 'active' && profile.recruitment_subscription_id) return alreadySubscribed
      if (profile?.stripe_customer_id && await hasLiveRecruitmentSubscription(getStripe(), profile.stripe_customer_id)) {
        return alreadySubscribed
      }
    }

    let customerId = profile?.stripe_customer_id

    if (!customerId) {
      const customer = await getOrCreateCustomer({
        userId: user.id,
        email: user.email || profile?.email || '',
        name: profile?.full_name || undefined,
      })
      customerId = customer.id

      // v75.7: billing columns are locked to the server, so save the
      // customer id with the service role rather than the user's login.
      await createAdminClient()
        .from('profiles')
        .update({ stripe_customer_id: customerId })
        .eq('id', user.id)
    }

    // Create checkout session
    const isRecruitment = parsed.data.tier === 'recruitment'
    const session = await createCheckoutSession({
      customerId,
      priceId,
      userId: user.id,
      successUrl: isRecruitment
        ? `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/recruitment?upgraded=true`
        : `${process.env.NEXT_PUBLIC_APP_URL}/dashboard?upgraded=true`,
      cancelUrl: isRecruitment
        ? `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/recruitment`
        : `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/settings`,
      product: isRecruitment ? 'recruitment' : 'plan',
    })

    return NextResponse.json({ url: session.url })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Checkout failed'
    console.error('Checkout error:', error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
