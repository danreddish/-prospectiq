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
 * Recruitment is a separate product from the plan tiers (v76). A user can
 * hold both subscriptions. Returns the billing period for a recruitment
 * price, or null when the price is not a recruitment price.
 */
export function getRecruitmentPeriodFromPriceId(priceId: string | undefined | null): 'monthly' | 'annual' | null {
  if (!priceId) return null
  const monthly = process.env.STRIPE_PRICE_RECRUITMENT_MONTHLY || ''
  const annual = process.env.STRIPE_PRICE_RECRUITMENT_ANNUAL || ''
  if (monthly && priceId === monthly) return 'monthly'
  if (annual && priceId === annual) return 'annual'
  return null
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
  product = 'plan',
}: {
  customerId: string
  priceId: string
  userId: string
  successUrl: string
  cancelUrl: string
  product?: 'plan' | 'recruitment'
}) {
  const stripe = getStripe()
  const vatRate = process.env.STRIPE_TAX_RATE_VAT
  if (!vatRate) console.error('[Stripe] STRIPE_TAX_RATE_VAT is not set; checkout will not show VAT on invoices')
  return stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    payment_method_types: ['card'],
    // Prices include VAT. The inclusive 20% UK VAT rate doesn't change what
    // the customer pays; it shows the VAT on their invoice and receipt.
    line_items: [{ price: priceId, quantity: 1, ...(vatRate ? { tax_rates: [vatRate] } : {}) }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    // v75.7: no Stripe trial for any product. The 7-day in-app trial (no
    // card needed) is the free trial for client plans, and Recruitment has
    // none. A Stripe trial on every checkout let people cancel and
    // resubscribe for another free week, again and again.
    subscription_data: {
      metadata: { userId, product },
    },
    metadata: { userId, product },
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
