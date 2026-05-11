import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createCheckoutSession, getOrCreateCustomer } from '@/lib/stripe'
import { z } from 'zod'

// Map tier + period to env var names (looked up at runtime, not build time)
const PRICE_MAP: Record<string, string> = {
  'starter_monthly': 'STRIPE_PRICE_STARTER_MONTHLY',
  'starter_annual': 'STRIPE_PRICE_STARTER_ANNUAL',
  'professional_monthly': 'STRIPE_PRICE_PRO_MONTHLY',
  'professional_annual': 'STRIPE_PRICE_PRO_ANNUAL',
  'growth_monthly': 'STRIPE_PRICE_GROWTH_MONTHLY',
  'growth_annual': 'STRIPE_PRICE_GROWTH_ANNUAL',
}

const CheckoutSchema = z.object({
  tier: z.enum(['starter', 'professional', 'growth']),
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
      .select('stripe_customer_id, email, full_name')
      .eq('id', user.id)
      .single()

    let customerId = profile?.stripe_customer_id

    if (!customerId) {
      const customer = await getOrCreateCustomer({
        userId: user.id,
        email: profile?.email || user.email!,
        name: profile?.full_name || undefined,
      })
      customerId = customer.id

      await supabase
        .from('profiles')
        .update({ stripe_customer_id: customerId })
        .eq('id', user.id)
    }

    // Create checkout session
    const session = await createCheckoutSession({
      customerId,
      priceId,
      userId: user.id,
      successUrl: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard?upgraded=true`,
      cancelUrl: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/settings`,
    })

    return NextResponse.json({ url: session.url })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Checkout failed'
    console.error('Checkout error:', error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
