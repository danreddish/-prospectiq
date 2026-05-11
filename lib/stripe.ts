import Stripe from 'stripe'

// Lazy-initialised Stripe client — avoids throwing during Next.js build
// when env vars are not yet available
let _stripe: Stripe | null = null

export function getStripe(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY
    if (!key) {
      throw new Error('STRIPE_SECRET_KEY is not set')
    }
    _stripe = new Stripe(key, {
      apiVersion: '2025-02-24.acacia',
      typescript: true,
    })
  }
  return _stripe
}

/**
 * Map Stripe price IDs to plan tiers (also lazy to avoid undefined keys at build time)
 */
export function getTierFromPriceId(priceId: string): string {
  const map: Record<string, string> = {
    [process.env.STRIPE_PRICE_STARTER_MONTHLY || '']: 'starter',
    [process.env.STRIPE_PRICE_STARTER_ANNUAL || '']: 'starter',
    [process.env.STRIPE_PRICE_PRO_MONTHLY || '']: 'professional',
    [process.env.STRIPE_PRICE_PRO_ANNUAL || '']: 'professional',
    [process.env.STRIPE_PRICE_GROWTH_MONTHLY || '']: 'growth',
    [process.env.STRIPE_PRICE_GROWTH_ANNUAL || '']: 'growth',
  }
  return map[priceId] || 'free'
}

/**
 * Create a Stripe Checkout session for a new subscription
 */
export async function createCheckoutSession({
  customerId,
  priceId,
  userId,
  successUrl,
  cancelUrl,
}: {
  customerId: string
  priceId: string
  userId: string
  successUrl: string
  cancelUrl: string
}) {
  const stripe = getStripe()
  return stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    subscription_data: {
      trial_period_days: 7,
      metadata: { userId },
    },
    metadata: { userId },
    allow_promotion_codes: true,
  })
}

/**
 * Create a Stripe Customer Portal session
 */
export async function createPortalSession({
  customerId,
  returnUrl,
}: {
  customerId: string
  returnUrl: string
}) {
  const stripe = getStripe()
  return stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  })
}

/**
 * Create or retrieve a Stripe customer for a user
 */
export async function getOrCreateCustomer({
  userId,
  email,
  name,
}: {
  userId: string
  email: string
  name?: string
}) {
  const stripe = getStripe()

  // Check if customer already exists
  const existing = await stripe.customers.list({
    email,
    limit: 1,
  })

  if (existing.data.length > 0) {
    return existing.data[0]
  }

  // Create new customer
  return stripe.customers.create({
    email,
    name: name || undefined,
    metadata: { userId },
  })
}
